/**
 * Escrita na Marketing API da Meta, só o que o Gestor usa: status e orçamento diário de campanha.
 * Precisa de META_ADS_TOKEN com ads_management (o token só de leitura funciona para ler, e a Meta recusa a
 * escrita com HTTP 400/403: o Gestor registra o erro e segue). Em modo ensaio nada é enviado.
 */
import { META_API_VERSAO } from "../meta_versao.ts";

export interface MetaApiEnv {
  META_ADS_TOKEN?: string;
}

export interface MudancaCampanha {
  status?: "ACTIVE" | "PAUSED";
  daily_budget?: number; // centavos
}

export interface RespostaMeta {
  ok: boolean;
  ensaio: boolean;
  status: number;
  texto: string;
}

export async function atualizarCampanhaMeta(env: MetaApiEnv, campanhaId: string, m: MudancaCampanha, ensaio: boolean, fetchFn: typeof fetch = fetch): Promise<RespostaMeta> {
  if (ensaio) return { ok: true, ensaio: true, status: 0, texto: `ensaio: ${JSON.stringify(m)}` };
  if (!env.META_ADS_TOKEN) return { ok: false, ensaio: false, status: 0, texto: "META_ADS_TOKEN não configurado" };
  const corpo = new URLSearchParams();
  if (m.status) corpo.set("status", m.status);
  if (m.daily_budget != null) corpo.set("daily_budget", String(m.daily_budget));
  const res = await fetchFn(`https://graph.facebook.com/${META_API_VERSAO}/${encodeURIComponent(campanhaId)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.META_ADS_TOKEN}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: corpo.toString(),
  });
  const texto = await res.text();
  return { ok: res.ok, ensaio: false, status: res.status, texto: texto.slice(0, 1000) };
}

/** Lê status e orçamento atuais, para o Gestor confirmar antes de mexer. */
export async function lerCampanhaMeta(env: MetaApiEnv, campanhaId: string, fetchFn: typeof fetch = fetch): Promise<{ status: string | null; daily_budget: number | null } | null> {
  if (!env.META_ADS_TOKEN) return null;
  const res = await fetchFn(`https://graph.facebook.com/${META_API_VERSAO}/${encodeURIComponent(campanhaId)}?fields=effective_status,daily_budget`, {
    headers: { authorization: `Bearer ${env.META_ADS_TOKEN}`, accept: "application/json" },
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { effective_status?: string; daily_budget?: string };
  return { status: j.effective_status ?? null, daily_budget: j.daily_budget == null ? null : Number(j.daily_budget) };
}
