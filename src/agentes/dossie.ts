/**
 * Dossiê do dia: tudo o que o Analista precisa para decidir, num JSON compacto (uns 3 a 6 mil tokens).
 * Vem só do D1: janelas da conta e por campanha (src/analista.ts), ações recentes (ads_acoes), estado dos
 * agentes e limites. Quem lê o dossiê é o modelo; quem o monta é código, então o modelo nunca consulta a
 * plataforma nem o banco por conta própria.
 */
import { FREQUENCIA_DIAS, PAUSAR_SEM_CADASTRO_CENTS, REDUZIR_FATOR, REDUZIR_PCT, TETO_DIARIO_CENTS, lerCampanhas, lerConta } from "../analista.ts";
import type { CampanhaJanela, ContaJanela } from "../analista.ts";
import { diaBrt } from "../anuncios.ts";
import { addDays } from "../util.ts";

import { LIMITES } from "../config/negocio.ts";
export const AUMENTAR_MAX_PCT = LIMITES.AUMENTAR_MAX_PCT;
export const ORCAMENTO_MIN_CENTS = LIMITES.ORCAMENTO_MIN_CENTS;
/** Confiança mínima que o modelo precisa declarar: gastar mais exige mais certeza do que cortar ou pausar. */
export const CONFIANCA_MIN = { aumentar: 0.7, ativar: 0.7, reduzir: 0.5, pausar: 0.5 } as const;

export interface AcaoRecente {
  id: number;
  dia: string;
  origem: string;
  alvo_id: string;
  alvo_nome: string | null;
  tipo: string;
  valor_cents: number | null;
  status: string;
  motivo: string;
}

export interface Dossie {
  hoje: string;
  limites: {
    teto_diario_cents: number;
    pausar_sem_cadastro_cents: number;
    reduzir_fator: number;
    reduzir_pct: number;
    aumentar_max_pct: number;
    frequencia_dias: number;
    orcamento_min_cents: number;
    confianca_min: { aumentar: number; ativar: number; reduzir: number; pausar: number };
  };
  conta: ContaJanela;
  campanhas: Array<CampanhaJanela & { custo_cadastro_7d_cents: number | null; custo_cadastro_28d_cents: number | null }>;
  orcamento_ativo_cents: number;
  acoes_recentes: AcaoRecente[];
  plano_semana: string | null;
}

const n = (v: unknown): number => Number(v ?? 0) || 0;
const porUnidade = (g: number, q: number): number | null => (q > 0 ? Math.round(g / q) : null);

export async function lerAcoesRecentes(db: D1Database, agora: Date, dias = 14): Promise<AcaoRecente[]> {
  const de = diaBrt(addDays(agora, -(dias - 1)));
  const r = await db
    .prepare("SELECT id, dia, origem, alvo_id, alvo_nome, tipo, valor_cents, status, motivo FROM ads_acoes WHERE dia >= ?1 AND status IN ('executada', 'ensaio', 'revertida', 'pendente') ORDER BY id DESC LIMIT 60")
    .bind(de)
    .all<Record<string, unknown>>();
  return r.results.map((x) => ({
    id: n(x.id),
    dia: String(x.dia),
    origem: String(x.origem),
    alvo_id: String(x.alvo_id),
    alvo_nome: x.alvo_nome == null ? null : String(x.alvo_nome),
    tipo: String(x.tipo),
    valor_cents: x.valor_cents == null ? null : n(x.valor_cents),
    status: String(x.status),
    motivo: String(x.motivo),
  }));
}

/** Campanhas conhecidas (ads_campanhas) que não gastaram nos 28 dias: entram zeradas, para o modelo poder propor "ativar". */
async function campanhasSemGasto(db: D1Database, jaTem: Set<string>): Promise<CampanhaJanela[]> {
  const r = await db.prepare("SELECT plataforma, campanha_id, campanha, status, orcamento_diario_cents FROM ads_campanhas ORDER BY campanha").all<Record<string, unknown>>();
  return r.results
    .filter((x) => !jaTem.has(String(x.campanha_id)))
    .map((x) => ({ plataforma: String(x.plataforma), campanha_id: String(x.campanha_id), campanha: String(x.campanha), status: x.status == null ? null : String(x.status), orcamento_diario_cents: x.orcamento_diario_cents == null ? null : n(x.orcamento_diario_cents), gasto_7d: 0, cadastros_7d: 0, gasto_28d: 0, cadastros_28d: 0, ultima_mudanca_dias: null }));
}

/** Último plano do Estrategista, como texto (a tabela pode ainda não existir nos testes antigos). */
async function lerPlanoTexto(db: D1Database): Promise<string | null> {
  try {
    const r = await db.prepare("SELECT semana, resumo, plano_json FROM ads_planos ORDER BY semana DESC LIMIT 1").first<{ semana: string; resumo: string; plano_json: string }>();
    if (!r) return null;
    const p = JSON.parse(r.plano_json) as { prioridades?: string[] };
    return `Semana ${r.semana}: ${r.resumo} Prioridades: ${(p.prioridades ?? []).join(" · ") || "—"}`;
  } catch {
    return null;
  }
}

export async function montarDossie(db: D1Database, agora = new Date()): Promise<Dossie> {
  const [conta, comGasto, acoes, plano] = await Promise.all([lerConta(db, agora), lerCampanhas(db, agora), lerAcoesRecentes(db, agora), lerPlanoTexto(db)]);
  const campanhas = [...comGasto, ...(await campanhasSemGasto(db, new Set(comGasto.map((c) => c.campanha_id))))];
  const ativas = campanhas.filter((c) => c.status === "ACTIVE");
  return {
    hoje: diaBrt(agora),
    limites: {
      teto_diario_cents: TETO_DIARIO_CENTS,
      pausar_sem_cadastro_cents: PAUSAR_SEM_CADASTRO_CENTS,
      reduzir_fator: REDUZIR_FATOR,
      reduzir_pct: REDUZIR_PCT,
      aumentar_max_pct: AUMENTAR_MAX_PCT,
      frequencia_dias: FREQUENCIA_DIAS,
      orcamento_min_cents: ORCAMENTO_MIN_CENTS,
      confianca_min: { ...CONFIANCA_MIN },
    },
    conta,
    campanhas: campanhas.map((c) => ({ ...c, custo_cadastro_7d_cents: porUnidade(c.gasto_7d, c.cadastros_7d), custo_cadastro_28d_cents: porUnidade(c.gasto_28d, c.cadastros_28d) })),
    orcamento_ativo_cents: ativas.reduce((s, c) => s + (c.orcamento_diario_cents ?? 0), 0),
    acoes_recentes: acoes,
    plano_semana: plano,
  };
}

/** Texto que vai ao modelo: o JSON e um glossário curto, para ele não confundir cadastro com cliente. */
export function dossieParaModelo(d: Dossie): string {
  return [
    "GLOSSÁRIO: cadastro = formulário contado pela plataforma; entrada = cliente criado no sistema de pagamento; cliente = 1º pagamento de um plano; coorte_seguiram = quantos dos que entraram há 35-63 dias pagaram pelo menos a 2ª vez.",
    "Entradas e clientes são da conta inteira (sem atribuição por campanha). Valores em centavos de real. Datas no fuso de Brasília.",
    d.plano_semana ? `Siga o plano da semana do Estrategista quando ele existir: ${d.plano_semana}` : "",
    "",
    JSON.stringify(d),
  ].join("\n");
}
