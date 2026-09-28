#!/bin/sh
# Start one poll run. launchd calls this every 5 minutes on the self-hosted runner machine,
# because GitHub's own `schedule:` trigger is best-effort and often skips runs entirely.
# Needs `gh auth login` on this machine.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# Don't pile up runs if earlier ones are still waiting (e.g. the runner was busy or offline).
queued=$(gh run list -R monkichi27/bkk-flood-watch --workflow poll.yml --status queued --json databaseId --jq length 2>/dev/null)
[ "${queued:-0}" -gt 0 ] && exit 0
exec gh workflow run poll.yml -R monkichi27/bkk-flood-watch
