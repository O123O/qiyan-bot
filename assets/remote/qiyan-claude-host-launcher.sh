#!/bin/sh
set -eu
umask 077

token=${1-}
socket_path=${2-}
identity_path=${3-}
host_path=${4-}
sdk_path=${5-}

case "$token" in
  *[!0-9a-f]*|'') exit 64 ;;
esac
case "$socket_path:$identity_path:$host_path" in
  *[!A-Za-z0-9_./:-]*) exit 64 ;;
esac
# The Agent SDK lives under a scoped package directory, so its path carries an `@` that no
# other remote path ever contains.
case "$sdk_path" in
  *[!A-Za-z0-9_./:@-]*|'') exit 64 ;;
esac

log_directory=${identity_path%/*}
log_path=${log_directory}/claude-host.log
previous_log_path=${log_directory}/claude-host.previous.log
previous_temporary=${previous_log_path}.tmp.$$
case "$log_path:$previous_log_path:$previous_temporary" in
  *[!A-Za-z0-9_./:-]*) exit 64 ;;
esac

node_path=$(command -v node)
case "$node_path" in
  /*) ;;
  *) exit 69 ;;
esac
case "$node_path" in
  *[!A-Za-z0-9_./+-]*) exit 69 ;;
esac
[ -x "$node_path" ] || exit 69

# The host drives this CLI through pathToClaudeCodeExecutable, so the machine runs the one
# Claude the user installed rather than the SDK's vendored copy.
claude_path=$(command -v claude)
case "$claude_path" in
  /*) ;;
  *) exit 69 ;;
esac
case "$claude_path" in
  *[!A-Za-z0-9_./+-]*) exit 69 ;;
esac
[ -x "$claude_path" ] || exit 69
[ -f "$host_path" ] || exit 69
[ -f "$sdk_path" ] || exit 69

QIYAN_RUNTIME_TOKEN=$token
export QIYAN_RUNTIME_TOKEN

if [ -L "$log_path" ]; then
  exit 73
elif [ -f "$log_path" ]; then
  chmod 600 "$log_path"
  if [ -d "$previous_log_path" ]; then exit 73; fi
  mv -f "$log_path" "$previous_log_path"
  tail -c 1048576 "$previous_log_path" > "$previous_temporary"
  chmod 600 "$previous_temporary"
  mv -f "$previous_temporary" "$previous_log_path"
elif [ -e "$log_path" ]; then
  exit 73
fi
: >> "$log_path"
chmod 600 "$log_path"

start_time=$(cut -d ' ' -f 22 "/proc/$$/stat")
process_group=$(ps -o pgid= -p "$$" | tr -d ' ')
case "$start_time:$process_group" in
  *[!0-9:]*) exit 70 ;;
esac

temporary="${identity_path}.tmp.$$"
printf '{"kind":"ssh","token":"%s","pid":%s,"linuxStartTime":"%s","processGroupId":%s}\n' \
  "$token" "$$" "$start_time" "$process_group" > "$temporary"
chmod 600 "$temporary"
mv -f "$temporary" "$identity_path"

exec "$node_path" "$host_path" --socket "$socket_path" --claude "$claude_path" --sdk "$sdk_path" >> "$log_path" 2>&1
