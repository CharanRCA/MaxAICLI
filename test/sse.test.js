import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../src/sse.js';

async function collect(chunks) {
  const out = [];
  for await (const ev of parseSSE(chunks)) out.push(ev);
  return out;
}

test('parses events split across chunks', async () => {
  const events = await collect(['event: a\nda', 'ta: 1\n\nevent: b\ndata: 2\n\n']);
  assert.deepEqual(events, [
    { event: 'a', data: '1' },
    { event: 'b', data: '2' },
  ]);
});

test('handles CRLF, comments, multi-line data and a missing trailing blank line', async () => {
  const events = await collect([': ping\r\ndata: x\r\ndata: y\r\n\r\nevent: z\r\ndata: end']);
  assert.deepEqual(events, [
    { event: 'message', data: 'x\ny' },
    { event: 'z', data: 'end' },
  ]);
});

test('does not split multi-byte characters across byte chunks', async () => {
  const bytes = new TextEncoder().encode('data: héllo 😀\n\n');
  const chunks = Array.from(bytes, (b) => Uint8Array.of(b));
  assert.deepEqual(await collect(chunks), [{ event: 'message', data: 'héllo 😀' }]);
});
