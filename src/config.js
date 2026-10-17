import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Config layers (later wins): ~/.config/maxai/config.json, ./.maxai.json
// {
//   "default": "opencode",
//   "fallback": ["kiro", "droid"],
//   "yolo": false,
//   "agents": {
//     "kimi": { "bin": "/opt/kimi", "model": "kimi-k2", "extraArgs": ["--verbose"],
//               "runTemplate": ["--print", "-p", "{prompt}"] }
//   }
// }
export function configPaths(cwd = process.cwd()) {
  return [
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'maxai', 'config.json'),
    path.join(cwd, '.maxai.json'),
  ];
}

export function loadConfig(cwd = process.cwd()) {
  const cfg = { agents: {} };
  for (const p of configPaths(cwd)) {
    if (!fs.existsSync(p)) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { throw new Error(`Invalid JSON in ${p}: ${e.message}`); }
    const { agents, ...rest } = j;
    Object.assign(cfg, rest);
    for (const [k, v] of Object.entries(agents || {})) cfg.agents[k] = { ...cfg.agents[k], ...v };
  }
  return cfg;
}
