import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

export function tempEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxaicli-'));
  return { MAXAICLI_HOME: dir, ...extra };
}

export function sseBody(texts, chunkSize = 17) {
  const events = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start' })}\n\n`,
    ...texts.map(
      (t) =>
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: t },
        })}\n\n`
    ),
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ].join('');
  const bytes = new TextEncoder().encode(events);
  // Split into awkward chunk boundaries to exercise the parser.
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
}

export function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    return handler({ url, init, body, n: calls.length });
  };
  impl.calls = calls;
  return impl;
}

export const okStream = (texts) => new Response(sseBody(texts), { status: 200 });

export function capture() {
  let out = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      out += chunk;
      cb();
    },
  });
  return { stream, text: () => out };
}

export function makeIo({ env, fetchImpl, stdin = '', isTTY = false } = {}) {
  const stdout = capture();
  const stderr = capture();
  const input = Readable.from(stdin ? [stdin] : []);
  input.isTTY = isTTY;
  return {
    io: { stdin: input, stdout: stdout.stream, stderr: stderr.stream, env, fetchImpl },
    out: stdout.text,
    err: stderr.text,
  };
}
