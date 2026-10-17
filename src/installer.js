import os from 'node:os';
import { spawn } from 'node:child_process';
import { ADAPTERS } from './adapters.js';
import { locate, which, runCapture } from './runner.js';

// Install recipes, tried in order; the first whose `needs` binary exists wins.
// `sh` recipes run through the shell (curl | sh); others are argv arrays.
const win = process.platform === 'win32';
export const RECIPES = {
  kiro: [{ needs: 'curl', sh: 'curl -fsSL https://cli.kiro.dev/install | bash' }],
  opencode: [
    { needs: 'npm', argv: ['npm', 'i', '-g', 'opencode-ai'] },
    { needs: 'curl', sh: 'curl -fsSL https://opencode.ai/install | bash' },
  ],
  antigravity: [], // no scripted installer known: manual
  copilot: [{ needs: 'npm', argv: ['npm', 'i', '-g', '@github/copilot'] }],
  qoder: [
    { needs: 'npm', argv: ['npm', 'i', '-g', '@qoder-ai/qodercli'] },
    { needs: 'curl', sh: 'curl -fsSL https://qoder.com/install | bash' },
  ],
  amp: [
    { needs: 'npm', argv: ['npm', 'i', '-g', '@sourcegraph/amp'] },
    { needs: 'curl', sh: 'curl -fsSL https://ampcode.com/install.sh | bash' },
  ],
  rovodev: [{ needs: 'brew', sh: 'brew tap atlassian/homebrew-acli && brew install acli' }],
  kimi: [
    { needs: 'uv', argv: ['uv', 'tool', 'install', '--python', '3.13', 'kimi-cli'] },
    { needs: 'pipx', argv: ['pipx', 'install', 'kimi-cli'] },
  ],
  droid: [{ needs: 'curl', sh: 'curl -fsSL https://app.factory.ai/cli | sh' }],
};

export async function status(id, cfg) {
  const path = locate(id, cfg);
  let version = null;
  if (path) {
    const r = await runCapture({ command: path, args: [...(ADAPTERS[id].prefix || []), '--version'] }, { timeoutMs: 5000 });
    if (r.code === 0) version = (r.out || r.err).trim().split('\n')[0].slice(0, 80) || null;
  }
  return { id, name: ADAPTERS[id].name, installed: !!path, path, version };
}

// -> { recipe | null, manual: string }
export function plan(id) {
  if (win) return { recipe: null, manual: `${ADAPTERS[id].install} (automatic install is not supported on Windows yet)` };
  const recipe = (RECIPES[id] || []).find((r) => which(r.needs));
  const missing = (RECIPES[id] || []).map((r) => r.needs);
  return {
    recipe: recipe || null,
    manual: recipe ? null : `${ADAPTERS[id].install}${missing.length ? ` (or install one of: ${[...new Set(missing)].join(', ')})` : ''}`,
  };
}

export const describe = (r) => (r.sh ? r.sh : r.argv.join(' '));

// Execute a recipe, streaming output through onData. Resolves to exit code.
export function execRecipe(r, onData) {
  return new Promise((resolve) => {
    const c = r.sh
      ? spawn('bash', ['-o', 'pipefail', '-c', r.sh], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, cwd: os.homedir() })
      : spawn(r.argv[0], r.argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.on('data', (d) => onData?.(String(d)));
    c.stderr.on('data', (d) => onData?.(String(d)));
    c.on('error', (e) => { onData?.(`${e.message}\n`); resolve(127); });
    c.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Install one agent unless already present (or force).
 * -> { id, result: 'already-installed'|'installed'|'failed'|'manual'|'dry-run', ... }
 */
export async function installAgent(id, cfg, { force = false, dry = false, onData } = {}) {
  const before = await status(id, cfg);
  if (before.installed && !force) return { id, result: 'already-installed', path: before.path, version: before.version };
  const { recipe, manual } = plan(id);
  if (!recipe) return { id, result: 'manual', manual };
  if (dry) return { id, result: 'dry-run', command: describe(recipe) };
  onData?.(`$ ${describe(recipe)}\n`);
  const code = await execRecipe(recipe, onData);
  const after = await status(id, cfg);
  if (code === 0 && after.installed) return { id, result: 'installed', path: after.path, version: after.version };
  return {
    id, result: 'failed', code,
    hint: code === 0 ? 'installer succeeded but the binary is not on PATH yet - open a new shell or add its bin dir to PATH' : undefined,
  };
}
