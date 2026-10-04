# lsum

Let Claude Code delegate noisy, mechanical output to a **local LLM** (Ollama) and keep its own context for the real work.

- **Summarize noisy commands** — builds, tests, installs, linters, `git pull`, docker, migrations. Claude gets a short structured summary plus the real exit code and the raw error lines; the full log stays on disk.
- **Monitor dev servers** — `lsum watch` starts a long-running process in the background, waits until it is ready, and keeps watching it for runtime errors, repeats, recoveries and crashes.
- **Notify Claude** — Claude Code hooks wake Claude when a watched server breaks, and add unread events to its context after each tool call or prompt.
- **Measure it** — `lsum stats` estimates the context tokens saved and flags summaries that weren't enough.

Everything runs locally: one Node.js script, no dependencies.

## Requirements

- Windows, macOS or Linux, with Node.js 18 or newer
- [Ollama](https://ollama.com) with a small code model, e.g. `ollama pull qwen2.5-coder:7b`
- Claude Code

## Install (Windows)

From a clone:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

This installs the skill to `~/.claude/skills/lsum`, adds a short section to your global `~/.claude/CLAUDE.md`, registers the notification hooks in `~/.claude/settings.json` (with a backup), adds an `lsum` command to your user PATH, and runs `lsum doctor`. It is safe to re-run. Flags: `-NoHooks`, `-NoPath`.

To update later, run `lsum update`. It runs `git pull` in the clone you installed from and then re-runs `install.ps1`.

To share without a clone, build a single-file installer with `npm run build:installer`. It writes `dist/install-lsum.ps1`.

To uninstall the hooks, run `lsum uninstall-hooks`.

## Usage

Claude uses it on its own through the skill. You can also use it yourself:

| Command | What it does |
|---|---|
| `lsum <command>` | Run a command and summarize its output. The exit code is preserved. Output of 30 lines or fewer is shown raw. |
| `lsum watch <command>` | Start a dev server or watcher in the background, summarize its startup, and keep monitoring it. |
| `lsum events [pid]` | Show new runtime events since the last check. |
| `lsum ps` / `lsum stop <pid\|all>` | List or stop watched processes. Watched processes keep running after Claude Code closes, until you stop them. |
| `lsum file <path>` | Summarize an existing log file. |
| `<cmd> \| lsum pipe [question]` | Summarize anything piped in. |
| `lsum diff [git diff args]` | Summarize a diff and flag risky changes. |
| `lsum commit` | Propose a commit message from the staged diff. It never commits. |
| `lsum stats [--days N\|--all] [--here]` | Show a usage report and the estimated context tokens saved. |
| `lsum doctor` | Check the setup and show recent hook activity. |
| `lsum update` / `lsum version` | Update from your clone / show the installed version. |

Options: `--focus "<what matters>"`, `--timeout <sec>`, `--ready "<regex>"`, `--error "<regex>"`, `--raw`.

## How the token estimate works

- **Baseline:** what Claude would have read from the raw output. It is estimated as characters ÷ 4 and capped at 30,000 characters per call, about what Claude Code shows of a long command.
- **Cost:** everything lsum printed, plus any follow-up look at a full log and every hook notification.
- **Not included:** the skill's own context cost, which `lsum stats` reports separately.

All of these are estimates, not exact tokenizer counts.

## Configuration

Set these environment variables to change the defaults:

| Variable | Default |
|---|---|
| `LSUM_MODEL` | `qwen2.5-coder:7b` |
| `LSUM_NUM_CTX` | `16384` |
| `LSUM_RAW_MAX` | `30` |
| `LSUM_MAX_CHARS` | `40000` |
| `LSUM_KEEP_ALIVE` | `10m` |
| `LSUM_BASELINE_CAP` | `30000` |
| `LSUM_LOG_DAYS` | `7` |
| `LSUM_HOME` | `~/.lsum` |
| `OLLAMA_HOST` | Ollama's default address |

Logs are written to the OS temp folder under `lsum/`.

## Development

```
skill/lsum.mjs          the tool (single file, no dependencies)
skill/SKILL.md          instructions Claude reads
claude-md-snippet.md    the line added to the global CLAUDE.md
install.ps1             Windows installer (reads the files above)
scripts/                build of the single-file installer
test/                   smoke tests with a fake Ollama server
```

```bash
npm test                  # smoke tests, no GPU needed
npm run build:installer   # dist/install-lsum.ps1
```

After changing `skill/`, re-run `install.ps1` to apply your local changes. Bump `VERSION` in `skill/lsum.mjs` and `package.json` together.
