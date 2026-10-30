/**
 * Vigia: o que faz um gestor de tráfego olhar a conta "só para ver se está tudo bem". Roda de hora em hora
 * (leve) e na rodada da madrugada (completo). Age no que é código e avisa no resto.
 *
 *   - anúncio reprovado ou com problema (status ao vivo na Meta)      → alerta grave (recurso é humano)
 *   - gasto de hoje acima de VIGIA_TETO_DIA_PCT do teto               → alerta grave + pausa as campanhas ativas (fila, origem vigia)
 *   - campanha ativa que gastou zero ontem                            → alerta (entrega travada, cobrança, aprendizado)
 *   - erro de execução ou de publicação registrado nas últimas 24 h   → alerta
 *
 * Alertas são únicos por chave e dia (tabela alertas) e vão por e-mail aos administradores do painel.
 */
import { META_API_VERSAO } from "../meta_versao.ts";
import { TETO_DIARIO_CENTS } from "../analista.ts";
import { diaBrt } from "../anuncios.ts";
import { addDays, nowIso } from "../util.ts";

export const VIGIA_TETO_DIA_PCT = 105;

export interface VigiaEnv {
  DB: D1Database;
  META_ADS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
  EMAIL?: { send(m: { to: string; from: string | { email: string; name: string }; subject: string; html: string; text: string }): Promise<{ messageId: string }> };
  EMAIL_REMETENTE?: string;
  ALERTA_EMAILS?: string;
  APP_URL?: string;
}

export interface Alerta {
  chave: string;
  gravidade: "aviso" | "grave";
  titulo: string;
  texto: string;
  acao?: string | null;
}

const n = (v: unknown): number => Number(v ?? 0) || 0;

/** Campanhas ativas pela lista da plataforma (ads_campanhas), inclusive as que ainda não gastaram. */
async function campanhasAtivas(db: D1Database): Promise<Array<{ plataforma: string; campanha_id: string; campanha: string; orcamento_diario_cents: number | null }>> {
  const r = await db.prepare("SELECT plataforma, campanha_id, campanha, orcamento_diario_cents FROM ads_campanhas WHERE status = 'ACTIVE' ORDER BY campanha").all<Record<string, unknown>>();
  return r.results.map((x) => ({ plataforma: String(x.plataforma), campanha_id: String(x.campanha_id), campanha: String(x.campanha), orcamento_diario_cents: x.orcamento_diario_cents == null ? null : n(x.orcamento_diario_cents) }));
}
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

/** Grava o alerta se ainda não existir hoje. Devolve true quando é novo. */
export async function registrarAlerta(db: D1Database, dia: string, agente: string, a: Alerta): Promise<boolean> {
  const r = await db
    .prepare("INSERT OR IGNORE INTO alertas (dia, chave, agente, gravidade, titulo, texto, acao, criado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(dia, a.chave, agente, a.gravidade, a.titulo.slice(0, 200), a.texto.slice(0, 2000), a.acao ?? null, nowIso())
    .run();
  return n(r.meta.changes) > 0;
}

/** Quem recebe alertas e relatórios: a variável ALERTA_EMAILS (separados por vírgula). */
export function emailsAdmin(env: { ALERTA_EMAILS?: string }): string[] {
  return [...new Set((env.ALERTA_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
}

/** Manda por e-mail os alertas novos do dia ainda não enviados. Sem binding de e-mail, só marca. */
export async function enviarAlertas(env: VigiaEnv, dia: string): Promise<number> {
  const pend = await env.DB.prepare("SELECT id, gravidade, titulo, texto, acao FROM alertas WHERE dia = ?1 AND enviado_em IS NULL ORDER BY id").bind(dia).all<{ id: number; gravidade: string; titulo: string; texto: string; acao: string | null }>();
  if (!pend.results.length) return 0;
  const para = emailsAdmin(env);
  if (env.EMAIL && para.length) {
    const linhas = pend.results.map((a) => `[${a.gravidade === "grave" ? "GRAVE" : "aviso"}] ${a.titulo}\n${a.texto}${a.acao ? `\nO sistema fez: ${a.acao}` : ""}`);
    const texto = `Alertas do time de tráfego em ${dia}:\n\n${linhas.join("\n\n")}\n\nPainel: ${env.APP_URL ?? ""}/#campanhas`;
    const html = `<p>Alertas do time de tráfego em ${esc(dia)}:</p>${pend.results.map((a) => `<p><b>[${a.gravidade === "grave" ? "GRAVE" : "aviso"}] ${esc(a.titulo)}</b><br>${esc(a.texto)}${a.acao ? `<br><i>O sistema fez: ${esc(a.acao)}</i>` : ""}</p>`).join("")}<p><a href="${esc(env.APP_URL ?? "")}/#campanhas">Abrir o painel</a></p>`;
    const grave = pend.results.some((a) => a.gravidade === "grave");
    for (const to of para) {
      try {
        await env.EMAIL.send({ to, from: { email: env.EMAIL_REMETENTE ?? "alertas@example.com", name: "Time de tráfego" }, subject: `${grave ? "GRAVE: " : ""}${pend.results.length} alerta(s) dos anúncios · ${dia}`, html, text: texto });
      } catch {
        // e-mail é melhor esforço: o alerta continua no painel
      }
    }
  }
  await env.DB.prepare("UPDATE alertas SET enviado_em = ?2 WHERE dia = ?1 AND enviado_em IS NULL").bind(dia, nowIso()).run();
  return pend.results.length;
}

async function getMeta(env: VigiaEnv, caminho: string, fetchFn: typeof fetch): Promise<Record<string, unknown>> {
  const res = await fetchFn(`https://graph.facebook.com/${META_API_VERSAO}/${caminho}`, { headers: { authorization: `Bearer ${env.META_ADS_TOKEN}`, accept: "application/json" } });
  const t = await res.text();
  if (!res.ok) throw new Error(`Meta HTTP ${res.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t) as Record<string, unknown>;
}

/** Anúncios reprovados ou com problema, ao vivo. */
export async function anunciosComProblema(env: VigiaEnv, fetchFn: typeof fetch): Promise<Array<{ id: string; name: string; status: string; motivo: string }>> {
  const q = new URLSearchParams({ fields: "id,name,effective_status,issues_info", limit: "200", filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["DISAPPROVED", "WITH_ISSUES"] }]) });
  const j = await getMeta(env, `act_${env.META_AD_ACCOUNT_ID}/ads?${q}`, fetchFn);
  const dados = Array.isArray(j.data) ? (j.data as Array<Record<string, unknown>>) : [];
  return dados.map((a) => ({
    id: String(a.id), name: String(a.name ?? a.id), status: String(a.effective_status ?? ""),
    motivo: Array.isArray(a.issues_info) ? (a.issues_info as Array<{ error_summary?: string; error_message?: string }>).map((i) => i.error_summary ?? i.error_message ?? "").filter(Boolean).join("; ") : "",
  }));
}

/** Gasto da conta hoje, em centavos. */
export async function gastoHoje(env: VigiaEnv, fetchFn: typeof fetch): Promise<number> {
  const j = await getMeta(env, `act_${env.META_AD_ACCOUNT_ID}/insights?date_preset=today&fields=spend`, fetchFn);
  const dados = Array.isArray(j.data) ? (j.data as Array<{ spend?: string }>) : [];
  return Math.round(Number(dados[0]?.spend ?? 0) * 100) || 0;
}

export interface ResultadoVigia {
  modo: "horario" | "completo";
  alertas_novos: number;
  enviados: number;
  pausas_enfileiradas: number;
  erros: string[];
}

export async function rodarVigia(env: VigiaEnv, modo: "horario" | "completo", nivel: number, fetchFn: typeof fetch = fetch, agora = new Date()): Promise<ResultadoVigia> {
  const dia = diaBrt(agora);
  const out: ResultadoVigia = { modo, alertas_novos: 0, enviados: 0, pausas_enfileiradas: 0, erros: [] };
  const novo = async (a: Alerta) => { if (await registrarAlerta(env.DB, dia, "vigia", a)) out.alertas_novos += 1; };
  const temMeta = Boolean(env.META_ADS_TOKEN && env.META_AD_ACCOUNT_ID);

  // 1. reprovados / com problema
  if (temMeta) {
    try {
      for (const a of await anunciosComProblema(env, fetchFn)) await novo({ chave: `problema:${a.id}`, gravidade: "grave", titulo: `Anúncio ${a.status === "DISAPPROVED" ? "reprovado" : "com problema"}: ${a.name}`, texto: a.motivo || "A Meta não detalhou o motivo. Abra o Gerenciador de Anúncios para ver e, se for o caso, pedir revisão.", acao: null });
    } catch (e) { out.erros.push(`problemas: ${String(e)}`); }
  }

  // 2. teto do dia
  if (temMeta) {
    try {
      const gasto = await gastoHoje(env, fetchFn);
      const limite = Math.round(TETO_DIARIO_CENTS * VIGIA_TETO_DIA_PCT / 100);
      if (gasto > limite) {
        const ativas = await campanhasAtivas(env.DB);
        let enfileiradas = 0;
        for (const c of ativas) {
          const ja = await env.DB.prepare("SELECT id FROM ads_acoes WHERE dia = ?1 AND origem = 'vigia' AND alvo_id = ?2 AND tipo = 'pausar'").bind(dia, c.campanha_id).first();
          if (ja) continue;
          if (nivel >= 2) {
            await env.DB.prepare("INSERT INTO ads_acoes (dia, origem, plataforma, alvo_tipo, alvo_id, alvo_nome, tipo, valor_anterior_cents, motivo, status, criado_em) VALUES (?1, 'vigia', ?2, 'campanha', ?3, ?4, 'pausar', ?5, ?6, 'pendente', ?7)")
              .bind(dia, c.plataforma, c.campanha_id, c.campanha, c.orcamento_diario_cents, `gasto de hoje R$ ${(gasto / 100).toFixed(2)} passou de ${VIGIA_TETO_DIA_PCT}% do teto (R$ ${(limite / 100).toFixed(2)})`, nowIso()).run();
            enfileiradas += 1;
          }
        }
        out.pausas_enfileiradas = enfileiradas;
        await novo({ chave: "teto_dia", gravidade: "grave", titulo: `Gasto de hoje passou do teto: R$ ${(gasto / 100).toFixed(2)}`, texto: `O limite é R$ ${(limite / 100).toFixed(2)} (${VIGIA_TETO_DIA_PCT}% de R$ ${(TETO_DIARIO_CENTS / 100).toFixed(2)}).`, acao: nivel >= 2 ? `enfileirou pausa de ${enfileiradas} campanha(s) ativa(s); o Gestor executa em seguida` : "nível do vigia não permite pausar; só avisou" });
      }
    } catch (e) { out.erros.push(`teto: ${String(e)}`); }
  }

  if (modo === "completo") {
    // 3. campanha ativa que gastou zero ontem
    const ontem = diaBrt(addDays(agora, -1));
    for (const c of await campanhasAtivas(env.DB)) {
      const g = await env.DB.prepare("SELECT gasto_cents FROM ads_gasto_diario WHERE dia = ?1 AND campanha_id = ?2").bind(ontem, c.campanha_id).first<{ gasto_cents: number }>();
      if (!g || n(g.gasto_cents) === 0) await novo({ chave: `sem_gasto:${c.campanha_id}`, gravidade: "aviso", titulo: `Campanha ativa sem gasto ontem: ${c.campanha}`, texto: "Pode ser entrega travada, cobrança recusada, anúncio em análise ou orçamento no conjunto. Vale abrir o Gerenciador.", acao: null });
    }
    // 4. erros do time nas últimas 24 h
    // só a falha que ainda vale: a última rodada daquele agente falhou (se ele rodou bem depois, já se resolveu)
    const erros = await env.DB.prepare(
      `SELECT e.agente, e.resumo, e.criado_em FROM agentes_execucoes e
        WHERE e.ok = 0 AND e.criado_em >= ?1
          AND NOT EXISTS (SELECT 1 FROM agentes_execucoes d WHERE d.agente = e.agente AND d.ok = 1 AND d.id > e.id)
        ORDER BY e.id DESC LIMIT 5`,
    ).bind(new Date(agora.getTime() - 86_400_000).toISOString()).all<{ agente: string; resumo: string; criado_em: string }>();
    const vistos = new Set<string>();
    for (const e of erros.results) {
      if (vistos.has(e.agente)) continue;
      vistos.add(e.agente);
      const quando = new Date(e.criado_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      await novo({ chave: `erro:${e.agente}`, gravidade: "aviso", titulo: `O agente ${e.agente} falhou`, texto: `Última rodada (${quando}): ${e.resumo}${await detalheDoErro(env.DB, e.agente, e.criado_em)}`.slice(0, 700), acao: null });
    }
    const acoesErro = await env.DB.prepare("SELECT id, alvo_nome, tipo, resposta FROM ads_acoes WHERE status = 'erro' AND criado_em >= ?1 ORDER BY id DESC LIMIT 5").bind(new Date(agora.getTime() - 86_400_000).toISOString()).all<{ id: number; alvo_nome: string | null; tipo: string; resposta: string | null }>();
    for (const a of acoesErro.results) await novo({ chave: `acao_erro:${a.id}`, gravidade: "aviso", titulo: `A Meta recusou a ação "${a.tipo}" em ${a.alvo_nome ?? "?"}`, texto: a.resposta ?? "", acao: null });
  }

  try { out.enviados = await enviarAlertas(env, dia); } catch (e) { out.erros.push(`e-mail: ${String(e)}`); }
  return out;
}

/** O que de fato falhou, quando o resumo da rodada só traz contagens (ex.: o Criador diz "1 erros"). */
async function detalheDoErro(db: D1Database, agente: string, quando: string): Promise<string> {
  if (agente !== "criador") return "";
  const de = new Date(Date.parse(quando) - 15 * 60_000).toISOString();
  const r = await db.prepare("SELECT id, resposta FROM ads_criativos WHERE status = 'erro' AND criado_em >= ?1 AND criado_em <= ?2 ORDER BY id DESC LIMIT 1").bind(de, quando).first<{ id: number; resposta: string | null }>();
  return r?.resposta ? ` · criativo nº ${r.id}: ${r.resposta.slice(0, 300)}` : "";
}

export async function listarAlertas(db: D1Database, dias = 14): Promise<Array<Record<string, unknown>>> {
  const de = diaBrt(addDays(new Date(), -(dias - 1)));
  const r = await db.prepare("SELECT id, dia, chave, agente, gravidade, titulo, texto, acao, enviado_em, criado_em FROM alertas WHERE dia >= ?1 ORDER BY id DESC LIMIT 50").bind(de).all();
  return r.results;
}
