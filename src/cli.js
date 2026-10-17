import fs from 'node:fs';
import { ADAPTERS, resolveId } from './adapters.js';
import { loadConfig, configPaths } from './config.js';
import { locate, buildCommand, runInherit, runCapture } from './runner.js';
import { pickAgent } from './router.js';

const HELP = `maxai - one CLI for many coding agents

Usage:
  maxai [run] [options] <prompt>      one-shot prompt (auto-picks an installed agent)
  maxai <agent> <prompt>              one-shot prompt on a specific agent
  maxai chat [-a agent] [prompt]      interactive session in that agent's own TUI
  maxai compare [-a a,b|all] <prompt> run on several agents in parallel, print side by side
  maxai list                          show agents and whether they are installed
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
