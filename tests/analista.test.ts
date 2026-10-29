import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { FREQUENCIA_DIAS, PAUSAR_SEM_CADASTRO_CENTS, TETO_DIARIO_CENTS, analisar, lerCampanhas, lerConta, resumoAnalista, rodarAnalista } from "../src/analista.ts";
import type { CampanhaJanela, ContaJanela } from "../src/analista.ts";
import { campanhasDaMeta, gravarCampanhas, gravarGasto } from "../src/anuncios.ts";

/**
 * Analista de anúncios (src/analista.ts): as regras puras (pausar, reduzir, manter, teto, frequência) e, num SQLite
 * com as migrações de verdade, as janelas lidas do banco e a gravação em modo sombra sem duplicar.
 */

const conta: ContaJanela = { gasto_7d: 140_000, cadastros_7d: 50, entradas_7d: 14, clientes_7d: 9, gasto_28d: 600_000, cadastros_28d: 220, entradas_28d: 60, clientes_28d: 40, coorte_clientes: 30, coorte_seguiram: 20 };
const camp = (x: Partial<CampanhaJanela>): CampanhaJanela => ({ plataforma: "meta", campanha_id: "C", campanha: "Campanha", status: "ACTIVE", orcamento_diario_cents: 20_000, gasto_7d: 100_000, cadastros_7d: 40, gasto_28d: 400_000, cadastros_28d: 160, ultima_mudanca_dias: null, ...x });

test("resumo sempre sai, com custo por cadastro, entrada e cliente", () => {
  const [r] = analisar(conta, []);
  assert.equal(r.tipo, "resumo");
  assert.match(r.motivo, /custo por cadastro R\$ 27,27/);
  assert.match(r.motivo, /por cliente R\$ 150,00/);
  assert.match(r.motivo, /20 de 30 seguiram/);
});

test("pausar: gasto sem cadastro acima do limite; abaixo do limite mantém", () => {
  const d = analisar(conta, [camp({ campanha_id: "A", gasto_7d: PAUSAR_SEM_CADASTRO_CENTS, cadastros_7d: 0 }), camp({ campanha_id: "B", gasto_7d: 5_000, cadastros_7d: 0 })]);
  assert.deepEqual(d.filter((x) => x.campanha_id).map((x) => [x.campanha_id, x.tipo]), [["A", "pausar"], ["B", "manter"]]);
});

test("reduzir: custo por cadastro acima de 2× o da conta, só com gasto mínimo", () => {
  // conta: R$ 27,27 por cadastro nos 28 dias; campanha a R$ 100 por cadastro
  const d = analisar(conta, [camp({ campanha_id: "A", gasto_7d: 20_000, cadastros_7d: 2 }), camp({ campanha_id: "B", gasto_7d: 5_000, cadastros_7d: 0 })]);
  assert.equal(d.find((x) => x.campanha_id === "A")?.tipo, "reduzir");
  assert.equal(d.find((x) => x.campanha_id === "B")?.tipo, "manter", "pouco gasto: nem pausa nem reduz");
});

test("frequência: mudança recente vira bloqueio, mudança antiga não", () => {
  const d = analisar(conta, [camp({ campanha_id: "A", gasto_7d: 20_000, cadastros_7d: 0, ultima_mudanca_dias: 2 }), camp({ campanha_id: "B", gasto_7d: 20_000, cadastros_7d: 0, ultima_mudanca_dias: FREQUENCIA_DIAS })]);
  assert.equal(d.find((x) => x.campanha_id === "A")?.bloqueio, "frequencia");
  assert.equal(d.find((x) => x.campanha_id === "B")?.bloqueio, null);
});

test("campanha pausada ou sem gasto não recebe decisão; teto gera alerta", () => {
  const d = analisar(conta, [camp({ campanha_id: "P", status: "PAUSED" }), camp({ campanha_id: "Z", gasto_7d: 0 }), camp({ campanha_id: "A", orcamento_diario_cents: TETO_DIARIO_CENTS + 100 })]);
  assert.deepEqual(d.map((x) => x.tipo), ["resumo", "alerta_teto", "manter"]);
});

// ---------- com banco ----------

function d1Falso(db: DatabaseSync): D1Database {
  const prepare = (sqlD1: string) => {
    const numerado = /\?\d+/.test(sqlD1);
    const stmt = db.prepare(numerado ? sqlD1.replace(/\?(\d+)/g, "$p$1") : sqlD1);
    const comArgs = (lista: unknown[]) => {
      const args = numerado ? [Object.fromEntries(lista.map((v, i) => [`p${i + 1}`, v]))] : lista;
      return {
        all: async () => ({ results: stmt.all(...(args as never[])), success: true, meta: {} }),
        first: async () => stmt.get(...(args as never[])) ?? null,
        run: async () => {
          const r = stmt.run(...(args as never[]));
          return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
        },
      };
    };
    return { ...comArgs([]), bind: (...args: unknown[]) => comArgs(args) };
  };
  return { prepare } as unknown as D1Database;
}

function banco(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  for (const m of ["0001_pagamento.sql", "0002_anuncios.sql", "0003_analista.sql", "0004_agentes.sql", "0005_criador.sql", "0006_biblioteca.sql", "0007_equipe.sql", "0008_negocio.sql", "0009_feedback_video.sql"]) sqlite.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"));
  return { db: d1Falso(sqlite), sqlite };
}

const AGORA = new Date("2026-10-29T15:00:00Z"); // 29/10 em Brasília

test("lerConta e lerCampanhas montam as janelas a partir do banco", async () => {
  const { db, sqlite } = banco();
  await gravarGasto(db, [
    { dia: "2026-10-29", plataforma: "meta", campanha_id: "A", campanha: "Fundo", gasto_cents: 20_000, impressoes: 1, cliques: 1, resultados: 8 },
    { dia: "2026-10-20", plataforma: "meta", campanha_id: "A", campanha: "Fundo", gasto_cents: 30_000, impressoes: 1, cliques: 1, resultados: 10 },
    { dia: "2026-09-01", plataforma: "meta", campanha_id: "A", campanha: "Fundo", gasto_cents: 99_000, impressoes: 1, cliques: 1, resultados: 99 },
  ]);
  await gravarCampanhas(db, campanhasDaMeta({ data: [{ id: "A", name: "Fundo (novo nome)", effective_status: "ACTIVE", daily_budget: "20000", objective: "OUTCOME_LEADS" }] }));
  // entradas (clientes criados) e pagamentos (1º pagamento = cliente; 2º = seguiu)
  sqlite.exec("INSERT INTO clientes (id, criado_em, atualizado_em) VALUES ('c1', '2026-10-28T10:00:00-03:00', 'x'), ('c2', '2026-10-05T10:00:00-03:00', 'x')");
  const pago = (id: string, cliente: string, dia: string) => sqlite.exec(`INSERT INTO pagamentos (id, cliente_id, pago_em, valor_cents, atualizado_em) VALUES ('${id}', '${cliente}', '${dia}', 1000, 'x')`);
  pago("p1", "c1", "2026-10-27");
  pago("p2", "c2", "2026-10-10");
  pago("p4a", "c4", "2026-09-10"); // coorte 35-63 dias
  pago("p4b", "c4", "2026-10-10"); // seguiu
  pago("p5", "c5", "2026-09-12"); // coorte, não seguiu

  const conta = await lerConta(db, AGORA);
  assert.deepEqual(conta, { gasto_7d: 20_000, cadastros_7d: 8, entradas_7d: 1, clientes_7d: 1, gasto_28d: 50_000, cadastros_28d: 18, entradas_28d: 2, clientes_28d: 2, coorte_clientes: 2, coorte_seguiram: 1 });

  const [c] = await lerCampanhas(db, AGORA);
  assert.equal(c.campanha, "Fundo (novo nome)", "nome vem de ads_campanhas quando existe");
  assert.equal(c.status, "ACTIVE");
  assert.equal(c.orcamento_diario_cents, 20_000);
  assert.deepEqual([c.gasto_7d, c.cadastros_7d, c.gasto_28d, c.cadastros_28d, c.ultima_mudanca_dias], [20_000, 8, 50_000, 18, null]);
});

test("rodarAnalista grava em modo sombra, não duplica e a frequência lê as decisões anteriores", async () => {
  const { db, sqlite } = banco();
  await gravarGasto(db, [{ dia: "2026-10-29", plataforma: "meta", campanha_id: "A", campanha: "Sem cadastro", gasto_cents: 20_000, impressoes: 1, cliques: 1, resultados: 0 }]);
  await gravarCampanhas(db, [{ plataforma: "meta", campanha_id: "A", campanha: "Sem cadastro", status: "ACTIVE", orcamento_diario_cents: 20_000, objetivo: null }]);
  const r1 = await rodarAnalista({ DB: db }, AGORA);
  assert.equal(r1.dia, "2026-10-29");
  assert.deepEqual(r1.decisoes.map((d) => [d.tipo, d.bloqueio]), [["resumo", null], ["pausar", null]]);
  await rodarAnalista({ DB: db }, AGORA);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM ads_decisoes").get() as { n: number }).n, 2, "rodar duas vezes no mesmo dia não duplica");

  const r2 = await rodarAnalista({ DB: db }, new Date("2026-10-31T15:00:00Z"));
  assert.equal(r2.decisoes[1].bloqueio, "frequencia", "2 dias depois a mesma decisão fica bloqueada");
  const resumo = (await resumoAnalista(db)) as { decisoes: Array<{ dia: string; tipo: string; dados: { gasto_7d?: number } }> };
  assert.equal(resumo.decisoes.length, 4);
  assert.equal(resumo.decisoes[0].dia, "2026-10-31");
  assert.equal(resumo.decisoes.find((d) => d.tipo === "pausar")?.dados.gasto_7d, 20_000);
});
