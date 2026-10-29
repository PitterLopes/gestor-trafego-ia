# Gestor de tráfego com IA

O sistema de marketing de um SaaS, inteiro, num Worker da Cloudflare: **o pagamento alimenta as métricas** (ativos, MRR, coortes, quem fica), **a landing page leva o clique até a venda**, **a Meta recebe os eventos de quem pagou** (para otimizar por cliente, não por formulário), **um painel com login** mostra tudo, e **um time de agentes de tráfego** lê a conta de anúncios, decide o que fazer com cada campanha dentro de limites escritos no código, executa, cria anúncios novos (imagem e vídeo) que você aprova ou manda melhorar no painel, vigia a conta de hora em hora e manda um relatório toda segunda.

Foi construído para a [DropDesk](https://lpdropdesk.com.br) e depois generalizado: **o sistema não sabe nada do seu negócio**. Tudo o que é seu fica em um arquivo de configuração e em variáveis; o pagamento entra por webhook (Stripe, Iugu, Asaas, genérico) ou CSV.

> **O jeito de instalar é conversando com o Claude Code.** Abra esta pasta nele e diga: *"Quero montar este sistema para a minha empresa."* O arquivo `CLAUDE.md` conduz, em fases que se adaptam ao que você tem: diagnóstico → fundação na Cloudflare → pagamento → Meta (anúncios e eventos) → landing page e captura do clique → painel → time em sombra → ligar devagar → entrega. A IA pergunta sobre o seu negócio, lê o seu site, preenche a configuração para você aprovar, navega com você nas telas da Cloudflare, da Meta e do seu sistema de pagamento (sem nunca ver a sua senha), publica em modo sombra e só liga a execução quando você disser.

## O que ele faz

| Agente | O que faz | Quando |
|---|---|---|
| **Coletor** | Puxa gasto, cliques e cadastros por campanha e por anúncio, com o texto de cada criativo | todo dia |
| **Analista** | Lê o dossiê do dia (7 e 28 dias, entradas e clientes do pagamento, plano da semana) e propõe: manter, pausar, reduzir, aumentar, ativar; pede criativo novo quando vê fadiga | todo dia, modelo de IA |
| **Gestor** | O único que escreve na Meta. Executa a fila dentro dos limites, guarda o baseline e reverte sozinho se piorar | todo dia |
| **Criador** | Escreve a copy (aprendendo com os anúncios que funcionam e com a sua landing page), passa por um verificador, renderiza a imagem (HTML → PNG) ou o vídeo (chat animado, canvas → WebM) e publica no conjunto de teste. No painel você publica, reprova ou pede uma nova versão com feedback | quando há pedido |
| **Vigia** | Anúncio reprovado, gasto do dia acima do teto (pausa na hora), campanha sem gasto, erros. Avisa por e-mail | de hora em hora |
| **Estrategista** | Plano da semana: diagnóstico, metas, teto sugerido, ângulos para criativos, prioridades para o Analista | segunda |
| **Relator** | Resumo da semana em português, por e-mail | segunda |
| **Públicos** | Listas do pagamento (fiéis, saíram cedo, entraram e não pagaram) viram públicos personalizados na Meta, mais um semelhante | segunda |

**O princípio:** o modelo propõe em JSON com esquema fixo; o código valida contra os limites e executa. Nenhum prompt consegue estourar o orçamento, porque o teto está na função que chama a API. Se o modelo cair, as regras determinísticas assumem.

**Autonomia que sobe devagar:** cada agente tem um nível. 0 = só lê. 1 = sombra (decide e registra, não executa). 2 = executa. Há um botão de parar tudo.

## O negócio por trás dos anúncios

| Peça | O que faz | Onde ler |
|---|---|---|
| **Pagamento** | Webhook (`stripe`, `iugu`, `asaas`, `generico`) ou CSV → `clientes` e `pagamentos` | [docs/integracoes.md](docs/integracoes.md) |
| **Eventos para a Meta** | `InitiateCheckout`, `Purchase` (1º pagamento), `RenovacaoAssinatura`, sem repetição, com o clique | [docs/integracoes.md](docs/integracoes.md) |
| **Landing page** | `captura.js` guarda `fbclid`/`gclid`/`utm`, preenche formulários, manda o lead; o cliente herda o clique | [docs/landing.md](docs/landing.md) |
| **Métricas** | Ativos, MRR, novos, cancelamentos, churn, coortes, funil gasto → cadastro → entrada → cliente | `src/metricas.ts` |
| **Painel** | Login por e-mail + código, papéis admin/leitor, aprovação de criativos | `/entrar`, `/painel` |

## O que você precisa

- Uma conta na [Cloudflare](https://cloudflare.com) no plano Workers Paid (US$ 5/mês; o navegador que renderiza os criativos exige o plano pago).
- Uma conta de anúncios na Meta num portfólio empresarial, com uma página do Facebook e um conjunto de anúncios onde o Criador possa publicar.
- Uma chave da [OpenRouter](https://openrouter.ai) (é por onde os modelos rodam; custa centavos por dia).
- [Node.js](https://nodejs.org) 22 e o [Claude Code](https://claude.com/claude-code), para instalar.
- O seu sistema de pagamento com webhook (Stripe, Iugu, Asaas, ou outro que o Claude Code adapte), ou pelo menos um CSV de clientes e pagamentos. Sem isso o time decide por cadastro, não por cliente.
- Uma landing page onde dê para colar um `<script>` (ou deixe o Claude Code escrever uma).

## Instalar à mão

O `CLAUDE.md` descreve cada passo em detalhe. O resumo:

1. `npm install`
2. Preencha `src/config/negocio.ts` (quem você é, o que pode afirmar, preço, ciclo de cobrança, limites) e `wrangler.toml` (ids da Meta, conjunto de dados, landing pages, e-mails).
3. `npx wrangler login`, `npx wrangler d1 create gestor-trafego` (cole o id no `wrangler.toml`), `npx wrangler r2 bucket create gestor-trafego-criativos`.
4. Segredos: `npx wrangler secret put ADMIN_TOKEN`, `LOGIN_SEGREDO`, `WEBHOOK_TOKEN`, `META_ADS_TOKEN`, `OPENROUTER_API_KEY` (e `PAGAMENTO_TOKEN` para Iugu/Asaas).
5. `npm run migrate:remote` e `npm run deploy`. Crie o primeiro usuário: `POST /admin/usuarios`.
6. Cadastre o webhook na plataforma de pagamento e importe o histórico por CSV. Cole o `captura.js` na landing page.
7. `POST /admin/anuncios/varrer?dias=28` para carregar o histórico de anúncios, `POST /admin/paginas/atualizar` para ler o site, `POST /admin/agentes/rodar` para a primeira rodada em sombra.
8. Entre em `/entrar` e abra `/painel`. Depois de alguns dias lendo as decisões, suba os níveis: `PUT /admin/agentes/estado?agente=gestor&nivel=2`, e assim por diante.

## Como ele é por dentro

Veja [docs/arquitetura.md](docs/arquitetura.md). Em uma linha: um Worker na Cloudflare com um banco D1, um bucket R2 para imagens e vídeos, o Browser Rendering para o PNG e o WebM, e dois crons. Modelos pela OpenRouter (Claude Sonnet para decidir e escrever, Claude Haiku para verificar e resumir, DeepSeek como reserva), trocáveis por variável.

## Testes

`npm run check` roda a verificação de tipos e a suíte (SQLite em memória, Meta e modelos falsos). Nada nos testes fala com a internet.

## Licença

MIT. Use, mude e venda à vontade; só não diga que a DropDesk endossa o que você fizer com ele.
