-- Dados de EXEMPLO para testar o sistema (não são aplicados automaticamente).
-- Para carregar: docker compose exec -T postgres psql -U assistente -d agente < postgres/dados-exemplo.sql

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
