#!/usr/bin/env bash
# Cadastra um escritório novo: cria a instância do WhatsApp na Evolution API (já ligada ao n8n)
# e o registro no banco. Depois é só ler o QR Code.
#
# Uso: ./scripts/novo-escritorio.sh <instancia> "<Nome do escritório>"
# Ex.: ./scripts/novo-escritorio.sh silva-advogados "Silva Advogados Associados"
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

INSTANCIA="${1:-}"; NOME="${2:-}"
if [[ -z "$INSTANCIA" || -z "$NOME" ]]; then
  echo "Uso: $0 <instancia> \"<Nome do escritório>\"" >&2; exit 1
fi
[[ "$INSTANCIA" =~ ^[a-z0-9-]+$ ]] || { echo "A instância deve ter só letras minúsculas, números e hífen." >&2; exit 1; }

echo "==> Criando instância '$INSTANCIA' na Evolution API (webhook -> n8n)"
docker compose exec -T n8n wget -qO- \
  --header "apikey: $EVOLUTION_API_KEY" --header "Content-Type: application/json" \
  --post-data "{
    \"instanceName\": \"$INSTANCIA\",
    \"integration\": \"WHATSAPP-BAILEYS\",
    \"qrcode\": true,
    \"groupsIgnore\": true,
    \"alwaysOnline\": false,
    \"readMessages\": false,
    \"webhook\": {
      \"url\": \"http://n8n:5678/webhook/whatsapp\",
      \"byEvents\": false,
      \"base64\": true,
      \"events\": [\"MESSAGES_UPSERT\"]
    }
  }" http://evolution:8080/instance/create >/dev/null && echo "    ok"

echo "==> Cadastrando no banco"
docker compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d agente \
  -v inst="$INSTANCIA" -v nome="$NOME" <<'SQL'
INSERT INTO escritorios (nome, instancia_whatsapp) VALUES (:'nome', :'inst')
ON CONFLICT (instancia_whatsapp) DO UPDATE SET nome = EXCLUDED.nome, ativo = true;
UPDATE config_sistema SET valor = COALESCE(valor, :'inst') WHERE chave = 'instancia_alertas';
SQL

cat <<EOF

✅ Escritório "$NOME" cadastrado.

Próximos passos:
 1. Conecte o WhatsApp: abra https://${EVOLUTION_SUBDOMAIN}.${DOMAIN}/manager, entre com a API key
    do .env, abra a instância "$INSTANCIA" e leia o QR Code com o celular do escritório.
 2. Complete o cadastro (endereço, áreas, horários, advogados, FAQ):
      docker compose exec -it postgres psql -U $POSTGRES_USER -d agente
    Use o modelo em postgres/modelo-cadastro-escritorio.sql.
EOF
