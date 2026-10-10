'use strict';
// Cria (ou redefine a senha de) um usuário do painel pela linha de comando.
// Uso: node src/criar-usuario.js <email> "<Nome>" [instancia-do-escritorio] [papel]
//   sem instância -> administrador geral (vê todos os escritórios)
// Imprime uma senha provisória, que deve ser trocada no primeiro acesso.
const { Client } = require('pg');
const S = require('./seguranca');

(async () => {
  const [email, nome, instancia, papelArg] = process.argv.slice(2);
  if (!email || !nome) {
    console.error('Uso: node src/criar-usuario.js <email> "<Nome>" [instancia-do-escritorio] [gestor|atendente]');
    process.exit(1);
  }
  const em = S.V.email(email, 'o e-mail', true);
  const papel = instancia ? (papelArg === 'atendente' ? 'atendente' : 'gestor') : 'admin_geral';
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  let escId = null;
  if (instancia) {
    const r = await db.query('SELECT id FROM escritorios WHERE instancia_whatsapp = $1', [instancia]);
    if (!r.rows[0]) { console.error(`Escritório "${instancia}" não encontrado.`); process.exit(1); }
    escId = r.rows[0].id;
  }
  const senha = S.senhaTemporaria();
  await db.query(`INSERT INTO painel_usuarios (escritorio_id, nome, email, senha_hash, papel, trocar_senha)
                  VALUES ($1, $2, $3, $4, $5, true)
                  ON CONFLICT (email) DO UPDATE SET senha_hash = EXCLUDED.senha_hash, trocar_senha = true, ativo = true`,
  [escId, nome, em, S.hashSenha(senha), papel]);
  await db.query('DELETE FROM painel_sessoes s USING painel_usuarios u WHERE u.id = s.usuario_id AND u.email = $1', [em]);
  await db.end();
  console.log(`Usuário: ${em}`);
  console.log(`Senha provisória: ${senha}`);
  console.log('Troque a senha no primeiro acesso.');
})().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
