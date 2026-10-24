// Rotas do app Mavero: empresa, produtos/estoque, equipe, vendas e movimentações.
// Todas exigem login e só enxergam os dados da empresa do próprio usuário.
module.exports = (app, { db, auth, h, pool }) => {
  const UUID = /^[0-9a-f-]{36}$/i;
  const bad = (res, m = 'Dados inválidos.') => res.status(400).json({ error: m });
  const cents = (v) => Math.round(parseFloat(String(v).replace(',', '.')) * 100);
  const int = (v) => (v == null || v === '' ? null : parseInt(v, 10));
  const txt = (v, n) => (v == null ? null : String(v).trim().slice(0, n));

  const company = async (uid) => {
    let [c] = await db('SELECT * FROM companies WHERE owner_id=$1 ORDER BY created_at LIMIT 1', [uid]);
    if (!c) [c] = await db("INSERT INTO companies(owner_id,name) VALUES($1,'') RETURNING *", [uid]);
    return c;
  };
  const A = [auth, h(async (req, _res, next) => { req.co = await company(req.user.id); next(); })];
  app.param('id', (req, res, next, v) => (UUID.test(v) ? next() : bad(res)));

  app.get('/api/state', ...A, h(async (req, res) => {
    const id = req.co.id;
    const [products, employees, transactions] = await Promise.all([
      db('SELECT id,name,qty,min_qty,price_cents FROM products WHERE company_id=$1 ORDER BY name', [id]),
      db('SELECT id,name,role,weight FROM employees WHERE company_id=$1 ORDER BY name', [id]),
      db("SELECT id,kind,amount_cents,category,note,product_id,occurred_at FROM transactions WHERE company_id=$1 AND occurred_at > now() - interval '120 days' ORDER BY occurred_at DESC LIMIT 1000", [id]),
    ]);
    const { name, cnpj, split_pct } = req.co;
    res.json({ company: { name, cnpj, split_pct }, products, employees, transactions });
  }));

  app.put('/api/company', ...A, h(async (req, res) => {
    const b = req.body || {};
    const pct = b.split_pct == null ? req.co.split_pct : parseInt(b.split_pct, 10);
    if (!(pct >= 0 && pct <= 100)) return bad(res);
    await db('UPDATE companies SET name=COALESCE($2,name), cnpj=COALESCE($3,cnpj), split_pct=$4 WHERE id=$1',
      [req.co.id, txt(b.name, 120), txt(b.cnpj, 30), pct]);
    res.json({ ok: true });
  }));

  app.post('/api/products', ...A, h(async (req, res) => {
    const b = req.body || {}, qty = int(b.qty) ?? 0, min = int(b.min_qty) ?? 0, price = cents(b.price || 0);
    if (!txt(b.name, 120) || !(qty >= 0) || !(min >= 0) || !(price >= 0)) return bad(res);
    const [r] = await db('INSERT INTO products(company_id,name,qty,min_qty,price_cents) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [req.co.id, txt(b.name, 120), qty, min, price]);
    res.json(r);
  }));

  app.patch('/api/products/:id', ...A, h(async (req, res) => {
    const b = req.body || {};
    const v = [txt(b.name, 120) || null, int(b.qty), int(b.min_qty), b.price === '' || b.price == null ? null : cents(b.price)];
    if (v.slice(1).some((x) => x != null && !(x >= 0))) return bad(res);
    const r = await db('UPDATE products SET name=COALESCE($3,name), qty=COALESCE($4,qty), min_qty=COALESCE($5,min_qty), price_cents=COALESCE($6,price_cents) WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.id, req.co.id, ...v]);
    r[0] ? res.json({ ok: true }) : res.status(404).json({ error: 'Produto não encontrado.' });
  }));

  app.delete('/api/products/:id', ...A, h(async (req, res) => {
    await db('DELETE FROM products WHERE id=$1 AND company_id=$2', [req.params.id, req.co.id]);
    res.json({ ok: true });
  }));

  app.post('/api/employees', ...A, h(async (req, res) => {
    const b = req.body || {}, w = Math.max(1, int(b.weight) || 1);
    if (!txt(b.name, 100)) return bad(res);
    await db('INSERT INTO employees(company_id,name,role,weight) VALUES($1,$2,$3,$4)', [req.co.id, txt(b.name, 100), txt(b.role, 80) || '', w]);
    res.json({ ok: true });
  }));

  app.delete('/api/employees/:id', ...A, h(async (req, res) => {
    await db('DELETE FROM employees WHERE id=$1 AND company_id=$2', [req.params.id, req.co.id]);
    res.json({ ok: true });
  }));

  // Venda: baixa o estoque e registra a entrada, tudo na mesma transação do banco.
  app.post('/api/sales', ...A, h(async (req, res) => {
    const { product_id, qty } = req.body || {}, q = int(qty) || 1;
    if (!UUID.test(product_id || '') || !(q > 0)) return bad(res);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [p] } = await c.query('UPDATE products SET qty=qty-$3 WHERE id=$1 AND company_id=$2 AND qty>=$3 RETURNING name,price_cents,qty', [product_id, req.co.id, q]);
      if (!p) { await c.query('ROLLBACK'); return res.status(409).json({ error: 'Estoque insuficiente ou produto não encontrado.' }); }
      await c.query("INSERT INTO transactions(company_id,kind,amount_cents,category,note,product_id) VALUES($1,'in',$2,'Venda',$3,$4)",
        [req.co.id, p.price_cents * q, `${q}× ${p.name}`, product_id]);
      await c.query('COMMIT');
      res.json({ ok: true, qty: p.qty });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }));

  app.post('/api/transactions', ...A, h(async (req, res) => {
    const b = req.body || {}, a = cents(b.amount);
    if (!['in', 'out'].includes(b.kind) || !(a > 0) || a > 1e11) return bad(res, 'Informe um valor válido.');
    await db('INSERT INTO transactions(company_id,kind,amount_cents,category,note) VALUES($1,$2,$3,$4,$5)',
      [req.co.id, b.kind, a, txt(b.category, 80) || '', txt(b.note, 200) || '']);
    res.json({ ok: true });
  }));

  // Só movimentações manuais podem ser apagadas (vendas ficam, para não desencontrar o estoque).
  app.delete('/api/transactions/:id', ...A, h(async (req, res) => {
    await db('DELETE FROM transactions WHERE id=$1 AND company_id=$2 AND product_id IS NULL', [req.params.id, req.co.id]);
    res.json({ ok: true });
  }));

  // Resumo da empresa que o Assistente recebe junto com a pergunta.
  app.locals.summary = async (uid) => {
    const c = await company(uid), id = c.id;
    const [t] = await db("SELECT COALESCE(SUM(amount_cents) FILTER (WHERE kind='in'),0) AS i, COALESCE(SUM(amount_cents) FILTER (WHERE kind='out'),0) AS o FROM transactions WHERE company_id=$1 AND occurred_at >= date_trunc('month', now())", [id]);
    const low = await db('SELECT name,qty,min_qty FROM products WHERE company_id=$1 AND qty<=min_qty LIMIT 20', [id]);
    const R = (x) => 'R$ ' + (Number(x) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    const i = Number(t.i), o = Number(t.o);
    return `\n\nDados da empresa "${(c.name || 'sem nome').slice(0, 80)}" neste mês: entradas ${R(i)}, saídas ${R(o)}, sobra ${R(i - o)}. Divisão com a equipe: ${c.split_pct}% da sobra. Estoque abaixo do mínimo: ${low.length ? low.map((p) => `${p.name} (${p.qty} de mín. ${p.min_qty})`).join(', ') : 'nenhum'}. Use estes dados quando a pergunta for sobre o negócio.`;
  };
};
