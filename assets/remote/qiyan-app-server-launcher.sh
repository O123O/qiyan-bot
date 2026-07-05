#!/bin/sh
set -eu
umask 077

token=${1-}
socket_path=${2-}
identity_path=${3-}

case "$token" in
  *[!0-9a-f]*|'') exit 64 ;;
esac
case "$socket_path:$identity_path" in
  *[!A-Za-z0-9_./:-]*) exit 64 ;;
esac

codex_path=$(command -v codex)
case "$codex_path" in
  /*) ;;
  *) exit 69 ;;
esac
case "$codex_path" in
  *[!A-Za-z0-9_./+-]*) exit 69 ;;
esac
[ -x "$codex_path" ] || exit 69

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

exec "$codex_path" app-server --listen "unix://${socket_path}"
