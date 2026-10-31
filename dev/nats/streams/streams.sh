#!/bin/sh
set -eu
n() { nats --inbox-prefix _INBOX_admin "$@"; }
for i in $(seq 60); do n account info >/dev/null 2>&1 && break; sleep 2; done
for f in /streams/*.json; do
  name=$(basename "$f" .json)
  if n stream info "$name" >/dev/null 2>&1; then
    n stream edit "$name" --config "$f" --force
  else
    n stream add "$name" --config "$f"
  fi
done
n stream ls --names
