import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ADAPTERS } from './adapters.js';

// Where installers drop binaries that are often missing from PATH in a fresh shell.
export const EXTRA_DIRS = ['.local/bin', '.opencode/bin', '.factory/bin', '.amp/bin', '.kiro/bin', '.qoder/bin', '.npm-global/bin', '.cargo/bin', 'bin']
  .map((d) => path.join(os.homedir(), d)).concat(['/usr/local/bin', '/opt/homebrew/bin']);

export function which(bin, env = process.env) {
  if (bin.includes(path.sep)) return fs.existsSync(bin) ? bin : null;
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of [...(env.PATH || '').split(path.delimiter), ...EXTRA_DIRS]) {
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      try { fs.accessSync(full, fs.constants.X_OK); if (fs.statSync(full).isFile()) return full; } catch {}
    }
  }
  return null;
}

// Locate the executable for an agent, honoring config overrides.
export function locate(id, cfg = { agents: {} }) {
  const a = ADAPTERS[id];
  const bins = cfg.agents?.[id]?.bin ? [cfg.agents[id].bin] : a.bins;
  for (const b of bins) { const p = which(b); if (p) return p; }
  return null;
}

// Build { command, args } for an agent. mode: 'run' | 'chat'.
export function buildCommand(id, mode, o, cfg = { agents: {} }) {
  const a = ADAPTERS[id];
  const ov = cfg.agents?.[id] || {};
  const opts = { prompt: o.prompt, model: o.model ?? ov.model, yolo: o.yolo ?? cfg.yolo ?? false };
  const tpl = ov[`${mode}Template`];
  let args = tpl
    ? tpl.map((t) => t.replaceAll('{prompt}', opts.prompt ?? '').replaceAll('{model}', opts.model ?? ''))
    : a[mode](opts);
  args = [...(a.prefix || []), ...args, ...(ov.extraArgs || [])];
  const command = locate(id, cfg) || (ov.bin || a.bins[0]);
  return { command, args };
}

// Run with the terminal attached (streams live). Resolves to exit code.
export function runInherit({ command, args }, { cwd } = {}) {
  return new Promise((resolve) => {
    const c = spawn(command, args, { stdio: 'inherit', cwd });
    c.on('error', (e) => { console.error(`maxai: cannot start ${command}: ${e.message}`); resolve(127); });
    c.on('close', (code, sig) => resolve(code ?? (sig ? 128 : 1)));
  });
}

// Run capturing output (for compare / fallback / --json).
export function runCapture({ command, args }, { cwd, onData, onErr, timeoutMs, signal } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '', err = '';
    const c = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    signal?.addEventListener('abort', () => c.kill('SIGTERM'), { once: true });
    const timer = timeoutMs ? setTimeout(() => c.kill('SIGTERM'), timeoutMs) : null;
    c.stdout.on('data', (d) => { out += d; onData?.(d); });
    c.stderr.on('data', (d) => { err += d; onErr?.(d); });
    c.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, out, err: e.message, ms: Date.now() - t0 }); });
    c.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out, err, ms: Date.now() - t0 }); });
  });
}
