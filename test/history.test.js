import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteSession, listSessions, loadSession, sanitizeName, saveSession } from '../src/history.js';
import { tempEnv } from './helpers.js';

test('save, load, list and delete a session', () => {
  const env = tempEnv();
  assert.deepEqual(loadSession('a', env), []);
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  saveSession('a', msgs, env);
  assert.deepEqual(loadSession('a', env), msgs);
  const [entry] = listSessions(env);
  assert.equal(entry.name, 'a');
  assert.equal(entry.messages, 2);
  assert.equal(deleteSession('a', env), true);
  assert.equal(deleteSession('a', env), false);
  assert.deepEqual(listSessions(env), []);
});

test('rejects session names that could escape the history directory', () => {
  assert.throws(() => sanitizeName('../evil'), /Invalid session name/);
  assert.throws(() => sanitizeName(''), /Invalid session name/);
  assert.equal(sanitizeName('work_1-b'), 'work_1-b');
});
