import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ADAPTERS, resolveId } from '../src/adapters.js';
import { buildCommand } from '../src/runner.js';
import { pickAgent } from '../src/router.js';

const bin = path.resolve('bin/maxai.js');

test('all nine agents are registered', () => {
  assert.deepEqual(Object.keys(ADAPTERS).sort(),
    ['amp', 'antigravity', 'copilot', 'droid', 'kimi', 'kiro', 'opencode', 'qoder', 'rovodev']);
});

test('aliases resolve', () => {
  assert.equal(resolveId('gh'), 'copilot');
  assert.equal(resolveId('Q'), 'kiro');
  assert.equal(resolveId('nope'), null);
});

test('buildCommand: rovodev uses acli prefix; yolo/model map', () => {
  const c = buildCommand('rovodev', 'run', { prompt: 'hi' });
  assert.deepEqual(c.args, ['rovodev', 'run', 'hi']);
  const d = buildCommand('droid', 'run', { prompt: 'x', model: 'm', yolo: true });
  assert.deepEqual(d.args, ['exec', '-m', 'm', '--auto', 'high', 'x']);
});

test('config template override', () => {
  const cfg = { agents: { kimi: { runTemplate: ['go', '{prompt}'], extraArgs: ['-v'] } } };
  assert.deepEqual(buildCommand('kimi', 'run', { prompt: 'p' }, cfg).args, ['go', 'p', '-v']);
});

test('router prefers installed agents', () => {
  assert.equal(pickAgent('summarize jira ticket', ['rovodev', 'amp']), 'rovodev');
  assert.equal(pickAgent('hello', ['kimi']), 'kimi');
  assert.equal(pickAgent('hello', []), null);
});

test('e2e: fake agent on PATH, run + fallback + compare', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxai-'));
  const mk = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, `#!/bin/sh\n${body}\n`); fs.chmodSync(p, 0o755); };
  mk('droid', 'echo "droid got: $*"');
  mk('amp', 'echo boom >&2; exit 3');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, XDG_CONFIG_HOME: dir };
  const sh = (...a) => spawnSync('node', [bin, ...a], { env, encoding: 'utf8', cwd: dir, input: '' });
  let r = sh('droid', 'fix', 'bug');
  assert.match(r.stdout, /droid got: exec fix bug/);
  r = sh('run', '-a', 'amp', '-f', 'droid', 'task');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /droid got: exec task/);
  r = sh('compare', '-a', 'all', '--json', 'q');
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.map((x) => x.agent).sort(), ['amp', 'droid']);
  r = sh('list', '--json');
  assert.equal(JSON.parse(r.stdout).find((x) => x.id === 'droid').installed, true);
});
