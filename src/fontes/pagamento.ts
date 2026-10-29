/**
 * A fonte de verdade do negócio: entradas (quem criou conta no pagamento), clientes (1º pagamento) e quem
 * seguiu pagando, lidos das tabelas clientes/pagamentos (migration 0001). Tudo o que o time sabe além do que a
 * plataforma de anúncio conta passa por aqui. Para ligar outro sistema de cobrança, alimente as tabelas
 * (POST /admin/pagamento/importar com CSV, ou um webhook seu) — o resto do código não muda.
 */
const n = (v: unknown): number => Number(v ?? 0) || 0;

export async function entradas(db: D1Database, de: string, ate: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM clientes WHERE substr(criado_em, 1, 10) BETWEEN ?1 AND ?2").bind(de, ate).first<{ n: unknown }>();
  return n(r?.n);
}

/** Clientes cujo 1º pagamento caiu no intervalo. */
export async function clientes(db: D1Database, de: string, ate: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM (SELECT cliente_id, MIN(pago_em) AS primeiro FROM pagamentos GROUP BY cliente_id) WHERE primeiro BETWEEN ?1 AND ?2").bind(de, ate).first<{ n: unknown }>();
  return n(r?.n);
}

/** Dos que entraram no intervalo, quantos já pagaram pelo menos 2 vezes. */
export async function seguiram(db: D1Database, de: string, ate: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM (SELECT cliente_id, MIN(pago_em) AS primeiro, COUNT(*) AS q FROM pagamentos GROUP BY cliente_id) WHERE primeiro BETWEEN ?1 AND ?2 AND q >= 2").bind(de, ate).first<{ n: unknown }>();
  return n(r?.n);
}

export async function clientesPorDia(db: D1Database, de: string, ate: string): Promise<Array<{ dia: string; n: number }>> {
  const r = await db.prepare("SELECT primeiro AS dia, COUNT(*) AS n FROM (SELECT cliente_id, MIN(pago_em) AS primeiro FROM pagamentos GROUP BY cliente_id) WHERE primeiro BETWEEN ?1 AND ?2 GROUP BY primeiro").bind(de, ate).all<{ dia: string; n: unknown }>();
  return r.results.map((x) => ({ dia: String(x.dia), n: n(x.n) }));
}

export async function entradasPorDia(db: D1Database, de: string, ate: string): Promise<Array<{ dia: string; n: number }>> {
  const r = await db.prepare("SELECT substr(criado_em, 1, 10) AS dia, COUNT(*) AS n FROM clientes WHERE substr(criado_em, 1, 10) BETWEEN ?1 AND ?2 GROUP BY 1").bind(de, ate).all<{ dia: string; n: unknown }>();
  return r.results.map((x) => ({ dia: String(x.dia), n: n(x.n) }));
}

export interface Pessoa { email: string | null; telefone: string | null }

/** Listas para públicos: fiéis (2+ pagamentos e, se houver, 3+ atendentes), saíram cedo (cancelaram com até 2 pagamentos), entraram e não pagaram (90 dias). */
export async function lista(db: D1Database, nome: "clientes_fieis" | "sairam_cedo" | "entraram_nao_pagaram", agora: Date): Promise<Array<{ email: unknown; telefone: unknown }>> {
  const sql = {
    clientes_fieis: "SELECT c.email, c.telefone FROM clientes c JOIN (SELECT cliente_id, COUNT(*) AS q FROM pagamentos GROUP BY cliente_id) p ON p.cliente_id = c.id WHERE p.q >= 2 AND c.cancelado_em IS NULL AND (c.atendentes IS NULL OR c.atendentes >= 3)",
    sairam_cedo: "SELECT c.email, c.telefone FROM clientes c LEFT JOIN (SELECT cliente_id, COUNT(*) AS q FROM pagamentos GROUP BY cliente_id) p ON p.cliente_id = c.id WHERE c.cancelado_em IS NOT NULL AND COALESCE(p.q, 0) <= 2",
    entraram_nao_pagaram: "SELECT c.email, c.telefone FROM clientes c WHERE c.criado_em >= ?1 AND NOT EXISTS (SELECT 1 FROM pagamentos p WHERE p.cliente_id = c.id)",
  }[nome];
  const q = db.prepare(sql);
  const r = nome === "entraram_nao_pagaram" ? await q.bind(new Date(agora.getTime() - 90 * 86_400_000).toISOString()).all<{ email: unknown; telefone: unknown }>() : await q.all<{ email: unknown; telefone: unknown }>();
  return r.results;
}

/** Importação por CSV (cabeçalho obrigatório). clientes: id,email,telefone,criado_em,plano,atendentes,cancelado_em · pagamentos: id,cliente_id,pago_em,valor_cents */
export function lerCsv(texto: string): Array<Record<string, string>> {
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim());
  if (!linhas.length) return [];
  const sep = linhas[0].includes(";") && !linhas[0].includes(",") ? ";" : ",";
  const cab = linhas[0].split(sep).map((c) => c.trim().replace(/^"|"$/g, "").toLowerCase());
  return linhas.slice(1).map((l) => {
    const cols = l.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
    return Object.fromEntries(cab.map((c, i) => [c, cols[i] ?? ""]));
  });
}

export async function importarCsv(db: D1Database, tabela: "clientes" | "pagamentos", texto: string): Promise<{ linhas: number }> {
  const agora = new Date().toISOString();
  const linhas = lerCsv(texto);
  for (const l of linhas) {
    if (tabela === "clientes") {
      if (!l.id || !l.criado_em) continue;
      await db.prepare("INSERT INTO clientes (id, email, telefone, criado_em, plano, atendentes, cancelado_em, atualizado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT (id) DO UPDATE SET email = excluded.email, telefone = excluded.telefone, criado_em = excluded.criado_em, plano = excluded.plano, atendentes = excluded.atendentes, cancelado_em = excluded.cancelado_em, atualizado_em = excluded.atualizado_em")
        .bind(l.id, l.email || null, l.telefone || null, l.criado_em, l.plano || null, l.atendentes ? Number(l.atendentes) : null, l.cancelado_em || null, agora).run();
    } else {
      if (!l.id || !l.cliente_id || !l.pago_em) continue;
      await db.prepare("INSERT INTO pagamentos (id, cliente_id, pago_em, valor_cents, atualizado_em) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (id) DO UPDATE SET cliente_id = excluded.cliente_id, pago_em = excluded.pago_em, valor_cents = excluded.valor_cents, atualizado_em = excluded.atualizado_em")
        .bind(l.id, l.cliente_id, l.pago_em.slice(0, 10), Math.round(Number(l.valor_cents || 0)) || 0, agora).run();
    }
  }
  return { linhas: linhas.length };
}
