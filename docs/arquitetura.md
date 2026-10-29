# Arquitetura

```
 landing page (captura.js)   plataforma de pagamento (webhook / CSV)        Meta Ads (Marketing API)
        │ leads: e-mail, fbclid        │ clientes, pagamentos                   │ gasto, campanhas, anúncios
        ▼                              ▼                                        ▼
 ┌──────────────────────────────── Worker na Cloudflare ──────────────────────────────────┐
 │  D1 (banco)  ·  R2 (imagens e vídeos)  ·  Browser Rendering (HTML → PNG, canvas → WebM)  │
 │                                                                                           │
 │  webhook → grava → eventos para a Meta (Purchase, Renovação, Checkout)  (na hora)         │
 │  03:00  coleta → eventos atrasados → regras → Vigia → Estrategista(seg) → Analista →       │
 │         Gestor → Criador → Públicos(seg) → Relator(seg)                                   │
 │  hh:20  Vigia (teto do dia, reprovações) → Gestor                                         │
 │                                                                                           │
 │  modelos pela OpenRouter (JSON com esquema; principal + reserva; teto de custo/dia)        │
 └──────────┬────────────────────────────────┬──────────────────────────┬────────────────────┘
            │ escreve (Gestor, Criador, Públicos)   │ eventos (API de Conversões)   │ lê
            ▼                                       ▼                              ▼
     Meta Ads (orçamento, status, anúncios)   conjunto de dados da Meta     /painel (login) · /admin · e-mail
```

## Módulos (`src/`)

| Arquivo | Papel |
|---|---|
| `config/negocio.ts` | **Tudo o que é da empresa**: perfil, o que pode/não pode afirmar, preço, ciclo de cobrança, template, limites |
| `fontes/ingestao.ts` | Webhook do pagamento: adaptadores `generico`, `iugu`, `stripe`, `asaas` → `clientes`/`pagamentos`; o cliente herda o clique do lead |
| `fontes/pagamento.ts` | Entradas, clientes, quem seguiu e listas para públicos; importação por CSV |
| `fontes/eventos_meta.ts` | API de Conversões: InitiateCheckout, Purchase, RenovacaoAssinatura, sem repetição, com fbc |
| `captura.ts` | `captura.js` para a landing page e `POST /lead` |
| `metricas.ts` | Ativos, MRR, novos, cancelamentos, churn, coortes (regra do ciclo + tolerância) |
| `login.ts` | Login por e-mail + código, sessões, usuários (admin/leitor) |
| `painel.ts` | A página do painel: negócio, funil, time, criativos com aprovação, plano, relatório, alertas, eventos, ingestão |
| `anuncios.ts` | Coleta da Meta: gasto por campanha e por anúncio, campanhas, texto dos criativos |
| `analista.ts` | Regras determinísticas (o piso) e as janelas de 7/28 dias |
| `agentes/llm.ts` | Cliente OpenRouter: esquema JSON, reserva, raciocínio ligado/desligado, custo, teto diário |
| `agentes/dossie.ts` | O JSON que o Analista recebe |
| `agentes/analista_ia.ts` | Plano do dia → `validarAcoes` (limites) → fila; fallback para as regras |
| `agentes/gestor.ts` | Executa a fila na Meta; níveis; baseline e reversão em 3 dias; botão de parar |
| `agentes/criador.ts` | Copy → verificador → imagem (`templates/escritorio.ts`) ou vídeo (`templates/chat_video.ts`) → R2 → anúncio; aprovação e feedback (`acaoCriativo`) |
| `agentes/render.ts` | Browser Rendering: `renderizarPng` e `renderizarWebm` (a página grava o canvas com MediaRecorder) |
| `agentes/biblioteca.ts` · `paginas.ts` | O que a conta aprendeu com os anúncios; resumo das landing pages |
| `agentes/vigia.ts` · `estrategista.ts` · `relator.ts` · `publicos.ts` · `equipe.ts` | O resto do time e a rodada |
| `index.ts` | Rotas e cron |

## Tabelas (`migrations/`)

`clientes`, `pagamentos`, `leads`, `meta_eventos`, `ingestao_log`, `usuarios`, `login_*` (o negócio) · `ads_gasto_diario`, `ads_campanhas`, `ads_anuncios`, `ads_anuncio_diario` (a plataforma) · `ads_decisoes` (regras) · `agentes_estado`, `ads_acoes`, `llm_chamadas`, `agentes_execucoes` (o time) · `ads_pedidos_criativo`, `ads_criativos`, `paginas_resumo` (o Criador, com formato, feedback e versões) · `alertas`, `ads_planos`, `relatorios`, `ads_publicos`.

## Limites (o que o modelo não consegue contornar)

Em `config/negocio.ts` → `LIMITES`: teto diário somado, pausar sem cadastro, reduzir/aumentar em %, frequência entre mudanças, orçamento mínimo. Em código: confiança mínima por tipo de ação (`dossie.ts`), 1 criativo por dia e 3 dias entre publicações (`criador.ts`; uma nova versão pedida no painel nasce sempre em sombra), reversão com 30% de piora (`gestor.ts`), teto de custo de modelo por dia (`llm.ts`), gasto do dia acima de 105% do teto pausa tudo (`vigia.ts`).

## Vídeo

O anúncio em vídeo é a mesma tela do criativo estático com a conversa acontecendo: um `<canvas>` desenhado quadro a quadro (título, telefone, mensagens entrando com "digitando…", painel final com promessa e preço), gravado pela própria página com `MediaRecorder` (WebM/VP9, 1080×1920, 15 s) dentro do Browser Rendering. Vai para a Meta por `advideos` (espera processar), a capa por `adimages`, e o criativo usa `video_data`. O Estrategista escolhe o formato por ângulo; `POST /admin/criativos/pedir?formato=video` pede um à mão. Nenhum vídeo é gerado por IA generativa: é código.

## Modelos

Padrão: `anthropic/claude-sonnet-5.5` (Analista, Estrategista, copy), `anthropic/claude-haiku-5.5` (verificador, páginas, relatório), reservas DeepSeek. Trocam por variável no `wrangler.toml`. Para classificação o raciocínio fica desligado (senão o modelo gasta o limite de resposta pensando e devolve vazio).
