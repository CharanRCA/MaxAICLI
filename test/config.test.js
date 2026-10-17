import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  loadConfig,
  maskSecret,
  resolveSettings,
  setConfigValue,
  unsetConfigValue,
} from '../src/config.js';
import { tempEnv } from './helpers.js';

test('loadConfig returns {} when no file exists', () => {
  assert.deepEqual(loadConfig(tempEnv()), {});
});

test('set / unset round-trips and coerces numbers', () => {
  const env = tempEnv();
  setConfigValue('model', 'claude-opus-5-5', env);
  assert.equal(setConfigValue('maxTokens', '123', env), 123);
  assert.deepEqual(loadConfig(env), { model: 'claude-opus-5-5', maxTokens: 123 });
  unsetConfigValue('model', env);
  assert.deepEqual(loadConfig(env), { maxTokens: 123 });
});

test('rejects unknown keys and bad numbers', () => {
  const env = tempEnv();
  assert.throws(() => setConfigValue('nope', 'x', env), /Unknown config key/);
  assert.throws(() => setConfigValue('maxTokens', 'abc', env), /positive integer/);
  assert.throws(() => setConfigValue('maxTokens', '-5', env), /positive integer/);
});

test('precedence: defaults < file < env < flags', () => {
  const env = tempEnv();
  assert.equal(resolveSettings({ env }).model, DEFAULTS.model);
  setConfigValue('model', 'from-file', env);
  assert.equal(resolveSettings({ env }).model, 'from-file');
  assert.equal(resolveSettings({ env: { ...env, MAXAICLI_MODEL: 'from-env' } }).model, 'from-env');
  assert.equal(resolveSettings({ env, flags: { model: 'from-flag' } }).model, 'from-flag');
});

test('API key from env wins over file; trailing slash trimmed from baseUrl', () => {
  const env = tempEnv();
  setConfigValue('apiKey', 'file-key', env);
  setConfigValue('baseUrl', 'http://localhost:1234/', env);
  const s = resolveSettings({ env: { ...env, ANTHROPIC_API_KEY: 'env-key' } });
  assert.equal(s.apiKey, 'env-key');
  assert.equal(s.baseUrl, 'http://localhost:1234');
});

test('maskSecret hides the middle', () => {
  assert.equal(maskSecret('sk-ant-1234567890'), 'sk-a...7890');
  assert.equal(maskSecret('short'), '****');
  assert.equal(maskSecret(undefined), '');
});
