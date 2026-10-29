import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { coletarMeta, gravarGasto, linhasDaMeta, metaGastoAtivo, resumoGasto, varrerGasto } from "../src/anuncios.ts";
import type { AnunciosEnv } from "../src/anuncios.ts";

/**
 * Gasto diário dos anúncios (src/anuncios.ts): leitura da resposta de insights da Meta, paginação, regravação
 * segura no SQLite com a migração de verdade e erro de uma plataforma sem derrubar a passada.
 */

const pagina = {
  data: [
    {
      campaign_id: "C1",
      campaign_name: "[3] [Teste] [Fundo] [Aberto] [Semelhante 5%]",
      date_start: "2026-10-28",
      spend: "201.37",
      impressions: "1700",
      inline_link_clicks: "52",
      actions: [
        { action_type: "link_click", value: "60" },
        { action_type: "lead", value: "8" },
        { action_type: "offsite_conversion.fb_pixel_lead", value: "8" },
      ],
    },
    { campaign_id: "C2", campaign_name: "Parada", date_start: "2026-10-28", spend: "0", impressions: "0" },
    { campaign_name: "sem id", date_start: "2026-10-28", spend: "5" },
  ],
};

test("linhasDaMeta converte gasto para centavos e conta cadastro uma vez só", () => {
  const l = linhasDaMeta(pagina);
  assert.equal(l.length, 2, "linha sem id de campanha é descartada");
  assert.deepEqual(l[0], {
    dia: "2026-10-28",
    plataforma: "meta",
    campanha_id: "C1",
    campanha: "[3] [Teste] [Fundo] [Aberto] [Semelhante 5%]",
    gasto_cents: 20137,
    impressoes: 1700,
    cliques: 52,
    resultados: 8,
  });
  assert.equal(l[1].gasto_cents, 0);
  assert.equal(l[1].resultados, 0);
  assert.deepEqual(linhasDaMeta({}), []);
});

test("metaGastoAtivo precisa do token e da conta", () => {
  assert.equal(metaGastoAtivo({ DB: {} as D1Database }), false);
  assert.equal(metaGastoAtivo({ DB: {} as D1Database, META_ADS_TOKEN: "t" }), false);
  assert.equal(metaGastoAtivo({ DB: {} as D1Database, META_ADS_TOKEN: "t", META_AD_ACCOUNT_ID: "123456789" }), true);
});

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

function banco(): { env: AnunciosEnv; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  for (const m of ["0001_pagamento.sql", "0002_anuncios.sql", "0003_analista.sql", "0004_agentes.sql", "0005_criador.sql", "0006_biblioteca.sql", "0007_equipe.sql", "0008_negocio.sql", "0009_feedback_video.sql"]) sqlite.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"));
  return { env: { DB: d1Falso(sqlite), META_ADS_TOKEN: "tok", META_AD_ACCOUNT_ID: "123" }, sqlite };
}

const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });

test("coletarMeta pede o intervalo certo, manda o token no cabeçalho e segue a paginação", async () => {
  const { env } = banco();
  const urls: string[] = [];
  const tokens: string[] = [];
  const fetchFalso = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    tokens.push(String((init?.headers as Record<string, string>).authorization));
    return urls.length === 1 ? resposta({ ...pagina, paging: { next: "https://graph.facebook.com/proxima" } }) : resposta({ data: [{ campaign_id: "C3", campaign_name: "Outra", date_start: "2026-10-27", spend: "10" }] });
  }) as unknown as typeof fetch;
  const linhas = await coletarMeta(env, "2026-10-22", "2026-10-28", fetchFalso);
  assert.equal(linhas.length, 3);
  assert.match(urls[0], /\/act_123\/insights\?/);
  assert.match(decodeURIComponent(urls[0]), /"since":"2026-10-22","until":"2026-10-28"/);
  assert.equal(urls[1], "https://graph.facebook.com/proxima");
  assert.deepEqual(tokens, ["Bearer tok", "Bearer tok"]);
});

test("gravarGasto regrava o mesmo dia sem duplicar e atualiza os números", async () => {
  const { env, sqlite } = banco();
  await gravarGasto(env.DB, linhasDaMeta(pagina));
  await gravarGasto(env.DB, linhasDaMeta({ data: [{ ...pagina.data[0], spend: "250.00", actions: [{ action_type: "lead", value: "10" }] }] }));
  const r = sqlite.prepare("SELECT gasto_cents, resultados FROM ads_gasto_diario WHERE campanha_id = 'C1'").all() as Array<{ gasto_cents: number; resultados: number }>;
  assert.deepEqual(r.map((x) => ({ ...x })), [{ gasto_cents: 25000, resultados: 10 }]);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM ads_gasto_diario").get() as { n: number }).n, 2);
});

test("varrerGasto relê 7 dias no fuso de Brasília, grava e resume por mês", async () => {
  const { env } = banco();
  const urls: string[] = [];
  const fetchFalso = (async (u: string) => {
    urls.push(u);
    return u.includes("/campaigns?") ? resposta({ data: [{ id: "C1", name: "Fundo", effective_status: "ACTIVE", daily_budget: "20000", objective: "OUTCOME_LEADS" }] }) : resposta(pagina);
  }) as unknown as typeof fetch;
  // 29/10 01:00 UTC ainda é 28/10 em Brasília.
  const r = await varrerGasto(env, fetchFalso, new Date("2026-10-29T01:00:00Z"));
  assert.deepEqual(r, { meta: { linhas: 2, campanhas: 1, anuncios: 0, linhas_anuncio: 0 } });
  assert.match(decodeURIComponent(urls[0]), /"since":"2026-10-22","until":"2026-10-28"/);
  assert.match(urls[1], /\/act_123\/campaigns\?/);
  const resumo = (await resumoGasto(env.DB)) as { meses: Array<{ mes: string; plataforma: string; gasto_cents: number }> };
  assert.deepEqual(resumo.meses.map((m) => [m.mes, m.plataforma, m.gasto_cents]), [["2026-10", "meta", 20137]]);
});

test("varrerGasto: erro da Meta vira resultado e plataforma desligada não é consultada", async () => {
  const { env } = banco();
  const falha = (async () => resposta({ error: { message: "token expirado" } }, 400)) as unknown as typeof fetch;
  const r = await varrerGasto(env, falha);
  assert.match(String((r.meta as { erro: string }).erro), /HTTP 400.*token expirado/);
  let chamou = false;
  const espiao = (async () => {
    chamou = true;
    return resposta(pagina);
  }) as unknown as typeof fetch;
  assert.deepEqual(await varrerGasto({ DB: env.DB }, espiao), { meta: null });
  assert.equal(chamou, false);
});
