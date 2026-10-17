// One adapter per underlying agent CLI.
// `run(o)` -> argv for a one-shot, non-interactive prompt.
// `chat(o)` -> argv for an interactive session (optionally seeded with a prompt).
// o = { prompt, model, yolo }. Everything here can be overridden in .maxai.json.

const opt = (cond, ...args) => (cond ? args : []);

export const ADAPTERS = {
  kiro: {
    name: 'Kiro CLI',
    bins: ['kiro-cli', 'kiro'],
    install: 'https://kiro.dev/cli',
    run: (o) => ['chat', '--no-interactive', ...opt(o.yolo, '--trust-all-tools'), o.prompt],
    chat: (o) => ['chat', ...opt(o.prompt, o.prompt)],
  },
  opencode: {
    name: 'OpenCode',
    bins: ['opencode'],
    install: 'npm i -g opencode-ai',
    run: (o) => ['run', ...opt(o.model, '--model', o.model), o.prompt],
    chat: (o) => [...opt(o.model, '--model', o.model), ...opt(o.prompt, '--prompt', o.prompt)],
  },
  antigravity: {
    name: 'Antigravity CLI',
    bins: ['agy', 'antigravity'],
    install: 'https://antigravity.google',
    run: (o) => [...opt(o.model, '--model', o.model), '-p', o.prompt],
    chat: (o) => [...opt(o.model, '--model', o.model), ...opt(o.prompt, o.prompt)],
  },
  copilot: {
    name: 'GitHub Copilot CLI',
    bins: ['copilot'],
    install: 'npm i -g @github/copilot',
    run: (o) => ['-p', o.prompt, ...opt(o.model, '--model', o.model), ...opt(o.yolo, '--allow-all-tools')],
    chat: (o) => [...opt(o.model, '--model', o.model), ...opt(o.prompt, '-i', o.prompt)],
  },
  qoder: {
    name: 'Qoder CLI',
    bins: ['qodercli', 'qoder'],
    install: 'https://qoder.com/cli',
    run: (o) => ['-p', o.prompt, ...opt(o.model, '--model', o.model), ...opt(o.yolo, '--yolo')],
    chat: (o) => [...opt(o.model, '--model', o.model)],
  },
  amp: {
    name: 'Amp',
    bins: ['amp'],
    install: 'npm i -g @sourcegraph/amp',
    run: (o) => ['-x', o.prompt, ...opt(o.yolo, '--dangerously-allow-all')],
    chat: () => [],
  },
  rovodev: {
    name: 'Rovo Dev CLI',
    bins: ['acli'],
    prefix: ['rovodev'],
    install: 'https://developer.atlassian.com/cloud/acli',
    run: (o) => ['run', ...opt(o.yolo, '--yolo'), o.prompt],
    chat: (o) => ['run', ...opt(o.prompt, o.prompt)],
  },
  kimi: {
    name: 'Kimi Code CLI',
    bins: ['kimi'],
    install: 'uv tool install kimi-cli',
    run: (o) => ['--print', ...opt(o.model, '--model', o.model), '-p', o.prompt],
    chat: (o) => [...opt(o.model, '--model', o.model), ...opt(o.prompt, '-c', o.prompt)],
  },
  droid: {
    name: 'Droid CLI',
    bins: ['droid'],
    install: 'curl -fsSL https://app.factory.ai/cli | sh',
    run: (o) => ['exec', ...opt(o.model, '-m', o.model), ...opt(o.yolo, '--auto', 'high'), o.prompt],
    chat: (o) => [...opt(o.prompt, o.prompt)],
  },
};

export const ALIASES = {
  'kiro-cli': 'kiro', q: 'kiro',
  oc: 'opencode',
  agy: 'antigravity', gemini: 'antigravity',
  gh: 'copilot', ghcp: 'copilot', 'github-copilot': 'copilot',
  qodercli: 'qoder',
  rovo: 'rovodev', acli: 'rovodev',
  'kimi-code': 'kimi', moonshot: 'kimi',
  factory: 'droid',
};

export function resolveId(id) {
  const k = String(id).toLowerCase();
  const out = ALIASES[k] || k;
  return ADAPTERS[out] ? out : null;
}
