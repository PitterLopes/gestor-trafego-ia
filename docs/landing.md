# Landing page: do clique ao pagamento

Para a Meta otimizar por **cliente que pagou** (e não por formulário), o clique do anúncio precisa chegar até o pagamento. O caminho é: anúncio → landing page (guarda o `fbclid`) → formulário ou botão de checkout (leva o `fbclid` junto) → pagamento (o cliente nasce com o `fbclid`) → evento `Purchase` com `fbc`.

Isto vale para qualquer construtor de página (WordPress, Webflow, Framer, HighLevel, Wix, HTML puro): só precisa aceitar um `<script>`.

## 1. Coloque o script na landing page

```html
<script src="https://SEU-WORKER/captura.js" data-captura-links="checkout.suaplataforma.com,app.suaempresa.com"></script>
```

O que ele faz, sozinho:

- guarda `fbclid`, `gclid` e `utm_*` que vieram na URL do anúncio (no navegador, por 90 dias);
- preenche campos ocultos com esses nomes em todo formulário da página (crie-os no construtor se quiser que o valor chegue ao seu CRM; se não existirem, ele cria);
- acrescenta os mesmos parâmetros aos links que apontam para os domínios em `data-captura-links` (o checkout, o cadastro do app), para a sua plataforma de pagamento receber o `fbclid` na URL;
- quando um formulário com e-mail ou telefone é enviado, manda um **lead** para `POST /lead` do Worker (`email`, `telefone`, `nome`, `fbclid`, `gclid`, `fbp`, `utm`, página).

Quando o mesmo e-mail ou telefone aparece no pagamento (webhook ou CSV), o cliente **herda o clique** do lead automaticamente, mesmo que a plataforma de pagamento não tenha guardado nada.

Se o formulário for de um construtor que não dispara o evento `submit` da página (alguns widgets), chame à mão: `gtCaptura.enviarLead({ email, telefone, nome })`.

## 2. Se a sua plataforma de pagamento aceita campos extras

Melhor ainda: passe o `fbclid` para dentro do cliente. No Stripe, grave em `metadata.fbclid` no checkout; no genérico, mande `fbclid` no cliente. Aí a atribuição não depende de bater e-mail.

## 3. O que a landing page precisa dizer

O Criador lê as páginas em `CRIADOR_PAGINAS` e só escreve anúncios com o que elas prometem (e com o que está em `AFIRMACOES_PERMITIDAS`). Então a página é a fonte de verdade: preço exato, o que está incluso, condições do teste/garantia, provas verificáveis (avaliações com fonte). Se a página promete o que o anúncio não pode, o verificador barra o anúncio; se a página não diz, o Criador não inventa.

Se você ainda não tem landing page, o Claude Code pode escrever uma página simples (HTML estático) a partir das suas respostas do Passo 1 do `CLAUDE.md` e publicá-la num Cloudflare Pages; o importante é ter um formulário (nome, e-mail, WhatsApp) ou um botão de checkout, com este script.

## 4. Confira

Abra a landing page com `?fbclid=teste123&utm_campaign=x`, preencha o formulário com um e-mail de teste e veja em `GET /admin/ingestao` (ou no painel, cartão "Pagamento") se o lead chegou. Depois mande um pagamento de teste pelo webhook com o mesmo e-mail: o cliente aparece com `fbclid = teste123`.
