/**
 * Gasto diário dos anúncios, por campanha, gravado em ads_gasto_diario. Só leitura nas plataformas: nada aqui cria,
 * muda ou pausa anúncio.
 *
 *   Meta    Marketing API: insights (nível campanha, um dia por linha) em ads_gasto_diario, a lista de campanhas
 *           (status e orçamento diário) em ads_campanhas e, por anúncio, o texto do criativo (ads_anuncios) e o
 *           gasto diário (ads_anuncio_diario), que alimentam a biblioteca do Criador. Precisa do segredo META_ADS_TOKEN (token de
 *           usuário do sistema com ads_read; o META_CAPI_TOKEN não serve) e de META_AD_ACCOUNT_ID.
 *   Google  ainda não: a conta está sem gasto e a leitura pela API própria ainda não foi validada no Worker.
 *
 * O cron relê os últimos dias a cada passada, porque as plataformas revisam o gasto depois do fato; a chave
 * (dia, plataforma, campanha) faz a regravação ser segura.
 */
import { META_API_VERSAO } from "./meta_versao.ts";
import { BRT_OFFSET_MS, addDays, nowIso } from "./util.ts";

export interface AnunciosEnv {
  DB: D1Database;
  META_ADS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
}

export interface Campanha {
  plataforma: "meta" | "google";
  campanha_id: string;
  campanha: string;
  status: string;
  orcamento_diario_cents: number | null;
  objetivo: string | null;
}

export interface LinhaGasto {
  dia: string;
  plataforma: "meta" | "google";
  campanha_id: string;
  campanha: string;
  gasto_cents: number;
  impressoes: number;
  cliques: number;
  resultados: number;
}

/** Quantos dias para trás cada passada relê. */
export const GASTO_JANELA_DIAS = 7;
const TIPOS_CADASTRO = new Set(["offsite_conversion.fb_pixel_lead", "lead", "onsite_conversion.lead_grouped"]);

export function metaGastoAtivo(env: AnunciosEnv): boolean {
  return Boolean(env.META_ADS_TOKEN && env.META_AD_ACCOUNT_ID);
}

const inteiro = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/** Linhas da resposta de /insights (nível campanha, time_increment=1) no formato da tabela. */
export function linhasDaMeta(pagina: unknown): LinhaGasto[] {
  const dados = (pagina as { data?: unknown }).data;
  if (!Array.isArray(dados)) return [];
  const out: LinhaGasto[] = [];
  for (const r of dados as Array<Record<string, unknown>>) {
    const dia = typeof r.date_start === "string" ? r.date_start : null;
    const id = typeof r.campaign_id === "string" ? r.campaign_id : null;
    if (!dia || !id) continue;
    const acoes = Array.isArray(r.actions) ? (r.actions as Array<{ action_type?: string; value?: string }>) : [];
    // "lead" e "offsite_conversion.fb_pixel_lead" podem aparecer juntos para o mesmo cadastro: fica o maior.
    const cadastros = acoes.filter((a) => a.action_type && TIPOS_CADASTRO.has(a.action_type)).reduce((m, a) => Math.max(m, inteiro(a.value)), 0);
    out.push({
      dia,
      plataforma: "meta",
      campanha_id: id,
      campanha: typeof r.campaign_name === "string" ? r.campaign_name : id,
      gasto_cents: Math.round(Number(r.spend ?? 0) * 100) || 0,
      impressoes: inteiro(r.impressions),
      cliques: inteiro(r.inline_link_clicks),
      resultados: cadastros,
    });
  }
  return out;
}

export async function coletarMeta(env: AnunciosEnv, de: string, ate: string, fetchFn: typeof fetch = fetch): Promise<LinhaGasto[]> {
  const q = new URLSearchParams({
    level: "campaign",
    time_increment: "1",
    fields: "campaign_id,campaign_name,spend,impressions,inline_link_clicks,actions",
    time_range: JSON.stringify({ since: de, until: ate }),
    limit: "500",
  });
  let url: string | null = `https://graph.facebook.com/${META_API_VERSAO}/act_${env.META_AD_ACCOUNT_ID}/insights?${q}`;
  const linhas: LinhaGasto[] = [];
  for (let paginas = 0; url && paginas < 20; paginas++) {
    const res: Response = await fetchFn(url, { headers: { authorization: `Bearer ${env.META_ADS_TOKEN}`, accept: "application/json" } });
    const texto = await res.text();
    if (!res.ok) throw new Error(`Meta insights HTTP ${res.status}: ${texto.slice(0, 300)}`);
    const j = JSON.parse(texto) as { paging?: { next?: string } };
    linhas.push(...linhasDaMeta(j));
    url = j.paging?.next ?? null;
  }
  return linhas;
}

export async function gravarGasto(db: D1Database, linhas: LinhaGasto[]): Promise<number> {
  const agora = nowIso();
  for (const l of linhas) {
    await db
      .prepare(
        `INSERT INTO ads_gasto_diario (dia, plataforma, campanha_id, campanha, gasto_cents, impressoes, cliques, resultados, atualizado_em)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (dia, plataforma, campanha_id) DO UPDATE SET campanha = excluded.campanha, gasto_cents = excluded.gasto_cents,
           impressoes = excluded.impressoes, cliques = excluded.cliques, resultados = excluded.resultados, atualizado_em = excluded.atualizado_em`,
      )
      .bind(l.dia, l.plataforma, l.campanha_id, l.campanha, l.gasto_cents, l.impressoes, l.cliques, l.resultados, agora)
      .run();
  }
  return linhas.length;
}

/** Campanhas da conta com status e orçamento diário (a Meta devolve o orçamento em centavos, como string). */
export function campanhasDaMeta(pagina: unknown): Campanha[] {
  const dados = (pagina as { data?: unknown }).data;
  if (!Array.isArray(dados)) return [];
  const out: Campanha[] = [];
  for (const r of dados as Array<Record<string, unknown>>) {
    const id = typeof r.id === "string" ? r.id : null;
    if (!id) continue;
    const orc = r.daily_budget == null ? null : inteiro(r.daily_budget);
    out.push({
      plataforma: "meta",
      campanha_id: id,
      campanha: typeof r.name === "string" ? r.name : id,
      status: typeof r.effective_status === "string" ? r.effective_status : "DESCONHECIDO",
      orcamento_diario_cents: orc && orc > 0 ? orc : null,
      objetivo: typeof r.objective === "string" ? r.objective : null,
    });
  }
  return out;
}

export async function coletarCampanhasMeta(env: AnunciosEnv, fetchFn: typeof fetch = fetch): Promise<Campanha[]> {
  const q = new URLSearchParams({ fields: "id,name,effective_status,daily_budget,objective", limit: "200" });
  let url: string | null = `https://graph.facebook.com/${META_API_VERSAO}/act_${env.META_AD_ACCOUNT_ID}/campaigns?${q}`;
  const out: Campanha[] = [];
  for (let paginas = 0; url && paginas < 10; paginas++) {
    const res: Response = await fetchFn(url, { headers: { authorization: `Bearer ${env.META_ADS_TOKEN}`, accept: "application/json" } });
    const texto = await res.text();
    if (!res.ok) throw new Error(`Meta campaigns HTTP ${res.status}: ${texto.slice(0, 300)}`);
    const j = JSON.parse(texto) as { paging?: { next?: string } };
    out.push(...campanhasDaMeta(j));
    url = j.paging?.next ?? null;
  }
  return out;
}

export async function gravarCampanhas(db: D1Database, campanhas: Campanha[]): Promise<number> {
  const agora = nowIso();
  for (const c of campanhas) {
    await db
      .prepare(
        `INSERT INTO ads_campanhas (plataforma, campanha_id, campanha, status, orcamento_diario_cents, objetivo, atualizado_em)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (plataforma, campanha_id) DO UPDATE SET campanha = excluded.campanha, status = excluded.status,
           orcamento_diario_cents = excluded.orcamento_diario_cents, objetivo = excluded.objetivo, atualizado_em = excluded.atualizado_em`,
      )
      .bind(c.plataforma, c.campanha_id, c.campanha, c.status, c.orcamento_diario_cents, c.objetivo, agora)
      .run();
  }
  return campanhas.length;
}

// ---------- anúncios: texto do criativo e gasto por dia ----------

export interface Anuncio {
  plataforma: "meta";
  anuncio_id: string;
  anuncio: string;
  campanha_id: string | null;
  conjunto_id: string | null;
  status: string | null;
  creative_id: string | null;
  titulo: string | null;
  texto: string | null;
  descricao: string | null;
  imagem_url: string | null;
}

export interface LinhaAnuncio {
  dia: string;
  plataforma: "meta";
  anuncio_id: string;
  gasto_cents: number;
  impressoes: number;
  cliques: number;
  resultados: number;
}

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 2000) : null);

/** Anúncios da conta com o criativo expandido; o texto vem de body/title ou, para posts, do object_story_spec. */
export function anunciosDaMeta(pagina: unknown): Anuncio[] {
  const dados = (pagina as { data?: unknown }).data;
  if (!Array.isArray(dados)) return [];
  const out: Anuncio[] = [];
  for (const r of dados as Array<Record<string, unknown>>) {
    const id = typeof r.id === "string" ? r.id : null;
    if (!id) continue;
    const c = (r.creative ?? {}) as Record<string, unknown>;
    const spec = (c.object_story_spec ?? {}) as { link_data?: Record<string, unknown>; video_data?: Record<string, unknown> };
    const ld = spec.link_data ?? spec.video_data ?? {};
    out.push({
      plataforma: "meta",
      anuncio_id: id,
      anuncio: typeof r.name === "string" ? r.name : id,
      campanha_id: typeof r.campaign_id === "string" ? r.campaign_id : null,
      conjunto_id: typeof r.adset_id === "string" ? r.adset_id : null,
      status: typeof r.effective_status === "string" ? r.effective_status : null,
      creative_id: typeof c.id === "string" ? c.id : null,
      titulo: texto(c.title) ?? texto(ld.name) ?? texto(ld.title),
      texto: texto(c.body) ?? texto(ld.message),
      descricao: texto(ld.description),
      imagem_url: texto(c.image_url) ?? texto(c.thumbnail_url),
    });
  }
  return out;
}

export async function coletarAnunciosMeta(env: AnunciosEnv, fetchFn: typeof fetch = fetch): Promise<Anuncio[]> {
  const q = new URLSearchParams({ fields: "id,name,effective_status,campaign_id,adset_id,creative{id,title,body,image_url,thumbnail_url,object_story_spec}", limit: "200" });
  let url: string | null = `https://graph.facebook.com/${META_API_VERSAO}/act_${env.META_AD_ACCOUNT_ID}/ads?${q}`;
  const out: Anuncio[] = [];
  for (let paginas = 0; url && paginas < 10; paginas++) {
    const res: Response = await fetchFn(url, { headers: { authorization: `Bearer ${env.META_ADS_TOKEN}`, accept: "application/json" } });
    const t = await res.text();
    if (!res.ok) throw new Error(`Meta ads HTTP ${res.status}: ${t.slice(0, 300)}`);
    const j = JSON.parse(t) as { paging?: { next?: string } };
    out.push(...anunciosDaMeta(j));
    url = j.paging?.next ?? null;
  }
  return out;
}

export function linhasAnuncioDaMeta(pagina: unknown): LinhaAnuncio[] {
  const dados = (pagina as { data?: unknown }).data;
  if (!Array.isArray(dados)) return [];
  const out: LinhaAnuncio[] = [];
  for (const r of dados as Array<Record<string, unknown>>) {
    const dia = typeof r.date_start === "string" ? r.date_start : null;
    const id = typeof r.ad_id === "string" ? r.ad_id : null;
    if (!dia || !id) continue;
    const acoes = Array.isArray(r.actions) ? (r.actions as Array<{ action_type?: string; value?: string }>) : [];
    const cadastros = acoes.filter((a) => a.action_type && TIPOS_CADASTRO.has(a.action_type)).reduce((m, a) => Math.max(m, inteiro(a.value)), 0);
    out.push({ dia, plataforma: "meta", anuncio_id: id, gasto_cents: Math.round(Number(r.spend ?? 0) * 100) || 0, impressoes: inteiro(r.impressions), cliques: inteiro(r.inline_link_clicks), resultados: cadastros });
  }
  return out;
}

export async function coletarAnuncioDiarioMeta(env: AnunciosEnv, de: string, ate: string, fetchFn: typeof fetch = fetch): Promise<LinhaAnuncio[]> {
  const q = new URLSearchParams({ level: "ad", time_increment: "1", fields: "ad_id,spend,impressions,inline_link_clicks,actions", time_range: JSON.stringify({ since: de, until: ate }), limit: "500" });
  let url: string | null = `https://graph.facebook.com/${META_API_VERSAO}/act_${env.META_AD_ACCOUNT_ID}/insights?${q}`;
  const out: LinhaAnuncio[] = [];
  for (let paginas = 0; url && paginas < 20; paginas++) {
    const res: Response = await fetchFn(url, { headers: { authorization: `Bearer ${env.META_ADS_TOKEN}`, accept: "application/json" } });
    const t = await res.text();
    if (!res.ok) throw new Error(`Meta insights (ad) HTTP ${res.status}: ${t.slice(0, 300)}`);
    const j = JSON.parse(t) as { paging?: { next?: string } };
    out.push(...linhasAnuncioDaMeta(j));
    url = j.paging?.next ?? null;
  }
  return out;
}

export async function gravarAnuncios(db: D1Database, anuncios: Anuncio[], linhas: LinhaAnuncio[]): Promise<{ anuncios: number; linhas: number }> {
  const agora = nowIso();
  for (const a of anuncios) {
    await db
      .prepare(
        `INSERT INTO ads_anuncios (plataforma, anuncio_id, anuncio, campanha_id, conjunto_id, status, creative_id, titulo, texto, descricao, imagem_url, atualizado_em)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT (plataforma, anuncio_id) DO UPDATE SET anuncio = excluded.anuncio, campanha_id = excluded.campanha_id, conjunto_id = excluded.conjunto_id, status = excluded.status,
           creative_id = excluded.creative_id, titulo = COALESCE(excluded.titulo, ads_anuncios.titulo), texto = COALESCE(excluded.texto, ads_anuncios.texto),
           descricao = COALESCE(excluded.descricao, ads_anuncios.descricao), imagem_url = COALESCE(excluded.imagem_url, ads_anuncios.imagem_url), atualizado_em = excluded.atualizado_em`,
      )
      .bind(a.plataforma, a.anuncio_id, a.anuncio, a.campanha_id, a.conjunto_id, a.status, a.creative_id, a.titulo, a.texto, a.descricao, a.imagem_url, agora)
      .run();
  }
  for (const l of linhas) {
    await db
      .prepare(
        `INSERT INTO ads_anuncio_diario (dia, plataforma, anuncio_id, gasto_cents, impressoes, cliques, resultados, atualizado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (dia, plataforma, anuncio_id) DO UPDATE SET gasto_cents = excluded.gasto_cents, impressoes = excluded.impressoes, cliques = excluded.cliques, resultados = excluded.resultados, atualizado_em = excluded.atualizado_em`,
      )
      .bind(l.dia, l.plataforma, l.anuncio_id, l.gasto_cents, l.impressoes, l.cliques, l.resultados, agora)
      .run();
  }
  return { anuncios: anuncios.length, linhas: linhas.length };
}

export const diaBrt = (d: Date): string => new Date(d.getTime() + BRT_OFFSET_MS).toISOString().slice(0, 10);

/** Uma passada: relê os últimos GASTO_JANELA_DIAS dias de cada plataforma ligada. Erro de uma não derruba a outra. */
export async function varrerGasto(
  env: AnunciosEnv,
  fetchFn: typeof fetch = fetch,
  agora = new Date(),
  dias = GASTO_JANELA_DIAS,
): Promise<{ meta: { linhas: number; campanhas: number; anuncios?: number; linhas_anuncio?: number; erro_anuncios?: string } | { erro: string } | null }> {
  const ate = diaBrt(agora);
  const de = diaBrt(addDays(agora, -(dias - 1)));
  const out: { meta: { linhas: number; campanhas: number; anuncios?: number; linhas_anuncio?: number; erro_anuncios?: string } | { erro: string } | null } = { meta: null };
  if (metaGastoAtivo(env)) {
    try {
      const linhas = await gravarGasto(env.DB, await coletarMeta(env, de, ate, fetchFn));
      const campanhas = await gravarCampanhas(env.DB, await coletarCampanhasMeta(env, fetchFn));
      out.meta = { linhas, campanhas };
      // por anúncio: texto do criativo e gasto diário (falha aqui não derruba a coleta por campanha)
      try {
        const r = await gravarAnuncios(env.DB, await coletarAnunciosMeta(env, fetchFn), await coletarAnuncioDiarioMeta(env, de, ate, fetchFn));
        out.meta.anuncios = r.anuncios;
        out.meta.linhas_anuncio = r.linhas;
      } catch (e) {
        out.meta.erro_anuncios = String(e);
      }
    } catch (e) {
      out.meta = { erro: String(e) };
    }
  }
  return out;
}

/** Totais por mês e as últimas linhas, para conferir na rota /admin/anuncios. */
export async function resumoGasto(db: D1Database): Promise<Record<string, unknown>> {
  const meses = await db
    .prepare(
      `SELECT substr(dia, 1, 7) AS mes, plataforma, SUM(gasto_cents) AS gasto_cents, SUM(resultados) AS resultados, COUNT(DISTINCT dia) AS dias
       FROM ads_gasto_diario GROUP BY 1, 2 ORDER BY 1 DESC, 2 LIMIT 24`,
    )
    .all();
  const ultimo = await db.prepare("SELECT MAX(dia) AS dia, MAX(atualizado_em) AS atualizado_em FROM ads_gasto_diario").first();
  return { meses: meses.results, ultimo };
}
