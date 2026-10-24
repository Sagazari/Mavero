-- Executado automaticamente ao iniciar a API (CREATE IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text,
  google boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Limite diário do Assistente (por usuário e por dia)
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  n int NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
-- Base para os próximos passos (empresa, equipe, estoque, movimentações)
CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL, cnpj text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL, role text, weight int NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL, qty int NOT NULL DEFAULT 0, min_qty int NOT NULL DEFAULT 0, price_cents int NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('in','out')),
  amount_cents bigint NOT NULL, category text, occurred_at timestamptz NOT NULL DEFAULT now()
);

-- v2: campos usados pelo app
ALTER TABLE companies ADD COLUMN IF NOT EXISTS split_pct int NOT NULL DEFAULT 30;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tx_company_time ON transactions(company_id, occurred_at DESC);
