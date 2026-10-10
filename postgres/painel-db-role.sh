#!/bin/bash
# Cria (ou atualiza a senha de) o usuário "painel" no Postgres: só acessa o banco
# "agente" e só lê/grava dados (não altera tabelas, não lê os outros bancos).
set -euo pipefail
: "${PAINEL_DB_PASSWORD:?PAINEL_DB_PASSWORD não definida}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname agente \
  -v senha="$PAINEL_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE painel LOGIN PASSWORD %L', :'senha')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'painel') \gexec
SELECT format('ALTER ROLE painel PASSWORD %L', :'senha') \gexec
GRANT CONNECT ON DATABASE agente TO painel;
GRANT USAGE ON SCHEMA public TO painel;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO painel;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO painel;
GRANT EXECUTE ON FUNCTION escolher_responsavel(uuid, uuid, text, boolean, boolean) TO painel;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO painel;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO painel;
SQL
echo "Usuário do painel configurado"
