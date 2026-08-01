#!/bin/sh
# Restart qiyan-bot only when no managed worker is mid-turn.
#
# A worker's native transcript is the architecture-independent signal: a user row with no
# assistant row after it means a turn is awaiting its reply. Grepping for a process pattern
# is not — the SDK host spawns no `claude -p`, so such a check silently reports "idle"
# forever and a restart kills live work. Pass --force to override deliberately.
set -eu
if [ "${1-}" != "--force" ] && ! python3 - <<'PY'
import glob, json, os, sys, time
managed = set()
with open(os.path.expanduser('~/.qiyan-bot/data/sessions.json')) as handle:
    registry = json.load(handle)
for entry in (registry.get('sessions', registry)).values():
    if isinstance(entry, dict) and entry.get('thread_id'):
        managed.add(entry['thread_id'])
busy = []
for path in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')):
    thread = os.path.basename(path)[:-6]
    if thread not in managed or time.time() - os.path.getmtime(path) > 900:
        continue
    rows = []
    try:
        with open(path) as handle:
            for line in handle:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
    except Exception:
        continue
    tail = [row for row in rows if row.get('type') in ('user', 'assistant')][-6:]
    last_user = max((i for i, r in enumerate(tail) if r.get('type') == 'user'), default=-1)
    last_assistant = max((i for i, r in enumerate(tail) if r.get('type') == 'assistant'), default=-1)
    if last_user > last_assistant:
        busy.append(thread[:8])
if busy:
    print('refusing: managed workers mid-turn: ' + ', '.join(busy), file=sys.stderr)
    sys.exit(1)
PY
then
  echo "restart refused; re-run with --force to interrupt them" >&2
  exit 1
fi
systemctl --user restart qiyan-bot.service
