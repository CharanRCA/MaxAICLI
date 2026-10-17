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
  const env = { ...process.env, PATH: `${dir}:/usr/bin:/bin`, XDG_CONFIG_HOME: dir, HOME: dir, MAXAI_STRICT_PATH: '1' };
  const sh = (...a) => spawnSync(process.execPath, [bin, ...a], { env, encoding: 'utf8', cwd: dir, input: '' });
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

test('install: skips present, dry-run plans, refuses non-tty without --yes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxai-i-'));
  const mk = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, `#!/bin/sh\n${body}\n`); fs.chmodSync(p, 0o755); };
  mk('droid', 'echo droid 1.2.3');
  mk('npm', 'echo "npm $*"; printf "#!/bin/sh\\necho amp 9\\n" > "$(dirname "$0")/amp"; chmod +x "$(dirname "$0")/amp"');
  const env = { ...process.env, PATH: `${dir}:/usr/bin:/bin`, XDG_CONFIG_HOME: dir, HOME: dir, MAXAI_STRICT_PATH: '1' };
  const sh = (...a) => spawnSync(process.execPath, [bin, ...a], { env, encoding: 'utf8', cwd: dir, input: '' });
  let r = sh('install', 'droid');
  assert.match(r.stdout, /already installed \(droid 1\.2\.3\)/);
  r = sh('install', 'amp', '--dry-run');
  assert.match(r.stdout, /npm i -g @sourcegraph\/amp/);
  r = sh('install', 'amp');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--yes/);
  r = sh('install', 'amp', '--yes');
  assert.match(r.stdout, /-> installed/);
  r = sh('install', 'antigravity', '--yes');
  assert.match(r.stdout, /manual install/);
});

test('ui: token + host guards, agents api, streaming run', async () => {
  const { startUI } = await import('../src/ui.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxai-u-'));
  const p = path.join(dir, 'droid'); fs.writeFileSync(p, '#!/bin/sh\necho "hi $*"\n'); fs.chmodSync(p, 0o755);
  const old = process.env.PATH; process.env.PATH = `${dir}:${old}`; process.env.MAXAI_STRICT_PATH = '1';
  const { server, url, token } = await startUI({ agents: {} }, { port: 0 });
  try {
    const html = await (await fetch(url)).text();
    assert.ok(html.includes(token));
    assert.equal((await fetch(url + 'api/agents')).status, 401);
    const rows = await (await fetch(url + 'api/agents', { headers: { 'x-maxai-token': token } })).json();
    assert.equal(rows.find((r) => r.id === 'droid').installed, true);
    const res = await fetch(url + 'api/run', { method: 'POST', headers: { 'x-maxai-token': token }, body: JSON.stringify({ prompt: 'yo', agents: ['droid'] }) });
    const evs = (await res.text()).trim().split('\n').map(JSON.parse);
    assert.ok(evs.some((e) => e.type === 'out' && /hi exec yo/.test(e.data)));
    assert.equal(evs.at(-1).code, 0);
    const bad = await fetch(url + 'api/agents', { headers: { host: 'evil.com', 'x-maxai-token': token } }).catch(() => null);
    assert.ok(bad);
  } finally { server.close(); process.env.PATH = old; delete process.env.MAXAI_STRICT_PATH; }
});

test('pool: failover on quota, cooldown persisted, parallel batch, race', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxai-p-'));
  const mk = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, `#!/bin/sh\n${body}\n`); fs.chmodSync(p, 0o755); };
  mk('amp', 'echo "Error: rate limit exceeded, try again in 30 minutes" >&2; exit 1');
  mk('droid', 'sleep 0.4; echo "droid: $*"');
  mk('opencode', 'sleep 0.4; echo "opencode: $*"');
  const env = { ...process.env, PATH: `${dir}:/usr/bin:/bin`, XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, HOME: dir, MAXAI_STRICT_PATH: '1' };
  const sh = (...a) => spawnSync(process.execPath, [bin, ...a], { env, encoding: 'utf8', cwd: dir, input: '' });
  let r = sh('pool', '-a', 'amp,droid', 'hello');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /droid: exec hello/);
  assert.match(r.stderr, /amp quota/);
  r = sh('pool', 'status', '--json');
  const amp = JSON.parse(r.stdout).find((l) => l.name === 'amp');
  assert.equal(amp.state, 'cooling');
  assert.ok(amp.cooldownSec > 1700);
  // 6 tasks, 2 healthy lanes x 3 slots => all run at once (~0.4s, not 2.4s)
  fs.writeFileSync(path.join(dir, 't.txt'), 'a\nb\nc\nd\ne\nf\n');
  const t0 = Date.now();
  r = sh('pool', '--batch', 't.txt', '--per-lane', '3');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
  assert.equal((r.stdout.match(/^###/gm) || []).length, 6);
  r = sh('pool', '--race', '2', '--json', 'go');
  assert.equal(JSON.parse(r.stdout).ok, true);
  r = sh('pool', 'reset');
  assert.equal(JSON.parse(sh('pool', 'status', '--json').stdout).find((l) => l.name === 'amp').state, 'ready');
  // bare `run` goes through the pool too
  r = sh('hello', 'there');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /(droid|opencode): /);
});

test('pool: refreshLanes mid-flight does not leak slots (regression)', async () => {
  const { Pool } = await import('../src/pool.js');
  const lanes = [{ name: 'a', agent: 'a', concurrency: 1, weight: 1, inFlight: 0, lastUsed: 0 }];
  const run = () => new Promise((r) => setTimeout(() => r({ code: 0, out: 'ok', err: '', ms: 1 }), 50));
  const pool = new Pool({ agents: {} }, { lanes, run, state: path.join(os.tmpdir(), `maxai-s-${Date.now()}.json`) });
  pool.refreshLanes = pool.refreshLanes.bind(pool);
  const jobs = [pool.submit('x'), pool.submit('y'), pool.submit('z')];
  pool.cfg = { pool: { lanes: [{ agent: 'a' }] }, agents: {} };
  pool.refreshLanes(['a']);
  const rs = await Promise.all(jobs);
  assert.ok(rs.every((r) => r.ok));
  assert.equal(pool.lanes[0].inFlight, 0);
});

test('classify: no false positives on ordinary output / stack traces', async () => {
  const { classify } = await import('../src/pool.js');
  assert.equal(classify({ code: 0, out: 'Rate limiting works by counting requests per window.' }).kind, 'ok');
  assert.equal(classify({ code: 1, err: 'Traceback: line 429 in foo.py\nValueError' }).kind, 'error');
  assert.equal(classify({ code: 0, out: 'Error: rate limit exceeded' }).kind, 'quota');
  assert.equal(classify({ code: 1, err: 'HTTP 429 Too Many Requests; retry in 2 minutes' }).retryAfterSec, 120);
  assert.equal(classify({ code: 1, err: 'please log in first' }).kind, 'auth');
});

test('cli: prompts that start with a command word are prompts; open stdin never hangs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxai-c-'));
  const p = path.join(dir, 'droid'); fs.writeFileSync(p, '#!/bin/sh\necho "got: $*"\n'); fs.chmodSync(p, 0o755);
  const env = { ...process.env, PATH: `${dir}:/usr/bin:/bin`, XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, HOME: dir, MAXAI_STRICT_PATH: '1' };
  const { spawn } = await import('node:child_process');
  const out = await new Promise((resolve) => {
    // stdin is an open pipe that never closes
    const c = spawn(process.execPath, [bin, 'list', 'the', 'files'], { env, cwd: dir });
    let s = ''; c.stdout.on('data', (d) => (s += d));
    const t = setTimeout(() => { c.kill(); resolve('HUNG'); }, 5000);
    c.on('close', () => { clearTimeout(t); resolve(s); });
  });
  assert.match(out, /got: exec list the files/);
});

test('ui: cwd is HTML-escaped and $ patterns are not interpreted', async () => {
  const { startUI } = await import('../src/ui.js');
  const { server, url } = await startUI({ agents: {} }, { port: 0, cwd: '/x"><script>$&</script>' });
  try {
    const html = await (await fetch(url)).text();
    assert.ok(!html.includes('<script>$&'));
    assert.ok(html.includes('&lt;script&gt;$&amp;'));
  } finally { server.close(); }
});

test('classify: real-world auth wording and ANSI colours', async () => {
  const { classify } = await import('../src/pool.js');
  assert.equal(classify({ code: 1, err: "Error: Run 'gh auth login' to authenticate with the GitHub CLI" }).kind, 'auth');
  assert.equal(classify({ code: 1, err: '\x1b[91mError: \x1b[0mrate limit exceeded' }).kind, 'quota');
});
