import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ADAPTERS } from './adapters.js';
import { locate, buildCommand, runCapture } from './runner.js';

// ---- failure classification ------------------------------------------------
const QUOTA_RE = /rate.?limit|quota|too many requests|\b429\b|usage limit|limit (has been )?(reached|exceeded)|exceeded .*(limit|quota)|out of (credits|requests)|insufficient (credits|balance)|free (tier|usage|requests?)|overloaded|at capacity|try again (later|in)|resets? (in|at)/i;
const AUTH_RE = /not logged in|(please|must) (log ?in|sign ?in)|login required|unauthori[sz]ed|\b401\b|authentication (failed|required)|invalid api key|no api key|not authenticated/i;
const UNITS = { s: 1, sec: 1, second: 1, m: 60, min: 60, minute: 60, h: 3600, hr: 3600, hour: 3600 };

export function classify({ code, out = '', err = '' }) {
  const text = `${err}\n${out.length < 600 ? out : out.slice(-300)}`;
  if (code === 0 && !(out.trim().length < 400 && QUOTA_RE.test(out))) return { kind: 'ok' };
  if (code === 0 && AUTH_RE.test(out) && out.trim().length < 400) return { kind: 'auth' };
  if (AUTH_RE.test(text)) return { kind: 'auth' };
  if (QUOTA_RE.test(text)) {
    const m = text.match(/(?:try again|retry|reset[s]?)\D{0,20}?(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i);
    const retryAfterSec = m ? Number(m[1]) * (UNITS[m[2].toLowerCase()] ?? UNITS[m[2].toLowerCase().replace(/s$/, '')]) || null : null;
    return { kind: 'quota', retryAfterSec };
  }
  return { kind: 'error' };
}

// ---- persisted lane state (cooldowns survive between invocations) ----------
export function statePath() {
  return process.env.MAXAI_STATE || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'maxai', 'pool.json');
}
function loadState(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } }
function saveState(p, s) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(s, null, 1)); } catch {} }

// ---- lanes: each (agent, model) pair is an independent quota bucket ---------
// config: "pool": { "concurrency": 2, "exclude": ["rovodev"], "lanes": [{ "agent": "opencode", "model": "x/y", "concurrency": 3, "weight": 2 }] }
export function buildLanes(cfg, installed) {
  const pc = cfg.pool || {};
  const have = new Set(installed);
  const src = pc.lanes?.length ? pc.lanes : installed.filter((id) => !(pc.exclude || []).includes(id)).map((agent) => ({ agent }));
  const seen = new Set();
  return src.filter((l) => have.has(l.agent)).map((l) => {
    const model = l.model ?? cfg.agents?.[l.agent]?.model;
    let name = l.name || (model ? `${l.agent}:${model}` : l.agent);
    while (seen.has(name)) name += '+';
    seen.add(name);
    return { name, agent: l.agent, model, concurrency: l.concurrency ?? pc.concurrency ?? 2, weight: l.weight ?? 1, inFlight: 0, lastUsed: 0 };
  });
}

export class Pool extends EventEmitter {
  constructor(cfg, { lanes, run, now = Date.now, state = statePath(), maxAttempts = 4, timeoutMs = 600000 } = {}) {
    super();
    this.cfg = cfg; this.now = now; this.statePath = state; this.maxAttempts = maxAttempts; this.timeoutMs = timeoutMs;
    this.lanes = lanes || buildLanes(cfg, Object.keys(ADAPTERS).filter((id) => locate(id, cfg)));
    this.st = loadState(state);
    this.queue = [];
    this.timer = null;
    this._run = run || ((lane, o, signal) => runCapture(buildCommand(lane.agent, 'run', { prompt: o.prompt, model: lane.model, yolo: o.yolo }, cfg),
      { cwd: o.cwd, timeoutMs: this.timeoutMs, signal }));
  }

  _s(lane) { return (this.st[lane.name] ||= { ok: 0, fail: 0, quotaHits: 0, streak: 0, cooldownUntil: 0, reason: null }); }
  _save() { saveState(this.statePath, this.st); }
  cooling(lane) { return this._s(lane).cooldownUntil > this.now(); }

  status() {
    return this.lanes.map((l) => {
      const s = this._s(l), cd = Math.max(0, s.cooldownUntil - this.now());
      return { name: l.name, agent: l.agent, model: l.model, concurrency: l.concurrency, weight: l.weight, inFlight: l.inFlight,
        state: cd ? (s.reason === 'auth' ? 'needs-login' : 'cooling') : 'ready', cooldownSec: Math.ceil(cd / 1000), reason: cd ? s.reason : null, ok: s.ok, fail: s.fail, quotaHits: s.quotaHits };
    });
  }
  /** Re-detect installed agents (after an install) keeping in-flight counts. */
  refreshLanes(installed) {
    const old = new Map(this.lanes.map((l) => [l.name, l]));
    // keep the same lane objects: running attempts hold references and decrement them
    this.lanes = buildLanes(this.cfg, installed).map((l) => { const o = old.get(l.name); return o ? Object.assign(o, { agent: l.agent, model: l.model, weight: l.weight, concurrency: l.concurrency }) : l; });
    this._pump();
  }
  reset(name) {
    for (const l of this.lanes) if (!name || l.name === name || l.agent === name) Object.assign(this._s(l), { cooldownUntil: 0, reason: null, streak: 0 });
    this._save();
  }

  _penalize(lane, cls) {
    const s = this._s(lane);
    s.fail++;
    if (cls.kind === 'auth') { s.cooldownUntil = this.now() + 24 * 3600e3; s.reason = 'auth'; }
    else if (cls.kind === 'quota') {
      s.quotaHits++; s.streak++;
      const sec = cls.retryAfterSec ?? Math.min(300 * 2 ** (s.streak - 1), 6 * 3600);
      s.cooldownUntil = this.now() + sec * 1000; s.reason = 'quota';
    } else if (++s.streak >= 3) { s.cooldownUntil = this.now() + 600e3; s.reason = 'errors'; }
  }

  async _exec(lane, o, signal) {
    lane.inFlight++; lane.lastUsed = this.now();
    let r;
    try { r = await this._run(lane, o, signal); } catch (e) { r = { code: 1, out: '', err: String(e.message || e), ms: 0 }; }
    lane.inFlight--;
    const cls = signal?.aborted ? { kind: 'aborted' } : classify(r);
    const s = this._s(lane);
    if (cls.kind === 'ok') { s.ok++; s.streak = 0; if (s.reason !== 'auth') { s.cooldownUntil = 0; s.reason = null; } }
    else if (cls.kind !== 'aborted') this._penalize(lane, cls);
    this._save();
    const attempt = { lane: lane.name, agent: lane.agent, kind: cls.kind, code: r.code, ms: r.ms, err: cls.kind === 'ok' ? undefined : (r.err || '').trim().split('\n').pop() };
    this.emit('attempt', attempt);
    return { r, cls, attempt };
  }

  _candidates(task) {
    return this.lanes.filter((l) => !task.tried.has(l.name) && (!task.pin || task.pin.includes(l.agent) || task.pin.includes(l.name)) && this._s(l).reason !== 'auth');
  }
  _pick(lanes) {
    return lanes.filter((l) => !this.cooling(l) && l.inFlight < l.concurrency)
      .sort((a, b) => (a.inFlight + 1) / a.weight - (b.inFlight + 1) / b.weight || a.lastUsed - b.lastUsed)[0];
  }

  /** Queue a prompt. Resolves (never rejects) to { ok, output, lane, agent, attempts, ms, error? }. */
  submit(prompt, { pin, cwd, yolo, wait = true, signal, tag } = {}) {
    return new Promise((resolve) => {
      const task = { prompt, tag, pin, cwd, yolo, wait, signal, tried: new Set(), attempts: [], t0: this.now(), resolve, running: false };
      this.queue.push(task);
      this.emit('queued', { prompt });
      this._pump();
    });
  }

  _finish(task, res) {
    this.queue = this.queue.filter((t) => t !== task);
    task.resolve({ prompt: task.prompt, attempts: task.attempts, ms: this.now() - task.t0, ...res });
    this._pump();
  }

  _pump() {
    clearTimeout(this.timer);
    let wake = Infinity;
    for (const task of [...this.queue]) {
      if (task.running) continue;
      if (task.signal?.aborted) { this._finish(task, { ok: false, error: 'aborted' }); continue; }
      if (task.attempts.length >= this.maxAttempts) { this._finish(task, { ok: false, error: `gave up after ${task.attempts.length} attempts` }); continue; }
      const cands = this._candidates(task);
      if (!cands.length) { this._finish(task, { ok: false, error: task.attempts.length ? 'every lane failed' : 'no usable agent lanes (run `maxai list`, `maxai pool status`)' }); continue; }
      const lane = this._pick(cands);
      if (lane) { this._start(task, lane); continue; }
      const busy = cands.some((l) => !this.cooling(l));
      if (busy) continue; // a running task will re-pump on completion
      const soonest = Math.min(...cands.map((l) => this._s(l).cooldownUntil));
      if (!task.wait) { this._finish(task, { ok: false, error: `all lanes cooling down; next ready in ${Math.ceil((soonest - this.now()) / 1000)}s` }); continue; }
      wake = Math.min(wake, soonest - this.now());
    }
    if (wake < Infinity) { this.timer = setTimeout(() => this._pump(), Math.max(50, wake)); this.timer.unref?.(); }
  }

  async _start(task, lane) {
    task.running = true; task.tried.add(lane.name);
    this.emit('start', { tag: task.tag, lane: lane.name });
    const { r, cls, attempt } = await this._exec(lane, task, task.signal);
    task.attempts.push(attempt); task.running = false;
    this.emit('result', { tag: task.tag, ...attempt });
    if (cls.kind === 'ok') this._finish(task, { ok: true, output: r.out, lane: lane.name, agent: lane.agent });
    else this._pump();
  }

  /** Send one prompt to n lanes at once; first success wins, others are killed. */
  async race(prompt, n, { pin, cwd, yolo } = {}) {
    const t0 = this.now();
    const lanes = this.lanes.filter((l) => !pin || pin.includes(l.agent) || pin.includes(l.name));
    const chosen = [];
    for (let i = 0; i < n; i++) {
      const l = this._pick(lanes.filter((x) => !chosen.includes(x)));
      if (l) chosen.push(l);
    }
    if (!chosen.length) return { ok: false, prompt, error: 'no ready lanes', attempts: [], ms: 0 };
    const ac = new AbortController();
    const attempts = [];
    let winner = null;
    await Promise.all(chosen.map(async (lane) => {
      const { r, cls, attempt } = await this._exec(lane, { prompt, cwd, yolo }, ac.signal);
      attempts.push(attempt);
      if (cls.kind === 'ok' && !winner) { winner = { lane, out: r.out }; ac.abort(); }
    }));
    return winner ? { ok: true, prompt, output: winner.out, lane: winner.lane.name, agent: winner.lane.agent, attempts, ms: this.now() - t0 }
      : { ok: false, prompt, error: 'every raced lane failed', attempts, ms: this.now() - t0 };
  }
}
