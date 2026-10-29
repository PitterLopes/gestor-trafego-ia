import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { adaptarAsaas, adaptarGenerico, adaptarIugu, adaptarStripe, dataIso, gravarEntrada, lerCorpo, receberWebhook } from "../src/fontes/ingestao.ts";
import { dadosDeCorrespondencia, planejarEventos, processarCliente, varrerEventos } from "../src/fontes/eventos_meta.ts";
import { calcularMetricas } from "../src/metricas.ts";
import { criarUsuario, rotasLogin, sessaoDoPedido } from "../src/login.ts";
import { receberLead, scriptCaptura } from "../src/captura.ts";

/**
 * O negócio por inteiro (src/fontes/ingestao.ts, src/fontes/eventos_meta.ts, src/metricas.ts, src/login.ts,
 * src/captura.ts): webhook de cada plataforma → clientes/pagamentos; lead da landing → cliente herda o clique;
 * eventos para a Meta sem repetição; métricas e coortes; login por código; captura.
 */

function d1Falso(db: DatabaseSync): D1Database {
  const prepare = (sqlD1: string) => {
    const numerado = /\?\d+/.test(sqlD1);
    const stmt = db.prepare(numerado ? sqlD1.replace(/\?(\d+)/g, "$p$1") : sqlD1);
    const comArgs = (lista: unknown[]) => {
      const args = numerado ? [Object.fromEntries(lista.map((v, i) => [`p${i + 1}`, v]))] : lista;
      return {
        all: async () => ({ results: stmt.all(...(args as never[])), success: true, meta: {} }),
        first: async () => stmt.get(...(args as never[])) ?? null,
        run: async () => { const r = stmt.run(...(args as never[])); return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      };
    };
    return { ...comArgs([]), bind: (...args: unknown[]) => comArgs(args) };
  };
  const batch = async (stmts: Array<{ run: () => Promise<unknown> }>) => { for (const s of stmts) await s.run(); return []; };
  return { prepare, batch } as unknown as D1Database;
}
function banco(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  for (const m of ["0001_pagamento.sql", "0008_negocio.sql"]) sqlite.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"));
  return { db: d1Falso(sqlite), sqlite };
}
const AGORA = new Date("2026-10-29T15:00:00Z");
const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });
const req = (url: string, corpo: unknown, headers: Record<string, string> = { "content-type": "application/json" }, method = "POST") => new Request(url, { method, headers, body: typeof corpo === "string" ? corpo : JSON.stringify(corpo) });

// ---------- ingestão ----------

test("dataIso aceita ISO, AAAA-MM-DD, DD/MM/AAAA e Unix", () => {
  assert.equal(dataIso("2026-10-29"), "2026-10-29T12:00:00.000Z");
  assert.equal(dataIso("29/10/2026 08:30"), "2026-10-29T08:30:00.000Z");
  assert.equal(dataIso(1_793_238_000), "2026-10-29T01:40:00.000Z");
  assert.equal(dataIso("x"), null);
});

test("genérico: lote e registro único; Stripe, Asaas e Iugu viram o mesmo esquema", async () => {
  const g = adaptarGenerico({ clientes: [{ id: "c1", email: "A@x.com", criado_em: "2026-10-01", utm_source: "meta" }], pagamentos: [{ id: "p1", cliente_id: "c1", pago_em: "2026-10-02T10:00:00Z", valor: 99.9 }] });
  assert.deepEqual(g.clientes[0].utm, { utm_source: "meta" });
  assert.deepEqual(g.pagamentos[0], { id: "p1", cliente_id: "c1", pago_em: "2026-10-02", valor_cents: 9990 });
  assert.equal(adaptarGenerico({ tipo: "pagamento", id: "p2", cliente_id: "c1", pago_em: "2026-10-03", valor_cents: 5000 }).pagamentos.length, 1);

  const s = adaptarStripe({ type: "invoice.paid", data: { object: { id: "in_1", customer: "cus_1", amount_paid: 2500, status_transitions: { paid_at: 1_793_238_000 } } } });
  assert.deepEqual(s.pagamentos[0], { id: "in_1", cliente_id: "cus_1", pago_em: "2026-10-29", valor_cents: 2500 });
  assert.equal(adaptarStripe({ type: "customer.created", data: { object: { id: "cus_1", email: "a@x.com", created: 1_793_238_000, metadata: { fbclid: "FB1" } } } }).clientes[0].fbclid, "FB1");

  const fetchAsaas = (async (url: string) => (url.includes("/customers/") ? resposta({ id: "cus_9", email: "b@x.com", mobilePhone: "11988887777", name: "Bia", dateCreated: "2026-10-20" }) : resposta({}, 404))) as unknown as typeof fetch;
  const a = await adaptarAsaas({ event: "PAYMENT_RECEIVED", payment: { id: "pay_1", customer: "cus_9", value: 49.9, paymentDate: "2026-10-28" } }, { DB: banco().db, PAGAMENTO_TOKEN: "t" }, fetchAsaas);
  assert.deepEqual(a.pagamentos[0], { id: "pay_1", cliente_id: "cus_9", pago_em: "2026-10-28", valor_cents: 4990 });
  assert.equal(a.clientes[0].telefone, "11988887777");

  const fetchIugu = (async (url: string) => (url.endsWith("/invoices/F1") ? resposta({ id: "F1", status: "paid", customer_id: "C7", paid_at: "2026-10-27T13:00:00-03:00", paid_cents: 2500, created_at_iso: "2026-10-20T10:00:00-03:00" }) : url.endsWith("/customers/C7") ? resposta({ id: "C7", email: "c@x.com", phone: "988887777", phone_prefix: "11", name: "Carla", created_at: "2026-10-20T10:00:00-03:00" }) : resposta({}, 404))) as unknown as typeof fetch;
  const corpoIugu = await lerCorpo(req("https://w/x", "event=invoice.status_changed&data[id]=F1&data[status]=paid", { "content-type": "application/x-www-form-urlencoded" }));
  const i = await adaptarIugu(corpoIugu, { DB: banco().db, PAGAMENTO_TOKEN: "t" }, fetchIugu);
  assert.deepEqual(i.pagamentos[0], { id: "F1", cliente_id: "C7", pago_em: "2026-10-27", valor_cents: 2500 });
  assert.equal(i.clientes[0].email, "c@x.com");
});

test("webhook: token obrigatório, grava, registra no log e devolve os clientes tocados; o lead da landing passa o clique ao cliente", async () => {
  const { db, sqlite } = banco();
  const env = { DB: db, WEBHOOK_TOKEN: "segredo" };
  await receberLead(db, req("https://w/lead", { email: "Ana@X.com", telefone: "(11) 98888-7777", fbclid: "FBCLICK", gclid: "", fbp: "fb.1.1.2", utm: { utm_campaign: "fundo" }, pagina: "https://lp/" }));
  assert.equal((await receberWebhook(env, "generico", req("https://w/webhook/pagamento/generico?token=errado", {}))).status, 401);
  const r = await receberWebhook(env, "generico", req("https://w/webhook/pagamento/generico?token=segredo", { clientes: [{ id: "c1", email: "ana@x.com", criado_em: "2026-10-28" }], pagamentos: [{ id: "p1", cliente_id: "c1", pago_em: "2026-10-29", valor_cents: 2500 }] }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.tocados, ["c1"]);
  const c = sqlite.prepare("SELECT fbclid, fbp, utm_json, origem FROM clientes WHERE id = 'c1'").get() as Record<string, string>;
  assert.deepEqual({ ...c }, { fbclid: "FBCLICK", fbp: "fb.1.1.2", utm_json: '{"utm_campaign":"fundo"}', origem: "webhook:generico" });
  assert.equal((sqlite.prepare("SELECT clientes, pagamentos FROM ingestao_log").get() as { clientes: number }).clientes, 1);
  // pagamento de cliente desconhecido cria o cliente mínimo
  await gravarEntrada(db, { clientes: [], pagamentos: [{ id: "p9", cliente_id: "c9", pago_em: "2026-10-29", valor_cents: 100 }] }, "csv");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM clientes").get()!.n, 2);
  assert.equal((await receberWebhook(env, "outra", req("https://w/webhook/pagamento/outra?token=segredo", {}))).status, 404);
});

// ---------- eventos para a Meta ----------

test("eventos: checkout + purchase no 1º pagamento, renovação nos seguintes; fbc vem do fbclid", async () => {
  const c = { id: "c1", email: "Ana@X.com", telefone: "(11) 98888-7777", nome: "Ana Maria Souza", criado_em: "2026-10-28T10:00:00.000Z", fbclid: "FB", fbp: null, plano: "Pro" };
  const ev = planejarEventos(c, [{ id: "p2", pago_em: "2026-11-28", valor_cents: 2500 }, { id: "p1", pago_em: "2026-10-29", valor_cents: 2500 }]);
  assert.deepEqual(ev.map((e) => [e.event_id, e.evento, e.action_source]), [["checkout_c1", "InitiateCheckout", "other"], ["purchase_p1", "Purchase", "other"], ["renovacao_p2", "RenovacaoAssinatura", "system_generated"]]);
  assert.deepEqual(dadosDeCorrespondencia(c), { em: "ana@x.com", ph: "5511988887777", fn: "ana", ln: "souza", country: "br", external_id: "c1" });
});

test("processarCliente: envia uma vez, ignora o que passou de 7 dias, repete só o erro, e respeita o código de teste", async () => {
  const { db, sqlite } = banco();
  await gravarEntrada(db, { clientes: [{ id: "c1", email: "a@x.com", criado_em: "2026-10-28T10:00:00.000Z", fbclid: "FB" }, { id: "velho", email: "v@x.com", criado_em: "2026-09-01T10:00:00.000Z" }], pagamentos: [{ id: "p1", cliente_id: "c1", pago_em: "2026-10-29", valor_cents: 2500 }, { id: "pv", cliente_id: "velho", pago_em: "2026-09-02", valor_cents: 2500 }] }, "teste");
  const chamadas: string[] = [];
  let falhar = false;
  const fetchFn = (async (url: string, init?: RequestInit) => { chamadas.push(String(init?.body)); return falhar ? resposta({ error: "x" }, 400) : resposta({ events_received: 1 }); }) as unknown as typeof fetch;
  const env = { DB: db, META_CAPI_ATIVO: "true", META_DATASET_ID: "ds", META_ADS_TOKEN: "tk" };
  const r = await processarCliente(env, "c1", fetchFn, AGORA.getTime());
  assert.deepEqual(r.enviados, ["checkout_c1", "purchase_p1"]);
  const corpo = JSON.parse(chamadas[0]) as { data: Array<{ user_data: Record<string, unknown>; custom_data: Record<string, unknown> }> };
  assert.equal(corpo.data.length, 2);
  assert.ok(String(corpo.data[0].user_data.fbc).startsWith("fb.1."));
  assert.equal(corpo.data[1].custom_data.value, 25);
  assert.deepEqual((await processarCliente(env, "c1", fetchFn, AGORA.getTime())).enviados, [], "segunda vez não manda");
  const v = await processarCliente(env, "velho", fetchFn, AGORA.getTime());
  assert.deepEqual(v.ignorados, ["checkout_velho", "purchase_pv"]);
  // renovação chega → só ela sai; erro fica para a varredura repetir
  await gravarEntrada(db, { clientes: [], pagamentos: [{ id: "p2", cliente_id: "c1", pago_em: "2026-10-29", valor_cents: 2500 }] }, "teste");
  falhar = true;
  assert.equal((await processarCliente(env, "c1", fetchFn, AGORA.getTime())).erros.length, 1);
  falhar = false;
  const var1 = await varrerEventos(env, fetchFn, AGORA);
  assert.equal(var1.enviados, 1, JSON.stringify(var1));
  assert.equal(sqlite.prepare("SELECT status FROM meta_eventos WHERE event_id = 'renovacao_p2'").get()!.status, "enviado");
  assert.equal((await processarCliente({ ...env, META_CAPI_ATIVO: "false" }, "c1", fetchFn)).enviados.length, 0, "desligado não manda");
  const teste = await processarCliente({ ...env, META_TEST_EVENT_CODE: "TEST1" }, "c1", fetchFn, AGORA.getTime());
  assert.equal(teste.enviados.length, 0, "tudo já enviado de verdade: nada a reenviar como teste");
});

// ---------- métricas ----------

test("métricas: ativos pela regra do ciclo + tolerância, MRR, novos, churn e coortes", () => {
  const clientes = [
    { id: "a", criado_em: "2026-06-01T00:00:00Z", cancelado_em: null },
    { id: "b", criado_em: "2026-07-05T00:00:00Z", cancelado_em: null },
    { id: "c", criado_em: "2026-08-10T00:00:00Z", cancelado_em: "2026-09-20T00:00:00Z" },
    { id: "d", criado_em: "2026-10-15T00:00:00Z", cancelado_em: null }, // entrou e não pagou
  ];
  const pagamentos = [
    ...["2026-06-02", "2026-07-02", "2026-08-02", "2026-09-02", "2026-10-02"].map((d, i) => ({ cliente_id: "a", pago_em: d, valor_cents: 2500 + i })),
    { cliente_id: "b", pago_em: "2026-07-06", valor_cents: 5000 }, { cliente_id: "b", pago_em: "2026-08-06", valor_cents: 5000 }, // parou em agosto
    { cliente_id: "c", pago_em: "2026-08-11", valor_cents: 1000 },
  ];
  const m = calcularMetricas(clientes, pagamentos, AGORA, 6);
  const out = m.meses.find((x) => x.mes === "2026-10")!, set = m.meses.find((x) => x.mes === "2026-09")!, ago = m.meses.find((x) => x.mes === "2026-08")!;
  assert.equal(ago.ativos, 3, "agosto: a, b e c pagaram");
  assert.equal(set.ativos, 1, "setembro: b passou dos 45 dias sem pagar (06/08), c cancelou; só a");
  assert.equal(out.ativos, 1, "outubro: só a");
  assert.equal(out.mrr_cents, 2504);
  assert.equal(out.entradas, 1);
  assert.equal(set.cancelados, 2);
  assert.equal(set.churn_pct, 66.7);
  assert.equal(out.churn_pct, 0);
  assert.deepEqual(m.hoje, { ativos: 1, mrr_cents: 2504, novos_30d: 0, entradas_30d: 1, conversao_30d_pct: 0 });
  const jul = m.coortes.find((c) => c.mes === "2026-07")!;
  assert.deepEqual(jul.retidos, [100, 0, 0, null], "b pagou +1 mês, não +2, +6 ainda não chegou");
  assert.equal(m.coortes.find((c) => c.mes === "2026-08")!.clientes, 1);
});

// ---------- login ----------

test("login: código por e-mail (falso), sessão em cookie, usuários só para admin", async () => {
  const { db } = banco();
  const enviados: Array<{ to: string; text: string }> = [];
  const env = { DB: db, LOGIN_SEGREDO: "segredo-longo", EMAIL: { send: async (m: { to: string; text: string }) => { enviados.push(m); return { messageId: "1" }; } } };
  await criarUsuario(db, { email: "dona@x.com", nome: "Dona", papel: "admin", por: "token" });
  const desconhecido = await rotasLogin("/auth/codigo", req("https://w/auth/codigo", { email: "ninguem@x.com" }), env);
  assert.equal(desconhecido!.status, 200);
  assert.equal(enviados.length, 0, "e-mail não cadastrado não recebe nada, mas a resposta é igual");
  assert.equal((await rotasLogin("/auth/codigo", req("https://w/auth/codigo", { email: "dona@x.com" }), env))!.status, 200);
  const codigo = /(\d{3}) (\d{3})/.exec(enviados[0].text)!.slice(1).join("");
  assert.equal((await rotasLogin("/auth/entrar", req("https://w/auth/entrar", { email: "dona@x.com", codigo: "000000" }), env))!.status, 401);
  const ok = await rotasLogin("/auth/entrar", req("https://w/auth/entrar", { email: "dona@x.com", codigo }), env);
  assert.equal(ok!.status, 200);
  const cookie = ok!.headers.get("set-cookie")!.split(";")[0];
  const quem = await sessaoDoPedido(new Request("https://w/painel", { headers: { cookie } }), env);
  assert.deepEqual(quem, { email: "dona@x.com", nome: "Dona", papel: "admin" });
  const add = await rotasLogin("/auth/usuarios", req("https://w/auth/usuarios", { email: "socio@x.com", nome: "Sócio", papel: "leitor" }, { "content-type": "application/json", cookie }), env);
  assert.equal(add!.status, 200);
  assert.equal((await rotasLogin("/auth/usuarios", new Request("https://w/auth/usuarios"), env))!.status, 401, "sem sessão não lista");
  assert.equal((await rotasLogin("/auth/sair", req("https://w/auth/sair", {}, { cookie }), env))!.status, 200);
  assert.equal(await sessaoDoPedido(new Request("https://w/painel", { headers: { cookie } }), env), null);
});

test("sem e-mail configurado o código vai para o log e o login continua funcionando", async () => {
  const { db } = banco();
  const env = { DB: db, LOGIN_SEGREDO: "s" };
  await criarUsuario(db, { email: "a@x.com", nome: "A", papel: "admin", por: "token" });
  const logs: string[] = [];
  const orig = console.log; console.log = (m: string) => { logs.push(String(m)); };
  try {
    const r = await rotasLogin("/auth/codigo", req("https://w/auth/codigo", { email: "a@x.com" }), env);
    assert.ok(((await r!.json()) as { aviso?: string }).aviso);
  } finally { console.log = orig; }
  const codigo = /: (\d{6}) /.exec(logs[0])![1];
  assert.equal((await rotasLogin("/auth/entrar", req("https://w/auth/entrar", { email: "a@x.com", codigo }), env))!.status, 200);
});

// ---------- captura ----------

test("captura.js aponta para /lead do Worker e guarda fbclid/gclid/utm; /lead exige e-mail ou telefone", async () => {
  const js = scriptCaptura("https://app.exemplo.com");
  assert.ok(js.includes('"https://app.exemplo.com"+"/lead"') && js.includes("fbclid") && js.includes("gclid") && js.includes("utm_campaign") && js.includes("data-captura-links"));
  const { db, sqlite } = banco();
  assert.equal((await receberLead(db, req("https://w/lead", { nome: "x" }))).status, 400);
  assert.equal((await receberLead(db, req("https://w/lead", { email: "A@x.com", gclid: "G1", utm: { utm_source: "google" } }))).status, 200);
  const l = sqlite.prepare("SELECT email, gclid, utm_json FROM leads").get() as Record<string, string>;
  assert.deepEqual({ ...l }, { email: "a@x.com", gclid: "G1", utm_json: '{"utm_source":"google"}' });
});
