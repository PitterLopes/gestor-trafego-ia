-- Time de tráfego com IA (src/agentes/). O modelo propõe, o código valida e o Gestor executa dentro dos limites.
--

-- Estado de cada agente: nível de autonomia e botão de parar. Uma linha por agente; o cron lê antes de rodar.
--   nivel: 0 = só lê e relata, 1 = decide e registra (sombra), 2 = executa dentro dos limites
--   parado = 1: o agente não roda (botão de parar). "todos" é o botão geral.
CREATE TABLE IF NOT EXISTS agentes_estado (
  agente TEXT PRIMARY KEY,          -- todos, analista, gestor, criador, vigia, estrategista, publicos, relator
  nivel INTEGER NOT NULL DEFAULT 1,
  parado INTEGER NOT NULL DEFAULT 0,
  atualizado_em TEXT NOT NULL,
  atualizado_por TEXT
);
INSERT OR IGNORE INTO agentes_estado (agente, nivel, parado, atualizado_em, atualizado_por) VALUES
  ('todos', 2, 0, '2026-10-29T00:00:00.000Z', 'migração'),
  ('analista', 1, 0, '2026-10-29T00:00:00.000Z', 'migração'),
  ('gestor', 1, 0, '2026-10-29T00:00:00.000Z', 'migração'),
  ('criador', 0, 0, '2026-10-29T00:00:00.000Z', 'migração'),
  ('vigia', 0, 0, '2026-10-29T00:00:00.000Z', 'migração');

-- Fila de ações: quem pediu (analista, regras, vigia, criador, reversao), o que fazer e o que aconteceu.
--   status: pendente → executada | recusada (não passou nos limites) | ensaio (nível 1: registrada, não executada)
--           | erro | revertida (o Gestor desfez depois de piorar) | cancelada
CREATE TABLE IF NOT EXISTS ads_acoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dia TEXT NOT NULL,                -- dia da decisão (Brasília)
  origem TEXT NOT NULL,             -- analista_ia, regras, vigia, criador, reversao
  plataforma TEXT NOT NULL,         -- meta, google
  alvo_tipo TEXT NOT NULL,          -- campanha, conjunto, anuncio
  alvo_id TEXT NOT NULL,
  alvo_nome TEXT,
  tipo TEXT NOT NULL,               -- pausar, ativar, reduzir, aumentar, orcamento
  valor_cents INTEGER,              -- orçamento diário novo (reduzir, aumentar, orcamento)
  valor_anterior_cents INTEGER,     -- orçamento diário antes da ação (para reverter)
  motivo TEXT NOT NULL,
  confianca REAL,                   -- 0 a 1, quando veio do modelo
  status TEXT NOT NULL,
  recusa TEXT,                      -- limite que barrou (teto, frequencia, alvo, valor, nivel, parado)
  baseline_json TEXT,               -- métricas dos 7 dias antes da ação (para a reversão comparar)
  resposta TEXT,                    -- resposta da plataforma ou erro
  executada_em TEXT,
  revisar_em TEXT,                  -- quando o Gestor volta para comparar com o baseline
  revertida_por INTEGER,            -- id da ação inversa, quando houve
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ads_acoes_status ON ads_acoes(status, revisar_em);
CREATE INDEX IF NOT EXISTS idx_ads_acoes_alvo ON ads_acoes(alvo_id, dia);

-- Cada chamada de modelo: o que foi pedido, o que voltou, quanto custou. Teto diário de custo no código.
CREATE TABLE IF NOT EXISTS llm_chamadas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agente TEXT NOT NULL,
  modelo TEXT NOT NULL,             -- id na OpenRouter que respondeu
  ok INTEGER NOT NULL,
  tokens_entrada INTEGER,
  tokens_saida INTEGER,
  custo_usd REAL,
  duracao_ms INTEGER,
  entrada TEXT,                     -- prompt do usuário (o dossiê), cortado em 20 mil caracteres
  saida TEXT,                       -- resposta bruta, cortada em 20 mil caracteres
  erro TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_chamadas_dia ON llm_chamadas(criado_em);

-- Registro de cada passada do time (um por agente por rodada), para o painel e o runbook.
CREATE TABLE IF NOT EXISTS agentes_execucoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agente TEXT NOT NULL,
  dia TEXT NOT NULL,
  gatilho TEXT NOT NULL,            -- cron, manual
  ok INTEGER NOT NULL,
  resumo TEXT,                      -- frase para gente ler
  detalhes_json TEXT,
  duracao_ms INTEGER,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agentes_execucoes_dia ON agentes_execucoes(dia, agente);
