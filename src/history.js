import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './config.js';

const dir = (env) => path.join(homeDir(env), 'history');

export function sanitizeName(name) {
  const clean = String(name).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean || clean !== String(name)) {
    throw new Error(`Invalid session name "${name}" (use letters, numbers, - and _)`);
  }
  return clean;
}

const file = (name, env) => path.join(dir(env), `${sanitizeName(name)}.json`);

export function loadSession(name, env = process.env) {
  try {
    const data = JSON.parse(fs.readFileSync(file(name, env), 'utf8'));
    return Array.isArray(data.messages) ? data.messages : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`Could not read session "${name}": ${err.message}`);
  }
}

export function saveSession(name, messages, env = process.env) {
  fs.mkdirSync(dir(env), { recursive: true });
  const payload = { name: sanitizeName(name), updatedAt: new Date().toISOString(), messages };
  fs.writeFileSync(file(name, env), JSON.stringify(payload, null, 2) + '\n');
}

export function listSessions(env = process.env) {
  let entries;
  try {
    entries = fs.readdirSync(dir(env));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const name = f.slice(0, -5);
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir(env), f), 'utf8'));
        return { name, messages: data.messages?.length ?? 0, updatedAt: data.updatedAt ?? '' };
      } catch {
        return { name, messages: 0, updatedAt: '' };
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deleteSession(name, env = process.env) {
  try {
    fs.unlinkSync(file(name, env));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}
