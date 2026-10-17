import readline from 'node:readline';
import { Pool } from './pool.js';
import { ADAPTERS, resolveId } from './adapters.js';
import { startUI } from './ui.js';
import { locate } from './runner.js';

const HELP = `Type a prompt and press Enter; it runs on the pool (several can run at once).
  /race N <prompt>   same prompt on N agents, fastest answer wins
  /pin a,b | /pin    restrict to agents (empty = all)
  /status            lanes, slots, quota cooldowns
  /reset [lane]      clear cooldowns
  /yolo              toggle auto-approve of tool calls
  /ui                start the web UI
  /help  /quit`;

export async function repl(cfg, o = {}) {
  const pool = new Pool(cfg);
  let pin = o.agent ? o.agent.split(',').map((x) => resolveId(x.trim())).filter(Boolean) : undefined;
  let yolo = o.yolo ?? cfg.yolo ?? false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'maxai> ' });
  const say = (txt) => { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); console.log(txt); rl.prompt(true); };
  const show = (r) => say(r.ok ? `\n[${r.lane} · ${(r.ms / 1000).toFixed(1)}s]\n${r.output.trim()}\n` : `\nfailed: ${r.error}\n`);
  pool.on('attempt', (a) => { if (a.kind !== 'ok' && a.kind !== 'aborted') say(`  ${a.lane}: ${a.kind}${a.err ? ' - ' + a.err.slice(0, 70) : ''} -> trying another lane`); });

  console.log(`MaxAI - ${pool.lanes.length} lane(s): ${pool.lanes.map((l) => l.name).join(', ') || 'none installed (run: maxai install)'}\n${'/help for commands, Ctrl+D to exit'}`);
  rl.prompt();
  let pending = 0, closed = false;
  const finishIfDone = () => { if (closed && !pending) process.exit(0); };

  rl.on('line', async (raw) => {
    const line = raw.trim();
    if (!line) return rl.prompt();
    const [cmd, ...args] = line.split(/\s+/);
    if (cmd === '/quit' || cmd === '/exit') return rl.close();
    if (cmd === '/help') return say(HELP);
    if (cmd === '/status') {
      return say(pool.status().map((l) => `${l.state === 'ready' ? '✔' : '⏳'} ${l.name.padEnd(26)} ${l.state}${l.cooldownSec ? ` ${Math.ceil(l.cooldownSec / 60)}m` : ''}  ${l.inFlight}/${l.concurrency} busy  ok ${l.ok} fail ${l.fail}`).join('\n') || 'no lanes');
    }
    if (cmd === '/reset') { pool.reset(args[0]); return say('cooldowns cleared'); }
    if (cmd === '/yolo') { yolo = !yolo; return say(`auto-approve ${yolo ? 'ON' : 'off'}`); }
    if (cmd === '/pin') {
      pin = args.length ? args.join(',').split(',').map((x) => resolveId(x.trim())).filter(Boolean) : undefined;
      return say(pin ? `pinned to: ${pin.join(', ')}` : 'using all agents');
    }
    if (cmd === '/ui') {
      try { const { url } = await startUI(cfg, { fallback: true }); return say(`UI at ${url}`); } catch (e) { return say(`ui: ${e.message}`); }
    }
    let prompt = line, race = 0;
    if (cmd === '/race') { race = Number(args[0]); prompt = args.slice(1).join(' '); if (!(race > 1) || !prompt) return say('usage: /race N <prompt>'); }
    else if (cmd.startsWith('/')) return say(`unknown command ${cmd} (try /help)`);
    pool.refreshLanes(Object.keys(ADAPTERS).filter((id) => locate(id, cfg))); // pick up agents installed meanwhile
    if (!pool.lanes.length) return say('no agents installed - run `maxai install`');
    pending++;
    const opts = { pin, yolo, wait: false };
    try { show(race ? await pool.race(prompt, race, opts) : await pool.submit(prompt, opts)); }
    finally { pending--; finishIfDone(); }
  });
  rl.on('close', () => { closed = true; finishIfDone(); });
  return new Promise(() => {});
}
