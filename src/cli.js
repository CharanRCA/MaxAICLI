import fs from 'node:fs';
import { ADAPTERS, resolveId } from './adapters.js';
import { loadConfig, configPaths } from './config.js';
import { locate, buildCommand, runInherit, runCapture } from './runner.js';
import { pickAgent } from './router.js';
import { status, plan, describe, installAgent } from './installer.js';
import { startUI } from './ui.js';
import { Pool } from './pool.js';
import readline from 'node:readline/promises';

const HELP = `maxai - one CLI for many coding agents

Usage:
  maxai [run] [options] <prompt>      one prompt on the POOL: load-balanced over every installed
                                      agent's free quota, with automatic failover
  maxai pool --batch tasks.txt        many prompts in parallel across the whole pool
                                      (one per line, '-' = stdin; JSONL {"prompt":..} ok)
  maxai pool --race 3 <prompt>        same prompt on 3 agents at once, fastest answer wins
  maxai pool status | reset [lane]    show lanes/quota cooldowns, or clear them
  maxai <agent> <prompt>              one-shot prompt on a specific agent
  maxai chat [-a agent] [prompt]      interactive session in that agent's own TUI
  maxai compare [-a a,b|all] <prompt> run on several agents in parallel, print side by side
  maxai list                          show agents and whether they are installed
  maxai install [ids|all]             install agent CLIs (skips ones already present)
  maxai ui [--port N] [--open]        local web UI: run, compare, install from the browser
  maxai config                        show config file locations / merged config

Options:
  -a, --agent <id[,id]>   agent (kiro opencode antigravity copilot qoder amp rovodev kimi droid)
  -m, --model <name>      model passed through to the agent
  -f, --fallback <ids>    on failure, try these agents in order
  -C, --cwd <dir>         working directory
  -y, --yolo              let the agent run tools without asking (use with care)
      --json              (run/compare) print machine-readable JSON, captured not streamed
      --dry-run           print the command that would run
      --timeout <sec>     kill an agent after N seconds (compare/fallback/json)
  -h, --help
Pool options: --batch <file|->, --race <n>, --per-lane <n> (concurrency per lane), --no-wait
Install options: --yes (no confirmation), --force (reinstall even if present), --dry-run
Prompt may also be piped on stdin.
`;

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--') { o._.push(...argv.slice(i + 1)); break; }
    else if (a === '-a' || a === '--agent') o.agent = val();
    else if (a === '-m' || a === '--model') o.model = val();
    else if (a === '-f' || a === '--fallback') o.fallback = val();
    else if (a === '-C' || a === '--cwd') o.cwd = val();
    else if (a === '--timeout') o.timeout = Number(val());
    else if (a === '-y' || a === '--yolo') o.yolo = true;
    else if (a === '--json') o.json = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--batch') o.batch = val();
    else if (a === '--race') o.race = Number(val());
    else if (a === '--per-lane') o.perLane = Number(val());
    else if (a === '--no-wait') o.noWait = true;
    else if (a === '--force') o.force = true;
    else if (a === '--open') o.open = true;
    else if (a === '--port') o.port = Number(val());
    else if (a === '--dry-run') o.dry = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('-') && a.length > 1) throw new Error(`unknown option ${a}`);
    else o._.push(a);
  }
  return o;
}

const ids = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
  const id = resolveId(x);
  if (!id) throw new Error(`unknown agent "${x}". Known: ${Object.keys(ADAPTERS).join(', ')}`);
  return id;
});

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const c of process.stdin) s += c;
  return s.trim();
}

async function getPrompt(o, words) {
  const arg = words.join(' ').trim();
  const piped = await readStdin();
  return [arg, piped].filter(Boolean).join('\n\n');
}

const installedIds = (cfg) => Object.keys(ADAPTERS).filter((id) => locate(id, cfg));
const show = (c) => [c.command, ...c.args].map((x) => (/[\s"']/.test(x) ? JSON.stringify(x) : x)).join(' ');

function cmdList(cfg, o) {
  const rows = Object.entries(ADAPTERS).map(([id, a]) => {
    const p = locate(id, cfg);
    return { id, name: a.name, installed: !!p, path: p, install: a.install };
  });
  if (o.json) return console.log(JSON.stringify(rows, null, 2));
  for (const r of rows) {
    console.log(`${r.installed ? '✔' : '✘'} ${r.id.padEnd(12)} ${r.name.padEnd(20)} ${r.installed ? r.path : 'not found - ' + r.install}`);
  }
}

async function cmdRun(cfg, o, words) {
  if (!o.agent && !o.dry && !o.json && !o.fallback && !o.timeout) return cmdPool(cfg, o, words);
  const prompt = await getPrompt(o, words);
  if (!prompt) throw new Error('no prompt given');
  const inst = installedIds(cfg);
  let chain = o.agent ? ids(o.agent) : [];
  if (!chain.length) {
    const pick = pickAgent(prompt, inst, cfg);
    if (!pick && !o.dry) throw new Error('no supported agent CLI found on PATH. Run `maxai list`.');
    chain = [pick || cfg.default || 'opencode'];
  }
  chain.push(...ids(o.fallback || (cfg.fallback || []).join(',') || ''));
  chain = [...new Set(chain)];
  const capture = o.json || chain.length > 1 || o.timeout;
  const results = [];
  for (const id of chain) {
    const cmd = buildCommand(id, 'run', { prompt, model: o.model, yolo: o.yolo }, cfg);
    if (o.dry) { console.log(`[${id}] ${show(cmd)}`); continue; }
    if (!locate(id, cfg)) { results.push({ agent: id, code: 127, error: 'not installed' }); console.error(`maxai: ${id} not installed, skipping`); continue; }
    if (!capture) return runInherit(cmd, { cwd: o.cwd });
    console.error(`maxai: using ${id}`);
    const r = await runCapture(cmd, { cwd: o.cwd, timeoutMs: o.timeout && o.timeout * 1000, onData: o.json ? null : (d) => process.stdout.write(d) });
    results.push({ agent: id, code: r.code, ms: r.ms, output: r.out, stderr: r.err });
    if (r.code === 0) break;
    console.error(`maxai: ${id} exited ${r.code}${r.err ? ': ' + r.err.trim().split('\n').pop() : ''}`);
  }
  if (o.dry) return 0;
  if (o.json) console.log(JSON.stringify(results.at(-1) && results.length === 1 ? results[0] : results, null, 2));
  return results.at(-1)?.code ?? 1;
}

async function cmdCompare(cfg, o, words) {
  const prompt = await getPrompt(o, words);
  if (!prompt) throw new Error('no prompt given');
  const want = !o.agent || o.agent === 'all' ? installedIds(cfg) : ids(o.agent);
  if (!want.length) throw new Error('no agents available');
  const jobs = want.map(async (id) => {
    const cmd = buildCommand(id, 'run', { prompt, model: o.model, yolo: o.yolo }, cfg);
    if (o.dry) return { agent: id, code: 0, output: show(cmd), ms: 0 };
    if (!locate(id, cfg)) return { agent: id, code: 127, output: '', stderr: 'not installed', ms: 0 };
    const r = await runCapture(cmd, { cwd: o.cwd, timeoutMs: (o.timeout || 300) * 1000 });
    return { agent: id, code: r.code, output: r.out, stderr: r.err, ms: r.ms };
  });
  const res = await Promise.all(jobs);
  if (o.json) { console.log(JSON.stringify(res, null, 2)); return 0; }
  for (const r of res) {
    console.log(`\n━━━ ${ADAPTERS[r.agent].name} (${r.agent}) · exit ${r.code} · ${(r.ms / 1000).toFixed(1)}s ━━━`);
    console.log(r.output.trim() || (r.stderr ? `(stderr) ${r.stderr.trim()}` : '(no output)'));
  }
  return res.some((r) => r.code !== 0) ? 1 : 0;
}

async function cmdChat(cfg, o, words) {
  const prompt = words.join(' ').trim();
  const id = o.agent ? ids(o.agent)[0] : pickAgent(prompt, installedIds(cfg), cfg);
  if (!id) throw new Error('no supported agent CLI found on PATH. Run `maxai list`.');
  const cmd = buildCommand(id, 'chat', { prompt, model: o.model, yolo: o.yolo }, cfg);
  if (o.dry) { console.log(`[${id}] ${show(cmd)}`); return 0; }
  return runInherit(cmd, { cwd: o.cwd });
}

function lineLabel(s, n = 60) { s = s.replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

async function cmdPool(cfg, o, words) {
  if (o.perLane) cfg = { ...cfg, pool: { ...cfg.pool, concurrency: o.perLane } };
  const pool = new Pool(cfg);
  const sub = words[0];
  if (sub === 'status') {
    const st = pool.status();
    if (o.json) { console.log(JSON.stringify(st, null, 2)); return 0; }
    if (!st.length) { console.log('no lanes: no supported agent CLI is installed. Try `maxai install`.'); return 1; }
    for (const l of st) {
      const flag = l.state === 'ready' ? '✔' : l.state === 'needs-login' ? '🔑' : '⏳';
      const extra = l.state === 'ready' ? '' : ` (${l.reason}, ${Math.ceil(l.cooldownSec / 60)}m left)`;
      console.log(`${flag} ${l.name.padEnd(28)} ${l.state}${extra}  slots ${l.concurrency}  ok ${l.ok} fail ${l.fail} quota-hits ${l.quotaHits}`);
    }
    console.log(`\npool capacity: ${st.filter((l) => l.state === 'ready').reduce((n, l) => n + l.concurrency, 0)} parallel requests`);
    return 0;
  }
  if (sub === 'reset') { pool.reset(words[1]); console.log('pool state cleared'); return 0; }
  const pin = o.agent ? ids(o.agent) : undefined;
  const opts = { pin, cwd: o.cwd, yolo: o.yolo ?? cfg.yolo, wait: !o.noWait };
  if (!pool.lanes.length) throw new Error('no supported agent CLI found on PATH. Run `maxai install`.');
  pool.on('attempt', (a) => { if (a.kind !== 'ok' && a.kind !== 'aborted') console.error(`maxai: ${a.lane} ${a.kind}${a.err ? ' - ' + lineLabel(a.err, 80) : ''} -> failing over`); });

  let prompts;
  if (o.batch) {
    const raw = o.batch === '-' ? await readStdin() : fs.readFileSync(o.batch, 'utf8');
    prompts = raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { if (l[0] === '{') { try { return JSON.parse(l).prompt; } catch {} } return l; });
    if (!prompts.length) throw new Error('batch file has no prompts');
  } else {
    const p = await getPrompt(o, words[0] === 'run' ? words.slice(1) : words);
    if (!p) throw new Error('no prompt given');
    prompts = [p];
  }

  if (o.dry) { for (const l of pool.status()) console.log(`lane ${l.name} (slots ${l.concurrency}, ${l.state})`); console.log(`${prompts.length} task(s)`); return 0; }
  let done = 0, failed = 0;
  const finish = (i, r) => {
    done++; if (!r.ok) failed++;
    if (o.json) console.log(JSON.stringify({ index: i, ...r }));
    else if (prompts.length === 1) { if (r.ok) process.stdout.write(r.output.endsWith('\n') ? r.output : r.output + '\n'); else console.error(`maxai: failed - ${r.error}`); }
    else {
      console.error(`[${done}/${prompts.length}] ${r.ok ? '✔ ' + r.lane : '✘ ' + r.error} · ${(r.ms / 1000).toFixed(1)}s · ${lineLabel(r.prompt)}`);
      if (r.ok) console.log(`### ${i + 1}: ${lineLabel(r.prompt)}\n${r.output.trim()}\n`);
    }
  };
  if (o.race > 1) { const r = await pool.race(prompts[0], o.race, opts); finish(0, r); return r.ok ? 0 : 1; }
  await Promise.all(prompts.map((p, i) => pool.submit(p, opts).then((r) => finish(i, r))));
  if (prompts.length > 1) console.error(`\npool done: ${done - failed} ok, ${failed} failed`);
  return failed ? 1 : 0;
}

async function cmdInstall(cfg, o, words) {
  const want = !words.length || words.includes('missing') ? 'missing' : words.includes('all') ? 'all' : null;
  const targets = want ? Object.keys(ADAPTERS) : words.flatMap((w) => ids(w));
  const sts = await Promise.all(targets.map((id) => status(id, cfg)));
  const todo = [];
  for (const s of sts) {
    if (s.installed && !o.force) { console.log(`✔ ${s.id.padEnd(12)} already installed (${s.version || s.path})`); continue; }
    const p = plan(s.id);
    if (!p.recipe) { console.log(`! ${s.id.padEnd(12)} manual install: ${p.manual}`); continue; }
    todo.push([s.id, p.recipe]);
  }
  if (!todo.length) return 0;
  console.log('\nWill run:');
  for (const [id, r] of todo) console.log(`  ${id.padEnd(12)} ${describe(r)}`);
  if (o.dry) return 0;
  if (!o.yes) {
    if (!process.stdin.isTTY) throw new Error('refusing to run installers non-interactively without --yes');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question('\nProceed? These execute remote install scripts / package installs [y/N] ')).trim().toLowerCase();
    rl.close();
    if (a !== 'y' && a !== 'yes') { console.log('aborted'); return 1; }
  }
  let bad = 0;
  for (const [id] of todo) {
    console.log(`\n=== ${id} ===`);
    const r = await installAgent(id, cfg, { force: o.force, onData: (d) => process.stdout.write(d) });
    console.log(`-> ${r.result}${r.path ? ' ' + r.path : ''}${r.hint ? ' - ' + r.hint : ''}`);
    if (r.result === 'failed') bad++;
  }
  return bad ? 1 : 0;
}

async function cmdUI(cfg, o) {
  const { url } = await startUI(cfg, { port: o.port ?? 4747, cwd: o.cwd || process.cwd() });
  console.log(`MaxAI UI running at ${url}  (Ctrl+C to stop)`);
  if (o.open) {
    const { spawn } = await import('node:child_process');
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    spawn(opener, process.platform === 'win32' ? ['/c', 'start', url] : [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
  return new Promise(() => {}); // run until killed
}

export async function main(argv) {
  try {
    const o = parse(argv);
    const cfg = loadConfig();
    if (o.help || (!o._.length && process.stdin.isTTY)) { console.log(HELP); return 0; }
    const [first, ...rest] = o._;
    switch (first) {
      case 'list': case 'doctor': cmdList(cfg, o); return 0;
      case 'config':
        console.log(configPaths().map((p) => `${fs.existsSync(p) ? '✔' : '·'} ${p}`).join('\n'));
        console.log(JSON.stringify(cfg, null, 2)); return 0;
      case 'install': return await cmdInstall(cfg, o, rest);
      case 'ui': return await cmdUI(cfg, o);
      case 'pool': return await cmdPool(cfg, o, rest);
      case 'run': return await cmdRun(cfg, o, rest);
      case 'chat': return await cmdChat(cfg, o, rest);
      case 'compare': return await cmdCompare(cfg, o, rest);
    }
    const id = first && resolveId(first);
    if (id && rest.length) return await cmdRun(cfg, { ...o, agent: id }, rest);
    if (id) return await cmdChat(cfg, { ...o, agent: id }, []);
    return await cmdRun(cfg, o, o._);
  } catch (e) {
    console.error(`maxai: ${e.message}`);
    return 2;
  }
}
