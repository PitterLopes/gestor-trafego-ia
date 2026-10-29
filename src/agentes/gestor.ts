/**
 * Gestor: o único agente que escreve nas plataformas. Pega a fila ads_acoes (pendente), confere os freios de
 * novo na hora de executar (botão de parar, nível, frequência, teto), executa, grava o baseline e marca para
 * revisão em 3 dias. Na revisão, se o custo por cadastro da campanha piorou mais de REVERSAO_PIORA_PCT em
 * relação ao baseline, enfileira e executa a ação inversa (origem "reversao").
 *
 *   nível do gestor 0 ou 1  → nada é enviado; as pendentes viram "ensaio" (registradas, não executadas)
 *   nível 2                 → executa de verdade (precisa de META_ADS_TOKEN com ads_management)
 *   parado (gestor ou todos) → não faz nada e diz por quê
 */
import { FREQUENCIA_DIAS, TETO_DIARIO_CENTS, lerCampanhas } from "../analista.ts";
import { diaBrt } from "../anuncios.ts";
import { addDays, nowIso } from "../util.ts";
import { atualizarCampanhaMeta } from "./meta_api.ts";
import type { MetaApiEnv } from "./meta_api.ts";

export const REVISAR_EM_DIAS = 3;
export const REVERSAO_PIORA_PCT = 30;

export interface GestorEnv extends MetaApiEnv {
  DB: D1Database;
}

export interface EstadoAgente {
  nivel: number;
  parado: boolean;
}

export async function lerEstado(db: D1Database): Promise<Record<string, EstadoAgente>> {
  const r = await db.prepare("SELECT agente, nivel, parado FROM agentes_estado").all<{ agente: string; nivel: number; parado: number }>();
  const out: Record<string, EstadoAgente> = {};
  for (const x of r.results) out[x.agente] = { nivel: Number(x.nivel), parado: Boolean(x.parado) };
  return out;
}

export async function gravarEstado(db: D1Database, agente: string, nivel: number | null, parado: boolean | null, por: string): Promise<void> {
  const atual = (await lerEstado(db))[agente] ?? { nivel: 0, parado: false };
  await db
    .prepare("INSERT INTO agentes_estado (agente, nivel, parado, atualizado_em, atualizado_por) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (agente) DO UPDATE SET nivel = excluded.nivel, parado = excluded.parado, atualizado_em = excluded.atualizado_em, atualizado_por = excluded.atualizado_por")
    .bind(agente, nivel ?? atual.nivel, (parado ?? atual.parado) ? 1 : 0, nowIso(), por)
    .run();
}

/** Pode rodar? Devolve o motivo quando não. */
export function bloqueio(estado: Record<string, EstadoAgente>, agente: string): string | null {
  if (estado.todos?.parado) return "parado: botão geral";
  if (estado[agente]?.parado) return `parado: ${agente}`;
  return null;
}

interface Acao {
  id: number;
  dia: string;
  origem: string;
  plataforma: string;
  alvo_id: string;
  alvo_nome: string | null;
  tipo: string;
  valor_cents: number | null;
  valor_anterior_cents: number | null;
  motivo: string;
}

const n = (v: unknown): number => Number(v ?? 0) || 0;

async function pendentes(db: D1Database): Promise<Acao[]> {
  const r = await db.prepare("SELECT id, dia, origem, plataforma, alvo_id, alvo_nome, tipo, valor_cents, valor_anterior_cents, motivo FROM ads_acoes WHERE status = 'pendente' ORDER BY id").all<Record<string, unknown>>();
  return r.results.map((x) => ({ id: n(x.id), dia: String(x.dia), origem: String(x.origem), plataforma: String(x.plataforma), alvo_id: String(x.alvo_id), alvo_nome: x.alvo_nome == null ? null : String(x.alvo_nome), tipo: String(x.tipo), valor_cents: x.valor_cents == null ? null : n(x.valor_cents), valor_anterior_cents: x.valor_anterior_cents == null ? null : n(x.valor_anterior_cents), motivo: String(x.motivo) }));
}

async function marcar(db: D1Database, id: number, status: string, campos: { recusa?: string | null; resposta?: string | null; baseline_json?: string | null; executada_em?: string | null; revisar_em?: string | null; revertida_por?: number | null }): Promise<void> {
  await db
    .prepare("UPDATE ads_acoes SET status = ?2, recusa = COALESCE(?3, recusa), resposta = COALESCE(?4, resposta), baseline_json = COALESCE(?5, baseline_json), executada_em = COALESCE(?6, executada_em), revisar_em = COALESCE(?7, revisar_em), revertida_por = COALESCE(?8, revertida_por) WHERE id = ?1")
    .bind(id, status, campos.recusa ?? null, campos.resposta ?? null, campos.baseline_json ?? null, campos.executada_em ?? null, campos.revisar_em ?? null, campos.revertida_por ?? null)
    .run();
}

/** Houve ação executada nesta campanha nos últimos FREQUENCIA_DIAS dias (sem contar reversão)? */
async function mudancaRecente(db: D1Database, alvoId: string, hoje: string, exceto: number): Promise<string | null> {
  const de = diaBrt(addDays(new Date(`${hoje}T12:00:00-03:00`), -(FREQUENCIA_DIAS - 1)));
  const r = await db.prepare("SELECT dia FROM ads_acoes WHERE alvo_id = ?1 AND status = 'executada' AND origem != 'reversao' AND dia >= ?2 AND id != ?3 ORDER BY dia DESC LIMIT 1").bind(alvoId, de, exceto).first<{ dia: string }>();
  return r?.dia ?? null;
}

function mudancaDe(a: Acao): { status?: "ACTIVE" | "PAUSED"; daily_budget?: number } | null {
  if (a.tipo === "pausar") return { status: "PAUSED" };
  if (a.tipo === "ativar") return { status: "ACTIVE" };
  if ((a.tipo === "reduzir" || a.tipo === "aumentar" || a.tipo === "orcamento") && a.valor_cents) return { daily_budget: a.valor_cents };
  return null;
}

export interface ResultadoGestor {
  bloqueado: string | null;
  nivel: number;
  executadas: number;
  ensaio: number;
  recusadas: number;
  erros: number;
  revisadas: number;
  revertidas: number;
  detalhes: Array<{ id: number; alvo: string; tipo: string; status: string; nota: string }>;
}

/** Executa a fila e depois revisa o que venceu. */
export async function rodarGestor(env: GestorEnv, fetchFn: typeof fetch = fetch, agora = new Date()): Promise<ResultadoGestor> {
  const estado = await lerEstado(env.DB);
  const nivel = estado.gestor?.nivel ?? 0;
  const out: ResultadoGestor = { bloqueado: bloqueio(estado, "gestor"), nivel, executadas: 0, ensaio: 0, recusadas: 0, erros: 0, revisadas: 0, revertidas: 0, detalhes: [] };
  if (out.bloqueado) return out;
  const hoje = diaBrt(agora);
  const campanhas = await lerCampanhas(env.DB, agora);
  const porId = new Map(campanhas.map((c) => [c.campanha_id, c]));
  let orcamentoAtivo = campanhas.filter((c) => c.status === "ACTIVE").reduce((s, c) => s + (c.orcamento_diario_cents ?? 0), 0);

  for (const a of await pendentes(env.DB)) {
    const alvo = a.alvo_nome ?? a.alvo_id;
    const m = mudancaDe(a);
    if (!m) { await marcar(env.DB, a.id, "recusada", { recusa: "tipo: ação desconhecida ou sem valor" }); out.recusadas += 1; out.detalhes.push({ id: a.id, alvo, tipo: a.tipo, status: "recusada", nota: "tipo" }); continue; }
    if (a.origem !== "reversao") {
      const rec = await mudancaRecente(env.DB, a.alvo_id, hoje, a.id);
      if (rec) { await marcar(env.DB, a.id, "recusada", { recusa: `frequencia: já executada em ${rec}` }); out.recusadas += 1; out.detalhes.push({ id: a.id, alvo, tipo: a.tipo, status: "recusada", nota: "frequencia" }); continue; }
    }
    const c = porId.get(a.alvo_id);
    const orcAtual = c?.orcamento_diario_cents ?? a.valor_anterior_cents ?? 0;
    const delta = m.status === "ACTIVE" ? orcAtual : m.status === "PAUSED" ? -orcAtual : m.daily_budget != null ? m.daily_budget - orcAtual : 0;
    if (delta > 0 && orcamentoAtivo + delta > TETO_DIARIO_CENTS) { await marcar(env.DB, a.id, "recusada", { recusa: `teto: orçamento ativo iria a ${orcamentoAtivo + delta}` }); out.recusadas += 1; out.detalhes.push({ id: a.id, alvo, tipo: a.tipo, status: "recusada", nota: "teto" }); continue; }
    if (nivel < 2) { await marcar(env.DB, a.id, "ensaio", { resposta: `ensaio: nível ${nivel}` }); out.ensaio += 1; out.detalhes.push({ id: a.id, alvo, tipo: a.tipo, status: "ensaio", nota: `nível ${nivel}` }); continue; }
    const r = await atualizarCampanhaMeta(env, a.alvo_id, m, false, fetchFn);
    if (!r.ok) { await marcar(env.DB, a.id, "erro", { resposta: `HTTP ${r.status}: ${r.texto}` }); out.erros += 1; out.detalhes.push({ id: a.id, alvo, tipo: a.tipo, status: "erro", nota: `HTTP ${r.status}` }); continue; }
    orcamentoAtivo += delta;
    const baseline = c ? { gasto_7d: c.gasto_7d, cadastros_7d: c.cadastros_7d, custo_cadastro_7d: c.cadastros_7d > 0 ? Math.round(c.gasto_7d / c.cadastros_7d) : null, orcamento_antes: orcAtual } : null;
    const revisar = a.origem === "reversao" || a.tipo === "pausar" ? null : diaBrt(addDays(agora, REVISAR_EM_DIAS));
    await marcar(env.DB, a.id, "executada", { resposta: r.texto, baseline_json: baseline ? JSON.stringify(baseline) : null, executada_em: nowIso(), revisar_em: revisar });
    out.executadas += 1;
    out.detalhes.push({ id: a.id, alvo, tipo: a.tipo, status: "executada", nota: revisar ? `revisar em ${revisar}` : "sem revisão" });
  }

  // revisão: piorou mais de REVERSAO_PIORA_PCT? enfileira a inversa e executa já
  const vencidas = await env.DB.prepare("SELECT id, dia, origem, plataforma, alvo_id, alvo_nome, tipo, valor_cents, valor_anterior_cents, motivo, baseline_json FROM ads_acoes WHERE status = 'executada' AND revisar_em IS NOT NULL AND revisar_em <= ?1 AND revertida_por IS NULL ORDER BY id").bind(hoje).all<Record<string, unknown>>();
  for (const x of vencidas.results) {
    const a: Acao = { id: n(x.id), dia: String(x.dia), origem: String(x.origem), plataforma: String(x.plataforma), alvo_id: String(x.alvo_id), alvo_nome: x.alvo_nome == null ? null : String(x.alvo_nome), tipo: String(x.tipo), valor_cents: x.valor_cents == null ? null : n(x.valor_cents), valor_anterior_cents: x.valor_anterior_cents == null ? null : n(x.valor_anterior_cents), motivo: String(x.motivo) };
    const base = x.baseline_json ? (JSON.parse(String(x.baseline_json)) as { custo_cadastro_7d: number | null; cadastros_7d: number }) : null;
    const c = porId.get(a.alvo_id);
    out.revisadas += 1;
    const custoAgora = c && c.cadastros_7d > 0 ? Math.round(c.gasto_7d / c.cadastros_7d) : null;
    const piorou = c != null && base != null && ((base.custo_cadastro_7d != null && custoAgora != null && custoAgora > base.custo_cadastro_7d * (1 + REVERSAO_PIORA_PCT / 100)) || (base.cadastros_7d > 0 && c.cadastros_7d === 0 && c.gasto_7d > 0));
    if (!piorou) { await env.DB.prepare("UPDATE ads_acoes SET revisar_em = NULL WHERE id = ?1").bind(a.id).run(); continue; }
    const inversa = a.tipo === "ativar" ? { tipo: "pausar", valor: null as number | null } : a.valor_anterior_cents ? { tipo: "orcamento", valor: a.valor_anterior_cents } : null;
    if (!inversa) { await env.DB.prepare("UPDATE ads_acoes SET revisar_em = NULL WHERE id = ?1").bind(a.id).run(); continue; }
    const motivo = `reversão da ação ${a.id}: custo por cadastro foi de ${base?.custo_cadastro_7d ?? "—"} para ${custoAgora ?? "sem cadastro"} (limite +${REVERSAO_PIORA_PCT}%)`;
    const ins = await env.DB
      .prepare("INSERT INTO ads_acoes (dia, origem, plataforma, alvo_tipo, alvo_id, alvo_nome, tipo, valor_cents, valor_anterior_cents, motivo, status, criado_em) VALUES (?1, 'reversao', ?2, 'campanha', ?3, ?4, ?5, ?6, ?7, ?8, 'pendente', ?9)")
      .bind(hoje, a.plataforma, a.alvo_id, a.alvo_nome, inversa.tipo, inversa.valor, a.valor_cents, motivo, nowIso())
      .run();
    const idInv = Number(ins.meta.last_row_id);
    const m = inversa.tipo === "pausar" ? { status: "PAUSED" as const } : { daily_budget: inversa.valor! };
    if (nivel < 2) { await marcar(env.DB, idInv, "ensaio", { resposta: `ensaio: nível ${nivel}` }); out.ensaio += 1; }
    else {
      const r = await atualizarCampanhaMeta(env, a.alvo_id, m, false, fetchFn);
      if (r.ok) { await marcar(env.DB, idInv, "executada", { resposta: r.texto, executada_em: nowIso() }); out.revertidas += 1; }
      else { await marcar(env.DB, idInv, "erro", { resposta: `HTTP ${r.status}: ${r.texto}` }); out.erros += 1; }
    }
    await marcar(env.DB, a.id, "revertida", { revertida_por: idInv });
    await env.DB.prepare("UPDATE ads_acoes SET revisar_em = NULL WHERE id = ?1").bind(a.id).run();
    out.detalhes.push({ id: idInv, alvo: a.alvo_nome ?? a.alvo_id, tipo: inversa.tipo, status: nivel < 2 ? "ensaio" : "executada", nota: `reverte ${a.id}` });
  }
  return out;
}

export async function resumoAcoes(db: D1Database, dias = 14): Promise<Record<string, unknown>> {
  const de = diaBrt(addDays(new Date(), -(dias - 1)));
  const lista = await db.prepare("SELECT id, dia, origem, plataforma, alvo_id, alvo_nome, tipo, valor_cents, valor_anterior_cents, motivo, confianca, status, recusa, resposta, executada_em, revisar_em, revertida_por FROM ads_acoes WHERE dia >= ?1 ORDER BY id DESC LIMIT 200").bind(de).all();
  const porStatus = await db.prepare("SELECT status, COUNT(*) AS n FROM ads_acoes GROUP BY status").all();
  return { dias, por_status: porStatus.results, acoes: lista.results };
}
