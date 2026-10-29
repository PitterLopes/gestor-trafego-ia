import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { enviarAlertas, registrarAlerta, rodarVigia } from "../src/agentes/vigia.ts";
import { lerPlanoSemana, planoParaModelo, rodarEstrategista, semanaIso } from "../src/agentes/estrategista.ts";
import { dadosDaSemana, rodarRelator } from "../src/agentes/relator.ts";
import { listar, normEmail, normTelefone, rodarPublicos } from "../src/agentes/publicos.ts";
import { ehSegunda, rodarEquipe, rodarVigiaHorario } from "../src/agentes/equipe.ts";
import type { EquipeEnv } from "../src/agentes/equipe.ts";
import { gravarCampanhas, gravarGasto } from "../src/anuncios.ts";
import { gravarEstado } from "../src/agentes/gestor.ts";
import { montarDossie } from "../src/agentes/dossie.ts";

/**
 * Vigia, Estrategista, Relator e Públicos (src/agentes/), e a rodada completa (equipe.ts), com Meta, modelo e
 * e-mail falsos num SQLite com as migrações de verdade.
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
const MIGRACOES = ["0001_pagamento.sql", "0002_anuncios.sql", "0003_analista.sql", "0004_agentes.sql", "0005_criador.sql", "0006_biblioteca.sql", "0007_equipe.sql"];
function banco(extra: Partial<EquipeEnv> = {}): { env: EquipeEnv; sqlite: DatabaseSync; emails: Array<{ to: string; subject: string; text: string }> } {
  const sqlite = new DatabaseSync(":memory:");
  for (const m of MIGRACOES) sqlite.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"));

  const emails: Array<{ to: string; subject: string; text: string }> = [];
  const EMAIL = { send: async (m: { to: string; subject: string; text: string }) => { emails.push({ to: m.to, subject: m.subject, text: m.text }); return { messageId: "1" }; } };
  return { env: { DB: d1Falso(sqlite), OPENROUTER_API_KEY: "or", META_ADS_TOKEN: "tk", META_AD_ACCOUNT_ID: "123", EMAIL, APP_URL: "https://app.test", ALERTA_EMAILS: "socio@x.com, Socio@x.com", ...extra } as EquipeEnv, sqlite, emails };
}
const AGORA = new Date("2026-10-29T15:00:00Z"); // quarta
const SEGUNDA = new Date("2026-11-02T15:00:00Z");
const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });
const respostaLlm = (conteudo: unknown, modelo = "anthropic/claude-sonnet-5.5") => resposta({ model: modelo, choices: [{ message: { content: JSON.stringify(conteudo) } }], usage: { prompt_tokens: 1000, completion_tokens: 300, cost: 0.01 } });

async function semear(env: EquipeEnv): Promise<void> {
  const linhas = [];
  for (let k = 1; k < 20; k++) {
    const d = new Date(AGORA.getTime() - k * 86_400_000).toISOString().slice(0, 10);
    linhas.push({ dia: d, plataforma: "meta" as const, campanha_id: "A", campanha: "Fundo", gasto_cents: 20_000, impressoes: 100, cliques: 20, resultados: 8 });
  }
  await gravarGasto(env.DB, linhas);
  await gravarCampanhas(env.DB, [{ plataforma: "meta", campanha_id: "A", campanha: "Fundo", status: "ACTIVE", orcamento_diario_cents: 20_000, objetivo: "OUTCOME_LEADS" }, { plataforma: "meta", campanha_id: "B", campanha: "Vazia", status: "ACTIVE", orcamento_diario_cents: 5_000, objetivo: null }]);
}

/** fetch falso da Meta para o Vigia: anúncios com problema e gasto de hoje configuráveis. */
function metaVigia(opts: { problemas?: Array<Record<string, unknown>>; gastoHoje?: number }) {
  return (async (url: string) => {
    if (url.includes("/ads?")) return resposta({ data: opts.problemas ?? [] });
    if (url.includes("date_preset=today")) return resposta({ data: [{ spend: String((opts.gastoHoje ?? 0) / 100) }] });
    if (url.includes("openrouter")) return respostaLlm({ texto: "Semana ok." }, "anthropic/claude-haiku-5.5");
    return resposta({ success: true });
  }) as unknown as typeof fetch;
}

// ---------- vigia ----------

test("vigia: reprovação vira alerta grave único no dia; e-mail só para administradores; não repete", async () => {
  const { env, sqlite, emails } = banco();
  await semear(env);
  const f = metaVigia({ problemas: [{ id: "ad1", name: "Mock", effective_status: "DISAPPROVED", issues_info: [{ error_summary: "Texto na imagem acima do permitido" }] }] });
  const v1 = await rodarVigia(env, "horario", 2, f, AGORA);
  assert.deepEqual([v1.alertas_novos, v1.enviados, v1.pausas_enfileiradas], [1, 1, 0]);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, "socio@x.com");
  assert.match(emails[0].subject, /^GRAVE: 1 alerta/);
  assert.match(emails[0].text, /Texto na imagem/);
  const v2 = await rodarVigia(env, "horario", 2, f, AGORA);
  assert.deepEqual([v2.alertas_novos, v2.enviados], [0, 0]);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM alertas").get() as { n: number }).n, 1);
});

test("vigia: gasto do dia acima de 105% do teto pausa as ativas (nível 2) e só avisa (nível 1)", async () => {
  const { env, sqlite } = banco();
  await semear(env);
  const f = metaVigia({ gastoHoje: 40_000 });
  const v = await rodarVigia(env, "horario", 2, f, AGORA);
  assert.equal(v.pausas_enfileiradas, 2);
  const fila = sqlite.prepare("SELECT origem, alvo_id, tipo, status FROM ads_acoes ORDER BY id").all() as Array<Record<string, string>>;
  assert.deepEqual(fila.map((a) => [a.origem, a.alvo_id, a.tipo, a.status]), [["vigia", "A", "pausar", "pendente"], ["vigia", "B", "pausar", "pendente"]]);
  const { env: env1 } = banco();
  await semear(env1);
  const v1 = await rodarVigia(env1, "horario", 1, f, AGORA);
  assert.equal(v1.pausas_enfileiradas, 0);
  assert.equal(v1.alertas_novos, 1);
});

test("vigia completo: campanha ativa sem gasto ontem e erros do time viram avisos", async () => {
  const { env, sqlite } = banco();
  await semear(env); // B está ativa e não tem gasto nenhum
  sqlite.exec("INSERT INTO agentes_execucoes (agente, dia, gatilho, ok, resumo, duracao_ms, criado_em) VALUES ('criador', '2026-10-29', 'cron', 0, 'render: timeout', 1, '" + new Date(AGORA.getTime() - 3600_000).toISOString() + "')");
  const v = await rodarVigia(env, "completo", 2, metaVigia({}), AGORA);
  const chaves = (sqlite.prepare("SELECT chave FROM alertas ORDER BY id").all() as Array<{ chave: string }>).map((x) => x.chave);
  assert.deepEqual(chaves, ["sem_gasto:B", "erro:criador"]);
  assert.equal(v.alertas_novos, 2);
});

test("rodarVigiaHorario executa as pausas pelo Gestor na hora", async () => {
  const { env, sqlite } = banco();
  await semear(env);
  await gravarEstado(env.DB, "gestor", 2, null, "t");
  const r = await rodarVigiaHorario(env, metaVigia({ gastoHoje: 40_000 }), AGORA);
  assert.equal((r.gestor as { executadas: number }).executadas, 2);
  assert.deepEqual((sqlite.prepare("SELECT status FROM ads_acoes").all() as Array<{ status: string }>).map((x) => x.status), ["executada", "executada"]);
});

// ---------- estrategista ----------

test("semanaIso e ehSegunda", () => {
  assert.equal(semanaIso(AGORA), "2026-W44");
  assert.equal(semanaIso(SEGUNDA), "2026-W45");
  assert.equal(ehSegunda(AGORA), false);
  assert.equal(ehSegunda(SEGUNDA), true);
});

const PLANO = { diagnostico: "Conta estável a R$ 25 por cadastro.", metas: { custo_cadastro_alvo_cents: 2400, cadastros_semana: 60 }, teto_diario_sugerido_cents: 99_999, angulos: [{ angulo: "histórico fica na empresa", motivo: "melhor anúncio fala disso" }, { angulo: "setor certo", motivo: "página promete" }, { angulo: "terceiro", motivo: "x" }], prioridades: ["não aumentar sem 7 dias de dado"] };

test("lerPlanoSemana limita o teto ao do código e corta ângulos em 3", () => {
  const p = lerPlanoSemana(PLANO)!;
  assert.equal(p.teto_diario_sugerido_cents, 30_000);
  assert.equal(p.angulos.length, 3);
  assert.equal(lerPlanoSemana({ diagnostico: "x" }), null);
  assert.match(planoParaModelo({ semana: "2026-W44", plano: p }), /PLANO DA SEMANA 2026-W44/);
});

test("estrategista: escreve o plano uma vez por semana, registra 2 pedidos de criativo e o dossiê passa a citá-lo", async () => {
  const { env, sqlite } = banco();
  await semear(env);
  const f = (async (url: string) => (url.includes("openrouter") ? respostaLlm(PLANO) : resposta({}))) as unknown as typeof fetch;
  const r1 = await rodarEstrategista(env, f, AGORA);
  assert.equal(r1.feito, true);
  assert.equal(r1.pedidos, 2);
  const r2 = await rodarEstrategista(env, f, AGORA);
  assert.equal(r2.feito, false);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM ads_pedidos_criativo WHERE origem = 'estrategista'").get() as { n: number }).n, 2);
  const d = await montarDossie(env.DB, AGORA);
  assert.match(String(d.plano_semana), /Semana 2026-W44/);
});

// ---------- relator ----------

test("relator: junta a semana e a anterior, escreve com o modelo, manda aos administradores e guarda", async () => {
  const { env, sqlite, emails } = banco();
  await semear(env);
  const d = await dadosDaSemana(env.DB, AGORA);
  assert.equal((d.semana as { gasto_cents: number }).gasto_cents, 140_000);
  assert.equal((d.anterior as { gasto_cents: number }).gasto_cents, 140_000);
  const f = (async (url: string) => (url.includes("openrouter") ? respostaLlm({ texto: "Semana estável: R$ 1.400,00 e 56 cadastros." }, "anthropic/claude-haiku-5.5") : resposta({}))) as unknown as typeof fetch;
  const r = await rodarRelator(env, f, SEGUNDA);
  assert.equal(r.feito, true);
  assert.deepEqual(r.enviado_para, ["socio@x.com"]);
  assert.equal(emails.length, 1);
  assert.match(emails[0].subject, /Relatório dos anúncios · 2026-W45/);
  assert.equal((sqlite.prepare("SELECT texto FROM relatorios").get() as { texto: string }).texto, "Semana estável: R$ 1.400,00 e 56 cadastros.");
  assert.equal((await rodarRelator(env, f, SEGUNDA)).feito, false);
});

test("relator sem modelo: ainda grava um resumo automático com os números", async () => {
  const { env } = banco();
  await semear(env);
  const f = (async () => resposta({ error: { message: "fora" } }, 500)) as unknown as typeof fetch;
  const r = await rodarRelator(env, f, SEGUNDA);
  assert.equal(r.feito, true);
  // os dados de exemplo vão até 28/10: a semana de 26/10 a 1/11 tem 3 dias com gasto
  assert.match(String(r.texto), /^Semana 2026-10-26 a 2026-11-01: R\$ 600,00 gastos, 24 cadastros \(R\$ 25,00 cada\)/);
});

// ---------- públicos ----------

test("normalização de e-mail e telefone", () => {
  assert.equal(normEmail(" Fulano@X.com "), "fulano@x.com");
  assert.equal(normEmail("sem-arroba"), null);
  assert.equal(normTelefone("(21) 96680-3124"), "5521966803124");
  assert.equal(normTelefone("+55 21 96680-3124"), "5521966803124");
  assert.equal(normTelefone("123"), null);
});

function semearPagamento(sqlite: DatabaseSync): void {
  const cli = (id: string, email: string, telefone: string, atendentes: number | null, criado = "2026-10-01T10:00:00-03:00", cancelado: string | null = null) =>
    sqlite.exec(`INSERT INTO clientes (id, email, telefone, criado_em, atendentes, cancelado_em, atualizado_em) VALUES ('${id}', '${email}', '${telefone}', '${criado}', ${atendentes ?? "NULL"}, ${cancelado ? `'${cancelado}'` : "NULL"}, 'x')`);
  const pago = (id: string, cliente: string, dia: string) => sqlite.exec(`INSERT INTO pagamentos (id, cliente_id, pago_em, valor_cents, atualizado_em) VALUES ('${id}', '${cliente}', '${dia}', 1000, 'x')`);
  cli("c1", "fiel@x.com", "21999990001", 4); pago("p1a", "c1", "2026-08-01"); pago("p1b", "c1", "2026-09-01");
  cli("c2", "solo@x.com", "21999990002", 1); pago("p2a", "c2", "2026-08-01"); pago("p2b", "c2", "2026-09-01"); // paga, mas time de 1: fora dos fiéis
  cli("c3", "saiu@x.com", "", 2, "2026-07-01T10:00:00-03:00", "2026-08-15"); pago("p3", "c3", "2026-07-01");
  cli("c4", "", "21999990004", null, new Date(AGORA.getTime() - 10 * 86_400_000).toISOString());
  cli("c5", "velho@x.com", "", null, "2025-01-01T10:00:00-03:00");
}

test("listas do pagamento: fiéis (2+ pagamentos, 3+ atendentes), saíram cedo, entraram e não pagaram", async () => {
  const { env, sqlite } = banco();
  semearPagamento(sqlite);
  assert.deepEqual(await listar(env.DB, "clientes_fieis", AGORA), [{ email: "fiel@x.com", telefone: "5521999990001" }]);
  assert.deepEqual(await listar(env.DB, "sairam_cedo", AGORA), [{ email: "saiu@x.com", telefone: null }]);
  assert.deepEqual(await listar(env.DB, "entraram_nao_pagaram", AGORA), [{ email: null, telefone: "5521999990004" }]);
});

test("públicos nível 1 só conta; nível 2 cria o público, manda hash e exige 100 fiéis para o semelhante", async () => {
  const { env, sqlite } = banco();
  semearPagamento(sqlite);
  const r1 = await rodarPublicos(env, 1, (async () => resposta({})) as unknown as typeof fetch, AGORA);
  assert.deepEqual(r1.listas.map((l) => [l.nome, l.pessoas, l.resposta]), [["clientes_fieis", 1, "só contagem"], ["sairam_cedo", 1, "só contagem"], ["entraram_nao_pagaram", 1, "só contagem"]]);
  const pedidos: Array<{ url: string; corpo: string }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    pedidos.push({ url, corpo: String(init?.body ?? "") });
    if (url.endsWith("/customaudiences")) return resposta({ id: "aud" + pedidos.length });
    if (url.endsWith("/users")) return resposta({ num_received: 1 });
    return resposta({});
  }) as unknown as typeof fetch;
  const r2 = await rodarPublicos(env, 2, f, AGORA);
  assert.equal(r2.erros, 0);
  assert.equal(r2.listas[0].resposta, "menos de 100 pessoas");
  assert.equal(r2.semelhante, null, "sem fiéis suficientes não cria semelhante");
  const envios = pedidos.filter((p) => p.url.endsWith("/users"));
  assert.equal(envios.length, 2);
  const payload = JSON.parse(String(new URLSearchParams(envios[0].corpo).get("payload"))) as { schema: string[]; data: string[][] };
  assert.deepEqual(payload.schema, ["EMAIL", "PHONE"]);
  assert.match(payload.data[0][0], /^[0-9a-f]{64}$/, "e-mail vai em SHA-256");
  const guardados = sqlite.prepare("SELECT nome, publico_id, pessoas FROM ads_publicos ORDER BY nome").all() as Array<Record<string, unknown>>;
  assert.deepEqual(guardados.map((g) => [g.nome, typeof g.publico_id, g.pessoas]), [["clientes_fieis", "object", 1], ["entraram_nao_pagaram", "string", 1], ["sairam_cedo", "string", 1]]);
});

// ---------- rodada completa ----------

test("rodarEquipe numa quarta: vigia, estrategista, analista e gestor rodam; relator e públicos ficam para segunda", async () => {
  const { env, sqlite } = banco();
  await semear(env);
  const f = (async (url: string, init?: RequestInit) => {
    if (url.includes("openrouter")) {
      const sistema = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0].content;
      if (/estrategista/.test(sistema)) return respostaLlm(PLANO);
      return respostaLlm({ resumo: "ok", acoes: [{ campanha_id: "A", tipo: "manter", valor_cents: null, motivo: "m", confianca: 0.9 }], pedidos_criativo: [] });
    }
    if (url.includes("/ads?")) return resposta({ data: [] });
    if (url.includes("date_preset=today")) return resposta({ data: [{ spend: "10" }] });
    return resposta({ success: true });
  }) as unknown as typeof fetch;
  const r = await rodarEquipe(env, "cron", f, AGORA);
  assert.equal((r.estrategista as { feito: boolean }).feito, true);
  assert.equal((r.analista as { origem: string }).origem, "analista_ia");
  assert.equal(r.relator, undefined);
  assert.equal(r.publicos, undefined);
  const agentes = (sqlite.prepare("SELECT DISTINCT agente FROM agentes_execucoes ORDER BY agente").all() as Array<{ agente: string }>).map((x) => x.agente);
  assert.deepEqual(agentes, ["analista", "estrategista", "gestor", "vigia"]);
});
