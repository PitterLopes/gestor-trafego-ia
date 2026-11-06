import test from "node:test";
import { TELA_PRODUTO } from "../src/config/negocio.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { acaoCriativo, concluirPublicacoes, lerCopy, metaPublicacaoConfigurada, registrarPedido, rodarCriador, verificarPorRegras } from "../src/agentes/criador.ts";
import type { Copy, CriadorEnv } from "../src/agentes/criador.ts";
import { htmlEscritorio, tituloComDestaque } from "../src/agentes/templates/escritorio.ts";
import { atualizarReferencias, escolherReferencias, garantirMiniaturas, imagensDoAnuncio, lerIndice, rankingAnuncios, referenciaManual, referenciasParaModelo, removerReferenciaManual } from "../src/agentes/referencia.ts";
import type { AnuncioReferencia } from "../src/agentes/biblioteca.ts";
import { lerPlano } from "../src/agentes/analista_ia.ts";

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
  const bucket = {
    put: async (k: string, v: Uint8Array | string) => { guardados.set(k, typeof v === "string" ? new TextEncoder().encode(v) : v); return null; },
    head: async (k: string) => (guardados.has(k) ? { key: k } : null),
    get: async (k: string) => (guardados.has(k) ? { body: guardados.get(k), arrayBuffer: async () => guardados.get(k)!.slice().buffer, text: async () => new TextDecoder().decode(guardados.get(k)) } : null),
  } as unknown as R2Bucket;
  return { bucket, guardados };
}

/** Anúncio da conta com gasto e cadastros (lead) nos últimos 28 dias, como a coleta grava. */
function anuncioComLeads(sqlite: DatabaseSync, id: string, nome: string, texto: string | null, gastoCents: number, leads: number, dia = "2026-10-20"): void {
  sqlite.prepare("INSERT INTO ads_anuncios (plataforma, anuncio_id, anuncio, status, titulo, texto, atualizado_em) VALUES ('meta', ?, ?, 'ACTIVE', ?, ?, 't')").run(id, nome, texto ? `Título de ${nome}` : null, texto);
  sqlite.prepare("INSERT INTO ads_anuncio_diario (dia, plataforma, anuncio_id, gasto_cents, resultados, atualizado_em) VALUES (?, 'meta', ?, ?, ?, 't')").run(dia, id, gastoCents, leads);
}

function banco(extra: Partial<CriadorEnv> = {}, opts: { semBase?: boolean } = {}): { env: CriadorEnv; sqlite: DatabaseSync; r2: Map<string, Uint8Array> } {
  const sqlite = new DatabaseSync(":memory:");
  for (const m of ["0001_pagamento.sql", "0002_anuncios.sql", "0003_analista.sql", "0004_agentes.sql", "0005_criador.sql", "0006_biblioteca.sql", "0007_equipe.sql", "0008_negocio.sql", "0009_feedback_video.sql", "0010_referencia.sql", "0011_video_story.sql"]) sqlite.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"));
  if (!opts.semBase) anuncioComLeads(sqlite, "win1", "EscritorioMock_4x5", "Seu escritório ainda atende pelo WhatsApp pessoal do sócio?", 260_000, 140);
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
    if (url.endsWith("/advideos")) return resposta({ id: `vid${4 + chamadas.filter((c) => c.url.endsWith("/advideos")).length}` });
    if (/\/vid\d+\?fields=status$/.test(url)) return resposta({ status: { video_status: "ready" } });
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

test("vídeo: grava a tela de chat do sistema em 1:1 e 9:16 e publica um anúncio com os dois por posicionamento", async () => {
  const { env, sqlite, r2 } = banco();
  const pedido = await registrarPedido(env.DB, "2026-10-29", "estrategista", { plataforma: "meta", campanha_id: null, campanha: null, angulo: "a conversa acontecendo", motivo: "reels", formato: "video" });
  assert.notEqual(await registrarPedido(env.DB, "2026-10-29", "estrategista", { plataforma: "meta", campanha_id: null, campanha: null, angulo: "a conversa acontecendo", motivo: "reels" }), pedido, "mesmo ângulo em outro formato é outro pedido");
  const f = fetchFalso({ copy: { ...COPY_VIDEO, contato: "Marcos Padaria", conversa: [...COPY_VIDEO.conversa, { de: "evento", texto: "Ana transferiu para Pessoal" }] } });
  const semGravador = await rodarCriador(env, 2, { renderPng: renderFalso, fetchFn: f.fn, agora: AGORA, soPedido: pedido });
  assert.equal(semGravador.erros, 1, "sem gravador de vídeo o pedido fica com erro, não publica");
  sqlite.exec("DELETE FROM ads_criativos; UPDATE ads_pedidos_criativo SET status = 'pendente'");
  const gravados: Array<{ html: string; w: number; h: number }> = [];
  const gravador = async (html: string, w: number, h: number) => { gravados.push({ html, w, h }); return renderWebmFalso(html); };
  const r = await rodarCriador(env, 2, { renderPng: renderFalso, renderWebm: gravador, fetchFn: f.fn, agora: AGORA, soPedido: pedido });
  assert.equal(r.publicados, 1, JSON.stringify(r));
  assert.deepEqual(gravados.map((g) => [g.w, g.h]), [[1080, 1080], [1080, 1920]]);
  for (const g of gravados) {
    assert.ok(g.html.includes(TELA_PRODUTO.url), "é a tela do produto, não o WhatsApp");
    assert.ok(g.html.includes("Marcos Padaria") && g.html.includes("Ana transferiu para Pessoal"));
  }
  const prompt = f.chamadas.find((c) => c.url.includes("openrouter"))!.corpo;
  assert.ok(prompt.includes("FORMATO: video") && prompt.includes("TELA DE CHAT DO PRODUTO"));
  for (const k of ["criativos/2.webm", "criativos/2-capa.png", "criativos/2-story.webm", "criativos/2-story-capa.png"]) assert.ok(r2.has(k), k);
  const c = sqlite.prepare("SELECT formato, video_chave, video_story_chave, video_id, video_story_id, ad_id, status FROM ads_criativos WHERE id = 2").get() as Record<string, string>;
  assert.deepEqual({ ...c }, { formato: "video", video_chave: "criativos/2.webm", video_story_chave: "criativos/2-story.webm", video_id: "vid5", video_story_id: "vid6", ad_id: "ad7", status: "publicado" });
  const criativo = new URLSearchParams(f.chamadas.find((x) => x.url.endsWith("/adcreatives"))!.corpo);
  const feed = JSON.parse(criativo.get("asset_feed_spec")!) as { videos: Array<{ video_id: string; adlabels: Array<{ name: string }> }>; asset_customization_rules: Array<{ customization_spec: { instagram_positions: string[] }; video_label: { name: string } }> };
  assert.deepEqual(feed.videos.map((v) => [v.video_id, v.adlabels[0].name]), [["vid5", "dd_quadrado"], ["vid6", "dd_story"]]);
  assert.deepEqual(feed.asset_customization_rules.map((x) => x.video_label.name), ["dd_story", "dd_quadrado"]);
  assert.ok(feed.asset_customization_rules[0].customization_spec.instagram_positions.includes("story"));
  assert.equal(f.chamadas.filter((x) => x.url.endsWith("/advideos")).length, 2, "subiu os dois vídeos");
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

test("verificador: trechos listados como 'sem problema' não reprovam, mesmo com aprovado=false do modelo", async () => {
  const { env } = banco();
  const f = fetchFalso({ verificacao: { aprovado: false, problemas: [{ trecho: "x", motivo: "Afirmação dentro do permitido; sem problema.", viola: true }, { trecho: "y", motivo: "Grátis sem teste? Não: aqui está 'Teste grátis'. Conforme.", viola: true }, { trecho: "z", motivo: "promessa de resultado", viola: false }] } });
  await registrarPedido(env.DB, "2026-10-29", "manual", { plataforma: "meta", campanha_id: null, campanha: null, angulo: "x", motivo: "m" });
  const r = await rodarCriador(env, 1, { renderPng: renderFalso, fetchFn: f.fn, agora: AGORA });
  assert.equal(r.gerados, 1, JSON.stringify(r.detalhes));
  const g = fetchFalso({ verificacao: { aprovado: true, problemas: [{ trecho: "Dobre suas vendas", motivo: "promessa de resultado" }] } });
  const { env: env2 } = banco();
  await registrarPedido(env2.DB, "2026-10-29", "manual", { plataforma: "meta", campanha_id: null, campanha: null, angulo: "x", motivo: "m" });
  assert.equal((await rodarCriador(env2, 1, { renderPng: renderFalso, fetchFn: g.fn, agora: AGORA })).reprovados, 1, "problema de verdade reprova mesmo com aprovado=true");
});

// ---------- base das variações: anúncio que converte em lead ----------

test("criador: a variação parte do anúncio que mais traz lead pelo menor custo, que vai no prompt e fica registrado", async () => {
  const { env, sqlite } = banco();
  // gastou muito e não trouxe lead; e um que trouxe lead mas caro demais: nenhum dos dois serve de base
  anuncioComLeads(sqlite, "zero", "SemLead_4x5", "Texto que não converte.", 90_000, 0);
  anuncioComLeads(sqlite, "caro", "Caro_4x5", "Texto caro.", 120_000, 6);
  await registrarPedido(env.DB, "2026-10-29", "analista_ia", { plataforma: "meta", campanha_id: null, campanha: null, angulo: "equipe de 3 ou mais atendentes", motivo: "teste" });
  const f = fetchFalso();
  const r = await rodarCriador(env, 1, { renderPng: renderFalso, fetchFn: f.fn, agora: AGORA });
  assert.equal(r.gerados, 1);
  const promptCriador = f.chamadas.find((c) => c.url.includes("openrouter") && !c.corpo.includes("revisa textos"))!.corpo;
  assert.match(promptCriador, /ANÚNCIO BASE/);
  assert.match(promptCriador, /EscritorioMock_4x5/);
  assert.match(promptCriador, /R\$ 18,57 por cadastro, 140 cadastros/);
  assert.match(promptCriador, /VARIAÇÃO deste anúncio/);
  const c = sqlite.prepare("SELECT angulo FROM ads_criativos").get() as { angulo: string };
  assert.match(c.angulo, /^variação de "EscritorioMock_4x5" \(win1\) · equipe de 3/);
});

test("criador: sem anúncio que converte, pedido de agente espera; pedido da pessoa segue", async () => {
  const { env, sqlite } = banco({}, { semBase: true });
  anuncioComLeads(sqlite, "poucos", "PoucosLeads", "Texto.", 50_000, 3); // 3 leads: pouco para ter confiança
  await registrarPedido(env.DB, "2026-10-29", "estrategista", { plataforma: "meta", campanha_id: null, campanha: null, angulo: "ângulo novo", motivo: "plano" });
  const r = await rodarCriador(env, 1, { renderPng: renderFalso, fetchFn: fetchFalso().fn, agora: AGORA });
  assert.deepEqual([r.gerados, r.detalhes[0].status], [0, "adiado"]);
  assert.match(r.detalhes[0].nota, /cadastros suficientes/);
  const pendente = sqlite.prepare("SELECT status FROM ads_pedidos_criativo").get() as { status: string };
  assert.equal(pendente.status, "pendente", "fica pendente para quando houver base");
  await registrarPedido(env.DB, "2026-10-29", "manual", { plataforma: "meta", campanha_id: null, campanha: null, angulo: "pedido do dono", motivo: "manual" });
  const r2 = await rodarCriador(env, 1, { renderPng: renderFalso, fetchFn: fetchFalso().fn, agora: AGORA, soPedido: 2 });
  assert.equal(r2.gerados, 1);
});

// ---------- pasta de referência ----------

const ANALISE_OK = {
  tipo_visual: "tela_de_chat",
  descricao: "Tela do sistema com conversas por setor; à direita, o chat do Fiscal respondendo a guia do DAS.",
  elementos_que_prendem: ["setor e atendente no topo", "protocolo na conversa"],
  por_que_converte: "Mostra o produto real resolvendo a dor do WhatsApp misturado.",
  variacoes: [{ formato: "video", angulo: "A mesma conversa acontecendo mensagem por mensagem", o_que_muda: "vira vídeo; mesma tela" }, { formato: "imagem", angulo: "Mesma tela com o setor Financeiro", o_que_muda: "troca o setor" }],
};
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);

/** fetch falso da pasta: Meta (anúncio → criativo de vídeo do Advantage+ → hash → adimages), download da imagem e o modelo. */
function fetchReferencia(opts: { imagem?: Uint8Array } = {}) {
  const chamadas: Array<{ url: string; corpo: string }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const corpo = String(init?.body ?? "");
    chamadas.push({ url, corpo });
    if (url.includes("openrouter")) {
      const j = JSON.parse(corpo) as { messages: Array<{ content: unknown }> };
      const sistema = String(j.messages[0].content);
      if (sistema.includes("Você analisa anúncios")) return respostaLlm(ANALISE_OK, "anthropic/claude-sonnet-5.5");
      if (sistema.includes("revisa textos")) return respostaLlm({ aprovado: true, problemas: [] }, "anthropic/claude-haiku-5.5");
      return respostaLlm(COPY_VIDEO, "anthropic/claude-sonnet-5.5");
    }
    if (/\/(win1|chat1)\?fields=creative/.test(url)) return resposta({ creative: { id: url.includes("chat1") ? "crChat" : "crWin" } });
    if (/\/crWin\?fields=/.test(url)) return resposta({ thumbnail_url: "https://cdn.test/mini64.jpg", asset_feed_spec: { images: [{ hash: "hWin" }], videos: [] } });
    if (/\/crChat\?fields=/.test(url)) return resposta({ image_url: "https://cdn.test/chat.png" });
    if (url.includes("/adimages?hashes=")) return resposta({ data: [{ url: "https://cdn.test/win1080.jpg", width: 1080, height: 1350 }] });
    if (url.startsWith("https://cdn.test/")) return new Response(opts.imagem ?? JPG, { status: 200, headers: { "content-type": url.endsWith(".png") ? "image/png" : "image/jpeg" } });
    return resposta({}, 404);
  }) as unknown as typeof fetch;
  return { fn, chamadas };
}

const ref = (id: string, leads: number, cpl: number): AnuncioReferencia => ({ anuncio_id: id, anuncio: id, status: "ACTIVE", titulo: null, texto: "t", gasto_28d: leads * cpl, cadastros_28d: leads, custo_cadastro_cents: cpl, gerado_pelo_criador: false });

test("escolherReferencias: os 2 que mais trazem cadastro; empate vai para o mais barato", () => {
  assert.deepEqual(escolherReferencias([ref("barato_pouco", 7, 2600), ref("campeao", 143, 1822), ref("segundo", 28, 3072)]).map((a) => a.anuncio_id), ["campeao", "segundo"]);
  assert.deepEqual(escolherReferencias([ref("a", 10, 3000), ref("b", 10, 2000)], 1).map((a) => a.anuncio_id), ["b"]);
});

test("imagensDoAnuncio: Advantage+ sem imagem direta → o hash em adimages (1080) vem antes da miniatura de 64px", async () => {
  const { env } = banco();
  const img = await imagensDoAnuncio(env, "win1", fetchReferencia().fn);
  assert.deepEqual(img, { urls: ["https://cdn.test/win1080.jpg", "https://cdn.test/mini64.jpg"], midia: "imagem" });
});

test("vídeo: capa que abre página do Facebook (HTML) é pulada e a próxima URL com imagem é a que fica", async () => {
  const { env, sqlite, r2 } = banco({}, { semBase: true });
  anuncioComLeads(sqlite, "vid1", "CampeaoVideo", "Texto do vídeo.", 260_000, 140);
  const base = fetchReferencia().fn;
  const fn = (async (url: string, init?: RequestInit) => {
    if (/\/vid1\?fields=creative/.test(url)) return resposta({ creative: { id: "crVid" } });
    if (/\/crVid\?fields=/.test(url)) return resposta({ thumbnail_url: "https://cdn.test/mini64.jpg", object_story_spec: { video_data: { video_id: "v9", image_url: "https://www.facebook.com/ads/image/?d=x" } } });
    if (/\/v9\?fields=/.test(url)) return resposta({ error: { message: "sem permissão no vídeo" } }, 400); // miniaturas fora: sobram a capa (HTML) e a miniatura do criativo
    if (url.startsWith("https://www.facebook.com/")) return new Response("<!DOCTYPE html><html></html>", { status: 200, headers: { "content-type": "text/html" } });
    return base(url, init);
  }) as unknown as typeof fetch;
  const r = await atualizarReferencias(env, fn, AGORA);
  assert.deepEqual(r.erros, []);
  assert.equal(r.referencias[0].midia, "video");
  assert.deepEqual(r2.get("referencia/vid1.jpg"), JPG);
  assert.ok(![...r2.values()].some((v) => new TextDecoder().decode(v).startsWith("<!DOCTYPE")), "HTML não entra na pasta");
});

test("atualizarReferencias: baixa a imagem para o R2, o modelo vê a imagem, e a análise é reaproveitada se a imagem não mudou", async () => {
  const { env, r2 } = banco();
  const f = fetchReferencia();
  const r = await atualizarReferencias(env, f.fn, AGORA);
  assert.deepEqual(r.erros, []);
  assert.equal(r.referencias[0].anuncio_id, "win1");
  assert.equal(r.referencias[0].imagem_chave, "referencia/win1.jpg");
  assert.deepEqual(r2.get("referencia/win1.jpg"), JPG);
  assert.equal(r.referencias[0].analise?.tipo_visual, "tela_de_chat");
  const pedidoModelo = JSON.parse(f.chamadas.find((c) => c.url.includes("openrouter"))!.corpo) as { messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> };
  assert.equal(pedidoModelo.messages[1].content[1].type, "image_url");
  assert.match(pedidoModelo.messages[1].content[1].image_url!.url, /^data:image\/jpeg;base64,/);
  // de novo, mesma imagem: não chama o modelo
  const f2 = fetchReferencia();
  await atualizarReferencias(env, f2.fn, AGORA);
  assert.equal(f2.chamadas.filter((c) => c.url.includes("openrouter")).length, 0);
  // imagem nova: analisa de novo
  const f3 = fetchReferencia({ imagem: new Uint8Array([9, 9, 9]) });
  await atualizarReferencias(env, f3.fn, AGORA);
  assert.equal(f3.chamadas.filter((c) => c.url.includes("openrouter")).length, 1);
  const pasta = await lerIndice(env);
  assert.deepEqual(pasta.referencias.map((x) => x.anuncio_id), ["win1"]);
  const txt = referenciasParaModelo(pasta.referencias);
  assert.match(txt, /PASTA DE REFERÊNCIA/);
  assert.match(txt, /anuncio_base win1/);
  assert.match(txt, /tela de chat/);
  assert.match(txt, /\[video\] A mesma conversa/);
});

test("criador: pedido com base à mão (chat sem cadastro ainda) vira vídeo vendo a imagem do chat", async () => {
  const { env, sqlite } = banco();
  anuncioComLeads(sqlite, "chat1", "PrintDaTela_Chat_v1", null, 200, 0);
  await registrarPedido(env.DB, "2026-10-29", "manual", { plataforma: "meta", campanha_id: null, campanha: null, angulo: "transformar a tela de chat em vídeo", motivo: "pedido do dono", formato: "video", anuncio_base: "chat1" });
  const f = fetchReferencia();
  const r = await rodarCriador(env, 1, { renderPng: renderFalso, renderWebm: renderWebmFalso, fetchFn: f.fn, agora: AGORA });
  assert.equal(r.gerados, 1, JSON.stringify(r.detalhes));
  const corpos = f.chamadas.filter((c) => c.url.includes("openrouter")).map((c) => JSON.parse(c.corpo) as { messages: Array<{ content: unknown }> });
  const criador = corpos.find((c) => String(c.messages[0].content).startsWith("Você escreve anúncios"))!;
  const partes = criador.messages[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
  assert.match(partes[0].text!, /ANÚNCIO BASE \(ainda sem cadastro; escolhido à mão\)/);
  assert.match(partes[0].text!, /O QUE O ANÚNCIO BASE MOSTRA/);
  assert.match(partes[0].text!, /VÍDEO A PARTIR DO ANÚNCIO BASE/);
  assert.match(partes[1].image_url!.url, /^data:image\/png;base64,/);
  const c = sqlite.prepare("SELECT anuncio_base, formato FROM ads_criativos").get() as { anuncio_base: string; formato: string };
  assert.deepEqual([c.anuncio_base, c.formato], ["chat1", "video"]);
});

test("analista: o pedido de criativo traz anuncio_base e formato", () => {
  const p = lerPlano({ resumo: "ok", acoes: [], pedidos_criativo: [{ campanha_id: "C", anuncio_base: "win1", formato: "video", angulo: "mesma tela em vídeo", motivo: "campeão" }] });
  assert.deepEqual(p?.pedidos_criativo[0], { campanha_id: "C", angulo: "mesma tela em vídeo", motivo: "campeão", anuncio_base: "win1", formato: "video" });
});

test("pasta: anúncio fixado à mão (a tela de chat real) fica na pasta mesmo sem cadastro e sobrevive à atualização", async () => {
  const { env, sqlite } = banco();
  anuncioComLeads(sqlite, "chat1", "PrintDaTela_Chat_v1", null, 200, 0);
  await atualizarReferencias(env, fetchReferencia().fn, AGORA);
  assert.ok(await referenciaManual(env, "chat1", fetchReferencia().fn, AGORA));
  await atualizarReferencias(env, fetchReferencia().fn, AGORA);
  const pasta = await lerIndice(env);
  assert.deepEqual(pasta.referencias.map((r) => [r.anuncio_id, r.escolhido]), [["win1", "leads"], ["chat1", "manual"]]);
  assert.match(referenciasParaModelo(pasta.referencias), /chat1: "PrintDaTela_Chat_v1" · FIXADO PELO DONO/);
  assert.equal(await removerReferenciaManual(env, "chat1"), true);
  assert.deepEqual((await lerIndice(env)).referencias.map((r) => r.anuncio_id), ["win1"]);
});

test("publicar vídeo no painel: envia os dois vídeos e responde; o anúncio sai quando a Meta termina (cron de 5 min)", async () => {
  const { env, sqlite } = banco();
  await registrarPedido(env.DB, "2026-10-29", "manual", { plataforma: "meta", campanha_id: null, campanha: null, angulo: "a conversa na tela", motivo: "m", formato: "video" });
  const base = fetchFalso({ copy: { ...COPY_VIDEO, contato: "Marcos Padaria" } });
  await rodarCriador(env, 1, { renderPng: renderFalso, renderWebm: renderWebmFalso, fetchFn: base.fn, agora: AGORA });
  // a Meta ainda processando
  let pronto = false;
  const chamadas: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    chamadas.push(url);
    if (/\/vid\d+\?fields=status$/.test(url)) return resposta({ status: { video_status: pronto ? "ready" : "processing" } });
    return base.fn(url, init);
  }) as unknown as typeof fetch;
  const r = await acaoCriativo(env, 1, "publicar", "", "dono@x.com", { fetchFn: fn, agora: AGORA });
  assert.equal(r.ok, true);
  assert.match(r.mensagem, /processando/);
  let c = sqlite.prepare("SELECT status, video_id, video_story_id, ad_id FROM ads_criativos WHERE id = 1").get() as Record<string, string | null>;
  assert.deepEqual({ ...c }, { status: "publicando", video_id: "vid5", video_story_id: "vid6", ad_id: null });
  assert.ok(!chamadas.some((u) => u.endsWith("/ads")), "sem vídeo pronto, nenhum anúncio");
  // o cron passa depois que a Meta termina
  pronto = true;
  const fim = await concluirPublicacoes(env, fn, new Date(AGORA.getTime() + 10 * 60_000));
  assert.deepEqual(fim.map((x) => x.status), ["publicado"]);
  c = sqlite.prepare("SELECT status, ad_id, creative_id FROM ads_criativos WHERE id = 1").get() as Record<string, string | null>;
  assert.deepEqual({ ...c }, { status: "publicado", ad_id: "ad7", creative_id: "cr9" });
  const criativo = new URLSearchParams(chamadas.length ? base.chamadas.find((x) => x.url.endsWith("/adcreatives"))!.corpo : "");
  assert.ok(criativo.get("asset_feed_spec")!.includes("dd_story"), "os dois formatos no mesmo anúncio");
  assert.deepEqual(await concluirPublicacoes(env, fn, AGORA), [], "nada mais pendente");
});

test("publicação de vídeo que a Meta não processa no prazo vira erro", async () => {
  const { env, sqlite } = banco();
  await registrarPedido(env.DB, "2026-10-29", "manual", { plataforma: "meta", campanha_id: null, campanha: null, angulo: "a conversa na tela", motivo: "m", formato: "video" });
  const base = fetchFalso({ copy: { ...COPY_VIDEO, contato: "Marcos Padaria" } });
  await rodarCriador(env, 1, { renderPng: renderFalso, renderWebm: renderWebmFalso, fetchFn: base.fn, agora: AGORA });
  const fn = (async (url: string, init?: RequestInit) => (/\/vid\d+\?fields=status$/.test(url) ? resposta({ status: { video_status: "processing" } }) : base.fn(url, init))) as unknown as typeof fetch;
  await acaoCriativo(env, 1, "publicar", "", "dono@x.com", { fetchFn: fn, agora: AGORA });
  sqlite.exec("UPDATE ads_criativos SET revisado_em = '2026-10-29T10:00:00Z' WHERE id = 1");
  const fim = await concluirPublicacoes(env, fn, AGORA);
  assert.equal(fim[0].status, "erro");
  const c = sqlite.prepare("SELECT status, resposta FROM ads_criativos WHERE id = 1").get() as Record<string, string>;
  assert.equal(c.status, "erro");
  assert.match(c.resposta, /não terminou de processar/);
});

test("ranking da tela: mais cadastros primeiro, marca a base e a pasta, e baixa a imagem dos que faltam", async () => {
  const { env, sqlite, r2 } = banco(); // win1: 140 cadastros
  anuncioComLeads(sqlite, "chat1", "Segundo", "t", 86_000, 28);
  anuncioComLeads(sqlite, "zero", "SemLead", "t", 90_000, 0);
  anuncioComLeads(sqlite, "empA", "EmpateCaro", "t", 30_000, 5);
  anuncioComLeads(sqlite, "empB", "EmpateBarato", "t", 10_000, 5);
  await atualizarReferencias(env, fetchReferencia().fn, AGORA);
  const r = await rankingAnuncios(env, AGORA);
  assert.deepEqual(r.map((x) => x.anuncio), ["EscritorioMock_4x5", "Segundo", "EmpateBarato", "EmpateCaro"], "sem cadastro fica fora; empate vai para o mais barato");
  assert.deepEqual(r.map((x) => x.posicao), [1, 2, 3, 4]);
  assert.equal(r[0].base, true);
  assert.equal(r[0].na_pasta, true);
  assert.equal(r[0].imagem_chave, "referencia/win1.jpg");
  // chat1 (Segundo) também foi para a pasta (top 2); os outros ganham miniatura, sem modelo
  assert.ok(r2.has("referencia/chat1.png"));
  const f = fetchReferencia();
  const fn = (async (url: string, init?: RequestInit) => {
    if (/\/emp[AB]\?fields=creative/.test(url)) return resposta({ creative: { id: "crChat" } });
    return f.fn(url, init);
  }) as unknown as typeof fetch;
  const m = await garantirMiniaturas(env, fn, AGORA);
  assert.equal(m.baixadas, 2);
  assert.ok(r2.has("referencia/mini/empA.png") && r2.has("referencia/mini/empB.png"));
  assert.equal(f.chamadas.filter((c) => c.url.includes("openrouter")).length, 0, "miniatura não chama o modelo");
  assert.equal((await rankingAnuncios(env, AGORA))[2].imagem_chave, "referencia/mini/empB.png");
});
