import readline from 'node:readline';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { streamMessage, sendMessage } from './client.js';
import {
  KEYS,
  configPath,
  loadConfig,
  maskSecret,
  resolveSettings,
  setConfigValue,
  unsetConfigValue,
} from './config.js';
import { deleteSession, listSessions, loadSession, saveSession } from './history.js';

const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

export const HELP = `maxaicli ${pkg.version} - chat with Claude from your terminal

Usage:
  maxaicli                        Start an interactive chat
  maxaicli "your question"        Ask once and print the answer
  cat file.txt | maxaicli "summarise this"
  maxaicli config <list|get|set|unset> [key] [value]
  maxaicli history <list|show|delete> [name]

Options:
  -m, --model <id>        Model to use (default: claude-sonnet-5-5)
  -s, --system <text>     System prompt
  -S, --session <name>    Named session whose history is saved and resumed
      --max-tokens <n>    Maximum tokens in the reply
      --no-stream         Wait for the full reply instead of streaming
  -h, --help              Show this help
  -v, --version           Show version

Setup:
  maxaicli config set apiKey sk-ant-...     (or set ANTHROPIC_API_KEY)

Interactive commands:
  /help  /clear  /model <id>  /system <text>  /history  /exit
`;

const REPL_HELP = `/help           Show this help
/clear          Forget this conversation
/model <id>     Switch model
/system <text>  Set the system prompt
/history        Show message count
/exit           Quit (Ctrl+D also works)
`;

const OPTIONS = {
  model: { type: 'string', short: 'm' },
  system: { type: 'string', short: 's' },
  session: { type: 'string', short: 'S' },
  'max-tokens': { type: 'string' },
  'no-stream': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

async function readAll(stream) {
  let data = '';
  for await (const chunk of stream) data += chunk;
  return data;
}

/** Send one user turn; prints the reply and records it. Returns the reply text. */
export async function ask({ settings, messages, prompt, io, stream = true, signal }) {
  messages.push({ role: 'user', content: prompt });
  const opts = { ...settings, messages, fetchImpl: io.fetchImpl, signal };
  let reply = '';
  try {
    if (stream) {
      for await (const text of streamMessage(opts)) {
        reply += text;
        io.stdout.write(text);
      }
    } else {
      reply = await sendMessage(opts);
      io.stdout.write(reply);
    }
    if (!reply) throw new Error('The model returned an empty reply');
  } catch (err) {
    messages.pop();
    throw err;
  }
  io.stdout.write('\n');
  messages.push({ role: 'assistant', content: reply });
  return reply;
}

function configCommand(args, io) {
  const [action = 'list', key, value] = args;
  const { env, stdout } = io;
  switch (action) {
    case 'list': {
      const file = loadConfig(env);
      stdout.write(`# ${configPath(env)}\n`);
      for (const k of Object.keys(KEYS)) {
        if (file[k] === undefined) continue;
        stdout.write(`${k} = ${k === 'apiKey' ? maskSecret(file[k]) : file[k]}\n`);
      }
      return 0;
    }
    case 'get': {
      if (!key) throw new Error('Usage: maxaicli config get <key>');
      if (!(key in KEYS)) throw new Error(`Unknown config key "${key}"`);
      const v = loadConfig(env)[key];
      stdout.write(`${v === undefined ? '' : key === 'apiKey' ? maskSecret(v) : v}\n`);
      return 0;
    }
    case 'set':
      if (!key || value === undefined) throw new Error('Usage: maxaicli config set <key> <value>');
      setConfigValue(key, value, env);
      stdout.write(`Saved ${key}.\n`);
      return 0;
    case 'unset':
      if (!key) throw new Error('Usage: maxaicli config unset <key>');
      unsetConfigValue(key, env);
      stdout.write(`Removed ${key}.\n`);
      return 0;
    default:
      throw new Error(`Unknown config action "${action}"`);
  }
}

function historyCommand(args, io) {
  const [action = 'list', name] = args;
  const { env, stdout } = io;
  switch (action) {
    case 'list': {
      const sessions = listSessions(env);
      if (!sessions.length) stdout.write('No saved sessions.\n');
      for (const s of sessions) stdout.write(`${s.name}\t${s.messages} messages\t${s.updatedAt}\n`);
      return 0;
    }
    case 'show': {
      if (!name) throw new Error('Usage: maxaicli history show <name>');
      const messages = loadSession(name, env);
      if (!messages.length) throw new Error(`No session named "${name}"`);
      for (const m of messages) stdout.write(`[${m.role}]\n${m.content}\n\n`);
      return 0;
    }
    case 'delete':
      if (!name) throw new Error('Usage: maxaicli history delete <name>');
      if (!deleteSession(name, env)) throw new Error(`No session named "${name}"`);
      stdout.write(`Deleted ${name}.\n`);
      return 0;
    default:
      throw new Error(`Unknown history action "${action}"`);
  }
}

async function repl({ settings, messages, sessionName, io }) {
  const rl = readline.createInterface({ input: io.stdin, output: io.stdout, prompt: 'you> ' });
  let controller = null;
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });
  rl.on('SIGINT', () => {
    if (controller) controller.abort();
    else rl.close();
  });

  io.stdout.write(`maxaicli (${settings.model}) - /help for commands, Ctrl+D to exit\n`);
  if (messages.length) io.stdout.write(`Resumed "${sessionName}" with ${messages.length} messages.\n`);
  rl.prompt();

  for await (const raw of rl) {
    const line = raw.trim();
    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(' ');
      if (cmd === 'exit' || cmd === 'quit') break;
      else if (cmd === 'help') io.stdout.write(REPL_HELP);
      else if (cmd === 'clear') {
        messages.length = 0;
        if (sessionName) saveSession(sessionName, messages, io.env);
        io.stdout.write('Conversation cleared.\n');
      } else if (cmd === 'model') {
        if (arg) settings.model = arg;
        io.stdout.write(`Model: ${settings.model}\n`);
      } else if (cmd === 'system') {
        settings.system = arg;
        io.stdout.write(arg ? 'System prompt set.\n' : 'System prompt cleared.\n');
      } else if (cmd === 'history') io.stdout.write(`${messages.length} messages in this conversation.\n`);
      else io.stdout.write(`Unknown command /${cmd}. Try /help.\n`);
    } else if (line) {
      controller = new AbortController();
      try {
        io.stdout.write('claude> ');
        await ask({ settings, messages, prompt: line, io, signal: controller.signal });
        if (sessionName) saveSession(sessionName, messages, io.env);
      } catch (err) {
        io.stdout.write('\n');
        io.stderr.write(err.name === 'AbortError' ? '(interrupted)\n' : `Error: ${err.message}\n`);
      } finally {
        controller = null;
      }
    }
    if (!closed) rl.prompt();
  }
  rl.close();
  return 0;
}

export async function run(argv, overrides = {}) {
  const io = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    fetchImpl: fetch,
    ...overrides,
  };

  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    if (values.help) {
      io.stdout.write(HELP);
      return 0;
    }
    if (values.version) {
      io.stdout.write(`${pkg.version}\n`);
      return 0;
    }

    const [first, ...rest] = positionals;
    if (first === 'config') return configCommand(rest, io);
    if (first === 'history') return historyCommand(rest, io);

    const flags = { model: values.model, system: values.system };
    if (values['max-tokens'] !== undefined) {
      const n = Number(values['max-tokens']);
      if (!Number.isInteger(n) || n <= 0) throw new Error('--max-tokens must be a positive integer');
      flags.maxTokens = n;
    }
    const settings = resolveSettings({ env: io.env, flags });
    if (!settings.apiKey) {
      throw new Error('No API key found. Run `maxaicli config set apiKey <key>` or set ANTHROPIC_API_KEY.');
    }

    let prompt = positionals.join(' ');
    if (!io.stdin.isTTY) {
      const piped = (await readAll(io.stdin)).trim();
      if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped;
    }

    if (prompt) {
      const sessionName = values.session;
      const messages = sessionName ? loadSession(sessionName, io.env) : [];
      await ask({ settings, messages, prompt, io, stream: !values['no-stream'] });
      if (sessionName) saveSession(sessionName, messages, io.env);
      return 0;
    }

    if (!io.stdin.isTTY) throw new Error('No prompt provided.');
    const sessionName = values.session ?? 'default';
    return await repl({ settings, messages: loadSession(sessionName, io.env), sessionName, io });
  } catch (err) {
    io.stderr.write(`Error: ${err.message}\n`);
    return 1;
  }
}
