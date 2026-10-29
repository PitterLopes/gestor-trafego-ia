/**
 * Ingestão do pagamento: tudo o que alimenta `clientes` e `pagamentos` passa por aqui.
 *
 *   POST /webhook/pagamento/<fonte>?token=WEBHOOK_TOKEN
 *     fonte = generico | iugu | stripe | asaas
 *
 * O formato genérico é o mesmo do CSV, em JSON:
 *   { "clientes": [{ id, email, telefone, nome, criado_em, plano, atendentes, cancelado_em, fbclid, gclid, utm }],
 *     "pagamentos": [{ id, cliente_id, pago_em, valor_cents }] }
 * ou um único registro: { "tipo": "cliente", ... } / { "tipo": "pagamento", ... }.
 *
 * Os adaptadores traduzem o webhook de cada plataforma para esse formato; o que não vem no webhook é buscado
 * na API da plataforma com PAGAMENTO_TOKEN (só leitura, uma chamada por evento). Para ligar outra plataforma,
 * escreva um adaptador aqui (uma função que devolve `Entrada`) e documente em docs/integracoes.md.
 *
 * Depois de gravar, quem chamou dispara os eventos para a Meta (src/fontes/eventos_meta.ts) dos clientes tocados.
 */
import { nowIso } from "../util.ts";

export interface ClienteEntrada {
  id: string;
  email?: string | null;
  telefone?: string | null;
  nome?: string | null;
  criado_em: string;
  plano?: string | null;
  atendentes?: number | null;
  cancelado_em?: string | null;
  fbclid?: string | null;
  gclid?: string | null;
  fbp?: string | null;
  utm?: Record<string, string> | null;
}
export interface PagamentoEntrada {
  id: string;
  cliente_id: string;
  pago_em: string; // AAAA-MM-DD (ou ISO; só os 10 primeiros contam)
  valor_cents: number;
}
export interface Entrada {
  clientes: ClienteEntrada[];
  pagamentos: PagamentoEntrada[];
}

export interface IngestaoEnv {
  DB: D1Database;
  WEBHOOK_TOKEN?: string;
  PAGAMENTO_TOKEN?: string; // chave de leitura da plataforma, quando o webhook não traz os dados
}

const ehObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Data em qualquer forma razoável → ISO (ou null). Aceita ISO, "AAAA-MM-DD", "DD/MM/AAAA[ HH:MM]" e segundos Unix. */
export function dataIso(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return new Date((v < 1e12 ? v * 1000 : v)).toISOString();
  const s = String(v).trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2}))?/.exec(s);
  if (br) return new Date(Date.UTC(Number(br[3]), Number(br[2]) - 1, Number(br[1]), Number(br[4] ?? 12), Number(br[5] ?? 0))).toISOString();
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function lerUtm(v: unknown): Record<string, string> | null {
  if (!ehObj(v)) return null;
  const out: Record<string, string> = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
    const x = str(v[k] ?? v[k.replace("utm_", "")]);
    if (x) out[k] = x.slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

function lerCliente(v: unknown): ClienteEntrada | null {
  if (!ehObj(v)) return null;
  const id = str(v.id), criado = dataIso(v.criado_em ?? v.created_at);
  if (!id || !criado) return null;
  return { id, email: str(v.email), telefone: str(v.telefone ?? v.phone), nome: str(v.nome ?? v.name), criado_em: criado, plano: str(v.plano ?? v.plan), atendentes: num(v.atendentes), cancelado_em: dataIso(v.cancelado_em ?? v.canceled_at), fbclid: str(v.fbclid), gclid: str(v.gclid), fbp: str(v.fbp), utm: lerUtm(v.utm ?? v) };
}
function lerPagamento(v: unknown): PagamentoEntrada | null {
  if (!ehObj(v)) return null;
  const id = str(v.id), cliente = str(v.cliente_id ?? v.customer_id), pago = dataIso(v.pago_em ?? v.paid_at);
  const valor = num(v.valor_cents ?? v.total_cents ?? v.amount_cents) ?? (num(v.valor) != null ? Math.round(num(v.valor)! * 100) : null);
  if (!id || !cliente || !pago || valor == null) return null;
  return { id, cliente_id: cliente, pago_em: pago.slice(0, 10), valor_cents: Math.round(valor) };
}

/** Formato genérico (JSON do nosso esquema). */
export function adaptarGenerico(corpo: unknown): Entrada {
  const out: Entrada = { clientes: [], pagamentos: [] };
  const lista = Array.isArray(corpo) ? corpo : [corpo];
  for (const item of lista) {
    if (!ehObj(item)) continue;
    if (Array.isArray(item.clientes)) for (const c of item.clientes) { const x = lerCliente(c); if (x) out.clientes.push(x); }
    if (Array.isArray(item.pagamentos)) for (const p of item.pagamentos) { const x = lerPagamento(p); if (x) out.pagamentos.push(x); }
    if (item.tipo === "cliente") { const x = lerCliente(item); if (x) out.clientes.push(x); }
    if (item.tipo === "pagamento") { const x = lerPagamento(item); if (x) out.pagamentos.push(x); }
  }
  return out;
}

/**
 * Stripe: eventos `customer.created`, `customer.deleted`, `invoice.paid` (ou `checkout.session.completed` com customer).
 * O corpo do Stripe já traz tudo; nada é buscado.
 */
export function adaptarStripe(corpo: unknown): Entrada {
  const out: Entrada = { clientes: [], pagamentos: [] };
  if (!ehObj(corpo) || !ehObj(corpo.data) || !ehObj(corpo.data.object)) return out;
  const tipo = String(corpo.type ?? ""), o = corpo.data.object;
  if (tipo === "customer.created" || tipo === "customer.updated") {
    const id = str(o.id), criado = dataIso(o.created);
    if (id && criado) out.clientes.push({ id, email: str(o.email), telefone: str(o.phone), nome: str(o.name), criado_em: criado, plano: null, utm: lerUtm(o.metadata), fbclid: ehObj(o.metadata) ? str(o.metadata.fbclid) : null, gclid: ehObj(o.metadata) ? str(o.metadata.gclid) : null });
  }
  if (tipo === "customer.deleted") {
    const id = str(o.id);
    if (id) out.clientes.push({ id, criado_em: dataIso(o.created) ?? nowIso(), cancelado_em: nowIso() });
  }
  if (tipo === "invoice.paid" || tipo === "invoice.payment_succeeded") {
    const id = str(o.id), cliente = str(o.customer), pago = dataIso(ehObj(o.status_transitions) ? o.status_transitions.paid_at : o.created), valor = num(o.amount_paid);
    if (id && cliente && pago && valor != null) out.pagamentos.push({ id, cliente_id: cliente, pago_em: pago.slice(0, 10), valor_cents: valor });
  }
  if (tipo === "customer.subscription.deleted") {
    const cliente = str(o.customer);
    if (cliente) out.clientes.push({ id: cliente, criado_em: dataIso(o.created) ?? nowIso(), cancelado_em: dataIso(o.canceled_at ?? o.ended_at) ?? nowIso() });
  }
  return out;
}

/**
 * Asaas: `PAYMENT_RECEIVED` / `PAYMENT_CONFIRMED` trazem payment.customer, value e paymentDate; o cliente novo
 * vem em `CUSTOMER_CREATED` (quando ligado) ou é buscado em /v3/customers/<id> com PAGAMENTO_TOKEN.
 */
export async function adaptarAsaas(corpo: unknown, env: IngestaoEnv, fetchFn: typeof fetch): Promise<Entrada> {
  const out: Entrada = { clientes: [], pagamentos: [] };
  if (!ehObj(corpo)) return out;
  const evento = String(corpo.event ?? "");
  const p = ehObj(corpo.payment) ? corpo.payment : null;
  if ((evento === "PAYMENT_RECEIVED" || evento === "PAYMENT_CONFIRMED") && p) {
    const id = str(p.id), cliente = str(p.customer), pago = dataIso(p.paymentDate ?? p.confirmedDate ?? p.clientPaymentDate), valor = num(p.value);
    if (id && cliente && pago && valor != null) {
      out.pagamentos.push({ id, cliente_id: cliente, pago_em: pago.slice(0, 10), valor_cents: Math.round(valor * 100) });
      const c = await buscarAsaasCliente(cliente, env, fetchFn);
      if (c) out.clientes.push(c);
    }
  }
  if (evento === "CUSTOMER_CREATED" && ehObj(corpo.customer)) {
    const c = corpo.customer, id = str(c.id);
    if (id) out.clientes.push({ id, email: str(c.email), telefone: str(c.mobilePhone ?? c.phone), nome: str(c.name), criado_em: dataIso(c.dateCreated) ?? nowIso() });
  }
  return out;
}
async function buscarAsaasCliente(id: string, env: IngestaoEnv, fetchFn: typeof fetch): Promise<ClienteEntrada | null> {
  if (!env.PAGAMENTO_TOKEN) return null;
  try {
    const r = await fetchFn(`https://api.asaas.com/v3/customers/${encodeURIComponent(id)}`, { headers: { access_token: env.PAGAMENTO_TOKEN } });
    if (!r.ok) return null;
    const c = (await r.json()) as Record<string, unknown>;
    return { id, email: str(c.email), telefone: str(c.mobilePhone ?? c.phone), nome: str(c.name), criado_em: dataIso(c.dateCreated) ?? nowIso() };
  } catch { return null; }
}

/**
 * Iugu: o webhook é form-urlencoded e só traz `event`, `data[id]` e `data[status]`; a fatura e o cliente são
 * buscados na API (GET /v1/invoices/<id> e /v1/customers/<id>) com PAGAMENTO_TOKEN (Basic, token:).
 * Eventos que importam: invoice.status_changed (paid/externally_paid), invoice.created, customer.created.
 */
export async function adaptarIugu(corpo: unknown, env: IngestaoEnv, fetchFn: typeof fetch): Promise<Entrada> {
  const out: Entrada = { clientes: [], pagamentos: [] };
  if (!ehObj(corpo) || !env.PAGAMENTO_TOKEN) return out;
  const evento = String(corpo.event ?? ""), dados = ehObj(corpo.data) ? corpo.data : {};
  const id = str(dados.id);
  if (!id) return out;
  const auth = { authorization: `Basic ${btoa(`${env.PAGAMENTO_TOKEN}:`)}` };
  const buscar = async (caminho: string): Promise<Record<string, unknown> | null> => {
    try { const r = await fetchFn(`https://api.iugu.com/v1/${caminho}`, { headers: auth }); return r.ok ? ((await r.json()) as Record<string, unknown>) : null; } catch { return null; }
  };
  const cliente = async (cid: string, criado: string | null): Promise<void> => {
    const c = await buscar(`customers/${cid}`);
    out.clientes.push({ id: cid, email: str(c?.email), telefone: str(c?.phone ? `${c.phone_prefix ?? ""}${c.phone}` : null), nome: str(c?.name), criado_em: dataIso(c?.created_at) ?? criado ?? nowIso(), plano: null });
  };
  if (evento === "customer.created") { await cliente(id, null); return out; }
  if (evento.startsWith("invoice.")) {
    const f = await buscar(`invoices/${id}`);
    const cid = str(f?.customer_id);
    if (!f || !cid) return out;
    await cliente(cid, dataIso(f.created_at_iso ?? f.created_at));
    const status = String(f.status ?? "");
    if (status === "paid" || status === "externally_paid") {
      const pago = dataIso(f.paid_at ?? f.occurred_at), valor = num(f.paid_cents) || num(f.total_cents);
      if (pago && valor) out.pagamentos.push({ id, cliente_id: cid, pago_em: pago.slice(0, 10), valor_cents: valor });
    }
  }
  return out;
}

export async function adaptar(fonte: string, corpo: unknown, env: IngestaoEnv, fetchFn: typeof fetch): Promise<Entrada | null> {
  if (fonte === "generico") return adaptarGenerico(corpo);
  if (fonte === "stripe") return adaptarStripe(corpo);
  if (fonte === "asaas") return adaptarAsaas(corpo, env, fetchFn);
  if (fonte === "iugu") return adaptarIugu(corpo, env, fetchFn);
  return null;
}

/** Corpo do webhook em qualquer formato: JSON ou form-urlencoded (Iugu manda `data[id]=...`). */
export async function lerCorpo(request: Request): Promise<unknown> {
  const tipo = request.headers.get("content-type") ?? "";
  const texto = await request.text();
  if (tipo.includes("json") || /^\s*[[{]/.test(texto)) { try { return JSON.parse(texto); } catch { return null; } }
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(texto)) {
    const m = /^(\w+)\[(\w+)\]$/.exec(k);
    if (m) { const o = (out[m[1]] ??= {}) as Record<string, unknown>; o[m[2]] = v; } else out[k] = v;
  }
  return out;
}

// ---------- gravação ----------

/** Procura o lead da landing page pelo e-mail ou telefone, para herdar fbclid/gclid/utm. */
async function leadDe(db: D1Database, c: ClienteEntrada): Promise<{ fbclid: string | null; gclid: string | null; fbp: string | null; utm_json: string | null } | null> {
  const email = c.email?.toLowerCase() ?? null, tel = c.telefone?.replace(/\D/g, "") ?? null;
  if (!email && !tel) return null;
  return db.prepare("SELECT fbclid, gclid, fbp, utm_json FROM leads WHERE (?1 IS NOT NULL AND lower(email) = ?1) OR (?2 IS NOT NULL AND ?2 <> '' AND replace(replace(replace(replace(telefone,' ',''),'-',''),'(',''),')','') LIKE '%' || ?2) ORDER BY id DESC LIMIT 1").bind(email, tel).first();
}

export async function gravarEntrada(db: D1Database, e: Entrada, origem: string): Promise<{ clientes: number; pagamentos: number; tocados: string[] }> {
  const agora = nowIso();
  const tocados = new Set<string>();
  for (const c of e.clientes) {
    const lead = !c.fbclid && !c.gclid ? await leadDe(db, c) : null;
    await db.prepare(`INSERT INTO clientes (id, email, telefone, nome, criado_em, plano, atendentes, cancelado_em, origem, fbclid, gclid, fbp, utm_json, atualizado_em)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
      ON CONFLICT (id) DO UPDATE SET email = COALESCE(excluded.email, clientes.email), telefone = COALESCE(excluded.telefone, clientes.telefone), nome = COALESCE(excluded.nome, clientes.nome),
        plano = COALESCE(excluded.plano, clientes.plano), atendentes = COALESCE(excluded.atendentes, clientes.atendentes), cancelado_em = COALESCE(excluded.cancelado_em, clientes.cancelado_em),
        fbclid = COALESCE(clientes.fbclid, excluded.fbclid), gclid = COALESCE(clientes.gclid, excluded.gclid), fbp = COALESCE(clientes.fbp, excluded.fbp), utm_json = COALESCE(clientes.utm_json, excluded.utm_json), atualizado_em = excluded.atualizado_em`)
      .bind(c.id, c.email ?? null, c.telefone ?? null, c.nome ?? null, c.criado_em, c.plano ?? null, c.atendentes ?? null, c.cancelado_em ?? null, origem, c.fbclid ?? lead?.fbclid ?? null, c.gclid ?? lead?.gclid ?? null, c.fbp ?? lead?.fbp ?? null, c.utm ? JSON.stringify(c.utm) : lead?.utm_json ?? null, agora).run();
    tocados.add(c.id);
  }
  for (const p of e.pagamentos) {
    // pagamento de cliente que ainda não existe: cria o cliente mínimo para o histórico não ficar órfão
    await db.prepare("INSERT OR IGNORE INTO clientes (id, criado_em, origem, atualizado_em) VALUES (?1, ?2, ?3, ?4)").bind(p.cliente_id, `${p.pago_em}T12:00:00.000Z`, origem, agora).run();
    await db.prepare("INSERT INTO pagamentos (id, cliente_id, pago_em, valor_cents, atualizado_em) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (id) DO UPDATE SET cliente_id = excluded.cliente_id, pago_em = excluded.pago_em, valor_cents = excluded.valor_cents, atualizado_em = excluded.atualizado_em")
      .bind(p.id, p.cliente_id, p.pago_em, p.valor_cents, agora).run();
    tocados.add(p.cliente_id);
  }
  return { clientes: e.clientes.length, pagamentos: e.pagamentos.length, tocados: [...tocados] };
}

/** Recebe um webhook: confere o token, adapta, grava e registra no log. Devolve os clientes tocados (para os eventos). */
export async function receberWebhook(env: IngestaoEnv, fonte: string, request: Request, fetchFn: typeof fetch = fetch): Promise<{ status: number; corpo: Record<string, unknown>; tocados: string[] }> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!env.WEBHOOK_TOKEN || token !== env.WEBHOOK_TOKEN) return { status: 401, corpo: { error: "token do webhook inválido (WEBHOOK_TOKEN)" }, tocados: [] };
  const corpo = await lerCorpo(request);
  const e = await adaptar(fonte, corpo, env, fetchFn);
  if (!e) return { status: 404, corpo: { error: `fonte desconhecida: ${fonte} (use generico, iugu, stripe ou asaas)` }, tocados: [] };
  const tipo = ehObj(corpo) ? str(corpo.event ?? corpo.type ?? corpo.tipo) : null;
  try {
    const r = await gravarEntrada(env.DB, e, `webhook:${fonte}`);
    await env.DB.prepare("INSERT INTO ingestao_log (fonte, tipo, clientes, pagamentos, recebido_em) VALUES (?1, ?2, ?3, ?4, ?5)").bind(fonte, tipo, r.clientes, r.pagamentos, nowIso()).run();
    return { status: 200, corpo: { ok: true, ...r }, tocados: r.tocados };
  } catch (err) {
    await env.DB.prepare("INSERT INTO ingestao_log (fonte, tipo, erro, recebido_em) VALUES (?1, ?2, ?3, ?4)").bind(fonte, tipo, String(err).slice(0, 500), nowIso()).run();
    return { status: 500, corpo: { error: String(err) }, tocados: [] };
  }
}

export async function resumoIngestao(db: D1Database): Promise<{ ultimos: Array<Record<string, unknown>>; clientes: number; pagamentos: number; com_clique: number }> {
  const ultimos = await db.prepare("SELECT fonte, tipo, clientes, pagamentos, erro, recebido_em FROM ingestao_log ORDER BY id DESC LIMIT 20").all<Record<string, unknown>>();
  const t = await db.prepare("SELECT (SELECT COUNT(*) FROM clientes) AS clientes, (SELECT COUNT(*) FROM pagamentos) AS pagamentos, (SELECT COUNT(*) FROM clientes WHERE fbclid IS NOT NULL OR gclid IS NOT NULL) AS com_clique").first<{ clientes: number; pagamentos: number; com_clique: number }>();
  return { ultimos: ultimos.results, clientes: Number(t?.clientes ?? 0), pagamentos: Number(t?.pagamentos ?? 0), com_clique: Number(t?.com_clique ?? 0) };
}
