/**
 * Gestor de tráfego com IA: um Worker na Cloudflare que lê a conta de anúncios, cruza com o pagamento e
 * decide sozinho dentro de limites escritos no código. Veja README.md (o que é) e CLAUDE.md (como instalar).
 *
 * Rotas (todas com Authorization: Bearer ADMIN_TOKEN, exceto /health):
 *   GET  /health                                   o que está configurado
 *   GET  /painel?token=ADMIN_TOKEN                 página simples com estado, ações, criativos, plano, relatório e alertas
 *   GET  /painel/criativos/<id>.png?token=         imagem de um criativo gerado
 *   POST /admin/anuncios/varrer[?dias=7]           relê gasto e campanhas na Meta
 *   GET  /admin/anuncios · GET /admin/analista     gasto por mês · decisões das regras
 *   POST /admin/analista/rodar                     regras determinísticas agora
 *   GET  /admin/agentes · GET /admin/agentes/dossie
 *   POST /admin/agentes/rodar                      Vigia → Estrategista → Analista (IA) → Gestor → Criador (+ Públicos e Relator às segundas)
 *   PUT  /admin/agentes/estado?agente=&nivel=0|1|2&parado=0|1
 *   POST /admin/agentes/vigia · /estrategista[?forcar=1] · /relator[?forcar=1] · /publicos
 *   POST /admin/criativos/pedir?angulo=            pede um criativo
 *   GET  /admin/criativos/<id>.png · GET /admin/criativos/biblioteca
 *   GET  /admin/paginas · POST /admin/paginas/atualizar[?forcar=1]
 *   POST /admin/pagamento/importar?tabela=clientes|pagamentos   corpo: CSV (veja migrations/0001_pagamento.sql)
 *
 * Cron: "0 6 * * *" (03:00 de Brasília) roda a coleta, as regras e o time; "20 * * * *" roda só o Vigia.
 */
import type { BrowserWorker } from "@cloudflare/puppeteer";
import { metaGastoAtivo, resumoGasto, varrerGasto } from "./anuncios.ts";
import { resumoAnalista, rodarAnalista } from "./analista.ts";
import { painelAgentes, rodarEquipe, rodarVigiaHorario } from "./agentes/equipe.ts";
import { gravarEstado, lerEstado } from "./agentes/gestor.ts";
import { montarDossie } from "./agentes/dossie.ts";
import { contextoDoCriador, registrarPedido } from "./agentes/criador.ts";
import { montarBiblioteca } from "./agentes/biblioteca.ts";
import { atualizarPaginas, lerResumos } from "./agentes/paginas.ts";
import { rodarEstrategista } from "./agentes/estrategista.ts";
import { rodarRelator } from "./agentes/relator.ts";
import { rodarPublicos } from "./agentes/publicos.ts";
import { renderizarPng } from "./agentes/render.ts";
import { diaBrt } from "./anuncios.ts";
import { importarCsv } from "./fontes/pagamento.ts";
import { paginaPainel } from "./painel.ts";
import { clampInt, json, timingSafeEqual } from "./util.ts";

export interface Env {
  DB: D1Database;
  BROWSER?: BrowserWorker;
  CRIATIVOS?: R2Bucket;
  EMAIL?: { send(m: { to: string; from: string | { email: string; name: string }; subject: string; html: string; text: string }): Promise<{ messageId: string }> };
  ADMIN_TOKEN?: string;
  APP_URL?: string;
  // Meta
  META_ADS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
  META_PAGE_ID?: string;
  META_ADSET_CRIADOR_ID?: string;
  // modelos
  OPENROUTER_API_KEY?: string;
  LLM_TETO_USD_DIA?: string;
  LLM_MODELO_ANALISTA?: string;
  LLM_MODELO_ANALISTA_RESERVA?: string;
  LLM_MODELO_CRIADOR?: string;
  LLM_MODELO_VERIFICADOR?: string;
  // criador e páginas
  CRIADOR_LINK?: string;
  CRIADOR_PAGINAS?: string;
  // alertas
  ALERTA_EMAILS?: string;
  EMAIL_REMETENTE?: string;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function bearerOk(request: Request, token: string | undefined, url: URL): boolean {
  if (!token) return false;
  const h = request.headers.get("authorization") ?? "";
  const dado = h.startsWith("Bearer ") ? h.slice(7).trim() : (url.searchParams.get("token") ?? "");
  return dado.length > 0 && timingSafeEqual(dado, token);
}

function renderDe(env: Env) {
  return env.BROWSER ? (html: string, l: number, a: number) => renderizarPng(env.BROWSER!, html, l, a) : undefined;
}

async function admin(path: string, request: Request, url: URL, env: Env): Promise<Response> {
  const method = request.method;
  if (path === "/admin/anuncios" && method === "GET") return json({ meta_ativo: metaGastoAtivo(env), conta: env.META_AD_ACCOUNT_ID ?? null, ...(await resumoGasto(env.DB)) });
  if (path === "/admin/anuncios/varrer" && method === "POST") {
    if (!metaGastoAtivo(env)) throw new HttpError(503, "coleta desligada: faltam META_ADS_TOKEN e META_AD_ACCOUNT_ID");
    return json(await varrerGasto(env, fetch, new Date(), clampInt(url.searchParams.get("dias"), 7, 1, 90)));
  }
  if (path === "/admin/analista" && method === "GET") return json(await resumoAnalista(env.DB, clampInt(url.searchParams.get("dias"), 14, 1, 90)));
  if (path === "/admin/analista/rodar" && method === "POST") return json(await rodarAnalista(env));
  if (path === "/admin/agentes" && method === "GET") return json(await painelAgentes(env));
  if (path === "/admin/agentes/dossie" && method === "GET") return json(await montarDossie(env.DB));
  if (path === "/admin/agentes/rodar" && method === "POST") return json(await rodarEquipe(env, "manual", fetch, new Date(), renderDe(env)));
  if (path === "/admin/agentes/estado" && method === "PUT") {
    const agente = url.searchParams.get("agente");
    if (!agente || !/^[a-z]+$/.test(agente)) throw new HttpError(400, "informe ?agente=<nome>&nivel=0|1|2&parado=0|1");
    const nivelS = url.searchParams.get("nivel"), paradoS = url.searchParams.get("parado");
    await gravarEstado(env.DB, agente, nivelS == null ? null : clampInt(nivelS, 1, 0, 2), paradoS == null ? null : paradoS === "1" || paradoS === "true", "token de administrador");
    return json({ ok: true, estado: await lerEstado(env.DB) });
  }
  if (path === "/admin/agentes/vigia" && method === "POST") return json(await rodarVigiaHorario(env));
  if (path === "/admin/agentes/estrategista" && method === "POST") return json(await rodarEstrategista(env, fetch, new Date(), url.searchParams.get("forcar") === "1"));
  if (path === "/admin/agentes/relator" && method === "POST") return json(await rodarRelator(env, fetch, new Date(), url.searchParams.get("forcar") === "1"));
  if (path === "/admin/agentes/publicos" && method === "POST") return json(await rodarPublicos(env, (await lerEstado(env.DB)).publicos?.nivel ?? 0));
  if (path === "/admin/criativos/pedir" && method === "POST") {
    const angulo = (url.searchParams.get("angulo") ?? "").trim();
    if (angulo.length < 10) throw new HttpError(400, "informe ?angulo=<a ideia do anúncio, em uma frase>");
    return json({ ok: true, pedido: await registrarPedido(env.DB, diaBrt(new Date()), "manual", { plataforma: "meta", campanha_id: null, campanha: null, angulo, motivo: url.searchParams.get("motivo") ?? "pedido manual" }) });
  }
  if (path === "/admin/criativos/biblioteca" && method === "GET") return json({ biblioteca: await montarBiblioteca(env.DB), prompt: await contextoDoCriador(env, new Date()) });
  if (path === "/admin/paginas" && method === "GET") return json({ paginas: await lerResumos(env.DB) });
  if (path === "/admin/paginas/atualizar" && method === "POST") return json({ resultado: await atualizarPaginas(env, fetch, new Date(), url.searchParams.get("forcar") === "1") });
  if (path === "/admin/pagamento/importar" && method === "POST") {
    const tabela = url.searchParams.get("tabela");
    if (tabela !== "clientes" && tabela !== "pagamentos") throw new HttpError(400, "informe ?tabela=clientes ou ?tabela=pagamentos e o CSV no corpo");
    return json(await importarCsv(env.DB, tabela, await request.text()));
  }
  const png = /^\/admin\/criativos\/(\d+)\.png$/.exec(path);
  if (png && method === "GET") return imagem(env, png[1]);
  throw new HttpError(404, "não encontrado");
}

async function imagem(env: Env, id: string): Promise<Response> {
  if (!env.CRIATIVOS) throw new HttpError(503, "R2 CRIATIVOS não configurado");
  const obj = await env.CRIATIVOS.get(`criativos/${id}.png`);
  if (!obj) throw new HttpError(404, "imagem não encontrada");
  return new Response(obj.body, { headers: { "content-type": "image/png", "cache-control": "private, max-age=300" } });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/health") {
        return json({
          ok: true,
          configurado: {
            admin_token: Boolean(env.ADMIN_TOKEN), meta_token: Boolean(env.META_ADS_TOKEN), meta_conta: Boolean(env.META_AD_ACCOUNT_ID),
            meta_pagina: Boolean(env.META_PAGE_ID), meta_conjunto_criador: Boolean(env.META_ADSET_CRIADOR_ID), openrouter: Boolean(env.OPENROUTER_API_KEY),
            navegador: Boolean(env.BROWSER), r2: Boolean(env.CRIATIVOS), email: Boolean(env.EMAIL), alerta_emails: Boolean(env.ALERTA_EMAILS), paginas: Boolean(env.CRIADOR_PAGINAS || env.CRIADOR_LINK),
          },
        });
      }
      if (!bearerOk(request, env.ADMIN_TOKEN, url)) return json({ error: env.ADMIN_TOKEN ? "não autorizado" : "ADMIN_TOKEN não configurado: grave com `npx wrangler secret put ADMIN_TOKEN`" }, 401);
      if (path === "/painel" && request.method === "GET") return new Response(paginaPainel(await painelAgentes(env), url.searchParams.get("token") ?? ""), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      const pngPainel = /^\/painel\/criativos\/(\d+)\.png$/.exec(path);
      if (pngPainel && request.method === "GET") return imagem(env, pngPainel[1]);
      if (path.startsWith("/admin/")) return await admin(path, request, url, env);
      throw new HttpError(404, "não encontrado");
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      return json({ error: String(e) }, 500);
    }
  },

  async scheduled(event, env, ctx): Promise<void> {
    if (event.cron === "0 6 * * *") {
      ctx.waitUntil((async () => {
        if (metaGastoAtivo(env)) await varrerGasto(env);
        await rodarAnalista(env);
        await rodarEquipe(env, "cron", fetch, new Date(), renderDe(env));
      })());
    } else {
      ctx.waitUntil(rodarVigiaHorario(env));
    }
  },
} satisfies ExportedHandler<Env>;
