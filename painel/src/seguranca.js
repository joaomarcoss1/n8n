'use strict';
// Senhas (scrypt), tokens de sessão, validação de entrada e limite de tentativas.
const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(senha, sal, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sal.toString('base64')}$${h.toString('base64')}`;
}

function conferirSenha(senha, armazenado) {
  try {
    const [alg, N, r, p, sal, h] = String(armazenado).split('$');
    if (alg !== 'scrypt') return false;
    const esperado = Buffer.from(h, 'base64');
    const calc = crypto.scryptSync(senha, Buffer.from(sal, 'base64'), esperado.length,
      { N: Number(N), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(calc, esperado);
  } catch {
    return false;
  }
}

// usado quando o e-mail não existe, para o tempo de resposta não revelar isso
const HASH_FALSO = hashSenha(crypto.randomBytes(16).toString('hex'));

const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const iguais = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function senhaTemporaria() {
  // 12 caracteres sem ambíguos (0/O, 1/l/I)
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(12), (b) => alfabeto[b % alfabeto.length]).join('');
}

function senhaForte(s) {
  return typeof s === 'string' && s.length >= 10 && s.length <= 200 && /[a-zA-Z]/.test(s) && /\d/.test(s);
}

// ---------------------------------------------------------------- validação
class ErroValidacao extends Error {
  constructor(msg) { super(msg); this.status = 400; }
}
const falha = (msg) => { throw new ErroValidacao(msg); };

const V = {
  texto(v, campo, { max = 500, obrigatorio = false } = {}) {
    if (v === undefined || v === null || String(v).trim() === '') {
      if (obrigatorio) falha(`Preencha ${campo}.`);
      return null;
    }
    const s = String(v).trim();
    if (s.length > max) falha(`${campo}: máximo de ${max} caracteres.`);
    return s;
  },
  email(v, campo = 'o e-mail', obrigatorio = false) {
    const s = V.texto(v, campo, { max: 200, obrigatorio });
    if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) falha(`${campo} é inválido.`);
    return s ? s.toLowerCase() : null;
  },
  whatsapp(v, campo = 'o WhatsApp', obrigatorio = false) {
    const s = V.texto(v, campo, { max: 30, obrigatorio });
    if (!s) return null;
    let d = s.replace(/\D/g, '');
    if (d.length === 10 || d.length === 11) d = '55' + d; // número brasileiro sem DDI
    if (d.length < 12 || d.length > 15) falha(`${campo} deve ter DDD e número (ex.: 11 99999-0000).`);
    return d;
  },
  inteiro(v, campo, min, max) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) falha(`${campo} deve estar entre ${min} e ${max}.`);
    return n;
  },
  bool: (v) => v === true || v === 'true' || v === 1 || v === '1',
  uuid(v, campo = 'id') {
    if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) falha(`${campo} inválido.`);
    return v.toLowerCase();
  },
  uuidOuNulo: (v, campo) => (v ? V.uuid(v, campo) : null),
  opcao(v, campo, opcoes) {
    if (!opcoes.includes(v)) falha(`${campo} inválido.`);
    return v;
  },
  areas(v) {
    const lista = Array.isArray(v) ? v : String(v || '').split(',');
    const limpas = [...new Set(lista.map((a) => String(a).trim().toLowerCase()).filter(Boolean))];
    if (limpas.length > 30) falha('Máximo de 30 áreas.');
    for (const a of limpas) if (a.length > 40) falha('Nome de área muito longo.');
    return limpas;
  },
  horario(v) {
    const dias = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];
    if (!v || typeof v !== 'object' || Array.isArray(v)) falha('Horário de atendimento inválido.');
    const saida = {};
    for (const [dia, faixas] of Object.entries(v)) {
      if (!dias.includes(dia)) falha('Dia inválido no horário.');
      if (!Array.isArray(faixas)) falha('Horário inválido.');
      if (!faixas.length) continue;
      if (faixas.length > 4) falha('Máximo de 4 intervalos por dia.');
      saida[dia] = faixas.map(([ini, fim]) => {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(ini) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(fim) || ini >= fim) {
          falha(`Intervalo inválido em ${dia}: use HH:MM e início antes do fim.`);
        }
        return [ini, fim];
      });
    }
    return saida;
  },
};

// ---------------------------------------------------------------- limite de tentativas
function limitador({ janelaMs, maximo }) {
  const mapa = new Map();
  setInterval(() => {
    const agora = Date.now();
    for (const [k, v] of mapa) if (v.ate < agora) mapa.delete(k);
  }, 60_000).unref();
  return {
    bloqueado(chave) {
      const v = mapa.get(chave);
      return !!v && v.ate > Date.now() && v.n >= maximo;
    },
    falhou(chave) {
      const agora = Date.now();
      const v = mapa.get(chave);
      if (!v || v.ate < agora) mapa.set(chave, { n: 1, ate: agora + janelaMs });
      else v.n++;
    },
    limpar(chave) { mapa.delete(chave); },
  };
}

module.exports = { hashSenha, conferirSenha, HASH_FALSO, token, sha256, iguais, senhaTemporaria, senhaForte, V, ErroValidacao, limitador };
