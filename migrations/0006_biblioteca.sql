-- Aprendizado do Criador: anúncios da conta (texto e desempenho) e resumo das landing pages.
--

-- Cada anúncio da conta, com o texto do criativo (o que a Meta devolve) e o status. Atualizado na coleta diária.
CREATE TABLE IF NOT EXISTS ads_anuncios (
  plataforma TEXT NOT NULL,
  anuncio_id TEXT NOT NULL,
  anuncio TEXT NOT NULL,
  campanha_id TEXT,
  conjunto_id TEXT,
  status TEXT,
  creative_id TEXT,
  titulo TEXT,
  texto TEXT,
  descricao TEXT,
  imagem_url TEXT,
  atualizado_em TEXT NOT NULL,
  PRIMARY KEY (plataforma, anuncio_id)
);

-- Gasto e cadastros por anúncio e por dia (mesma lógica de ads_gasto_diario, um nível abaixo).
CREATE TABLE IF NOT EXISTS ads_anuncio_diario (
  dia TEXT NOT NULL,
  plataforma TEXT NOT NULL,
  anuncio_id TEXT NOT NULL,
  gasto_cents INTEGER NOT NULL,
  impressoes INTEGER NOT NULL DEFAULT 0,
  cliques INTEGER NOT NULL DEFAULT 0,
  resultados INTEGER NOT NULL DEFAULT 0,
  atualizado_em TEXT NOT NULL,
  PRIMARY KEY (dia, plataforma, anuncio_id)
);
CREATE INDEX IF NOT EXISTS idx_ads_anuncio_diario_dia ON ads_anuncio_diario(dia);

-- Resumo de cada landing page (feito pelo modelo a partir do texto da página), renovado toda semana.
CREATE TABLE IF NOT EXISTS paginas_resumo (
  url TEXT PRIMARY KEY,
  texto_hash TEXT NOT NULL,         -- SHA-256 do texto extraído: página igual não gasta modelo de novo
  resumo_json TEXT NOT NULL,
  modelo TEXT,
  atualizado_em TEXT NOT NULL,
  erro TEXT
);
