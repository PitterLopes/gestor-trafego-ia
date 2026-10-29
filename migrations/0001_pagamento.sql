-- O que o sistema sabe do seu negócio: quem entrou no pagamento, quem pagou, quantas vezes, quem cancelou.
-- Alimente estas tabelas com o seu sistema de cobrança (CSV em POST /admin/pagamento/importar, ou um webhook seu).
-- Sem elas o time ainda funciona, só que decide por cadastro (o que a plataforma conta), não por cliente.

CREATE TABLE IF NOT EXISTS clientes (
  id TEXT PRIMARY KEY,              -- o id do cliente no seu sistema de cobrança
  email TEXT,
  telefone TEXT,
  criado_em TEXT NOT NULL,          -- ISO: quando entrou no pagamento (criou conta, iniciou checkout)
  plano TEXT,                       -- nome do plano de entrada (livre)
  atendentes INTEGER,               -- tamanho do time, quando fizer sentido no seu produto (NULL se não)
  cancelado_em TEXT,                -- ISO: quando deixou de ser cliente (NULL se continua)
  atualizado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clientes_criado ON clientes(criado_em);

CREATE TABLE IF NOT EXISTS pagamentos (
  id TEXT PRIMARY KEY,              -- id da fatura/cobrança paga
  cliente_id TEXT NOT NULL,
  pago_em TEXT NOT NULL,            -- AAAA-MM-DD
  valor_cents INTEGER NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pagamentos_cliente ON pagamentos(cliente_id, pago_em);
CREATE INDEX IF NOT EXISTS idx_pagamentos_dia ON pagamentos(pago_em);
