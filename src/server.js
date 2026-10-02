import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Bridge } from './bridge.js';

export const filename = z.string().min(1).max(180).refine(x => !/[<>:"/\\|?*\x00-\x1f]/.test(x) && !/[. ]$/.test(x) && x !== '.' && x !== '..', 'Use a plain filename without path separators');
const avatar = filename.refine(x => x.endsWith('.png'), 'Use the avatar filename from list_characters');
const bridge = new Bridge();
const jobs = new Map();
const server = new McpServer({ name: 'sillytavern-agent', version: '0.1.0' }, { instructions: 'First call status and list_characters. start_conversation returns a job immediately; poll get_job until succeeded or failed. Reuse request_id to avoid duplicate execution in this server session. Operations are serialized. Generated conversations use a new isolated chat, retaining the character, presets, world info and extensions. Job state is in memory; chat results persist in SillyTavern. Do not automatically retry a failed generation: inspect its chat first.' });
function tool(name, description, inputSchema, fn, readOnly = true, lock = true) {
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: !readOnly } }, async args => {
    try {
      const result = await (lock ? bridge.exclusive(() => fn(args)) : fn(args));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
}
tool('status', 'Check the local SillyTavern runtime and model connection.', {}, () => bridge.status());
tool('list_characters', 'List character names and exact avatar identifiers.', {}, async () => (await bridge.api('characters/all')).map(c => ({ name: c.name, avatar: c.avatar, description: c.description?.slice(0, 200) })));
tool('get_character', 'Read a complete character card.', { avatar }, args => bridge.api('characters/get', { avatar_url: args.avatar }));
tool('update_character', 'Merge supported text fields into an existing character card.', { avatar, fields: z.object({ description: z.string().optional(), personality: z.string().optional(), scenario: z.string().optional(), first_mes: z.string().optional(), mes_example: z.string().optional() }).strict() }, args => bridge.api('characters/merge-attributes', { ...args.fields, data: args.fields, avatar: args.avatar }), false);
tool('list_worlds', 'List world books.', {}, () => bridge.api('worldinfo/list'));
tool('get_world', 'Read a world book; missing books return an empty entries object.', { name: filename }, args => bridge.api('worldinfo/get', args));
tool('save_world', 'Create or replace a world book. Read and preserve existing entries before editing.', { name: filename, data: z.object({ entries: z.record(z.string(), z.record(z.string(), z.unknown())) }).passthrough() }, args => bridge.api('worldinfo/edit', args), false);
tool('list_chats', 'List saved conversations for a character.', { avatar }, args => bridge.api('characters/chats', { avatar_url: args.avatar }));
tool('get_chat', 'Read a saved conversation including its metadata header.', { avatar, chat_name: filename }, args => bridge.api('chats/get', { avatar_url: args.avatar, file_name: args.chat_name }));
tool('start_conversation', 'Run a sequence of literal user messages through the real SillyTavern generation pipeline. Uses configured model credentials and may incur model charges. Creates a fresh chat and returns a job ID immediately.', { avatar, messages: z.array(z.string().min(1).max(100000)).min(1).max(50), request_id: z.string().min(1).max(100), timeout_seconds: z.number().int().min(10).max(900).default(180) }, async args => {
  const previous = jobs.get(args.request_id);
  if (previous) {
    if (previous.signature !== JSON.stringify(args)) throw new Error('request_id was already used with different inputs');
    const { signature, ...result } = previous;
    return result;
  }
  if (bridge.busy) throw new Error('Another operation is running');
  if (jobs.size >= 500) throw new Error('Session job limit reached. Restart the MCP server after recording results.');
  const job = { job_id: args.request_id, signature: JSON.stringify(args), state: 'running', avatar: args.avatar, chat_name: 'MCP-' + randomUUID(), replies: [] };
  jobs.set(args.request_id, job);
  void bridge.exclusive(async () => {
    let watchdog;
    try {
      job.result = await Promise.race([
        bridge.run({ ...args, chat_name: job.chat_name }, replies => { job.replies = [...replies]; }),
        new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Workflow exceeded its total time limit. Inspect the saved chat before retrying.')), (60 + args.messages.length * (args.timeout_seconds + 10)) * 1000); }),
      ]);
      job.state = 'succeeded';
    }
    catch (error) { job.state = 'failed'; job.error = error.message; await bridge.close(); }
    finally { clearTimeout(watchdog); }
  });
  return { job_id: job.job_id, state: job.state, chat_name: job.chat_name };
}, false, false);
tool('get_job', 'Poll a conversation job. States: running, succeeded, failed. Results include assistant replies.', { job_id: z.string() }, async ({ job_id }) => {
  const job = jobs.get(job_id); if (!job) throw new Error('Unknown job ID (jobs are scoped to this server process)');
  const { signature, ...result } = job; return result;
}, true, false);

await server.connect(new StdioServerTransport());
server.server.onclose = () => { void bridge.close(); };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await bridge.close(); process.exit(0); });
