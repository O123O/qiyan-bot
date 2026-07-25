#!/bin/sh
set -eu
umask 077

token=$1
identity_path=$2
watch_path=$3
export QIYAN_RUNTIME_TOKEN=$token

[ -p "$watch_path" ]
exec 3<>"$watch_path"

pid=$$
stat_line=$(cat "/proc/$pid/stat")
after=${stat_line##*) }
process_group=$(printf '%s\n' "$after" | cut -d ' ' -f 3)
start_time=$(printf '%s\n' "$after" | cut -d ' ' -f 20)
temporary="${identity_path}.$$"

printf '{"kind":"ssh","token":"%s","pid":%s,"linuxStartTime":"%s","processGroupId":%s}\n' \
  "$token" "$pid" "$start_time" "$process_group" > "$temporary"
chmod 600 "$temporary"
mv -f "$temporary" "$identity_path"

exec tail -f /dev/null
