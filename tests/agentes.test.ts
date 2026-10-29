import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { chamarLlm, custoHoje, extrairJson } from "../src/agentes/llm.ts";
import { lerPlano, propostasDasRegras, rodarAnalistaIa, validarAcoes } from "../src/agentes/analista_ia.ts";
import { montarDossie } from "../src/agentes/dossie.ts";
import { bloqueio, gravarEstado, lerEstado, rodarGestor } from "../src/agentes/gestor.ts";
import { rodarEquipe } from "../src/agentes/equipe.ts";
import type { EquipeEnv } from "../src/agentes/equipe.ts";
import { gravarCampanhas, gravarGasto } from "../src/anuncios.ts";
import { analisar, lerCampanhas, lerConta } from "../src/analista.ts";

/**
 * Time de tráfego com IA (src/agentes/): o cliente de modelo (JSON, teto diário, reserva), o Analista
 * (esquema, validação contra os limites, fallback para as regras, fila) e o Gestor (ensaio, execução,
 * frequência, teto, revisão e reversão), num SQLite com as migrações de verdade e um fetch falso.
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
  return { prepare } as unknown as D1Database;
}

function banco(extra: Partial<EquipeEnv> = {}): { env: EquipeEnv; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  for (const m of ["0001_pagamento.sql", "0002_anuncios.sql", "0003_analista.sql", "0004_agentes.sql", "0005_criador.sql", "0006_biblioteca.sql", "0007_equipe.sql", "0008_negocio.sql", "0009_feedback_video.sql"]) sqlite.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"));
  return { env: { DB: d1Falso(sqlite), OPENROUTER_API_KEY: "or-teste", META_ADS_TOKEN: "meta-teste", ...extra }, sqlite };
}

const AGORA = new Date("2026-10-29T15:00:00Z"); // 29/10 em Brasília
const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });
const respostaLlm = (conteudo: unknown, modelo = "anthropic/claude-sonnet-5.5") =>
  resposta({ model: modelo, choices: [{ message: { content: JSON.stringify(conteudo) } }], usage: { prompt_tokens: 1200, completion_tokens: 300, cost: 0.0054 } });

/** Conta com duas campanhas ativas (A saudável, B cara) e uma pausada (C). */
async function semear(env: EquipeEnv): Promise<void> {
  const linhas = [];
  for (let k = 0; k < 10; k++) {
    const dia = `2026-10-${String(29 - k).padStart(2, "0")}`;
    linhas.push({ dia, plataforma: "meta" as const, campanha_id: "A", campanha: "Fundo", gasto_cents: 20_000, impressoes: 100, cliques: 20, resultados: 8 });
    linhas.push({ dia, plataforma: "meta" as const, campanha_id: "B", campanha: "Cara", gasto_cents: 5_000, impressoes: 100, cliques: 5, resultados: k < 7 ? 0 : 1 });
  }
  await gravarGasto(env.DB, linhas);
  await gravarCampanhas(env.DB, [
    { plataforma: "meta", campanha_id: "A", campanha: "Fundo", status: "ACTIVE", orcamento_diario_cents: 20_000, objetivo: "OUTCOME_LEADS" },
    { plataforma: "meta", campanha_id: "B", campanha: "Cara", status: "ACTIVE", orcamento_diario_cents: 5_000, objetivo: "OUTCOME_LEADS" },
    { plataforma: "meta", campanha_id: "C", campanha: "Parada", status: "PAUSED", orcamento_diario_cents: 10_000, objetivo: null },
  ]);
}

// ---------- llm ----------

test("extrairJson aceita cerca de código e texto em volta", () => {
  assert.deepEqual(extrairJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extrairJson('Claro! {"a":[1,2]} fim'), { a: [1, 2] });
  assert.throws(() => extrairJson("nada aqui"));
});

test("chamarLlm: registra a chamada com custo, usa o reserva quando o principal falha e respeita o teto diário", async () => {
  const { env, sqlite } = banco({ LLM_TETO_USD_DIA: "0.01" });
  const modelos: string[] = [];
  const fetchFalso = (async (_u: string, init?: RequestInit) => {
    const corpo = JSON.parse(String(init?.body)) as { model: string; response_format: { type: string }; reasoning: Record<string, unknown> };
    modelos.push(corpo.model);
    assert.equal(corpo.response_format.type, "json_schema");
    assert.deepEqual(corpo.reasoning, { enabled: false }, "sem pedido de raciocínio, ele fica desligado");
    if (corpo.model === "principal") return resposta({ error: { message: "indisponível" } }, 503);
    return respostaLlm({ x: 1 }, "reserva");
  }) as unknown as typeof fetch;
  const p = { agente: "teste", modelo: "principal", modeloReserva: "reserva", sistema: "s", usuario: "u", esquema: { type: "object" }, nomeEsquema: "t" };
  const r = await chamarLlm<{ x: number }>(env, p, fetchFalso, AGORA);
  assert.ok(r.ok && r.dados.x === 1 && r.modelo === "reserva");
  assert.deepEqual(modelos, ["principal", "reserva"]);
  const chamadas = sqlite.prepare("SELECT modelo, ok, custo_usd FROM llm_chamadas ORDER BY id").all() as Array<{ modelo: string; ok: number; custo_usd: number | null }>;
  assert.deepEqual(chamadas.map((c) => [c.modelo, c.ok]), [["principal", 0], ["reserva", 1]]);
  assert.equal(chamadas[1].custo_usd, 0.0054);
  // já gastou mais que o teto de US$ 0,01? não: 0,0054. Mais uma chamada passa, a terceira bate no teto.
  await chamarLlm(env, p, fetchFalso, AGORA);
  assert.ok((await custoHoje(env.DB, AGORA)) >= 0.01);
  const r3 = await chamarLlm(env, p, fetchFalso, AGORA);
  assert.ok(!r3.ok && /teto diário/.test(r3.erro));
});

// ---------- analista: esquema e limites ----------

test("chamarLlm: resposta cortada pelo max_tokens vira erro claro", async () => {
  const { env } = banco();
  const cortada = (async () => resposta({ model: "m", choices: [{ finish_reason: "length", message: { content: null, reasoning: "pensando..." } }] })) as unknown as typeof fetch;
  const r = await chamarLlm(env, { agente: "t", modelo: "m", sistema: "s", usuario: "u", esquema: { type: "object" }, nomeEsquema: "t", maxTokens: 50 }, cortada, AGORA);
  assert.ok(!r.ok && /cortada pelo max_tokens \(50\)/.test(r.erro), r.ok ? "" : r.erro);
});

test("lerPlano aceita o esquema e rejeita o que está fora dele", () => {
  assert.ok(lerPlano({ resumo: "ok", acoes: [{ campanha_id: "A", tipo: "manter", valor_cents: null, motivo: "m", confianca: 0.9 }], pedidos_criativo: [] }));
  assert.equal(lerPlano({ resumo: "ok", acoes: [{ campanha_id: "A", tipo: "explodir", valor_cents: null, motivo: "m", confianca: 0.9 }], pedidos_criativo: [] }), null);
  assert.equal(lerPlano({ resumo: "ok", acoes: "nada" }), null);
});

test("validarAcoes aplica teto, frequência, alvo e valor", async () => {
  const { env } = banco();
  await semear(env);
  const d = await montarDossie(env.DB, AGORA);
  assert.equal(d.orcamento_ativo_cents, 25_000);
  const v = validarAcoes(d, [
    { campanha_id: "A", tipo: "aumentar", valor_cents: 23_000, motivo: "bom", confianca: 0.8 }, // +15%: ok
    { campanha_id: "B", tipo: "reduzir", valor_cents: 4_000, motivo: "caro", confianca: 0.7 }, // -20%: ok
    { campanha_id: "C", tipo: "ativar", valor_cents: null, motivo: "voltar", confianca: 0.9 }, // 23000+4000+10000 = 37000 > 34500: teto
    { campanha_id: "A", tipo: "pausar", valor_cents: null, motivo: "dupla", confianca: 0.9 }, // mesma campanha duas vezes
    { campanha_id: "Z", tipo: "pausar", valor_cents: null, motivo: "não existe", confianca: 0.9 },
    { campanha_id: "C", tipo: "reduzir", valor_cents: 1_000, motivo: "pausada", confianca: 0.9 },
  ]);
  assert.deepEqual(v.map((x) => [x.alvo_id, x.tipo, x.recusa ? x.recusa.split(":")[0] : null]), [
    ["A", "aumentar", null], ["B", "reduzir", null], ["C", "ativar", "teto"], ["A", "pausar", "alvo"], ["Z", "pausar", "alvo"], ["C", "reduzir", "alvo"],
  ]);
  assert.equal(v[0].valor_anterior_cents, 20_000);
  const demais = validarAcoes(d, [
    { campanha_id: "A", tipo: "aumentar", valor_cents: 30_000, motivo: "+50%", confianca: 0.9 },
    { campanha_id: "B", tipo: "reduzir", valor_cents: 3_000, motivo: "-40%", confianca: 0.9 },
    { campanha_id: "B", tipo: "reduzir", valor_cents: null, motivo: "sem valor", confianca: 0.9 },
  ]);
  assert.deepEqual(demais.map((x) => x.recusa?.split(":")[0]), ["valor", "valor", "alvo"]);
});

test("confiança mínima: aumentar abaixo de 0,7 e pausar abaixo de 0,5 são recusados", async () => {
  const { env } = banco();
  await semear(env);
  const d = await montarDossie(env.DB, AGORA);
  const v = validarAcoes(d, [
    { campanha_id: "A", tipo: "aumentar", valor_cents: 23_000, motivo: "margem pequena", confianca: 0.55 },
    { campanha_id: "B", tipo: "pausar", valor_cents: null, motivo: "talvez", confianca: 0.4 },
  ]);
  assert.deepEqual(v.map((x) => x.recusa?.split(":")[0]), ["confianca", "confianca"]);
  const ok = validarAcoes(d, [{ campanha_id: "A", tipo: "aumentar", valor_cents: 23_000, motivo: "claro", confianca: 0.7 }]);
  assert.equal(ok[0].recusa, null);
});

test("frequência: campanha com mudança há 2 dias não recebe ação nova", async () => {
  const { env, sqlite } = banco();
  await semear(env);
  sqlite.exec("INSERT INTO ads_decisoes (dia, plataforma, campanha_id, campanha, tipo, motivo, bloqueio, dados_json, modo, criado_em) VALUES ('2026-10-27', 'meta', 'A', 'Fundo', 'reduzir', 'm', NULL, '{}', 'sombra', 't')");
  const d = await montarDossie(env.DB, AGORA);
  const [v] = validarAcoes(d, [{ campanha_id: "A", tipo: "pausar", valor_cents: null, motivo: "x", confianca: 1 }]);
  assert.match(String(v.recusa), /^frequencia/);
});

test("propostasDasRegras converte as decisões determinísticas em ações", async () => {
  const { env } = banco();
  await semear(env);
  const d = await montarDossie(env.DB, AGORA);
  const dec = analisar(await lerConta(env.DB, AGORA), await lerCampanhas(env.DB, AGORA));
  const p = propostasDasRegras(d, dec);
  // B: R$ 350 em 7 dias sem cadastro → pausar; A: manter
  assert.deepEqual(p.map((x) => [x.campanha_id, x.tipo]).sort(), [["A", "manter"], ["B", "pausar"]]);
});

// ---------- analista: rodada completa ----------

test("rodarAnalistaIa: plano do modelo vira fila (ensaio no nível 1, pendente no 2) e rodar de novo não duplica", async () => {
  const { env, sqlite } = banco();
  await semear(env);
  const plano = { resumo: "Conta saudável; B sem cadastro.", acoes: [
    { campanha_id: "A", tipo: "manter", valor_cents: null, motivo: "R$ 25 por cadastro", confianca: 0.9 },
    { campanha_id: "B", tipo: "pausar", valor_cents: null, motivo: "R$ 350 sem cadastro em 7 dias", confianca: 0.95 },
    { campanha_id: "C", tipo: "aumentar", valor_cents: 12_000, motivo: "pausada", confianca: 0.3 },
  ], pedidos_criativo: [{ campanha_id: "A", angulo: "equipe inteira no mesmo número", motivo: "custo subindo" }] };
  const fetchFalso = (async () => respostaLlm(plano)) as unknown as typeof fetch;
  const r1 = await rodarAnalistaIa(env, 1, fetchFalso, AGORA);
  assert.equal(r1.origem, "analista_ia");
  assert.deepEqual(r1.fila, { pendentes: 1, recusadas: 1, manter: 1 });
  assert.equal(r1.pedidos_criativo.length, 1);
  const linhas = () => sqlite.prepare("SELECT alvo_id, tipo, status, recusa FROM ads_acoes ORDER BY id").all() as Array<{ alvo_id: string; tipo: string; status: string; recusa: string | null }>;
  assert.deepEqual(linhas().map((l) => [l.alvo_id, l.tipo, l.status]), [["B", "pausar", "ensaio"], ["C", "aumentar", "recusada"]]);
  const r2 = await rodarAnalistaIa(env, 2, fetchFalso, AGORA);
  assert.equal(r2.fila.pendentes, 1);
  assert.deepEqual(linhas().map((l) => [l.alvo_id, l.status]), [["B", "pendente"], ["C", "recusada"]], "a rodada nova substitui a anterior do mesmo dia");
});

test("rodarAnalistaIa: modelo fora do ar → regras assumem, com origem 'regras'", async () => {
  const { env, sqlite } = banco();
  await semear(env);
  const fetchFalso = (async () => resposta({ error: { message: "fora do ar" } }, 500)) as unknown as typeof fetch;
  const r = await rodarAnalistaIa(env, 2, fetchFalso, AGORA);
  assert.equal(r.origem, "regras");
  assert.match(String(r.erro_modelo), /HTTP 500/);
  assert.deepEqual((sqlite.prepare("SELECT alvo_id, tipo, status, origem FROM ads_acoes").all() as Array<Record<string, unknown>>).map((x) => [x.alvo_id, x.tipo, x.status, x.origem]), [["B", "pausar", "pendente", "regras"]]);
});

test("rodarAnalistaIa: resposta fora do esquema também cai nas regras", async () => {
  const { env } = banco();
  await semear(env);
  const fetchFalso = (async () => respostaLlm({ resumo: "x", acoes: [{ campanha_id: "A", tipo: "dobrar" }], pedidos_criativo: [] })) as unknown as typeof fetch;
  const r = await rodarAnalistaIa(env, 2, fetchFalso, AGORA);
  assert.equal(r.origem, "regras");
  assert.equal(r.erro_modelo, "resposta fora do esquema");
});

// ---------- gestor ----------

test("estado: níveis da migração, botão de parar e gravação", async () => {
  const { env } = banco();
  const e = await lerEstado(env.DB);
  assert.deepEqual([e.todos.nivel, e.analista.nivel, e.gestor.nivel, e.criador.nivel], [2, 1, 1, 0]);
  assert.equal(bloqueio(e, "gestor"), null);
  await gravarEstado(env.DB, "todos", null, true, "teste");
  assert.equal(bloqueio(await lerEstado(env.DB), "gestor"), "parado: botão geral");
  await gravarEstado(env.DB, "todos", null, false, "teste");
  await gravarEstado(env.DB, "gestor", 2, null, "teste");
  const e2 = await lerEstado(env.DB);
  assert.equal(e2.gestor.nivel, 2);
  assert.equal(e2.gestor.parado, false);
});

test("gestor nível 1: pendentes viram ensaio, nada é enviado", async () => {
  const { env, sqlite } = banco();
  await semear(env);
  await rodarAnalistaIa(env, 2, (async () => respostaLlm({ resumo: "", acoes: [{ campanha_id: "B", tipo: "pausar", valor_cents: null, motivo: "m", confianca: 1 }], pedidos_criativo: [] })) as unknown as typeof fetch, AGORA);
  let chamouMeta = false;
  const g = await rodarGestor(env, (async () => { chamouMeta = true; return resposta({ success: true }); }) as unknown as typeof fetch, AGORA);
  assert.equal(g.ensaio, 1);
  assert.equal(chamouMeta, false);
  assert.equal((sqlite.prepare("SELECT status FROM ads_acoes").get() as { status: string }).status, "ensaio");
});

test("gestor nível 2: executa na Meta, grava baseline e revisão; frequência barra a segunda no mesmo alvo", async () => {
  const { env, sqlite } = banco();
  await semear(env);
  await gravarEstado(env.DB, "gestor", 2, null, "teste");
  const pedidos: Array<{ url: string; corpo: string }> = [];
  const fetchMeta = (async (u: string, init?: RequestInit) => { pedidos.push({ url: u, corpo: String(init?.body) }); return resposta({ success: true }); }) as unknown as typeof fetch;
  sqlite.exec(`INSERT INTO ads_acoes (dia, origem, plataforma, alvo_tipo, alvo_id, alvo_nome, tipo, valor_cents, valor_anterior_cents, motivo, status, criado_em) VALUES
    ('2026-10-29', 'analista_ia', 'meta', 'campanha', 'A', 'Fundo', 'aumentar', 23000, 20000, 'bom', 'pendente', 't'),
    ('2026-10-29', 'analista_ia', 'meta', 'campanha', 'B', 'Cara', 'pausar', NULL, 5000, 'sem cadastro', 'pendente', 't')`);
  const g = await rodarGestor(env, fetchMeta, AGORA);
  assert.deepEqual([g.executadas, g.recusadas, g.erros], [2, 0, 0]);
  assert.equal(pedidos.length, 2);
  assert.match(pedidos[0].url, /\/A$/);
  assert.equal(pedidos[0].corpo, "daily_budget=23000");
  assert.equal(pedidos[1].corpo, "status=PAUSED");
  const a = sqlite.prepare("SELECT status, revisar_em, baseline_json FROM ads_acoes WHERE alvo_id = 'A'").get() as { status: string; revisar_em: string | null; baseline_json: string };
  assert.equal(a.status, "executada");
  assert.equal(a.revisar_em, "2026-11-01");
  assert.equal(JSON.parse(a.baseline_json).custo_cadastro_7d, 2500);
  const b = sqlite.prepare("SELECT revisar_em FROM ads_acoes WHERE alvo_id = 'B'").get() as { revisar_em: string | null };
  assert.equal(b.revisar_em, null, "pausar não tem revisão");
  // dia seguinte: outra ação em A é barrada pela frequência
  sqlite.exec("INSERT INTO ads_acoes (dia, origem, plataforma, alvo_tipo, alvo_id, alvo_nome, tipo, valor_cents, valor_anterior_cents, motivo, status, criado_em) VALUES ('2026-10-30', 'analista_ia', 'meta', 'campanha', 'A', 'Fundo', 'reduzir', 18000, 23000, 'x', 'pendente', 't')");
  const g2 = await rodarGestor(env, fetchMeta, new Date("2026-10-30T15:00:00Z"));
  assert.equal(g2.recusadas, 1);
  assert.equal(pedidos.length, 2, "nada novo foi enviado");
});

test("gestor: teto na hora de executar e erro da Meta ficam registrados", async () => {
  const { env, sqlite } = banco();
  await semear(env);
  await gravarEstado(env.DB, "gestor", 2, null, "teste");
  sqlite.exec(`INSERT INTO ads_acoes (dia, origem, plataforma, alvo_tipo, alvo_id, alvo_nome, tipo, valor_cents, valor_anterior_cents, motivo, status, criado_em) VALUES
    ('2026-10-29', 'analista_ia', 'meta', 'campanha', 'C', 'Parada', 'ativar', NULL, 10000, 'voltar', 'pendente', 't'),
    ('2026-10-29', 'analista_ia', 'meta', 'campanha', 'A', 'Fundo', 'aumentar', 21000, 20000, 'x', 'pendente', 't')`);
  // ativar C: 25000 + 10000 = 35000 > 34500 → teto; aumentar A: a Meta responde erro
  const g = await rodarGestor(env, (async () => resposta({ error: { message: "(#200) permissão" } }, 400)) as unknown as typeof fetch, AGORA);
  assert.deepEqual([g.recusadas, g.erros, g.executadas], [1, 1, 0]);
  const rows = sqlite.prepare("SELECT alvo_id, status, recusa, resposta FROM ads_acoes ORDER BY id").all() as Array<Record<string, string | null>>;
  assert.match(String(rows[0].recusa), /^teto/);
  assert.equal(rows[1].status, "erro");
  assert.match(String(rows[1].resposta), /HTTP 400/);
});

test("reversão: 3 dias depois, custo por cadastro 30% pior → ação inversa executada e original marcada", async () => {
  const { env, sqlite } = banco();
  await semear(env);
  await gravarEstado(env.DB, "gestor", 2, null, "teste");
  // ação executada em 26/10 com baseline de R$ 25 por cadastro, revisão em 29/10
  sqlite.exec(`INSERT INTO ads_acoes (dia, origem, plataforma, alvo_tipo, alvo_id, alvo_nome, tipo, valor_cents, valor_anterior_cents, motivo, status, baseline_json, executada_em, revisar_em, criado_em) VALUES
    ('2026-10-26', 'analista_ia', 'meta', 'campanha', 'A', 'Fundo', 'aumentar', 20000, 16000, 'x', 'executada', '{"gasto_7d":100000,"cadastros_7d":40,"custo_cadastro_7d":2500,"orcamento_antes":16000}', 't', '2026-10-29', 't')`);
  // hoje A está a 20000/8 = R$ 25 por cadastro: não piorou → só fecha a revisão
  const pedidos: string[] = [];
  const fetchMeta = (async (_u: string, init?: RequestInit) => { pedidos.push(String(init?.body)); return resposta({ success: true }); }) as unknown as typeof fetch;
  const g1 = await rodarGestor(env, fetchMeta, AGORA);
  assert.deepEqual([g1.revisadas, g1.revertidas], [1, 0]);
  assert.equal((sqlite.prepare("SELECT revisar_em FROM ads_acoes WHERE id = 1").get() as { revisar_em: string | null }).revisar_em, null);
  // piorou: cadastros de A nos últimos 7 dias caem para 2 (R$ 700 por cadastro)
  sqlite.exec("UPDATE ads_gasto_diario SET resultados = 0 WHERE campanha_id = 'A' AND dia >= '2026-10-24'");
  sqlite.exec("UPDATE ads_acoes SET revisar_em = '2026-10-29' WHERE id = 1");
  const g2 = await rodarGestor(env, fetchMeta, AGORA);
  assert.deepEqual([g2.revisadas, g2.revertidas], [1, 1]);
  assert.deepEqual(pedidos, ["daily_budget=16000"]);
  const rows = sqlite.prepare("SELECT id, origem, tipo, status, revertida_por FROM ads_acoes ORDER BY id").all() as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((r) => [r.origem, r.tipo, r.status, r.revertida_por]), [["analista_ia", "aumentar", "revertida", 2], ["reversao", "orcamento", "executada", null]]);
});

test("rodarEquipe: registra as execuções e respeita o botão de parar do analista", async () => {
  const { env, sqlite } = banco();
  await semear(env);
  await gravarEstado(env.DB, "analista", null, true, "teste");
  const r = await rodarEquipe(env, "manual", (async () => resposta({ success: true })) as unknown as typeof fetch, AGORA);
  assert.deepEqual(r.analista, { pulado: "parado: analista" });
  const ex = sqlite.prepare("SELECT agente, ok FROM agentes_execucoes ORDER BY id").all() as Array<{ agente: string; ok: number }>;
  assert.deepEqual(ex.map((x) => ({ ...x })), [{ agente: "vigia", ok: 1 }, { agente: "gestor", ok: 1 }]);
});
