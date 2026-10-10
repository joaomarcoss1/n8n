'use strict';
// Rotas da API do painel. Toda consulta é filtrada pelo escritório da sessão (req.escritorioId).

const PAPEIS_CONFIG = ['admin_geral', 'gestor'];
const STATUS_LEAD = ['novo', 'em_triagem', 'agendado', 'atendido', 'cliente', 'perdido', 'humano'];
const CARGOS = ['advogado', 'socio', 'secretaria', 'estagiario', 'atendimento'];
const TONS = ['formal, cordial e objetivo', 'próximo e acolhedor, sem perder a formalidade', 'direto e objetivo'];

function erro(status, msg) { const e = new Error(msg); e.status = status; e.publico = true; return e; }

module.exports = function montarApi(app, { db, CFG, S, auditar }) {
  const { V } = S;
  const q = (sql, params) => db.query(sql, params);
  const rota = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  const escritorio = (req) => {
    if (!req.escritorioId) throw erro(400, 'Selecione um escritório.');
    return req.escritorioId;
  };
  const exigeConfig = (req) => {
    if (!PAPEIS_CONFIG.includes(req.usuario.papel)) throw erro(403, 'Seu usuário não tem permissão para isso.');
  };
  const exigeAdminGeral = (req) => {
    if (req.usuario.papel !== 'admin_geral') throw erro(403, 'Apenas o administrador geral pode fazer isso.');
  };

  // ---------------------------------------------------------------- integrações
  async function evolution(metodo, caminho, corpo) {
    let r;
    try {
      r = await fetch(CFG.evolutionUrl + caminho, {
        method: metodo,
        headers: { apikey: CFG.evolutionKey, 'content-type': 'application/json' },
        body: corpo ? JSON.stringify(corpo) : undefined,
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      throw erro(502, 'Não foi possível falar com o WhatsApp (Evolution API). Tente de novo em instantes.');
    }
    const texto = await r.text();
    let json; try { json = JSON.parse(texto); } catch { json = { bruto: texto.slice(0, 300) }; }
    return { status: r.status, ok: r.ok, json };
  }

  async function acaoN8n(dados) {
    let r;
    try {
      r = await fetch(`${CFG.n8nUrl}/webhook/painel-acao`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-painel-token': CFG.n8nSegredo },
        body: JSON.stringify(dados),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw erro(502, 'Não foi possível falar com o n8n. Tente de novo em instantes.');
    }
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw erro(502, 'O n8n recusou a ação. Veja as execuções no n8n.');
    return json;
  }

  async function leadDoEscritorio(req, id) {
    const { rows } = await q('SELECT * FROM leads WHERE id = $1 AND escritorio_id = $2', [V.uuid(id), escritorio(req)]);
    if (!rows[0]) throw erro(404, 'Conversa não encontrada.');
    return rows[0];
  }

  // ---------------------------------------------------------------- sessão
  app.get('/api/me', rota(async (req, res) => {
    const escritorios = req.usuario.papel === 'admin_geral'
      ? (await q('SELECT id, nome, instancia_whatsapp, ativo FROM escritorios ORDER BY nome')).rows
      : (await q('SELECT id, nome, instancia_whatsapp, ativo FROM escritorios WHERE id = $1', [req.usuario.escritorio_id])).rows;
    res.json({ usuario: req.usuario, csrf: req.csrf, escritorios, escritorioId: req.escritorioId });
  }));

  // ---------------------------------------------------------------- visão geral
  app.get('/api/resumo', rota(async (req, res) => {
    const esc = escritorio(req);
    const [n, atencao, proximas, recentes] = await Promise.all([
      q(`SELECT
          (SELECT count(DISTINCT m.lead_id) FROM mensagens m JOIN leads l ON l.id = m.lead_id
            WHERE l.escritorio_id = $1 AND m.papel = 'cliente'
              AND m.criado_em >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')) AS conversas_hoje,
          (SELECT count(*) FROM leads WHERE escritorio_id = $1 AND criado_em > now() - interval '7 days') AS novos_7d,
          (SELECT count(*) FROM agendamentos WHERE escritorio_id = $1 AND status IN ('marcado','confirmado')
            AND inicio BETWEEN now() AND now() + interval '7 days') AS reunioes_semana,
          (SELECT count(*) FROM agendamentos WHERE escritorio_id = $1 AND status = 'confirmado'
            AND inicio BETWEEN now() AND now() + interval '7 days') AS confirmadas_semana,
          (SELECT count(*) FROM encaminhamentos WHERE escritorio_id = $1 AND resolvido_em IS NULL) AS encaminhados,
          (SELECT count(*) FROM encaminhamentos WHERE escritorio_id = $1 AND resolvido_em IS NULL AND urgencia = 'alta') AS urgentes,
          (SELECT count(*) FROM agendamentos WHERE escritorio_id = $1 AND criado_em > now() - interval '30 days') AS agendados_30d`, [esc]),
      q(`SELECT e.id, e.motivo, e.resumo, e.urgencia, e.criado_em, l.id AS lead_id, COALESCE(l.nome, l.nome_whatsapp, l.whatsapp) AS cliente,
                l.area, r.nome AS responsavel
         FROM encaminhamentos e JOIN leads l ON l.id = e.lead_id LEFT JOIN responsaveis r ON r.id = e.responsavel_id
         WHERE e.escritorio_id = $1 AND e.resolvido_em IS NULL
         ORDER BY (e.urgencia = 'alta') DESC, e.criado_em DESC LIMIT 10`, [esc]),
      q(`SELECT a.id, a.inicio, a.modalidade, a.status, a.area, COALESCE(l.nome, l.nome_whatsapp, l.whatsapp) AS cliente, l.id AS lead_id,
                r.nome AS responsavel
         FROM agendamentos a JOIN leads l ON l.id = a.lead_id LEFT JOIN responsaveis r ON r.id = a.responsavel_id
         WHERE a.escritorio_id = $1 AND a.status IN ('marcado','confirmado') AND a.fim > now()
         ORDER BY a.inicio LIMIT 8`, [esc]),
      q(`SELECT l.id, COALESCE(l.nome, l.nome_whatsapp, l.whatsapp) AS cliente, l.area, l.status, l.resumo_caso,
                (l.ia_pausada_ate > now()) AS ia_pausada, r.nome AS responsavel, um.criado_em AS ultima_em, um.conteudo AS ultima
         FROM leads l LEFT JOIN responsaveis r ON r.id = l.responsavel_id
         JOIN LATERAL (SELECT conteudo, criado_em FROM mensagens WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) um ON true
         WHERE l.escritorio_id = $1 ORDER BY um.criado_em DESC LIMIT 8`, [esc]),
    ]);
    res.json({ numeros: n.rows[0], atencao: atencao.rows, proximas: proximas.rows, recentes: recentes.rows });
  }));

  // ---------------------------------------------------------------- conversas
  app.get('/api/conversas', rota(async (req, res) => {
    const esc = escritorio(req);
    const busca = V.texto(req.query.q, 'a busca', { max: 100 });
    const status = STATUS_LEAD.includes(req.query.status) ? req.query.status : null;
    const filtroIa = req.query.ia === 'pausada' ? 'pausada' : null;
    const { rows } = await q(
      `SELECT l.id, l.whatsapp, COALESCE(l.nome, l.nome_whatsapp) AS nome, l.area, l.status, l.urgencia,
              (l.ia_pausada_ate > now()) AS ia_pausada, r.nome AS responsavel, um.criado_em AS ultima_em, um.conteudo AS ultima, um.papel AS ultima_papel
       FROM leads l LEFT JOIN responsaveis r ON r.id = l.responsavel_id
       JOIN LATERAL (SELECT conteudo, criado_em, papel FROM mensagens WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) um ON true
       WHERE l.escritorio_id = $1
         AND ($2::text IS NULL OR l.nome ILIKE '%' || $2 || '%' OR l.nome_whatsapp ILIKE '%' || $2 || '%' OR (regexp_replace($2, '\\D', '', 'g') <> '' AND l.whatsapp LIKE '%' || regexp_replace($2, '\\D', '', 'g') || '%'))
         AND ($3::text IS NULL OR l.status = $3)
         AND ($4::text IS NULL OR l.ia_pausada_ate > now())
       ORDER BY um.criado_em DESC LIMIT 200`, [esc, busca, status, filtroIa]);
    res.json(rows);
  }));

  app.get('/api/conversas/:id', rota(async (req, res) => {
    const lead = await leadDoEscritorio(req, req.params.id);
    const [msgs, ags, encs] = await Promise.all([
      q(`SELECT id, papel, conteudo, tipo, criado_em FROM (
           SELECT * FROM mensagens WHERE lead_id = $1 ORDER BY id DESC LIMIT 300) x ORDER BY id`, [lead.id]),
      q(`SELECT a.id, a.inicio, a.fim, a.modalidade, a.status, a.area, a.link_reuniao, r.nome AS responsavel
         FROM agendamentos a LEFT JOIN responsaveis r ON r.id = a.responsavel_id WHERE a.lead_id = $1 ORDER BY a.inicio DESC LIMIT 20`, [lead.id]),
      q(`SELECT e.id, e.motivo, e.resumo, e.urgencia, e.criado_em, e.resolvido_em, r.nome AS responsavel
         FROM encaminhamentos e LEFT JOIN responsaveis r ON r.id = e.responsavel_id WHERE e.lead_id = $1 ORDER BY e.criado_em DESC LIMIT 20`, [lead.id]),
    ]);
    res.json({
      lead: { ...lead, ia_pausada: !!lead.ia_pausada_ate && new Date(lead.ia_pausada_ate) > new Date() },
      mensagens: msgs.rows, agendamentos: ags.rows, encaminhamentos: encs.rows,
    });
  }));

  app.put('/api/conversas/:id', rota(async (req, res) => {
    const lead = await leadDoEscritorio(req, req.params.id);
    const b = req.body || {};
    const respId = V.uuidOuNulo(b.responsavel_id, 'responsável');
    if (respId) {
      const r = await q('SELECT 1 FROM responsaveis WHERE id = $1 AND escritorio_id = $2', [respId, lead.escritorio_id]);
      if (!r.rows[0]) throw erro(400, 'Responsável inválido.');
    }
    await q(`UPDATE leads SET nome = $2, email = $3, area = $4, resumo_caso = $5, status = $6, responsavel_id = $7,
               ja_e_cliente = $8, atualizado_em = now() WHERE id = $1`,
    [lead.id, V.texto(b.nome, 'o nome', { max: 120 }), V.email(b.email), V.texto(b.area, 'a área', { max: 40 })?.toLowerCase() ?? null,
      V.texto(b.resumo_caso, 'o resumo', { max: 2000 }), V.opcao(b.status, 'Situação', STATUS_LEAD), respId, V.bool(b.ja_e_cliente)]);
    await auditar(req, 'editou_cliente', { lead_id: lead.id });
    res.json({ ok: true });
  }));

  app.post('/api/conversas/:id/mensagem', rota(async (req, res) => {
    const lead = await leadDoEscritorio(req, req.params.id);
    const texto = V.texto(req.body?.texto, 'a mensagem', { max: 4000, obrigatorio: true });
    const { rows: [esc] } = await q('SELECT instancia_whatsapp, horas_pausa_ia FROM escritorios WHERE id = $1', [lead.escritorio_id]);
    const r = await evolution('POST', `/message/sendText/${encodeURIComponent(esc.instancia_whatsapp)}`, { number: lead.whatsapp, text: texto });
    if (!r.ok || !r.json?.key?.id) throw erro(502, 'O WhatsApp não aceitou a mensagem. Verifique se o número está conectado.');
    const cliente = await db.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query(`INSERT INTO mensagens (lead_id, papel, conteudo, wa_message_id) VALUES ($1, 'humano', $2, $3)
                           ON CONFLICT DO NOTHING`, [lead.id, texto, r.json.key.id]);
      // a IA passa a saber o que a equipe respondeu
      await cliente.query(`INSERT INTO n8n_chat_histories (session_id, message) VALUES ($1, $2)`,
        [lead.id, JSON.stringify({ type: 'ai', content: `[Mensagem enviada por ${req.usuario.nome}, da equipe do escritório] ${texto}`,
          tool_calls: [], additional_kwargs: {}, response_metadata: {}, invalid_tool_calls: [] })]);
      await cliente.query(`UPDATE leads SET ia_pausada_ate = now() + make_interval(hours => $2),
                             status = CASE WHEN status = 'novo' THEN 'em_triagem' ELSE status END, atualizado_em = now()
                           WHERE id = $1`, [lead.id, esc.horas_pausa_ia]);
      await cliente.query('COMMIT');
    } catch (e) { await cliente.query('ROLLBACK'); throw e; } finally { cliente.release(); }
    await auditar(req, 'enviou_mensagem', { lead_id: lead.id });
    res.json({ ok: true });
  }));

  app.post('/api/conversas/:id/ia', rota(async (req, res) => {
    const lead = await leadDoEscritorio(req, req.params.id);
    const ativar = V.bool(req.body?.ativa);
    if (ativar) {
      await q(`UPDATE leads SET ia_pausada_ate = NULL, status = CASE WHEN status = 'humano' THEN 'em_triagem' ELSE status END,
                 atualizado_em = now() WHERE id = $1`, [lead.id]);
      await q('UPDATE encaminhamentos SET resolvido_em = now() WHERE lead_id = $1 AND resolvido_em IS NULL', [lead.id]);
    } else {
      const horas = V.inteiro(req.body?.horas ?? 24, 'As horas', 1, 720);
      await q('UPDATE leads SET ia_pausada_ate = now() + make_interval(hours => $2), atualizado_em = now() WHERE id = $1', [lead.id, horas]);
    }
    await auditar(req, ativar ? 'reativou_ia' : 'pausou_ia', { lead_id: lead.id });
    res.json({ ok: true });
  }));

  app.post('/api/encaminhamentos/:id/resolver', rota(async (req, res) => {
    const { rows } = await q(`UPDATE encaminhamentos SET resolvido_em = now()
                              WHERE id = $1 AND escritorio_id = $2 AND resolvido_em IS NULL RETURNING lead_id`, [V.uuid(req.params.id), escritorio(req)]);
    if (!rows[0]) throw erro(404, 'Encaminhamento não encontrado ou já resolvido.');
    if (V.bool(req.body?.reativar_ia)) {
      await q(`UPDATE leads SET ia_pausada_ate = NULL, status = CASE WHEN status = 'humano' THEN 'em_triagem' ELSE status END
               WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM encaminhamentos WHERE lead_id = $1 AND resolvido_em IS NULL)`, [rows[0].lead_id]);
    }
    await auditar(req, 'resolveu_encaminhamento', { id: req.params.id });
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- agenda
  app.get('/api/agenda', rota(async (req, res) => {
    const esc = escritorio(req);
    const passadas = req.query.periodo === 'passadas';
    const resp = req.query.responsavel ? V.uuid(req.query.responsavel, 'responsável') : null;
    const { rows } = await q(
      `SELECT a.id, a.inicio, a.fim, a.modalidade, a.status, a.area, a.resumo, a.link_reuniao, a.google_event_id IS NOT NULL AS no_google,
              l.id AS lead_id, COALESCE(l.nome, l.nome_whatsapp) AS cliente, l.whatsapp, r.id AS responsavel_id, r.nome AS responsavel
       FROM agendamentos a JOIN leads l ON l.id = a.lead_id LEFT JOIN responsaveis r ON r.id = a.responsavel_id
       WHERE a.escritorio_id = $1 AND ($2::uuid IS NULL OR a.responsavel_id = $2)
         AND CASE WHEN $3 THEN a.fim < now() ELSE a.fim >= now() END
       ORDER BY CASE WHEN $3 THEN a.inicio END DESC, CASE WHEN NOT $3 THEN a.inicio END ASC LIMIT 300`, [esc, resp, passadas]);
    res.json(rows);
  }));

  app.post('/api/agenda/:id/status', rota(async (req, res) => {
    const status = V.opcao(req.body?.status, 'Situação', ['marcado', 'confirmado', 'realizado', 'faltou']);
    const { rows } = await q(`UPDATE agendamentos SET status = $3, atualizado_em = now()
                              WHERE id = $1 AND escritorio_id = $2 AND status <> 'cancelado' RETURNING lead_id`,
    [V.uuid(req.params.id), escritorio(req), status]);
    if (!rows[0]) throw erro(404, 'Reunião não encontrada.');
    if (status === 'realizado') await q(`UPDATE leads SET status = 'atendido' WHERE id = $1 AND status IN ('agendado','em_triagem','novo')`, [rows[0].lead_id]);
    await auditar(req, 'reuniao_' + status, { id: req.params.id });
    res.json({ ok: true });
  }));

  app.post('/api/agenda/:id/cancelar', rota(async (req, res) => {
    const esc = escritorio(req);
    const { rows } = await q(`SELECT id, lead_id, inicio FROM agendamentos WHERE id = $1 AND escritorio_id = $2 AND status IN ('marcado','confirmado')`,
      [V.uuid(req.params.id), esc]);
    const a = rows[0];
    if (!a) throw erro(404, 'Reunião não encontrada ou já cancelada.');
    if (new Date(a.inicio) <= new Date()) throw erro(400, 'Essa reunião já começou. Marque como realizada ou falta.');
    // o n8n cancela, apaga do Google Agenda e avisa o advogado
    const r = await acaoN8n({ acao: 'cancelar', escritorio_id: esc, lead_id: a.lead_id, agendamento_id: a.id });
    await auditar(req, 'cancelou_reuniao', { id: a.id });
    res.json({ ok: true, resposta: r.resposta || null });
  }));

  // ---------------------------------------------------------------- equipe
  app.get('/api/equipe', rota(async (req, res) => {
    const { rows } = await q(`SELECT r.*, (SELECT count(*) FROM agendamentos a WHERE a.responsavel_id = r.id AND a.status IN ('marcado','confirmado') AND a.fim > now()) AS reunioes_futuras
                              FROM responsaveis r WHERE r.escritorio_id = $1 ORDER BY r.ativo DESC, r.nome`, [escritorio(req)]);
    res.json(rows);
  }));

  function dadosResponsavel(b) {
    return [
      V.texto(b.nome, 'o nome', { max: 120, obrigatorio: true }),
      V.opcao(b.cargo, 'Cargo', CARGOS),
      V.whatsapp(b.whatsapp, 'o WhatsApp', true),
      V.email(b.email),
      V.areas(b.areas),
      V.email(b.google_calendar_id, 'a agenda Google'),
      V.bool(b.faz_reunioes), V.bool(b.recebe_urgencias), V.bool(b.padrao), V.bool(b.recebe_agenda_diaria), b.ativo === undefined ? true : V.bool(b.ativo),
    ];
  }

  async function salvarResponsavel(req, id) {
    exigeConfig(req);
    const esc = escritorio(req);
    const d = dadosResponsavel(req.body || {});
    const cliente = await db.connect();
    try {
      await cliente.query('BEGIN');
      if (d[8]) await cliente.query('UPDATE responsaveis SET padrao = false WHERE escritorio_id = $1', [esc]); // só um padrão
      let r;
      if (id) {
        r = await cliente.query(`UPDATE responsaveis SET nome=$3, cargo=$4, whatsapp=$5, email=$6, areas=$7, google_calendar_id=$8,
                 faz_reunioes=$9, recebe_urgencias=$10, padrao=$11, recebe_agenda_diaria=$12, ativo=$13
                 WHERE id = $1 AND escritorio_id = $2 RETURNING id`, [V.uuid(id), esc, ...d]);
        if (!r.rows[0]) throw erro(404, 'Pessoa não encontrada.');
      } else {
        r = await cliente.query(`INSERT INTO responsaveis (escritorio_id, nome, cargo, whatsapp, email, areas, google_calendar_id,
                 faz_reunioes, recebe_urgencias, padrao, recebe_agenda_diaria, ativo)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [esc, ...d]);
      }
      await cliente.query('COMMIT');
      await auditar(req, id ? 'editou_responsavel' : 'criou_responsavel', { id: r.rows[0].id, nome: d[0] });
      return r.rows[0].id;
    } catch (e) { await cliente.query('ROLLBACK'); throw e; } finally { cliente.release(); }
  }
  app.post('/api/equipe', rota(async (req, res) => res.json({ id: await salvarResponsavel(req, null) })));
  app.put('/api/equipe/:id', rota(async (req, res) => res.json({ id: await salvarResponsavel(req, req.params.id) })));

  // ---------------------------------------------------------------- configuração do escritório
  app.get('/api/escritorio', rota(async (req, res) => {
    const { rows } = await q('SELECT * FROM escritorios WHERE id = $1', [escritorio(req)]);
    res.json(rows[0]);
  }));

  app.put('/api/escritorio', rota(async (req, res) => {
    exigeConfig(req);
    const b = req.body || {};
    const tom = V.texto(b.tom_de_voz, 'o tom de voz', { max: 200 }) || TONS[0];
    await q(`UPDATE escritorios SET nome=$2, telefone=$3, endereco=$4, site=$5, areas_atuacao=$6, horario_atendimento=$7,
               duracao_reuniao_min=$8, intervalo_entre_reunioes_min=$9, antecedencia_minima_horas=$10, dias_para_frente=$11,
               google_calendar_id=$12, tom_de_voz=$13, valor_consulta=$14, instrucoes_extras=$15, horas_pausa_ia=$16,
               followup_ativo=$17, chatwoot_inbox_id=$18 WHERE id = $1`, [
      escritorio(req),
      V.texto(b.nome, 'o nome do escritório', { max: 150, obrigatorio: true }),
      V.texto(b.telefone, 'o telefone', { max: 40 }),
      V.texto(b.endereco, 'o endereço', { max: 300 }),
      V.texto(b.site, 'o site', { max: 200 }),
      V.areas(b.areas_atuacao),
      JSON.stringify(V.horario(b.horario_atendimento)),
      V.inteiro(b.duracao_reuniao_min, 'A duração', 15, 240),
      V.inteiro(b.intervalo_entre_reunioes_min, 'O intervalo', 0, 120),
      V.inteiro(b.antecedencia_minima_horas, 'A antecedência', 0, 168),
      V.inteiro(b.dias_para_frente, 'A janela de agendamento', 1, 90),
      V.email(b.google_calendar_id, 'a agenda Google'),
      tom,
      V.texto(b.valor_consulta, 'o valor da consulta', { max: 100 }),
      V.texto(b.instrucoes_extras, 'as instruções', { max: 3000 }),
      V.inteiro(b.horas_pausa_ia, 'A pausa da IA', 1, 168),
      V.bool(b.followup_ativo),
      b.chatwoot_inbox_id === '' || b.chatwoot_inbox_id == null ? null : V.inteiro(b.chatwoot_inbox_id, 'A caixa do Chatwoot', 1, 1e9),
    ]);
    await auditar(req, 'editou_configuracao');
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- perguntas frequentes
  app.get('/api/faq', rota(async (req, res) => {
    const { rows } = await q('SELECT id, pergunta, resposta, ativo FROM faq WHERE escritorio_id = $1 ORDER BY pergunta', [escritorio(req)]);
    res.json(rows);
  }));
  app.post('/api/faq', rota(async (req, res) => {
    exigeConfig(req);
    const { rows } = await q('INSERT INTO faq (escritorio_id, pergunta, resposta) VALUES ($1, $2, $3) RETURNING id', [
      escritorio(req), V.texto(req.body?.pergunta, 'a pergunta', { max: 300, obrigatorio: true }),
      V.texto(req.body?.resposta, 'a resposta', { max: 2000, obrigatorio: true })]);
    await auditar(req, 'criou_faq', { id: rows[0].id });
    res.json(rows[0]);
  }));
  app.put('/api/faq/:id', rota(async (req, res) => {
    exigeConfig(req);
    const { rowCount } = await q('UPDATE faq SET pergunta = $3, resposta = $4, ativo = $5 WHERE id = $1 AND escritorio_id = $2', [
      V.uuid(req.params.id), escritorio(req), V.texto(req.body?.pergunta, 'a pergunta', { max: 300, obrigatorio: true }),
      V.texto(req.body?.resposta, 'a resposta', { max: 2000, obrigatorio: true }), req.body?.ativo === undefined ? true : V.bool(req.body.ativo)]);
    if (!rowCount) throw erro(404, 'Pergunta não encontrada.');
    await auditar(req, 'editou_faq', { id: req.params.id });
    res.json({ ok: true });
  }));
  app.delete('/api/faq/:id', rota(async (req, res) => {
    exigeConfig(req);
    const { rowCount } = await q('DELETE FROM faq WHERE id = $1 AND escritorio_id = $2', [V.uuid(req.params.id), escritorio(req)]);
    if (!rowCount) throw erro(404, 'Pergunta não encontrada.');
    await auditar(req, 'apagou_faq', { id: req.params.id });
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- WhatsApp
  async function instancia(req) {
    const { rows } = await q('SELECT instancia_whatsapp FROM escritorios WHERE id = $1', [escritorio(req)]);
    return rows[0].instancia_whatsapp;
  }

  async function criarInstancia(nome) {
    return evolution('POST', '/instance/create', {
      instanceName: nome, integration: 'WHATSAPP-BAILEYS', qrcode: true, groupsIgnore: true, alwaysOnline: false, readMessages: false,
      webhook: { url: `${CFG.n8nUrl}/webhook/whatsapp`, byEvents: false, base64: true, events: ['MESSAGES_UPSERT'] },
    });
  }

  app.get('/api/whatsapp', rota(async (req, res) => {
    const inst = await instancia(req);
    const r = await evolution('GET', `/instance/connectionState/${encodeURIComponent(inst)}`);
    const estado = r.status === 404 ? 'inexistente' : (r.json?.instance?.state || r.json?.state || 'desconhecido');
    res.json({ instancia: inst, estado });
  }));

  app.post('/api/whatsapp/conectar', rota(async (req, res) => {
    exigeConfig(req);
    const inst = await instancia(req);
    let r = await evolution('GET', `/instance/connect/${encodeURIComponent(inst)}`);
    if (r.status === 404) { // instância ainda não existe: cria já ligada ao n8n
      const c = await criarInstancia(inst);
      if (!c.ok) throw erro(502, 'Não foi possível criar a conexão do WhatsApp.');
      r = { ok: true, json: c.json.qrcode || {} };
    }
    const qr = r.json?.base64 || r.json?.qrcode?.base64 || null;
    if (qr && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(qr)) throw erro(502, 'QR Code inválido recebido do WhatsApp.');
    await auditar(req, 'gerou_qrcode');
    res.json({ qrcode: qr, codigo: r.json?.pairingCode || null, estado: r.json?.instance?.state || null });
  }));

  app.post('/api/whatsapp/desconectar', rota(async (req, res) => {
    exigeConfig(req);
    const inst = await instancia(req);
    await evolution('DELETE', `/instance/logout/${encodeURIComponent(inst)}`);
    await auditar(req, 'desconectou_whatsapp');
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- usuários do painel
  app.get('/api/usuarios', rota(async (req, res) => {
    exigeConfig(req);
    const { rows } = await q(`SELECT id, nome, email, papel, ativo, trocar_senha, ultimo_login_em, criado_em
                              FROM painel_usuarios WHERE escritorio_id = $1 ORDER BY ativo DESC, nome`, [escritorio(req)]);
    res.json(rows);
  }));

  app.post('/api/usuarios', rota(async (req, res) => {
    exigeConfig(req);
    const esc = escritorio(req);
    const senha = S.senhaTemporaria();
    try {
      const { rows } = await q(`INSERT INTO painel_usuarios (escritorio_id, nome, email, senha_hash, papel) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
        esc, V.texto(req.body?.nome, 'o nome', { max: 120, obrigatorio: true }), V.email(req.body?.email, 'o e-mail', true),
        S.hashSenha(senha), V.opcao(req.body?.papel, 'Perfil', ['gestor', 'atendente'])]);
      await auditar(req, 'criou_usuario', { id: rows[0].id });
      res.json({ id: rows[0].id, senhaProvisoria: senha });
    } catch (e) {
      if (e.code === '23505') throw erro(400, 'Já existe um usuário com esse e-mail.');
      throw e;
    }
  }));

  app.put('/api/usuarios/:id', rota(async (req, res) => {
    exigeConfig(req);
    const id = V.uuid(req.params.id);
    if (id === req.usuario.id && req.body?.ativo === false) throw erro(400, 'Você não pode desativar o próprio usuário.');
    const { rowCount } = await q(`UPDATE painel_usuarios SET nome = $3, papel = $4, ativo = $5 WHERE id = $1 AND escritorio_id = $2`, [
      id, escritorio(req), V.texto(req.body?.nome, 'o nome', { max: 120, obrigatorio: true }),
      V.opcao(req.body?.papel, 'Perfil', ['gestor', 'atendente']), V.bool(req.body?.ativo)]);
    if (!rowCount) throw erro(404, 'Usuário não encontrado.');
    if (!V.bool(req.body?.ativo)) await q('DELETE FROM painel_sessoes WHERE usuario_id = $1', [id]);
    await auditar(req, 'editou_usuario', { id });
    res.json({ ok: true });
  }));

  app.post('/api/usuarios/:id/nova-senha', rota(async (req, res) => {
    exigeConfig(req);
    const id = V.uuid(req.params.id);
    const senha = S.senhaTemporaria();
    const { rowCount } = await q(`UPDATE painel_usuarios SET senha_hash = $3, trocar_senha = true WHERE id = $1 AND escritorio_id = $2`,
      [id, escritorio(req), S.hashSenha(senha)]);
    if (!rowCount) throw erro(404, 'Usuário não encontrado.');
    await q('DELETE FROM painel_sessoes WHERE usuario_id = $1', [id]);
    await auditar(req, 'redefiniu_senha', { id });
    res.json({ senhaProvisoria: senha });
  }));

  // ---------------------------------------------------------------- auditoria
  app.get('/api/auditoria', rota(async (req, res) => {
    exigeConfig(req);
    const { rows } = await q(`SELECT a.acao, a.detalhe, a.ip, a.criado_em, u.nome AS usuario FROM painel_auditoria a
                              LEFT JOIN painel_usuarios u ON u.id = a.usuario_id WHERE a.escritorio_id = $1
                              ORDER BY a.id DESC LIMIT 200`, [escritorio(req)]);
    res.json(rows);
  }));

  // ---------------------------------------------------------------- administração geral (você)
  app.get('/api/admin/escritorios', rota(async (req, res) => {
    exigeAdminGeral(req);
    const { rows } = await q(`SELECT e.id, e.nome, e.instancia_whatsapp, e.ativo, e.plano, e.criado_em,
        (SELECT count(*) FROM leads l WHERE l.escritorio_id = e.id AND l.criado_em > now() - interval '30 days') AS leads_30d,
        (SELECT count(*) FROM agendamentos a WHERE a.escritorio_id = e.id AND a.criado_em > now() - interval '30 days') AS reunioes_30d,
        (SELECT count(*) FROM painel_usuarios u WHERE u.escritorio_id = e.id AND u.ativo) AS usuarios
      FROM escritorios e ORDER BY e.nome`);
    res.json(rows);
  }));

  app.post('/api/admin/escritorios', rota(async (req, res) => {
    exigeAdminGeral(req);
    const nome = V.texto(req.body?.nome, 'o nome do escritório', { max: 150, obrigatorio: true });
    const inst = V.texto(req.body?.instancia, 'o identificador', { max: 40, obrigatorio: true }).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(inst)) throw erro(400, 'Identificador: só letras minúsculas, números e hífen (3 a 40).');
    const gestorEmail = V.email(req.body?.gestor_email, 'o e-mail do gestor', true);
    const gestorNome = V.texto(req.body?.gestor_nome, 'o nome do gestor', { max: 120, obrigatorio: true });
    const senha = S.senhaTemporaria();
    const cliente = await db.connect();
    let id;
    try {
      await cliente.query('BEGIN');
      ({ rows: [{ id }] } = await cliente.query('INSERT INTO escritorios (nome, instancia_whatsapp) VALUES ($1, $2) RETURNING id', [nome, inst]));
      await cliente.query(`INSERT INTO painel_usuarios (escritorio_id, nome, email, senha_hash, papel) VALUES ($1, $2, $3, $4, 'gestor')`,
        [id, gestorNome, gestorEmail, S.hashSenha(senha)]);
      await cliente.query(`UPDATE config_sistema SET valor = COALESCE(valor, $1) WHERE chave = 'instancia_alertas'`, [inst]);
      await cliente.query('COMMIT');
    } catch (e) {
      await cliente.query('ROLLBACK');
      if (e.code === '23505') throw erro(400, 'Já existe um escritório com esse identificador ou um usuário com esse e-mail.');
      throw e;
    } finally { cliente.release(); }
    const c = await criarInstancia(inst);
    await auditar(req, 'criou_escritorio', { id, inst }, id);
    res.json({ id, gestor: { email: gestorEmail, senhaProvisoria: senha }, whatsappCriado: c.ok });
  }));

  app.put('/api/admin/escritorios/:id', rota(async (req, res) => {
    exigeAdminGeral(req);
    const id = V.uuid(req.params.id);
    const ativo = V.bool(req.body?.ativo);
    const { rowCount } = await q('UPDATE escritorios SET ativo = $2 WHERE id = $1', [id, ativo]);
    if (!rowCount) throw erro(404, 'Escritório não encontrado.');
    if (!ativo) await q('DELETE FROM painel_sessoes s USING painel_usuarios u WHERE u.id = s.usuario_id AND u.escritorio_id = $1', [id]);
    await auditar(req, ativo ? 'ativou_escritorio' : 'desativou_escritorio', { id }, id);
    res.json({ ok: true });
  }));
};
