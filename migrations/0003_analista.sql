-- Analista de anúncios (src/analista.ts). Em modo sombra ele decide e registra o que faria, sem executar.
--

-- Estado atual de cada campanha (status e orçamento), puxado junto com o gasto diário (src/anuncios.ts).
CREATE TABLE IF NOT EXISTS ads_campanhas (
  plataforma TEXT NOT NULL,         -- meta, google
  campanha_id TEXT NOT NULL,
  campanha TEXT NOT NULL,
  status TEXT NOT NULL,             -- ACTIVE, PAUSED, ... (como a plataforma devolve)
  orcamento_diario_cents INTEGER,   -- NULL quando o orçamento é vitalício ou fica no conjunto
  objetivo TEXT,
  atualizado_em TEXT NOT NULL,
  PRIMARY KEY (plataforma, campanha_id)
);

-- Uma linha por decisão por dia de análise. modo = 'sombra' (só registrado) ou 'executado'.
CREATE TABLE IF NOT EXISTS ads_decisoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dia TEXT NOT NULL,                -- dia da análise (Brasília)
  plataforma TEXT,                  -- NULL nas decisões da conta inteira
  campanha_id TEXT,
  campanha TEXT,
  tipo TEXT NOT NULL,               -- manter, pausar, reduzir, alerta_teto, resumo
  motivo TEXT NOT NULL,             -- frase para gente ler
  bloqueio TEXT,                    -- regra que impediria executar (ex.: frequencia), ou NULL
  dados_json TEXT NOT NULL,         -- números que levaram à decisão
  modo TEXT NOT NULL,               -- sombra, executado
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ads_decisoes_dia ON ads_decisoes(dia);
CREATE INDEX IF NOT EXISTS idx_ads_decisoes_campanha ON ads_decisoes(campanha_id, dia);
