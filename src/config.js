import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  model: 'claude-sonnet-5-5',
  maxTokens: 4096,
  system: '',
  baseUrl: 'https://api.anthropic.com',
});

export const KEYS = {
  apiKey: 'string',
  model: 'string',
  maxTokens: 'number',
  system: 'string',
  baseUrl: 'string',
};

export function homeDir(env = process.env) {
  return env.MAXAICLI_HOME || path.join(os.homedir(), '.maxaicli');
}

export function configPath(env = process.env) {
  return path.join(homeDir(env), 'config.json');
}

export function loadConfig(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(configPath(env), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not read ${configPath(env)}: ${err.message}`);
  }
}

export function saveConfig(config, env = process.env) {
  fs.mkdirSync(homeDir(env), { recursive: true });
  fs.writeFileSync(configPath(env), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export function parseValue(key, raw) {
  if (!(key in KEYS)) {
    throw new Error(`Unknown config key "${key}". Valid keys: ${Object.keys(KEYS).join(', ')}`);
  }
  if (KEYS[key] === 'number') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${key} must be a positive integer`);
    return n;
  }
  return String(raw);
}

export function setConfigValue(key, raw, env = process.env) {
  const value = parseValue(key, raw);
  const config = loadConfig(env);
  config[key] = value;
  saveConfig(config, env);
  return value;
}

export function unsetConfigValue(key, env = process.env) {
  parseValue(key, '1');
  const config = loadConfig(env);
  delete config[key];
  saveConfig(config, env);
}

export function maskSecret(value) {
  if (!value) return '';
  return value.length <= 8 ? '****' : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/** Merge defaults < config file < environment < CLI flags. */
export function resolveSettings({ env = process.env, flags = {} } = {}) {
  const file = loadConfig(env);
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== '');
  const maxTokens = pick(flags.maxTokens, env.MAXAICLI_MAX_TOKENS, file.maxTokens, DEFAULTS.maxTokens);
  return {
    apiKey: pick(env.ANTHROPIC_API_KEY, file.apiKey),
    model: pick(flags.model, env.MAXAICLI_MODEL, file.model, DEFAULTS.model),
    maxTokens: Number(maxTokens),
    system: pick(flags.system, file.system, DEFAULTS.system),
    baseUrl: pick(env.ANTHROPIC_BASE_URL, file.baseUrl, DEFAULTS.baseUrl).replace(/\/+$/, ''),
  };
}
