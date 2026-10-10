#!/usr/bin/env bash
# Importa (ou atualiza) credenciais e fluxos no n8n e publica os fluxos.
# Uso: ./scripts/importar-fluxos.sh            -> importa fluxos; cria credenciais que ainda não existem
#      ./scripts/importar-fluxos.sh --credenciais -> recria TODAS as credenciais a partir do .env
#                                                  (atenção: desconecta o Google Agenda já autorizado)
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo "Arquivo .env não encontrado. Rode o install.sh primeiro." >&2; exit 1; }
set -a; source .env; set +a

RECRIAR_CREDENCIAIS="${1:-}"
WORKFLOWS=(ajAlertaErros001 ajToolHorarios01 ajToolAgendar001 ajToolGerenciar1 ajToolRegistrar1 ajToolTransferir ajAtendimento001 ajRotinas0000001 ajRetomarIA00001 ajAcoesPainel001)
n8n() { docker compose exec -T -u node n8n n8n "$@"; }
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

echo "==> Aguardando o n8n"
until docker compose exec -T n8n wget -qO- http://127.0.0.1:5678/healthz >/dev/null 2>&1; do sleep 3; done

# --- credenciais ------------------------------------------------------------
mkdir -p .credenciais-tmp && chmod 755 .credenciais-tmp
trap 'rm -f .credenciais-tmp/*.json' EXIT

credencial_existe() {
  docker compose exec -T postgres psql -U "$POSTGRES_USER" -d n8n -tAc \
    "SELECT 1 FROM credentials_entity WHERE id = '$1'" 2>/dev/null | grep -q 1
}

adicionar() { # id nome tipo json_data
  if [[ "$RECRIAR_CREDENCIAIS" == "--credenciais" ]] || ! credencial_existe "$1"; then
    CREDS+=("{\"id\":\"$1\",\"name\":\"$2\",\"type\":\"$3\",\"data\":$4}")
  fi
}
CREDS=()
adicionar ajCredPostgres01 "Postgres - Agente" postgres \
  "{\"host\":\"postgres\",\"port\":5432,\"database\":\"agente\",\"user\":\"$(json_escape "$POSTGRES_USER")\",\"password\":\"$(json_escape "$POSTGRES_PASSWORD")\",\"ssl\":\"disable\"}"
adicionar ajCredEvolution1 "Evolution API" httpHeaderAuth \
  "{\"name\":\"apikey\",\"value\":\"$(json_escape "$EVOLUTION_API_KEY")\"}"
adicionar ajCredPainelHook "Painel -> n8n (token)" httpHeaderAuth \
  "{\"name\":\"x-painel-token\",\"value\":\"$(json_escape "$PAINEL_N8N_SECRET")\"}"
adicionar ajCredAnthropic1 "Anthropic" anthropicApi \
  "{\"apiKey\":\"$(json_escape "${ANTHROPIC_API_KEY:-}")\",\"url\":\"$(json_escape "${ANTHROPIC_BASE_URL:-https://api.anthropic.com}")\"}"
adicionar ajCredOpenAI0001 "OpenAI (transcrição de áudio)" openAiApi \
  "{\"apiKey\":\"$(json_escape "${OPENAI_API_KEY:-}")\",\"url\":\"$(json_escape "${OPENAI_BASE_URL:-https://api.openai.com/v1}")\"}"
adicionar ajCredGoogleCal1 "Google Agenda" googleCalendarOAuth2Api \
  "{\"clientId\":\"$(json_escape "${GOOGLE_CLIENT_ID:-}")\",\"clientSecret\":\"$(json_escape "${GOOGLE_CLIENT_SECRET:-}")\"}"

if ((${#CREDS[@]})); then
  echo "==> Importando ${#CREDS[@]} credencial(is)"
  (IFS=,; umask 022; printf '[%s]' "${CREDS[*]}" > .credenciais-tmp/credenciais.json)
  n8n import:credentials --input=/credenciais/credenciais.json
else
  echo "==> Credenciais já existem (use --credenciais para recriar a partir do .env)"
fi

# --- fluxos -----------------------------------------------------------------
echo "==> Importando fluxos"
n8n import:workflow --separate --input=/fluxos

echo "==> Publicando fluxos"
for id in "${WORKFLOWS[@]}"; do
  n8n publish:workflow --id="$id" >/dev/null && echo "    publicado: $id"
done

# --- alertas de erro --------------------------------------------------------
if [[ -n "${ADMIN_WHATSAPP:-}" ]]; then
  docker compose exec -T postgres psql -q -U "$POSTGRES_USER" -d agente -c \
    "UPDATE config_sistema SET valor = '$(printf '%s' "$ADMIN_WHATSAPP" | tr -cd '0-9')' WHERE chave = 'admin_whatsapp';
     UPDATE config_sistema SET valor = COALESCE(valor, (SELECT instancia_whatsapp FROM escritorios WHERE ativo ORDER BY criado_em LIMIT 1))
     WHERE chave = 'instancia_alertas';"
fi

echo "==> Reiniciando o n8n para ativar os fluxos publicados"
INICIO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose restart n8n >/dev/null
# o n8n responde ao healthz antes de terminar de ativar os fluxos; espera a ativação
until docker compose logs n8n --since "$INICIO" 2>&1 | grep -q "Finished building workflow dependency index"; do sleep 3; done
sleep 3
echo "✅ Fluxos importados e ativos."
