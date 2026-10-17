import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, sendMessage, streamMessage } from '../src/client.js';
import { fakeFetch, okStream } from './helpers.js';

const base = {
  apiKey: 'k',
  baseUrl: 'https://example.test',
  model: 'm',
  system: 'be brief',
  maxTokens: 10,
  messages: [{ role: 'user', content: 'hi' }],
};

test('streamMessage yields text deltas and sends the right request', async () => {
  const fetchImpl = fakeFetch(() => okStream(['Hel', 'lo ', 'wörld']));
  let text = '';
  for await (const t of streamMessage({ ...base, fetchImpl })) text += t;
  assert.equal(text, 'Hello wörld');
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://example.test/v1/messages');
  assert.equal(call.init.headers['x-api-key'], 'k');
  assert.deepEqual(call.body, {
    model: 'm',
    max_tokens: 10,
    messages: base.messages,
    stream: true,
    system: 'be brief',
  });
});

test('omits system when empty', async () => {
  const fetchImpl = fakeFetch(() => okStream(['x']));
  for await (const _ of streamMessage({ ...base, system: '', fetchImpl }));
  assert.equal('system' in fetchImpl.calls[0].body, false);
});

test('HTTP errors become ApiError with a helpful message', async () => {
  const fetchImpl = fakeFetch(
    () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 })
  );
  await assert.rejects(
    async () => {
      for await (const _ of streamMessage({ ...base, fetchImpl }));
    },
    (err) => err instanceof ApiError && err.status === 401 && /invalid x-api-key.*check your API key/.test(err.message)
  );
});

test('mid-stream error events are surfaced', async () => {
  const body = 'event: error\ndata: {"type":"error","error":{"message":"Overloaded"}}\n\n';
  const fetchImpl = fakeFetch(() => new Response(body, { status: 200 }));
  await assert.rejects(
    async () => {
      for await (const _ of streamMessage({ ...base, fetchImpl }));
    },
    /Overloaded/
  );
});

test('sendMessage joins text blocks', async () => {
  const fetchImpl = fakeFetch(
    () =>
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] })
      )
  );
  assert.equal(await sendMessage({ ...base, fetchImpl }), 'ab');
  assert.equal(fetchImpl.calls[0].body.stream, false);
});
