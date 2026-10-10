'use strict';
// Painel web do Assistente Jurídico: servidor HTTP, sessão e segurança.
const path = require('node:path');
const express = require('express');
const { Pool } = require('pg');
const S = require('./seguranca');
const montarApi = require('./api');

const CFG = {
  porta: Number(process.env.PORT || 3000),
  bancoUrl: process.env.DATABASE_URL,
  cookieSeguro: process.env.COOKIE_SECURE !== 'false', // em produção sempre HTTPS
  sessaoHoras: Number(process.env.SESSAO_HORAS || 12),
  evolutionUrl: process.env.EVOLUTION_URL || 'http://evolution:8080',
  evolutionKey: process.env.EVOLUTION_API_KEY,
  n8nUrl: process.env.N8N_URL || 'http://n8n:5678',
  n8nSegredo: process.env.PAINEL_N8N_SECRET,
};
for (const [k, v] of Object.entries({ DATABASE_URL: CFG.bancoUrl, EVOLUTION_API_KEY: CFG.evolutionKey, PAINEL_N8N_SECRET: CFG.n8nSegredo })) {
  if (!v) { console.error(`Variável ${k} não definida.`); process.exit(1); }
}

const db = new Pool({ connectionString: CFG.bancoUrl, max: 10, idleTimeoutMillis: 30_000 });
db.on('error', (e) => console.error('Erro no pool do Postgres:', e.message));

const COOKIE = CFG.cookieSeguro ? '__Host-sessao' : 'sessao';
const tentativasLogin = S.limitador({ janelaMs: 15 * 60_000, maximo: 5 });
const tentativasIp = S.limitador({ janelaMs: 15 * 60_000, maximo: 30 });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, uniquelocal'); // atrás do Caddy

// ---------------------------------------------------------------- cabeçalhos de segurança
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  next();
});

app.get('/saude', async (req, res) => {
  try { await db.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});

app.use('/api', express.json({ limit: '100kb' }));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// ---------------------------------------------------------------- sessão
function lerCookie(req, nome) {
  const c = req.headers.cookie || '';
  for (const parte of c.split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}
function gravarCookie(res, valor, maxAgeSeg) {
  const attrs = [`${COOKIE}=${valor}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeg}`];
  if (CFG.cookieSeguro) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

async function auditar(req, acao, detalhe, escritorioId) {
  try {
    await db.query('INSERT INTO painel_auditoria (usuario_id, escritorio_id, acao, detalhe, ip) VALUES ($1, $2, $3, $4, $5)',
      [req.usuario?.id || null, escritorioId ?? req.escritorioId ?? null, acao, detalhe ? JSON.stringify(detalhe) : null, req.ip]);
  } catch (e) { console.error('auditoria:', e.message); }
}

app.post('/api/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 200);
    const senha = String(req.body?.senha || '').slice(0, 200);
    const chave = `${req.ip}|${email}`;
    if (tentativasLogin.bloqueado(chave) || tentativasIp.bloqueado(req.ip)) {
      return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos e tente de novo.' });
    }
    const { rows } = await db.query(
      `SELECT u.*, e.ativo AS escritorio_ativo FROM painel_usuarios u
       LEFT JOIN escritorios e ON e.id = u.escritorio_id WHERE u.email = $1`, [email]);
    const u = rows[0];
    const ok = S.conferirSenha(senha, u ? u.senha_hash : S.HASH_FALSO);
    if (!u || !ok || !u.ativo || (u.escritorio_id && !u.escritorio_ativo)) {
      tentativasLogin.falhou(chave); tentativasIp.falhou(req.ip);
      await auditar({ ip: req.ip }, 'login_falhou', { email }, u?.escritorio_id || null);
      return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
    }
    tentativasLogin.limpar(chave);
    const tk = S.token();
    const csrf = S.token();
    await db.query(`INSERT INTO painel_sessoes (token_hash, usuario_id, csrf, ip, expira_em)
                    VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))`, [S.sha256(tk), u.id, csrf, req.ip, CFG.sessaoHoras]);
    await db.query('UPDATE painel_usuarios SET ultimo_login_em = now() WHERE id = $1', [u.id]);
    await db.query('DELETE FROM painel_sessoes WHERE expira_em < now()');
    gravarCookie(res, tk, CFG.sessaoHoras * 3600);
    await auditar({ usuario: u, ip: req.ip }, 'login', null, u.escritorio_id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// exige sessão válida em todo o resto da API
app.use('/api', async (req, res, next) => {
  try {
    const tk = lerCookie(req, COOKIE);
    if (!tk) return res.status(401).json({ erro: 'Faça login.' });
    const { rows } = await db.query(
      `SELECT s.csrf, s.expira_em, u.id, u.nome, u.email, u.papel, u.escritorio_id, u.trocar_senha
       FROM painel_sessoes s JOIN painel_usuarios u ON u.id = s.usuario_id
       LEFT JOIN escritorios e ON e.id = u.escritorio_id
       WHERE s.token_hash = $1 AND s.expira_em > now() AND u.ativo AND (u.escritorio_id IS NULL OR e.ativo)`, [S.sha256(tk)]);
    if (!rows[0]) { gravarCookie(res, '', 0); return res.status(401).json({ erro: 'Sessão expirada. Faça login de novo.' }); }
    const s = rows[0];
    req.sessaoHash = S.sha256(tk);
    req.csrf = s.csrf;
    req.usuario = { id: s.id, nome: s.nome, email: s.email, papel: s.papel, escritorio_id: s.escritorio_id, trocar_senha: s.trocar_senha };
    // proteção CSRF: toda escrita precisa do token da sessão no cabeçalho
    if (!['GET', 'HEAD'].includes(req.method) && !S.iguais(req.get('x-csrf-token') || '', s.csrf)) {
      return res.status(403).json({ erro: 'Requisição recusada (CSRF). Recarregue a página.' });
    }
    // sessão deslizante: renova quando falta menos da metade
    if (new Date(s.expira_em) - Date.now() < CFG.sessaoHoras * 1800_000) {
      await db.query('UPDATE painel_sessoes SET expira_em = now() + make_interval(hours => $2) WHERE token_hash = $1', [req.sessaoHash, CFG.sessaoHoras]);
      gravarCookie(res, tk, CFG.sessaoHoras * 3600);
    }
    // escritório em uso: o do usuário; o administrador geral escolhe pelo cabeçalho
    if (s.papel === 'admin_geral') {
      const pedido = req.get('x-escritorio');
      if (pedido && /^[0-9a-f-]{36}$/i.test(pedido)) {
        const r = await db.query('SELECT id FROM escritorios WHERE id = $1', [pedido]);
        req.escritorioId = r.rows[0]?.id || null;
      } else req.escritorioId = null;
    } else req.escritorioId = s.escritorio_id;
    // com senha provisória, só pode trocar a senha
    if (s.trocar_senha && !['/me', '/minha-senha', '/logout'].includes(req.path)) {
      return res.status(403).json({ erro: 'Troque sua senha provisória para continuar.', trocarSenha: true });
    }
    next();
  } catch (e) { next(e); }
});

app.post('/api/logout', async (req, res, next) => {
  try {
    await db.query('DELETE FROM painel_sessoes WHERE token_hash = $1', [req.sessaoHash]);
    gravarCookie(res, '', 0);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/minha-senha', async (req, res, next) => {
  try {
    const { atual, nova } = req.body || {};
    if (!S.senhaForte(nova)) return res.status(400).json({ erro: 'A nova senha precisa de pelo menos 10 caracteres, com letras e números.' });
    const { rows } = await db.query('SELECT senha_hash FROM painel_usuarios WHERE id = $1', [req.usuario.id]);
    if (!S.conferirSenha(String(atual || ''), rows[0].senha_hash)) return res.status(400).json({ erro: 'Senha atual incorreta.' });
    if (S.conferirSenha(nova, rows[0].senha_hash)) return res.status(400).json({ erro: 'A nova senha deve ser diferente da atual.' });
    await db.query('UPDATE painel_usuarios SET senha_hash = $2, trocar_senha = false WHERE id = $1', [req.usuario.id, S.hashSenha(nova)]);
    // encerra as outras sessões deste usuário
    await db.query('DELETE FROM painel_sessoes WHERE usuario_id = $1 AND token_hash <> $2', [req.usuario.id, req.sessaoHash]);
    await auditar(req, 'trocou_senha');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

montarApi(app, { db, CFG, S, auditar });

// ---------------------------------------------------------------- arquivos do site
app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: 'index.html',
  setHeaders: (res, arq) => res.set('Cache-Control', arq.endsWith('.html') ? 'no-cache' : 'public, max-age=300'),
}));
app.use('/api', (req, res) => res.status(404).json({ erro: 'Não encontrado.' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ---------------------------------------------------------------- erros
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.status === 400 || err instanceof S.ErroValidacao) return res.status(400).json({ erro: err.message });
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ erro: 'Dados inválidos.' });
  if (err.status && err.publico) return res.status(err.status).json({ erro: err.message });
  console.error(new Date().toISOString(), req.method, req.path, err);
  res.status(500).json({ erro: 'Erro interno. Tente de novo; se continuar, avise o suporte.' });
});

app.listen(CFG.porta, '0.0.0.0', () => console.log(`Painel ouvindo na porta ${CFG.porta}`));
