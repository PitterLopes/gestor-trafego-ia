/**
 * Métricas do negócio a partir de `clientes` e `pagamentos`, por mês (últimos 12): entradas, clientes novos,
 * ativos no fim do mês, MRR, cancelamentos e taxa, e as coortes (de quem virou cliente em cada mês, quantos
 * ainda pagavam 1, 2, 3 e 6 meses depois). Regra de "ativo": último pagamento com menos de
 * CICLO_DIAS + TOLERANCIA_DIAS e sem cancelamento até a data (config/negocio.ts). Tudo puro: lê as linhas uma vez.
 */
import { CICLO_DIAS, TOLERANCIA_DIAS } from "./config/negocio.ts";

export interface ClienteLinha { id: string; criado_em: string; cancelado_em: string | null }
export interface PagamentoLinha { cliente_id: string; pago_em: string; valor_cents: number }
export interface MesMetrica { mes: string; entradas: number; novos: number; ativos: number; mrr_cents: number; cancelados: number; churn_pct: number | null; receita_cents: number }
export interface Coorte { mes: string; clientes: number; retidos: Array<number | null> } // retidos[k-1] = % pagando no mês +k (null = ainda não chegou)
export interface Metricas { meses: MesMetrica[]; coortes: Coorte[]; hoje: { ativos: number; mrr_cents: number; novos_30d: number; entradas_30d: number; conversao_30d_pct: number | null } }

const DIA = 86_400_000;
const mesDe = (iso: string) => iso.slice(0, 7);
const fimDoMes = (mes: string): number => { const [a, m] = mes.split("-").map(Number); return Date.UTC(a, m, 0, 23, 59, 59); };
const somaMes = (mes: string, k: number): string => { const [a, m] = mes.split("-").map(Number); const d = new Date(Date.UTC(a, m - 1 + k, 1)); return d.toISOString().slice(0, 7); };
const JANELA = CICLO_DIAS > 0 ? (CICLO_DIAS + TOLERANCIA_DIAS) * DIA : Infinity;

function ativoEm(c: ClienteLinha, ultimoPagoMs: number | null, valorUltimo: number, t: number): { ativo: boolean; mrr: number } {
  if (ultimoPagoMs == null || ultimoPagoMs > t) return { ativo: false, mrr: 0 };
  if (c.cancelado_em && Date.parse(c.cancelado_em) <= t) return { ativo: false, mrr: 0 };
  const ativo = t - ultimoPagoMs < JANELA;
  return { ativo, mrr: ativo && CICLO_DIAS > 0 ? Math.round(valorUltimo * (30 / CICLO_DIAS)) : 0 };
}

export function calcularMetricas(clientes: ClienteLinha[], pagamentos: PagamentoLinha[], agora = new Date(), meses = 12): Metricas {
  const porCliente = new Map<string, PagamentoLinha[]>();
  for (const p of pagamentos) { const l = porCliente.get(p.cliente_id) ?? []; l.push(p); porCliente.set(p.cliente_id, l); }
  for (const l of porCliente.values()) l.sort((a, b) => a.pago_em.localeCompare(b.pago_em));
  const primeiro = new Map<string, string>();
  for (const [id, l] of porCliente) primeiro.set(id, l[0].pago_em);

  /** Último pagamento até a data t (ms) e seu valor. */
  const ultimoAte = (id: string, t: number): { ms: number | null; valor: number } => {
    const l = porCliente.get(id) ?? [];
    let ms: number | null = null, valor = 0;
    for (const p of l) { const pm = Date.parse(`${p.pago_em}T12:00:00Z`); if (pm <= t) { ms = pm; valor = p.valor_cents; } else break; }
    return { ms, valor };
  };
  const foto = (t: number): { ativos: number; mrr: number; ids: Set<string> } => {
    let ativos = 0, mrr = 0; const ids = new Set<string>();
    for (const c of clientes) { const u = ultimoAte(c.id, t); const a = ativoEm(c, u.ms, u.valor, t); if (a.ativo) { ativos += 1; mrr += a.mrr; ids.add(c.id); } }
    return { ativos, mrr, ids };
  };

  const mesAtual = agora.toISOString().slice(0, 7);
  const lista: MesMetrica[] = [];
  let anterior: Set<string> | null = null;
  for (let k = meses - 1; k >= 0; k--) {
    const mes = somaMes(mesAtual, -k);
    const fim = Math.min(fimDoMes(mes), agora.getTime());
    const f = foto(fim);
    const entradas = clientes.filter((c) => mesDe(c.criado_em) === mes).length;
    const novos = [...primeiro.values()].filter((d) => mesDe(d) === mes).length;
    const receita = pagamentos.filter((p) => mesDe(p.pago_em) === mes).reduce((s, p) => s + p.valor_cents, 0);
    const cancelados = anterior ? [...anterior].filter((id) => !f.ids.has(id)).length : 0;
    lista.push({ mes, entradas, novos, ativos: f.ativos, mrr_cents: f.mrr, cancelados, churn_pct: anterior && anterior.size ? Math.round((cancelados / anterior.size) * 1000) / 10 : null, receita_cents: receita });
    anterior = f.ids;
  }

  // coortes: mês do 1º pagamento → % que pagou no mês +k
  const coortes: Coorte[] = [];
  const porMes = new Map<string, string[]>();
  for (const [id, d] of primeiro) { const m = mesDe(d); const l = porMes.get(m) ?? []; l.push(id); porMes.set(m, l); }
  for (const mes of [...porMes.keys()].sort().slice(-meses)) {
    const ids = porMes.get(mes)!;
    const retidos = [1, 2, 3, 6].map((k) => {
      const alvo = somaMes(mes, k);
      if (alvo > mesAtual) return null;
      const n = ids.filter((id) => (porCliente.get(id) ?? []).some((p) => mesDe(p.pago_em) === alvo)).length;
      return Math.round((n / ids.length) * 1000) / 10;
    });
    coortes.push({ mes, clientes: ids.length, retidos });
  }

  const hojeF = foto(agora.getTime());
  const de30 = new Date(agora.getTime() - 30 * DIA).toISOString();
  const entradas30 = clientes.filter((c) => c.criado_em >= de30);
  const novos30 = [...primeiro.values()].filter((d) => d >= de30.slice(0, 10)).length;
  const converteram = entradas30.filter((c) => primeiro.has(c.id)).length;
  return { meses: lista, coortes, hoje: { ativos: hojeF.ativos, mrr_cents: hojeF.mrr, novos_30d: novos30, entradas_30d: entradas30.length, conversao_30d_pct: entradas30.length ? Math.round((converteram / entradas30.length) * 1000) / 10 : null } };
}

export async function lerMetricas(db: D1Database, agora = new Date()): Promise<Metricas> {
  const c = await db.prepare("SELECT id, criado_em, cancelado_em FROM clientes").all<ClienteLinha>();
  const p = await db.prepare("SELECT cliente_id, pago_em, valor_cents FROM pagamentos").all<PagamentoLinha>();
  return calcularMetricas(c.results.map((x) => ({ id: String(x.id), criado_em: String(x.criado_em), cancelado_em: x.cancelado_em == null ? null : String(x.cancelado_em) })), p.results.map((x) => ({ cliente_id: String(x.cliente_id), pago_em: String(x.pago_em), valor_cents: Number(x.valor_cents) })), agora);
}
