/**
 * Criador: a partir de um pedido (ângulo + motivo), escreve a copy com o modelo, passa pelo verificador
 * (regras no código + modelo barato), renderiza a imagem (template HTML → PNG), guarda no R2 e, no nível 2,
 * publica na Meta como anúncio novo no conjunto de teste (imagem → criativo → anúncio ACTIVE). Nunca edita um
 * criativo existente. Nível 1 = sombra: gera, verifica, guarda e mostra; não publica.
 *
 * Fontes da copy: o ângulo do pedido, o perfil da empresa, as listas do que pode e não pode (prompts/criador.ts),
 * a biblioteca de referência (anúncios da conta que funcionam e que não, biblioteca.ts) e o resumo da página de
 * destino (paginas.ts). Tudo isso entra no prompt; nada é copiado literalmente.
 *
 * Limites no código: CRIADOR_MAX_DIA criativos por dia e nenhum novo enquanto o último publicado tiver menos
 * de CRIADOR_INTERVALO_DIAS dias (dá tempo de a plataforma aprender e de a gente olhar o resultado).
 */
import { META_API_VERSAO } from "../meta_versao.ts";
import { diaBrt } from "../anuncios.ts";
import { addDays, nowIso } from "../util.ts";
import { chamarLlm } from "./llm.ts";
import type { LlmEnv } from "./llm.ts";
import { PERFIL_NEGOCIO } from "./prompts/analista.ts";
import { AFIRMACOES_PERMITIDAS, ESQUEMA_COPY, ESQUEMA_VERIFICACAO, PROIBIDO, SISTEMA_CRIADOR, SISTEMA_VERIFICADOR } from "./prompts/criador.ts";
import { PALAVRAS_CONTAGEM, PRECO_LINHA as PRECO_CONFIG, PRECO_PERMITIDO } from "../config/negocio.ts";
import { TEMPLATE_ALTURA, TEMPLATE_LARGURA, htmlEscritorio } from "./templates/escritorio.ts";
import { TAMANHOS, htmlChatSistema, primeiroNome, protocoloDe } from "./templates/chat_sistema.ts";
import type { FormatoVideo, MensagemSistema as Mensagem } from "./templates/chat_sistema.ts";
import { baseParaModelo, bibliotecaParaModelo, lerAnuncios, montarBiblioteca } from "./biblioteca.ts";
import { analiseParaModelo, imagemDataUrl, lerIndice, lerReferencia, prepararReferencia } from "./referencia.ts";
import type { Referencia } from "./referencia.ts";
import type { AnuncioReferencia } from "./biblioteca.ts";
import { lerResumos, paginaParaModelo } from "./paginas.ts";

export const MODELO_CRIADOR_PADRAO = "anthropic/claude-sonnet-5.5";
export const MODELO_VERIFICADOR_PADRAO = "anthropic/claude-haiku-5.5";
export const CRIADOR_MAX_DIA = 1;
export const CRIADOR_INTERVALO_DIAS = 3;
export const PRECO_LINHA = PRECO_CONFIG;

export interface CriadorEnv extends LlmEnv {
  CRIATIVOS?: R2Bucket;
  META_ADS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
  META_PAGE_ID?: string;
  META_ADSET_CRIADOR_ID?: string;
  CRIADOR_LINK?: string;
  META_VIDEO_ESPERA_MS?: string; // só para testes
  CRIADOR_PAGINAS?: string;
  LLM_MODELO_CRIADOR?: string;
  LLM_MODELO_VERIFICADOR?: string;
}

export interface Copy {
  nome: string;
  titulo_imagem: string;
  promessa: string;
  texto_primario: string;
  headline: string;
  descricao: string;
  conversa: Mensagem[];
  setor: string;
  atendente: string;
  /** Nome do cliente na lista de conversas (vídeo). */
  contato?: string;
}
export type Formato = "imagem" | "video";

/** Roteiro do vídeo na tela do sistema a partir da copy aprovada. */
export function roteiroDoVideo(c: Copy, agora: Date): Parameters<typeof htmlChatSistema>[0] {
  const [a, m, d] = diaBrt(agora).split("-");
  return {
    titulo_imagem: c.titulo_imagem,
    contato: c.contato?.trim() || "Cliente",
    setor: primeiroNome(c.setor || "", "Atendimento"),
    atendente: primeiroNome(c.atendente || "", "Equipe"),
    protocolo: protocoloDe(c.conversa, c.nome),
    conversa: c.conversa,
    promessa: c.promessa,
    preco: PRECO_LINHA,
    dia: `${d}/${m}/${a}`,
    segundos: VIDEO_SEGUNDOS,
  };
}

/** Os dois vídeos: 1:1 (feed, o principal) e 9:16 (stories e reels). */
export const FORMATOS_VIDEO: FormatoVideo[] = ["quadrado", "story"];
export const VIDEO_SEGUNDOS = 15;
export interface Verificacao {
  aprovado: boolean;
  problemas: Array<{ trecho: string; motivo: string }>;
  por: "regras" | "modelo" | "regras+modelo";
}
export interface Pedido {
  id: number;
  dia: string;
  origem: string;
  formato: Formato;
  campanha_id: string | null;
  campanha: string | null;
  angulo: string;
  motivo: string;
  criativo_pai: number | null;
  /** Anúncio da Meta que a variação segue; null = o Criador escolhe na pasta de referência. */
  anuncio_base?: string | null;
}

export type RenderPng = (html: string, largura: number, altura: number) => Promise<Uint8Array>;
export type RenderWebm = (html: string, largura: number, altura: number, segundos: number) => Promise<{ webm: Uint8Array; capa: Uint8Array; tipo: string }>;

const ehObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const LIMITES = { nome: 60, titulo_imagem: 90, promessa: 80, texto_primario: 400, headline: 60, descricao: 40 } as const;

export function lerCopy(v: unknown, formato: Formato = "imagem"): Copy | null {
  if (!ehObj(v)) return null;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(LIMITES) as Array<keyof typeof LIMITES>) {
    const x = v[k];
    if (typeof x !== "string" || !x.trim()) return null;
    out[k] = x.trim().slice(0, LIMITES[k]);
  }
  out.nome = String(out.nome).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "Criativo";
  const conversa: Mensagem[] = Array.isArray(v.conversa)
    ? v.conversa.filter((m): m is { de: string; texto: string } => ehObj(m) && (m.de === "cliente" || m.de === "atendente" || m.de === "evento") && typeof m.texto === "string" && m.texto.trim() !== "").map((m) => ({ de: m.de as Mensagem["de"], texto: m.texto.trim().slice(0, 90) })).slice(0, 10)
    : [];
  if (formato === "video" && conversa.filter((m) => m.de !== "evento").length < 4) return null;
  out.conversa = conversa;
  out.setor = typeof v.setor === "string" ? v.setor.trim().slice(0, 40) : "";
  out.atendente = typeof v.atendente === "string" ? v.atendente.trim().slice(0, 30) : "";
  out.contato = typeof v.contato === "string" ? v.contato.trim().slice(0, 40) : "";
  return out as unknown as Copy;
}

/** Regras fixas do verificador: o que nunca passa, antes mesmo de perguntar ao modelo. */
const PROIBIDAS: Array<[RegExp, string]> = [
  [/\b(garant\w+|dobr\w+ (suas|as) vendas|nunca mais|100%|melhor do (mercado|brasil)|n[úu]mero 1|l[íi]der)\b/i, "promessa de resultado ou superlativo"],
  [/\b(oficial|homologad\w+|aprovad\w+ pel[ao]|parceir\w+ (da|do) (meta|whatsapp))\b/i, "sugere vínculo oficial com a Meta ou o WhatsApp"],
  [/\b(s[óo] hoje|[úu]ltimas vagas|promo[çc][ãa]o|desconto)\b/i, "urgência falsa ou desconto"],
  [/(?<!teste )(?<!testar )\bgr[áa]tis\b(?![^.]{0,40}\b(teste|testar)\b)/i, "'grátis' sem 'teste'"],
  [new RegExp(`\\b\\d[\\d.]*\\s*\\+?\\s*(mil\\s+)?(${PALAVRAS_CONTAGEM.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i"), "número de clientes ou empresas (não verificado)"],
  ...(PRECO_PERMITIDO == null ? [] : [[new RegExp(`R\\$\\s?(?!${PRECO_PERMITIDO}\\b)\\d+`), `preço diferente de R$ ${PRECO_PERMITIDO}`] as [RegExp, string]]),
  [/!!|\b[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{6,}\b/, "gritaria (!! ou caixa alta)"],
];

export function verificarPorRegras(c: Copy): Array<{ trecho: string; motivo: string }> {
  const textos = [c.titulo_imagem.replace(/\[\[|\]\]/g, ""), c.promessa, c.texto_primario, c.headline, c.descricao, ...(c.conversa ?? []).map((m) => m.texto)];
  const out: Array<{ trecho: string; motivo: string }> = [];
  for (const t of textos) for (const [re, motivo] of PROIBIDAS) { const m = re.exec(t); if (m) out.push({ trecho: m[0], motivo }); }
  const emojis = (c.texto_primario.match(/\p{Extended_Pictographic}/gu) || []).length;
  if (emojis > 1) out.push({ trecho: `${emojis} emojis`, motivo: "mais de um emoji no texto" });
  if (/\p{Extended_Pictographic}/u.test(c.titulo_imagem + c.promessa)) out.push({ trecho: "emoji na imagem", motivo: "sem emoji na imagem" });
  return out;
}

/** Motivos que dizem que NÃO há problema (o modelo lista o trecho mesmo assim). */
const SEM_PROBLEMA = /\b(sem problema|dentro do permitido|sem reprova|nenhum problema|est[áa] ok|aprovad[oa]|(é|est[áa]) aceit[oa]|problema real: nenhum|trecho (é )?aceito|conforme|est[áa] permitid[oa])\b/i;

export async function verificar(env: CriadorEnv, c: Copy, fetchFn: typeof fetch, agora: Date, pagina = ""): Promise<Verificacao> {
  const regras = verificarPorRegras(c);
  if (regras.length) return { aprovado: false, problemas: regras, por: "regras" };
  const r = await chamarLlm<{ aprovado: boolean; problemas: Array<{ trecho: string; motivo: string; viola?: boolean }> }>(env, {
    agente: "verificador",
    modelo: env.LLM_MODELO_VERIFICADOR || MODELO_VERIFICADOR_PADRAO,
    modeloReserva: "deepseek/deepseek-v4.1-flash",
    sistema: SISTEMA_VERIFICADOR,
    usuario: `PODE AFIRMAR:\n${AFIRMACOES_PERMITIDAS}${pagina ? `\n\nTambém pode afirmar o que a página de destino afirma:\n${pagina}` : ""}\n\nPROIBIDO:\n${PROIBIDO}\n\nTEXTO DO ANÚNCIO (JSON):\n${JSON.stringify(c)}`,
    esquema: ESQUEMA_VERIFICACAO as unknown as Record<string, unknown>,
    nomeEsquema: "verificacao",
    temperatura: 0,
    maxTokens: 1500,
    raciocinio: "none",
  }, fetchFn, agora);
  // sem modelo, o verificador não aprova sozinho: o criativo fica em sombra para alguém olhar
  if (!r.ok || !ehObj(r.dados) || typeof r.dados.aprovado !== "boolean") return { aprovado: false, problemas: [{ trecho: "", motivo: `verificador indisponível: ${r.ok ? "resposta inválida" : r.erro}` }], por: "modelo" };
  // o modelo às vezes lista trechos "sem problema" e ainda assim marca aprovado=false: só conta o que é problema de verdade
  const problemas = Array.isArray(r.dados.problemas)
    ? r.dados.problemas.filter((p) => ehObj(p) && typeof p.trecho === "string" && typeof p.motivo === "string" && p.viola !== false && !SEM_PROBLEMA.test(String(p.motivo))).map((p) => ({ trecho: String(p.trecho).slice(0, 200), motivo: String(p.motivo).slice(0, 300) }))
    : [];
  return { aprovado: problemas.length === 0, problemas, por: "regras+modelo" };
}

/**
 * Aprimoramentos automáticos da Meta (Advantage+ creative). O campo antigo `standard_enhancements` foi descontinuado
 * (subcódigo 3858504): cada recurso é desligado um a um (lista em AdCreativeFeaturesSpec). Desligamos os que mudam o
 * texto, a imagem ou o vídeo que o verificador aprovou; o que a Meta só reorganiza (ordem de mídia, selos) fica no padrão.
 */
export const APRIMORAMENTOS_DESLIGADOS = ["text_optimizations", "image_templates", "image_touchups", "adapt_to_placement", "add_text_overlay", "description_automation", "inline_comment", "generate_cta", "image_animation", "image_background_gen", "media_type_automation", "text_translation", "text_overlay_translation", "product_extensions", "site_extensions"];
export const APRIMORAMENTOS: Record<string, string> = { degrees_of_freedom_spec: JSON.stringify({ creative_features_spec: Object.fromEntries(APRIMORAMENTOS_DESLIGADOS.map((k) => [k, { enroll_status: "OPT_OUT" }])) }) };

/**
 * O que a conta já aprendeu, a página de destino e o anúncio base. Base: o que o pedido aponta; senão, um dos
 * anúncios da pasta de referência (alternando entre eles pelo número do pedido); senão, o melhor da biblioteca.
 * Com base na pasta, a imagem guardada vai junto para o modelo ver.
 */
export async function contextoDoCriador(env: CriadorEnv, agora: Date, p?: Pick<Pedido, "id" | "anuncio_base">, fetchFn?: typeof fetch): Promise<ContextoCriador> {
  const [b, paginas, indice] = await Promise.all([montarBiblioteca(env.DB, agora), lerResumos(env.DB), lerIndice(env)]);
  const destino = paginas.find((x) => x.url === env.CRIADOR_LINK) ?? paginas.find((x) => x.resumo);
  let base: AnuncioReferencia | null = null, ref: Referencia | null = null;
  if (p?.anuncio_base) {
    [base = null] = await lerAnuncios(env.DB, agora, p.anuncio_base);
    ref = await lerReferencia(env, p.anuncio_base);
    if (!ref && base && fetchFn) ref = await prepararReferencia(env, base, "manual", fetchFn, agora);
  } else if (indice.referencias.length) {
    ref = indice.referencias[(p?.id ?? 0) % indice.referencias.length];
    base = b.bases.find((x) => x.anuncio_id === ref!.anuncio_id) ?? (await lerAnuncios(env.DB, agora, ref.anuncio_id))[0] ?? null;
  }
  if (!base) { base = b.bases[0] ?? null; ref = base ? await lerReferencia(env, base.anuncio_id) : null; }
  return { biblioteca: bibliotecaParaModelo(b), pagina: paginaParaModelo(destino), base, referencia: ref, imagem: await imagemDataUrl(env, ref) };
}

/** O que entra no prompt: biblioteca, página, o anúncio base (o que converte) e, numa nova versão, a anterior. */
export interface ContextoCriador {
  biblioteca: string;
  pagina: string;
  base?: AnuncioReferencia | null;
  /** A base na pasta de referência (análise do visual) e a imagem dela, para o modelo ver. */
  referencia?: Referencia | null;
  imagem?: string | null;
  anterior?: { copy: Copy; feedback: string } | null;
}

/** Pedidos dos agentes precisam de um anúncio que converte como base; os da pessoa (manual, feedback) seguem mesmo sem. */
export const ORIGENS_EXIGEM_BASE = new Set(["analista_ia", "estrategista"]);

export async function escreverCopy(env: CriadorEnv, p: Pedido, fetchFn: typeof fetch, agora: Date, ctx: ContextoCriador = { biblioteca: "", pagina: "" }): Promise<{ copy: Copy; modelo: string } | { erro: string }> {
  const r = await chamarLlm<unknown>(env, {
    agente: "criador",
    modelo: env.LLM_MODELO_CRIADOR || MODELO_CRIADOR_PADRAO,
    modeloReserva: "deepseek/deepseek-v4-pro",
    sistema: `${SISTEMA_CRIADOR}\n\nSOBRE A EMPRESA:\n${PERFIL_NEGOCIO}\n\nPODE AFIRMAR:\n${AFIRMACOES_PERMITIDAS}\n\nPROIBIDO:\n${PROIBIDO}`,
    usuario: [
      `FORMATO: ${p.formato}\nÂNGULO: ${p.angulo}\nPOR QUÊ: ${p.motivo}\nCAMPANHA: ${p.campanha ?? "—"}\nLinha de preço obrigatória na imagem: "${PRECO_LINHA}".`,
      ctx.base ? baseParaModelo(ctx.base) : "",
      ctx.base && ctx.referencia?.analise ? `O QUE O ANÚNCIO BASE MOSTRA (a imagem vai anexa):\n${analiseParaModelo(ctx.referencia)}` : "",
      ctx.base && ctx.imagem && p.formato === "video" ? "VÍDEO A PARTIR DO ANÚNCIO BASE: se a imagem anexa for uma tela de chat, a conversa do vídeo é essa mesma conversa acontecendo mensagem por mensagem, com o mesmo setor, o mesmo tipo de pedido e o mesmo tom. Troque nomes e dados por fictícios." : "",
      ctx.anterior ? `VERSÃO ANTERIOR (foi revisada por uma pessoa; escreva uma versão nova que atenda ao pedido abaixo, mantendo o que não foi criticado):\n${JSON.stringify(ctx.anterior.copy)}\n\nO QUE A PESSOA PEDIU PARA MELHORAR: ${ctx.anterior.feedback}` : "",
      ctx.pagina,
      ctx.biblioteca ? `O QUE A CONTA JÁ APRENDEU COM OS ANÚNCIOS QUE RODARAM:\n${ctx.biblioteca}` : "",
    ].filter(Boolean).join("\n\n"),
    imagens: ctx.imagem ? [ctx.imagem] : undefined,
    esquema: ESQUEMA_COPY as unknown as Record<string, unknown>,
    nomeEsquema: "copy_anuncio",
    temperatura: 0.7,
    maxTokens: 2500,
    raciocinio: "low",
  }, fetchFn, agora);
  if (!r.ok) return { erro: r.erro };
  const copy = lerCopy(r.dados, p.formato);
  return copy ? { copy, modelo: r.modelo } : { erro: p.formato === "video" ? "copy fora do esquema ou conversa curta demais" : "copy fora do esquema" };
}

// ---------- Meta: imagem → criativo → anúncio ----------

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function postMeta(env: CriadorEnv, caminho: string, corpo: Record<string, string>, fetchFn: typeof fetch): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; texto: string }> {
  const res = await fetchFn(`https://graph.facebook.com/${META_API_VERSAO}/${caminho}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.META_ADS_TOKEN}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(corpo).toString(),
  });
  const texto = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(texto) as Record<string, unknown>; } catch { json = {}; }
  return { ok: res.ok, status: res.status, json, texto: texto.slice(0, 1000) };
}

export function metaPublicacaoConfigurada(env: CriadorEnv): string | null {
  if (!env.META_ADS_TOKEN) return "META_ADS_TOKEN";
  if (!env.META_AD_ACCOUNT_ID) return "META_AD_ACCOUNT_ID";
  if (!env.META_PAGE_ID) return "META_PAGE_ID";
  if (!env.META_ADSET_CRIADOR_ID) return "META_ADSET_CRIADOR_ID";
  if (!env.CRIADOR_LINK) return "CRIADOR_LINK";
  return null;
}

export async function publicarNaMeta(env: CriadorEnv, c: Copy, png: Uint8Array, nome: string, fetchFn: typeof fetch): Promise<{ ok: true; imagem_hash: string; creative_id: string; ad_id: string } | { ok: false; etapa: string; resposta: string }> {
  const conta = `act_${env.META_AD_ACCOUNT_ID}`;
  const img = await postMeta(env, `${conta}/adimages`, { bytes: b64(png), name: `${nome}.png` }, fetchFn);
  const images = (img.json.images ?? {}) as Record<string, { hash?: string }>;
  const hash = Object.values(images)[0]?.hash;
  if (!img.ok || !hash) return { ok: false, etapa: "imagem", resposta: `HTTP ${img.status}: ${img.texto}` };
  const spec = {
    page_id: env.META_PAGE_ID,
    link_data: { image_hash: hash, link: env.CRIADOR_LINK, message: c.texto_primario, name: c.headline, description: c.descricao, call_to_action: { type: "LEARN_MORE", value: { link: env.CRIADOR_LINK } } },
  };
  const cr = await postMeta(env, `${conta}/adcreatives`, { name: nome, object_story_spec: JSON.stringify(spec), ...APRIMORAMENTOS }, fetchFn);
  const creativeId = typeof cr.json.id === "string" ? cr.json.id : null;
  if (!cr.ok || !creativeId) return { ok: false, etapa: "criativo", resposta: `HTTP ${cr.status}: ${cr.texto}` };
  const ad = await postMeta(env, `${conta}/ads`, { name: nome, adset_id: env.META_ADSET_CRIADOR_ID!, creative: JSON.stringify({ creative_id: creativeId }), status: "ACTIVE" }, fetchFn);
  const adId = typeof ad.json.id === "string" ? ad.json.id : null;
  if (!ad.ok || !adId) return { ok: false, etapa: "anuncio", resposta: `HTTP ${ad.status}: ${ad.texto}` };
  return { ok: true, imagem_hash: hash, creative_id: creativeId, ad_id: adId };
}

/**
 * Vídeo: sobe o WebM (advideos), espera processar, sobe a capa como imagem e cria criativo + anúncio.
 * No Instagram o anúncio sai em nome do perfil ligado à página: a conta de anúncios precisa estar conectada a esse perfil e o
 * usuário do sistema precisa ter a página e o perfil atribuídos (senão a Meta recusa com o subcódigo 1815199).
 */
/** Só envia o vídeo para a biblioteca da conta (sem esperar o processamento). */
async function enviarVideo(env: CriadorEnv, webm: Uint8Array, nome: string, fetchFn: typeof fetch): Promise<{ ok: true; video_id: string } | { ok: false; etapa: string; resposta: string }> {
  const fd = new FormData();
  fd.append("access_token", env.META_ADS_TOKEN!);
  fd.append("name", nome);
  fd.append("source", new Blob([webm.slice().buffer], { type: "video/webm" }), `${nome}.webm`);
  const up = await fetchFn(`https://graph.facebook.com/${META_API_VERSAO}/act_${env.META_AD_ACCOUNT_ID}/advideos`, { method: "POST", body: fd });
  const upTexto = await up.text();
  let videoId: string | null = null;
  try { videoId = (JSON.parse(upTexto) as { id?: string }).id ?? null; } catch { videoId = null; }
  if (!up.ok || !videoId) return { ok: false, etapa: "video", resposta: `HTTP ${up.status}: ${upTexto.slice(0, 600)}` };
  return { ok: true, video_id: videoId };
}

/** Situação do processamento do vídeo na Meta: ready, processing, error (ou desconhecida). */
async function statusVideo(env: CriadorEnv, videoId: string, fetchFn: typeof fetch): Promise<string> {
  const st = await fetchFn(`https://graph.facebook.com/${META_API_VERSAO}/${videoId}?fields=status`, { headers: { authorization: `Bearer ${env.META_ADS_TOKEN}` } });
  const j = (await st.json().catch(() => ({}))) as { status?: { video_status?: string } };
  return j.status?.video_status ?? "desconhecido";
}

/** Sobe um vídeo para a conta e espera a Meta deixar "ready" (o criativo só aceita vídeo pronto). */
async function subirVideo(env: CriadorEnv, webm: Uint8Array, nome: string, fetchFn: typeof fetch, esperaMs: number, tentativas: number): Promise<{ ok: true; video_id: string } | { ok: false; etapa: string; resposta: string }> {
  const up = await enviarVideo(env, webm, nome, fetchFn);
  if (!up.ok) return up;
  for (let i = 0; i < tentativas; i++) {
    await new Promise((r) => setTimeout(r, esperaMs));
    const st = await statusVideo(env, up.video_id, fetchFn);
    if (st === "ready") return up;
    if (st === "error") return { ok: false, etapa: "video", resposta: "a Meta não conseguiu processar o vídeo" };
  }
  return { ok: false, etapa: "video", resposta: "vídeo ainda em processamento na Meta; tente publicar de novo em alguns minutos" };
}

async function subirCapa(env: CriadorEnv, png: Uint8Array, nome: string, fetchFn: typeof fetch): Promise<string | { etapa: string; resposta: string }> {
  const img = await postMeta(env, `act_${env.META_AD_ACCOUNT_ID}/adimages`, { bytes: b64(png), name: `${nome}.png` }, fetchFn);
  const hash = Object.values((img.json.images ?? {}) as Record<string, { hash?: string }>)[0]?.hash;
  return img.ok && hash ? hash : { etapa: "capa", resposta: `HTTP ${img.status}: ${img.texto}` };
}

/**
 * Criativo com dois vídeos, um por posicionamento (personalização por posicionamento da Meta): o 9:16 nos stories
 * e reels, o 1:1 em todo o resto. Mesmo texto, título, descrição e link nos dois.
 */
export function specDoisFormatos(env: CriadorEnv, c: Copy, quadrado: { video_id: string; hash: string }, story: { video_id: string; hash: string }): Record<string, unknown> {
  const plataformas = ["facebook", "instagram"];
  return {
    videos: [
      { video_id: quadrado.video_id, thumbnail_hash: quadrado.hash, adlabels: [{ name: "dd_quadrado" }] },
      { video_id: story.video_id, thumbnail_hash: story.hash, adlabels: [{ name: "dd_story" }] },
    ],
    bodies: [{ text: c.texto_primario }],
    titles: [{ text: c.headline }],
    descriptions: [{ text: c.descricao }],
    link_urls: [{ website_url: env.CRIADOR_LINK }],
    call_to_action_types: ["LEARN_MORE"],
    ad_formats: ["SINGLE_VIDEO"],
    optimization_type: "PLACEMENT",
    asset_customization_rules: [
      { customization_spec: { publisher_platforms: plataformas, facebook_positions: ["story", "facebook_reels"], instagram_positions: ["story", "reels"] }, video_label: { name: "dd_story" }, priority: 1 },
      { customization_spec: { publisher_platforms: plataformas, facebook_positions: ["feed", "video_feeds", "marketplace", "search"], instagram_positions: ["stream", "explore", "explore_home", "profile_feed"] }, video_label: { name: "dd_quadrado" }, priority: 2 },
    ],
  };
}

/** Criativo e anúncio ACTIVE a partir de vídeos já prontos na Meta (com o 9:16, um vídeo por posicionamento). */
async function criarAnuncioDeVideo(env: CriadorEnv, c: Copy, nome: string, quadrado: { video_id: string; hash: string }, story: { video_id: string; hash: string } | null, fetchFn: typeof fetch): Promise<{ ok: true; creative_id: string; ad_id: string } | { ok: false; etapa: string; resposta: string }> {
  const conta = `act_${env.META_AD_ACCOUNT_ID}`;
  const corpo: Record<string, string> = story
    ? { name: nome, object_story_spec: JSON.stringify({ page_id: env.META_PAGE_ID }), asset_feed_spec: JSON.stringify(specDoisFormatos(env, c, quadrado, story)), ...APRIMORAMENTOS }
    : { name: nome, object_story_spec: JSON.stringify({ page_id: env.META_PAGE_ID, video_data: { video_id: quadrado.video_id, image_hash: quadrado.hash, message: c.texto_primario, title: c.headline, link_description: c.descricao, call_to_action: { type: "LEARN_MORE", value: { link: env.CRIADOR_LINK } } } }), ...APRIMORAMENTOS };
  const cr = await postMeta(env, `${conta}/adcreatives`, corpo, fetchFn);
  const creativeId = typeof cr.json.id === "string" ? cr.json.id : null;
  if (!cr.ok || !creativeId) return { ok: false, etapa: "criativo", resposta: `HTTP ${cr.status}: ${cr.texto}` };
  const ad = await postMeta(env, `${conta}/ads`, { name: nome, adset_id: env.META_ADSET_CRIADOR_ID!, creative: JSON.stringify({ creative_id: creativeId }), status: "ACTIVE" }, fetchFn);
  const adId = typeof ad.json.id === "string" ? ad.json.id : null;
  if (!ad.ok || !adId) return { ok: false, etapa: "anuncio", resposta: `HTTP ${ad.status}: ${ad.texto}` };
  return { ok: true, creative_id: creativeId, ad_id: adId };
}

/** Quanto a publicação de um vídeo pode ficar esperando a Meta processar antes de virar erro. */
export const PUBLICACAO_PRAZO_MIN = 120;

/**
 * Termina uma publicação de vídeo que ficou em "publicando": quando os vídeos estão prontos na Meta, cria o
 * criativo e o anúncio. Chamado logo depois do envio (algumas tentativas curtas) e pelo cron a cada 5 minutos.
 */
export async function concluirPublicacao(env: CriadorEnv, id: number, fetchFn: typeof fetch = fetch, agora = new Date()): Promise<{ status: "publicado" | "publicando" | "erro"; mensagem: string }> {
  const c = await env.DB.prepare("SELECT id, status, copy_json, video_id, video_story_id, imagem_hash, resposta, revisado_em FROM ads_criativos WHERE id = ?1").bind(id).first<{ id: number; status: string; copy_json: string; video_id: string | null; video_story_id: string | null; imagem_hash: string | null; resposta: string | null; revisado_em: string | null }>();
  if (!c || c.status !== "publicando" || !c.video_id || !c.imagem_hash) return { status: "erro", mensagem: "nada para concluir" };
  let extra: { nome?: string; capa_story_hash?: string | null } = {};
  try { extra = JSON.parse(c.resposta ?? "{}") as typeof extra; } catch { extra = {}; }
  const estados = await Promise.all([c.video_id, c.video_story_id].filter((v): v is string => Boolean(v)).map((v) => statusVideo(env, v, fetchFn)));
  const falhar = async (msg: string) => {
    await env.DB.prepare("UPDATE ads_criativos SET status = 'erro', resposta = ?2 WHERE id = ?1").bind(id, msg).run();
    return { status: "erro" as const, mensagem: msg };
  };
  if (estados.includes("error")) return falhar("video: a Meta não conseguiu processar o vídeo");
  if (!estados.every((e) => e === "ready")) {
    const desde = c.revisado_em ? (agora.getTime() - new Date(c.revisado_em).getTime()) / 60_000 : 0;
    if (desde > PUBLICACAO_PRAZO_MIN) return falhar(`video: a Meta não terminou de processar em ${PUBLICACAO_PRAZO_MIN} minutos`);
    return { status: "publicando", mensagem: "vídeos enviados; a Meta ainda está processando. O anúncio é criado sozinho em alguns minutos." };
  }
  const copy = JSON.parse(c.copy_json) as Copy;
  const story = c.video_story_id && extra.capa_story_hash ? { video_id: c.video_story_id, hash: extra.capa_story_hash } : null;
  const r = await criarAnuncioDeVideo(env, copy, extra.nome ?? copy.nome, { video_id: c.video_id, hash: c.imagem_hash }, story, fetchFn);
  if (!r.ok) return falhar(`${r.etapa}: ${r.resposta}`);
  await env.DB.prepare("UPDATE ads_criativos SET status = 'publicado', creative_id = ?2, ad_id = ?3, resposta = 'ok', publicado_em = ?4 WHERE id = ?1").bind(id, r.creative_id, r.ad_id, nowIso()).run();
  return { status: "publicado", mensagem: `publicado: anúncio ${r.ad_id}` };
}

/** Cron: conclui as publicações de vídeo que estão esperando a Meta. */
export async function concluirPublicacoes(env: CriadorEnv, fetchFn: typeof fetch = fetch, agora = new Date()): Promise<Array<{ id: number; status: string; mensagem: string }>> {
  const r = await env.DB.prepare("SELECT id FROM ads_criativos WHERE status = 'publicando' ORDER BY id").all<{ id: number }>();
  const out: Array<{ id: number; status: string; mensagem: string }> = [];
  for (const x of r.results) out.push({ id: Number(x.id), ...(await concluirPublicacao(env, Number(x.id), fetchFn, agora)) });
  return out;
}

/** Vídeo → capa → criativo → anúncio ACTIVE. Com `story`, o anúncio leva os dois formatos (1:1 e 9:16). */
export async function publicarVideoNaMeta(env: CriadorEnv, c: Copy, webm: Uint8Array, capa: Uint8Array, nome: string, fetchFn: typeof fetch, esperaMs = Number(env.META_VIDEO_ESPERA_MS ?? 4000), tentativas = 20, story: { webm: Uint8Array; capa: Uint8Array } | null = null): Promise<{ ok: true; video_id: string; video_story_id: string | null; imagem_hash: string; creative_id: string; ad_id: string } | { ok: false; etapa: string; resposta: string }> {
  const v = await subirVideo(env, webm, nome, fetchFn, esperaMs, tentativas);
  if (!v.ok) return v;
  const hash = await subirCapa(env, capa, `${nome}-capa`, fetchFn);
  if (typeof hash !== "string") return { ok: false, ...hash };
  let storyFinal: { video_id: string; hash: string } | null = null;
  if (story) {
    const vs = await subirVideo(env, story.webm, `${nome}_story`, fetchFn, esperaMs, tentativas);
    if (!vs.ok) return { ...vs, etapa: "video_story" };
    const hs = await subirCapa(env, story.capa, `${nome}_story-capa`, fetchFn);
    if (typeof hs !== "string") return { ok: false, etapa: "capa_story", resposta: hs.resposta };
    storyFinal = { video_id: vs.video_id, hash: hs };
  }
  const r = await criarAnuncioDeVideo(env, c, nome, { video_id: v.video_id, hash }, storyFinal, fetchFn);
  if (!r.ok) return r;
  const storyId = storyFinal?.video_id ?? null, creativeId = r.creative_id, adId = r.ad_id;
  return { ok: true, video_id: v.video_id, video_story_id: storyId, imagem_hash: hash, creative_id: creativeId, ad_id: adId };
}

// ---------- rodada ----------

const n = (v: unknown): number => Number(v ?? 0) || 0;

export async function pedidosPendentes(db: D1Database, soId?: number): Promise<Pedido[]> {
  const r = soId
    ? await db.prepare("SELECT id, dia, origem, formato, campanha_id, campanha, angulo, motivo, criativo_pai, anuncio_base FROM ads_pedidos_criativo WHERE status = 'pendente' AND id = ?1").bind(soId).all<Record<string, unknown>>()
    : await db.prepare("SELECT id, dia, origem, formato, campanha_id, campanha, angulo, motivo, criativo_pai, anuncio_base FROM ads_pedidos_criativo WHERE status = 'pendente' ORDER BY id").all<Record<string, unknown>>();
  return r.results.map((x) => ({ id: n(x.id), dia: String(x.dia), origem: String(x.origem), formato: x.formato === "video" ? "video" : "imagem", campanha_id: x.campanha_id == null ? null : String(x.campanha_id), campanha: x.campanha == null ? null : String(x.campanha), angulo: String(x.angulo), motivo: String(x.motivo), criativo_pai: x.criativo_pai == null ? null : n(x.criativo_pai), anuncio_base: x.anuncio_base == null ? null : String(x.anuncio_base) }));
}

export async function registrarPedido(db: D1Database, dia: string, origem: string, p: { plataforma: string; campanha_id: string | null; campanha: string | null; angulo: string; motivo: string; criativo_pai?: number | null; formato?: Formato; anuncio_base?: string | null }): Promise<number> {
  const formato: Formato = p.formato === "video" ? "video" : "imagem";
  const existe = await db.prepare("SELECT id FROM ads_pedidos_criativo WHERE dia = ?1 AND status = 'pendente' AND angulo = ?2 AND origem = ?3 AND formato = ?4").bind(dia, p.angulo, origem, formato).first<{ id: number }>();
  if (existe) return Number(existe.id);
  const r = await db.prepare("INSERT INTO ads_pedidos_criativo (dia, origem, plataforma, campanha_id, campanha, angulo, motivo, status, criativo_pai, formato, criado_em, anuncio_base) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pendente', ?8, ?9, ?10, ?11)").bind(dia, origem, p.plataforma, p.campanha_id, p.campanha, p.angulo.slice(0, 400), p.motivo.slice(0, 600), p.criativo_pai ?? null, formato, nowIso(), p.anuncio_base ?? null).run();
  return Number(r.meta.last_row_id);
}

/** Quantos criativos saíram hoje e há quantos dias foi o último publicado (null = nenhum). */
async function ritmo(db: D1Database, hoje: string, agora: Date): Promise<{ hoje: number; dias_desde_ultimo: number | null }> {
  const h = await db.prepare("SELECT COUNT(*) AS c FROM ads_criativos WHERE dia = ?1 AND status IN ('sombra', 'publicado')").bind(hoje).first<{ c: unknown }>();
  const u = await db.prepare("SELECT MAX(dia) AS d FROM ads_criativos WHERE status = 'publicado'").first<{ d: unknown }>();
  const dias = u?.d ? Math.round((agora.getTime() - new Date(`${String(u.d)}T12:00:00-03:00`).getTime()) / 86_400_000) : null;
  return { hoje: n(h?.c), dias_desde_ultimo: dias };
}

export interface ResultadoCriador {
  bloqueado: string | null;
  nivel: number;
  gerados: number;
  reprovados: number;
  publicados: number;
  erros: number;
  detalhes: Array<{ pedido: number; criativo: number | null; status: string; nota: string }>;
}

export async function rodarCriador(env: CriadorEnv, nivel: number, deps: { renderPng: RenderPng; renderWebm?: RenderWebm; fetchFn?: typeof fetch; agora?: Date; soPedido?: number }): Promise<ResultadoCriador> {
  const fetchFn = deps.fetchFn ?? fetch, agora = deps.agora ?? new Date(), hoje = diaBrt(agora);
  const out: ResultadoCriador = { bloqueado: null, nivel, gerados: 0, reprovados: 0, publicados: 0, erros: 0, detalhes: [] };
  if (nivel < 1) { out.bloqueado = "nível 0: criador só observa"; return out; }
  if (!env.CRIATIVOS) { out.bloqueado = "R2 CRIATIVOS não configurado"; return out; }
  const pendentes = await pedidosPendentes(env.DB, deps.soPedido);
  for (const p of pendentes) {
    // um pedido vindo de feedback (nova versão) ou uma rodada pedida à mão para um pedido só não conta no ritmo: a pessoa está esperando
    const r = p.origem === "feedback" || deps.soPedido != null ? null : await ritmo(env.DB, hoje, agora);
    if (r && r.hoje >= CRIADOR_MAX_DIA) { out.detalhes.push({ pedido: p.id, criativo: null, status: "adiado", nota: `limite de ${CRIADOR_MAX_DIA} por dia` }); continue; }
    if (r && nivel >= 2 && r.dias_desde_ultimo != null && r.dias_desde_ultimo < CRIADOR_INTERVALO_DIAS) { out.detalhes.push({ pedido: p.id, criativo: null, status: "adiado", nota: `último publicado há ${r.dias_desde_ultimo} dias (mínimo ${CRIADOR_INTERVALO_DIAS})` }); continue; }
    // pedido velho (mais de 7 dias) expira sem gerar
    if (diaBrt(addDays(agora, -7)) > p.dia) { await env.DB.prepare("UPDATE ads_pedidos_criativo SET status = 'expirado' WHERE id = ?1").bind(p.id).run(); out.detalhes.push({ pedido: p.id, criativo: null, status: "expirado", nota: "pedido com mais de 7 dias" }); continue; }

    const ctx: ContextoCriador = await contextoDoCriador(env, agora, p, fetchFn);
    // variação nasce de anúncio que converte em cadastro: sem base com confiança, o pedido de agente espera
    if (!ctx.base && ORIGENS_EXIGEM_BASE.has(p.origem)) { out.detalhes.push({ pedido: p.id, criativo: null, status: "adiado", nota: "nenhum anúncio com cadastros suficientes para servir de base" }); continue; }
    const angulo = ctx.base ? `variação de "${ctx.base.anuncio}" (${ctx.base.anuncio_id}) · ${p.angulo}`.slice(0, 600) : p.angulo;
    if (p.criativo_pai) {
      const pai = await env.DB.prepare("SELECT copy_json, feedback FROM ads_criativos WHERE id = ?1").bind(p.criativo_pai).first<{ copy_json: string; feedback: string | null }>();
      if (pai) ctx.anterior = { copy: JSON.parse(pai.copy_json) as Copy, feedback: pai.feedback ?? p.motivo };
    }
    const esc = await escreverCopy(env, p, fetchFn, agora, ctx);
    if ("erro" in esc) { out.erros += 1; out.detalhes.push({ pedido: p.id, criativo: null, status: "erro", nota: esc.erro }); continue; }
    const ver = await verificar(env, esc.copy, fetchFn, agora, ctx.pagina);
    const ins = await env.DB
      .prepare("INSERT INTO ads_criativos (dia, pedido_id, plataforma, campanha_id, conjunto_id, angulo, modelo, copy_json, verificacao_json, status, criativo_pai, formato, criado_em, anuncio_base) VALUES (?1, ?2, 'meta', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)")
      .bind(hoje, p.id, p.campanha_id, env.META_ADSET_CRIADOR_ID ?? null, angulo, esc.modelo, JSON.stringify(esc.copy), JSON.stringify(ver), ver.aprovado ? "sombra" : "reprovado", p.criativo_pai, p.formato, nowIso(), ctx.base?.anuncio_id ?? null)
      .run();
    const id = Number(ins.meta.last_row_id);
    if (!ver.aprovado) {
      out.reprovados += 1;
      await env.DB.prepare("UPDATE ads_pedidos_criativo SET status = 'recusado', criativo_id = ?2, recusa = ?3 WHERE id = ?1").bind(p.id, id, ver.problemas.map((x) => x.motivo).join("; ").slice(0, 400)).run();
      out.detalhes.push({ pedido: p.id, criativo: id, status: "reprovado", nota: ver.problemas.map((x) => `${x.trecho}: ${x.motivo}`).join(" · ").slice(0, 300) });
      continue;
    }
    let png: Uint8Array;
    let webm: Uint8Array | null = null;
    let story: { webm: Uint8Array; capa: Uint8Array } | null = null;
    try {
      if (p.formato === "video") {
        if (!deps.renderWebm) throw new Error("sem gravador de vídeo");
        const roteiro = roteiroDoVideo(esc.copy, agora);
        const q = await deps.renderWebm(htmlChatSistema(roteiro, "quadrado"), TAMANHOS.quadrado.largura, TAMANHOS.quadrado.altura, VIDEO_SEGUNDOS);
        webm = q.webm; png = q.capa;
        await env.CRIATIVOS.put(`criativos/${id}.webm`, webm, { httpMetadata: { contentType: "video/webm" } });
        await env.CRIATIVOS.put(`criativos/${id}-capa.png`, png, { httpMetadata: { contentType: "image/png" } });
        const st = await deps.renderWebm(htmlChatSistema(roteiro, "story"), TAMANHOS.story.largura, TAMANHOS.story.altura, VIDEO_SEGUNDOS);
        story = { webm: st.webm, capa: st.capa };
        await env.CRIATIVOS.put(`criativos/${id}-story.webm`, st.webm, { httpMetadata: { contentType: "video/webm" } });
        await env.CRIATIVOS.put(`criativos/${id}-story-capa.png`, st.capa, { httpMetadata: { contentType: "image/png" } });
        await env.DB.prepare("UPDATE ads_criativos SET video_chave = ?2, capa_chave = ?3, imagem_chave = ?3, video_story_chave = ?4, capa_story_chave = ?5 WHERE id = ?1").bind(id, `criativos/${id}.webm`, `criativos/${id}-capa.png`, `criativos/${id}-story.webm`, `criativos/${id}-story-capa.png`).run();
      } else {
        png = await deps.renderPng(htmlEscritorio({ titulo_imagem: esc.copy.titulo_imagem, promessa: esc.copy.promessa, preco: PRECO_LINHA }), TEMPLATE_LARGURA, TEMPLATE_ALTURA);
        const chave = `criativos/${id}.png`;
        await env.CRIATIVOS.put(chave, png, { httpMetadata: { contentType: "image/png" } });
        await env.DB.prepare("UPDATE ads_criativos SET imagem_chave = ?2 WHERE id = ?1").bind(id, chave).run();
      }
    } catch (e) {
      out.erros += 1;
      await env.DB.prepare("UPDATE ads_criativos SET status = 'erro', resposta = ?2 WHERE id = ?1").bind(id, `render: ${String(e)}`.slice(0, 1000)).run();
      out.detalhes.push({ pedido: p.id, criativo: id, status: "erro", nota: `render: ${String(e)}` });
      continue;
    }
    out.gerados += 1;
    await env.DB.prepare("UPDATE ads_pedidos_criativo SET status = 'atendido', criativo_id = ?2 WHERE id = ?1").bind(p.id, id).run();
    if (nivel < 2 || p.origem === "feedback") { out.detalhes.push({ pedido: p.id, criativo: id, status: "sombra", nota: nivel < 2 ? "gerado e guardado; nível 1 não publica" : "nova versão aguarda aprovação de quem pediu a melhoria" }); continue; }
    const falta = metaPublicacaoConfigurada(env);
    if (falta) { out.detalhes.push({ pedido: p.id, criativo: id, status: "sombra", nota: `publicação desligada: falta ${falta}` }); continue; }
    const nome = `${esc.copy.nome}_${hoje.replace(/-/g, "")}_ia`;
    const pub = webm ? await publicarVideoNaMeta(env, esc.copy, webm, png, nome, fetchFn, undefined, undefined, story) : await publicarNaMeta(env, esc.copy, png, nome, fetchFn);
    if (!pub.ok) {
      out.erros += 1;
      await env.DB.prepare("UPDATE ads_criativos SET status = 'erro', resposta = ?2 WHERE id = ?1").bind(id, `${pub.etapa}: ${pub.resposta}`).run();
      out.detalhes.push({ pedido: p.id, criativo: id, status: "erro", nota: `${pub.etapa}: ${pub.resposta.slice(0, 200)}` });
      continue;
    }
    out.publicados += 1;
    await env.DB.prepare("UPDATE ads_criativos SET status = 'publicado', imagem_hash = ?2, creative_id = ?3, ad_id = ?4, video_id = ?6, video_story_id = ?7, resposta = 'ok', publicado_em = ?5 WHERE id = ?1").bind(id, pub.imagem_hash, pub.creative_id, pub.ad_id, nowIso(), "video_id" in pub ? pub.video_id : null, "video_story_id" in pub ? pub.video_story_id : null).run();
    out.detalhes.push({ pedido: p.id, criativo: id, status: "publicado", nota: `anúncio ${pub.ad_id} no conjunto ${env.META_ADSET_CRIADOR_ID}` });
  }
  return out;
}

// ---------- aprovação e feedback pelo painel ----------

export type AcaoCriativo = "publicar" | "reprovar" | "melhorar";

/**
 * Publicar: sobe o PNG guardado e cria o anúncio (mesmo caminho do nível 2). Reprovar: fecha com o motivo.
 * Melhorar: registra um pedido novo ligado a este criativo; o Criador escreve outra versão na hora (se houver
 * renderizador) ou na próxima rodada, e ela volta ao painel em sombra para aprovação.
 */
export async function acaoCriativo(env: CriadorEnv, id: number, acao: AcaoCriativo, feedback: string, quem: string, deps: { renderPng?: RenderPng; renderWebm?: RenderWebm; fetchFn?: typeof fetch; agora?: Date } = {}): Promise<{ ok: boolean; mensagem: string; novo_criativo?: number | null }> {
  const fetchFn = deps.fetchFn ?? fetch, agora = deps.agora ?? new Date();
  const c = await env.DB.prepare("SELECT id, status, angulo, campanha_id, copy_json, imagem_chave, formato, video_chave, capa_chave, anuncio_base, video_story_chave, capa_story_chave FROM ads_criativos WHERE id = ?1").bind(id).first<{ id: number; status: string; angulo: string; campanha_id: string | null; copy_json: string; imagem_chave: string | null; formato: string; video_chave: string | null; capa_chave: string | null; anuncio_base: string | null; video_story_chave: string | null; capa_story_chave: string | null }>();
  if (!c) return { ok: false, mensagem: "criativo não encontrado" };
  const marcar = (status: string | null, extra = "") => env.DB
    .prepare(`UPDATE ads_criativos SET ${status ? "status = ?2, " : ""}feedback = ?3, revisado_por = ?4, revisado_em = ?5${extra} WHERE id = ?1`)
    .bind(id, status ?? c.status, feedback.slice(0, 1000) || null, quem, nowIso()).run();
  if (acao === "reprovar") {
    if (c.status === "publicado") return { ok: false, mensagem: "já publicado: pause o anúncio pela plataforma" };
    await marcar("reprovado");
    return { ok: true, mensagem: "reprovado" };
  }
  if (acao === "publicar") {
    if (c.status === "publicado") return { ok: false, mensagem: "já publicado" };
    if (!c.imagem_chave || !env.CRIATIVOS) return { ok: false, mensagem: "este criativo não tem imagem (foi reprovado antes de renderizar); peça uma melhoria" };
    const falta = metaPublicacaoConfigurada(env);
    if (falta) return { ok: false, mensagem: `publicação desligada: falta ${falta}` };
    const obj = await env.CRIATIVOS.get(c.imagem_chave);
    if (!obj) return { ok: false, mensagem: "imagem não encontrada no R2" };
    const png = new Uint8Array(await obj.arrayBuffer());
    const copy = JSON.parse(c.copy_json) as Copy;
    const nomePub = `${copy.nome}_${diaBrt(agora).replace(/-/g, "")}_aprovado`;
    if (c.formato === "video" && c.video_chave) {
      // vídeo em duas etapas: o clique só envia os arquivos (rápido) e o anúncio é criado quando a Meta termina de
      // processar (aqui mesmo, se for rápido, ou pelo cron de 5 em 5 minutos). Esperar tudo no clique estourava o
      // limite de ~100 s de uma requisição.
      const v = await env.CRIATIVOS.get(c.video_chave);
      if (!v) return { ok: false, mensagem: "vídeo não encontrado no R2" };
      let story: { webm: Uint8Array; capa: Uint8Array } | null = null;
      if (c.video_story_chave && c.capa_story_chave) {
        const [vs, cs] = await Promise.all([env.CRIATIVOS.get(c.video_story_chave), env.CRIATIVOS.get(c.capa_story_chave)]);
        if (!vs || !cs) return { ok: false, mensagem: "vídeo 9:16 não encontrado no R2" };
        story = { webm: new Uint8Array(await vs.arrayBuffer()), capa: new Uint8Array(await cs.arrayBuffer()) };
      }
      const falha = async (etapa: string, resposta: string) => {
        await env.DB.prepare("UPDATE ads_criativos SET status = 'erro', resposta = ?2, revisado_por = ?3, revisado_em = ?4 WHERE id = ?1").bind(id, `${etapa}: ${resposta}`, quem, nowIso()).run();
        return { ok: false, mensagem: `a Meta recusou (${etapa}): ${resposta.slice(0, 200)}` };
      };
      const vq = await enviarVideo(env, new Uint8Array(await v.arrayBuffer()), nomePub, fetchFn);
      if (!vq.ok) return falha(vq.etapa, vq.resposta);
      const hq = await subirCapa(env, png, `${nomePub}-capa`, fetchFn);
      if (typeof hq !== "string") return falha(hq.etapa, hq.resposta);
      let vsId: string | null = null, hs: string | null = null;
      if (story) {
        const vs = await enviarVideo(env, story.webm, `${nomePub}_story`, fetchFn);
        if (!vs.ok) return falha("video_story", vs.resposta);
        const h = await subirCapa(env, story.capa, `${nomePub}_story-capa`, fetchFn);
        if (typeof h !== "string") return falha("capa_story", h.resposta);
        vsId = vs.video_id; hs = h;
      }
      await env.DB.prepare("UPDATE ads_criativos SET status = 'publicando', video_id = ?2, video_story_id = ?3, imagem_hash = ?4, resposta = ?5, revisado_por = ?6, revisado_em = ?7 WHERE id = ?1").bind(id, vq.video_id, vsId, hq, JSON.stringify({ nome: nomePub, capa_story_hash: hs }), quem, nowIso()).run();
      const espera = Number(env.META_VIDEO_ESPERA_MS ?? 5000);
      let r = await concluirPublicacao(env, id, fetchFn, agora);
      for (let i = 0; i < 6 && r.status === "publicando"; i++) { await new Promise((x) => setTimeout(x, espera)); r = await concluirPublicacao(env, id, fetchFn, agora); }
      return { ok: r.status !== "erro", mensagem: r.mensagem };
    }
    const pub = await publicarNaMeta(env, copy, png, nomePub, fetchFn);
    if (!pub.ok) {
      await env.DB.prepare("UPDATE ads_criativos SET status = 'erro', resposta = ?2, revisado_por = ?3, revisado_em = ?4 WHERE id = ?1").bind(id, `${pub.etapa}: ${pub.resposta}`, quem, nowIso()).run();
      return { ok: false, mensagem: `a Meta recusou (${pub.etapa}): ${pub.resposta.slice(0, 200)}` };
    }
    await env.DB.prepare("UPDATE ads_criativos SET status = 'publicado', imagem_hash = ?2, creative_id = ?3, ad_id = ?4, video_id = ?7, video_story_id = ?8, resposta = 'ok', publicado_em = ?5, revisado_por = ?6, revisado_em = ?5 WHERE id = ?1").bind(id, pub.imagem_hash, pub.creative_id, pub.ad_id, nowIso(), quem, "video_id" in pub ? pub.video_id : null, "video_story_id" in pub ? pub.video_story_id : null).run();
    return { ok: true, mensagem: `publicado: anúncio ${pub.ad_id}` };
  }
  // melhorar
  if (feedback.trim().length < 5) return { ok: false, mensagem: "escreva o que melhorar" };
  await marcar(c.status === "publicado" ? null : "reprovado");
  const pedido = await registrarPedido(env.DB, diaBrt(agora), "feedback", { plataforma: "meta", campanha_id: c.campanha_id, campanha: null, angulo: c.angulo, motivo: `melhoria pedida por ${quem}: ${feedback.slice(0, 500)}`, criativo_pai: id, formato: c.formato === "video" ? "video" : "imagem", anuncio_base: c.anuncio_base });
  if (!deps.renderPng) return { ok: true, mensagem: "pedido registrado; a nova versão sai na próxima rodada", novo_criativo: null };
  const r = await rodarCriador(env, 1, { renderPng: deps.renderPng, renderWebm: deps.renderWebm, fetchFn, agora, soPedido: pedido });
  const d = r.detalhes[0];
  return { ok: Boolean(d && d.criativo), mensagem: d ? `${d.status}: ${d.nota}` : "pedido registrado", novo_criativo: d?.criativo ?? null };
}

/** Situação do anúncio na Meta (effective_status) em que ele ainda roda ou vai rodar. */
export const STATUS_EM_CIRCULACAO = ["ACTIVE", "IN_PROCESS", "PENDING_REVIEW", "PREAPPROVED"];

/** Lista dos criativos; status_anuncio vem da coleta (ads_anuncios), null quando a coleta ainda não viu o anúncio. */
export async function listarCriativos(db: D1Database, dias = 30): Promise<Array<Record<string, unknown>>> {
  const de = diaBrt(addDays(new Date(), -(dias - 1)));
  const r = await db.prepare("SELECT id, dia, pedido_id, campanha_id, conjunto_id, angulo, modelo, copy_json, verificacao_json, imagem_chave, creative_id, ad_id, status, resposta, criado_em, publicado_em, feedback, criativo_pai, revisado_por, revisado_em, formato, video_chave, video_id, video_story_chave, anuncio_base, (SELECT a.status FROM ads_anuncios a WHERE a.plataforma = 'meta' AND a.anuncio_id = ads_criativos.ad_id) AS status_anuncio, (SELECT SUM(d.gasto_cents) FROM ads_anuncio_diario d WHERE d.plataforma = 'meta' AND d.anuncio_id = ads_criativos.ad_id) AS res_gasto_cents, (SELECT SUM(d.resultados) FROM ads_anuncio_diario d WHERE d.plataforma = 'meta' AND d.anuncio_id = ads_criativos.ad_id) AS res_cadastros, (SELECT SUM(d.cliques) FROM ads_anuncio_diario d WHERE d.plataforma = 'meta' AND d.anuncio_id = ads_criativos.ad_id) AS res_cliques, (SELECT SUM(d.impressoes) FROM ads_anuncio_diario d WHERE d.plataforma = 'meta' AND d.anuncio_id = ads_criativos.ad_id) AS res_impressoes, (SELECT MAX(d.dia) FROM ads_anuncio_diario d WHERE d.plataforma = 'meta' AND d.anuncio_id = ads_criativos.ad_id) AS res_ate FROM ads_criativos WHERE dia >= ?1 ORDER BY id DESC LIMIT 50").bind(de).all<Record<string, unknown>>();
  return r.results.map((x) => ({ ...x, copy: JSON.parse(String(x.copy_json)), verificacao: x.verificacao_json ? JSON.parse(String(x.verificacao_json)) : null, copy_json: undefined, verificacao_json: undefined }));
}
