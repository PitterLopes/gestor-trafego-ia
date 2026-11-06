/**
 * Pasta de referência do time de tráfego: os anúncios da conta que mais trazem cadastro (lead), com a imagem
 * de verdade guardada no R2 (referencia/<anúncio>.<ext>) e uma análise do que aparece nela (tela de chat,
 * mockup, foto…), feita por um modelo que vê a imagem. O Analista e o Estrategista leem essa pasta para pedir
 * variações; o Criador recebe a imagem e a análise do anúncio base.
 *
 * Escolha automática: os REFERENCIA_TOP anúncios com mais cadastros entre os que convertem com confiança
 * (biblioteca.ts: gasto e cadastros mínimos, custo por cadastro perto da média). Também dá para pôr um anúncio
 * à mão (ex.: um print da tela do produto que o dono quer transformar em vídeo).
 *
 * Só leitura na Meta: lê o criativo, a imagem e a miniatura do vídeo. A análise só gasta modelo quando a
 * imagem muda (comparada pelo SHA-256).
 */
import { META_API_VERSAO } from "../meta_versao.ts";
import { nowIso } from "../util.ts";
import { chamarLlm } from "./llm.ts";
import { PERFIL_NEGOCIO } from "../config/negocio.ts";
import type { LlmEnv } from "./llm.ts";
import { lerAnuncios, montarBiblioteca } from "./biblioteca.ts";
import type { AnuncioReferencia } from "./biblioteca.ts";

export const REFERENCIA_TOP = 2;
export const MODELO_REFERENCIA_PADRAO = "anthropic/claude-sonnet-5.5";
const INDICE = "referencia/indice.json";
/** Imagem acima disso não vai para o modelo (custo e limite de tamanho). */
const IMAGEM_MAX_BYTES = 4_000_000;

export interface ReferenciaEnv extends LlmEnv {
  CRIATIVOS?: R2Bucket;
  META_ADS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
  LLM_MODELO_REFERENCIA?: string;
}

export interface VariacaoSugerida {
  formato: "imagem" | "video";
  angulo: string;
  o_que_muda: string;
}

export interface AnaliseVisual {
  tipo_visual: "tela_de_chat" | "mockup_do_sistema" | "foto" | "texto_na_imagem" | "outro";
  descricao: string;
  elementos_que_prendem: string[];
  por_que_converte: string;
  variacoes: VariacaoSugerida[];
}

export interface Referencia {
  anuncio_id: string;
  anuncio: string;
  titulo: string | null;
  texto: string | null;
  gasto_28d: number;
  cadastros_28d: number;
  custo_cadastro_cents: number | null;
  midia: "imagem" | "video" | null;
  imagem_chave: string | null;
  imagem_sha: string | null;
  analise: AnaliseVisual | null;
  escolhido: "leads" | "manual";
  erro: string | null;
  atualizado_em: string;
}

export const ESQUEMA_ANALISE = {
  type: "object",
  additionalProperties: false,
  required: ["tipo_visual", "descricao", "elementos_que_prendem", "por_que_converte", "variacoes"],
  properties: {
    tipo_visual: { type: "string", enum: ["tela_de_chat", "mockup_do_sistema", "foto", "texto_na_imagem", "outro"] },
    descricao: { type: "string", description: "O que aparece na imagem, de cima para baixo, em até 5 frases." },
    elementos_que_prendem: { type: "array", items: { type: "string" }, description: "De 2 a 5 elementos visuais ou de texto que chamam a atenção." },
    por_que_converte: { type: "string", description: "Hipótese curta, ligada à dor do cliente." },
    variacoes: {
      type: "array",
      description: "De 2 a 3 variações que mantêm o que funciona.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["formato", "angulo", "o_que_muda"],
        properties: {
          formato: { type: "string", enum: ["imagem", "video"] },
          angulo: { type: "string", description: "A ideia da variação, em uma frase." },
          o_que_muda: { type: "string", description: "O que muda em relação ao anúncio original e o que fica igual." },
        },
      },
    },
  },
} as const;

const SISTEMA_REFERENCIA = `Você analisa anúncios da Meta que estão trazendo cadastros para a empresa descrita em SOBRE A EMPRESA. Recebe a imagem do anúncio (ou a capa do vídeo), o texto e os números de 28 dias.

Descreva o que aparece, diga o que prende a atenção e por que você acha que converte, e sugira de 2 a 3 variações que mantenham o que funciona (a mesma dor, o mesmo tipo de visual) e mudem uma coisa só. Quando a imagem for uma tela de chat, uma das variações deve ser em vídeo: a mesma conversa acontecendo, mensagem por mensagem. Português do Brasil, direto. Não invente número, cliente ou promessa.`;

const ehObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const TIPOS_VISUAIS = new Set(["tela_de_chat", "mockup_do_sistema", "foto", "texto_na_imagem", "outro"]);

export function lerAnalise(v: unknown): AnaliseVisual | null {
  if (!ehObj(v) || typeof v.descricao !== "string" || typeof v.por_que_converte !== "string" || !Array.isArray(v.elementos_que_prendem) || !Array.isArray(v.variacoes)) return null;
  const variacoes = v.variacoes.filter(ehObj).filter((x) => typeof x.angulo === "string" && typeof x.o_que_muda === "string").map((x) => ({ formato: x.formato === "video" ? "video" as const : "imagem" as const, angulo: String(x.angulo).slice(0, 300), o_que_muda: String(x.o_que_muda).slice(0, 400) })).slice(0, 3);
  return {
    tipo_visual: TIPOS_VISUAIS.has(String(v.tipo_visual)) ? (v.tipo_visual as AnaliseVisual["tipo_visual"]) : "outro",
    descricao: v.descricao.slice(0, 1200),
    elementos_que_prendem: v.elementos_que_prendem.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 200)).slice(0, 5),
    por_que_converte: v.por_que_converte.slice(0, 600),
    variacoes,
  };
}

/** Os mais fortes em cadastro entre os que convertem com confiança; empate vai para o menor custo por cadastro. */
export function escolherReferencias(bases: AnuncioReferencia[], top = REFERENCIA_TOP): AnuncioReferencia[] {
  return [...bases].sort((a, b) => b.cadastros_28d - a.cadastros_28d || (a.custo_cadastro_cents ?? Infinity) - (b.custo_cadastro_cents ?? Infinity)).slice(0, top);
}

// ---------- Meta: achar a imagem grande do criativo (só leitura) ----------

async function getMeta(env: ReferenciaEnv, caminho: string, fetchFn: typeof fetch): Promise<Record<string, unknown>> {
  const res = await fetchFn(`https://graph.facebook.com/${META_API_VERSAO}/${caminho}`, { headers: { authorization: `Bearer ${env.META_ADS_TOKEN}`, accept: "application/json" } });
  const t = await res.text();
  if (!res.ok) throw new Error(`Meta HTTP ${res.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t) as Record<string, unknown>;
}

/**
 * Onde pode estar a imagem em tamanho de anúncio, na ordem de tentativa: a do link, a do catálogo de mídias
 * (Advantage+, pelo hash), a miniatura grande do vídeo, a capa informada no criativo e, por último, a miniatura
 * do criativo. Algumas dessas URLs abrem uma página do Facebook em vez da imagem: quem baixa confere o tipo.
 */
export async function imagensDoAnuncio(env: ReferenciaEnv, anuncioId: string, fetchFn: typeof fetch): Promise<{ urls: string[]; midia: "imagem" | "video" } | null> {
  const ad = await getMeta(env, `${anuncioId}?fields=creative{id}`, fetchFn);
  const creativeId = str((ad.creative as Record<string, unknown> | undefined)?.id);
  if (!creativeId) return null;
  const c = await getMeta(env, `${creativeId}?fields=image_url,image_hash,thumbnail_url,video_id,object_story_spec,asset_feed_spec&thumbnail_width=1080&thumbnail_height=1350`, fetchFn);
  const spec = (ehObj(c.object_story_spec) ? c.object_story_spec : {}) as { link_data?: Record<string, unknown>; video_data?: Record<string, unknown> };
  const feed = (ehObj(c.asset_feed_spec) ? c.asset_feed_spec : {}) as { images?: Array<Record<string, unknown>>; videos?: Array<Record<string, unknown>> };
  const videoId = str(c.video_id) ?? str(spec.video_data?.video_id) ?? str(feed.videos?.[0]?.video_id);
  const midia: "imagem" | "video" = videoId ? "video" : "imagem";
  const urls: Array<string | null> = [str(spec.link_data?.picture), str(c.image_url)];

  const hash = str(c.image_hash) ?? str(spec.link_data?.image_hash) ?? str(spec.video_data?.image_hash) ?? str(feed.images?.[0]?.hash);
  if (hash && env.META_AD_ACCOUNT_ID) {
    try {
      const imgs = await getMeta(env, `act_${env.META_AD_ACCOUNT_ID}/adimages?hashes=${encodeURIComponent(JSON.stringify([hash]))}&fields=url,width,height`, fetchFn);
      urls.push(str((imgs.data as Array<Record<string, unknown>> | undefined)?.[0]?.url));
    } catch { /* segue para as outras */ }
  }
  if (videoId) {
    try {
      const v = await getMeta(env, `${videoId}?fields=picture,thumbnails{uri,width,height,is_preferred}`, fetchFn);
      const lista = ((v.thumbnails as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? []).filter((t) => str(t.uri));
      const melhor = lista.find((t) => t.is_preferred === true) ?? [...lista].sort((x, y) => Number(y.width ?? 0) - Number(x.width ?? 0))[0];
      urls.push(str(melhor?.uri), str(v.picture));
    } catch { /* segue para as outras */ }
  }
  urls.push(str(spec.video_data?.image_url), str(feed.videos?.[0]?.thumbnail_url), str(feed.images?.[0]?.url), str(c.thumbnail_url));
  const unicas = [...new Set(urls.filter((u): u is string => Boolean(u)))];
  return unicas.length ? { urls: unicas, midia } : null;
}

/** Baixa a primeira URL que devolve imagem de verdade (content-type image/*). */
export async function baixarImagem(urls: string[], fetchFn: typeof fetch): Promise<{ bytes: Uint8Array; tipo: string; url: string } | null> {
  for (const url of urls) {
    try {
      const res = await fetchFn(url);
      const tipo = res.headers.get("content-type") ?? "";
      if (!res.ok || !tipo.startsWith("image/")) continue;
      return { bytes: new Uint8Array(await res.arrayBuffer()), tipo, url };
    } catch { /* tenta a próxima */ }
  }
  return null;
}

// ---------- R2 ----------

async function sha256(bytes: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const extensao = (tipo: string): string => (tipo.includes("png") ? "png" : tipo.includes("webp") ? "webp" : "jpg");

export async function lerReferencia(env: ReferenciaEnv, anuncioId: string): Promise<Referencia | null> {
  if (!env.CRIATIVOS) return null;
  const o = await env.CRIATIVOS.get(`referencia/${anuncioId}.json`);
  if (!o) return null;
  try { return JSON.parse(await o.text()) as Referencia; } catch { return null; }
}

async function lerIndiceBruto(env: ReferenciaEnv): Promise<{ atualizado_em: string | null; ids: string[]; manuais: string[] }> {
  const o = env.CRIATIVOS ? await env.CRIATIVOS.get(INDICE) : null;
  if (!o) return { atualizado_em: null, ids: [], manuais: [] };
  try {
    const j = JSON.parse(await o.text()) as { atualizado_em?: string; ids?: string[]; manuais?: string[] };
    return { atualizado_em: j.atualizado_em ?? null, ids: j.ids ?? [], manuais: j.manuais ?? [] };
  } catch {
    return { atualizado_em: null, ids: [], manuais: [] };
  }
}

async function gravarIndice(env: ReferenciaEnv, ids: string[], manuais: string[]): Promise<void> {
  if (env.CRIATIVOS) await env.CRIATIVOS.put(INDICE, JSON.stringify({ atualizado_em: nowIso(), ids, manuais }), { httpMetadata: { contentType: "application/json" } });
}

/** A pasta: os que mais trazem cadastro e, depois, os fixados à mão (ex.: a tela de chat real do sistema). */
export async function lerIndice(env: ReferenciaEnv): Promise<{ atualizado_em: string | null; referencias: Referencia[] }> {
  const j = await lerIndiceBruto(env);
  const ids = [...new Set([...j.ids, ...j.manuais])];
  const refs = await Promise.all(ids.map((id) => lerReferencia(env, id)));
  return { atualizado_em: j.atualizado_em, referencias: refs.filter((r): r is Referencia => r != null) };
}

/** A imagem guardada, como data URL para o modelo ver. */
export async function imagemDataUrl(env: ReferenciaEnv, ref: Referencia | null): Promise<string | null> {
  if (!ref?.imagem_chave || !env.CRIATIVOS) return null;
  const o = await env.CRIATIVOS.get(ref.imagem_chave);
  if (!o) return null;
  const bytes = new Uint8Array(await o.arrayBuffer());
  if (bytes.length > IMAGEM_MAX_BYTES) return null;
  return `data:${ref.imagem_chave.endsWith(".png") ? "image/png" : ref.imagem_chave.endsWith(".webp") ? "image/webp" : "image/jpeg"};base64,${b64(bytes)}`;
}

async function analisar(env: ReferenciaEnv, a: AnuncioReferencia, midia: string | null, dataUrl: string, fetchFn: typeof fetch, agora: Date): Promise<AnaliseVisual | { erro: string }> {
  const r = await chamarLlm<unknown>(env, {
    agente: "referencia",
    modelo: env.LLM_MODELO_REFERENCIA || MODELO_REFERENCIA_PADRAO,
    sistema: `${SISTEMA_REFERENCIA}\n\nSOBRE A EMPRESA:\n${PERFIL_NEGOCIO}`,
    usuario: `ANÚNCIO: "${a.anuncio}" (${midia === "video" ? "vídeo; a imagem é a capa" : "imagem"})\nTÍTULO: ${a.titulo ?? "—"}\nTEXTO: ${(a.texto ?? "—").slice(0, 1200)}\n28 DIAS: R$ ${(a.gasto_28d / 100).toFixed(2).replace(".", ",")} gastos, ${a.cadastros_28d} cadastros${a.custo_cadastro_cents != null ? `, R$ ${(a.custo_cadastro_cents / 100).toFixed(2).replace(".", ",")} por cadastro` : ""}.`,
    imagens: [dataUrl],
    esquema: ESQUEMA_ANALISE as unknown as Record<string, unknown>,
    nomeEsquema: "analise_referencia",
    temperatura: 0.3,
    maxTokens: 4000,
    // com imagem, o endpoint do Sonnet exige raciocínio ligado ("Reasoning is mandatory")
    raciocinio: "low",
  }, fetchFn, agora);
  if (!r.ok) return { erro: r.erro };
  return lerAnalise(r.dados) ?? { erro: "análise fora do esquema" };
}

/**
 * Baixa a imagem do anúncio para o R2 e analisa. Se a imagem não mudou desde a última vez, reaproveita a análise.
 * Nunca lança: o erro fica em `erro` e o resto segue.
 */
export async function prepararReferencia(env: ReferenciaEnv, a: AnuncioReferencia, escolhido: Referencia["escolhido"], fetchFn: typeof fetch = fetch, agora = new Date(), forcar = false): Promise<Referencia> {
  const anterior = await lerReferencia(env, a.anuncio_id);
  const ref: Referencia = { anuncio_id: a.anuncio_id, anuncio: a.anuncio, titulo: a.titulo, texto: a.texto, gasto_28d: a.gasto_28d, cadastros_28d: a.cadastros_28d, custo_cadastro_cents: a.custo_cadastro_cents, midia: anterior?.midia ?? null, imagem_chave: anterior?.imagem_chave ?? null, imagem_sha: anterior?.imagem_sha ?? null, analise: anterior?.analise ?? null, escolhido, erro: null, atualizado_em: nowIso() };
  try {
    if (!env.CRIATIVOS) throw new Error("R2 CRIATIVOS não configurado");
    if (!env.META_ADS_TOKEN) throw new Error("META_ADS_TOKEN não configurado");
    const img = await imagensDoAnuncio(env, a.anuncio_id, fetchFn);
    if (!img) throw new Error("criativo sem imagem que dê para baixar");
    const baixada = await baixarImagem(img.urls, fetchFn);
    if (!baixada) throw new Error(`nenhuma das ${img.urls.length} URLs devolveu imagem`);
    const { bytes, tipo } = baixada;
    const sha = await sha256(bytes);
    const chave = `referencia/${a.anuncio_id}.${extensao(tipo)}`;
    ref.midia = img.midia;
    if (sha !== ref.imagem_sha || chave !== ref.imagem_chave) {
      await env.CRIATIVOS.put(chave, bytes, { httpMetadata: { contentType: tipo } });
      ref.imagem_chave = chave;
      ref.imagem_sha = sha;
      ref.analise = null;
    }
    if (!ref.analise || forcar) {
      const dataUrl = await imagemDataUrl(env, ref);
      if (!dataUrl) throw new Error("imagem grande demais para análise");
      const an = await analisar(env, a, ref.midia, dataUrl, fetchFn, agora);
      if ("erro" in an) ref.erro = `análise: ${an.erro}`; else ref.analise = an;
    }
  } catch (e) {
    ref.erro = String(e instanceof Error ? e.message : e).slice(0, 400);
  }
  if (env.CRIATIVOS) await env.CRIATIVOS.put(`referencia/${a.anuncio_id}.json`, JSON.stringify(ref), { httpMetadata: { contentType: "application/json" } });
  return ref;
}

/** Monta a pasta: os anúncios que mais trazem cadastro, baixados e analisados. Roda antes do Analista. */
export async function atualizarReferencias(env: ReferenciaEnv, fetchFn: typeof fetch = fetch, agora = new Date(), forcar = false): Promise<{ referencias: Referencia[]; erros: string[] }> {
  const b = await montarBiblioteca(env.DB, agora);
  const escolhidos = escolherReferencias(b.bases);
  const referencias: Referencia[] = [];
  for (const a of escolhidos) referencias.push(await prepararReferencia(env, a, "leads", fetchFn, agora, forcar));
  // os fixados à mão continuam na pasta, com os números atualizados
  const { manuais } = await lerIndiceBruto(env);
  for (const id of manuais.filter((x) => !escolhidos.some((a) => a.anuncio_id === x))) {
    const [a] = await lerAnuncios(env.DB, agora, id);
    if (a) referencias.push(await prepararReferencia(env, a, "manual", fetchFn, agora, forcar));
  }
  await gravarIndice(env, escolhidos.map((a) => a.anuncio_id), manuais);
  // e a imagem dos outros anúncios do ranking da tela (só download, sem modelo)
  const mini = await garantirMiniaturas(env, fetchFn, agora);
  return { referencias, erros: [...referencias.filter((r) => r.erro).map((r) => `${r.anuncio}: ${r.erro}`), ...mini.erros] };
}

/** Um anúncio escolhido à mão (pode não ter cadastros ainda): entra na pasta como "manual". */
export async function referenciaManual(env: ReferenciaEnv, anuncioId: string, fetchFn: typeof fetch = fetch, agora = new Date()): Promise<Referencia | null> {
  const [a] = await lerAnuncios(env.DB, agora, anuncioId);
  if (!a) return null;
  const ref = await prepararReferencia(env, a, "manual", fetchFn, agora);
  const j = await lerIndiceBruto(env);
  if (!j.manuais.includes(anuncioId)) await gravarIndice(env, j.ids, [...j.manuais, anuncioId]);
  return ref;
}

/** Tira um anúncio fixado à mão da pasta. */
export async function removerReferenciaManual(env: ReferenciaEnv, anuncioId: string): Promise<boolean> {
  const j = await lerIndiceBruto(env);
  if (!j.manuais.includes(anuncioId)) return false;
  await gravarIndice(env, j.ids, j.manuais.filter((x) => x !== anuncioId));
  return true;
}

const reais = (c: number | null): string => (c == null ? "sem cadastro" : `R$ ${(c / 100).toFixed(2).replace(".", ",")}`);
const TIPO_TEXTO: Record<AnaliseVisual["tipo_visual"], string> = { tela_de_chat: "tela de chat", mockup_do_sistema: "mockup do sistema", foto: "foto", texto_na_imagem: "texto na imagem", outro: "outro" };

export function analiseParaModelo(r: Referencia): string {
  if (!r.analise) return "";
  const a = r.analise;
  return `  Visual (${TIPO_TEXTO[a.tipo_visual]}${r.midia === "video" ? ", vídeo" : ""}): ${a.descricao}\n  O que prende: ${a.elementos_que_prendem.join("; ")}\n  Por que converte: ${a.por_que_converte}\n  Variações sugeridas:\n${a.variacoes.map((v) => `   - [${v.formato}] ${v.angulo} (${v.o_que_muda})`).join("\n")}`;
}

/** Texto da pasta para o Analista e o Estrategista. Vazio quando a pasta ainda não foi montada. */
export function referenciasParaModelo(refs: Referencia[]): string {
  if (!refs.length) return "";
  return `PASTA DE REFERÊNCIA (os anúncios que mais trazem cadastro; a imagem foi baixada e analisada). Peça criativos como variações destes, apontando o anuncio_base. Vídeos mostram a tela de chat do produto (não o WhatsApp):\n${refs
    .map((r) => `- anuncio_base ${r.anuncio_id}: "${r.anuncio}"${r.escolhido === "manual" ? " · FIXADO PELO DONO (modelo visual a seguir)" : ""} · ${r.cadastros_28d} cadastros em 28d · ${reais(r.custo_cadastro_cents)} por cadastro\n  Título: ${r.titulo ?? "—"}\n  Texto: ${(r.texto ?? "—").replace(/\s+/g, " ").slice(0, 300)}${r.analise ? `\n${analiseParaModelo(r)}` : ""}`)
    .join("\n")}`;
}

// ---------- ranking: os anúncios da conta que trazem cadastro, para a tela ----------

/** Quantos anúncios com cadastro aparecem no ranking da tela. */
export const RANKING_TOP = 8;

export interface ItemRanking {
  posicao: number;
  anuncio_id: string;
  anuncio: string;
  status: string | null;
  gasto_28d: number;
  cadastros_28d: number;
  custo_cadastro_cents: number | null;
  /** é o anúncio que o Criador usa como base (o melhor custo por cadastro entre os que convertem com confiança) */
  base: boolean;
  na_pasta: boolean;
  imagem_chave: string | null;
}

const MINI = (id: string, ext: string) => `referencia/mini/${id}.${ext}`;

async function chaveImagem(env: ReferenciaEnv, id: string): Promise<string | null> {
  if (!env.CRIATIVOS) return null;
  const ref = await lerReferencia(env, id);
  if (ref?.imagem_chave) return ref.imagem_chave;
  for (const ext of ["jpg", "png", "webp"]) if (await env.CRIATIVOS.head(MINI(id, ext))) return MINI(id, ext);
  return null;
}

/** Ranking por cadastros em 28 dias (empate: menor custo por cadastro), com a imagem guardada quando houver. */
export async function rankingAnuncios(env: ReferenciaEnv, agora = new Date()): Promise<ItemRanking[]> {
  const [todos, b, j] = await Promise.all([lerAnuncios(env.DB, agora), montarBiblioteca(env.DB, agora), lerIndiceBruto(env)]);
  const pasta = new Set([...j.ids, ...j.manuais]);
  const lista = todos.filter((a) => a.cadastros_28d > 0 && a.gasto_28d > 0)
    .sort((x, y) => y.cadastros_28d - x.cadastros_28d || (x.custo_cadastro_cents ?? Infinity) - (y.custo_cadastro_cents ?? Infinity))
    .slice(0, RANKING_TOP);
  return Promise.all(lista.map(async (a, i) => ({
    posicao: i + 1, anuncio_id: a.anuncio_id, anuncio: a.anuncio, status: a.status, gasto_28d: a.gasto_28d, cadastros_28d: a.cadastros_28d, custo_cadastro_cents: a.custo_cadastro_cents,
    base: b.bases[0]?.anuncio_id === a.anuncio_id, na_pasta: pasta.has(a.anuncio_id), imagem_chave: await chaveImagem(env, a.anuncio_id),
  })));
}

/** Baixa (sem análise, sem modelo) a imagem dos anúncios do ranking que ainda não têm imagem guardada. Só lê a Meta. */
export async function garantirMiniaturas(env: ReferenciaEnv, fetchFn: typeof fetch = fetch, agora = new Date()): Promise<{ baixadas: number; erros: string[] }> {
  const out = { baixadas: 0, erros: [] as string[] };
  if (!env.CRIATIVOS || !env.META_ADS_TOKEN) return out;
  for (const item of await rankingAnuncios(env, agora)) {
    if (item.imagem_chave) continue;
    try {
      const img = await imagensDoAnuncio(env, item.anuncio_id, fetchFn);
      const baixada = img ? await baixarImagem(img.urls, fetchFn) : null;
      if (!baixada) { out.erros.push(`${item.anuncio}: sem imagem para baixar`); continue; }
      await env.CRIATIVOS.put(MINI(item.anuncio_id, extensao(baixada.tipo)), baixada.bytes, { httpMetadata: { contentType: baixada.tipo } });
      out.baixadas += 1;
    } catch (e) {
      out.erros.push(`${item.anuncio}: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
    }
  }
  return out;
}
