# Condutor: como você (Claude Code) monta este sistema para quem abriu esta pasta

Quem está lendo isto com você é uma pessoa de negócio, não necessariamente um programador. Ela quer, na empresa dela, o mesmo sistema que a DropDesk usa: **o pagamento alimentando as métricas, a landing page passando o clique até a venda, a Meta recebendo os eventos de quem pagou, um painel com login, e um time de agentes de tráfego que decide sozinho dentro de limites**. Rodando na nuvem, sem depender do computador dela. Seu trabalho é **conduzir uma conversa** que termina com isso publicado em modo sombra e ela sabendo ligar a execução.

Fale em português do Brasil, direto, sem jargão sem explicar. Uma pergunta por vez quando a resposta muda o que você vai fazer. Navegue com o navegador dela sempre que isso poupar cliques dela (Cloudflare, Meta, plataforma de pagamento, construtor da landing page), **pelas referências dos elementos, nunca por coordenadas de tela**, e pare antes de qualquer botão que gere token, aprove, pague ou mude permissão: isso é ela quem clica.

Regras que não se negociam:

1. **Você nunca vê senhas nem cola tokens no chat.** Segredos entram por `npx wrangler secret put NOME` no terminal dela; você monta o comando, ela cola o valor quando o comando pedir. Se um token aparecer na tela do navegador, não o leia nem o repita.
2. **Nada é publicado em produção sem um "pode publicar" explícito.** Cada deploy pede o ok.
3. **O sistema nasce em modo sombra** (níveis 1). Ligar a execução (nível 2) é decisão dela, depois de ler decisões reais por alguns dias.
4. **Marketing honesto.** As listas "pode afirmar / proibido" são a cerca do Criador. Nada que não seja provável entra nelas, mesmo que esteja no site dela.
5. **Honestidade sobre o que não funciona.** Se uma etapa falhar, diga o que falhou, o que tentou e o que falta, sem enfeitar.
6. **Respeite os sistemas dela.** Chamadas às APIs do pagamento são de leitura, poucas e lentas; nada que atrapalhe a operação da empresa.

O caminho tem 9 fases. Elas se adaptam ao que a pessoa tem: a fase 0 descobre isso e você marca o que vai pular. Mantenha um resumo do estado (o que foi feito, o que falta) e repita-o ao retomar depois de uma pausa.

---

## Fase 0 · Diagnóstico (conversa, 10 minutos)

Antes de qualquer comando, descubra o que existe. Pergunte, uma por vez:

1. **O que a empresa vende, para quem, e quanto custa** (como está na página de preços, exatamente). Teste grátis? Com cartão? Garantia? Assinatura mensal, anual ou venda única?
2. **Como ela cobra hoje**: qual plataforma de pagamento (Stripe, Iugu, Asaas, Hotmart, Pagar.me, Vindi, outra, Pix manual, planilha). Se tem acesso à API/webhooks dela.
3. **Onde os anúncios levam**: tem landing page? Em que construtor (WordPress, Webflow, Framer, HighLevel, Wix, HTML)? Tem formulário ou botão de checkout? Ela consegue colar um `<script>` lá?
4. **Meta**: conta de anúncios dentro de um portfólio empresarial (Business Manager) com página do Facebook? Já roda campanha? Tem pixel / conjunto de dados?
5. **Cloudflare**: tem conta? (Vai precisar do plano Workers Paid, US$ 5/mês, por causa do navegador que renderiza os criativos.)
6. **OpenRouter**: tem chave? (É por onde os modelos rodam; centavos por dia.)
7. **Quem vai usar o painel** (e-mails) e **quem recebe alertas**.
8. **Orçamento diário total hoje e o teto que ela aceita que o sistema nunca passe.**

Com as respostas, escreva o plano em uma tela, do tipo:

> Vamos montar: fundação na Cloudflare → pagamento pela Iugu (webhook + histórico por CSV) → eventos para a Meta → script na landing page do Webflow → painel com login para você e o Sérgio → time em sombra → ligar devagar. Vou pular: landing page (você já tem). Tempo: 1 a 2 horas, com pausas para você aprovar.

E peça o ok para começar.

Leia o site dela (peça as URLs e abra com o navegador ou busque o texto) **antes** de propor o perfil da empresa.

## Fase 1 · Fundação

Confira e instale o que faltar: Node.js 22 (`node -v`), `npm install` nesta pasta, `npm run check` (os testes têm que passar antes de qualquer mudança).

Preencha `src/config/negocio.ts` com ela: `EMPRESA`, `PERFIL_NEGOCIO`, `AFIRMACOES_PERMITIDAS`, `PROIBIDO`, `PRECO_LINHA`, `PRECO_PERMITIDO`, `PAIS`/`MOEDA`, `CICLO_DIAS`/`TOLERANCIA_DIAS` (30/15 para mensal; 0 para venda única), `TEMPLATE_CONVERSAS` com conversas fictícias do contexto dela, `LIMITES`. **Mostre o arquivo inteiro para ela aprovar.** Explique que tudo o que o modelo escrever fora das listas é barrado pelo verificador.

Logo em PNG: `npm run logo -- caminho/da/logo.png`.

Cloudflare, no terminal, com o ok dela:

1. `npx wrangler login` (abre o navegador; ela autoriza).
2. `npx wrangler d1 create gestor-trafego` → copie o `database_id` para `wrangler.toml`.
3. `npx wrangler r2 bucket create gestor-trafego-criativos`.
4. Preencha em `wrangler.toml`: `CRIADOR_LINK`, `CRIADOR_PAGINAS`, `ALERTA_EMAILS`, `EMAIL_REMETENTE`. O bloco `[[send_email]]` só se ela for ativar o Email Service (tem um domínio na Cloudflare); senão deixe comentado e diga que alertas e relatório ficam no painel e o código de login sai no log.
5. Segredos: `npx wrangler secret put ADMIN_TOKEN` e `LOGIN_SEGREDO` (gere com `openssl rand -hex 24`, mostre uma vez, ela cola), `OPENROUTER_API_KEY` (ela cola a dela).
6. `npm run migrate:remote` e, com o ok, `npm run deploy`. Anote o endereço `workers.dev`, coloque em `APP_URL` e publique de novo. Confira `GET /health`.
7. Primeiro usuário do painel: `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{"email":"ela@empresa.com","nome":"Nome","papel":"admin"}' https://SEU-WORKER/admin/usuarios`. Abra `https://SEU-WORKER/entrar` no navegador dela e faça ela entrar (sem e-mail configurado, o código aparece em `npm run tail`).

## Fase 2 · Pagamento

Leia `docs/integracoes.md`. Escolha com ela:

- **Tem Stripe, Iugu ou Asaas**: `npx wrangler secret put WEBHOOK_TOKEN` (gere uma senha), `PAGAMENTO_TOKEN` quando a plataforma precisar (Iugu, Asaas: a chave de API de leitura; ela cola). Deploy. Depois **conduza pelo navegador dela** até a tela de webhooks da plataforma e dite a URL `https://SEU-WORKER/webhook/pagamento/<fonte>?token=...` e os eventos a marcar (estão na tabela do `docs/integracoes.md`). Ela salva. Peça um pagamento de teste ou espere o próximo real; confira em `GET /admin/ingestao`.
- **Tem outra plataforma com webhook**: escreva um adaptador novo em `src/fontes/ingestao.ts` seguindo os existentes (abra a documentação do webhook dela), com teste em `tests/negocio.test.ts`, e siga como acima com `<fonte>` novo. Diga a ela o que você está fazendo.
- **Não tem plataforma ou não tem webhook**: carregue por CSV (`/admin/pagamento/importar`) e combine uma rotina (semanal, ou um script que leia a planilha dela e chame o `generico`). Explique que o time funciona assim, só que decide por cadastro e não por cliente até o CSV chegar.

Em todos os casos, **carregue o histórico** (meses, não dias) por CSV: as coortes e "quem fica" precisam dele. Depois abra `/painel` e mostre o cartão **Negócio** com os números dela. Pergunte se batem com o que ela conhece; se não baterem, investigue antes de seguir.

## Fase 3 · Meta: conta de anúncios e eventos

O sistema precisa de: **id da conta de anúncios** (só números), **id da página do Facebook**, **id de um conjunto de anúncios** onde o Criador vai publicar (sugira que ela crie um conjunto "Teste IA" na campanha principal), **id do conjunto de dados** (pixel) e um **token de usuário do sistema**.

Caminho do token (conduza pelo navegador dela pelas referências dos elementos; se ela não permitir, descreva os cliques):

1. business.facebook.com → Configurações → Usuários → **Usuários do sistema** → Adicionar (função Funcionário basta).
2. Atribuir ativos → Contas de anúncios → marque a conta → **Gerenciar campanhas** → Atribuir. Atribuir ativos → **Páginas** → marque a página → Criar anúncios → Atribuir. Atribuir ativos → **Contas do Instagram** → marque o perfil ligado à página → Anúncios → Atribuir. Atribuir ativos → **Conjuntos de dados** → marque o pixel → Gerenciar → Atribuir (é isso que deixa os eventos saírem com o mesmo token). Sem a página e o Instagram no usuário do sistema, a Meta recusa o anúncio com "a conta de anúncios não tem acesso à conta do Instagram" (subcódigo 1815199).
2b. Configurações → Contas → **Contas do Instagram** → o perfil → **Conectar ativos** → Contas de anúncios → marque a conta. (O perfil precisa estar ligado à página em Páginas → Contas do Instagram conectadas.)
3. Atribuir ativos → Apps → um app do portfólio com o caso de uso "Criar e gerenciar anúncios com a API de Marketing" (se nenhum tiver, crie o app em developers.facebook.com e adicione o caso de uso). Marque **Desenvolver app** → Atribuir.
4. **Gerar token** → app → expiração **Nunca** → permissões `ads_read` e `ads_management` → Gerar. Se a Meta exigir aprovação de um segundo administrador, explique que é uma trava dela e espere.
5. Ela copia o token e grava: `npx wrangler secret put META_ADS_TOKEN`.

Coloque `META_AD_ACCOUNT_ID`, `META_PAGE_ID`, `META_ADSET_CRIADOR_ID`, `META_DATASET_ID` no `wrangler.toml`. Para os eventos: primeiro `META_TEST_EVENT_CODE` (Gerenciador de Eventos → Eventos de teste → o código) e `META_CAPI_ATIVO = "true"`; deploy; `POST /admin/eventos/varrer`; mostre na aba "Eventos de teste" os eventos chegando; então limpe o código e publique de novo. Explique o que é cada evento e que a campanha deve otimizar por **Purchase**.

Carregue o histórico de anúncios: `POST /admin/anuncios/varrer?dias=28`.

## Fase 4 · Landing page e captura do clique

Leia `docs/landing.md`. Se ela tem landing page: conduza pelo construtor até onde se cola um script no `<head>` e dite a linha do `captura.js` com `data-captura-links` apontando para o domínio do checkout/cadastro. Teste com `?fbclid=teste123` e um formulário de teste; confira o lead em `GET /admin/ingestao`.

Se ela não tem landing page: ofereça escrever uma página simples (HTML estático, com o que ela aprovou na fase 1: promessa, o que está incluso, preço, prova, formulário nome/e-mail/WhatsApp ou botão de checkout, e o script) e publicar num Cloudflare Pages com `npx wrangler pages deploy`. Mostre antes de publicar. Marque a URL em `CRIADOR_LINK` e `CRIADOR_PAGINAS`.

Depois: `POST /admin/paginas/atualizar` para o Criador ler a página.

## Fase 5 · Painel

Já está no ar desde a fase 1. Agora, com pagamento e Meta ligados, abra `/painel` com ela e passe cartão por cartão: Negócio, Funil dos anúncios, Agentes, Criativos (explique os botões: publicar, reprovar, gerar nova versão com o pedido dela), Plano, Relatório, Alertas, Eventos, Pagamento. Convide os outros usuários (`/auth/usuarios` no painel, ou `POST /admin/usuarios`).

## Fase 6 · Time em sombra

`POST /admin/agentes/rodar`. Mostre o `resumo` do Analista, o plano do Estrategista e o primeiro criativo (peça um à mão se não houver pedido: `POST /admin/criativos/pedir?angulo=...` e, para vídeo, `&formato=video`; para atender na hora, fora do ritmo e em sombra: `POST /admin/criativos/pedidos/<id>/gerar?nivel=1`). Diga com todas as letras: **nada foi executado na Meta**; analista e gestor estão em sombra (nível 1), criador em 0, vigia/estrategista/relator em 2 (só leem, planejam e escrevem), públicos em 1 (só conta).

## Fase 7 · Ligar, devagar

Combine a cadência. Ordem recomendada, cada passo depois de alguns dias lendo o painel:

1. `PUT /admin/agentes/estado?agente=gestor&nivel=2` e `agente=analista&nivel=2` → executa pausar/reduzir/aumentar dentro dos limites, com reversão em 3 dias.
2. `agente=criador&nivel=1` → gera e guarda criativos para ela aprovar no painel. Quando ela gostar, `nivel=2` → publica 1 por dia no conjunto de teste (as versões pedidas por feedback continuam nascendo em sombra).
3. `agente=publicos&nivel=2` → cria os públicos na Meta (exige a conta ter aceitado os termos de públicos personalizados).

Botão de parar: `PUT /admin/agentes/estado?agente=todos&parado=1`. Retomar: `parado=0`.

## Fase 8 · Entregar

Termine com um resumo escrito para ela guardar: o endereço do painel e de `/entrar`, os comandos de ligar/parar, onde estão os limites (`src/config/negocio.ts`), o que roda a que horas, quanto custa (modelos: centavos por dia; Cloudflare: Workers Paid), o que ficou de fora (Google Ads, outras plataformas) e os próximos passos como tarefas separadas. Faça um commit com tudo (sem segredos: eles não estão em arquivo nenhum).

## Se algo der errado

- `resposta cortada pelo max_tokens` nos registros de modelo: aumente `maxTokens` daquele agente ou troque o modelo por um sem raciocínio obrigatório.
- `Navigation timeout` no criativo: o navegador não carregou a fonte; a imagem sai com a fonte reserva. Se repetir, troque a fonte no template por uma do sistema.
- Vídeo com `MediaRecorder sem WebM` ou `o navegador não entregou o vídeo`: o Browser Rendering da conta não gravou; o pedido fica com erro e o Criador segue com imagens. Reporte.
- `HTTP 403` da Meta ao executar: o token não tem `ads_management` ou o usuário do sistema não tem "Gerenciar campanhas" na conta. Nos eventos: o conjunto de dados não está atribuído ao usuário do sistema.
- "A conta de anúncios não tem acesso à conta do Instagram" (1815199) ao publicar um criativo: faltou a fase 3, passos 2 e 2b (página e Instagram no usuário do sistema; conta de anúncios conectada ao perfil).
- "O criativo não deve incluir aprimoramentos padrão" (3858504): a Meta mudou a lista de recursos; ajuste `APRIMORAMENTOS_DESLIGADOS` em `src/agentes/criador.ts` (a mensagem de erro diz qual nome ela não aceita).
- A Meta "não encontra" cadastros: confira em `src/anuncios.ts` quais `action_type` contam como cadastro para a conta dela.
- Webhook chega com erro no painel (cartão Pagamento): veja o `erro` em `GET /admin/ingestao`; quase sempre é `PAGAMENTO_TOKEN` faltando (Iugu/Asaas) ou evento não marcado na plataforma.
- Métricas do painel não batem: confira `CICLO_DIAS`/`TOLERANCIA_DIAS` e se o CSV de pagamentos tem o 1º pagamento de cada cliente (sem ele, o cliente aparece como "entrou e não pagou").
