-- O negócio por inteiro: atribuição do clique até o pagamento, eventos para a Meta, leads da landing page
-- e o login do painel por e-mail + código (src/fontes/ingestao.ts, src/fontes/eventos_meta.ts, src/login.ts).

-- Clientes ganham nome (para a correspondência da Meta) e os ids de clique que vieram da landing page.
ALTER TABLE clientes ADD COLUMN nome TEXT;
ALTER TABLE clientes ADD COLUMN origem TEXT;          -- de onde veio o cadastro: webhook:<fonte>, csv, lead
ALTER TABLE clientes ADD COLUMN fbclid TEXT;          -- clique da Meta (vira fbc no evento)
ALTER TABLE clientes ADD COLUMN gclid TEXT;           -- clique do Google (para a etapa Google Ads)
ALTER TABLE clientes ADD COLUMN fbp TEXT;             -- cookie _fbp do navegador, quando a landing capturou
ALTER TABLE clientes ADD COLUMN utm_json TEXT;        -- utm_source/medium/campaign/content/term

-- Quem preencheu um formulário na landing page (POST /lead, pelo captura.js). Liga o clique ao cliente
-- quando o mesmo e-mail ou telefone aparece no pagamento.
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  telefone TEXT,
  nome TEXT,
  fbclid TEXT,
  gclid TEXT,
  fbp TEXT,
  utm_json TEXT,
  pagina TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_telefone ON leads(telefone);

-- Eventos enviados à Meta (API de Conversões): um por fato, nunca repetido.
CREATE TABLE IF NOT EXISTS meta_eventos (
  event_id TEXT PRIMARY KEY,        -- checkout_<cliente>, purchase_<pagamento>, renovacao_<pagamento>
  evento TEXT NOT NULL,             -- InitiateCheckout, Purchase, RenovacaoAssinatura
  cliente_id TEXT NOT NULL,
  pagamento_id TEXT,
  event_time INTEGER NOT NULL,
  valor_cents INTEGER,
  status TEXT NOT NULL,             -- enviando, enviado, teste, erro, ignorado
  tentativas INTEGER NOT NULL DEFAULT 0,
  resposta TEXT,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_eventos_status ON meta_eventos(status, atualizado_em);

-- Registro do que chegou pelo webhook (para depurar a integração sem guardar o corpo inteiro).
CREATE TABLE IF NOT EXISTS ingestao_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fonte TEXT NOT NULL,
  tipo TEXT,
  clientes INTEGER NOT NULL DEFAULT 0,
  pagamentos INTEGER NOT NULL DEFAULT 0,
  erro TEXT,
  recebido_em TEXT NOT NULL
);

-- Login do painel por e-mail + código de 6 dígitos. Só hashes no banco.
CREATE TABLE IF NOT EXISTS usuarios (
  email TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  papel TEXT NOT NULL CHECK (papel IN ('admin', 'leitor')),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  convidado_por TEXT,
  ultimo_acesso_em TEXT
);
CREATE TABLE IF NOT EXISTS login_codigos (
  email TEXT PRIMARY KEY,
  codigo_hash TEXT NOT NULL,
  expira_em TEXT NOT NULL,
  tentativas INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_pedidos_email ON login_pedidos(email, em);
CREATE TABLE IF NOT EXISTS login_sessoes (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  criado_em TEXT NOT NULL,
  expira_em TEXT NOT NULL,
  visto_em TEXT NOT NULL,
  agente TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_sessoes_email ON login_sessoes(email);
