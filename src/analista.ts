/**
 * Analista de anúncios (regras): lê o gasto (ads_gasto_diario, ads_campanhas) e a aquisição real (fontes/pagamento.ts)
 * e decide, campanha a campanha, o que faria. Em modo SOMBRA só grava a decisão em ads_decisoes; nada é executado
 * na plataforma. Os limites moram aqui, no código, não num prompt:
 *
 *   TETO_DIARIO_CENTS        soma do orçamento diário das campanhas ativas nunca passa disso (alerta)
 *   PAUSAR_SEM_CADASTRO      gasto nos últimos 7 dias sem nenhum cadastro → pausar
 *   REDUZIR_FATOR            custo por cadastro da campanha acima de N× o da conta nos 28 dias → reduzir 20%
 *   FREQUENCIA_DIAS          uma mudança por campanha a cada 7 dias (bloqueio "frequencia")
 *
 * "Cadastro" é o resultado que a Meta conta (lead). "Entrada" é quem criou conta no pagamento. "Cliente" é o 1º
 * pagamento. "Segue" é quem pagou pelo menos a 2ª vez. Só o cadastro é por campanha; o resto é da conta inteira,
 * porque a atribuição (fbclid) normalmente não chega até o pagamento.
 */
import { addDays, nowIso } from "./util.ts";
import { diaBrt } from "./anuncios.ts";
import { LIMITES } from "./config/negocio.ts";
import * as pagamento from "./fontes/pagamento.ts";

export const TETO_DIARIO_CENTS = LIMITES.TETO_DIARIO_CENTS;
export const PAUSAR_SEM_CADASTRO_CENTS = LIMITES.PAUSAR_SEM_CADASTRO_CENTS;
export const REDUZIR_MIN_GASTO_CENTS = LIMITES.REDUZIR_MIN_GASTO_CENTS;
export const REDUZIR_FATOR = LIMITES.REDUZIR_FATOR;
export const REDUZIR_PCT = LIMITES.REDUZIR_PCT;
export const FREQUENCIA_DIAS = LIMITES.FREQUENCIA_DIAS;

export interface AnalistaEnv {
  DB: D1Database;
}

export interface CampanhaJanela {
  plataforma: string;
  campanha_id: string;
  campanha: string;
  status: string | null;
  orcamento_diario_cents: number | null;
  gasto_7d: number;
  cadastros_7d: number;
  gasto_28d: number;
  cadastros_28d: number;
  /** Última decisão de pausar/reduzir registrada para a campanha, em dias atrás (null = nenhuma). */
  ultima_mudanca_dias: number | null;
}

export interface ContaJanela {
  gasto_7d: number;
  cadastros_7d: number;
  entradas_7d: number;
  clientes_7d: number;
  gasto_28d: number;
  cadastros_28d: number;
  entradas_28d: number;
  clientes_28d: number;
  /** Clientes que entraram entre 35 e 63 dias atrás e quantos deles já pagaram a 2ª vez. */
  coorte_clientes: number;
  coorte_seguiram: number;
}

export interface Decisao {
  plataforma: string | null;
  campanha_id: string | null;
  campanha: string | null;
  tipo: "manter" | "pausar" | "reduzir" | "alerta_teto" | "resumo";
  motivo: string;
  bloqueio: string | null;
  dados: Record<string, unknown>;
}

const reais = (c: number): string => `R$ ${(c / 100).toFixed(2).replace(".", ",")}`;
const porUnidade = (gasto: number, n: number): number | null => (n > 0 ? Math.round(gasto / n) : null);

/** Regras puras: recebe as janelas prontas e devolve as decisões. Sem banco, sem rede. */
export function analisar(conta: ContaJanela, campanhas: CampanhaJanela[]): Decisao[] {
  const out: Decisao[] = [];
  const custoCadastroConta28 = porUnidade(conta.gasto_28d, conta.cadastros_28d);
  const ativas = campanhas.filter((c) => c.status === "ACTIVE");
  const orcamentoAtivo = ativas.reduce((s, c) => s + (c.orcamento_diario_cents ?? 0), 0);

  out.push({
    plataforma: null,
    campanha_id: null,
    campanha: null,
    tipo: "resumo",
    motivo:
      `7 dias: ${reais(conta.gasto_7d)}, ${conta.cadastros_7d} cadastros, ${conta.entradas_7d} entradas, ${conta.clientes_7d} clientes. ` +
      `28 dias: ${reais(conta.gasto_28d)}, custo por cadastro ${custoCadastroConta28 == null ? "—" : reais(custoCadastroConta28)}, ` +
      `por entrada ${porUnidade(conta.gasto_28d, conta.entradas_28d) == null ? "—" : reais(porUnidade(conta.gasto_28d, conta.entradas_28d)!)}, ` +
      `por cliente ${porUnidade(conta.gasto_28d, conta.clientes_28d) == null ? "—" : reais(porUnidade(conta.gasto_28d, conta.clientes_28d)!)}. ` +
      `Coorte de 35-63 dias: ${conta.coorte_seguiram} de ${conta.coorte_clientes} seguiram pagando.`,
    bloqueio: null,
    dados: { ...conta, custo_cadastro_28d: custoCadastroConta28, orcamento_ativo_cents: orcamentoAtivo, teto_cents: TETO_DIARIO_CENTS },
  });

  if (orcamentoAtivo > TETO_DIARIO_CENTS) {
    out.push({
      plataforma: null,
      campanha_id: null,
      campanha: null,
      tipo: "alerta_teto",
      motivo: `Orçamento diário das campanhas ativas (${reais(orcamentoAtivo)}) passa do teto de ${reais(TETO_DIARIO_CENTS)}.`,
      bloqueio: null,
      dados: { orcamento_ativo_cents: orcamentoAtivo, teto_cents: TETO_DIARIO_CENTS, ativas: ativas.map((c) => c.campanha) },
    });
  }

  for (const c of campanhas) {
    if (c.status !== "ACTIVE" || c.gasto_7d === 0) continue;
    const custo7 = porUnidade(c.gasto_7d, c.cadastros_7d);
    const bloqueio = c.ultima_mudanca_dias != null && c.ultima_mudanca_dias < FREQUENCIA_DIAS ? "frequencia" : null;
    const dados = { gasto_7d: c.gasto_7d, cadastros_7d: c.cadastros_7d, custo_cadastro_7d: custo7, custo_cadastro_conta_28d: custoCadastroConta28, orcamento_diario_cents: c.orcamento_diario_cents, ultima_mudanca_dias: c.ultima_mudanca_dias };
    const base = { plataforma: c.plataforma, campanha_id: c.campanha_id, campanha: c.campanha, dados };
    if (c.cadastros_7d === 0 && c.gasto_7d >= PAUSAR_SEM_CADASTRO_CENTS) {
      out.push({ ...base, tipo: "pausar", bloqueio, motivo: `${reais(c.gasto_7d)} em 7 dias sem nenhum cadastro (limite ${reais(PAUSAR_SEM_CADASTRO_CENTS)}).` });
    } else if (custo7 != null && custoCadastroConta28 != null && c.gasto_7d >= REDUZIR_MIN_GASTO_CENTS && custo7 > REDUZIR_FATOR * custoCadastroConta28) {
      out.push({
        ...base,
        tipo: "reduzir",
        bloqueio,
        motivo: `Custo por cadastro ${reais(custo7)} nos 7 dias, mais de ${REDUZIR_FATOR}× o da conta (${reais(custoCadastroConta28)}): reduzir ${REDUZIR_PCT}% do orçamento.`,
      });
    } else {
      out.push({ ...base, tipo: "manter", bloqueio: null, motivo: `Custo por cadastro ${custo7 == null ? "—" : reais(custo7)} nos 7 dias, dentro do esperado.` });
    }
  }
  return out;
}

// ---------- leitura do D1 ----------

const n = (v: unknown): number => Number(v ?? 0) || 0;

async function somaGasto(db: D1Database, de: string, ate: string): Promise<{ gasto: number; cadastros: number }> {
  const r = await db.prepare("SELECT SUM(gasto_cents) AS g, SUM(resultados) AS c FROM ads_gasto_diario WHERE dia BETWEEN ?1 AND ?2").bind(de, ate).first<{ g: unknown; c: unknown }>();
  return { gasto: n(r?.g), cadastros: n(r?.c) };
}


export async function lerConta(db: D1Database, agora: Date): Promise<ContaJanela> {
  const hoje = diaBrt(agora);
  const d7 = diaBrt(addDays(agora, -6));
  const d28 = diaBrt(addDays(agora, -27));
  const c35 = diaBrt(addDays(agora, -35));
  const c63 = diaBrt(addDays(agora, -63));
  const [g7, g28] = await Promise.all([somaGasto(db, d7, hoje), somaGasto(db, d28, hoje)]);
  return {
    gasto_7d: g7.gasto,
    cadastros_7d: g7.cadastros,
    entradas_7d: await pagamento.entradas(db, d7, hoje),
    clientes_7d: await pagamento.clientes(db, d7, hoje),
    gasto_28d: g28.gasto,
    cadastros_28d: g28.cadastros,
    entradas_28d: await pagamento.entradas(db, d28, hoje),
    clientes_28d: await pagamento.clientes(db, d28, hoje),
    coorte_clientes: await pagamento.clientes(db, c63, c35),
    coorte_seguiram: await pagamento.seguiram(db, c63, c35),
  };
}

export async function lerCampanhas(db: D1Database, agora: Date): Promise<CampanhaJanela[]> {
  const hoje = diaBrt(agora);
  const d7 = diaBrt(addDays(agora, -6));
  const d28 = diaBrt(addDays(agora, -27));
  const r = await db
    .prepare(
      `SELECT g.plataforma, g.campanha_id, COALESCE(c.campanha, MAX(g.campanha)) AS campanha, c.status, c.orcamento_diario_cents,
         SUM(CASE WHEN g.dia >= ?1 THEN g.gasto_cents ELSE 0 END) AS gasto_7d,
         SUM(CASE WHEN g.dia >= ?1 THEN g.resultados ELSE 0 END) AS cadastros_7d,
         SUM(g.gasto_cents) AS gasto_28d, SUM(g.resultados) AS cadastros_28d,
         (SELECT MAX(d.dia) FROM ads_decisoes d WHERE d.campanha_id = g.campanha_id AND d.tipo IN ('pausar', 'reduzir') AND d.bloqueio IS NULL AND d.dia < ?3) AS ultima_mudanca
       FROM ads_gasto_diario g LEFT JOIN ads_campanhas c ON c.plataforma = g.plataforma AND c.campanha_id = g.campanha_id
       WHERE g.dia BETWEEN ?2 AND ?3 GROUP BY g.plataforma, g.campanha_id ORDER BY gasto_7d DESC`,
    )
    .bind(d7, d28, hoje)
    .all<Record<string, unknown>>();
  return r.results.map((x) => ({
    plataforma: String(x.plataforma),
    campanha_id: String(x.campanha_id),
    campanha: String(x.campanha),
    status: x.status == null ? null : String(x.status),
    orcamento_diario_cents: x.orcamento_diario_cents == null ? null : n(x.orcamento_diario_cents),
    gasto_7d: n(x.gasto_7d),
    cadastros_7d: n(x.cadastros_7d),
    gasto_28d: n(x.gasto_28d),
    cadastros_28d: n(x.cadastros_28d),
    ultima_mudanca_dias: x.ultima_mudanca == null ? null : Math.round((agora.getTime() - new Date(`${String(x.ultima_mudanca)}T12:00:00-03:00`).getTime()) / 86_400_000),
  }));
}

/** Uma rodada em modo sombra: apaga as decisões do dia (rodar de novo não duplica) e grava as novas. */
export async function rodarAnalista(env: AnalistaEnv, agora = new Date()): Promise<{ dia: string; decisoes: Decisao[] }> {
  const dia = diaBrt(agora);
  const [conta, campanhas] = [await lerConta(env.DB, agora), await lerCampanhas(env.DB, agora)];
  const decisoes = analisar(conta, campanhas);
  await env.DB.prepare("DELETE FROM ads_decisoes WHERE dia = ?1 AND modo = 'sombra'").bind(dia).run();
  const criado = nowIso();
  for (const d of decisoes) {
    await env.DB
      .prepare("INSERT INTO ads_decisoes (dia, plataforma, campanha_id, campanha, tipo, motivo, bloqueio, dados_json, modo, criado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'sombra', ?9)")
      .bind(dia, d.plataforma, d.campanha_id, d.campanha, d.tipo, d.motivo, d.bloqueio, JSON.stringify(d.dados), criado)
      .run();
  }
  return { dia, decisoes };
}

export async function resumoAnalista(db: D1Database, dias = 14): Promise<Record<string, unknown>> {
  const r = await db
    .prepare("SELECT id, dia, plataforma, campanha, tipo, motivo, bloqueio, modo, dados_json FROM ads_decisoes WHERE dia >= ?1 ORDER BY dia DESC, id")
    .bind(diaBrt(addDays(new Date(), -(dias - 1))))
    .all<Record<string, unknown>>();
  const porTipo = await db.prepare("SELECT tipo, COUNT(*) AS n FROM ads_decisoes GROUP BY tipo").all();
  return { limites: { teto_diario_cents: TETO_DIARIO_CENTS, pausar_sem_cadastro_cents: PAUSAR_SEM_CADASTRO_CENTS, reduzir_fator: REDUZIR_FATOR, reduzir_pct: REDUZIR_PCT, frequencia_dias: FREQUENCIA_DIAS }, por_tipo: porTipo.results, decisoes: r.results.map((x) => ({ ...x, dados: JSON.parse(String(x.dados_json)), dados_json: undefined })) };
}
