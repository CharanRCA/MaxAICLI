import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, resolveId } from './adapters.js';
import { buildCommand, locate, runCapture } from './runner.js';
import { status, plan, describe, installAgent } from './installer.js';
import { Pool } from './pool.js';
import { ADAPTERS as ALL } from './adapters.js';

const PAGE = fs.readFileSync(fileURLToPath(new URL('./ui.html', import.meta.url)), 'utf8');

// Local-only web UI. Guards: loopback bind, Host check (DNS rebinding), per-launch token.
export function startUI(cfg, { port = 4747, host = '127.0.0.1', cwd = process.cwd() } = {}) {
  const pool = new Pool(cfg);
  const installedNow = () => Object.keys(ALL).filter((id) => locate(id, cfg));
  const token = crypto.randomBytes(16).toString('hex');
  const hostOk = (h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h || '');
  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const body = (req) => new Promise((ok, bad) => {
    let s = ''; req.on('data', (d) => { s += d; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { bad(e); } });
  });
  const stream = (res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    return (o) => res.writableEnded || res.write(JSON.stringify(o) + '\n');
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req.headers.host)) return send(res, 403, { error: 'bad host' });
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE.replace('__TOKEN__', token).replace('__CWD__', JSON.stringify(cwd).slice(1, -1)), 'text/html; charset=utf-8');
      if (req.headers['x-maxai-token'] !== token) return send(res, 401, { error: 'bad token' });

      if (url.pathname === '/api/agents') {
        const rows = await Promise.all(Object.keys(ADAPTERS).map(async (id) => {
          const s = await status(id, cfg);
          const p = plan(id);
          return { ...s, installCmd: p.recipe ? describe(p.recipe) : null, manual: p.manual };
        }));
        return send(res, 200, rows);
      }

      if (url.pathname === '/api/pool') { pool.refreshLanes(installedNow()); return send(res, 200, pool.status()); }
      if (req.method === 'POST' && url.pathname === '/api/pool/reset') { pool.reset((await body(req)).lane); return send(res, 200, pool.status()); }
      if (req.method === 'POST' && url.pathname === '/api/pool/run') {
        const { prompts = [], race, yolo, dir, perLane } = await body(req);
        const list = prompts.map((p) => String(p).trim()).filter(Boolean);
        if (!list.length) return send(res, 400, { error: 'no prompts' });
        pool.refreshLanes(installedNow());
        if (perLane) for (const l of pool.lanes) l.concurrency = perLane;
        if (!pool.lanes.length) return send(res, 400, { error: 'no installed agents - install some first' });
        const emit = stream(res);
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        const tags = new Set(); const tag = (t) => tags.has(t);
        const onStart = (e) => tag(e.tag) && emit({ type: 'start', ...e });
        const onResult = (e) => tag(e.tag) && emit({ type: 'attempt', ...e });
        pool.on('start', onStart); pool.on('result', onResult);
        try {
          await Promise.all(list.map(async (prompt, i) => {
            const t = `${token}:${Date.now()}:${i}`; tags.add(t);
            const o = { cwd: dir || cwd, yolo: !!yolo, signal: ac.signal, tag: t };
            const r = race > 1 ? await pool.race(prompt, race, o) : await pool.submit(prompt, o);
            emit({ type: 'done', index: i, tag: t, ok: r.ok, lane: r.lane, output: r.output, error: r.error, ms: r.ms, attempts: r.attempts });
          }));
        } finally { pool.off('start', onStart); pool.off('result', onResult); }
        return res.end();
      }

      if (req.method === 'POST' && url.pathname === '/api/run') {
        const { prompt, agents = [], model, yolo, dir } = await body(req);
        if (!prompt || !agents.length) return send(res, 400, { error: 'prompt and agents required' });
        const emit = stream(res);
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        await Promise.all(agents.map(async (raw) => {
          const id = resolveId(raw);
          if (!id || !locate(id, cfg)) { emit({ agent: raw, type: 'exit', code: 127, err: 'not installed' }); return; }
          const cmd = buildCommand(id, 'run', { prompt, model: model || undefined, yolo: !!yolo }, cfg);
          emit({ agent: id, type: 'start', cmd: [cmd.command, ...cmd.args.slice(0, -1)].join(' ') });
          const r = await runCapture(cmd, {
            cwd: dir || cwd, timeoutMs: 600000, signal: ac.signal,
            onData: (d) => emit({ agent: id, type: 'out', data: String(d) }),
            onErr: (d) => emit({ agent: id, type: 'err', data: String(d) }),
          });
          emit({ agent: id, type: 'exit', code: r.code, ms: r.ms });
        }));
        return res.end();
      }

      if (req.method === 'POST' && url.pathname === '/api/install') {
        const { agents = [], force } = await body(req);
        const emit = stream(res);
        for (const raw of agents) {
          const id = resolveId(raw);
          if (!id) { emit({ agent: raw, type: 'done', result: 'failed', hint: 'unknown agent' }); continue; }
          emit({ agent: id, type: 'start' });
          const r = await installAgent(id, cfg, { force: !!force, onData: (d) => emit({ agent: id, type: 'out', data: d }) });
          emit({ agent: id, type: 'done', ...r });
        }
        return res.end();
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: e.message }); else res.end();
    }
  });
  return new Promise((ok, bad) => {
    server.on('error', bad);
    server.listen(port, host, () => ok({ server, url: `http://${host}:${server.address().port}/`, token }));
  });
}
