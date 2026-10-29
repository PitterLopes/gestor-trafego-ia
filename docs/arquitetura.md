# Arquitetura

```
 Meta Ads (Marketing API)      sistema de cobrança (CSV / webhook)      landing pages
        │  gasto, campanhas,            │  clientes, pagamentos                │  texto
        │  anúncios, status             │                                      │
        ▼                               ▼                                      ▼
 ┌───────────────────────────────── Worker na Cloudflare ─────────────────────────────────┐
 │  D1 (banco)  ·  R2 (imagens dos criativos)  ·  Browser Rendering (HTML → PNG)  ·  cron  │
 │                                                                                         │
 │  03:00  coleta → regras → Vigia → Estrategista(seg) → Analista → Gestor → Criador       │
 │         → Públicos(seg) → Relator(seg)                                                  │
 │  hh:20  Vigia (teto do dia, reprovações) → Gestor                                       │
 │                                                                                         │
 │  modelos pela OpenRouter (JSON com esquema; principal + reserva; teto de custo/dia)      │
 └───────────────┬───────────────────────────────────────────────┬─────────────────────────┘
                 │ escreve (só o Gestor e o Criador)             │ lê
                 ▼                                               ▼
          Meta Ads (orçamento, status, anúncios, públicos)   /painel · /admin · e-mail
```

## Módulos (`src/`)

| Arquivo | Papel |
|---|---|
| `config/negocio.ts` | **Tudo o que é da empresa**: perfil, o que pode/não pode afirmar, preço, template, limites |
| `fontes/pagamento.ts` | Entradas, clientes, quem seguiu e listas para públicos, lidos de `clientes`/`pagamentos`; importação por CSV |
| `anuncios.ts` | Coleta da Meta: gasto por campanha e por anúncio, campanhas (status, orçamento), texto dos criativos |
| `analista.ts` | Regras determinísticas (o piso) e as janelas de 7/28 dias que todos usam |
| `agentes/llm.ts` | Cliente OpenRouter: esquema JSON, reserva, raciocínio ligado/desligado, custo por chamada, teto diário |
| `agentes/dossie.ts` | O JSON compacto que o Analista recebe (inclui o plano da semana) |
| `agentes/analista_ia.ts` | Plano do dia pelo modelo → `validarAcoes` (teto, frequência, confiança mínima, valores) → fila `ads_acoes`; fallback para as regras |
| `agentes/gestor.ts` | Executa a fila na Meta; níveis; baseline e reversão em 3 dias; estado e botão de parar |
| `agentes/meta_api.ts` | Escrita na Meta (status, orçamento) |
| `agentes/criador.ts` | Copy → verificador (regras + modelo) → `templates/escritorio.ts` → PNG (`render.ts`) → R2 → anúncio |
| `agentes/biblioteca.ts` | Melhores e piores anúncios da conta, para o prompt |
| `agentes/paginas.ts` | Lê e resume as landing pages (renova por semana) |
| `agentes/vigia.ts` | Reprovação, teto do dia (pausa), sem gasto, erros; alertas e e-mail |
| `agentes/estrategista.ts` | Plano semanal e pedidos de criativo |
| `agentes/relator.ts` | Relatório semanal |
| `agentes/publicos.ts` | Públicos personalizados e semelhante |
| `agentes/equipe.ts` | A rodada: ordem, níveis, registro em `agentes_execucoes` |
| `painel.ts` | Página única de acompanhamento |
| `index.ts` | Rotas e cron |

## Tabelas (`migrations/`)

`clientes`, `pagamentos` (o seu negócio) · `ads_gasto_diario`, `ads_campanhas`, `ads_anuncios`, `ads_anuncio_diario` (a plataforma) · `ads_decisoes` (regras) · `agentes_estado`, `ads_acoes`, `llm_chamadas`, `agentes_execucoes` (o time) · `ads_pedidos_criativo`, `ads_criativos`, `paginas_resumo` (o Criador) · `alertas`, `ads_planos`, `relatorios`, `ads_publicos`.

## Limites (o que o modelo não consegue contornar)

Em `config/negocio.ts` → `LIMITES`: teto diário somado, pausar sem cadastro, reduzir/aumentar em %, frequência entre mudanças, orçamento mínimo. Em código: confiança mínima por tipo de ação (`dossie.ts`), 1 criativo por dia e 3 dias entre publicações (`criador.ts`), reversão com 30% de piora (`gestor.ts`), teto de custo de modelo por dia (`llm.ts`), gasto do dia acima de 105% do teto pausa tudo (`vigia.ts`).

## Modelos

Padrão: `anthropic/claude-sonnet-5.5` (Analista, Estrategista, copy), `anthropic/claude-haiku-5.5` (verificador, páginas, relatório), reservas DeepSeek. Trocam por variável no `wrangler.toml`. Para classificação o raciocínio fica desligado (senão o modelo gasta o limite de resposta pensando e devolve vazio).
