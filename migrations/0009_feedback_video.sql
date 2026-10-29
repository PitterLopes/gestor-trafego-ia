-- Aprovação e feedback dos criativos no painel, e anúncios em vídeo (chat animado gravado no navegador).
ALTER TABLE ads_criativos ADD COLUMN feedback TEXT;        -- o que a pessoa pediu para melhorar
ALTER TABLE ads_criativos ADD COLUMN criativo_pai INTEGER; -- de qual criativo esta versão nasceu
ALTER TABLE ads_criativos ADD COLUMN revisado_por TEXT;
ALTER TABLE ads_criativos ADD COLUMN revisado_em TEXT;
ALTER TABLE ads_criativos ADD COLUMN formato TEXT NOT NULL DEFAULT 'imagem';   -- imagem | video
ALTER TABLE ads_criativos ADD COLUMN video_chave TEXT;     -- R2: criativos/<id>.webm
ALTER TABLE ads_criativos ADD COLUMN video_id TEXT;        -- id do vídeo na Meta
ALTER TABLE ads_criativos ADD COLUMN capa_chave TEXT;      -- R2: criativos/<id>-capa.png
ALTER TABLE ads_pedidos_criativo ADD COLUMN criativo_pai INTEGER;
ALTER TABLE ads_pedidos_criativo ADD COLUMN formato TEXT NOT NULL DEFAULT 'imagem';
