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
import { TEMPLATE_ALTURA, TEMPLATE_LARGURA, htmlEscritorio } from "./templates/escritorio.ts";
import { EMPRESA, PALAVRAS_CONTAGEM, PRECO_LINHA as PRECO_CONFIG, PRECO_PERMITIDO } from "../config/negocio.ts";
import { bibliotecaParaModelo, montarBiblioteca } from "./biblioteca.ts";
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
}
export interface Verificacao {
  aprovado: boolean;
  problemas: Array<{ trecho: string; motivo: string }>;
  por: "regras" | "modelo" | "regras+modelo";
}
export interface Pedido {
  id: number;
  dia: string;
  campanha_id: string | null;
  campanha: string | null;
  angulo: string;
  motivo: string;
}

export type RenderPng = (html: string, largura: number, altura: number) => Promise<Uint8Array>;

const ehObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const LIMITES: Record<keyof Copy, number> = { nome: 60, titulo_imagem: 90, promessa: 80, texto_primario: 400, headline: 60, descricao: 40 };

export function lerCopy(v: unknown): Copy | null {
  if (!ehObj(v)) return null;
  const out: Partial<Copy> = {};
  for (const k of Object.keys(LIMITES) as Array<keyof Copy>) {
    const x = v[k];
    if (typeof x !== "string" || !x.trim()) return null;
    out[k] = x.trim().slice(0, LIMITES[k]);
  }
  out.nome = out.nome!.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "Criativo";
  return out as Copy;
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
  const textos = [c.titulo_imagem.replace(/\[\[|\]\]/g, ""), c.promessa, c.texto_primario, c.headline, c.descricao];
  const out: Array<{ trecho: string; motivo: string }> = [];
  for (const t of textos) for (const [re, motivo] of PROIBIDAS) { const m = re.exec(t); if (m) out.push({ trecho: m[0], motivo }); }
  const emojis = (c.texto_primario.match(/\p{Extended_Pictographic}/gu) || []).length;
  if (emojis > 1) out.push({ trecho: `${emojis} emojis`, motivo: "mais de um emoji no texto" });
  if (/\p{Extended_Pictographic}/u.test(c.titulo_imagem + c.promessa)) out.push({ trecho: "emoji na imagem", motivo: "sem emoji na imagem" });
  return out;
}

export async function verificar(env: CriadorEnv, c: Copy, fetchFn: typeof fetch, agora: Date, pagina = ""): Promise<Verificacao> {
  const regras = verificarPorRegras(c);
  if (regras.length) return { aprovado: false, problemas: regras, por: "regras" };
  const r = await chamarLlm<{ aprovado: boolean; problemas: Array<{ trecho: string; motivo: string }> }>(env, {
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
  const problemas = Array.isArray(r.dados.problemas) ? r.dados.problemas.filter((p) => ehObj(p) && typeof p.trecho === "string" && typeof p.motivo === "string").map((p) => ({ trecho: String(p.trecho).slice(0, 200), motivo: String(p.motivo).slice(0, 300) })) : [];
  return { aprovado: r.dados.aprovado && problemas.length === 0, problemas, por: "regras+modelo" };
}

/** O que a conta já aprendeu (anúncios que funcionam e que não) e a página de destino, para o prompt. */
export async function contextoDoCriador(env: CriadorEnv, agora: Date): Promise<{ biblioteca: string; pagina: string }> {
  const [b, paginas] = await Promise.all([montarBiblioteca(env.DB, agora), lerResumos(env.DB)]);
  const destino = paginas.find((x) => x.url === env.CRIADOR_LINK) ?? paginas.find((x) => x.resumo);
  return { biblioteca: bibliotecaParaModelo(b), pagina: paginaParaModelo(destino) };
}

export async function escreverCopy(env: CriadorEnv, p: Pedido, fetchFn: typeof fetch, agora: Date, ctx: { biblioteca: string; pagina: string } = { biblioteca: "", pagina: "" }): Promise<{ copy: Copy; modelo: string } | { erro: string }> {
  const r = await chamarLlm<unknown>(env, {
    agente: "criador",
    modelo: env.LLM_MODELO_CRIADOR || MODELO_CRIADOR_PADRAO,
    modeloReserva: "deepseek/deepseek-v4-pro",
    sistema: `${SISTEMA_CRIADOR}\n\nSOBRE A EMPRESA:\n${PERFIL_NEGOCIO}\n\nPODE AFIRMAR:\n${AFIRMACOES_PERMITIDAS}\n\nPROIBIDO:\n${PROIBIDO}`,
    usuario: [
      `ÂNGULO: ${p.angulo}\nPOR QUÊ: ${p.motivo}\nCAMPANHA: ${p.campanha ?? "—"}\nLinha de preço obrigatória na imagem: "${PRECO_LINHA}".`,
      ctx.pagina,
      ctx.biblioteca ? `O QUE A CONTA JÁ APRENDEU COM OS ANÚNCIOS QUE RODARAM:\n${ctx.biblioteca}` : "",
    ].filter(Boolean).join("\n\n"),
    esquema: ESQUEMA_COPY as unknown as Record<string, unknown>,
    nomeEsquema: "copy_anuncio",
    temperatura: 0.7,
    maxTokens: 2500,
    raciocinio: "low",
  }, fetchFn, agora);
  if (!r.ok) return { erro: r.erro };
  const copy = lerCopy(r.dados);
  return copy ? { copy, modelo: r.modelo } : { erro: "copy fora do esquema" };
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
  const cr = await postMeta(env, `${conta}/adcreatives`, { name: nome, object_story_spec: JSON.stringify(spec), degrees_of_freedom_spec: JSON.stringify({ creative_features_spec: { standard_enhancements: { enroll_status: "OPT_OUT" } } }) }, fetchFn);
  const creativeId = typeof cr.json.id === "string" ? cr.json.id : null;
  if (!cr.ok || !creativeId) return { ok: false, etapa: "criativo", resposta: `HTTP ${cr.status}: ${cr.texto}` };
  const ad = await postMeta(env, `${conta}/ads`, { name: nome, adset_id: env.META_ADSET_CRIADOR_ID!, creative: JSON.stringify({ creative_id: creativeId }), status: "ACTIVE" }, fetchFn);
  const adId = typeof ad.json.id === "string" ? ad.json.id : null;
  if (!ad.ok || !adId) return { ok: false, etapa: "anuncio", resposta: `HTTP ${ad.status}: ${ad.texto}` };
  return { ok: true, imagem_hash: hash, creative_id: creativeId, ad_id: adId };
}

// ---------- rodada ----------

const n = (v: unknown): number => Number(v ?? 0) || 0;

export async function pedidosPendentes(db: D1Database): Promise<Pedido[]> {
  const r = await db.prepare("SELECT id, dia, campanha_id, campanha, angulo, motivo FROM ads_pedidos_criativo WHERE status = 'pendente' ORDER BY id").all<Record<string, unknown>>();
  return r.results.map((x) => ({ id: n(x.id), dia: String(x.dia), campanha_id: x.campanha_id == null ? null : String(x.campanha_id), campanha: x.campanha == null ? null : String(x.campanha), angulo: String(x.angulo), motivo: String(x.motivo) }));
}

export async function registrarPedido(db: D1Database, dia: string, origem: string, p: { plataforma: string; campanha_id: string | null; campanha: string | null; angulo: string; motivo: string }): Promise<number> {
  const existe = await db.prepare("SELECT id FROM ads_pedidos_criativo WHERE dia = ?1 AND status = 'pendente' AND angulo = ?2").bind(dia, p.angulo).first<{ id: number }>();
  if (existe) return Number(existe.id);
  const r = await db.prepare("INSERT INTO ads_pedidos_criativo (dia, origem, plataforma, campanha_id, campanha, angulo, motivo, status, criado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pendente', ?8)").bind(dia, origem, p.plataforma, p.campanha_id, p.campanha, p.angulo.slice(0, 400), p.motivo.slice(0, 600), nowIso()).run();
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

export async function rodarCriador(env: CriadorEnv, nivel: number, deps: { renderPng: RenderPng; fetchFn?: typeof fetch; agora?: Date }): Promise<ResultadoCriador> {
  const fetchFn = deps.fetchFn ?? fetch, agora = deps.agora ?? new Date(), hoje = diaBrt(agora);
  const out: ResultadoCriador = { bloqueado: null, nivel, gerados: 0, reprovados: 0, publicados: 0, erros: 0, detalhes: [] };
  if (nivel < 1) { out.bloqueado = "nível 0: criador só observa"; return out; }
  if (!env.CRIATIVOS) { out.bloqueado = "R2 CRIATIVOS não configurado"; return out; }
  const pendentes = await pedidosPendentes(env.DB);
  for (const p of pendentes) {
    const r = await ritmo(env.DB, hoje, agora);
    if (r.hoje >= CRIADOR_MAX_DIA) { out.detalhes.push({ pedido: p.id, criativo: null, status: "adiado", nota: `limite de ${CRIADOR_MAX_DIA} por dia` }); continue; }
    if (nivel >= 2 && r.dias_desde_ultimo != null && r.dias_desde_ultimo < CRIADOR_INTERVALO_DIAS) { out.detalhes.push({ pedido: p.id, criativo: null, status: "adiado", nota: `último publicado há ${r.dias_desde_ultimo} dias (mínimo ${CRIADOR_INTERVALO_DIAS})` }); continue; }
    // pedido velho (mais de 7 dias) expira sem gerar
    if (diaBrt(addDays(agora, -7)) > p.dia) { await env.DB.prepare("UPDATE ads_pedidos_criativo SET status = 'expirado' WHERE id = ?1").bind(p.id).run(); out.detalhes.push({ pedido: p.id, criativo: null, status: "expirado", nota: "pedido com mais de 7 dias" }); continue; }

    const ctx = await contextoDoCriador(env, agora);
    const esc = await escreverCopy(env, p, fetchFn, agora, ctx);
    if ("erro" in esc) { out.erros += 1; out.detalhes.push({ pedido: p.id, criativo: null, status: "erro", nota: esc.erro }); continue; }
    const ver = await verificar(env, esc.copy, fetchFn, agora, ctx.pagina);
    const ins = await env.DB
      .prepare("INSERT INTO ads_criativos (dia, pedido_id, plataforma, campanha_id, conjunto_id, angulo, modelo, copy_json, verificacao_json, status, criado_em) VALUES (?1, ?2, 'meta', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)")
      .bind(hoje, p.id, p.campanha_id, env.META_ADSET_CRIADOR_ID ?? null, p.angulo, esc.modelo, JSON.stringify(esc.copy), JSON.stringify(ver), ver.aprovado ? "sombra" : "reprovado", nowIso())
      .run();
    const id = Number(ins.meta.last_row_id);
    if (!ver.aprovado) {
      out.reprovados += 1;
      await env.DB.prepare("UPDATE ads_pedidos_criativo SET status = 'recusado', criativo_id = ?2, recusa = ?3 WHERE id = ?1").bind(p.id, id, ver.problemas.map((x) => x.motivo).join("; ").slice(0, 400)).run();
      out.detalhes.push({ pedido: p.id, criativo: id, status: "reprovado", nota: ver.problemas.map((x) => `${x.trecho}: ${x.motivo}`).join(" · ").slice(0, 300) });
      continue;
    }
    let png: Uint8Array;
    try {
      png = await deps.renderPng(htmlEscritorio({ titulo_imagem: esc.copy.titulo_imagem, promessa: esc.copy.promessa, preco: PRECO_LINHA }), TEMPLATE_LARGURA, TEMPLATE_ALTURA);
      const chave = `criativos/${id}.png`;
      await env.CRIATIVOS.put(chave, png, { httpMetadata: { contentType: "image/png" } });
      await env.DB.prepare("UPDATE ads_criativos SET imagem_chave = ?2 WHERE id = ?1").bind(id, chave).run();
    } catch (e) {
      out.erros += 1;
      await env.DB.prepare("UPDATE ads_criativos SET status = 'erro', resposta = ?2 WHERE id = ?1").bind(id, `render: ${String(e)}`.slice(0, 1000)).run();
      out.detalhes.push({ pedido: p.id, criativo: id, status: "erro", nota: `render: ${String(e)}` });
      continue;
    }
    out.gerados += 1;
    await env.DB.prepare("UPDATE ads_pedidos_criativo SET status = 'atendido', criativo_id = ?2 WHERE id = ?1").bind(p.id, id).run();
    if (nivel < 2) { out.detalhes.push({ pedido: p.id, criativo: id, status: "sombra", nota: "gerado e guardado; nível 1 não publica" }); continue; }
    const falta = metaPublicacaoConfigurada(env);
    if (falta) { out.detalhes.push({ pedido: p.id, criativo: id, status: "sombra", nota: `publicação desligada: falta ${falta}` }); continue; }
    const nome = `${esc.copy.nome}_${hoje.replace(/-/g, "")}_ia`;
    const pub = await publicarNaMeta(env, esc.copy, png, nome, fetchFn);
    if (!pub.ok) {
      out.erros += 1;
      await env.DB.prepare("UPDATE ads_criativos SET status = 'erro', resposta = ?2 WHERE id = ?1").bind(id, `${pub.etapa}: ${pub.resposta}`).run();
      out.detalhes.push({ pedido: p.id, criativo: id, status: "erro", nota: `${pub.etapa}: ${pub.resposta.slice(0, 200)}` });
      continue;
    }
    out.publicados += 1;
    await env.DB.prepare("UPDATE ads_criativos SET status = 'publicado', imagem_hash = ?2, creative_id = ?3, ad_id = ?4, resposta = 'ok', publicado_em = ?5 WHERE id = ?1").bind(id, pub.imagem_hash, pub.creative_id, pub.ad_id, nowIso()).run();
    out.detalhes.push({ pedido: p.id, criativo: id, status: "publicado", nota: `anúncio ${pub.ad_id} no conjunto ${env.META_ADSET_CRIADOR_ID}` });
  }
  return out;
}

export async function listarCriativos(db: D1Database, dias = 30): Promise<Array<Record<string, unknown>>> {
  const de = diaBrt(addDays(new Date(), -(dias - 1)));
  const r = await db.prepare("SELECT id, dia, pedido_id, campanha_id, conjunto_id, angulo, modelo, copy_json, verificacao_json, imagem_chave, creative_id, ad_id, status, resposta, criado_em, publicado_em FROM ads_criativos WHERE dia >= ?1 ORDER BY id DESC LIMIT 50").bind(de).all<Record<string, unknown>>();
  return r.results.map((x) => ({ ...x, copy: JSON.parse(String(x.copy_json)), verificacao: x.verificacao_json ? JSON.parse(String(x.verificacao_json)) : null, copy_json: undefined, verificacao_json: undefined }));
}
