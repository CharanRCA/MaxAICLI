import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/cli.js';
import { loadSession } from '../src/history.js';
import { fakeFetch, makeIo, okStream, tempEnv } from './helpers.js';

const withKey = () => tempEnv({ ANTHROPIC_API_KEY: 'test-key' });

test('--help and --version', async () => {
  const a = makeIo({ env: tempEnv() });
  assert.equal(await run(['--help'], a.io), 0);
  assert.match(a.out(), /Usage:/);
  const b = makeIo({ env: tempEnv() });
  assert.equal(await run(['--version'], b.io), 0);
  assert.match(b.out(), /^\d+\.\d+\.\d+\n$/);
});

test('one-shot prompt streams the reply', async () => {
  const fetchImpl = fakeFetch(() => okStream(['4', '2']));
  const { io, out } = makeIo({ env: withKey(), fetchImpl });
  assert.equal(await run(['what', 'is', '6x7?'], io), 0);
  assert.equal(out(), '42\n');
  assert.equal(fetchImpl.calls[0].body.messages[0].content, 'what is 6x7?');
});

test('--no-stream uses the non-streaming endpoint', async () => {
  const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] })));
  const { io, out } = makeIo({ env: withKey(), fetchImpl });
  assert.equal(await run(['--no-stream', 'yo'], io), 0);
  assert.equal(out(), 'hi\n');
  assert.equal(fetchImpl.calls[0].body.stream, false);
});

test('piped stdin is appended to the prompt', async () => {
  const fetchImpl = fakeFetch(() => okStream(['ok']));
  const { io } = makeIo({ env: withKey(), fetchImpl, stdin: 'file contents\n' });
  await run(['summarise'], io);
  assert.equal(fetchImpl.calls[0].body.messages[0].content, 'summarise\n\nfile contents');
});

test('flags override model, system and max tokens', async () => {
  const fetchImpl = fakeFetch(() => okStream(['ok']));
  const { io } = makeIo({ env: withKey(), fetchImpl });
  await run(['-m', 'custom', '-s', 'sys', '--max-tokens', '77', 'hi'], io);
  const { body } = fetchImpl.calls[0];
  assert.equal(body.model, 'custom');
  assert.equal(body.system, 'sys');
  assert.equal(body.max_tokens, 77);
});

test('sessions persist and resume across runs', async () => {
  const env = withKey();
  const fetchImpl = fakeFetch(({ n }) => okStream([`reply${n}`]));
  await run(['-S', 'chat', 'first'], makeIo({ env, fetchImpl }).io);
  await run(['-S', 'chat', 'second'], makeIo({ env, fetchImpl }).io);
  assert.deepEqual(
    fetchImpl.calls[1].body.messages.map((m) => m.content),
    ['first', 'reply1', 'second']
  );
  assert.equal(loadSession('chat', env).length, 4);
});

test('failed request is not saved to history', async () => {
  const env = withKey();
  const fetchImpl = fakeFetch(() => new Response('{"error":{"message":"boom"}}', { status: 500 }));
  const { io, err } = makeIo({ env, fetchImpl });
  assert.equal(await run(['-S', 's', 'hi'], io), 1);
  assert.match(err(), /boom/);
  assert.deepEqual(loadSession('s', env), []);
});

test('missing API key gives a clear error and makes no request', async () => {
  const fetchImpl = fakeFetch(() => okStream(['x']));
  const { io, err } = makeIo({ env: tempEnv(), fetchImpl });
  assert.equal(await run(['hi'], io), 1);
  assert.match(err(), /No API key/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('invalid --max-tokens is rejected', async () => {
  const { io, err } = makeIo({ env: withKey(), fetchImpl: fakeFetch(() => okStream(['x'])) });
  assert.equal(await run(['--max-tokens', 'abc', 'hi'], io), 1);
  assert.match(err(), /max-tokens/);
});

test('config command set/get/list masks the API key', async () => {
  const env = tempEnv();
  await run(['config', 'set', 'apiKey', 'sk-ant-secret-1234'], makeIo({ env }).io);
  const get = makeIo({ env });
  await run(['config', 'get', 'apiKey'], get.io);
  assert.doesNotMatch(get.out(), /secret/);
  const list = makeIo({ env });
  await run(['config', 'list'], list.io);
  assert.match(list.out(), /apiKey = sk-a\.\.\.1234/);
  const bad = makeIo({ env });
  assert.equal(await run(['config', 'set', 'bogus', '1'], bad.io), 1);
});

test('history list/show/delete', async () => {
  const env = withKey();
  const fetchImpl = fakeFetch(() => okStream(['pong']));
  await run(['-S', 'h', 'ping'], makeIo({ env, fetchImpl }).io);
  const list = makeIo({ env });
  await run(['history', 'list'], list.io);
  assert.match(list.out(), /^h\t2 messages/);
  const show = makeIo({ env });
  await run(['history', 'show', 'h'], show.io);
  assert.match(show.out(), /\[user\]\nping[\s\S]*\[assistant\]\npong/);
  const del = makeIo({ env });
  assert.equal(await run(['history', 'delete', 'h'], del.io), 0);
  assert.equal(await run(['history', 'delete', 'h'], makeIo({ env }).io), 1);
});

test('interactive mode handles chat, slash commands and saves the session', async () => {
  const env = withKey();
  const fetchImpl = fakeFetch(({ n }) => okStream([`r${n}`]));
  const stdin = ['/model foo', 'hello', '/history', 'again', '/exit', ''].join('\n');
  const { io, out } = makeIo({ env, fetchImpl, stdin, isTTY: true });
  assert.equal(await run([], io), 0);
  assert.match(out(), /Model: foo/);
  assert.match(out(), /claude> r1/);
  assert.match(out(), /2 messages in this conversation/);
  assert.equal(fetchImpl.calls[1].body.model, 'foo');
  assert.deepEqual(
    fetchImpl.calls[1].body.messages.map((m) => m.content),
    ['hello', 'r1', 'again']
  );
  assert.equal(loadSession('default', env).length, 4);
});
