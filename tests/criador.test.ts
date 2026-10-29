import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { acaoCriativo, lerCopy, metaPublicacaoConfigurada, registrarPedido, rodarCriador, verificarPorRegras } from "../src/agentes/criador.ts";
import type { Copy, CriadorEnv } from "../src/agentes/criador.ts";
import { htmlEscritorio, tituloComDestaque } from "../src/agentes/templates/escritorio.ts";

/**
 * Criador (src/agentes/criador.ts): esquema da copy, regras do verificador, template, e a rodada inteira
 * (pedido → copy → verificação → PNG no R2 → sombra ou publicação na Meta) com modelo, navegador, R2 e Meta falsos.
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

function r2Falso(): { bucket: R2Bucket; guardados: Map<string, Uint8Array> } {
  const guardados = new Map<string, Uint8Array>();
  const bucket = { put: async (k: string, v: Uint8Array) => { guardados.set(k, v); return null; }, get: async (k: string) => (guardados.has(k) ? { body: guardados.get(k), arrayBuffer: async () => guardados.get(k)!.buffer } : null) } as unknown as R2Bucket;
  return { bucket, guardados };
}

function banco(extra: Partial<CriadorEnv> = {}): { env: CriadorEnv; sqlite: DatabaseSync; r2: Map<string, Uint8Array> } {
  const sqlite = new DatabaseSync(":memory:");
  for (const m of ["0001_pagamento.sql", "0002_anuncios.sql", "0003_analista.sql", "0004_agentes.sql", "0005_criador.sql", "0006_biblioteca.sql", "0007_equipe.sql", "0008_negocio.sql", "0009_feedback_video.sql"]) sqlite.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"));
  const { bucket, guardados } = r2Falso();
  return { env: { DB: d1Falso(sqlite), CRIATIVOS: bucket, META_VIDEO_ESPERA_MS: "0", OPENROUTER_API_KEY: "or", META_ADS_TOKEN: "tk", META_AD_ACCOUNT_ID: "123", META_PAGE_ID: "p1", META_ADSET_CRIADOR_ID: "as1", CRIADOR_LINK: "https://exemplo.com.br", ...extra }, sqlite, r2: guardados };
}

const AGORA = new Date("2026-10-29T15:00:00Z");
const COPY_OK: Copy = {
  nome: "SetorCerto_4x5",
  titulo_imagem: "Seu escritório ainda atende pelo [[WhatsApp pessoal do sócio]]?",
  promessa: "Um número da empresa. | Cada setor no seu lugar.",
  texto_primario: "Comercial, dúvidas e financeiro misturados num número só.\nO sistema organiza: cada setor no seu lugar e a equipe inteira atendendo.\nTeste grátis, sem cartão · R$ 25 por atendente/mês.",
  headline: "WhatsApp organizado por setor",
  descricao: "Teste grátis, sem cartão",
  conversa: [],
  setor: "",
  atendente: "",
};
const COPY_VIDEO: Copy = {
  ...COPY_OK,
  nome: "ChatSuporte_9x16",
  setor: "Suporte · Empresa",
  atendente: "Ana · Suporte",
  conversa: [
    { de: "cliente", texto: "Oi, preciso da segunda via do boleto" },
    { de: "atendente", texto: "Olá! Aqui é a Ana, do Financeiro. Já te envio" },
    { de: "cliente", texto: "Antes eu mandava no número do dono e ficava perdido" },
    { de: "atendente", texto: "Agora cada setor responde. Protocolo 1042 aberto" },
    { de: "atendente", texto: "Boleto enviado. Vence dia 20" },
    { de: "cliente", texto: "Perfeito, obrigado!" },
  ],
};
const renderWebmFalso = async (html: string) => ({ webm: new TextEncoder().encode("WEBM:" + html.length), capa: new TextEncoder().encode("CAPA"), tipo: "video/webm" });
const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });
const respostaLlm = (conteudo: unknown, modelo: string) => resposta({ model: modelo, choices: [{ message: { content: JSON.stringify(conteudo) } }], usage: { prompt_tokens: 800, completion_tokens: 200, cost: 0.004 } });
const renderFalso = async (html: string) => new TextEncoder().encode("PNG:" + html.length);

/** fetch falso: OpenRouter (criador e verificador) e Meta (imagem, criativo, anúncio). */
function fetchFalso(opts: { copy?: unknown; verificacao?: unknown; meta?: "ok" | "erro_imagem" } = {}) {
  const chamadas: Array<{ url: string; corpo: string }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const corpo = String(init?.body ?? "");
    chamadas.push({ url, corpo });
    if (url.includes("openrouter")) {
      const j = JSON.parse(corpo) as { messages: Array<{ content: string }> };
      const ehVerificador = j.messages[0].content.includes("revisa textos");
      return ehVerificador ? respostaLlm(opts.verificacao ?? { aprovado: true, problemas: [] }, "anthropic/claude-haiku-5.5") : respostaLlm(opts.copy ?? COPY_OK, "anthropic/claude-sonnet-5.5");
    }
    if (url.endsWith("/advideos")) return resposta({ id: "vid5" });
    if (/\/vid5\?fields=status$/.test(url)) return resposta({ status: { video_status: "ready" } });
    if (url.endsWith("/adimages")) return opts.meta === "erro_imagem" ? resposta({ error: { message: "imagem inválida" } }, 400) : resposta({ images: { "x.png": { hash: "h123" } } });
    if (url.endsWith("/adcreatives")) return resposta({ id: "cr9" });
    if (url.endsWith("/ads")) return resposta({ id: "ad7" });
    return resposta({}, 404);
  }) as unknown as typeof fetch;
  return { fn, chamadas };
}

test("lerCopy exige os seis campos e limpa o nome", () => {
  const c = lerCopy({ ...COPY_OK, nome: "Setor Certo 4x5!" });
  assert.equal(c?.nome, "Setor_Certo_4x5_");
  assert.equal(lerCopy({ ...COPY_OK, headline: "" }), null);
  assert.equal(lerCopy("x"), null);
});

test("verificador por regras barra promessa, 'grátis' solto, preço errado e vínculo oficial", () => {
  assert.deepEqual(verificarPorRegras(COPY_OK), []);
  const ruim = { ...COPY_OK, texto_primario: "Dobre suas vendas com o app oficial do WhatsApp. Grátis para sempre por R$ 19.", headline: "O melhor do mercado" };
  const motivos = verificarPorRegras(ruim).map((p) => p.motivo);
  assert.ok(motivos.some((m) => /promessa/.test(m)));
  assert.ok(motivos.some((m) => /oficial/.test(m)));
  assert.ok(motivos.some((m) => /grátis/.test(m)));
  assert.deepEqual(verificarPorRegras({ ...COPY_OK, texto_primario: "Teste grátis, sem cartão. R$ 25 por atendente/mês." }), [], "'teste grátis' passa");
  assert.deepEqual(verificarPorRegras({ ...COPY_OK, texto_primario: "4,8 de 5 com mais de 130 avaliações no Google e mais de 8 milhões de atendimentos. Teste grátis." }), [], "avaliações e atendimentos passam");
  assert.ok(verificarPorRegras({ ...COPY_OK, texto_primario: "Mais de 3.000 empresas já usam. Teste grátis." }).some((p) => /clientes ou empresas/.test(p.motivo)), "número de empresas é barrado");
  assert.ok(verificarPorRegras({ ...COPY_OK, headline: "3 mil clientes" }).some((p) => /clientes ou empresas/.test(p.motivo)));
});

test("template: destaque vira <mark>, promessa quebra em duas linhas, nada escapa sem escapar", () => {
  assert.equal(tituloComDestaque("a [[b]] <c>"), "a <mark>b</mark> &lt;c&gt;");
  const h = htmlEscritorio({ titulo_imagem: COPY_OK.titulo_imagem, promessa: COPY_OK.promessa, preco: "R$ 25" });
  assert.ok(h.includes("<mark>WhatsApp pessoal do sócio</mark>"));
  assert.ok(h.includes("Um número da empresa.<br>Cada setor no seu lugar."));
  assert.ok(h.includes("data:image/svg+xml") || h.includes("data:image/png;base64,"));
  assert.ok(h.includes("width:1080px;height:1350px"));
});

test("metaPublicacaoConfigurada aponta o que falta", () => {
  const { env } = banco();
  assert.equal(metaPublicacaoConfigurada(env), null);
  assert.equal(metaPublicacaoConfigurada({ ...env, META_PAGE_ID: undefined }), "META_PAGE_ID");
});

test("nível 1: gera, verifica, guarda o PNG no R2 e fica em sombra; o pedido vira atendido", async () => {
  const { env, sqlite, r2 } = banco();
  const id = await registrarPedido(env.DB, "2026-10-29", "analista_ia", { plataforma: "meta", campanha_id: "A", campanha: "Fundo", angulo: "a conversa fica no celular de quem saiu", motivo: "fadiga" });
  assert.equal(await registrarPedido(env.DB, "2026-10-29", "analista_ia", { plataforma: "meta", campanha_id: "A", campanha: "Fundo", angulo: "a conversa fica no celular de quem saiu", motivo: "fadiga" }), id, "mesmo ângulo no dia não duplica");
  const f = fetchFalso();
  const r = await rodarCriador(env, 1, { renderPng: renderFalso, fetchFn: f.fn, agora: AGORA });
  assert.deepEqual([r.gerados, r.reprovados, r.publicados, r.erros], [1, 0, 0, 0]);
  assert.equal(r.detalhes[0].status, "sombra");
  assert.ok(r2.has("criativos/1.png"));
  const c = sqlite.prepare("SELECT status, imagem_chave, modelo FROM ads_criativos").get() as Record<string, string>;
  assert.deepEqual([c.status, c.imagem_chave, c.modelo], ["sombra", "criativos/1.png", "anthropic/claude-sonnet-5.5"]);
  assert.equal((sqlite.prepare("SELECT status FROM ads_pedidos_criativo").get() as { status: string }).status, "atendido");
  assert.ok(!f.chamadas.some((x) => x.url.includes("graph.facebook")), "nível 1 não fala com a Meta");
  // segundo pedido no mesmo dia: limite diário
  await registrarPedido(env.DB, "2026-10-29", "manual", { plataforma: "meta", campanha_id: null, campanha: null, angulo: "outro ângulo qualquer", motivo: "m" });
  const r2b = await rodarCriador(env, 1, { renderPng: renderFalso, fetchFn: f.fn, agora: AGORA });
  assert.equal(r2b.detalhes[0].status, "adiado");
});

test("nível 2: publica na Meta (imagem → criativo → anúncio ACTIVE) e guarda os ids", async () => {
  const { env, sqlite } = banco();
  await registrarPedido(env.DB, "2026-10-29", "analista_ia", { plataforma: "meta", campanha_id: "A", campanha: "Fundo", angulo: "equipe inteira no mesmo número", motivo: "m" });
  const f = fetchFalso();
  const r = await rodarCriador(env, 2, { renderPng: renderFalso, fetchFn: f.fn, agora: AGORA });
  assert.deepEqual([r.gerados, r.publicados, r.erros], [1, 1, 0]);
  const meta = f.chamadas.filter((x) => x.url.includes("graph.facebook")).map((x) => x.url.split("/").pop());
  assert.deepEqual(meta, ["adimages", "adcreatives", "ads"]);
  const anuncio = new URLSearchParams(f.chamadas[f.chamadas.length - 1].corpo);
  assert.equal(anuncio.get("adset_id"), "as1");
  assert.equal(anuncio.get("status"), "ACTIVE");
  const criativo = new URLSearchParams(f.chamadas[f.chamadas.length - 2].corpo);
  const spec = JSON.parse(String(criativo.get("object_story_spec"))) as { page_id: string; link_data: { image_hash: string; link: string; message: string } };
  assert.deepEqual([spec.page_id, spec.link_data.image_hash, spec.link_data.link], ["p1", "h123", "https://exemplo.com.br"]);
  const c = sqlite.prepare("SELECT status, imagem_hash, creative_id, ad_id FROM ads_criativos").get() as Record<string, string>;
  assert.deepEqual([c.status, c.imagem_hash, c.creative_id, c.ad_id], ["publicado", "h123", "cr9", "ad7"]);
});

test("verificador do modelo reprova → criativo reprovado, pedido recusado, nada no R2", async () => {
  const { env, sqlite, r2 } = banco();
  await registrarPedido(env.DB, "2026-10-29", "analista_ia", { plataforma: "meta", campanha_id: "A", campanha: "Fundo", angulo: "x", motivo: "m" });
  const f = fetchFalso({ verificacao: { aprovado: false, problemas: [{ trecho: "equipe inteira", motivo: "promete demais" }] } });
  const r = await rodarCriador(env, 2, { renderPng: renderFalso, fetchFn: f.fn, agora: AGORA });
  assert.deepEqual([r.gerados, r.reprovados], [0, 1]);
  assert.equal(r2.size, 0);
  assert.equal((sqlite.prepare("SELECT status FROM ads_pedidos_criativo").get() as { status: string }).status, "recusado");
});

test("erro da Meta na imagem fica registrado como erro, sem anúncio", async () => {
  const { env, sqlite } = banco();
  await registrarPedido(env.DB, "2026-10-29", "analista_ia", { plataforma: "meta", campanha_id: "A", campanha: "Fundo", angulo: "x", motivo: "m" });
  const f = fetchFalso({ meta: "erro_imagem" });
  const r = await rodarCriador(env, 2, { renderPng: renderFalso, fetchFn: f.fn, agora: AGORA });
  assert.deepEqual([r.gerados, r.publicados, r.erros], [1, 0, 1]);
  const c = sqlite.prepare("SELECT status, resposta FROM ads_criativos").get() as Record<string, string>;
  assert.equal(c.status, "erro");
  assert.match(c.resposta, /^imagem: HTTP 400/);
  assert.ok(!f.chamadas.some((x) => x.url.endsWith("/ads")));
});

test("vídeo: pedido em formato vídeo grava o chat animado (WebM + capa no R2) e publica por advideos → video_data", async () => {
  const { env, sqlite, r2 } = banco();
  const pedido = await registrarPedido(env.DB, "2026-10-29", "estrategista", { plataforma: "meta", campanha_id: null, campanha: null, angulo: "a conversa acontecendo", motivo: "reels", formato: "video" });
  assert.notEqual(await registrarPedido(env.DB, "2026-10-29", "estrategista", { plataforma: "meta", campanha_id: null, campanha: null, angulo: "a conversa acontecendo", motivo: "reels" }), pedido, "mesmo ângulo em outro formato é outro pedido");
  const f = fetchFalso({ copy: COPY_VIDEO });
  const semGravador = await rodarCriador(env, 2, { renderPng: renderFalso, fetchFn: f.fn, agora: AGORA, soPedido: pedido });
  assert.equal(semGravador.erros, 1, "sem gravador de vídeo o pedido fica com erro, não publica");
  sqlite.exec("DELETE FROM ads_criativos; UPDATE ads_pedidos_criativo SET status = 'pendente'");
  const r = await rodarCriador(env, 2, { renderPng: renderFalso, renderWebm: renderWebmFalso, fetchFn: f.fn, agora: AGORA, soPedido: pedido });
  assert.equal(r.publicados, 1, JSON.stringify(r));
  assert.ok(f.chamadas.find((c) => c.url.includes("openrouter"))!.corpo.includes("FORMATO: video"));
  assert.ok(r2.has("criativos/2.webm") && r2.has("criativos/2-capa.png"));
  const c = sqlite.prepare("SELECT formato, video_chave, video_id, ad_id, status FROM ads_criativos WHERE id = 2").get() as Record<string, string>;
  assert.deepEqual({ ...c }, { formato: "video", video_chave: "criativos/2.webm", video_id: "vid5", ad_id: "ad7", status: "publicado" });
  const criativo = f.chamadas.find((x) => x.url.endsWith("/adcreatives"))!.corpo;
  assert.ok(criativo.includes("video_data") && criativo.includes("vid5") && criativo.includes("h123"));
  assert.equal(lerCopy({ ...COPY_OK, conversa: COPY_VIDEO.conversa.slice(0, 2) }, "video"), null, "vídeo exige pelo menos 4 mensagens");
});

test("aprovação: publicar um criativo em sombra sobe a imagem guardada e cria o anúncio; não publica duas vezes", async () => {
  const { env, sqlite } = banco();
  await registrarPedido(env.DB, "2026-10-29", "analista_ia", { plataforma: "meta", campanha_id: "A", campanha: "Fundo", angulo: "x", motivo: "m" });
  const f = fetchFalso();
  await rodarCriador(env, 1, { renderPng: renderFalso, fetchFn: f.fn, agora: AGORA });
  const r = await acaoCriativo(env, 1, "publicar", "", "socio@x.com", { fetchFn: f.fn, agora: AGORA });
  assert.equal(r.ok, true, r.mensagem);
  const c = sqlite.prepare("SELECT status, ad_id, revisado_por FROM ads_criativos WHERE id = 1").get() as Record<string, string>;
  assert.deepEqual([c.status, c.ad_id, c.revisado_por], ["publicado", "ad7", "socio@x.com"]);
  assert.equal((await acaoCriativo(env, 1, "publicar", "", "socio@x.com", { fetchFn: f.fn })).ok, false);
});

test("feedback: 'melhorar' gera uma nova versão na hora, ligada à anterior, com o pedido no prompt; ela fica em sombra mesmo no nível 2", async () => {
  const { env, sqlite } = banco();
  await registrarPedido(env.DB, "2026-10-29", "analista_ia", { plataforma: "meta", campanha_id: "A", campanha: "Fundo", angulo: "x", motivo: "m" });
  const f = fetchFalso();
  await rodarCriador(env, 1, { renderPng: renderFalso, fetchFn: f.fn, agora: AGORA });
  const r = await acaoCriativo(env, 1, "melhorar", "título mais curto e preço antes", "socio@x.com", { renderPng: renderFalso, fetchFn: f.fn, agora: AGORA });
  assert.equal(r.ok, true, r.mensagem);
  assert.equal(r.novo_criativo, 2);
  const prompts = f.chamadas.filter((c) => c.url.includes("openrouter")).map((c) => c.corpo);
  assert.ok(prompts.some((p) => p.includes("título mais curto")), "o feedback vai para o Criador");
  const novo = sqlite.prepare("SELECT status, criativo_pai FROM ads_criativos WHERE id = 2").get() as Record<string, unknown>;
  assert.deepEqual({ ...novo }, { status: "sombra", criativo_pai: 1 });
  const velho = sqlite.prepare("SELECT status, feedback FROM ads_criativos WHERE id = 1").get() as Record<string, unknown>;
  assert.deepEqual({ ...velho }, { status: "reprovado", feedback: "título mais curto e preço antes" });
});
