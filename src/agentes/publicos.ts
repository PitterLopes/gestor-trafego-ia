/**
 * Públicos: as listas que um gestor de tráfego montaria à mão toda semana, geradas do pagamento e enviadas à
 * Meta como públicos personalizados (e-mail e telefone em SHA-256), mais um semelhante a partir dos fiéis.
 *
 *   clientes_fieis         pagaram 2+ vezes (e, se o produto tem times, 3+ atendentes): a semente do semelhante
 *   sairam_cedo            cancelaram com no máximo 2 pagamentos (exclusão)
 *   entraram_nao_pagaram   criaram conta no pagamento nos últimos 90 dias e nunca pagaram (remarketing)
 *   semelhante_fieis       lookalike 5% Brasil a partir de clientes_fieis (criado uma vez)
 *
 * Nível 1: calcula e registra as contagens. Nível 2: cria/atualiza os públicos na Meta. A Meta exige que a conta
 * tenha aceitado os termos de públicos personalizados; se recusar, o erro fica registrado e vira alerta.
 */
import { META_API_VERSAO } from "../meta_versao.ts";
import { nowIso, sha256Hex } from "../util.ts";

export const PUBLICOS = ["clientes_fieis", "sairam_cedo", "entraram_nao_pagaram"] as const;
export type NomePublico = (typeof PUBLICOS)[number];
export const SEMELHANTE_RATIO = 0.05;
export const LOTE = 500;

export interface PublicosEnv {
  DB: D1Database;
  META_ADS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
}

export interface Pessoa {
  email: string | null;
  telefone: string | null;
}

import { lista as listaPagamento } from "../fontes/pagamento.ts";
import { EMPRESA } from "../config/negocio.ts";

export function normEmail(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
}
export function normTelefone(v: unknown): string | null {
  const d = typeof v === "string" ? v.replace(/\D/g, "") : "";
  if (d.length < 10) return null;
  return d.startsWith("55") && d.length >= 12 ? d : `55${d}`;
}

export async function listar(db: D1Database, nome: NomePublico, agora = new Date()): Promise<Pessoa[]> {
  const linhas = await listaPagamento(db, nome, agora);
  const vistos = new Set<string>();
  const out: Pessoa[] = [];
  for (const x of linhas) {
    const p = { email: normEmail(x.email), telefone: normTelefone(x.telefone) };
    if (!p.email && !p.telefone) continue;
    const chave = `${p.email ?? ""}|${p.telefone ?? ""}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    out.push(p);
  }
  return out;
}

async function postMeta(env: PublicosEnv, caminho: string, corpo: Record<string, string>, fetchFn: typeof fetch): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; texto: string }> {
  const res = await fetchFn(`https://graph.facebook.com/${META_API_VERSAO}/${caminho}`, { method: "POST", headers: { authorization: `Bearer ${env.META_ADS_TOKEN}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(corpo).toString() });
  const texto = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(texto) as Record<string, unknown>; } catch { json = {}; }
  return { ok: res.ok, status: res.status, json, texto: texto.slice(0, 600) };
}

async function registrar(db: D1Database, nome: string, tipo: string, campos: { publico_id?: string | null; pessoas?: number | null; resposta?: string | null }): Promise<void> {
  await db
    .prepare("INSERT INTO ads_publicos (nome, plataforma, publico_id, tipo, pessoas, resposta, atualizado_em) VALUES (?1, 'meta', ?2, ?3, ?4, ?5, ?6) ON CONFLICT (nome) DO UPDATE SET publico_id = COALESCE(excluded.publico_id, ads_publicos.publico_id), pessoas = COALESCE(excluded.pessoas, ads_publicos.pessoas), resposta = excluded.resposta, atualizado_em = excluded.atualizado_em")
    .bind(nome, campos.publico_id ?? null, tipo, campos.pessoas ?? null, campos.resposta ?? null, nowIso())
    .run();
}

async function idExistente(db: D1Database, nome: string): Promise<string | null> {
  const r = await db.prepare("SELECT publico_id FROM ads_publicos WHERE nome = ?1").bind(nome).first<{ publico_id: string | null }>();
  return r?.publico_id ?? null;
}

const ROTULO: Record<NomePublico, string> = { clientes_fieis: "Clientes fiéis (pagamento)", sairam_cedo: "Saíram cedo (pagamento)", entraram_nao_pagaram: "Entraram e não pagaram (pagamento)" };

/** Cria o público (uma vez) e envia as pessoas em lotes, com hash. Devolve o id ou o erro. */
export async function sincronizarPublico(env: PublicosEnv, nome: NomePublico, pessoas: Pessoa[], fetchFn: typeof fetch): Promise<{ ok: boolean; publico_id: string | null; resposta: string }> {
  const conta = `act_${env.META_AD_ACCOUNT_ID}`;
  let id = await idExistente(env.DB, nome);
  if (!id) {
    const r = await postMeta(env, `${conta}/customaudiences`, { name: ROTULO[nome], subtype: "CUSTOM", customer_file_source: "USER_PROVIDED_ONLY", description: `Gerado pelo time de tráfego de ${EMPRESA} a partir do pagamento` }, fetchFn);
    if (!r.ok || typeof r.json.id !== "string") return { ok: false, publico_id: null, resposta: `criar: HTTP ${r.status}: ${r.texto}` };
    id = r.json.id;
    await registrar(env.DB, nome, "lista", { publico_id: id });
  }
  const linhas: string[][] = [];
  for (const p of pessoas) linhas.push([p.email ? await sha256Hex(p.email) : "", p.telefone ? await sha256Hex(p.telefone) : ""]);
  for (let i = 0; i < linhas.length; i += LOTE) {
    const r = await postMeta(env, `${id}/users`, { payload: JSON.stringify({ schema: ["EMAIL", "PHONE"], data: linhas.slice(i, i + LOTE) }) }, fetchFn);
    if (!r.ok) return { ok: false, publico_id: id, resposta: `enviar lote ${i / LOTE + 1}: HTTP ${r.status}: ${r.texto}` };
  }
  return { ok: true, publico_id: id, resposta: `ok: ${pessoas.length} pessoas em ${Math.ceil(linhas.length / LOTE)} lote(s)` };
}

export async function criarSemelhante(env: PublicosEnv, origemId: string, fetchFn: typeof fetch): Promise<{ ok: boolean; publico_id: string | null; resposta: string }> {
  const existente = await idExistente(env.DB, "semelhante_fieis");
  if (existente) return { ok: true, publico_id: existente, resposta: "já existe" };
  const r = await postMeta(env, `act_${env.META_AD_ACCOUNT_ID}/customaudiences`, { name: `Semelhante ${Math.round(SEMELHANTE_RATIO * 100)}% · clientes fiéis`, subtype: "LOOKALIKE", origin_audience_id: origemId, lookalike_spec: JSON.stringify({ country: "BR", ratio: SEMELHANTE_RATIO, type: "similarity" }) }, fetchFn);
  if (!r.ok || typeof r.json.id !== "string") return { ok: false, publico_id: null, resposta: `semelhante: HTTP ${r.status}: ${r.texto}` };
  await registrar(env.DB, "semelhante_fieis", "semelhante", { publico_id: r.json.id, resposta: "criado" });
  return { ok: true, publico_id: r.json.id, resposta: "criado" };
}

export interface ResultadoPublicos {
  nivel: number;
  listas: Array<{ nome: string; pessoas: number; publico_id: string | null; resposta: string }>;
  semelhante: { publico_id: string | null; resposta: string } | null;
  erros: number;
}

export async function rodarPublicos(env: PublicosEnv, nivel: number, fetchFn: typeof fetch = fetch, agora = new Date()): Promise<ResultadoPublicos> {
  const out: ResultadoPublicos = { nivel, listas: [], semelhante: null, erros: 0 };
  const podeEnviar = nivel >= 2 && Boolean(env.META_ADS_TOKEN && env.META_AD_ACCOUNT_ID);
  let idFieis: string | null = null;
  for (const nome of PUBLICOS) {
    const pessoas = await listar(env.DB, nome, agora);
    if (!podeEnviar) {
      await registrar(env.DB, nome, "lista", { pessoas: pessoas.length, resposta: nivel >= 2 ? "sem token da Meta" : `nível ${nivel}: só contagem` });
      out.listas.push({ nome, pessoas: pessoas.length, publico_id: await idExistente(env.DB, nome), resposta: nivel >= 2 ? "sem token da Meta" : "só contagem" });
      continue;
    }
    if (pessoas.length < 100 && nome === "clientes_fieis") {
      await registrar(env.DB, nome, "lista", { pessoas: pessoas.length, resposta: "menos de 100 pessoas: a Meta exige pelo menos 100 para semelhante; lista não enviada" });
      out.listas.push({ nome, pessoas: pessoas.length, publico_id: null, resposta: "menos de 100 pessoas" });
      continue;
    }
    const r = await sincronizarPublico(env, nome, pessoas, fetchFn);
    await registrar(env.DB, nome, "lista", { publico_id: r.publico_id, pessoas: pessoas.length, resposta: r.resposta });
    if (!r.ok) out.erros += 1;
    if (nome === "clientes_fieis" && r.ok) idFieis = r.publico_id;
    out.listas.push({ nome, pessoas: pessoas.length, publico_id: r.publico_id, resposta: r.resposta });
  }
  if (podeEnviar && idFieis) {
    const s = await criarSemelhante(env, idFieis, fetchFn);
    if (!s.ok) out.erros += 1;
    out.semelhante = { publico_id: s.publico_id, resposta: s.resposta };
  }
  return out;
}

export async function listarPublicos(db: D1Database): Promise<Array<Record<string, unknown>>> {
  return (await db.prepare("SELECT nome, plataforma, publico_id, tipo, pessoas, resposta, atualizado_em FROM ads_publicos ORDER BY nome").all()).results;
}
