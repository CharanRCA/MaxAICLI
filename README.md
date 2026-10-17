# MaxAICLI (`maxai`)

One command-line front end for nine coding-agent CLIs. Zero dependencies, Node ≥ 18.

| id | Tool | Binary looked up |
|---|---|---|
| `kiro` | Kiro CLI | `kiro-cli` |
| `opencode` | OpenCode | `opencode` |
| `antigravity` | Antigravity CLI | `agy` |
| `copilot` | GitHub Copilot CLI | `copilot` |
| `qoder` | Qoder CLI | `qodercli` |
| `amp` | Amp | `amp` |
| `rovodev` | Rovo Dev CLI | `acli rovodev` |
| `kimi` | Kimi Code CLI | `kimi` |
| `droid` | Droid CLI | `droid` |

`maxai` does not reimplement these tools; it detects what you have installed and
translates one interface into each tool's native flags.

```
npm link                                  # install `maxai` globally from this checkout
maxai list                                # which agents are installed
maxai "add input validation to api.ts"    # auto-routes to an installed agent
maxai droid "fix the failing tests"       # specific agent (aliases: gh, q, agy, rovo, oc ...)
maxai run -a amp -f droid,kiro "task"     # fallback chain if the first one fails
maxai compare -a all "explain this repo"  # run on every installed agent in parallel
maxai chat -a opencode                    # hand the terminal to that agent's TUI
git diff | maxai -a copilot "review this" # piped stdin is appended to the prompt
maxai --dry-run -a kiro "hi"              # show the exact command without running
```

```
maxai "any prompt"                        # uses the POOL by default (see below)
maxai pool --batch tasks.txt              # many prompts in parallel across all agents
maxai pool --race 3 "hard question"       # same prompt on 3 agents, first good answer wins
maxai pool status                         # lanes, free slots, quota cooldowns
maxai ui --open                           # local web UI (http://127.0.0.1:4747)
maxai install                             # install every missing agent CLI (asks first)
maxai install opencode droid --yes        # specific ones, no prompt
maxai install all --dry-run               # show what would run
```

Flags: `-a agent[,agent]`, `-m model`, `-f fallbacks`, `-C dir`, `-y/--yolo` (auto-approve tools),
`--json`, `--timeout sec`, `--dry-run`.

## The pool (combined free quota)

Every installed agent CLI becomes a **lane**; a lane is one (agent, model) pair, i.e. one
quota bucket, so you can add several free models of one agent as separate lanes. `maxai`
dispatches work across all lanes at once and:

- **balances load** by free slots and weight, so N tasks run on N lanes in parallel;
- **detects quota/rate-limit/overload errors** (and "try again in 30 minutes" hints),
  puts that lane on a cooldown (persisted in `~/.local/state/maxai/pool.json`, exponential
  up to 6 h) and **retries the task on another lane**;
- marks lanes that need a login as such instead of hammering them (`maxai pool reset` clears);
- can **race** several lanes and keep the fastest answer (the losers are killed).

Each lane uses *your own* login with that vendor and that vendor's own free tier. The pool
just spreads load and backs off when told to; it doesn't share credentials or evade limits.
Tune it in config:

```json
{ "pool": { "concurrency": 2, "exclude": ["rovodev"],
    "lanes": [ { "agent": "opencode", "model": "provider/free-model-a", "concurrency": 3 },
               { "agent": "opencode", "model": "provider/free-model-b" },
               { "agent": "kimi", "weight": 2 } ] } }
```

## Web UI

`maxai ui` serves a local page: agent list with install status/version, one-click install
with live logs, a live **pool panel** (lanes, busy slots, cooldowns, total parallel capacity), a prompt box
where each line becomes a task fanned out across the pool (with the failover trail shown per task),
and a Compare mode for side-by-side output from chosen agents. It binds to loopback only, checks the Host header and requires a per-launch
token, because it can execute commands on your machine.

## Installer

`maxai install` checks each agent first (PATH plus common install dirs such as
`~/.local/bin`, `~/.opencode/bin`, `~/.factory/bin`) and skips those already present
(`--force` reinstalls). Otherwise it picks the first usable recipe (npm, curl script,
uv/pipx, brew), shows the exact command, and asks before running. Non-interactive use
requires `--yes`. Recipes live in `src/installer.js`. Antigravity has no scripted
installer, and Rovo Dev needs Homebrew, so those fall back to printing manual
instructions. As with the flags, the install commands are unverified against the vendors' current docs.

## Config

`~/.config/maxai/config.json` then `./.maxai.json` (later wins):

```json
{
  "default": "opencode",
  "fallback": ["droid", "kiro"],
  "agents": {
    "kimi": { "bin": "/opt/kimi/bin/kimi", "model": "kimi-k2",
              "extraArgs": ["--verbose"], "runTemplate": ["--print", "-p", "{prompt}"] }
  }
}
```

## Caveat

The flag mappings in `src/adapters.js` come from each tool's documented headless mode
as best known, and have **not been verified against live installs** (none are available
in the dev sandbox; Antigravity's, Qoder's and Rovo Dev's are the least certain). Use
`maxai --dry-run` to inspect, and fix any mismatch via `runTemplate`/`chatTemplate`/`bin`
in config without touching code. `npm test` covers the wrapper logic with fake binaries.
