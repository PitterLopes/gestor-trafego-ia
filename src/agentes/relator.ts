/**
 * Relator: toda segunda escreve, em português, o que aconteceu nos 7 dias: gasto, cadastros, entradas,
 * clientes, ações do Gestor, criativos, alertas, custo de modelo e o plano da semana. O texto vem de um modelo
 * barato a partir de números que o código montou (o modelo não inventa número: recebe a tabela pronta). Vai
 * por e-mail aos administradores e fica no painel.
 */
import { diaBrt } from "../anuncios.ts";
import { lerConta } from "../analista.ts";
import { addDays, nowIso } from "../util.ts";
import { chamarLlm } from "./llm.ts";
import type { LlmEnv } from "./llm.ts";
import { lerPlanoAtual, semanaIso } from "./estrategista.ts";
import { emailsAdmin } from "./vigia.ts";
import * as pagamento from "../fontes/pagamento.ts";

export interface RelatorEnv extends LlmEnv {
  LLM_MODELO_VERIFICADOR?: string;
  EMAIL?: { send(m: { to: string; from: string | { email: string; name: string }; subject: string; html: string; text: string }): Promise<{ messageId: string }> };
  EMAIL_REMETENTE?: string;
  ALERTA_EMAILS?: string;
  APP_URL?: string;
}

const n = (v: unknown): number => Number(v ?? 0) || 0;
const reais = (c: number): string => `R$ ${(c / 100).toFixed(2).replace(".", ",")}`;

export async function dadosDaSemana(db: D1Database, agora: Date): Promise<Record<string, unknown>> {
  const de = diaBrt(addDays(agora, -7)), ate = diaBrt(addDays(agora, -1));
  const deAnt = diaBrt(addDays(agora, -14)), ateAnt = diaBrt(addDays(agora, -8));
  const soma = async (d1: string, d2: string) => {
    const g = await db.prepare("SELECT SUM(gasto_cents) AS g, SUM(resultados) AS c FROM ads_gasto_diario WHERE dia BETWEEN ?1 AND ?2").bind(d1, d2).first<{ g: unknown; c: unknown }>();
    const gasto = n(g?.g), cad = n(g?.c), ent = await pagamento.entradas(db, d1, d2), cli = await pagamento.clientes(db, d1, d2);
    return { gasto_cents: gasto, cadastros: cad, entradas: ent, clientes: cli, custo_cadastro_cents: cad ? Math.round(gasto / cad) : null, custo_cliente_cents: cli ? Math.round(gasto / cli) : null };
  };
  const [semana, anterior, conta] = await Promise.all([soma(de, ate), soma(deAnt, ateAnt), lerConta(db, agora)]);
  const acoes = await db.prepare("SELECT tipo, alvo_nome, status, valor_anterior_cents, valor_cents, origem FROM ads_acoes WHERE dia BETWEEN ?1 AND ?2 AND status IN ('executada', 'revertida', 'erro') ORDER BY id").bind(de, ate).all();
  const criativos = await db.prepare("SELECT status, angulo FROM ads_criativos WHERE dia BETWEEN ?1 AND ?2 ORDER BY id").bind(de, ate).all();
  const alertas = await db.prepare("SELECT gravidade, titulo FROM alertas WHERE dia BETWEEN ?1 AND ?2 ORDER BY id DESC LIMIT 10").bind(de, ate).all();
  const custo = await db.prepare("SELECT SUM(custo_usd) AS c, COUNT(*) AS n FROM llm_chamadas WHERE criado_em >= ?1").bind(new Date(agora.getTime() - 7 * 86_400_000).toISOString()).first<{ c: unknown; n: unknown }>();
  const plano = await lerPlanoAtual(db, agora);
  return { periodo: { de, ate }, semana, anterior, coorte: { clientes: conta.coorte_clientes, seguiram: conta.coorte_seguiram }, acoes: acoes.results, criativos: criativos.results, alertas: alertas.results, modelo: { custo_usd: Number((n(custo?.c)).toFixed(4)), chamadas: n(custo?.n) }, plano: plano ? { semana: plano.semana, resumo: plano.resumo } : null };
}

const SISTEMA = `Você escreve o relatório semanal dos anúncios para os sócios de uma empresa de software, em português do Brasil. Recebe os números prontos em JSON (semana e semana anterior, ações que o sistema executou, criativos, alertas, custo de modelo e o plano da semana). Escreva em texto corrido, 4 a 7 frases curtas, sem markdown, sem adjetivos vazios, com os números exatos do JSON (valores em centavos: converta para reais com vírgula). Comece pelo que importa: custo por cliente e por cadastro, e se melhorou ou piorou contra a semana anterior. Diga o que o sistema fez sozinho e o que pede decisão humana. Termine com uma frase sobre o plano da semana, se houver.`;

export async function rodarRelator(env: RelatorEnv, fetchFn: typeof fetch = fetch, agora = new Date(), forcar = false): Promise<{ semana: string; feito: boolean; motivo: string; texto?: string; enviado_para?: string[] }> {
  const semana = semanaIso(agora);
  const existe = await env.DB.prepare("SELECT semana FROM relatorios WHERE semana = ?1").bind(semana).first();
  if (existe && !forcar) return { semana, feito: false, motivo: "a semana já tem relatório" };
  const dados = await dadosDaSemana(env.DB, agora);
  const r = await chamarLlm<{ texto: string }>(env, {
    agente: "relator",
    modelo: env.LLM_MODELO_VERIFICADOR || "anthropic/claude-haiku-5.5",
    modeloReserva: "deepseek/deepseek-v4.1-flash",
    sistema: SISTEMA,
    usuario: JSON.stringify(dados),
    esquema: { type: "object", additionalProperties: false, required: ["texto"], properties: { texto: { type: "string" } } },
    nomeEsquema: "relatorio_semanal",
    temperatura: 0.2,
    maxTokens: 1500,
    raciocinio: "none",
  }, fetchFn, agora);
  const s = dados.semana as { gasto_cents: number; cadastros: number; entradas: number; clientes: number; custo_cadastro_cents: number | null; custo_cliente_cents: number | null };
  const cabecalho = `Semana ${(dados.periodo as { de: string }).de} a ${(dados.periodo as { ate: string }).ate}: ${reais(s.gasto_cents)} gastos, ${s.cadastros} cadastros${s.custo_cadastro_cents != null ? ` (${reais(s.custo_cadastro_cents)} cada)` : ""}, ${s.entradas} entradas, ${s.clientes} clientes${s.custo_cliente_cents != null ? ` (${reais(s.custo_cliente_cents)} cada)` : ""}.`;
  const texto = r.ok && typeof r.dados?.texto === "string" && r.dados.texto.trim() ? r.dados.texto.trim() : `${cabecalho} (Resumo automático: o modelo não respondeu${r.ok ? "" : `: ${r.erro}`}.)`;
  const para = emailsAdmin(env);
  if (env.EMAIL && para.length) {
    for (const to of para) {
      try { await env.EMAIL.send({ to, from: { email: env.EMAIL_REMETENTE ?? "alertas@example.com", name: "Time de tráfego" }, subject: `Relatório dos anúncios · ${semana}`, html: `<p>${texto.replace(/\n/g, "<br>")}</p><p><a href="${env.APP_URL ?? ""}/#campanhas">Abrir o painel</a></p>`, text: `${texto}\n\n${env.APP_URL ?? ""}/#campanhas` }); } catch { /* melhor esforço */ }
    }
  }
  await env.DB
    .prepare("INSERT INTO relatorios (semana, dia, modelo, texto, dados_json, enviado_para, criado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (semana) DO UPDATE SET dia = excluded.dia, modelo = excluded.modelo, texto = excluded.texto, dados_json = excluded.dados_json, enviado_para = excluded.enviado_para, criado_em = excluded.criado_em")
    .bind(semana, diaBrt(agora), r.ok ? r.modelo : null, texto.slice(0, 6000), JSON.stringify(dados).slice(0, 20_000), para.join(","), nowIso())
    .run();
  return { semana, feito: true, motivo: "relatório escrito", texto, enviado_para: para };
}

export async function lerRelatorioAtual(db: D1Database): Promise<{ semana: string; dia: string; texto: string } | null> {
  const r = await db.prepare("SELECT semana, dia, texto FROM relatorios ORDER BY semana DESC LIMIT 1").first<{ semana: string; dia: string; texto: string }>();
  return r ?? null;
}
