#!/bin/bash
# Roda só na PRIMEIRA inicialização do Postgres (volume vazio).
# Cria os bancos de cada serviço e aplica o schema do agente.
set -euo pipefail

for db in n8n evolution chatwoot agente; do
  echo "Criando banco: $db"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -c "CREATE DATABASE \"$db\";"
done

# Chatwoot e o agente usam pgvector (busca semântica).
for db in chatwoot agente; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" \
    -c "CREATE EXTENSION IF NOT EXISTS vector;"
done

echo "Aplicando schema do agente"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname agente -f /schemas/agente-schema.sql
