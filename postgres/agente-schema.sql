-- Banco "agente": dados do assistente jurídico, multi-escritório (multi-tenant).
-- Um único conjunto de fluxos no n8n atende todos os escritórios: o escritório é
-- identificado pela instância da Evolution API que recebeu a mensagem.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Configurações gerais do sistema (alertas de erro etc.) ----------------------
CREATE TABLE config_sistema (
  chave text PRIMARY KEY,
  valor text,
  descricao text
);
INSERT INTO config_sistema (chave, valor, descricao) VALUES
  ('admin_whatsapp',    NULL, 'WhatsApp (só números, com DDI) que recebe alertas de erro dos fluxos'),
  ('instancia_alertas', NULL, 'Instância da Evolution usada para enviar os alertas');

-- Escritórios clientes ------------------------------------------------------
CREATE TABLE escritorios (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome                text NOT NULL,
  instancia_whatsapp  text NOT NULL UNIQUE,       -- nome da instância na Evolution API
  telefone            text,
  endereco            text,
  site                text,
  areas_atuacao       text[] NOT NULL DEFAULT '{}',
  -- dias: seg, ter, qua, qui, sex, sab, dom -> lista de intervalos [["09:00","12:00"],["13:30","18:00"]]
  horario_atendimento jsonb NOT NULL DEFAULT
    '{"seg":[["09:00","12:00"],["13:30","18:00"]],"ter":[["09:00","12:00"],["13:30","18:00"]],"qua":[["09:00","12:00"],["13:30","18:00"]],"qui":[["09:00","12:00"],["13:30","18:00"]],"sex":[["09:00","12:00"],["13:30","17:00"]]}',
  duracao_reuniao_min int  NOT NULL DEFAULT 60,
  intervalo_entre_reunioes_min int NOT NULL DEFAULT 15,
  antecedencia_minima_horas int NOT NULL DEFAULT 3,  -- não oferece horário antes disso
  dias_para_frente    int  NOT NULL DEFAULT 14,      -- janela máxima de agendamento
  google_calendar_id  text,                          -- agenda geral do escritório (opcional)
  chatwoot_account_id int,
  chatwoot_inbox_id   int,
  tom_de_voz          text NOT NULL DEFAULT 'formal, cordial e objetivo',
  instrucoes_extras   text,
  valor_consulta      text,                          -- null = não informar valores
  horas_pausa_ia      int  NOT NULL DEFAULT 12,      -- quanto tempo a IA fica pausada após humano assumir
  followup_ativo      boolean NOT NULL DEFAULT true,
  plano               text NOT NULL DEFAULT 'basico',
  ativo               boolean NOT NULL DEFAULT true,
  criado_em           timestamptz NOT NULL DEFAULT now()
);

-- Advogados e pessoas responsáveis ----------------------------------------------
CREATE TABLE responsaveis (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  escritorio_id      uuid NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  nome               text NOT NULL,                 -- como o cliente verá: "Dra. Ana Souza"
  cargo              text NOT NULL DEFAULT 'advogado' CHECK (cargo IN ('advogado','socio','secretaria','estagiario','atendimento')),
  whatsapp           text NOT NULL,                 -- só números com DDI: 5511999990000
  email              text,                          -- vira convidado no evento do Google Agenda
  areas              text[] NOT NULL DEFAULT '{}',  -- áreas que atende; vazio = todas
  google_calendar_id text,                          -- agenda própria (senão usa a do escritório)
  faz_reunioes       boolean NOT NULL DEFAULT true, -- false = só recebe encaminhamentos (ex.: secretária)
  recebe_urgencias   boolean NOT NULL DEFAULT false,
  padrao             boolean NOT NULL DEFAULT false,-- responsável quando nada mais se aplica
  recebe_agenda_diaria boolean NOT NULL DEFAULT true,
  ativo              boolean NOT NULL DEFAULT true,
  criado_em          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX responsaveis_escritorio_idx ON responsaveis (escritorio_id) WHERE ativo;

-- Perguntas frequentes / base de conhecimento --------------------------------
CREATE TABLE faq (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  escritorio_id uuid NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  pergunta      text NOT NULL,
  resposta      text NOT NULL,
  embedding     vector(1536),                      -- opcional: busca semântica (RAG)
  ativo         boolean NOT NULL DEFAULT true
);
CREATE INDEX faq_escritorio_idx ON faq (escritorio_id) WHERE ativo;

-- Contatos / leads ----------------------------------------------------------
CREATE TABLE leads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  escritorio_id    uuid NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  whatsapp         text NOT NULL,
  nome_whatsapp    text,                           -- nome do perfil do WhatsApp
  nome             text,                           -- nome informado na conversa
  email            text,
  area             text,
  resumo_caso      text,
  urgencia         text CHECK (urgencia IN ('baixa','media','alta')),
  ja_e_cliente     boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'novo'
                   CHECK (status IN ('novo','em_triagem','agendado','atendido','cliente','perdido','humano')),
  responsavel_id   uuid REFERENCES responsaveis(id) ON DELETE SET NULL,
  consentimento_lgpd_em timestamptz,
  ia_pausada_ate   timestamptz,                    -- enquanto > now(), a IA não responde
  ultima_msg_cliente_em timestamptz,
  followup_enviado_em   timestamptz,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  atualizado_em    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (escritorio_id, whatsapp)
);
CREATE INDEX leads_status_idx ON leads (escritorio_id, status);

-- Histórico de mensagens (log completo, inclusive humanas) --------------------
CREATE TABLE mensagens (
  id             bigserial PRIMARY KEY,
  lead_id        uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  papel          text NOT NULL CHECK (papel IN ('cliente','assistente','humano','sistema')),
  conteudo       text NOT NULL,
  tipo           text NOT NULL DEFAULT 'texto',     -- texto, audio, imagem, documento, lembrete, followup
  wa_message_id  text,                              -- id da mensagem no WhatsApp
  respondida     boolean NOT NULL DEFAULT false,    -- mensagens do cliente já tratadas pela IA
  criado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mensagens_lead_idx ON mensagens (lead_id, criado_em DESC);
CREATE UNIQUE INDEX mensagens_wa_id_idx ON mensagens (wa_message_id) WHERE wa_message_id IS NOT NULL;

-- Agendamentos ---------------------------------------------------------------
CREATE TABLE agendamentos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  escritorio_id    uuid NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  lead_id          uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  responsavel_id   uuid REFERENCES responsaveis(id) ON DELETE SET NULL,
  inicio           timestamptz NOT NULL,
  fim              timestamptz NOT NULL,
  modalidade       text NOT NULL DEFAULT 'presencial' CHECK (modalidade IN ('presencial','online','telefone')),
  area             text,
  resumo           text,
  google_calendar_id text,
  google_event_id  text,
  link_reuniao     text,
  status           text NOT NULL DEFAULT 'marcado'
                   CHECK (status IN ('marcado','confirmado','cancelado','realizado','faltou')),
  lembrete_24h_em  timestamptz,
  lembrete_1h_em   timestamptz,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  atualizado_em    timestamptz NOT NULL DEFAULT now(),
  CHECK (fim > inicio),
  -- impede dois agendamentos sobrepostos para o mesmo advogado, mesmo com mensagens simultâneas
  CONSTRAINT agendamentos_sem_conflito EXCLUDE USING gist (
    responsavel_id WITH =, tstzrange(inicio, fim) WITH &&
  ) WHERE (status IN ('marcado','confirmado'))
);
CREATE INDEX agendamentos_inicio_idx ON agendamentos (escritorio_id, inicio) WHERE status IN ('marcado','confirmado');

-- Encaminhamentos para humanos ----------------------------------------------
CREATE TABLE encaminhamentos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  escritorio_id  uuid NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
  lead_id        uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  responsavel_id uuid REFERENCES responsaveis(id) ON DELETE SET NULL,
  motivo         text NOT NULL,
  resumo         text,
  urgencia       text CHECK (urgencia IN ('baixa','media','alta')),
  notificado     boolean NOT NULL DEFAULT false,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  resolvido_em   timestamptz
);

-- Memória da IA (mesmo formato do nó "Postgres Chat Memory" do n8n) ---------------
CREATE TABLE IF NOT EXISTS n8n_chat_histories (
  id         serial PRIMARY KEY,
  session_id varchar(255) NOT NULL,   -- = leads.id
  message    jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS n8n_chat_histories_session_idx ON n8n_chat_histories (session_id, id);

-- Funções ----------------------------------------------------------------------

-- Escolhe o responsável por um atendimento, nesta ordem:
--   1. o responsável que já acompanha o lead (se atende a área pedida);
--   2. se urgente: quem recebe urgências (preferindo quem atende a área);
--   3. quem atende a área (com menos atendimentos nos últimos 30 dias);
--   4. o responsável padrão; 5. qualquer ativo.
-- p_precisa_reuniao = true considera só quem faz reuniões.
CREATE OR REPLACE FUNCTION escolher_responsavel(
  p_escritorio uuid, p_lead uuid, p_area text, p_urgente boolean, p_precisa_reuniao boolean DEFAULT false
) RETURNS uuid LANGUAGE sql STABLE AS $$
  WITH carga AS (
    SELECT r.*,
      (SELECT count(*) FROM encaminhamentos e WHERE e.responsavel_id = r.id AND e.criado_em > now() - interval '30 days')
      + (SELECT count(*) FROM agendamentos a WHERE a.responsavel_id = r.id AND a.criado_em > now() - interval '30 days') AS atendimentos,
      (cardinality(r.areas) = 0 OR lower(coalesce(p_area,'')) = ANY (SELECT lower(x) FROM unnest(r.areas) x)) AS atende_area
    FROM responsaveis r
    WHERE r.escritorio_id = p_escritorio AND r.ativo AND (NOT p_precisa_reuniao OR r.faz_reunioes)
  )
  SELECT id FROM (
    SELECT c.id, 1 AS prioridade, 0::bigint AS atendimentos FROM carga c
      JOIN leads l ON l.responsavel_id = c.id WHERE l.id = p_lead AND (p_area IS NULL OR c.atende_area)
    UNION ALL
    SELECT id, 2, atendimentos FROM carga WHERE p_urgente AND recebe_urgencias AND atende_area
    UNION ALL
    SELECT id, 3, atendimentos FROM carga WHERE p_urgente AND recebe_urgencias
    UNION ALL
    SELECT id, 4, atendimentos FROM carga WHERE p_area IS NOT NULL AND cardinality(areas) > 0 AND atende_area
    UNION ALL
    SELECT id, 5, atendimentos FROM carga WHERE padrao
    UNION ALL
    SELECT id, 6, atendimentos FROM carga
  ) opcoes
  ORDER BY prioridade, atendimentos, id
  LIMIT 1
$$;

-- Lembretes pendentes (fluxo "Rotinas" roda a cada 15 min)
CREATE VIEW lembretes_pendentes AS
SELECT a.id AS agendamento_id, a.inicio, a.modalidade, a.link_reuniao,
       l.id AS lead_id, l.whatsapp, coalesce(l.nome, l.nome_whatsapp) AS nome,
       r.nome AS responsavel, e.instancia_whatsapp, e.nome AS escritorio, e.endereco,
       CASE WHEN a.inicio - now() <= interval '75 minutes' THEN '1h' ELSE '24h' END AS tipo_lembrete
FROM agendamentos a
JOIN leads l ON l.id = a.lead_id
JOIN escritorios e ON e.id = a.escritorio_id
LEFT JOIN responsaveis r ON r.id = a.responsavel_id
WHERE a.status IN ('marcado','confirmado') AND e.ativo AND a.inicio > now()
  AND ((a.lembrete_1h_em IS NULL AND a.inicio - now() <= interval '75 minutes')
    OR (a.lembrete_24h_em IS NULL AND a.inicio - now() <= interval '24 hours' AND a.inicio - now() > interval '3 hours'));

-- Escritório de exemplo para testes -----------------------------------------
INSERT INTO escritorios (id, nome, instancia_whatsapp, telefone, endereco, areas_atuacao, instrucoes_extras)
VALUES ('00000000-0000-0000-0000-000000000001', 'Souza & Lima Advocacia', 'exemplo', '+55 11 3333-0000',
        'Av. Paulista, 1000, conj. 101 - Bela Vista, São Paulo/SP',
        '{trabalhista,previdenciario,familia,civil}',
        'Primeira reunião de até 1 hora, presencial ou online (Google Meet). Atendemos todo o Brasil de forma online.');

INSERT INTO responsaveis (escritorio_id, nome, cargo, whatsapp, email, areas, padrao, recebe_urgencias) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Dra. Ana Souza',  'socio',    '5511900000001', 'ana@exemplo.adv.br',    '{trabalhista,previdenciario}', true,  false),
  ('00000000-0000-0000-0000-000000000001', 'Dr. Carlos Lima', 'advogado', '5511900000002', 'carlos@exemplo.adv.br', '{familia,civil}',              false, true);
INSERT INTO responsaveis (escritorio_id, nome, cargo, whatsapp, areas, faz_reunioes, recebe_agenda_diaria) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Juliana (secretária)', 'secretaria', '5511900000003', '{}', false, false);

INSERT INTO faq (escritorio_id, pergunta, resposta) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Quais documentos levar na primeira reunião?',
   'RG, CPF, comprovante de residência e os documentos ligados ao caso (contratos, holerites, carteira de trabalho, extrato do INSS, certidões, decisões anteriores).'),
  ('00000000-0000-0000-0000-000000000001', 'Vocês atendem online?',
   'Sim. A reunião online é feita pelo Google Meet e o link é enviado na confirmação.'),
  ('00000000-0000-0000-0000-000000000001', 'Tem estacionamento?',
   'Há estacionamentos conveniados na Alameda Santos, a 100 metros do escritório.');
