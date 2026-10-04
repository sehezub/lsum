---
name: lsum
description: Run noisy shell commands (builds, tests, installs, linters, type checks, git pull/log, docker, migrations) through a local LLM that returns a short summary instead of the full output; start and monitor dev servers/watchers in the background; summarize big logs or diffs; draft commit messages. Use when a command will likely print more than ~30 lines or never terminates.
---

# lsum — local summarizer for noisy output

Invoke as `node ~/.claude/skills/lsum/lsum.mjs ...` (or `lsum ...` if on PATH). On Windows the wrapped command runs in cmd.exe: quote compound commands as one argument, e.g. `lsum "npm run build && npm test"`.

| Command | Use |
|---|---|
| `lsum <command>` | Any terminating command. Exit code preserved. ≤30 lines are printed as-is. |
| `lsum watch <command>` | Dev servers, watchers, `docker compose up`: starts in background, waits for ready/error (default 60s), keeps monitoring. |
| `lsum events [pid]` | New runtime errors / recoveries / exits since last check. |
| `lsum ps`, `lsum stop <pid\|all>` | List / stop watched processes. |
| `lsum file <path>` | Summarize an existing log. |
| `<cmd> \| lsum pipe "question"` | Summarize piped output answering a question. |
| `lsum diff [args]` | Summarize a git diff, flag risky changes. |
| `lsum commit` | Propose a commit message from the staged diff (does not commit). |

Options: `--focus "<what matters>"` (e.g. "which tests failed"), `--timeout <sec>`, `--raw`.

## When to use / not use

Use for commands whose output you would only skim: builds, test suites, installs, audits, linters/type checks with many findings, verbose git, docker, migrations, large logs.

Run commands directly (not through lsum) when output is short and you need it verbatim: `git status`, `ls`, reading files, JSON you will parse, exact values to copy, interactive commands. Don't wrap trivial commands — it adds overhead and saves nothing.

## Reading results

Trust `[lsum] exit N` and the `key lines (raw)` section over the model summary. The summarizing model is small: if the summary is vague or contradicts the exit code, inspect the full log with a targeted search or `lsum file <log> --focus "..."` instead of re-running the command raw.

## Dev servers

1. `lsum ps` first — reuse a server already running for this project.
2. `lsum watch "npm run dev"` → note PID and URL.
3. If hooks are installed, runtime errors arrive automatically as `[lsum] New events from background processes...` notices. Otherwise run `lsum events` after code changes. RECOVERED = already fixed.
4. Stop servers you started (`lsum stop <pid>`) before finishing, unless the user wants them running. They keep running after the session ends.

## Commits

Stage files → `lsum commit [--focus "why"]` → check the message against the staged files → `git commit -F "<saved path>"`, following any commit conventions you were given.
