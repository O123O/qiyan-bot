#!/bin/sh
set -eu
umask 077

token=${1-}
socket_path=${2-}
identity_path=${3-}
# The listener is an EXPLICIT argument rather than something inferred from whether a digest was
# passed. Under `set -eu` an empty variable is how an inference silently becomes an unauthenticated
# listener, and this one is reachable from any local user on a shared login node.
mode=${4-}
digest=${5-}

case "$token" in
  *[!0-9a-f]*|'') exit 64 ;;
esac
case "$socket_path:$identity_path" in
  *[!A-Za-z0-9_./:-]*) exit 64 ;;
esac
case "$mode" in
  unix) ;;
  ws)
    case "$digest" in
      *[!0-9a-f]*|'') exit 64 ;;
    esac
    [ "${#digest}" -eq 64 ] || exit 64
    ;;
  *) exit 64 ;;
esac

log_directory=${identity_path%/*}
log_path=${log_directory}/app-server.log
previous_log_path=${log_directory}/app-server.previous.log
previous_temporary=${previous_log_path}.tmp.$$
case "$log_path:$previous_log_path:$previous_temporary" in
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

QIYAN_RUNTIME_TOKEN=$token
export QIYAN_RUNTIME_TOKEN
# Errors only. This log lives in the runtime directory, which is /run/user — tmpfs, i.e.
# RAM — and is rotated only when the launcher next STARTS, so nothing caps it while the
# app-server runs. At info level every JSON-RPC request logs an enter and an exit span of
# ~600 bytes: one runtime wrote 3.1 GB in under five minutes and was killed for it.
RUST_LOG='error'
export RUST_LOG

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

# A WebSocket generation exists because this host redirects the unix socket into a /tmp that no
# other SSH channel can see. The port is loopback and kernel-assigned; `socket_path` stays
# validated above but is not handed to codex, since it is the path whose dangling link is the
# reason we are here. The capability token itself never reaches this script -- only its digest,
# which is not a secret and so is safe in a world-readable /proc/<pid>/cmdline.
if [ "$mode" = ws ]; then
  exec "$codex_path" app-server --listen ws://127.0.0.1:0 \
    --ws-auth capability-token --ws-token-sha256 "$digest" >> "$log_path" 2>&1
fi

exec "$codex_path" app-server --listen "unix://${socket_path}" >> "$log_path" 2>&1
