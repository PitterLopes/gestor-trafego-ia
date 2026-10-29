/**
 * A rodada do time: Analista com IA → Gestor, cada um com o seu estado (nível, parado) e um registro em
 * agentes_execucoes. É o que o cron chama depois da coleta e das regras, e o que POST /admin/agentes/rodar
 * dispara à mão. Um agente que falha não derruba o outro.
 */
import { diaBrt } from "../anuncios.ts";
import { nowIso } from "../util.ts";
import { rodarAnalistaIa } from "./analista_ia.ts";
import type { AnalistaEnv } from "./analista_ia.ts";
import { bloqueio, lerEstado, resumoAcoes, rodarGestor } from "./gestor.ts";
import type { GestorEnv } from "./gestor.ts";
import { llmAtivo, resumoLlm } from "./llm.ts";
import { listarCriativos, rodarCriador } from "./criador.ts";
import { atualizarPaginas } from "./paginas.ts";
import { listarAlertas, rodarVigia } from "./vigia.ts";
import type { VigiaEnv } from "./vigia.ts";
import { lerPlanoAtual, rodarEstrategista } from "./estrategista.ts";
import type { EstrategistaEnv } from "./estrategista.ts";
import { lerRelatorioAtual, rodarRelator } from "./relator.ts";
import type { RelatorEnv } from "./relator.ts";
import { listarPublicos, rodarPublicos } from "./publicos.ts";
import type { PublicosEnv } from "./publicos.ts";
import type { CriadorEnv, RenderPng } from "./criador.ts";

export type EquipeEnv = AnalistaEnv & GestorEnv & CriadorEnv & VigiaEnv & EstrategistaEnv & RelatorEnv & PublicosEnv;

/** Segunda-feira em Brasília: dia do Estrategista, do Relator e dos Públicos. */
export function ehSegunda(agora: Date): boolean {
  return new Date(`${diaBrt(agora)}T12:00:00Z`).getUTCDay() === 1;
}

async function passo(env: EquipeEnv, agente: string, dia: string, gatilho: string, fn: () => Promise<{ resumo: string; ok: boolean; detalhes?: unknown; registrar?: boolean }>): Promise<unknown> {
  const t = Date.now();
  try {
    const r = await fn();
    if (r.registrar !== false) await registrarExecucao(env.DB, { agente, dia, gatilho, ok: r.ok, resumo: r.resumo, detalhes: r.detalhes, duracao_ms: Date.now() - t });
    return r.detalhes ?? r.resumo;
  } catch (e) {
    await registrarExecucao(env.DB, { agente, dia, gatilho, ok: false, resumo: String(e), duracao_ms: Date.now() - t });
    return { erro: String(e) };
  }
}

/** Rodada leve de hora em hora: só o Vigia (teto do dia, reprovações) e o Gestor para executar o que ele pediu. */
export async function rodarVigiaHorario(env: EquipeEnv, fetchFn: typeof fetch = fetch, agora = new Date()): Promise<Record<string, unknown>> {
  const dia = diaBrt(agora);
  const estado = await lerEstado(env.DB);
  const out: Record<string, unknown> = { dia };
  const bloq = bloqueio(estado, "vigia");
  if (bloq) { out.vigia = { pulado: bloq }; return out; }
  out.vigia = await passo(env, "vigia", dia, "hora", async () => {
    const v = await rodarVigia(env, "horario", estado.vigia?.nivel ?? 0, fetchFn, agora);
    return { ok: v.erros.length === 0, resumo: `hora: ${v.alertas_novos} alertas novos, ${v.pausas_enfileiradas} pausas${v.erros.length ? ` · erros: ${v.erros.join("; ")}` : ""}`, detalhes: v, registrar: v.alertas_novos > 0 || v.erros.length > 0 };
  });
  if ((out.vigia as { pausas_enfileiradas?: number })?.pausas_enfileiradas) out.gestor = await rodarGestor(env, fetchFn, agora);
  return out;
}

export async function registrarExecucao(db: D1Database, x: { agente: string; dia: string; gatilho: string; ok: boolean; resumo: string; detalhes?: unknown; duracao_ms: number }): Promise<void> {
  await db
    .prepare("INSERT INTO agentes_execucoes (agente, dia, gatilho, ok, resumo, detalhes_json, duracao_ms, criado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(x.agente, x.dia, x.gatilho, x.ok ? 1 : 0, x.resumo.slice(0, 2000), x.detalhes == null ? null : JSON.stringify(x.detalhes).slice(0, 20_000), x.duracao_ms, nowIso())
    .run();
}

export async function rodarEquipe(env: EquipeEnv, gatilho: "cron" | "manual", fetchFn: typeof fetch = fetch, agora = new Date(), renderPng?: RenderPng): Promise<Record<string, unknown>> {
  const dia = diaBrt(agora);
  const estado = await lerEstado(env.DB);
  const out: Record<string, unknown> = { dia, estado };
  const segunda = ehSegunda(agora);

  // Vigia completo: antes de decidir, o que está quebrado
  const bloqV = bloqueio(estado, "vigia");
  out.vigia = bloqV ? { pulado: bloqV } : await passo(env, "vigia", dia, gatilho, async () => {
    const v = await rodarVigia(env, "completo", estado.vigia?.nivel ?? 0, fetchFn, agora);
    return { ok: v.erros.length === 0, resumo: `${v.alertas_novos} alertas novos, ${v.enviados} enviados, ${v.pausas_enfileiradas} pausas${v.erros.length ? ` · erros: ${v.erros.join("; ")}` : ""}`, detalhes: v };
  });

  // Estrategista: plano da semana (segunda, ou quando a semana não tem plano)
  const bloqE = bloqueio(estado, "estrategista");
  if (bloqE) out.estrategista = { pulado: bloqE };
  else if (!llmAtivo(env)) out.estrategista = { pulado: "OPENROUTER_API_KEY não configurada" };
  else if ((estado.estrategista?.nivel ?? 0) < 1) out.estrategista = { pulado: "nível 0" };
  else out.estrategista = await passo(env, "estrategista", dia, gatilho, async () => {
    const r = await rodarEstrategista(env, fetchFn, agora, false);
    return { ok: true, resumo: r.feito ? `plano ${r.semana}: ${r.pedidos ?? 0} pedidos de criativo` : `${r.semana}: ${r.motivo}`, detalhes: r, registrar: r.feito };
  });

  // Analista
  const t0 = Date.now();
  const bloqA = bloqueio(estado, "analista");
  if (bloqA) out.analista = { pulado: bloqA };
  else if (!llmAtivo(env)) out.analista = { pulado: "OPENROUTER_API_KEY não configurada" };
  else {
    try {
      const r = await rodarAnalistaIa(env, estado.analista?.nivel ?? 1, fetchFn, agora);
      const resumo = `${r.origem}${r.modelo ? ` (${r.modelo})` : ""}: ${r.fila.pendentes} para executar, ${r.fila.recusadas} recusadas, ${r.fila.manter} manter${r.pedidos_criativo.length ? `, ${r.pedidos_criativo.length} pedidos de criativo` : ""}${r.erro_modelo ? ` · modelo falhou: ${r.erro_modelo}` : ""}`;
      await registrarExecucao(env.DB, { agente: "analista", dia, gatilho, ok: true, resumo, detalhes: { resumo_modelo: r.resumo, acoes: r.acoes, pedidos_criativo: r.pedidos_criativo }, duracao_ms: Date.now() - t0 });
      out.analista = { origem: r.origem, modelo: r.modelo, erro_modelo: r.erro_modelo, resumo: r.resumo, fila: r.fila, pedidos_criativo: r.pedidos_criativo.length };
    } catch (e) {
      await registrarExecucao(env.DB, { agente: "analista", dia, gatilho, ok: false, resumo: String(e), duracao_ms: Date.now() - t0 });
      out.analista = { erro: String(e) };
    }
  }

  // Gestor
  const t1 = Date.now();
  try {
    const g = await rodarGestor(env, fetchFn, agora);
    const resumo = g.bloqueado ? `pulado: ${g.bloqueado}` : `nível ${g.nivel}: ${g.executadas} executadas, ${g.ensaio} em ensaio, ${g.recusadas} recusadas, ${g.erros} erros, ${g.revisadas} revisadas, ${g.revertidas} revertidas`;
    await registrarExecucao(env.DB, { agente: "gestor", dia, gatilho, ok: g.erros === 0, resumo, detalhes: g.detalhes, duracao_ms: Date.now() - t1 });
    out.gestor = g;
  } catch (e) {
    await registrarExecucao(env.DB, { agente: "gestor", dia, gatilho, ok: false, resumo: String(e), duracao_ms: Date.now() - t1 });
    out.gestor = { erro: String(e) };
  }

  // Criador: só quando há pedido pendente e ele não está parado
  const t2 = Date.now();
  const bloqC = bloqueio(estado, "criador");
  if (bloqC) out.criador = { pulado: bloqC };
  else if (!llmAtivo(env)) out.criador = { pulado: "OPENROUTER_API_KEY não configurada" };
  else if (!renderPng) out.criador = { pulado: "sem renderizador" };
  else {
    try {
      // landing pages: só as vencidas gastam modelo; erro aqui não impede o criador
      try { out.paginas = await atualizarPaginas(env, fetchFn, agora); } catch (e) { out.paginas = { erro: String(e) }; }
      const c = await rodarCriador(env, estado.criador?.nivel ?? 0, { renderPng, fetchFn, agora });
      if (c.bloqueado) out.criador = { pulado: c.bloqueado };
      else {
        const resumo = `nível ${c.nivel}: ${c.gerados} gerados, ${c.reprovados} reprovados, ${c.publicados} publicados, ${c.erros} erros`;
        if (c.detalhes.length) await registrarExecucao(env.DB, { agente: "criador", dia, gatilho, ok: c.erros === 0, resumo, detalhes: c.detalhes, duracao_ms: Date.now() - t2 });
        out.criador = c;
      }
    } catch (e) {
      await registrarExecucao(env.DB, { agente: "criador", dia, gatilho, ok: false, resumo: String(e), duracao_ms: Date.now() - t2 });
      out.criador = { erro: String(e) };
    }
  }

  // Públicos e Relator: às segundas
  if (segunda || gatilho === "manual") {
    const bloqP = bloqueio(estado, "publicos");
    out.publicos = bloqP ? { pulado: bloqP } : await passo(env, "publicos", dia, gatilho, async () => {
      const r = await rodarPublicos(env, estado.publicos?.nivel ?? 0, fetchFn, agora);
      return { ok: r.erros === 0, resumo: `nível ${r.nivel}: ${r.listas.map((l) => `${l.nome} ${l.pessoas}`).join(", ")}${r.semelhante ? ` · semelhante ${r.semelhante.resposta}` : ""}`, detalhes: r, registrar: segunda || r.erros > 0 };
    });
    const bloqR = bloqueio(estado, "relator");
    if (bloqR) out.relator = { pulado: bloqR };
    else if (!llmAtivo(env)) out.relator = { pulado: "OPENROUTER_API_KEY não configurada" };
    else if ((estado.relator?.nivel ?? 0) < 1 || !segunda) out.relator = { pulado: segunda ? "nível 0" : "só às segundas" };
    else out.relator = await passo(env, "relator", dia, gatilho, async () => {
      const r = await rodarRelator(env, fetchFn, agora, false);
      return { ok: true, resumo: r.feito ? `relatório ${r.semana} enviado para ${(r.enviado_para ?? []).length}` : `${r.semana}: ${r.motivo}`, detalhes: { semana: r.semana, feito: r.feito, motivo: r.motivo }, registrar: r.feito };
    });
  }
  return out;
}

export async function painelAgentes(env: EquipeEnv): Promise<Record<string, unknown>> {
  const execucoes = await env.DB.prepare("SELECT id, agente, dia, gatilho, ok, resumo, duracao_ms, criado_em FROM agentes_execucoes ORDER BY id DESC LIMIT 30").all();
  return {
    estado: await lerEstado(env.DB),
    llm_configurado: llmAtivo(env),
    meta_escrita_configurada: Boolean(env.META_ADS_TOKEN),
    execucoes: execucoes.results,
    acoes: await resumoAcoes(env.DB),
    criativos: await listarCriativos(env.DB),
    alertas: await listarAlertas(env.DB),
    plano: await lerPlanoAtual(env.DB),
    relatorio: await lerRelatorioAtual(env.DB),
    publicos: await listarPublicos(env.DB),
    modelos: await resumoLlm(env.DB),
  };
}
