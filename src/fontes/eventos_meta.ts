/**
 * Eventos para a Meta (API de Conversões) a partir de `clientes` e `pagamentos`:
 *
 *   InitiateCheckout     o cliente entrou no pagamento (criou conta / iniciou checkout)
 *   Purchase             primeiro pagamento do cliente: o sinal de "cliente novo" (é por ele que as campanhas otimizam)
 *   RenovacaoAssinatura  pagamentos seguintes: a Meta aprende quem paga e quanto (evento personalizado, de propósito,
 *                        para nenhuma campanha otimizar por renovação)
 *
 * Regras: um event_id por fato (checkout_<cliente>, purchase_<pagamento>, renovacao_<pagamento>), reservado em
 * meta_eventos antes do envio (webhook repetido, cron e reprocessamento nunca mandam duas vezes); a Meta recusa
 * eventos com mais de 7 dias (ficam "ignorado"); só saem e-mail, telefone, nome, país e o id do cliente, em SHA-256,
 * mais fbc/fbp quando a landing page capturou o clique. Nada sai sem META_CAPI_ATIVO = "true"; com
 * META_TEST_EVENT_CODE os eventos vão para a aba "Eventos de teste".
 */
import { MOEDA, PAIS } from "../config/negocio.ts";
import { META_API_VERSAO } from "../meta_versao.ts";
import { nowIso, sha256Hex } from "../util.ts";

export const META_IDADE_MAX_S = 7 * 86_400 - 3_600;
export const META_TENTATIVAS_MAX = 5;
const ENVIANDO_PRESO_MS = 10 * 60_000;

export interface EventosEnv {
  DB: D1Database;
  META_CAPI_ATIVO?: string;
  META_DATASET_ID?: string;
  META_CAPI_TOKEN?: string; // se vazio, usa META_ADS_TOKEN (o usuário do sistema precisa ter o conjunto de dados atribuído)
  META_ADS_TOKEN?: string;
  META_TEST_EVENT_CODE?: string;
}

export interface ClienteEv { id: string; email: string | null; telefone: string | null; nome: string | null; criado_em: string; fbclid: string | null; fbp: string | null; plano: string | null }
export interface PagamentoEv { id: string; pago_em: string; valor_cents: number }
export interface EventoPlanejado { event_id: string; evento: "InitiateCheckout" | "Purchase" | "RenovacaoAssinatura"; event_time: number; valor_cents: number | null; pagamento_id: string | null; action_source: "other" | "system_generated"; custom_data: Record<string, string | number> }

const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
export function normEmail(v: string | null | undefined): string | null { const e = (v ?? "").trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null; }
/** Só dígitos com DDI; número brasileiro de 10/11 dígitos ganha o 55. */
export function normTelefone(v: string | null | undefined): string | null {
  let d = (v ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (PAIS === "br" && (d.length === 10 || d.length === 11)) d = `55${d}`;
  return d.length >= 10 && d.length <= 15 ? d : null;
}
export function nomeSobrenome(nome: string | null | undefined): { fn: string; ln: string | null } | null {
  const partes = semAcento(nome ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  if (!partes.length) return null;
  return { fn: partes[0], ln: partes.length > 1 ? partes[partes.length - 1] : null };
}
const segundos = (iso: string): number => Math.floor(Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso) / 1000);

export function dadosDeCorrespondencia(c: ClienteEv): Record<string, string> {
  const out: Record<string, string> = {};
  const em = normEmail(c.email); if (em) out.em = em;
  const ph = normTelefone(c.telefone); if (ph) out.ph = ph;
  const n = nomeSobrenome(c.nome); if (n) { out.fn = n.fn; if (n.ln) out.ln = n.ln; }
  out.country = PAIS;
  out.external_id = c.id;
  return out;
}

/** user_data no formato da Meta: campos pessoais em SHA-256; fbc e fbp vão em claro (é assim que a Meta pede). */
export async function userData(c: ClienteEv, dados: Record<string, string>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(dados)) out[k] = [await sha256Hex(v)];
  if (c.fbclid) out.fbc = `fb.1.${Date.parse(c.criado_em) || Date.now()}.${c.fbclid}`;
  if (c.fbp) out.fbp = c.fbp;
  return out;
}

/** Todos os eventos que este cliente gera, do histórico inteiro (quem chama descarta os com mais de 7 dias ou já enviados). */
export function planejarEventos(c: ClienteEv, pagamentos: PagamentoEv[]): EventoPlanejado[] {
  const out: EventoPlanejado[] = [];
  const plano = c.plano ?? "plano";
  out.push({ event_id: `checkout_${c.id}`, evento: "InitiateCheckout", event_time: segundos(c.criado_em), valor_cents: null, pagamento_id: null, action_source: "other", custom_data: { currency: MOEDA, content_name: plano } });
  const ordenados = [...pagamentos].sort((a, b) => a.pago_em.localeCompare(b.pago_em) || a.id.localeCompare(b.id));
  ordenados.forEach((p, i) => {
    const base = { event_time: segundos(p.pago_em), valor_cents: p.valor_cents, pagamento_id: p.id };
    if (i === 0) out.push({ event_id: `purchase_${p.id}`, evento: "Purchase", action_source: "other", custom_data: { currency: MOEDA, value: p.valor_cents / 100, content_name: plano, tipo_cliente: "novo" }, ...base });
    else out.push({ event_id: `renovacao_${p.id}`, evento: "RenovacaoAssinatura", action_source: "system_generated", custom_data: { currency: MOEDA, value: p.valor_cents / 100, content_name: plano, tipo_cliente: "atual" }, ...base });
  });
  return out;
}

export function corpoParaMeta(eventos: EventoPlanejado[], ud: Record<string, unknown>, testCode?: string): Record<string, unknown> {
  return { data: eventos.map((e) => ({ event_name: e.evento, event_time: e.event_time, event_id: e.event_id, action_source: e.action_source, user_data: ud, custom_data: e.custom_data })), ...(testCode ? { test_event_code: testCode } : {}) };
}

export function eventosAtivos(env: EventosEnv): boolean {
  return env.META_CAPI_ATIVO === "true" && Boolean(env.META_DATASET_ID) && Boolean(env.META_CAPI_TOKEN || env.META_ADS_TOKEN);
}

export async function postarNaMeta(env: EventosEnv, corpo: Record<string, unknown>, fetchFn: typeof fetch): Promise<{ ok: boolean; status: number; texto: string }> {
  const token = env.META_CAPI_TOKEN || env.META_ADS_TOKEN;
  if (!token || !env.META_DATASET_ID) return { ok: false, status: 0, texto: "META_DATASET_ID ou token não configurado" };
  const res = await fetchFn(`https://graph.facebook.com/${META_API_VERSAO}/${env.META_DATASET_ID}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...corpo, access_token: token }) });
  return { ok: res.ok, status: res.status, texto: (await res.text()).slice(0, 1000) };
}

async function reservar(db: D1Database, e: EventoPlanejado, clienteId: string, retomarTeste: boolean, agora: string): Promise<boolean> {
  const preso = new Date(Date.parse(agora) - ENVIANDO_PRESO_MS).toISOString();
  const r = await db.prepare(`INSERT INTO meta_eventos (event_id, evento, cliente_id, pagamento_id, event_time, valor_cents, status, tentativas, criado_em, atualizado_em)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'enviando', 0, ?7, ?7)
    ON CONFLICT(event_id) DO UPDATE SET status = 'enviando', atualizado_em = excluded.atualizado_em
    WHERE (meta_eventos.status = 'erro' AND meta_eventos.tentativas < ?8) OR (meta_eventos.status = 'teste' AND ?9 = 1) OR (meta_eventos.status = 'enviando' AND meta_eventos.atualizado_em < ?10)`)
    .bind(e.event_id, e.evento, clienteId, e.pagamento_id, e.event_time, e.valor_cents, agora, META_TENTATIVAS_MAX, retomarTeste ? 1 : 0, preso).run();
  return (r.meta?.changes ?? 0) > 0;
}
async function marcar(db: D1Database, ids: string[], status: string, resposta: string): Promise<void> {
  for (const id of ids) await db.prepare("UPDATE meta_eventos SET status = ?2, resposta = ?3, atualizado_em = ?4, tentativas = tentativas + 1 WHERE event_id = ?1").bind(id, status, resposta.slice(0, 1000), nowIso()).run();
}
async function ignorar(db: D1Database, e: EventoPlanejado, clienteId: string, motivo: string): Promise<void> {
  await db.prepare("INSERT INTO meta_eventos (event_id, evento, cliente_id, pagamento_id, event_time, valor_cents, status, tentativas, resposta, criado_em, atualizado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ignorado', 0, ?7, ?8, ?8) ON CONFLICT(event_id) DO NOTHING")
    .bind(e.event_id, e.evento, clienteId, e.pagamento_id, e.event_time, e.valor_cents, motivo, nowIso()).run();
}

export async function lerClienteEv(db: D1Database, id: string): Promise<{ cliente: ClienteEv; pagamentos: PagamentoEv[] } | null> {
  const c = await db.prepare("SELECT id, email, telefone, nome, criado_em, fbclid, fbp, plano FROM clientes WHERE id = ?1").bind(id).first<ClienteEv>();
  if (!c) return null;
  const p = await db.prepare("SELECT id, pago_em, valor_cents FROM pagamentos WHERE cliente_id = ?1 ORDER BY pago_em, id").bind(id).all<PagamentoEv>();
  return { cliente: c, pagamentos: p.results.map((x) => ({ id: String(x.id), pago_em: String(x.pago_em), valor_cents: Number(x.valor_cents) })) };
}

export interface ResultadoCliente { cliente: string; enviados: string[]; ignorados: string[]; erros: string[] }

/** Monta, reserva e envia o que ainda não foi enviado deste cliente. Pode ser chamada quantas vezes for. */
export async function processarCliente(env: EventosEnv, clienteId: string, fetchFn: typeof fetch = fetch, agoraMs = Date.now()): Promise<ResultadoCliente> {
  const out: ResultadoCliente = { cliente: clienteId, enviados: [], ignorados: [], erros: [] };
  if (!eventosAtivos(env)) return out;
  const d = await lerClienteEv(env.DB, clienteId);
  if (!d) return out;
  const dados = dadosDeCorrespondencia(d.cliente);
  const agora = new Date(agoraMs).toISOString(), agoraS = Math.floor(agoraMs / 1000), testCode = env.META_TEST_EVENT_CODE || undefined;
  const reservados: EventoPlanejado[] = [];
  for (const e of planejarEventos(d.cliente, d.pagamentos)) {
    const ja = await env.DB.prepare("SELECT status FROM meta_eventos WHERE event_id = ?1").bind(e.event_id).first<{ status: string }>();
    if (ja && (ja.status === "enviado" || ja.status === "ignorado")) continue;
    if (agoraS - e.event_time > META_IDADE_MAX_S) { if (!ja) { await ignorar(env.DB, e, clienteId, "mais de 7 dias: a Meta recusa"); out.ignorados.push(e.event_id); } continue; }
    if (!dados.em && !dados.ph) { if (!ja) { await ignorar(env.DB, e, clienteId, "cliente sem e-mail e sem telefone"); out.ignorados.push(e.event_id); } continue; }
    if (await reservar(env.DB, e, clienteId, !testCode, agora)) reservados.push(e);
  }
  if (!reservados.length) return out;
  const ids = reservados.map((e) => e.event_id);
  try {
    const r = await postarNaMeta(env, corpoParaMeta(reservados, await userData(d.cliente, dados), testCode), fetchFn);
    if (r.ok) { await marcar(env.DB, ids, testCode ? "teste" : "enviado", r.texto); out.enviados.push(...ids); }
    else { await marcar(env.DB, ids, "erro", `HTTP ${r.status}: ${r.texto}`); out.erros.push(...ids.map((id) => `${id}: HTTP ${r.status}`)); }
  } catch (err) {
    await marcar(env.DB, ids, "erro", String(err));
    out.erros.push(...ids.map((id) => `${id}: ${String(err)}`));
  }
  return out;
}

/** Clientes criados ou com pagamento nos últimos 6 dias: pega o que o webhook perdeu e repete erros (cron diário). */
export async function varrerEventos(env: EventosEnv, fetchFn: typeof fetch = fetch, agora = new Date()): Promise<{ clientes: number; enviados: number; ignorados: number; erros: string[] }> {
  const de = new Date(agora.getTime() - 6 * 86_400_000).toISOString();
  const r = await env.DB.prepare("SELECT id FROM clientes WHERE criado_em >= ?1 UNION SELECT cliente_id FROM pagamentos WHERE pago_em >= ?2").bind(de, de.slice(0, 10)).all<{ id: string }>();
  const tot = { clientes: r.results.length, enviados: 0, ignorados: 0, erros: [] as string[] };
  for (const { id } of r.results) {
    const x = await processarCliente(env, String(id), fetchFn, agora.getTime());
    tot.enviados += x.enviados.length; tot.ignorados += x.ignorados.length; tot.erros.push(...x.erros);
  }
  return tot;
}

export async function resumoEventos(db: D1Database): Promise<{ por_status: Array<Record<string, unknown>>; ultimos_erros: Array<Record<string, unknown>> }> {
  const a = await db.prepare("SELECT evento, status, COUNT(*) AS n, SUM(valor_cents) AS valor_cents FROM meta_eventos WHERE criado_em >= datetime('now', '-30 days') GROUP BY evento, status ORDER BY evento, status").all<Record<string, unknown>>();
  const b = await db.prepare("SELECT event_id, evento, resposta, atualizado_em FROM meta_eventos WHERE status = 'erro' ORDER BY atualizado_em DESC LIMIT 10").all<Record<string, unknown>>();
  return { por_status: a.results, ultimos_erros: b.results };
}
