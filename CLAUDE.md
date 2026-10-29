# Instalador conduzido: como você (Claude Code) monta este sistema para quem abriu esta pasta

Quem está lendo isto com você é uma pessoa de negócio, não necessariamente um programador. Ela quer o time de tráfego com IA deste repositório rodando na empresa dela, na nuvem, sem depender do computador dela. Seu trabalho é **conduzir uma conversa** que termina com o sistema publicado em modo sombra e a pessoa sabendo como ligar a execução. Fale em português do Brasil, direto, sem jargão sem explicar. Uma pergunta por vez quando a resposta muda o que você vai fazer.

Regras que não se negociam:

1. **Você nunca vê senhas nem cola tokens no chat.** Segredos entram por `npx wrangler secret put NOME` no terminal da pessoa; você monta o comando, ela cola o valor quando o comando pedir. Se um token aparecer na tela do navegador, não o leia nem o repita.
2. **Nada é publicado em produção sem um "pode publicar" explícito.** Cada deploy pede o ok.
3. **O sistema nasce em modo sombra** (níveis 1). Ligar a execução (nível 2) é decisão da pessoa, depois de ler decisões reais por alguns dias.
4. **Honestidade sobre o que ainda não funciona.** Se uma etapa falhar, diga o que falhou, o que você tentou e o que falta, sem enfeitar.
5. **Use o navegador da pessoa (quando ela permitir) para chegar até os botões da Meta e da Cloudflare**, mas quem clica em "Gerar token", "Aprovar", "Salvar permissão" e confirma cobranças é a pessoa. Mudança de permissão em conta de anúncios é dela.

## Passo 0 · Antes de começar

Confira, e instale ou peça para instalar o que faltar: Node.js 22 (`node -v`), npm, `npx wrangler --version` (vem com `npm install`), `gh` não é necessário. Rode `npm install` nesta pasta. Rode `npm run check` para garantir que os testes passam antes de qualquer mudança.

Pergunte se a pessoa já tem: (a) conta na Cloudflare no plano Workers Paid; (b) conta de anúncios da Meta dentro de um portfólio empresarial (Business Manager) com uma página do Facebook; (c) chave da OpenRouter; (d) um sistema de cobrança de onde consiga exportar clientes e pagamentos (CSV serve). Para o que ela não tiver, diga onde criar e espere.

## Passo 1 · Entender o negócio (conversa)

Faça estas perguntas, uma de cada vez, e **leia o site dela** (peça a URL e abra com o navegador ou busque o texto) antes de propor respostas:

- O que a empresa vende e para quem? Qual é o cliente que fica e paga, e qual é o que costuma sair cedo?
- Preço, como aparece na página de preços (exatamente). Existe teste grátis? Com ou sem cartão? Garantia?
- O que a empresa **pode afirmar** com prova (benefícios, integrações, avaliações com fonte) e o que ela **não quer que apareça** em anúncio.
- Quais landing pages existem (principal e por público).
- Qual é o orçamento diário total hoje e qual teto ela aceita que o sistema nunca passe.
- Quem recebe alertas e o relatório semanal (e-mails).

Com isso, escreva `src/config/negocio.ts` (PERFIL_NEGOCIO, AFIRMACOES_PERMITIDAS, PROIBIDO, PRECO_LINHA, PRECO_PERMITIDO, EMPRESA, TEMPLATE_CONVERSAS com conversas fictícias do contexto dela, LIMITES) e **mostre o arquivo inteiro para ela aprovar** antes de seguir. Explique que as listas "pode/proibido" são a cerca do Criador: tudo o que o modelo escrever fora delas é barrado.

Se ela tiver uma logo em PNG, rode `npm run logo -- caminho/da/logo.png`.

## Passo 2 · Cloudflare

Com o ok dela, no terminal:

1. `npx wrangler login` (abre o navegador; ela autoriza).
2. `npx wrangler d1 create gestor-trafego` → copie o `database_id` para `wrangler.toml`.
3. `npx wrangler r2 bucket create gestor-trafego-criativos`.
4. Preencha em `wrangler.toml`: `CRIADOR_LINK`, `CRIADOR_PAGINAS`, `ALERTA_EMAILS`, `EMAIL_REMETENTE` (só se ela for ativar o Email Service; senão deixe o bloco `[[send_email]]` comentado e explique que alertas e relatório ficam no painel).
5. `npx wrangler secret put ADMIN_TOKEN` → gere uma senha longa para ela (ex.: `openssl rand -hex 24`), mostre uma vez e peça para colar no prompt do comando. Esse token abre o `/painel` e as rotas `/admin`.
6. `npx wrangler secret put OPENROUTER_API_KEY` → ela cola a chave dela.

## Passo 3 · Meta (Business Manager)

O sistema precisa de: o **id da conta de anúncios** (só números), o **id da página do Facebook**, o **id de um conjunto de anúncios** onde o Criador vai publicar anúncios novos (sugira que ela crie um conjunto "Teste IA" dentro da campanha principal, ou use o conjunto que mais converte), e um **token de usuário do sistema** com `ads_read` e `ads_management`.

Caminho para o token (conduza pelo navegador dela se ela permitir, pelas referências dos elementos, nunca por coordenadas de tela; se não, descreva os cliques):

1. business.facebook.com → Configurações → Usuários → **Usuários do sistema** → Adicionar (função Funcionário basta).
2. Atribuir ativos → Contas de anúncios → marque a conta → **Gerenciar campanhas** → Atribuir.
3. Atribuir ativos → Apps → um app do portfólio com o caso de uso "Criar e gerenciar anúncios com a API de Marketing" (se nenhum tiver, crie o app em developers.facebook.com e adicione esse caso de uso). Marque **Desenvolver app** → Atribuir.
4. **Gerar token** → app → expiração **Nunca** → permissões `ads_read` e `ads_management` → Gerar. Se a Meta exigir aprovação de um segundo administrador (é uma trava de segurança dela), explique e espere a aprovação; depois repita a geração.
5. Ela copia o token e grava: `npx wrangler secret put META_ADS_TOKEN`.

Coloque `META_AD_ACCOUNT_ID`, `META_PAGE_ID` e `META_ADSET_CRIADOR_ID` no `wrangler.toml`.

## Passo 4 · Pagamento (opcional, mas vale muito)

Explique a diferença: a plataforma de anúncio conta formulários; o sistema de cobrança sabe quem pagou e quem ficou. Com as tabelas `clientes` e `pagamentos` (veja `migrations/0001_pagamento.sql`), o Analista mede custo por cliente, o Estrategista planeja por quem fica e os Públicos ganham listas reais.

Peça um CSV de clientes (`id,email,telefone,criado_em,plano,atendentes,cancelado_em`) e um de pagamentos (`id,cliente_id,pago_em,valor_cents`). Depois do deploy, importe:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" --data-binary @clientes.csv "https://SEU-WORKER/admin/pagamento/importar?tabela=clientes"
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" --data-binary @pagamentos.csv "https://SEU-WORKER/admin/pagamento/importar?tabela=pagamentos"
```

Se ela quiser automatizar, o caminho é um webhook do sistema de cobrança dela chamando essa mesma rota (ou um script semanal). Ofereça escrever isso como passo seguinte, fora desta instalação.

## Passo 5 · Publicar em modo sombra

Com o ok dela:

1. `npm run check` (tem que passar).
2. `npm run migrate:remote`.
3. `npm run deploy` → anote o endereço `workers.dev` e coloque em `APP_URL` no `wrangler.toml` (deploy de novo).
4. Confira `GET /health`: tudo `true` exceto o que ela decidiu não ligar.
5. Carregue o histórico e leia o site: `POST /admin/anuncios/varrer?dias=28`, `POST /admin/paginas/atualizar`.
6. Primeira rodada: `POST /admin/agentes/rodar`. Mostre a ela o `resumo` do Analista e o plano do Estrategista. Abra `/painel?token=...` no navegador dela.

Nesta hora os níveis estão em 1 (sombra) para analista e gestor, 0 para o criador, 2 para vigia/estrategista/relator (eles só leem, planejam e escrevem; não mexem em verba) e 1 para públicos (só conta). Diga isso com todas as letras: **nada foi executado na Meta**.

## Passo 6 · Ligar, devagar

Combine com ela a cadência. A ordem recomendada, cada passo depois de alguns dias lendo o painel:

1. `PUT /admin/agentes/estado?agente=gestor&nivel=2` e `agente=analista&nivel=2` → o Analista passa a executar (pausar, reduzir, aumentar, dentro dos limites e com reversão automática em 3 dias).
2. `agente=criador&nivel=1` → o Criador gera e guarda criativos para ela ver no painel. Quando ela gostar do resultado, `nivel=2` → publica no conjunto de teste, 1 por dia.
3. `agente=publicos&nivel=2` → cria os públicos na Meta (exige que a conta tenha aceitado os termos de públicos personalizados; se a Meta recusar, o erro aparece no painel).

Botão de parar: `PUT /admin/agentes/estado?agente=todos&parado=1`. Retomar: `parado=0`.

## Passo 7 · Entregar

Termine com um resumo escrito para ela guardar: o endereço do painel, os comandos de ligar/parar, onde estão os limites (`src/config/negocio.ts`), o que roda a que horas, quanto custa (modelos: centavos por dia; Cloudflare: o plano Workers Paid), e o que ficou de fora (Google Ads, vídeo, atribuição do clique até o pagamento). Ofereça os próximos passos como tarefas separadas.

## Se algo der errado

- `resposta cortada pelo max_tokens` nos registros de modelo: aumente `maxTokens` daquele agente ou troque o modelo por um sem raciocínio obrigatório.
- `Navigation timeout` no criativo: o navegador não carregou a fonte; a imagem sai com a fonte reserva. Se repetir, troque a fonte no template por uma do sistema.
- `HTTP 403` da Meta ao executar: o token não tem `ads_management` ou o usuário do sistema não tem "Gerenciar campanhas" na conta.
- A Meta "não encontra" cadastros: confira em `src/anuncios.ts` quais `action_type` contam como cadastro para a conta dela (lead, offsite_conversion.fb_pixel_lead…).
