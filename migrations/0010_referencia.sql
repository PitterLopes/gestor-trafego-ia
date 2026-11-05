-- Pasta de referência do time de tráfego: o pedido de criativo pode apontar o anúncio da conta que serve de base
-- (os mais fortes em cadastro, ou um escolhido à mão). Imagens e análises ficam no R2 (referencia/). Nada aqui chama a Iugu.
ALTER TABLE ads_pedidos_criativo ADD COLUMN anuncio_base TEXT;   -- id do anúncio na Meta que a variação segue
ALTER TABLE ads_criativos ADD COLUMN anuncio_base TEXT;
