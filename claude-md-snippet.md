
## Local output summarizer (lsum)

For shell commands likely to print more than ~30 lines (builds, tests, installs, linters, type checks, git pull/log/diff, dev servers, docker, migrations) and for large logs or diffs, use the `lsum` skill instead of running the command directly. It summarizes output with a local model to save context; the exit code and raw error lines are always included. Short commands and output you need verbatim: run normally.
