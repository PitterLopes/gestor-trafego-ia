import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { anunciosDaMeta, gravarAnuncios, linhasAnuncioDaMeta } from "../src/anuncios.ts";
import { bibliotecaParaModelo, montarBiblioteca } from "../src/agentes/biblioteca.ts";
import { atualizarPaginas, extrairTexto, paginaParaModelo, urlsConfiguradas } from "../src/agentes/paginas.ts";
import { contextoDoCriador } from "../src/agentes/criador.ts";

/**
 * O que o Criador aprende: coleta por anúncio (texto + gasto), biblioteca de melhores e piores, e resumo das
 * landing pages (texto extraído, hash, renovação semanal), num SQLite com as migrações de verdade.
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
function banco(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  for (const m of ["0001_pagamento.sql", "0002_anuncios.sql", "0003_analista.sql", "0004_agentes.sql", "0005_criador.sql", "0006_biblioteca.sql", "0007_equipe.sql", "0008_negocio.sql", "0009_feedback_video.sql"]) sqlite.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"));
  return { db: d1Falso(sqlite), sqlite };
}
const AGORA = new Date("2026-10-29T15:00:00Z");

const PAGINA_ADS = { data: [
  { id: "a1", name: "Mock_4x5", effective_status: "ACTIVE", campaign_id: "C", adset_id: "S", creative: { id: "cr1", title: "WhatsApp organizado para escritórios", body: "Seu escritório ainda atende pelo WhatsApp pessoal do sócio?" } },
  { id: "a2", name: "Preco_4x5", effective_status: "ACTIVE", campaign_id: "C", adset_id: "S", creative: { id: "cr2", object_story_spec: { link_data: { name: "WhatsApp por setor", message: "Cada atendimento no seu setor.", description: "Teste grátis" } } } },
  { id: "a3", name: "Video", effective_status: "PAUSED", campaign_id: "C", adset_id: "S", creative: { id: "cr3" } },
  { id: "a4", name: "Caro", effective_status: "ACTIVE", campaign_id: "C", adset_id: "S", creative: { id: "cr4", body: "Texto que não trouxe ninguém." } },
  { name: "sem id" },
] };
const linhas = (dia: string, pares: Array<[string, number, number]>) => ({ data: pares.map(([id, spend, lead]) => ({ ad_id: id, date_start: dia, spend: String(spend), impressions: "100", inline_link_clicks: "5", actions: [{ action_type: "lead", value: String(lead) }] })) });

test("anunciosDaMeta lê título e texto do criativo ou do object_story_spec", () => {
  const a = anunciosDaMeta(PAGINA_ADS);
  assert.equal(a.length, 4);
  assert.deepEqual([a[0].titulo, a[0].texto], ["WhatsApp organizado para escritórios", "Seu escritório ainda atende pelo WhatsApp pessoal do sócio?"]);
  assert.deepEqual([a[1].titulo, a[1].texto, a[1].descricao], ["WhatsApp por setor", "Cada atendimento no seu setor.", "Teste grátis"]);
  assert.deepEqual([a[2].titulo, a[2].texto], [null, null]);
});

test("biblioteca: melhores por custo por cadastro, piores sem cadastro, mínimo de gasto, e o prompt", async () => {
  const { db, sqlite } = banco();
  await gravarAnuncios(db, anunciosDaMeta(PAGINA_ADS), [
    ...linhasAnuncioDaMeta(linhas("2026-10-20", [["a1", 300, 12], ["a2", 300, 4], ["a3", 80, 0], ["a4", 100, 0]])),
    ...linhasAnuncioDaMeta(linhas("2026-10-28", [["a1", 200, 8], ["a2", 100, 1], ["a3", 20, 0], ["a4", 80, 0]])),
    ...linhasAnuncioDaMeta(linhas("2026-09-01", [["a2", 5000, 1000]])), // fora dos 28 dias: não conta
  ]);
  const b = await montarBiblioteca(db, AGORA);
  assert.deepEqual(b.melhores.map((a) => [a.anuncio_id, a.custo_cadastro_cents]), [["a1", 2500], ["a2", 8000]]);
  assert.deepEqual(b.piores.map((a) => a.anuncio_id), ["a4"], "a4 gastou e não trouxe cadastro; a3 não tem texto; a2 já está nos melhores");
  assert.match(bibliotecaParaModelo(b), /"Caro" · nenhum cadastro · R\$ 180/);
  assert.equal(b.media_conta_cents, Math.round(90000 / 25));
  const txt = bibliotecaParaModelo(b);
  assert.match(txt, /O QUE FUNCIONA/);
  assert.match(txt, /"Mock_4x5" · R\$ 25,00 por cadastro/);
  assert.match(txt, /O QUE NÃO FUNCIONA/);
  // criativo do próprio Criador aparece marcado
  sqlite.exec("INSERT INTO ads_criativos (dia, plataforma, angulo, copy_json, status, criado_em, ad_id) VALUES ('2026-10-20', 'meta', 'x', '{}', 'publicado', 't', 'a2')");
  const b2 = await montarBiblioteca(db, AGORA);
  assert.equal(b2.do_criador.map((a) => a.anuncio_id).join(","), "a2");
  assert.match(bibliotecaParaModelo(b2), /CRIATIVOS ANTERIORES DO CRIADOR/);
  assert.equal(bibliotecaParaModelo({ melhores: [], piores: [], do_criador: [], media_conta_cents: null }), "");
});

test("extrairTexto tira script, tags e entidades e mantém título e descrição", () => {
  const html = `<html><head><title>Acme &amp; Cia</title><meta name="description" content="WhatsApp para equipes"><script>var x=1;</script><style>.a{}</style></head><body><nav>menu</nav><h1>Um número</h1><p>Teste gr&#225;tis, sem cart&#xE3;o.</p><footer>rodapé</footer></body></html>`;
  const t = extrairTexto(html);
  assert.ok(t.startsWith("Acme & Cia\nWhatsApp para equipes"));
  assert.ok(t.includes("Um número"));
  assert.ok(t.includes("Teste grátis, sem cartão."));
  assert.ok(!t.includes("var x") && !t.includes("menu") && !t.includes("rodapé"));
});

test("urlsConfiguradas aceita lista com vírgula e cai no CRIADOR_LINK", () => {
  assert.deepEqual(urlsConfiguradas({ DB: {} as D1Database, CRIADOR_PAGINAS: " https://a.com, https://b.com ,ftp://x, https://a.com" }), ["https://a.com", "https://b.com"]);
  assert.deepEqual(urlsConfiguradas({ DB: {} as D1Database, CRIADOR_LINK: "https://c.com" }), ["https://c.com"]);
});

test("atualizarPaginas: resume com o modelo, não repete página igual, renova depois de 7 dias e registra erro", async () => {
  const { db, sqlite } = banco();
  const env = { DB: db, OPENROUTER_API_KEY: "or", CRIADOR_PAGINAS: "https://site.test/,https://site.test/fora" };
  let html = "<html><title>Acme</title><body>" + "Um número de WhatsApp para a empresa inteira. ".repeat(10) + "R$ 25 por atendente por mês.</body></html>";
  let chamadasModelo = 0;
  const fetchFalso = (async (url: string) => {
    if (url.includes("openrouter")) { chamadasModelo += 1; return new Response(JSON.stringify({ model: "anthropic/claude-haiku-5.5", choices: [{ message: { content: JSON.stringify({ promessa_principal: "Um número para a empresa", beneficios: ["equipe inteira"], provas: [], preco: "R$ 25 por atendente/mês", chamada: "Teste grátis", publico: "empresas" }) } }], usage: { cost: 0.001 } })); }
    if (url.endsWith("/fora")) return new Response("nada", { status: 404 });
    return new Response(html, { status: 200 });
  }) as unknown as typeof fetch;
  const r1 = await atualizarPaginas(env, fetchFalso, AGORA);
  assert.deepEqual(r1.map((x) => x.resultado.split(":")[0]), ["resumida", "erro"]);
  assert.equal(chamadasModelo, 1);
  const r2 = await atualizarPaginas(env, fetchFalso, new Date(AGORA.getTime() + 86_400_000));
  assert.equal(r2[0].resultado, "ok, 1 dias");
  const r3 = await atualizarPaginas(env, fetchFalso, new Date(AGORA.getTime() + 8 * 86_400_000));
  assert.equal(r3[0].resultado, "texto igual, resumo mantido");
  assert.equal(chamadasModelo, 1, "página igual não gasta modelo");
  html = html.replace("R$ 25", "R$ 25 (novo texto)");
  const r4 = await atualizarPaginas(env, fetchFalso, new Date(AGORA.getTime() + 16 * 86_400_000));
  assert.equal(r4[0].resultado, "resumida");
  assert.equal(chamadasModelo, 2);
  const linhasDb = sqlite.prepare("SELECT url, erro FROM paginas_resumo ORDER BY url").all() as Array<{ url: string; erro: string | null }>;
  assert.equal(linhasDb[0].erro, null);
  assert.match(String(linhasDb[1].erro), /HTTP 404/);
  // o prompt do criador recebe a página de destino
  const ctx = await contextoDoCriador({ DB: db, CRIADOR_LINK: "https://site.test/" }, AGORA);
  assert.match(ctx.pagina, /PÁGINA DE DESTINO \(https:\/\/site.test\/\)/);
  assert.match(ctx.pagina, /Promessa: Um número para a empresa/);
  assert.equal(ctx.biblioteca, "");
  assert.equal(paginaParaModelo(undefined), "");
});
