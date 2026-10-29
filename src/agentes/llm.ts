/**
 * Cliente de modelo pela OpenRouter (chat completions com resposta em JSON por esquema).
 *
 *   - cada agente tem um modelo principal e um reserva (variáveis do wrangler.toml); se o principal falhar
 *     (erro, tempo esgotado, JSON inválido), tenta o reserva uma vez;
 *   - toda chamada vai para llm_chamadas com tokens e custo; passou do teto diário (LLM_TETO_USD_DIA), o
 *     cliente recusa a chamada e o agente cai no seu fallback sem modelo;
 *   - a resposta é parseada e devolvida como objeto; a validação de conteúdo é de quem chamou.
 */
import { nowIso } from "../util.ts";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const LLM_TEMPO_LIMITE_MS = 90_000;
export const LLM_TETO_USD_DIA_PADRAO = 2;
const GUARDA_TEXTO = 20_000;

export interface LlmEnv {
  DB: D1Database;
  OPENROUTER_API_KEY?: string;
  LLM_TETO_USD_DIA?: string;
}

export interface PedidoLlm {
  agente: string;
  modelo: string;
  modeloReserva?: string;
  sistema: string;
  usuario: string;
  /** JSON Schema da resposta (strict). */
  esquema: Record<string, unknown>;
  nomeEsquema: string;
  temperatura?: number;
  maxTokens?: number;
  /** Raciocínio interno do modelo (OpenRouter `reasoning`): "none" para classificar e resumir, "low" para decidir. Padrão "none". */
  raciocinio?: "none" | "low" | "medium";
}

export interface RespostaLlm<T> {
  ok: true;
  dados: T;
  modelo: string;
  custo_usd: number | null;
  tokens: { entrada: number | null; saida: number | null };
}
export interface FalhaLlm {
  ok: false;
  erro: string;
}

const corta = (s: string): string => (s.length > GUARDA_TEXTO ? s.slice(0, GUARDA_TEXTO) + "…[cortado]" : s);

export function llmAtivo(env: LlmEnv): boolean {
  return Boolean(env.OPENROUTER_API_KEY);
}

export async function custoHoje(db: D1Database, agora = new Date()): Promise<number> {
  const inicio = new Date(agora.getTime() - 86_400_000).toISOString();
  const r = await db.prepare("SELECT SUM(custo_usd) AS c FROM llm_chamadas WHERE criado_em >= ?1").bind(inicio).first<{ c: unknown }>();
  return Number(r?.c ?? 0) || 0;
}

async function registrar(db: D1Database, x: { agente: string; modelo: string; ok: boolean; tokens_entrada?: number | null; tokens_saida?: number | null; custo_usd?: number | null; duracao_ms: number; entrada: string; saida?: string | null; erro?: string | null }): Promise<void> {
  await db
    .prepare("INSERT INTO llm_chamadas (agente, modelo, ok, tokens_entrada, tokens_saida, custo_usd, duracao_ms, entrada, saida, erro, criado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)")
    .bind(x.agente, x.modelo, x.ok ? 1 : 0, x.tokens_entrada ?? null, x.tokens_saida ?? null, x.custo_usd ?? null, x.duracao_ms, corta(x.entrada), x.saida == null ? null : corta(x.saida), x.erro ?? null, nowIso())
    .run();
}

/** Extrai o objeto JSON da resposta, tolerando cercas de código. */
export function extrairJson(texto: string): unknown {
  const t = texto.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("resposta sem JSON");
  }
}

async function umaChamada<T>(env: LlmEnv, p: PedidoLlm, modelo: string, fetchFn: typeof fetch): Promise<RespostaLlm<T>> {
  const inicio = Date.now();
  const corpo = {
    model: modelo,
    messages: [
      { role: "system", content: p.sistema },
      { role: "user", content: p.usuario },
    ],
    temperature: p.temperatura ?? 0.2,
    max_tokens: p.maxTokens ?? 4000,
    response_format: { type: "json_schema", json_schema: { name: p.nomeEsquema, strict: true, schema: p.esquema } },
    // sem isto, modelos com raciocínio gastam o max_tokens pensando e devolvem conteúdo vazio
    reasoning: p.raciocinio && p.raciocinio !== "none" ? { effort: p.raciocinio, exclude: true } : { enabled: false },
    usage: { include: true },
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LLM_TEMPO_LIMITE_MS);
  let texto = "";
  try {
    const res = await fetchFn(OPENROUTER_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "content-type": "application/json", "HTTP-Referer": "https://github.com/PitterLopes/gestor-trafego-ia", "X-Title": "Gestor de tráfego com IA" },
      body: JSON.stringify(corpo),
      signal: ctl.signal,
    });
    texto = await res.text();
    if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${texto.slice(0, 300)}`);
    const j = JSON.parse(texto) as { model?: string; choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }; error?: { message?: string } };
    if (j.error) throw new Error(`OpenRouter: ${j.error.message ?? "erro"}`);
    const escolha = j.choices?.[0];
    const conteudo = escolha?.message?.content;
    if (typeof conteudo !== "string" || !conteudo.trim()) throw new Error(escolha?.finish_reason === "length" ? `resposta cortada pelo max_tokens (${p.maxTokens ?? 4000}) antes de escrever o JSON` : "resposta vazia");
    const dados = extrairJson(conteudo) as T;
    const out: RespostaLlm<T> = {
      ok: true,
      dados,
      modelo: j.model ?? modelo,
      custo_usd: typeof j.usage?.cost === "number" ? j.usage.cost : null,
      tokens: { entrada: j.usage?.prompt_tokens ?? null, saida: j.usage?.completion_tokens ?? null },
    };
    await registrar(env.DB, { agente: p.agente, modelo: out.modelo, ok: true, tokens_entrada: out.tokens.entrada, tokens_saida: out.tokens.saida, custo_usd: out.custo_usd, duracao_ms: Date.now() - inicio, entrada: p.usuario, saida: conteudo });
    return out;
  } catch (e) {
    const erro = e instanceof Error && e.name === "AbortError" ? `tempo esgotado (${LLM_TEMPO_LIMITE_MS} ms)` : String(e);
    await registrar(env.DB, { agente: p.agente, modelo, ok: false, duracao_ms: Date.now() - inicio, entrada: p.usuario, saida: texto || null, erro });
    throw new Error(erro);
  } finally {
    clearTimeout(timer);
  }
}

/** Chama o modelo principal e, se falhar, o reserva. Nunca lança: devolve { ok: false } para o agente usar o fallback. */
export async function chamarLlm<T>(env: LlmEnv, p: PedidoLlm, fetchFn: typeof fetch = fetch, agora = new Date()): Promise<RespostaLlm<T> | FalhaLlm> {
  if (!llmAtivo(env)) return { ok: false, erro: "OPENROUTER_API_KEY não configurada" };
  const teto = Number(env.LLM_TETO_USD_DIA ?? LLM_TETO_USD_DIA_PADRAO) || LLM_TETO_USD_DIA_PADRAO;
  const gasto = await custoHoje(env.DB, agora);
  if (gasto >= teto) return { ok: false, erro: `teto diário de modelo atingido (US$ ${gasto.toFixed(2)} de ${teto})` };
  const erros: string[] = [];
  for (const modelo of [p.modelo, p.modeloReserva].filter((m): m is string => Boolean(m))) {
    try {
      return await umaChamada<T>(env, p, modelo, fetchFn);
    } catch (e) {
      erros.push(`${modelo}: ${String(e instanceof Error ? e.message : e)}`);
    }
  }
  return { ok: false, erro: erros.join(" | ") };
}

export async function resumoLlm(db: D1Database, dias = 7): Promise<Record<string, unknown>> {
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
  const porAgente = await db
    .prepare("SELECT agente, modelo, COUNT(*) AS chamadas, SUM(ok) AS ok, SUM(custo_usd) AS custo_usd, SUM(tokens_entrada) AS tokens_entrada, SUM(tokens_saida) AS tokens_saida FROM llm_chamadas WHERE criado_em >= ?1 GROUP BY agente, modelo ORDER BY agente")
    .bind(desde)
    .all();
  const ultimas = await db.prepare("SELECT id, agente, modelo, ok, custo_usd, duracao_ms, erro, criado_em FROM llm_chamadas ORDER BY id DESC LIMIT 20").all();
  return { dias, por_agente: porAgente.results, ultimas: ultimas.results, custo_24h_usd: await custoHoje(db) };
}
