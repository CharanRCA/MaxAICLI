# maxaicli

A fast, dependency-free command-line chat client for Claude. Streaming replies, saved conversation history, and layered configuration. Requires Node.js 18+.

## Install

```bash
git clone https://github.com/charanRCA/maxaicli
cd maxaicli
npm link          # makes the `maxaicli` command available globally
```

Or run it directly with `node bin/maxaicli.js`.

## Setup

```bash
maxaicli config set apiKey sk-ant-...
```

You can also export `ANTHROPIC_API_KEY`, which takes priority over the config file.

## Usage

```bash
maxaicli                          # interactive chat (resumes the "default" session)
maxaicli "explain a mutex"        # one-shot answer, streamed
git diff | maxaicli "review this" # pipe content in
maxaicli -S project "next step?"  # one-shot turn that remembers the "project" session
maxaicli --no-stream "hi"         # wait for the whole reply
```

Options: `-m/--model`, `-s/--system`, `-S/--session`, `--max-tokens`, `--no-stream`, `-h`, `-v`.

Interactive commands: `/help`, `/clear`, `/model <id>`, `/system <text>`, `/history`, `/exit`. Press Ctrl+C to interrupt a reply (Ctrl+C at the prompt, or Ctrl+D, exits).

## Config

```bash
maxaicli config list
maxaicli config set model claude-opus-5-5
maxaicli config get model
maxaicli config unset model
```

Keys: `apiKey`, `model`, `maxTokens`, `system`, `baseUrl`. Precedence is defaults, then config file, then environment (`ANTHROPIC_API_KEY`, `MAXAICLI_MODEL`, `MAXAICLI_MAX_TOKENS`, `ANTHROPIC_BASE_URL`), then command-line flags. Files live in `~/.maxaicli` (override with `MAXAICLI_HOME`); the config file is created with owner-only permissions.

## History

```bash
maxaicli history list
maxaicli history show default
maxaicli history delete default
```

## Development

```bash
npm test
```

Tests use Node's built-in test runner with a mocked `fetch`; no network or API key needed.
