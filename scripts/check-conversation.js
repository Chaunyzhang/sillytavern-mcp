import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const client = new Client({ name: 'conversation-check', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.js', import.meta.url))] }));
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}
try {
  const cards = await call('list_characters');
  if (!cards.length) throw new Error('No characters available');
  const args = { avatar: process.env.ST_TEST_AVATAR || cards[0].avatar, messages: ['这是一条 MCP 自动化接入测试。请只回复：MCP连接成功。'], request_id: 'check-' + Date.now(), timeout_seconds: 120 };
  const started = await call('start_conversation', args);
  const duplicate = await call('start_conversation', args);
  assert.equal(duplicate.chat_name, started.chat_name);
  let job;
  do {
    await new Promise(resolve => setTimeout(resolve, 2000));
    job = await call('get_job', { job_id: started.job_id });
  } while (job.state === 'running');
  assert.equal(job.state, 'succeeded', job.error);
  const chat = await call('get_chat', { avatar: args.avatar, chat_name: started.chat_name });
  assert.ok(chat.some(x => x.is_user && x.mes === args.messages[0]));
  assert.ok(job.result.replies.length > 0);
  console.log(JSON.stringify({ state: job.state, chat_name: job.chat_name, replyCount: job.result.replies.length, savedMessages: chat.length }));
} finally { await client.close(); }
