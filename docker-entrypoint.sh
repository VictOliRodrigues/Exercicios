#!/bin/sh
set -e

# O volume persistente pode chegar com dono root (no Coolify, por exemplo). Rodando como root,
# o script ajusta o dono da pasta e depois executa o app como o usuário node, sem privilégios.
if [ "$(id -u)" = "0" ]; then
  storage="${STORAGE_PATH:-/app/storage}"
  mkdir -p "$storage"
  if [ "$(stat -c %u "$storage")" != "$(id -u node)" ]; then
    chown -R node:node "$storage"
  fi
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
