#!/usr/bin/env bash
# Instala o Assistente Jurídico 24h num VPS Ubuntu/Debian limpo.
# Uso:  sudo ./install.sh seudominio.com.br voce@email.com
set -euo pipefail
cd "$(dirname "$0")"

DOMAIN_ARG="${1:-}"
EMAIL_ARG="${2:-}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Rode como root: sudo ./install.sh seudominio.com.br voce@email.com" >&2
  exit 1
fi

# 1. Docker ---------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "Instalando Docker"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
docker compose version >/dev/null

# 2. Firewall ---------------------------------------------------------------
if command -v ufw >/dev/null 2>&1; then
  log "Configurando firewall (SSH, HTTP, HTTPS)"
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
fi

# 3. .env com segredos gerados ---------------------------------------------
gen() { openssl rand -hex "${1:-24}"; }

if [[ ! -f .env ]]; then
  log "Criando .env a partir do .env.example"
  cp .env.example .env
fi
chmod 600 .env

[[ -n "$DOMAIN_ARG" ]] && sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN_ARG}|" .env
[[ -n "$EMAIL_ARG" ]] && sed -i "s|^ACME_EMAIL=.*|ACME_EMAIL=${EMAIL_ARG}|" .env
if grep -qE "^(DOMAIN=seudominio\.com\.br|ACME_EMAIL=voce@)" .env; then
  echo "Informe domínio e e-mail: sudo ./install.sh seudominio.com.br voce@email.com" >&2
  exit 1
fi

# gera senhas para os segredos ainda vazios ou com "troque-me" (nunca troca um segredo já definido)
gerar_se_vazio() { # variável tamanho
  if grep -qE "^$1=(troque-me)?$" .env; then
    sed -i "s|^$1=.*|$1=$(gen "$2")|" .env
    echo "    gerado: $1"
  fi
}
log "Conferindo senhas e chaves"
gerar_se_vazio POSTGRES_PASSWORD 24
gerar_se_vazio REDIS_PASSWORD 24
gerar_se_vazio N8N_ENCRYPTION_KEY 32
gerar_se_vazio EVOLUTION_API_KEY 32
gerar_se_vazio CHATWOOT_SECRET_KEY_BASE 64
set -a; source .env; set +a
[[ -n "${ANTHROPIC_API_KEY:-}" ]] || echo "⚠️  ANTHROPIC_API_KEY vazia no .env: a IA não vai responder até você preencher e rodar ./scripts/importar-fluxos.sh --credenciais"

# 4. Sobe a stack -------------------------------------------------------------
log "Baixando imagens"
docker compose pull

log "Subindo banco e cache"
docker compose up -d postgres redis
until docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d agente >/dev/null 2>&1; do sleep 2; done

log "Preparando banco do Chatwoot (pode levar alguns minutos)"
docker compose run --rm chatwoot-rails bundle exec rails db:chatwoot_prepare

log "Subindo todos os serviços"
mkdir -p .credenciais-tmp
docker compose up -d

log "Importando os fluxos do assistente no n8n"
./scripts/importar-fluxos.sh

cat <<EOF

✅ Instalação concluída.

Antes de acessar, confirme que estes 3 registros DNS (tipo A) apontam para o IP deste servidor:
  ${N8N_SUBDOMAIN}.${DOMAIN}
  ${EVOLUTION_SUBDOMAIN}.${DOMAIN}
  ${CHATWOOT_SUBDOMAIN}.${DOMAIN}

  n8n (fluxos e IA):          https://${N8N_SUBDOMAIN}.${DOMAIN}
  Evolution API (WhatsApp):   https://${EVOLUTION_SUBDOMAIN}.${DOMAIN}/manager
      API key: ${EVOLUTION_API_KEY}
  Chatwoot (painel humano):   https://${CHATWOOT_SUBDOMAIN}.${DOMAIN}

Todas as senhas estão em $(pwd)/.env. Faça backup desse arquivo.
Próximos passos: veja o README.md, seção "Depois de instalar".
Para cadastrar o primeiro escritório: ./scripts/novo-escritorio.sh <instancia> "<Nome>"
EOF
