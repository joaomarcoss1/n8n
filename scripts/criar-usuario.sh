#!/usr/bin/env bash
# Cria um usuário do painel (ou gera nova senha provisória para um existente).
# Uso: ./scripts/criar-usuario.sh <email> "<Nome>"                         -> administrador geral
#      ./scripts/criar-usuario.sh <email> "<Nome>" <instancia> [atendente] -> gestor/atendente de um escritório
set -euo pipefail
cd "$(dirname "$0")/.."
[[ $# -ge 2 ]] || { sed -n '2,5p' "$0"; exit 1; }
docker compose exec -T painel node src/criar-usuario.js "$@"
