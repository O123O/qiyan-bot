#!/bin/sh
# Restart qiyan-bot only when no managed worker is still working.
#
# The running bot is the authority, and it is asked first: a session's status lives in its
# memory, not on disk. Background work — a Claude subagent or backgrounded command still
# running after its turn ended — is the case that has no transcript signal at all, so a
# file-based check cannot see it and would report "idle" while killing live work.
#
# The transcript scan below is the fallback for when the bot cannot be asked (web UI off, or
# already down). It catches a worker mid-turn: a user row with no assistant row after it.
# Grepping for a process pattern catches neither — the SDK host spawns no `claude -p`, so
# such a check reports "idle" forever. Pass --force to override deliberately.
set -eu
if [ "${1-}" != "--force" ] && ! python3 - <<'PY'
import glob, json, os, sys, time, urllib.request

home = os.path.expanduser('~/.qiyan-bot')


def refuse(reason):
    print('refusing: ' + reason, file=sys.stderr)
    sys.exit(1)


# Ask the running bot. Its /api/sessions reports each managed session's live native status,
# which is active for a turn in flight AND for background work that outlives its turn.
def ask_bot():
    with open(os.path.join(home, 'webui.json')) as handle:
        state = json.load(handle)
    if not state.get('enabled'):
        return None
    # `port` is recorded only when it was given as an explicit override, so its absence means
    # the default — not "no web UI". Bailing out on it silently downgraded every default
    # deployment to the transcript scan, which is exactly the check that cannot see a subagent.
    port = state.get('port') or int(os.environ.get('WEB_PORT', 9520))
    # A wildcard bind answers on loopback; anything else has to be dialled where it listens.
    host = state.get('host') or '127.0.0.1'
    if host in ('0.0.0.0', '::', ''):
        host = '127.0.0.1'
    with open(os.path.join(home, 'data', 'web-token')) as handle:
        token = handle.read().strip()
    url = 'http://%s:%d/api/sessions?token=%s' % (host, port, token)
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.load(response)


try:
    snapshot = ask_bot()
except Exception:
    snapshot = None

if snapshot is not None:
    busy = [s['nickname'] for s in snapshot.get('sessions', []) if s.get('nativeStatus') == 'active']
    if busy:
        refuse('managed workers are still working: ' + ', '.join(sorted(busy)))
    sys.exit(0)

# Fallback: the bot could not be asked, so read the transcripts directly.
print('note: the bot could not be asked; falling back to a transcript scan', file=sys.stderr)
managed = set()
with open(os.path.join(home, 'data', 'sessions.json')) as handle:
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
    refuse('managed workers mid-turn: ' + ', '.join(busy))
PY
then
  echo "restart refused; re-run with --force to interrupt them" >&2
  exit 1
fi
systemctl --user restart qiyan-bot.service
