/**
 * Analista com IA: monta o dossiê, pede o plano ao modelo, valida cada ação contra os limites (no código) e
 * grava na fila ads_acoes. Se o modelo falhar ou responder fora do esquema, cai nas regras determinísticas
 * de src/analista.ts (que continuam rodando todo dia e são o piso de segurança).
 *
 * O Analista nunca escreve na plataforma: ele enfileira. Quem executa é o Gestor (gestor.ts).
 */
import { analisar, lerCampanhas, lerConta } from "../analista.ts";
import type { Decisao } from "../analista.ts";
import { nowIso } from "../util.ts";
import { chamarLlm } from "./llm.ts";
import type { LlmEnv } from "./llm.ts";
import { AUMENTAR_MAX_PCT, CONFIANCA_MIN, ORCAMENTO_MIN_CENTS, dossieParaModelo, montarDossie } from "./dossie.ts";
import type { Dossie } from "./dossie.ts";
import { ESQUEMA_PLANO, PERFIL_NEGOCIO, SISTEMA_ANALISTA } from "./prompts/analista.ts";
import { registrarPedido } from "./criador.ts";

export interface AnalistaEnv extends LlmEnv {
  LLM_MODELO_ANALISTA?: string;
  LLM_MODELO_ANALISTA_RESERVA?: string;
}

export const MODELO_ANALISTA_PADRAO = "anthropic/claude-sonnet-5.5";
export const MODELO_ANALISTA_RESERVA_PADRAO = "deepseek/deepseek-v4-pro";

export interface AcaoProposta {
  campanha_id: string;
  tipo: "manter" | "pausar" | "ativar" | "reduzir" | "aumentar";
  valor_cents: number | null;
  motivo: string;
  confianca: number;
}
export interface PedidoCriativo {
  campanha_id: string;
  angulo: string;
  motivo: string;
}
export interface Plano {
  resumo: string;
  acoes: AcaoProposta[];
  pedidos_criativo: PedidoCriativo[];
}

export interface AcaoValidada {
  plataforma: string;
  alvo_id: string;
  alvo_nome: string | null;
  tipo: AcaoProposta["tipo"];
  valor_cents: number | null;
  valor_anterior_cents: number | null;
  motivo: string;
  confianca: number | null;
  recusa: string | null;
}

const ehObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const TIPOS = new Set(["manter", "pausar", "ativar", "reduzir", "aumentar"]);

/** Confere a forma da resposta do modelo. Fora do esquema = resposta inteira descartada. */
export function lerPlano(v: unknown): Plano | null {
  if (!ehObj(v) || typeof v.resumo !== "string" || !Array.isArray(v.acoes) || !Array.isArray(v.pedidos_criativo)) return null;
  const acoes: AcaoProposta[] = [];
  for (const a of v.acoes) {
    if (!ehObj(a) || typeof a.campanha_id !== "string" || typeof a.tipo !== "string" || !TIPOS.has(a.tipo) || typeof a.motivo !== "string") return null;
    const valor = a.valor_cents == null ? null : Number(a.valor_cents);
    if (valor != null && !Number.isFinite(valor)) return null;
    const conf = typeof a.confianca === "number" && a.confianca >= 0 && a.confianca <= 1 ? a.confianca : 0;
    acoes.push({ campanha_id: a.campanha_id, tipo: a.tipo as AcaoProposta["tipo"], valor_cents: valor == null ? null : Math.round(valor), motivo: a.motivo.slice(0, 600), confianca: conf });
  }
  const pedidos: PedidoCriativo[] = [];
  for (const p of v.pedidos_criativo) {
    if (!ehObj(p) || typeof p.campanha_id !== "string" || typeof p.angulo !== "string" || typeof p.motivo !== "string") return null;
    pedidos.push({ campanha_id: p.campanha_id, angulo: p.angulo.slice(0, 400), motivo: p.motivo.slice(0, 600) });
  }
  return { resumo: v.resumo.slice(0, 1500), acoes, pedidos_criativo: pedidos };
}

/**
 * Os limites, aplicados a cada ação proposta. Devolve a ação com `recusa` preenchida quando não pode seguir.
 * Puro: recebe o dossiê e a proposta, não toca no banco.
 */
export function validarAcoes(d: Dossie, propostas: AcaoProposta[]): AcaoValidada[] {
  const porId = new Map(d.campanhas.map((c) => [c.campanha_id, c]));
  const vistas = new Set<string>();
  let orcamentoAtivo = d.orcamento_ativo_cents;
  const out: AcaoValidada[] = [];
  for (const p of propostas) {
    const c = porId.get(p.campanha_id);
    const base = { plataforma: c?.plataforma ?? "meta", alvo_id: p.campanha_id, alvo_nome: c?.campanha ?? null, tipo: p.tipo, valor_cents: null as number | null, valor_anterior_cents: c?.orcamento_diario_cents ?? null, motivo: p.motivo, confianca: p.confianca, recusa: null as string | null };
    if (!c) { out.push({ ...base, recusa: "alvo: campanha não está no dossiê" }); continue; }
    if (vistas.has(p.campanha_id)) { out.push({ ...base, recusa: "alvo: mais de uma ação para a mesma campanha" }); continue; }
    vistas.add(p.campanha_id);
    if (p.tipo === "manter") { out.push(base); continue; }
    const minimo = CONFIANCA_MIN[p.tipo];
    if (p.confianca < minimo) { out.push({ ...base, recusa: `confianca: ${p.confianca.toFixed(2)} abaixo do mínimo de ${minimo} para ${p.tipo}` }); continue; }
    const mudancaRecente = c.ultima_mudanca_dias != null && c.ultima_mudanca_dias < d.limites.frequencia_dias;
    if (mudancaRecente) { out.push({ ...base, recusa: `frequencia: mudança há ${c.ultima_mudanca_dias} dias (mínimo ${d.limites.frequencia_dias})` }); continue; }
    const ativa = c.status === "ACTIVE";
    const orc = c.orcamento_diario_cents;
    if (p.tipo === "pausar") {
      if (!ativa) { out.push({ ...base, recusa: "alvo: campanha já não está ativa" }); continue; }
      orcamentoAtivo -= orc ?? 0;
      out.push(base);
      continue;
    }
    if (p.tipo === "ativar") {
      if (ativa) { out.push({ ...base, recusa: "alvo: campanha já está ativa" }); continue; }
      if (orc == null) { out.push({ ...base, recusa: "valor: campanha sem orçamento diário conhecido" }); continue; }
      if (orcamentoAtivo + orc > d.limites.teto_diario_cents) { out.push({ ...base, recusa: `teto: ativar levaria o orçamento ativo a ${orcamentoAtivo + orc} (teto ${d.limites.teto_diario_cents})` }); continue; }
      orcamentoAtivo += orc;
      out.push(base);
      continue;
    }
    // reduzir / aumentar
    if (!ativa) { out.push({ ...base, recusa: "alvo: campanha não está ativa" }); continue; }
    if (orc == null) { out.push({ ...base, recusa: "valor: campanha sem orçamento diário conhecido (orçamento no conjunto?)" }); continue; }
    if (p.valor_cents == null || p.valor_cents <= 0) { out.push({ ...base, recusa: "valor: informe o orçamento diário novo em centavos" }); continue; }
    const novo = p.valor_cents;
    if (p.tipo === "reduzir") {
      if (novo >= orc) { out.push({ ...base, recusa: `valor: reduzir precisa de valor abaixo do atual (${orc})` }); continue; }
      if (novo < ORCAMENTO_MIN_CENTS) { out.push({ ...base, recusa: `valor: abaixo do mínimo de ${ORCAMENTO_MIN_CENTS}` }); continue; }
      const corte = Math.round((1 - novo / orc) * 100);
      if (corte > d.limites.reduzir_pct) { out.push({ ...base, recusa: `valor: corte de ${corte}% passa do máximo de ${d.limites.reduzir_pct}%` }); continue; }
      orcamentoAtivo += novo - orc;
      out.push({ ...base, valor_cents: novo });
      continue;
    }
    if (novo <= orc) { out.push({ ...base, recusa: `valor: aumentar precisa de valor acima do atual (${orc})` }); continue; }
    const alta = Math.round((novo / orc - 1) * 100);
    if (alta > AUMENTAR_MAX_PCT) { out.push({ ...base, recusa: `valor: aumento de ${alta}% passa do máximo de ${AUMENTAR_MAX_PCT}%` }); continue; }
    if (orcamentoAtivo + (novo - orc) > d.limites.teto_diario_cents) { out.push({ ...base, recusa: `teto: orçamento ativo iria a ${orcamentoAtivo + (novo - orc)} (teto ${d.limites.teto_diario_cents})` }); continue; }
    orcamentoAtivo += novo - orc;
    out.push({ ...base, valor_cents: novo });
  }
  return out;
}

/** As regras determinísticas, no formato de proposta: é o fallback quando o modelo não responde. */
export function propostasDasRegras(d: Dossie, decisoes: Decisao[]): AcaoProposta[] {
  const out: AcaoProposta[] = [];
  for (const x of decisoes) {
    if (!x.campanha_id || x.bloqueio) continue;
    if (x.tipo === "pausar") out.push({ campanha_id: x.campanha_id, tipo: "pausar", valor_cents: null, motivo: `[regras] ${x.motivo}`, confianca: 1 });
    else if (x.tipo === "reduzir") {
      const c = d.campanhas.find((k) => k.campanha_id === x.campanha_id);
      const orc = c?.orcamento_diario_cents;
      if (orc) out.push({ campanha_id: x.campanha_id, tipo: "reduzir", valor_cents: Math.max(ORCAMENTO_MIN_CENTS, Math.round(orc * (1 - d.limites.reduzir_pct / 100))), motivo: `[regras] ${x.motivo}`, confianca: 1 });
    } else if (x.tipo === "manter") out.push({ campanha_id: x.campanha_id, tipo: "manter", valor_cents: null, motivo: `[regras] ${x.motivo}`, confianca: 1 });
  }
  return out;
}

async function enfileirar(db: D1Database, dia: string, origem: string, acoes: AcaoValidada[], nivel: number): Promise<{ pendentes: number; recusadas: number; manter: number }> {
  const agora = nowIso();
  let pendentes = 0, recusadas = 0, manter = 0;
  for (const a of acoes) {
    if (a.tipo === "manter") { manter += 1; continue; }
    const status = a.recusa ? "recusada" : nivel >= 2 ? "pendente" : "ensaio";
    if (a.recusa) recusadas += 1; else pendentes += 1;
    await db
      .prepare("INSERT INTO ads_acoes (dia, origem, plataforma, alvo_tipo, alvo_id, alvo_nome, tipo, valor_cents, valor_anterior_cents, motivo, confianca, status, recusa, criado_em) VALUES (?1, ?2, ?3, 'campanha', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)")
      .bind(dia, origem, a.plataforma, a.alvo_id, a.alvo_nome, a.tipo, a.valor_cents, a.valor_anterior_cents, a.motivo, a.confianca, status, a.recusa, agora)
      .run();
  }
  return { pendentes, recusadas, manter };
}

export interface ResultadoAnalista {
  dia: string;
  origem: "analista_ia" | "regras";
  modelo: string | null;
  erro_modelo: string | null;
  resumo: string;
  acoes: AcaoValidada[];
  pedidos_criativo: PedidoCriativo[];
  fila: { pendentes: number; recusadas: number; manter: number };
}

/**
 * Uma rodada: dossiê → modelo → validação → fila. `nivel` 1 grava como ensaio (não executa); 2 grava como
 * pendente para o Gestor. Rodar duas vezes no mesmo dia apaga o que o analista enfileirou antes naquele dia
 * e ainda não foi executado.
 */
export async function rodarAnalistaIa(env: AnalistaEnv, nivel: number, fetchFn: typeof fetch = fetch, agora = new Date()): Promise<ResultadoAnalista> {
  const d = await montarDossie(env.DB, agora);
  await env.DB.prepare("DELETE FROM ads_acoes WHERE dia = ?1 AND origem IN ('analista_ia', 'regras') AND status IN ('pendente', 'ensaio', 'recusada')").bind(d.hoje).run();

  const r = await chamarLlm<unknown>(env, {
    agente: "analista",
    modelo: env.LLM_MODELO_ANALISTA || MODELO_ANALISTA_PADRAO,
    modeloReserva: env.LLM_MODELO_ANALISTA_RESERVA || MODELO_ANALISTA_RESERVA_PADRAO,
    sistema: `${SISTEMA_ANALISTA}\n\nSOBRE A EMPRESA:\n${PERFIL_NEGOCIO}`,
    usuario: dossieParaModelo(d),
    esquema: ESQUEMA_PLANO as unknown as Record<string, unknown>,
    nomeEsquema: "plano_do_dia",
    raciocinio: "low",
    maxTokens: 6000,
  }, fetchFn, agora);

  const plano = r.ok ? lerPlano(r.dados) : null;
  if (r.ok && plano) {
    const acoes = validarAcoes(d, plano.acoes);
    const fila = await enfileirar(env.DB, d.hoje, "analista_ia", acoes, nivel);
    for (const pc of plano.pedidos_criativo) {
      const c = d.campanhas.find((k) => k.campanha_id === pc.campanha_id);
      await registrarPedido(env.DB, d.hoje, "analista_ia", { plataforma: c?.plataforma ?? "meta", campanha_id: c ? c.campanha_id : null, campanha: c?.campanha ?? null, angulo: pc.angulo, motivo: pc.motivo });
    }
    return { dia: d.hoje, origem: "analista_ia", modelo: r.modelo, erro_modelo: null, resumo: plano.resumo, acoes, pedidos_criativo: plano.pedidos_criativo, fila };
  }
  // fallback: as regras (que já rodaram e gravaram em ads_decisoes) viram ações
  const erro = r.ok ? "resposta fora do esquema" : r.erro;
  const decisoes = analisar(await lerConta(env.DB, agora), await lerCampanhas(env.DB, agora));
  const acoes = validarAcoes(d, propostasDasRegras(d, decisoes));
  const fila = await enfileirar(env.DB, d.hoje, "regras", acoes, nivel);
  return { dia: d.hoje, origem: "regras", modelo: null, erro_modelo: erro, resumo: decisoes[0]?.motivo ?? "", acoes, pedidos_criativo: [], fila };
}
