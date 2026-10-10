'use strict';
/* Painel do escritório: interface (sem frameworks). Todo texto vindo do servidor entra como texto, nunca como HTML. */

const TZ = 'America/Sao_Paulo';
const estado = { me: null, csrf: '', escritorioId: null, timer: null };
const app = document.getElementById('app');

// ---------------------------------------------------------------- utilidades
function h(tag, attrs, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // via CSSOM: permitido pela CSP (atributo style inline não é)
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const f of filhos.flat(Infinity)) {
    if (f === null || f === undefined || f === false) continue;
    el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return el;
}
const svg = (d) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', '18'); s.setAttribute('height', '18'); s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.append(p);
  return s;
};
const ICONES = {
  resumo: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  conversas: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  agenda: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 10h18M8 3v4M16 3v4',
  equipe: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M17.5 11.5a2.5 2.5 0 1 0 0-5M17 14.6c2.4.2 4 1.8 4.5 5.4',
  atendimento: 'M4 6h16M4 12h16M4 18h10M18 16v6M15 19h6',
  whatsapp: 'M5 4h14v16H5zM9 17h6',
  usuarios: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1',
  escritorios: 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6',
  menu: 'M4 6h16M4 12h16M4 18h16',
};

const fmt = {
  data: (iso) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' }).format(new Date(iso)),
  hora: (iso) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)),
  diaSemana: (iso) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'short', day: '2-digit' }).format(new Date(iso)).replace('.', ''),
  completo: (iso) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)),
  quando(iso) {
    if (!iso) return '';
    const d = new Date(iso), agora = new Date();
    const min = Math.round((agora - d) / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return `há ${min} min`;
    const mesmoDia = fmt.data(iso) === fmt.data(agora.toISOString());
    return mesmoDia ? fmt.hora(iso) : `${fmt.data(iso)} ${fmt.hora(iso)}`;
  },
  dataBloco(iso) {
    const hoje = fmt.data(new Date().toISOString());
    const amanha = fmt.data(new Date(Date.now() + 86400000).toISOString());
    const d = fmt.data(iso);
    return d === hoje ? 'Hoje' : d === amanha ? 'Amanhã' : fmt.diaSemana(iso);
  },
  fone(n) {
    const d = String(n || '').replace(/\D/g, '');
    if (d.startsWith('55') && d.length >= 12) { const r = d.slice(2); return `(${r.slice(0, 2)}) ${r.slice(2, -4)}-${r.slice(-4)}`; }
    return d ? '+' + d : '';
  },
  iniciais: (nome) => String(nome || '?').replace(/^(dra?\.|sr\.|sra\.)\s*/i, '').split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase(),
  cap: (s) => (s ? s[0].toUpperCase() + s.slice(1) : ''),
};

const STATUS_LEAD = {
  novo: ['Novo', 'azul'], em_triagem: ['Em triagem', 'azul'], agendado: ['Agendou', 'ok'], atendido: ['Atendido', 'neutro'],
  cliente: ['Cliente', 'ok'], perdido: ['Perdido', 'neutro'], humano: ['Com a equipe', 'alta'],
};
const STATUS_REUNIAO = {
  marcado: ['Aguardando confirmação', 'neutro'], confirmado: ['Confirmada', 'ok'], realizado: ['Realizada', 'azul'], faltou: ['Faltou', 'alta'], cancelado: ['Cancelada', 'neutro'],
};
const URGENCIA = { alta: ['Urgente', 'alta'], media: ['Média', 'media'], baixa: ['Baixa', 'neutro'] };
const CARGOS = { advogado: 'Advogado(a)', socio: 'Sócio(a)', secretaria: 'Secretária(o)', estagiario: 'Estagiário(a)', atendimento: 'Atendimento' };
const DIAS = [['seg', 'Segunda'], ['ter', 'Terça'], ['qua', 'Quarta'], ['qui', 'Quinta'], ['sex', 'Sexta'], ['sab', 'Sábado'], ['dom', 'Domingo']];
// *negrito* e _itálico_ do WhatsApp viram elementos, sem nunca interpretar HTML
function textoWhatsapp(t) {
  const partes = [];
  const re = /\*([^*\n]+)\*|_([^_\n]+)_/g;
  let i = 0, m;
  while ((m = re.exec(t))) {
    if (m.index > i) partes.push(t.slice(i, m.index));
    partes.push(m[1] !== undefined ? h('strong', {}, m[1]) : h('em', {}, m[2]));
    i = re.lastIndex;
  }
  if (i < t.length) partes.push(t.slice(i));
  return partes;
}
const chip = (par, extra) => h('span', { class: `chip ${par?.[1] || ''}` }, extra, par?.[0] || '');

function avisar(msg, tipo) {
  const el = h('div', { class: `aviso ${tipo || ''}` }, msg);
  document.getElementById('avisos').append(el);
  setTimeout(() => el.remove(), tipo === 'erro' ? 7000 : 4000);
}

async function api(metodo, url, corpo) {
  const headers = { 'x-csrf-token': estado.csrf };
  if (estado.escritorioId) headers['x-escritorio'] = estado.escritorioId;
  if (corpo !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(url, { method: metodo, headers, body: corpo !== undefined ? JSON.stringify(corpo) : undefined, credentials: 'same-origin' });
  const json = await r.json().catch(() => ({}));
  if (r.status === 401) { estado.me = null; telaLogin(); throw new Error(json.erro || 'Faça login.'); }
  if (r.status === 403 && json.trocarSenha) { telaTrocarSenha(true); throw new Error(json.erro); }
  if (!r.ok) throw new Error(json.erro || 'Algo deu errado.');
  return json;
}

// executa uma ação de botão com estado de carregando e aviso de erro
async function acao(botao, fn, sucesso) {
  if (botao) botao.disabled = true;
  try {
    const r = await fn();
    if (sucesso) avisar(sucesso);
    return r;
  } catch (e) {
    avisar(e.message, 'erro');
    return undefined;
  } finally { if (botao) botao.disabled = false; }
}

function dialogo(titulo, corpo, { textoOk = 'Salvar', aoConfirmar, perigo = false } = {}) {
  const erro = h('p', { class: 'erro-texto', role: 'alert' });
  const ok = h('button', { type: 'submit', class: perigo ? 'perigo' : 'primario' }, textoOk);
  const dlg = h('dialog', { 'aria-label': titulo },
    h('form', { method: 'dialog', novalidate: true },
      h('h2', {}, titulo), corpo, erro,
      h('div', { class: 'acoes', style: 'justify-content:flex-end' },
        h('button', { type: 'button', onclick: () => dlg.close() }, aoConfirmar ? 'Cancelar' : 'Fechar'),
        aoConfirmar ? ok : null)));
  dlg.querySelector('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!aoConfirmar) return dlg.close();
    ok.disabled = true; erro.textContent = '';
    try { const fechar = await aoConfirmar(); if (fechar !== false) dlg.close(); } catch (e) { erro.textContent = e.message; } finally { ok.disabled = false; }
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function mostrarSenha(titulo, email, senha) {
  dialogo(titulo, h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
    h('p', {}, 'Envie estes dados para a pessoa por um canal seguro. A senha só aparece agora e deve ser trocada no primeiro acesso.'),
    email ? h('p', {}, 'E-mail: ', h('strong', {}, email)) : null,
    h('div', { class: 'senha-mostrar' }, senha)));
}

const campo = (rotulo, input, ajuda) => h('label', { class: 'campo' }, rotulo, ajuda ? h('span', { class: 'ajuda' }, ajuda) : null, input);
const podeConfigurar = () => ['admin_geral', 'gestor'].includes(estado.me?.usuario.papel);

// ---------------------------------------------------------------- login e senha
function telaLogin() {
  clearInterval(estado.timer);
  const email = h('input', { type: 'email', name: 'email', autocomplete: 'username', required: true });
  const senha = h('input', { type: 'password', name: 'senha', autocomplete: 'current-password', required: true });
  const erro = h('p', { class: 'erro-texto', role: 'alert' });
  const botao = h('button', { type: 'submit', class: 'primario' }, 'Entrar');
  const form = h('form', { class: 'cartao', novalidate: true },
    h('div', { class: 'marca-login' }, h('img', { src: '/icone.svg', alt: '', width: 40, height: 40 }),
      h('div', {}, h('h1', { style: 'font-size:24px' }, 'Painel do Escritório'), h('p', { class: 'sub' }, 'Assistente jurídico 24h'))),
    campo('E-mail', email), campo('Senha', senha), erro, botao);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault(); botao.disabled = true; erro.textContent = '';
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.value, senha: senha.value }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.erro || 'Não foi possível entrar.');
      await iniciar();
    } catch (e) { erro.textContent = e.message; } finally { botao.disabled = false; }
  });
  app.replaceChildren(h('main', { class: 'login' }, form));
  email.focus();
}

function telaTrocarSenha(obrigatorio) {
  const atual = h('input', { type: 'password', autocomplete: 'current-password' });
  const nova = h('input', { type: 'password', autocomplete: 'new-password' });
  const repete = h('input', { type: 'password', autocomplete: 'new-password' });
  const conteudo = h('div', { style: 'display:flex;flex-direction:column;gap:14px' },
    obrigatorio ? h('p', {}, 'Por segurança, troque a senha provisória antes de continuar.') : null,
    campo(obrigatorio ? 'Senha provisória' : 'Senha atual', atual),
    campo('Nova senha', nova, 'Pelo menos 10 caracteres, com letras e números.'),
    campo('Repita a nova senha', repete));
  const dlg = dialogo('Trocar senha', conteudo, {
    textoOk: 'Trocar senha',
    aoConfirmar: async () => {
      if (nova.value !== repete.value) throw new Error('As senhas novas não são iguais.');
      await api('POST', '/api/minha-senha', { atual: atual.value, nova: nova.value });
      avisar('Senha alterada.');
      if (obrigatorio) await iniciar();
    },
  });
  if (obrigatorio) dlg.addEventListener('cancel', (e) => e.preventDefault());
}

// ---------------------------------------------------------------- estrutura
const ROTAS = [
  ['#/', 'Visão geral', 'resumo', telaResumo],
  ['#/conversas', 'Conversas', 'conversas', telaConversas],
  ['#/agenda', 'Agenda', 'agenda', telaAgenda],
  ['#/equipe', 'Equipe', 'equipe', telaEquipe],
  ['#/atendimento', 'Configurar atendimento', 'atendimento', telaAtendimento, true],
  ['#/whatsapp', 'WhatsApp', 'whatsapp', telaWhatsapp],
  ['#/usuarios', 'Usuários', 'usuarios', telaUsuarios, true],
  ['#/escritorios', 'Escritórios', 'escritorios', telaEscritorios, 'admin'],
];

function moldura(conteudo) {
  const me = estado.me;
  const esc = me.escritorios.find((e) => e.id === estado.escritorioId);
  const rotaAtual = location.hash.split('/').slice(0, 2).join('/') || '#/';
  const menu = h('aside', { class: 'menu' });
  const links = ROTAS.filter(([, , , , restrito]) => (restrito === 'admin' ? me.usuario.papel === 'admin_geral' : restrito ? podeConfigurar() : true))
    .filter(([hash]) => hash === '#/escritorios' || estado.escritorioId)
    .map(([hash, nome, icone]) => h('a', { href: hash, 'aria-current': (rotaAtual === hash || (hash === '#/' && rotaAtual === '#')) ? 'page' : null }, svg(ICONES[icone]), nome));
  const seletor = me.usuario.papel === 'admin_geral'
    ? h('select', { 'aria-label': 'Escritório', onchange: (e) => { estado.escritorioId = e.target.value || null; sessionStorage.setItem('escritorio', estado.escritorioId || ''); location.hash = estado.escritorioId ? '#/' : '#/escritorios'; rotear(); } },
      h('option', { value: '' }, 'Escolha um escritório…'),
      me.escritorios.map((e) => h('option', { value: e.id, selected: e.id === estado.escritorioId }, e.nome + (e.ativo ? '' : ' (inativo)'))))
    : null;
  menu.append(
    h('div', { class: 'menu-topo' },
      h('div', { class: 'marca' }, h('strong', {}, esc?.nome || 'Painel')),
      h('button', { class: 'btn-sair', 'aria-label': 'Abrir menu', 'aria-expanded': 'false', onclick: (e) => { menu.classList.toggle('aberto'); e.currentTarget.setAttribute('aria-expanded', menu.classList.contains('aberto')); } }, svg(ICONES.menu))),
    h('div', { class: 'marca' }, h('strong', {}, esc?.nome || 'Administração'), h('span', {}, 'Assistente virtual 24h')),
    h('nav', { 'aria-label': 'Menu principal' }, links),
    h('div', { class: 'rodape' },
      seletor,
      h('div', { class: 'usuario' }, h('strong', {}, me.usuario.nome), h('span', {}, { admin_geral: 'Administrador geral', gestor: 'Gestor', atendente: 'Atendente' }[me.usuario.papel]),
        h('button', { class: 'btn-sair', onclick: () => telaTrocarSenha(false) }, 'Trocar senha'),
        h('button', { class: 'btn-sair', onclick: async () => { await api('POST', '/api/logout', {}).catch(() => {}); telaLogin(); } }, 'Sair'))));
  menu.querySelectorAll('nav a').forEach((a) => a.addEventListener('click', () => menu.classList.remove('aberto')));
  app.replaceChildren(h('div', { class: 'shell' }, menu, h('main', { class: 'conteudo', id: 'principal' }, conteudo)));
}

function cabecalho(titulo, descricao, ...acoes) {
  return h('header', { class: 'cabecalho' },
    h('div', { class: 'titulos' }, h('h1', {}, titulo), descricao ? h('p', {}, descricao) : null),
    acoes.length ? h('div', { class: 'acoes' }, acoes) : null);
}

async function rotear() {
  clearInterval(estado.timer);
  if (!estado.me) return;
  const hash = location.hash || '#/';
  if (!estado.escritorioId && estado.me.usuario.papel === 'admin_geral' && !hash.startsWith('#/escritorios')) { location.hash = '#/escritorios'; return; }
  const [, base, id] = hash.split('/');
  const rota = ROTAS.find(([r]) => r === `#/${base || ''}`) || ROTAS[0];
  moldura(h('p', { class: 'carregando' }, 'Carregando…'));
  try {
    const conteudo = await rota[3](id);
    moldura(conteudo);
    document.title = `${rota[1]} · Painel do Escritório`;
  } catch (e) {
    if (estado.me) moldura(h('div', { class: 'cartao' }, h('h2', {}, 'Não foi possível carregar'), h('p', {}, e.message),
      h('div', {}, h('button', { onclick: rotear }, 'Tentar de novo'))));
  }
}
// atualiza a tela atual de tempos em tempos, sem perder o que está sendo digitado
function atualizarACada(seg, fn) { clearInterval(estado.timer); estado.timer = setInterval(fn, seg * 1000); }

// ---------------------------------------------------------------- visão geral
async function telaResumo() {
  const r = await api('GET', '/api/resumo');
  const n = r.numeros;
  atualizarACada(60, () => { if ((location.hash || '#/') === '#/' && !document.querySelector('dialog')) rotear(); });
  const kpi = (rotulo, valor, detalhe) => h('div', { class: 'cartao kpi' }, h('span', { class: 'rotulo' }, rotulo), h('span', { class: 'valor' }, valor), h('span', { class: 'detalhe' }, detalhe));
  return [
    cabecalho(`Olá, ${estado.me.usuario.nome.split(' ')[0]}`, new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, dateStyle: 'full' }).format(new Date())),
    h('section', { class: 'grade-kpi', 'aria-label': 'Resumo' },
      kpi('Conversas hoje', n.conversas_hoje, `${n.novos_7d} contatos novos em 7 dias`),
      kpi('Reuniões em 7 dias', n.reunioes_semana, `${n.confirmadas_semana} confirmadas pelo cliente`),
      kpi('Encaminhados à equipe', n.encaminhados, n.urgentes > 0 ? `${n.urgentes} com urgência alta` : 'nenhum urgente'),
      kpi('Reuniões agendadas', n.agendados_30d, 'pela assistente, últimos 30 dias')),
    h('div', { class: 'colunas' },
      h('section', { class: 'cartao', 'aria-labelledby': 'tit-atencao' },
        h('div', { class: 'cartao-topo' }, h('h2', { id: 'tit-atencao' }, 'Precisa de atenção'), r.atencao.length ? chip([`${r.atencao.length} encaminhado(s)`, 'alta']) : null),
        r.atencao.length ? r.atencao.map((e) => h('div', { class: 'item' },
          h('div', { class: 'cartao-topo' },
            h('div', { class: 'cresce' }, h('strong', {}, e.cliente), h('span', { class: 'sub' }, `${fmt.cap(e.area || 'área não informada')} · para ${e.responsavel || 'a equipe'} · ${fmt.quando(e.criado_em)}`)),
            chip(URGENCIA[e.urgencia] || URGENCIA.media)),
          h('p', {}, e.resumo || e.motivo),
          h('div', { class: 'acoes' },
            h('a', { class: 'botao', href: `#/conversas/${e.lead_id}` }, 'Abrir conversa'),
            h('button', { onclick: async (ev) => { if (await acao(ev.currentTarget, () => api('POST', `/api/encaminhamentos/${e.id}/resolver`, { reativar_ia: true }), 'Resolvido. A assistente voltou a atender esse cliente.') !== undefined) rotear(); } }, 'Resolvido, reativar a IA'))))
          : h('p', { class: 'vazio' }, 'Nada pendente. A assistente está dando conta.')),
      h('section', { class: 'cartao', 'aria-labelledby': 'tit-reunioes' },
        h('div', { class: 'cartao-topo' }, h('h2', { id: 'tit-reunioes' }, 'Próximas reuniões'), h('a', { href: '#/agenda' }, 'Ver agenda')),
        r.proximas.length ? r.proximas.map(listaReuniao) : h('p', { class: 'vazio' }, 'Nenhuma reunião marcada.'))),
    h('section', { class: 'cartao', 'aria-labelledby': 'tit-recentes' },
      h('div', { class: 'cartao-topo' }, h('h2', { id: 'tit-recentes' }, 'Conversas recentes'), h('a', { href: '#/conversas' }, 'Ver todas')),
      tabelaConversas(r.recentes.map((c) => ({ ...c, nome: c.cliente })))),
  ];
}

function listaReuniao(a) {
  return h('div', { class: 'linha-item' },
    h('div', { class: 'data-bloco' }, h('span', {}, fmt.dataBloco(a.inicio)), h('strong', {}, fmt.hora(a.inicio))),
    h('div', { class: 'cresce' }, h('a', { href: `#/conversas/${a.lead_id}` }, h('strong', {}, a.cliente || 'Cliente')),
      h('span', { class: 'sub' }, [fmt.cap(a.area), a.responsavel, a.modalidade].filter(Boolean).join(' · '))),
    chip(STATUS_REUNIAO[a.status]));
}

function tabelaConversas(lista) {
  if (!lista.length) return h('p', { class: 'vazio' }, 'Nenhuma conversa encontrada.');
  return h('div', { class: 'tabela-caixa' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Cliente', 'Assunto', 'Situação', 'Quem atende', 'Última mensagem'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, lista.map((c) => {
      const tr = h('tr', { class: 'clicavel', onclick: () => { location.hash = `#/conversas/${c.id}`; } },
        h('td', {}, h('a', { href: `#/conversas/${c.id}`, onclick: (e) => e.stopPropagation() }, h('strong', {}, c.nome || fmt.fone(c.whatsapp) || 'Cliente'))),
        h('td', {}, fmt.cap(c.area) || '—'),
        h('td', {}, chip(STATUS_LEAD[c.status]), ' ', c.ia_pausada ? chip(['IA pausada', 'media']) : null),
        h('td', {}, c.ia_pausada || c.status === 'humano' ? (c.responsavel || 'Equipe') : 'Assistente'),
        h('td', { class: 'sub' }, h('div', { class: 'recorte', style: 'max-width:260px' }, c.ultima || ''), fmt.quando(c.ultima_em)));
      return tr;
    }))));
}

// ---------------------------------------------------------------- conversas
async function telaConversas(id) {
  if (id) return telaConversa(id);
  const params = new URLSearchParams(sessionStorage.getItem('filtroConversas') || '');
  const busca = h('input', { type: 'search', placeholder: 'Buscar por nome ou telefone', value: params.get('q') || '', 'aria-label': 'Buscar' });
  const status = h('select', { 'aria-label': 'Situação' }, h('option', { value: '' }, 'Todas as situações'),
    Object.entries(STATUS_LEAD).map(([k, [nome]]) => h('option', { value: k, selected: params.get('status') === k }, nome)));
  const ia = h('select', { 'aria-label': 'IA' }, h('option', { value: '' }, 'IA ativa ou pausada'), h('option', { value: 'pausada', selected: params.get('ia') === 'pausada' }, 'Só com IA pausada'));
  const lista = h('div', {});
  async function carregar() {
    const p = new URLSearchParams();
    if (busca.value.trim()) p.set('q', busca.value.trim());
    if (status.value) p.set('status', status.value);
    if (ia.value) p.set('ia', ia.value);
    sessionStorage.setItem('filtroConversas', p.toString());
    const dados = await api('GET', '/api/conversas?' + p.toString()).catch((e) => { avisar(e.message, 'erro'); return null; });
    if (dados) lista.replaceChildren(tabelaConversas(dados));
  }
  let espera;
  busca.addEventListener('input', () => { clearTimeout(espera); espera = setTimeout(carregar, 350); });
  status.addEventListener('change', carregar); ia.addEventListener('change', carregar);
  await carregar();
  atualizarACada(30, () => { if (location.hash === '#/conversas' && document.activeElement !== busca) carregar(); });
  return [cabecalho('Conversas', 'Todas as pessoas que falaram com o escritório pelo WhatsApp.'),
    h('div', { class: 'cartao' }, h('div', { class: 'filtros' }, busca, status, ia), lista)];
}

async function telaConversa(id) {
  const [d, equipe] = await Promise.all([api('GET', `/api/conversas/${id}`), api('GET', '/api/equipe')]);
  const l = d.lead;
  const nome = l.nome || l.nome_whatsapp || fmt.fone(l.whatsapp);
  const caixa = h('div', { class: 'mensagens', role: 'log', 'aria-label': 'Mensagens' });
  let ultimoId = 0;
  function desenharMensagens(msgs) {
    const noFim = caixa.scrollHeight - caixa.scrollTop - caixa.clientHeight < 80;
    const ultimo = msgs.at(-1)?.id || 0;
    if (ultimo === ultimoId) return;
    ultimoId = ultimo;
    const quem = { cliente: nome, assistente: 'Assistente virtual', humano: 'Equipe', sistema: 'Sistema' };
    caixa.replaceChildren(...(msgs.length ? msgs.map((m) => h('div', { class: `msg ${m.papel}` }, h('span', {}, textoWhatsapp(m.conteudo)), h('span', { class: 'meta' }, `${quem[m.papel]} · ${fmt.quando(m.criado_em)}`)))
      : [h('p', { class: 'vazio' }, 'Sem mensagens.')]));
    if (noFim || caixa.dataset.primeira !== '0') { caixa.scrollTop = caixa.scrollHeight; caixa.dataset.primeira = '0'; }
  }
  desenharMensagens(d.mensagens);

  const avisoIa = h('div', { class: `aviso-ia ${l.ia_pausada ? 'pausada' : 'ativa'}` },
    h('span', {}, l.ia_pausada ? `Assistente pausada nesta conversa até ${fmt.completo(l.ia_pausada_ate)}. A equipe está atendendo.` : 'A assistente virtual está respondendo esta conversa.'),
    l.ia_pausada
      ? h('button', { class: 'pequeno', onclick: async (e) => { if (await acao(e.currentTarget, () => api('POST', `/api/conversas/${id}/ia`, { ativa: true }), 'A assistente voltou a atender.') !== undefined) rotear(); } }, 'Reativar assistente')
      : h('button', { class: 'pequeno', onclick: async (e) => { if (await acao(e.currentTarget, () => api('POST', `/api/conversas/${id}/ia`, { ativa: false, horas: 24 }), 'Assistente pausada por 24 horas.') !== undefined) rotear(); } }, 'Pausar e assumir'));

  const texto = h('textarea', { placeholder: 'Escreva uma resposta. Ela sai pelo WhatsApp do escritório e pausa a assistente.', 'aria-label': 'Resposta', rows: 2 });
  const enviar = h('button', { class: 'primario', type: 'submit' }, 'Enviar');
  const formResp = h('form', { class: 'responder' }, texto, enviar);
  formResp.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!texto.value.trim()) return;
    if (await acao(enviar, () => api('POST', `/api/conversas/${id}/mensagem`, { texto: texto.value }), 'Mensagem enviada.') !== undefined) { texto.value = ''; rotear(); }
  });
  texto.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) formResp.requestSubmit(); });

  atualizarACada(10, async () => {
    if (!location.hash.startsWith(`#/conversas/${id}`)) return;
    const novo = await api('GET', `/api/conversas/${id}`).catch(() => null);
    if (novo) desenharMensagens(novo.mensagens);
  });

  // dados do cliente
  const f = {
    nome: h('input', { type: 'text', value: l.nome || '' }),
    email: h('input', { type: 'email', value: l.email || '' }),
    area: h('input', { type: 'text', value: l.area || '' }),
    status: h('select', {}, Object.entries(STATUS_LEAD).map(([k, [n]]) => h('option', { value: k, selected: l.status === k }, n))),
    responsavel: h('select', {}, h('option', { value: '' }, 'Ninguém ainda'), equipe.filter((r) => r.ativo).map((r) => h('option', { value: r.id, selected: l.responsavel_id === r.id }, r.nome))),
    resumo: h('textarea', {}, l.resumo_caso || ''),
    cliente: h('input', { type: 'checkbox', checked: l.ja_e_cliente }),
  };
  const salvar = h('button', { class: 'primario', type: 'submit' }, 'Salvar dados');
  const formDados = h('form', { class: 'cartao' }, h('h2', {}, 'Dados do cliente'),
    h('p', { class: 'sub' }, `WhatsApp ${fmt.fone(l.whatsapp)} · `, h('a', { href: `https://wa.me/${l.whatsapp}`, target: '_blank', rel: 'noopener noreferrer' }, 'abrir no WhatsApp')),
    l.consentimento_lgpd_em ? h('p', { class: 'sub' }, `Consentimento LGPD em ${fmt.data(l.consentimento_lgpd_em)}`) : h('p', { class: 'sub' }, 'Consentimento LGPD ainda não registrado'),
    campo('Nome', f.nome), campo('E-mail', f.email), campo('Área do caso', f.area), campo('Situação', f.status), campo('Advogado(a) responsável', f.responsavel),
    campo('Resumo do caso', f.resumo), h('label', { class: 'checar' }, f.cliente, 'Já é cliente do escritório'), salvar);
  formDados.addEventListener('submit', (ev) => {
    ev.preventDefault();
    acao(salvar, () => api('PUT', `/api/conversas/${id}`, { nome: f.nome.value, email: f.email.value, area: f.area.value, status: f.status.value,
      responsavel_id: f.responsavel.value || null, resumo_caso: f.resumo.value, ja_e_cliente: f.cliente.checked }), 'Dados salvos.');
  });

  const reunioes = h('section', { class: 'cartao' }, h('h2', {}, 'Reuniões'),
    d.agendamentos.length ? d.agendamentos.map((a) => h('div', { class: 'linha-item' },
      h('div', { class: 'data-bloco' }, h('span', {}, fmt.data(a.inicio)), h('strong', {}, fmt.hora(a.inicio))),
      h('div', { class: 'cresce' }, h('span', {}, [a.responsavel, a.modalidade].filter(Boolean).join(' · ')), a.link_reuniao ? h('a', { href: a.link_reuniao, target: '_blank', rel: 'noopener noreferrer', class: 'sub' }, 'link da reunião') : null),
      chip(STATUS_REUNIAO[a.status]))) : h('p', { class: 'vazio' }, 'Nenhuma reunião.'));
  const encs = d.encaminhamentos.filter((e) => !e.resolvido_em);

  return [
    cabecalho(nome, [fmt.cap(l.area), STATUS_LEAD[l.status]?.[0]].filter(Boolean).join(' · '), h('a', { class: 'botao', href: '#/conversas' }, '← Voltar')),
    h('div', { class: 'conversa' },
      h('section', { class: 'cartao chat', 'aria-label': 'Conversa' }, avisoIa, caixa, formResp),
      h('div', { class: 'lateral' },
        encs.length ? h('section', { class: 'cartao' }, h('h2', {}, 'Encaminhamento em aberto'), encs.map((e) => h('div', { class: 'item' },
          h('div', { class: 'cartao-topo' }, h('strong', {}, e.responsavel || 'Equipe'), chip(URGENCIA[e.urgencia])),
          h('p', {}, e.motivo), e.resumo ? h('p', { class: 'sub' }, e.resumo) : null,
          h('button', { onclick: async (ev) => { if (await acao(ev.currentTarget, () => api('POST', `/api/encaminhamentos/${e.id}/resolver`, { reativar_ia: true }), 'Resolvido.') !== undefined) rotear(); } }, 'Marcar como resolvido')))) : null,
        reunioes, formDados)),
  ];
}

// ---------------------------------------------------------------- agenda
async function telaAgenda() {
  const filtro = new URLSearchParams(sessionStorage.getItem('filtroAgenda') || '');
  const equipe = await api('GET', '/api/equipe');
  const periodo = h('div', { class: 'abas', role: 'group', 'aria-label': 'Período' });
  const resp = h('select', { 'aria-label': 'Advogado(a)' }, h('option', { value: '' }, 'Todos os advogados'),
    equipe.filter((r) => r.faz_reunioes).map((r) => h('option', { value: r.id, selected: filtro.get('responsavel') === r.id }, r.nome)));
  const lista = h('div', {});
  let per = filtro.get('periodo') || 'proximas';
  function abas() {
    periodo.replaceChildren(...[['proximas', 'Próximas'], ['passadas', 'Anteriores']].map(([k, n]) =>
      h('button', { class: 'pequeno', 'aria-pressed': String(per === k), onclick: () => { per = k; abas(); carregar(); } }, n)));
  }
  async function carregar() {
    const p = new URLSearchParams({ periodo: per });
    if (resp.value) p.set('responsavel', resp.value);
    sessionStorage.setItem('filtroAgenda', p.toString());
    const dados = await api('GET', '/api/agenda?' + p).catch((e) => { avisar(e.message, 'erro'); return null; });
    if (!dados) return;
    if (!dados.length) return lista.replaceChildren(h('p', { class: 'vazio' }, 'Nenhuma reunião neste período.'));
    const grupos = {};
    for (const a of dados) (grupos[fmt.completo(a.inicio).split(',')[0] + ', ' + fmt.data(a.inicio)] ||= []).push(a);
    lista.replaceChildren(...Object.entries(grupos).map(([dia, itens]) => h('section', { class: 'cartao' }, h('h2', {}, fmt.cap(dia)),
      itens.map((a) => h('div', { class: 'linha-item', style: 'flex-wrap:wrap' },
        h('div', { class: 'data-bloco' }, h('span', {}, fmt.hora(a.inicio)), h('strong', {}, fmt.hora(a.fim))),
        h('div', { class: 'cresce', style: 'flex-basis:220px' },
          h('a', { href: `#/conversas/${a.lead_id}` }, h('strong', {}, a.cliente || fmt.fone(a.whatsapp))),
          h('span', { class: 'sub' }, [a.responsavel, a.modalidade, fmt.cap(a.area)].filter(Boolean).join(' · ')),
          a.resumo ? h('span', { class: 'sub recorte' }, a.resumo) : null,
          a.link_reuniao ? h('a', { href: a.link_reuniao, target: '_blank', rel: 'noopener noreferrer', class: 'sub' }, 'Link da reunião') : null),
        chip(STATUS_REUNIAO[a.status]),
        h('div', { class: 'acoes' }, botoesReuniao(a, carregar)))))));
  }
  resp.addEventListener('change', carregar);
  abas(); await carregar();
  atualizarACada(60, () => { if (location.hash === '#/agenda' && !document.querySelector('dialog')) carregar(); });
  return [cabecalho('Agenda', 'Reuniões marcadas pela assistente e pela equipe.'), h('div', { class: 'filtros' }, periodo, resp), lista];
}

function botoesReuniao(a, recarregar) {
  if (a.status === 'cancelado') return [];
  const status = async (btn, s, msg) => { if (await acao(btn, () => api('POST', `/api/agenda/${a.id}/status`, { status: s }), msg) !== undefined) recarregar(); };
  const futura = new Date(a.inicio) > new Date();
  return [
    futura && a.status === 'marcado' ? h('button', { class: 'pequeno', onclick: (e) => status(e.currentTarget, 'confirmado', 'Reunião confirmada.') }, 'Confirmar') : null,
    !futura && ['marcado', 'confirmado'].includes(a.status) ? h('button', { class: 'pequeno', onclick: (e) => status(e.currentTarget, 'realizado', 'Marcada como realizada.') }, 'Realizada') : null,
    !futura && ['marcado', 'confirmado'].includes(a.status) ? h('button', { class: 'pequeno', onclick: (e) => status(e.currentTarget, 'faltou', 'Marcada como falta.') }, 'Faltou') : null,
    futura ? h('button', { class: 'pequeno perigo', onclick: () => dialogo('Cancelar reunião?', h('p', {},
      `A reunião de ${fmt.completo(a.inicio)} com ${a.cliente || 'o cliente'} será cancelada, removida do Google Agenda e o advogado será avisado. O cliente não recebe mensagem automática; avise-o pela conversa.`),
    { textoOk: 'Cancelar reunião', perigo: true, aoConfirmar: async () => { await api('POST', `/api/agenda/${a.id}/cancelar`, {}); avisar('Reunião cancelada.'); recarregar(); } }) }, 'Cancelar') : null,
  ];
}

// ---------------------------------------------------------------- equipe
async function telaEquipe() {
  const equipe = await api('GET', '/api/equipe');
  const sim = (v) => chip(v ? ['Sim', 'ok'] : ['Não', 'neutro']);
  return [
    cabecalho('Equipe e responsáveis', 'Quem recebe cada atendimento. A assistente escolhe pela área do caso e pela urgência e manda o resumo e o contato do cliente no WhatsApp da pessoa.',
      podeConfigurar() ? h('button', { class: 'primario', onclick: () => formPessoa(null) }, '+ Adicionar pessoa') : null),
    equipe.length ? h('section', { class: 'grade-cartoes', 'aria-label': 'Pessoas' }, equipe.map((p) => h('article', { class: 'cartao', style: p.ativo ? '' : 'opacity:.6' },
      h('div', { style: 'display:flex;gap:12px;align-items:center' }, h('div', { class: 'avatar', 'aria-hidden': 'true' }, fmt.iniciais(p.nome)),
        h('div', { class: 'cresce' }, h('h3', {}, p.nome), h('span', { class: 'sub' }, `${CARGOS[p.cargo]} · ${fmt.fone(p.whatsapp)}`)), p.ativo ? null : chip(['Inativo', 'neutro'])),
      h('div', { class: 'etiquetas' }, (p.areas.length ? p.areas : ['todas as áreas']).map((a) => h('span', { class: 'etiqueta' }, fmt.cap(a)))),
      h('div', { class: 'opcoes-lista' },
        h('div', {}, 'Faz reuniões', sim(p.faz_reunioes)), h('div', {}, 'Recebe urgências', sim(p.recebe_urgencias)),
        h('div', {}, 'Responsável padrão', sim(p.padrao)), h('div', {}, 'Agenda do dia às 7h', sim(p.recebe_agenda_diaria)),
        h('div', {}, 'Google Agenda', p.google_calendar_id ? chip(['Configurado', 'ok']) : chip(['Não', 'neutro'])),
        h('div', {}, 'Reuniões futuras', h('strong', {}, p.reunioes_futuras))),
      podeConfigurar() ? h('div', {}, h('button', { onclick: () => formPessoa(p) }, 'Editar')) : null)))
      : h('div', { class: 'cartao' }, h('p', {}, 'Ninguém cadastrado ainda. Adicione os advogados para a assistente conseguir agendar e encaminhar.')),
    h('section', { class: 'cartao' }, h('h2', {}, 'Como a assistente escolhe quem atende'),
      h('ol', { style: 'margin:0;padding-left:22px;display:flex;flex-direction:column;gap:6px' },
        h('li', {}, 'Quem já acompanha o cliente, se atende a área do novo assunto.'),
        h('li', {}, 'Em caso urgente (audiência, prisão, prazo em 48h), quem recebe urgências.'),
        h('li', {}, 'Quem atende a área do caso, dividindo os atendimentos de forma equilibrada.'),
        h('li', {}, 'O responsável padrão do escritório.'))),
  ];
}

function formPessoa(p) {
  const v = p || { cargo: 'advogado', areas: [], faz_reunioes: true, recebe_agenda_diaria: true, ativo: true };
  const f = {
    nome: h('input', { type: 'text', value: v.nome || '', required: true, placeholder: 'Ex.: Dra. Ana Souza' }),
    cargo: h('select', {}, Object.entries(CARGOS).map(([k, n]) => h('option', { value: k, selected: v.cargo === k }, n))),
    whatsapp: h('input', { type: 'tel', value: v.whatsapp ? fmt.fone(v.whatsapp) : '', placeholder: '(11) 99999-0000' }),
    email: h('input', { type: 'email', value: v.email || '' }),
    areas: h('input', { type: 'text', value: (v.areas || []).join(', '), placeholder: 'trabalhista, familia' }),
    agenda: h('input', { type: 'email', value: v.google_calendar_id || '', placeholder: 'ana@escritorio.com.br' }),
    reunioes: h('input', { type: 'checkbox', checked: v.faz_reunioes }),
    urgencias: h('input', { type: 'checkbox', checked: v.recebe_urgencias }),
    padrao: h('input', { type: 'checkbox', checked: v.padrao }),
    diaria: h('input', { type: 'checkbox', checked: v.recebe_agenda_diaria }),
    ativo: h('input', { type: 'checkbox', checked: v.ativo }),
  };
  dialogo(p ? `Editar ${p.nome}` : 'Adicionar pessoa', h('div', { style: 'display:flex;flex-direction:column;gap:14px' },
    h('div', { class: 'form-grade' }, campo('Nome', f.nome), campo('Cargo', f.cargo), campo('WhatsApp', f.whatsapp, 'Recebe os encaminhamentos e a agenda.'), campo('E-mail', f.email, 'Recebe o convite das reuniões.')),
    campo('Áreas que atende', f.areas, 'Separe por vírgula. Vazio = todas as áreas.'),
    campo('Agenda do Google (opcional)', f.agenda, 'O e-mail da agenda dessa pessoa. Vazio = usa a agenda do escritório.'),
    h('div', { class: 'form-grade' },
      h('label', { class: 'checar' }, f.reunioes, 'Faz reuniões com clientes'), h('label', { class: 'checar' }, f.urgencias, 'Recebe casos urgentes'),
      h('label', { class: 'checar' }, f.padrao, 'Responsável padrão'), h('label', { class: 'checar' }, f.diaria, 'Recebe a agenda do dia às 7h'),
      h('label', { class: 'checar' }, f.ativo, 'Ativo'))), {
    aoConfirmar: async () => {
      const corpo = { nome: f.nome.value, cargo: f.cargo.value, whatsapp: f.whatsapp.value, email: f.email.value, areas: f.areas.value,
        google_calendar_id: f.agenda.value, faz_reunioes: f.reunioes.checked, recebe_urgencias: f.urgencias.checked, padrao: f.padrao.checked,
        recebe_agenda_diaria: f.diaria.checked, ativo: f.ativo.checked };
      await api(p ? 'PUT' : 'POST', p ? `/api/equipe/${p.id}` : '/api/equipe', corpo);
      avisar('Equipe atualizada.'); rotear();
    },
  });
}

// ---------------------------------------------------------------- configurar atendimento
async function telaAtendimento() {
  const [e, faq] = await Promise.all([api('GET', '/api/escritorio'), api('GET', '/api/faq')]);
  const pode = podeConfigurar();
  const num = (valor, min, max) => h('input', { type: 'number', value: valor, min, max, inputmode: 'numeric' });
  const f = {
    nome: h('input', { type: 'text', value: e.nome }), telefone: h('input', { type: 'tel', value: e.telefone || '' }),
    endereco: h('input', { type: 'text', value: e.endereco || '' }), site: h('input', { type: 'text', value: e.site || '' }),
    areas: h('input', { type: 'text', value: (e.areas_atuacao || []).join(', ') }),
    duracao: num(e.duracao_reuniao_min, 15, 240), intervalo: num(e.intervalo_entre_reunioes_min, 0, 120),
    antecedencia: num(e.antecedencia_minima_horas, 0, 168), dias: num(e.dias_para_frente, 1, 90), pausa: num(e.horas_pausa_ia, 1, 168),
    tom: h('select', {}, ['formal, cordial e objetivo', 'próximo e acolhedor, sem perder a formalidade', 'direto e objetivo'].map((t) => h('option', { value: t, selected: e.tom_de_voz === t }, fmt.cap(t)))),
    valor: h('input', { type: 'text', value: e.valor_consulta || '', placeholder: 'Ex.: R$ 300,00' }),
    instrucoes: h('textarea', { rows: 4 }, e.instrucoes_extras || ''),
    agenda: h('input', { type: 'email', value: e.google_calendar_id || '', placeholder: 'agenda@escritorio.com.br' }),
    followup: h('input', { type: 'checkbox', checked: e.followup_ativo }),
    chatwoot: h('input', { type: 'number', value: e.chatwoot_inbox_id ?? '', min: 1 }),
  };
  if (!f.tom.querySelector('[selected]') && e.tom_de_voz) f.tom.prepend(h('option', { value: e.tom_de_voz, selected: true }, e.tom_de_voz));

  // horários: até 2 intervalos por dia
  const horario = e.horario_atendimento || {};
  const linhasDias = DIAS.map(([k, nome]) => {
    let faixas = horario[k] || [];
    if (faixas.length && !Array.isArray(faixas[0])) faixas = [faixas]; // formato antigo: ["09:00","18:00"]
    const aberto = h('input', { type: 'checkbox', checked: faixas.length > 0 });
    const ini1 = h('input', { type: 'time', value: faixas[0]?.[0] || '09:00', 'aria-label': `${nome} início` });
    const fim1 = h('input', { type: 'time', value: faixas[0]?.[1] || '12:00', 'aria-label': `${nome} fim` });
    const ini2 = h('input', { type: 'time', value: faixas[1]?.[0] || '', 'aria-label': `${nome} início da tarde` });
    const fim2 = h('input', { type: 'time', value: faixas[1]?.[1] || '', 'aria-label': `${nome} fim da tarde` });
    const ler = () => (!aberto.checked ? [] : [[ini1.value, fim1.value], [ini2.value, fim2.value]].filter(([a, b]) => a && b));
    return { k, ler, el: h('div', { class: 'dia-linha' }, h('label', { class: 'checar nome-dia' }, aberto, nome),
      h('div', { class: 'faixa' }, ini1, 'às', fim1), h('div', { class: 'faixa' }, 'e', ini2, 'às', fim2)) };
  });

  const salvar = h('button', { class: 'primario', type: 'submit', disabled: !pode }, 'Salvar alterações');
  const form = h('form', { style: 'display:flex;flex-direction:column;gap:20px' },
    h('div', { class: 'colunas' },
      h('section', { class: 'cartao' }, h('h2', {}, 'Escritório'),
        h('div', { class: 'form-grade' }, campo('Nome', f.nome), campo('Telefone', f.telefone)),
        campo('Endereço', f.endereco), campo('Site', f.site),
        campo('Áreas de atuação', f.areas, 'Separe por vírgula. Ex.: trabalhista, familia, previdenciario'),
        campo('Instruções extras para a assistente', f.instrucoes, 'Ex.: "Atendemos todo o Brasil online." Nunca coloque aqui orientações jurídicas.')),
      h('section', { class: 'cartao' }, h('h2', {}, 'Horário de reuniões'),
        h('p', { class: 'sub' }, 'A assistente só oferece horários dentro destes intervalos e fora de compromissos já marcados.'),
        linhasDias.map((d) => d.el))),
    h('section', { class: 'cartao' }, h('h2', {}, 'Regras da agenda e da conversa'),
      h('div', { class: 'form-grade' },
        campo('Duração da reunião (min)', f.duracao), campo('Intervalo entre reuniões (min)', f.intervalo),
        campo('Antecedência mínima (horas)', f.antecedencia), campo('Agendar até quantos dias à frente', f.dias),
        campo('Tom de voz', f.tom), campo('Pausar a IA quando a equipe assume (horas)', f.pausa),
        campo('Valor da consulta', f.valor, 'Vazio = a assistente não informa valores.'),
        campo('Agenda Google do escritório', f.agenda, 'Opcional. Usada quando o advogado não tem agenda própria.'),
        campo('Caixa de entrada do Chatwoot (id)', f.chatwoot, 'Opcional.')),
      h('label', { class: 'checar' }, f.followup, 'Retomar contato com quem parou de responder (uma vez, após cerca de 20h)')),
    pode ? h('div', { class: 'acoes' }, salvar) : h('p', { class: 'sub' }, 'Somente gestores podem alterar estas configurações.'));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const horarios = Object.fromEntries(linhasDias.map((d) => [d.k, d.ler()]));
    acao(salvar, () => api('PUT', '/api/escritorio', {
      nome: f.nome.value, telefone: f.telefone.value, endereco: f.endereco.value, site: f.site.value, areas_atuacao: f.areas.value,
      horario_atendimento: horarios, duracao_reuniao_min: f.duracao.value, intervalo_entre_reunioes_min: f.intervalo.value,
      antecedencia_minima_horas: f.antecedencia.value, dias_para_frente: f.dias.value, google_calendar_id: f.agenda.value,
      tom_de_voz: f.tom.value, valor_consulta: f.valor.value, instrucoes_extras: f.instrucoes.value, horas_pausa_ia: f.pausa.value,
      followup_ativo: f.followup.checked, chatwoot_inbox_id: f.chatwoot.value }), 'Configurações salvas. Valem a partir da próxima mensagem.');
  });

  const listaFaq = h('section', { class: 'cartao' },
    h('div', { class: 'cartao-topo' }, h('div', { class: 'cresce' }, h('h2', {}, 'Perguntas frequentes'), h('span', { class: 'sub' }, 'A assistente responde com estas informações. Ela nunca dá parecer jurídico.')),
      pode ? h('button', { onclick: () => formFaq(null) }, '+ Nova pergunta') : null),
    faq.length ? faq.map((q) => h('div', { class: 'item' }, h('strong', {}, q.pergunta), h('p', { style: 'white-space:pre-wrap' }, q.resposta),
      pode ? h('div', { class: 'acoes' }, h('button', { class: 'pequeno', onclick: () => formFaq(q) }, 'Editar'),
        h('button', { class: 'pequeno perigo', onclick: () => dialogo('Apagar pergunta?', h('p', {}, q.pergunta), { textoOk: 'Apagar', perigo: true,
          aoConfirmar: async () => { await api('DELETE', `/api/faq/${q.id}`); avisar('Pergunta apagada.'); rotear(); } }) }, 'Apagar')) : null))
      : h('p', { class: 'vazio' }, 'Nenhuma pergunta cadastrada.'));
  return [cabecalho('Configurar atendimento', 'O que a assistente sabe sobre o escritório e como ela marca as reuniões.'), form, listaFaq];
}

function formFaq(q) {
  const pergunta = h('input', { type: 'text', value: q?.pergunta || '', placeholder: 'Ex.: Vocês atendem online?' });
  const resposta = h('textarea', { rows: 5 }, q?.resposta || '');
  dialogo(q ? 'Editar pergunta' : 'Nova pergunta', h('div', { style: 'display:flex;flex-direction:column;gap:14px' }, campo('Pergunta', pergunta), campo('Resposta', resposta)), {
    aoConfirmar: async () => {
      await api(q ? 'PUT' : 'POST', q ? `/api/faq/${q.id}` : '/api/faq', { pergunta: pergunta.value, resposta: resposta.value });
      avisar('Pergunta salva.'); rotear();
    },
  });
}

// ---------------------------------------------------------------- WhatsApp
async function telaWhatsapp() {
  const w = await api('GET', '/api/whatsapp');
  const nomes = { open: ['Conectado', 'ok'], connecting: ['Aguardando leitura do QR Code', 'media'], close: ['Desconectado', 'alta'], inexistente: ['Ainda não configurado', 'neutro'] };
  const areaQr = h('div', { style: 'display:flex;flex-direction:column;gap:12px;align-items:flex-start' });
  async function gerar(btn) {
    const r = await acao(btn, () => api('POST', '/api/whatsapp/conectar', {}));
    if (!r) return;
    if (r.qrcode) {
      areaQr.replaceChildren(h('div', { class: 'qr' }, h('img', { src: r.qrcode, alt: 'QR Code para conectar o WhatsApp' })),
        r.codigo ? h('p', {}, 'Ou use o código de pareamento: ', h('strong', {}, r.codigo)) : null,
        h('p', { class: 'sub' }, 'O QR Code expira em cerca de 40 segundos. Se expirar, gere outro.'));
      atualizarACada(5, async () => {
        const s = await api('GET', '/api/whatsapp').catch(() => null);
        if (s?.estado === 'open') { avisar('WhatsApp conectado!'); rotear(); }
      });
    } else {
      areaQr.replaceChildren(h('p', {}, r.estado === 'open' ? 'O WhatsApp já está conectado.' : 'Não veio QR Code. Tente de novo em alguns segundos.'));
    }
  }
  return [
    cabecalho('WhatsApp', 'O número do escritório que a assistente usa para atender.'),
    h('section', { class: 'cartao' },
      h('div', { class: 'cartao-topo' }, h('h2', {}, 'Conexão'), chip(nomes[w.estado] || [w.estado, 'neutro'], h('span', { class: 'ponto' }))),
      w.estado === 'open'
        ? [h('p', {}, 'Tudo certo: a assistente está recebendo e respondendo as mensagens.'),
          podeConfigurar() ? h('div', {}, h('button', { class: 'perigo', onclick: () => dialogo('Desconectar o WhatsApp?', h('p', {}, 'A assistente para de atender até você ler o QR Code de novo.'),
            { textoOk: 'Desconectar', perigo: true, aoConfirmar: async () => { await api('POST', '/api/whatsapp/desconectar', {}); avisar('WhatsApp desconectado.'); rotear(); } }) }, 'Desconectar')) : null]
        : [h('ol', { style: 'margin:0;padding-left:22px;display:flex;flex-direction:column;gap:6px' },
          h('li', {}, 'Use um celular com o WhatsApp (ou WhatsApp Business) do número do escritório.'),
          h('li', {}, 'No celular: Configurações → Aparelhos conectados → Conectar um aparelho.'),
          h('li', {}, 'Clique em "Gerar QR Code" abaixo e aponte a câmera do celular.')),
        podeConfigurar() ? h('div', {}, h('button', { class: 'primario', onclick: (e) => gerar(e.currentTarget) }, 'Gerar QR Code')) : h('p', { class: 'sub' }, 'Peça a um gestor para conectar.'),
        areaQr]),
    h('section', { class: 'cartao' }, h('h2', {}, 'Boas práticas'),
      h('ul', { style: 'margin:0;padding-left:22px;display:flex;flex-direction:column;gap:6px' },
        h('li', {}, 'Use um número só para o escritório e mantenha o celular com internet e bateria.'),
        h('li', {}, 'Não envie mensagens em massa: o WhatsApp pode bloquear o número.'),
        h('li', {}, 'Quando alguém da equipe responde pelo celular, a assistente pausa sozinha naquela conversa.'))),
  ];
}

// ---------------------------------------------------------------- usuários
async function telaUsuarios() {
  const [lista, auditoria] = await Promise.all([api('GET', '/api/usuarios'), api('GET', '/api/auditoria')]);
  const nomesAcao = {
    login: 'Entrou no painel', login_falhou: 'Tentativa de login falhou', trocou_senha: 'Trocou a senha', editou_cliente: 'Editou dados de cliente', enviou_mensagem: 'Respondeu um cliente',
    reativou_ia: 'Reativou a assistente', pausou_ia: 'Pausou a assistente', resolveu_encaminhamento: 'Resolveu um encaminhamento', reuniao_confirmado: 'Confirmou reunião',
    reuniao_realizado: 'Marcou reunião realizada', reuniao_faltou: 'Marcou falta', reuniao_marcado: 'Reabriu reunião', cancelou_reuniao: 'Cancelou reunião', criou_responsavel: 'Adicionou pessoa na equipe',
    editou_responsavel: 'Editou pessoa da equipe', editou_configuracao: 'Alterou a configuração', criou_faq: 'Criou pergunta frequente', editou_faq: 'Editou pergunta frequente', apagou_faq: 'Apagou pergunta frequente',
    gerou_qrcode: 'Gerou QR Code do WhatsApp', desconectou_whatsapp: 'Desconectou o WhatsApp', criou_usuario: 'Criou usuário', editou_usuario: 'Editou usuário', redefiniu_senha: 'Redefiniu senha de usuário',
    criou_escritorio: 'Criou o escritório', ativou_escritorio: 'Ativou o escritório', desativou_escritorio: 'Desativou o escritório',
  };
  return [
    cabecalho('Usuários do painel', 'Quem pode entrar neste painel. Gestores configuram tudo; atendentes veem conversas e agenda.',
      h('button', { class: 'primario', onclick: () => formUsuario(null) }, '+ Novo usuário')),
    h('section', { class: 'cartao' }, h('div', { class: 'tabela-caixa' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Nome', 'E-mail', 'Perfil', 'Situação', 'Último acesso', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, lista.map((u) => h('tr', {},
        h('td', {}, h('strong', {}, u.nome)), h('td', {}, u.email), h('td', {}, u.papel === 'gestor' ? 'Gestor' : 'Atendente'),
        h('td', {}, u.ativo ? (u.trocar_senha ? chip(['Senha provisória', 'media']) : chip(['Ativo', 'ok'])) : chip(['Inativo', 'neutro'])),
        h('td', { class: 'sub' }, u.ultimo_login_em ? fmt.quando(u.ultimo_login_em) : 'nunca'),
        h('td', {}, h('div', { class: 'acoes' }, h('button', { class: 'pequeno', onclick: () => formUsuario(u) }, 'Editar'),
          h('button', { class: 'pequeno', onclick: () => dialogo('Gerar nova senha?', h('p', {}, `${u.nome} vai precisar da nova senha provisória para entrar.`), { textoOk: 'Gerar nova senha',
            aoConfirmar: async () => { const r = await api('POST', `/api/usuarios/${u.id}/nova-senha`, {}); setTimeout(() => mostrarSenha('Nova senha provisória', u.email, r.senhaProvisoria), 50); } }) }, 'Nova senha'))))))))),
    h('section', { class: 'cartao' }, h('h2', {}, 'Atividade recente'),
      auditoria.length ? h('div', { class: 'tabela-caixa' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Quando', 'Quem', 'O quê', 'IP'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, auditoria.map((a) => h('tr', {}, h('td', { class: 'sub' }, `${fmt.data(a.criado_em)} ${fmt.hora(a.criado_em)}`),
          h('td', {}, a.usuario || '—'), h('td', {}, nomesAcao[a.acao] || a.acao), h('td', { class: 'sub' }, a.ip || '')))))) : h('p', { class: 'vazio' }, 'Sem atividade.')),
  ];
}

function formUsuario(u) {
  const nome = h('input', { type: 'text', value: u?.nome || '' });
  const email = h('input', { type: 'email', value: u?.email || '', disabled: !!u });
  const papel = h('select', {}, h('option', { value: 'atendente', selected: u?.papel === 'atendente' }, 'Atendente: conversas e agenda'), h('option', { value: 'gestor', selected: u?.papel === 'gestor' }, 'Gestor: acesso completo'));
  const ativo = h('input', { type: 'checkbox', checked: u ? u.ativo : true });
  dialogo(u ? `Editar ${u.nome}` : 'Novo usuário', h('div', { style: 'display:flex;flex-direction:column;gap:14px' },
    campo('Nome', nome), campo('E-mail', email), campo('Perfil', papel), u ? h('label', { class: 'checar' }, ativo, 'Ativo (pode entrar no painel)') : null), {
    aoConfirmar: async () => {
      if (u) { await api('PUT', `/api/usuarios/${u.id}`, { nome: nome.value, papel: papel.value, ativo: ativo.checked }); avisar('Usuário atualizado.'); rotear(); return; }
      const r = await api('POST', '/api/usuarios', { nome: nome.value, email: email.value, papel: papel.value });
      rotear(); setTimeout(() => mostrarSenha('Usuário criado', email.value.trim().toLowerCase(), r.senhaProvisoria), 50);
    },
  });
}

// ---------------------------------------------------------------- escritórios (administrador geral)
async function telaEscritorios() {
  const lista = await api('GET', '/api/admin/escritorios');
  return [
    cabecalho('Escritórios', 'Seus clientes. Cada escritório tem o próprio número de WhatsApp, equipe e painel.',
      h('button', { class: 'primario', onclick: formEscritorio }, '+ Novo escritório')),
    h('section', { class: 'cartao' }, lista.length ? h('div', { class: 'tabela-caixa' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Escritório', 'Identificador', 'Contatos (30 dias)', 'Reuniões (30 dias)', 'Usuários', 'Situação', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, lista.map((e) => h('tr', {},
        h('td', {}, h('strong', {}, e.nome)), h('td', { class: 'sub' }, e.instancia_whatsapp), h('td', {}, e.leads_30d), h('td', {}, e.reunioes_30d), h('td', {}, e.usuarios),
        h('td', {}, e.ativo ? chip(['Ativo', 'ok']) : chip(['Inativo', 'neutro'])),
        h('td', {}, h('div', { class: 'acoes' },
          h('button', { class: 'pequeno', onclick: () => { estado.escritorioId = e.id; sessionStorage.setItem('escritorio', e.id); location.hash = '#/'; } }, 'Abrir'),
          h('button', { class: `pequeno ${e.ativo ? 'perigo' : ''}`, onclick: () => dialogo(e.ativo ? 'Desativar escritório?' : 'Ativar escritório?',
            h('p', {}, e.ativo ? 'A assistente para de responder os clientes deste escritório e a equipe perde o acesso ao painel.' : 'A assistente volta a atender e a equipe volta a ter acesso.'),
            { textoOk: e.ativo ? 'Desativar' : 'Ativar', perigo: e.ativo, aoConfirmar: async () => { await api('PUT', `/api/admin/escritorios/${e.id}`, { ativo: !e.ativo }); await recarregarMe(); rotear(); } }) }, e.ativo ? 'Desativar' : 'Ativar'))))))))
      : h('p', { class: 'vazio' }, 'Nenhum escritório ainda. Cadastre o primeiro.')),
  ];
}

function formEscritorio() {
  const nome = h('input', { type: 'text', placeholder: 'Silva Advogados Associados' });
  const inst = h('input', { type: 'text', placeholder: 'silva-advogados' });
  nome.addEventListener('input', () => { if (!inst.dataset.mexeu) inst.value = nome.value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40); });
  inst.addEventListener('input', () => { inst.dataset.mexeu = '1'; });
  const gNome = h('input', { type: 'text' });
  const gEmail = h('input', { type: 'email' });
  dialogo('Novo escritório', h('div', { style: 'display:flex;flex-direction:column;gap:14px' },
    campo('Nome do escritório', nome), campo('Identificador', inst, 'Só letras minúsculas, números e hífen. Não dá para mudar depois.'),
    h('h3', {}, 'Gestor do escritório'), h('div', { class: 'form-grade' }, campo('Nome', gNome), campo('E-mail', gEmail))), {
    textoOk: 'Criar escritório',
    aoConfirmar: async () => {
      const r = await api('POST', '/api/admin/escritorios', { nome: nome.value, instancia: inst.value, gestor_nome: gNome.value, gestor_email: gEmail.value });
      await recarregarMe();
      estado.escritorioId = r.id; sessionStorage.setItem('escritorio', r.id);
      location.hash = '#/whatsapp';
      setTimeout(() => mostrarSenha('Escritório criado', r.gestor.email, r.gestor.senhaProvisoria), 50);
    },
  });
}

// ---------------------------------------------------------------- início
async function recarregarMe() {
  const me = await api('GET', '/api/me');
  estado.me = me; estado.csrf = me.csrf;
  if (me.usuario.papel !== 'admin_geral') estado.escritorioId = me.usuario.escritorio_id;
  else {
    const salvo = sessionStorage.getItem('escritorio');
    estado.escritorioId = me.escritorios.some((e) => e.id === salvo) ? salvo : null;
  }
}

async function iniciar() {
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    if (r.status === 401) return telaLogin();
    const me = await r.json();
    if (r.status === 403 && me.trocarSenha) {
      estado.me = { usuario: { nome: '', papel: '' }, escritorios: [] };
      return telaTrocarSenha(true);
    }
    await recarregarMe();
    if (estado.me.usuario.trocar_senha) { app.replaceChildren(); return telaTrocarSenha(true); }
    rotear();
  } catch { telaLogin(); }
}
window.addEventListener('hashchange', rotear);
iniciar();
