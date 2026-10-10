-- Modelo para completar o cadastro de um escritório.
-- Troque 'silva-advogados' pela instância criada com scripts/novo-escritorio.sh e ajuste os dados.
-- Rode com:  docker compose exec -T postgres psql -U assistente -d agente < postgres/modelo-cadastro-escritorio.sql

BEGIN;

UPDATE escritorios SET
  telefone            = '+55 11 3333-0000',
  endereco            = 'Rua Exemplo, 123, sala 45 - Centro, São Paulo/SP',
  site                = 'https://silvaadvogados.com.br',
  areas_atuacao       = '{trabalhista,previdenciario,familia}',
  -- intervalos por dia (seg, ter, qua, qui, sex, sab, dom). Dia ausente = fechado.
  horario_atendimento = '{"seg":[["09:00","12:00"],["14:00","18:00"]],
                          "ter":[["09:00","12:00"],["14:00","18:00"]],
                          "qua":[["09:00","12:00"],["14:00","18:00"]],
                          "qui":[["09:00","12:00"],["14:00","18:00"]],
                          "sex":[["09:00","12:00"],["14:00","17:00"]]}',
  duracao_reuniao_min = 60,
  intervalo_entre_reunioes_min = 15,
  antecedencia_minima_horas = 3,
  dias_para_frente    = 14,
  google_calendar_id  = NULL,           -- ex.: 'agenda@silvaadvogados.com.br' (agenda geral do escritório)
  tom_de_voz          = 'formal, cordial e objetivo',
  valor_consulta      = NULL,           -- ex.: 'R$ 300,00' ou NULL para não informar
  instrucoes_extras   = 'Primeira reunião de até 1 hora. Atendimento presencial ou online.',
  horas_pausa_ia      = 12,
  chatwoot_inbox_id   = NULL            -- id da caixa de entrada no Chatwoot (para reativar a IA ao resolver)
WHERE instancia_whatsapp = 'silva-advogados';

-- Advogados e pessoas que recebem atendimentos.
-- areas vazio = atende todas | padrao = recebe quando nada mais se aplica
-- recebe_urgencias = recebe casos urgentes | faz_reunioes = false para secretária/atendimento
INSERT INTO responsaveis (escritorio_id, nome, cargo, whatsapp, email, areas, google_calendar_id, padrao, recebe_urgencias, faz_reunioes)
SELECT id, v.nome, v.cargo, v.whatsapp, v.email, v.areas::text[], v.agenda, v.padrao, v.urgencias, v.reunioes
FROM escritorios e, (VALUES
  ('Dr. João Silva',   'socio',      '5511911110001', 'joao@silvaadvogados.com.br',  '{trabalhista}',     NULL, true,  true,  true),
  ('Dra. Maria Costa', 'advogado',   '5511911110002', 'maria@silvaadvogados.com.br', '{familia,previdenciario}', NULL, false, false, true),
  ('Recepção',         'secretaria', '5511911110003', NULL,                          '{}',               NULL, false, false, false)
) AS v(nome, cargo, whatsapp, email, areas, agenda, padrao, urgencias, reunioes)
WHERE e.instancia_whatsapp = 'silva-advogados';

-- Perguntas frequentes
INSERT INTO faq (escritorio_id, pergunta, resposta)
SELECT id, v.pergunta, v.resposta FROM escritorios e, (VALUES
  ('Quais documentos levar?', 'RG, CPF, comprovante de residência e os documentos ligados ao caso.'),
  ('Atendem online?',          'Sim, por Google Meet. O link é enviado na confirmação.')
) AS v(pergunta, resposta)
WHERE e.instancia_whatsapp = 'silva-advogados';

COMMIT;
