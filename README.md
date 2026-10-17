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
maxai ui --open                           # local web UI (http://127.0.0.1:4747)
maxai install                             # install every missing agent CLI (asks first)
maxai install opencode droid --yes        # specific ones, no prompt
maxai install all --dry-run               # show what would run
```

Flags: `-a agent[,agent]`, `-m model`, `-f fallbacks`, `-C dir`, `-y/--yolo` (auto-approve tools),
`--json`, `--timeout sec`, `--dry-run`.

## Web UI

`maxai ui` serves a local page: agent list with install status/version, one-click install
with live logs, a prompt box, and side-by-side streaming output when several agents are
selected. It binds to loopback only, checks the Host header and requires a per-launch
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
