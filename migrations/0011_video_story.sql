-- Vídeo do Criador em dois formatos: o principal (video_chave) é o 1:1 do feed; o story (9:16) fica ao lado e
-- entra no mesmo anúncio pela personalização por posicionamento. Nada aqui chama a Iugu.
ALTER TABLE ads_criativos ADD COLUMN video_story_chave TEXT;   -- R2: criativos/<id>-story.webm
ALTER TABLE ads_criativos ADD COLUMN capa_story_chave TEXT;    -- R2: criativos/<id>-story-capa.png
ALTER TABLE ads_criativos ADD COLUMN video_story_id TEXT;      -- id do vídeo 9:16 na Meta
