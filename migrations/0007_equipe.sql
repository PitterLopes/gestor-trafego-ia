-- Vigia, Estrategista, Relator e Públicos (src/agentes/).

-- Alertas do Vigia (um por chave por dia): reprovação, gasto zerado, teto do dia, erro de publicação.
CREATE TABLE IF NOT EXISTS alertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dia TEXT NOT NULL,
  chave TEXT NOT NULL,              -- ex.: reprovado:<ad_id>, teto_dia, sem_gasto:<campanha_id>
  agente TEXT NOT NULL,
  gravidade TEXT NOT NULL,          -- aviso, grave
  titulo TEXT NOT NULL,
  texto TEXT NOT NULL,
  acao TEXT,                        -- o que o sistema fez sozinho (ou NULL)
  enviado_em TEXT,                  -- quando foi por e-mail
  criado_em TEXT NOT NULL,
  UNIQUE (dia, chave)
);

-- Plano da semana do Estrategista (um por semana ISO).
CREATE TABLE IF NOT EXISTS ads_planos (
  semana TEXT PRIMARY KEY,          -- AAAA-Www
  dia TEXT NOT NULL,
  modelo TEXT,
  plano_json TEXT NOT NULL,
  resumo TEXT NOT NULL,
  criado_em TEXT NOT NULL
);

-- Relatório semanal do Relator (texto para gente, mais os números usados).
CREATE TABLE IF NOT EXISTS relatorios (
  semana TEXT PRIMARY KEY,
  dia TEXT NOT NULL,
  modelo TEXT,
  texto TEXT NOT NULL,
  dados_json TEXT NOT NULL,
  enviado_para TEXT,                -- e-mails, separados por vírgula
  criado_em TEXT NOT NULL
);

-- Públicos personalizados criados na Meta a partir do pagamento (e o semelhante gerado deles).
CREATE TABLE IF NOT EXISTS ads_publicos (
  nome TEXT PRIMARY KEY,            -- clientes_fieis, sairam_cedo, entraram_nao_pagaram, semelhante_fieis
  plataforma TEXT NOT NULL,
  publico_id TEXT,                  -- id na plataforma
  tipo TEXT NOT NULL,               -- lista, semelhante
  pessoas INTEGER,                  -- quantas pessoas da última sincronização
  resposta TEXT,
  atualizado_em TEXT NOT NULL
);

INSERT OR IGNORE INTO agentes_estado (agente, nivel, parado, atualizado_em, atualizado_por) VALUES
  ('estrategista', 2, 0, '2026-10-29T00:00:00.000Z', 'migração'),
  ('relator', 2, 0, '2026-10-29T00:00:00.000Z', 'migração'),
  ('publicos', 1, 0, '2026-10-29T00:00:00.000Z', 'migração');
UPDATE agentes_estado SET nivel = 2 WHERE agente = 'vigia' AND nivel = 0;
