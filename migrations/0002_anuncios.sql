-- Gasto diário por campanha, puxado das plataformas de anúncio (src/anuncios.ts). É a base do analista de
-- anúncios: custo por cadastro, por cliente e por cliente retido.
-- A tela Anúncios (saas_ads) continua sendo o total mensal digitado pelos sócios; esta tabela não mexe nela.
CREATE TABLE IF NOT EXISTS ads_gasto_diario (
  dia TEXT NOT NULL,                -- AAAA-MM-DD, no fuso da conta de anúncios
  plataforma TEXT NOT NULL,         -- meta, google
  campanha_id TEXT NOT NULL,
  campanha TEXT NOT NULL,
  gasto_cents INTEGER NOT NULL,
  impressoes INTEGER NOT NULL DEFAULT 0,
  cliques INTEGER NOT NULL DEFAULT 0,
  resultados INTEGER NOT NULL DEFAULT 0, -- cadastros (lead) no Meta
  atualizado_em TEXT NOT NULL,
  PRIMARY KEY (dia, plataforma, campanha_id)
);
CREATE INDEX IF NOT EXISTS idx_ads_gasto_dia ON ads_gasto_diario(dia);
