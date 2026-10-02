import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

test('MCP handshake, tool schemas, validation and live SillyTavern reads', { timeout: 60000 }, async () => {
  const client = new Client({ name: 'smoke', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.js', import.meta.url))] });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 11);
    const invalid = await client.callTool({ name: 'get_character', arguments: { avatar: '../secret.png' } });
    assert.equal(invalid.isError, true);
    const missing = await client.callTool({ name: 'get_job', arguments: { job_id: 'missing' } });
    assert.equal(missing.isError, true);
    const status = await client.callTool({ name: 'status', arguments: {} });
    assert.ok(!status.isError, JSON.stringify(status));
    assert.equal(typeof JSON.parse(status.content[0].text).characterCount, 'number');
    const cards = await client.callTool({ name: 'list_characters', arguments: {} });
    assert.ok(!cards.isError, JSON.stringify(cards));
    assert.ok(Array.isArray(JSON.parse(cards.content[0].text)));
    const worlds = await client.callTool({ name: 'list_worlds', arguments: {} });
    assert.ok(!worlds.isError, JSON.stringify(worlds));
  } finally { await client.close(); }
});
