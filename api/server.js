// Mavero API: login (e-mail + Google), Mavero Assistente (Mistral) com limite diário, Postgres.
const fs = require('fs'), path = require('path');
const express = require('express'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs'), cors = require('cors'), rateLimit = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
const { Pool } = require('pg');

const { APP_URL, API_URL, JWT_SECRET, MISTRAL_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, DATABASE_URL } = process.env;
const DAILY = +process.env.DAILY_LIMIT || 20, GLOBAL = +process.env.GLOBAL_DAILY_LIMIT || 2000;
const pool = new Pool({ connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL || '') ? false : { rejectUnauthorized: false } });
const db = (t, p) => pool.query(t, p).then((r) => r.rows);
const google = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, `${API_URL}/auth/google/callback`);

const app = express();
app.set('trust proxy', 1); // Render fica atrás de um proxy HTTPS
app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());
app.use(cors({ origin: APP_URL, credentials: true }));
app.use(rateLimit({ windowMs: 60_000, max: 60 }));

const h = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const cookie = { httpOnly: true, secure: true, sameSite: 'none', maxAge: 7 * 864e5 };
const sign = (res, u) => res.cookie('mv', jwt.sign({ sub: u.id }, JWT_SECRET, { expiresIn: '7d' }), cookie);
const pub = (u) => ({ name: u.name, email: u.email });
const auth = h(async (req, res, next) => {
  try { const { sub } = jwt.verify(req.cookies.mv, JWT_SECRET); [req.user] = await db('SELECT id,name,email FROM users WHERE id=$1', [sub]); } catch {}
  req.user ? next() : res.status(401).json({ error: 'Faça login para continuar.' });
});

app.get('/health', (_, res) => res.send('ok'));

app.post('/auth/register', h(async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!/^\S+@\S+\.\S+$/.test(email || '') || (password || '').length < 8) return res.status(400).json({ error: 'Dados inválidos.' });
  const rows = await db('INSERT INTO users(name,email,password_hash) VALUES($1,lower($2),$3) ON CONFLICT(email) DO NOTHING RETURNING id,name,email',
    [name || email.split('@')[0], email, await bcrypt.hash(password, 12)]);
  if (!rows[0]) return res.status(409).json({ error: 'Este e-mail já tem conta.' });
  sign(res, rows[0]); res.json({ user: pub(rows[0]) });
}));

app.post('/auth/login', h(async (req, res) => {
  const { email, password } = req.body || {};
  const [u] = await db('SELECT * FROM users WHERE email=lower($1)', [email || '']);
  if (!u || !u.password_hash || !(await bcrypt.compare(password || '', u.password_hash)))
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  sign(res, u); res.json({ user: pub(u) });
}));

app.get('/auth/google', (_, res) =>
  res.redirect(google.generateAuthUrl({ scope: ['openid', 'email', 'profile'], prompt: 'select_account' })));

app.get('/auth/google/callback', h(async (req, res) => {
  try {
    const { tokens } = await google.getToken(req.query.code);
    const p = (await google.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID })).getPayload();
    const [u] = await db('INSERT INTO users(name,email,google) VALUES($1,lower($2),true) ON CONFLICT(email) DO UPDATE SET google=true RETURNING id,name,email', [p.name, p.email]);
    sign(res, u); res.redirect(APP_URL + '/app.html');
  } catch (e) { console.error(e); res.redirect(APP_URL + '?erro=google'); }
}));

app.get('/auth/me', auth, (req, res) => res.json({ user: pub(req.user) }));
app.post('/auth/logout', (_, res) => res.clearCookie('mv', cookie).json({ ok: true }));

// Limite do Assistente: DAILY por usuário/dia e GLOBAL no total/dia (controla o custo da Mistral)
const quota = h(async (req, res, next) => {
  const d = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const [{ t }] = await db('SELECT COALESCE(SUM(n),0)::int AS t FROM ai_usage WHERE day=$1', [d]);
  if (t >= GLOBAL) return res.status(429).json({ error: 'O Assistente está com muita procura. Tente novamente amanhã.' });
  const r = await db('INSERT INTO ai_usage(user_id,day,n) VALUES($1,$2,1) ON CONFLICT(user_id,day) DO UPDATE SET n=ai_usage.n+1 WHERE ai_usage.n<$3 RETURNING n', [req.user.id, d, DAILY]);
  if (!r[0]) return res.status(429).json({ error: `Você usou suas ${DAILY} mensagens de hoje. Elas voltam amanhã.` });
  req.left = DAILY - r[0].n; next();
});

const SYSTEM = `Você é o Mavero Assistente, da plataforma Mavero, que mostra entradas, saídas, divisão com a equipe, estoque e o que arrumar em pequenas empresas.
Responda em português do Brasil, de forma curta, clara e confiante. Não invente números: se não tiver o dado, diga.
Você não movimenta dinheiro e não dá consultoria financeira, contábil ou jurídica; sugira um profissional quando for o caso.`;

app.post('/api/chat', auth, rateLimit({ windowMs: 60_000, max: 10 }), quota, h(async (req, res) => {
  const messages = (req.body.messages || []).slice(-12).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 2000) }));
  const ctx = await app.locals.summary(req.user.id).catch(() => '');
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MISTRAL_API_KEY}` },
    body: JSON.stringify({ model: 'mistral-small-latest', temperature: 0.3, max_tokens: 500,
      messages: [{ role: 'system', content: SYSTEM + ctx }, ...messages] }),
  });
  if (!r.ok) throw new Error('Mistral: ' + await r.text());
  res.json({ reply: (await r.json()).choices[0].message.content, remaining: req.left });
}));

require('./routes')(app, { db, auth, h, pool }); // empresa, estoque, equipe, caixa

app.use((e, _req, res, _next) => { console.error(e); res.status(502).json({ error: 'Serviço indisponível. Tente novamente.' }); });

pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'))
  .then(() => app.listen(process.env.PORT || 3000, () => console.log('Mavero API no ar')))
  .catch((e) => { console.error('Falha ao preparar o banco:', e); process.exit(1); });
