# Integrar o pagamento

O sistema precisa saber **quem entrou no pagamento, quem pagou, quantas vezes e quem cancelou**. Isso vive em duas tabelas (`clientes` e `pagamentos`, veja `migrations/0001_pagamento.sql`) e tudo o que o time decide por cliente, as métricas do painel, os públicos e os eventos para a Meta saem delas.

Há três jeitos de alimentar as tabelas. Use o que a sua plataforma permitir, do mais automático ao mais manual.

## 1. Webhook da plataforma (automático)

Cadastre na sua plataforma de pagamento a URL:

```
https://SEU-WORKER/webhook/pagamento/<fonte>?token=WEBHOOK_TOKEN
```

`WEBHOOK_TOKEN` é um segredo seu (`npx wrangler secret put WEBHOOK_TOKEN`). `<fonte>` é um dos adaptadores abaixo. Cada webhook é gravado, registrado em `ingestao_log` (aparece no painel) e dispara na hora os eventos para a Meta do cliente tocado.

| fonte | O que cadastrar na plataforma | O que o adaptador faz |
|---|---|---|
| `stripe` | Eventos `customer.created`, `invoice.paid`, `customer.subscription.deleted` (Developers → Webhooks) | Lê o corpo JSON. `metadata.fbclid` / `metadata.gclid` no customer, se você gravar, viram atribuição. Nada é buscado na API. |
| `asaas` | Webhook com `PAYMENT_RECEIVED`, `PAYMENT_CONFIRMED` e, se quiser, `CUSTOMER_CREATED` | Lê o pagamento do corpo e busca o cliente em `/v3/customers/<id>` com `PAGAMENTO_TOKEN` (a chave de API do Asaas). |
| `iugu` | Gatilhos `invoice.status_changed`, `invoice.created`, `customer.created` | O webhook da Iugu só manda o id: o adaptador busca a fatura e o cliente em `/v1/invoices` e `/v1/customers` com `PAGAMENTO_TOKEN` (API token da Iugu). Pagou = `paid` ou `externally_paid`. |
| `generico` | Qualquer sistema seu que consiga fazer um POST | JSON no nosso formato (abaixo). Serve para um ERP, um n8n/Make, um script, ou outra plataforma que você adapte. |

Formato genérico (JSON; aceita lote ou um registro por vez):

```json
{
  "clientes": [{ "id": "c123", "email": "ana@empresa.com", "telefone": "11988887777", "nome": "Ana Souza",
                  "criado_em": "2026-10-28T10:00:00Z", "plano": "Pro", "atendentes": 4, "cancelado_em": null,
                  "fbclid": "...", "gclid": "...", "utm": { "utm_campaign": "fundo" } }],
  "pagamentos": [{ "id": "f987", "cliente_id": "c123", "pago_em": "2026-10-29", "valor_cents": 2500 }]
}
```

ou `{ "tipo": "pagamento", "id": "f987", "cliente_id": "c123", "pago_em": "2026-10-29", "valor_cents": 2500 }`. Datas em ISO, `AAAA-MM-DD`, `DD/MM/AAAA` ou segundos Unix. Mandar o mesmo registro duas vezes não duplica (o `id` é a chave).

**Outra plataforma (Hotmart, Kiwify, Eduzz, Pagar.me, Vindi, PagSeguro, Mercado Pago…)?** Escreva um adaptador em `src/fontes/ingestao.ts`: uma função que recebe o corpo do webhook e devolve `{ clientes, pagamentos }` no formato acima, e acrescente o nome em `adaptar()`. O Claude Code faz isso em minutos com a documentação do webhook da plataforma aberta. Até lá, use o `generico` por uma automação (n8n, Make, Zapier) que traduza o webhook.

## 2. CSV (manual, mas vale para carregar o histórico)

Exporte da plataforma dois arquivos e mande:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" --data-binary @clientes.csv   "https://SEU-WORKER/admin/pagamento/importar?tabela=clientes"
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" --data-binary @pagamentos.csv "https://SEU-WORKER/admin/pagamento/importar?tabela=pagamentos"
```

Cabeçalhos: `id,email,telefone,criado_em,plano,atendentes,cancelado_em` e `id,cliente_id,pago_em,valor_cents`. Faça isso uma vez para o histórico (as coortes e o "quem fica" precisam de meses) e deixe o webhook cuidar do dia a dia.

## 3. Sem plataforma de pagamento

Se você vende por Pix manual, contrato ou planilha, a planilha é a plataforma: exporte o CSV toda semana (ou peça ao Claude Code um script que leia a planilha e chame o `generico`). O time funciona sem isso, só que decide por cadastro (o que a Meta conta), não por cliente que pagou.

## Eventos para a Meta (API de Conversões)

Com o pagamento ligado, cada fato vira um evento no conjunto de dados da Meta, com e-mail/telefone/nome em SHA-256 e, quando a landing page capturou, o clique (`fbc`):

| Evento | Quando | Para quê |
|---|---|---|
| `InitiateCheckout` | cliente entrou no pagamento | funil |
| `Purchase` | primeiro pagamento | **é por ele que as campanhas devem otimizar**: cliente que pagou, não formulário |
| `RenovacaoAssinatura` | pagamentos seguintes (evento personalizado) | a Meta aprende quem paga e quanto; públicos |

Ligar: `META_DATASET_ID` (Gerenciador de Eventos → Conjuntos de dados → id) e `META_CAPI_ATIVO = "true"` no `wrangler.toml`. O token é o mesmo `META_ADS_TOKEN` desde que o usuário do sistema tenha o conjunto de dados atribuído (Configurações → Usuários do sistema → Atribuir ativos → Conjuntos de dados); ou um `META_CAPI_TOKEN` separado. Teste primeiro com `META_TEST_EVENT_CODE` (aba "Eventos de teste"), confira que os eventos chegam, depois limpe o código: eventos marcados "teste" são reenviados de verdade.

A Meta recusa eventos com mais de 7 dias; por isso o histórico antigo não é enviado (fica "ignorado"). `GET /admin/eventos` mostra o resumo; `POST /admin/eventos/varrer` reenvia erros dos últimos 6 dias (o cron já faz isso todo dia).
