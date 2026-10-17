// Heuristic auto-routing: pick the first *installed* agent from a preference list.
const RULES = [
  [/\b(spec|requirements?|design doc|plan)\b/i, ['kiro', 'amp', 'opencode']],
  [/\b(jira|confluence|bitbucket|atlassian)\b/i, ['rovodev']],
  [/\b(pull request|pr|github|issues?|gh)\b/i, ['copilot', 'droid']],
  [/\b(refactor|migrate|large|monorepo|whole repo)\b/i, ['amp', 'droid', 'opencode']],
  [/\b(chinese|中文|translate)\b/i, ['kimi', 'qoder']],
];
const DEFAULT_ORDER = ['opencode', 'droid', 'amp', 'copilot', 'kiro', 'qoder', 'kimi', 'antigravity', 'rovodev'];

export function pickAgent(prompt, installed, cfg = {}) {
  const have = new Set(installed);
  const prefs = [];
  for (const [re, ids] of RULES) if (re.test(prompt)) prefs.push(...ids);
  if (cfg.default) prefs.push(cfg.default);
  prefs.push(...DEFAULT_ORDER);
  return prefs.find((id) => have.has(id)) || null;
}
