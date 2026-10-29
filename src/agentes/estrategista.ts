/**
 * Estrategista: uma vez por semana (segunda, ou quando a semana ainda não tem plano) lê os 28 dias, a
 * biblioteca e as páginas e escreve o plano da semana: diagnóstico, metas, teto de verba sugerido (nunca acima
 * do teto do código), ângulos para testar e quantos criativos pedir. O plano vai para o dossiê do Analista e os
 * ângulos viram pedidos de criativo (no máximo ESTRATEGISTA_PEDIDOS_SEMANA). Não escreve na plataforma.
 */
import { TETO_DIARIO_CENTS } from "../analista.ts";
import { diaBrt } from "../anuncios.ts";
import { nowIso } from "../util.ts";
import { chamarLlm } from "./llm.ts";
import type { LlmEnv } from "./llm.ts";
import { dossieParaModelo, montarDossie } from "./dossie.ts";
import { bibliotecaParaModelo, montarBiblioteca } from "./biblioteca.ts";
import { lerResumos, paginaParaModelo } from "./paginas.ts";
import { PERFIL_NEGOCIO } from "./prompts/analista.ts";
import { registrarPedido } from "./criador.ts";

export const ESTRATEGISTA_PEDIDOS_SEMANA = 2;
export const MODELO_ESTRATEGISTA_PADRAO = "anthropic/claude-sonnet-5.5";

export interface EstrategistaEnv extends LlmEnv {
  LLM_MODELO_ANALISTA?: string;
  CRIADOR_LINK?: string;
}

export interface PlanoSemana {
  diagnostico: string;
  metas: { custo_cadastro_alvo_cents: number; cadastros_semana: number };
  teto_diario_sugerido_cents: number;
  angulos: Array<{ angulo: string; motivo: string }>;
  prioridades: string[];
}

const ESQUEMA_PLANO_SEMANA = {
  type: "object",
  additionalProperties: false,
  required: ["diagnostico", "metas", "teto_diario_sugerido_cents", "angulos", "prioridades"],
  properties: {
    diagnostico: { type: "string", description: "3 a 5 frases: o que os 28 dias dizem e o que mudou na última semana." },
    metas: { type: "object", additionalProperties: false, required: ["custo_cadastro_alvo_cents", "cadastros_semana"], properties: { custo_cadastro_alvo_cents: { type: "integer" }, cadastros_semana: { type: "integer" } } },
    teto_diario_sugerido_cents: { type: "integer", description: "Quanto gastar por dia nesta semana, em centavos; nunca acima do teto informado." },
    angulos: { type: "array", items: { type: "object", additionalProperties: false, required: ["angulo", "motivo"], properties: { angulo: { type: "string" }, motivo: { type: "string" } } } },
    prioridades: { type: "array", items: { type: "string" }, description: "Até 4 frases curtas com o que o Analista deve privilegiar nesta semana." },
  },
} as const;

const SISTEMA = `Você é o estrategista de tráfego pago de uma empresa de software. Uma vez por semana recebe: o dossiê (28 dias de gasto, cadastros, entradas no pagamento e clientes), o que a conta aprendeu com os anúncios (melhores e piores) e o resumo das landing pages. Escreva o plano da semana em JSON:
- diagnóstico honesto, com números;
- metas realistas: custo por cadastro alvo (perto do melhor que a conta já fez de forma sustentada) e cadastros esperados na semana com o teto sugerido;
- teto diário sugerido: igual ou menor que o teto informado; só sugira o máximo se a conta estiver abaixo da média de custo por cadastro por 2 semanas;
- de 1 a 3 ângulos para criativos novos, cada um com motivo ligado ao que funcionou, ao que não funcionou ou ao que a página promete e o anúncio ainda não usa;
- até 4 prioridades para o Analista (ex.: "não aumentar enquanto o custo por cliente não cair", "pausar X se Y").
Português do Brasil, direto. Não proponha nada fora do que a empresa pode afirmar.`;

const ehObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function lerPlanoSemana(v: unknown): PlanoSemana | null {
  if (!ehObj(v) || typeof v.diagnostico !== "string" || !ehObj(v.metas) || !Array.isArray(v.angulos) || !Array.isArray(v.prioridades)) return null;
  const m = v.metas;
  const alvo = Number(m.custo_cadastro_alvo_cents), cad = Number(m.cadastros_semana), teto = Number(v.teto_diario_sugerido_cents);
  if (![alvo, cad, teto].every(Number.isFinite)) return null;
  const angulos = v.angulos.filter((a): a is { angulo: string; motivo: string } => ehObj(a) && typeof a.angulo === "string" && typeof a.motivo === "string").map((a) => ({ angulo: a.angulo.slice(0, 400), motivo: a.motivo.slice(0, 600) })).slice(0, 3);
  return {
    diagnostico: v.diagnostico.slice(0, 2000),
    metas: { custo_cadastro_alvo_cents: Math.max(0, Math.round(alvo)), cadastros_semana: Math.max(0, Math.round(cad)) },
    teto_diario_sugerido_cents: Math.min(TETO_DIARIO_CENTS, Math.max(0, Math.round(teto))),
    angulos,
    prioridades: v.prioridades.filter((p): p is string => typeof p === "string").map((p) => p.slice(0, 300)).slice(0, 4),
  };
}

/** Semana ISO (AAAA-Www) de uma data em Brasília. */
export function semanaIso(agora: Date): string {
  const d = new Date(`${diaBrt(agora)}T12:00:00Z`);
  const dia = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dia);
  const ano = d.getUTCFullYear();
  const inicio = new Date(Date.UTC(ano, 0, 1));
  const semana = Math.ceil(((d.getTime() - inicio.getTime()) / 86_400_000 + 1) / 7);
  return `${ano}-W${String(semana).padStart(2, "0")}`;
}

export async function lerPlanoAtual(db: D1Database, agora = new Date()): Promise<{ semana: string; plano: PlanoSemana; resumo: string } | null> {
  const r = await db.prepare("SELECT semana, plano_json, resumo FROM ads_planos ORDER BY semana DESC LIMIT 1").first<{ semana: string; plano_json: string; resumo: string }>();
  if (!r) return null;
  return { semana: r.semana, plano: JSON.parse(r.plano_json) as PlanoSemana, resumo: r.resumo };
}

/** Roda se a semana ainda não tem plano (ou se `forcar`). */
export async function rodarEstrategista(env: EstrategistaEnv, fetchFn: typeof fetch = fetch, agora = new Date(), forcar = false): Promise<{ semana: string; feito: boolean; motivo: string; plano?: PlanoSemana; pedidos?: number }> {
  const semana = semanaIso(agora);
  const existe = await env.DB.prepare("SELECT semana FROM ads_planos WHERE semana = ?1").bind(semana).first();
  if (existe && !forcar) return { semana, feito: false, motivo: "a semana já tem plano" };
  const [d, b, paginas] = await Promise.all([montarDossie(env.DB, agora), montarBiblioteca(env.DB, agora), lerResumos(env.DB)]);
  const destino = paginas.find((x) => x.url === env.CRIADOR_LINK) ?? paginas.find((x) => x.resumo);
  const anterior = await lerPlanoAtual(env.DB, agora);
  const r = await chamarLlm<unknown>(env, {
    agente: "estrategista",
    modelo: env.LLM_MODELO_ANALISTA || MODELO_ESTRATEGISTA_PADRAO,
    modeloReserva: "deepseek/deepseek-v4-pro",
    sistema: `${SISTEMA}\n\nSOBRE A EMPRESA:\n${PERFIL_NEGOCIO}\n\nTETO DE VERBA DO CÓDIGO: ${TETO_DIARIO_CENTS} centavos por dia.`,
    usuario: [dossieParaModelo(d), bibliotecaParaModelo(b), paginaParaModelo(destino), anterior ? `PLANO DA SEMANA ANTERIOR (${anterior.semana}):\n${JSON.stringify(anterior.plano)}` : ""].filter(Boolean).join("\n\n"),
    esquema: ESQUEMA_PLANO_SEMANA as unknown as Record<string, unknown>,
    nomeEsquema: "plano_semana",
    raciocinio: "low",
    maxTokens: 5000,
  }, fetchFn, agora);
  if (!r.ok) return { semana, feito: false, motivo: `modelo: ${r.erro}` };
  const plano = lerPlanoSemana(r.dados);
  if (!plano) return { semana, feito: false, motivo: "resposta fora do esquema" };
  const resumo = `${plano.diagnostico} Meta: R$ ${(plano.metas.custo_cadastro_alvo_cents / 100).toFixed(2)} por cadastro, ${plano.metas.cadastros_semana} cadastros na semana, até R$ ${(plano.teto_diario_sugerido_cents / 100).toFixed(2)}/dia.`;
  await env.DB
    .prepare("INSERT INTO ads_planos (semana, dia, modelo, plano_json, resumo, criado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (semana) DO UPDATE SET dia = excluded.dia, modelo = excluded.modelo, plano_json = excluded.plano_json, resumo = excluded.resumo, criado_em = excluded.criado_em")
    .bind(semana, diaBrt(agora), r.modelo, JSON.stringify(plano), resumo.slice(0, 3000), nowIso())
    .run();
  let pedidos = 0;
  for (const a of plano.angulos.slice(0, ESTRATEGISTA_PEDIDOS_SEMANA)) {
    await registrarPedido(env.DB, diaBrt(agora), "estrategista", { plataforma: "meta", campanha_id: null, campanha: null, angulo: a.angulo, motivo: `[plano ${semana}] ${a.motivo}` });
    pedidos += 1;
  }
  return { semana, feito: true, motivo: "plano escrito", plano, pedidos };
}

/** Texto do plano para o dossiê do Analista. */
export function planoParaModelo(p: { semana: string; plano: PlanoSemana } | null): string {
  if (!p) return "";
  return `PLANO DA SEMANA ${p.semana} (do Estrategista): ${p.plano.diagnostico}\nMetas: R$ ${(p.plano.metas.custo_cadastro_alvo_cents / 100).toFixed(2)} por cadastro, ${p.plano.metas.cadastros_semana} cadastros; teto sugerido R$ ${(p.plano.teto_diario_sugerido_cents / 100).toFixed(2)}/dia.\nPrioridades: ${p.plano.prioridades.join(" · ") || "—"}`;
}
