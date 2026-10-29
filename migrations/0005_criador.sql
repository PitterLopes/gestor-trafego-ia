-- Criador de anúncios (src/agentes/criador.ts): pedidos do Analista e os criativos gerados.
--

-- Pedido de criativo novo, escrito pelo Analista no plano do dia. status: pendente → atendido | recusado | expirado
CREATE TABLE IF NOT EXISTS ads_pedidos_criativo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dia TEXT NOT NULL,
  origem TEXT NOT NULL,             -- analista_ia, manual
  plataforma TEXT NOT NULL,
  campanha_id TEXT,
  campanha TEXT,
  angulo TEXT NOT NULL,             -- a ideia central do anúncio, em uma frase
  motivo TEXT NOT NULL,
  status TEXT NOT NULL,
  criativo_id INTEGER,              -- ads_criativos.id quando atendido
  recusa TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ads_pedidos_status ON ads_pedidos_criativo(status, dia);

-- Um criativo gerado: copy (JSON), verificação (JSON), imagem no R2 e, quando publicado, os ids na plataforma.
--   status: sombra (gerado e guardado, não publicado) | reprovado (verificador barrou) | publicado | erro
CREATE TABLE IF NOT EXISTS ads_criativos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dia TEXT NOT NULL,
  pedido_id INTEGER,
  plataforma TEXT NOT NULL,
  campanha_id TEXT,
  conjunto_id TEXT,
  angulo TEXT NOT NULL,
  modelo TEXT,                      -- modelo que escreveu a copy
  copy_json TEXT NOT NULL,
  verificacao_json TEXT,
  imagem_chave TEXT,                -- chave no R2 (criativos/<id>.png)
  imagem_hash TEXT,                 -- hash da imagem na Meta
  creative_id TEXT,
  ad_id TEXT,
  status TEXT NOT NULL,
  resposta TEXT,
  criado_em TEXT NOT NULL,
  publicado_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_ads_criativos_dia ON ads_criativos(dia, status);
