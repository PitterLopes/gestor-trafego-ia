/**
 * Gestor de tráfego com IA: um Worker na Cloudflare que recebe o seu pagamento, mede o negócio, manda os eventos
 * para a Meta, lê a conta de anúncios e decide sozinho dentro de limites escritos no código.
 * Veja README.md (o que é) e CLAUDE.md (como instalar).
 *
 * Público:
 *   GET  /health                                   o que está configurado
 *   GET  /captura.js · POST /lead                  captura do clique na landing page (docs/landing.md)
 *   POST /webhook/pagamento/<fonte>?token=         generico | iugu | stripe | asaas (docs/integracoes.md)
 *   GET  /entrar · /auth/*                          login por e-mail + código
 * Painel (sessão, ou ?token=ADMIN_TOKEN):
 *   GET  /painel                                   negócio, time, criativos (com aprovação), plano, relatório, alertas
 *   GET  /painel/criativos/<id>.png|.webm|-capa.png
 *   POST /painel/criativos/<id>/(publicar|reprovar|melhorar)   formulário do painel
 * Administração (Authorization: Bearer ADMIN_TOKEN):
 *   POST /admin/anuncios/varrer[?dias=7] · GET /admin/anuncios · GET /admin/analista · POST /admin/analista/rodar
 *   GET  /admin/agentes · /dossie · POST /admin/agentes/rodar · PUT /admin/agentes/estado?agente=&nivel=&parado=
 *   POST /admin/agentes/vigia · /estrategista[?forcar=1] · /relator[?forcar=1] · /publicos
 *   POST /admin/criativos/pedir?angulo=&formato=imagem|video · POST /admin/criativos/pedidos/<id>/gerar[?nivel=1]
 *   GET  /admin/criativos/<id>.png|.webm · /biblioteca
 *   POST /admin/criativos/<id>/(publicar|reprovar|melhorar)
 *   GET  /admin/paginas · POST /admin/paginas/atualizar[?forcar=1]
 *   POST /admin/pagamento/importar?tabela=clientes|pagamentos (CSV) · GET /admin/ingestao
 *   GET  /admin/eventos · POST /admin/eventos/varrer · GET /admin/metricas
 *   GET  /admin/usuarios · POST /admin/usuarios {email,nome,papel}
 *
 * Cron: "0 6 * * *" (03:00 de Brasília): coleta, eventos atrasados, regras e o time; "20 * * * *": só o Vigia.
 */
import type { BrowserWorker } from "@cloudflare/puppeteer";
import { metaGastoAtivo, resumoGasto, varrerGasto } from "./anuncios.ts";
import { resumoAnalista, rodarAnalista } from "./analista.ts";
import { painelAgentes, rodarEquipe, rodarVigiaHorario } from "./agentes/equipe.ts";
import { gravarEstado, lerEstado } from "./agentes/gestor.ts";
import { montarDossie } from "./agentes/dossie.ts";
import { acaoCriativo, contextoDoCriador, registrarPedido, rodarCriador } from "./agentes/criador.ts";
import type { AcaoCriativo } from "./agentes/criador.ts";
import { montarBiblioteca } from "./agentes/biblioteca.ts";
import { atualizarPaginas, lerResumos } from "./agentes/paginas.ts";
import { rodarEstrategista } from "./agentes/estrategista.ts";
import { rodarRelator } from "./agentes/relator.ts";
import { rodarPublicos } from "./agentes/publicos.ts";
import { renderizarPng, renderizarWebm } from "./agentes/render.ts";
import { diaBrt } from "./anuncios.ts";
import { importarCsv } from "./fontes/pagamento.ts";
import { receberWebhook, resumoIngestao } from "./fontes/ingestao.ts";
import { eventosAtivos, processarCliente, resumoEventos, varrerEventos } from "./fontes/eventos_meta.ts";
import { lerMetricas } from "./metricas.ts";
import { CORS, receberLead, scriptCaptura } from "./captura.ts";
import { criarUsuario, listarUsuarios, normalizarEmail, paginaEntrar, rotasLogin, sessaoDoPedido } from "./login.ts";
import type { Quem } from "./login.ts";
import { paginaPainel } from "./painel.ts";
import { clampInt, json, timingSafeEqual } from "./util.ts";

export interface Env {
  DB: D1Database;
  BROWSER?: BrowserWorker;
  CRIATIVOS?: R2Bucket;
  EMAIL?: { send(m: { to: string; from: string | { email: string; name: string }; subject: string; html: string; text: string }): Promise<{ messageId: string }> };
  ADMIN_TOKEN?: string;
  APP_URL?: string;
  LOGIN_SEGREDO?: string;
  // pagamento
  WEBHOOK_TOKEN?: string;
  PAGAMENTO_TOKEN?: string;
  // Meta: anúncios
  META_ADS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
  META_PAGE_ID?: string;
  META_ADSET_CRIADOR_ID?: string;
  // Meta: eventos (API de Conversões)
  META_CAPI_ATIVO?: string;
  META_DATASET_ID?: string;
  META_CAPI_TOKEN?: string;
  META_TEST_EVENT_CODE?: string;
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
  // alertas e e-mail
  ALERTA_EMAILS?: string;
  EMAIL_REMETENTE?: string;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function bearerOk(request: Request, token: string | undefined, url: URL): boolean {
  if (!token) return false;
  const h = request.headers.get("authorization") ?? "";
  const dado = h.startsWith("Bearer ") ? h.slice(7).trim() : (url.searchParams.get("token") ?? "");
  return dado.length > 0 && timingSafeEqual(dado, token);
}
const renderDe = (env: Env) => (env.BROWSER ? (html: string, l: number, a: number) => renderizarPng(env.BROWSER!, html, l, a) : undefined);
const renderWebmDe = (env: Env) => (env.BROWSER ? (html: string, l: number, a: number, s: number) => renderizarWebm(env.BROWSER!, html, l, a, s) : undefined);

/** Depois de um webhook: manda os eventos dos clientes tocados (em segundo plano). */
async function eventosDosTocados(env: Env, tocados: string[]): Promise<void> {
  if (!eventosAtivos(env)) return;
  for (const id of tocados) await processarCliente(env, id);
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
  if (path === "/admin/agentes/rodar" && method === "POST") return json(await rodarEquipe(env, "manual", fetch, new Date(), renderDe(env), renderWebmDe(env)));
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
    if (angulo.length < 10) throw new HttpError(400, "informe ?angulo=<a ideia do anúncio, em uma frase>[&formato=video]");
    return json({ ok: true, pedido: await registrarPedido(env.DB, diaBrt(new Date()), "manual", { plataforma: "meta", campanha_id: null, campanha: null, angulo, motivo: url.searchParams.get("motivo") ?? "pedido manual", formato: url.searchParams.get("formato") === "video" ? "video" : "imagem" }) });
  }
  const gerar = /^\/admin\/criativos\/pedidos\/(\d+)\/gerar$/.exec(path);
  if (gerar && method === "POST") {
    // atende um pedido agora, fora do ritmo; ?nivel=1 gera em sombra mesmo com o Criador no nível 2
    const nivelS = url.searchParams.get("nivel");
    const nivel = nivelS == null ? ((await lerEstado(env.DB)).criador?.nivel ?? 0) : clampInt(nivelS, 1, 1, 2);
    return json(await rodarCriador(env, nivel, { renderPng: renderDe(env)!, renderWebm: renderWebmDe(env), soPedido: Number(gerar[1]) }));
  }
  if (path === "/admin/criativos/biblioteca" && method === "GET") return json({ biblioteca: await montarBiblioteca(env.DB), prompt: await contextoDoCriador(env, new Date()) });
  const acao = /^\/admin\/criativos\/(\d+)\/(publicar|reprovar|melhorar)$/.exec(path);
  if (acao && method === "POST") {
    const corpo = (await request.json().catch(() => ({}))) as { feedback?: string };
    const r = await acaoCriativo(env, Number(acao[1]), acao[2] as AcaoCriativo, String(corpo.feedback ?? ""), "token de administrador", { renderPng: renderDe(env), renderWebm: renderWebmDe(env) });
    return json(r, r.ok ? 200 : 400);
  }
  if (path === "/admin/paginas" && method === "GET") return json({ paginas: await lerResumos(env.DB) });
  if (path === "/admin/paginas/atualizar" && method === "POST") return json({ resultado: await atualizarPaginas(env, fetch, new Date(), url.searchParams.get("forcar") === "1") });
  if (path === "/admin/pagamento/importar" && method === "POST") {
    const tabela = url.searchParams.get("tabela");
    if (tabela !== "clientes" && tabela !== "pagamentos") throw new HttpError(400, "informe ?tabela=clientes ou ?tabela=pagamentos e o CSV no corpo");
    return json(await importarCsv(env.DB, tabela, await request.text()));
  }
  if (path === "/admin/ingestao" && method === "GET") return json(await resumoIngestao(env.DB));
  if (path === "/admin/eventos" && method === "GET") return json({ ativo: eventosAtivos(env), teste: Boolean(env.META_TEST_EVENT_CODE), ...(await resumoEventos(env.DB)) });
  if (path === "/admin/eventos/varrer" && method === "POST") {
    if (!eventosAtivos(env)) throw new HttpError(503, "eventos desligados: META_CAPI_ATIVO=true, META_DATASET_ID e um token");
    return json(await varrerEventos(env));
  }
  if (path === "/admin/metricas" && method === "GET") return json(await lerMetricas(env.DB));
  if (path === "/admin/usuarios" && method === "GET") return json({ usuarios: await listarUsuarios(env.DB) });
  if (path === "/admin/usuarios" && method === "POST") {
    const c = (await request.json().catch(() => ({}))) as { email?: unknown; nome?: unknown; papel?: unknown };
    const email = normalizarEmail(c.email), nome = typeof c.nome === "string" ? c.nome.trim().slice(0, 80) : "";
    if (!email || !nome) throw new HttpError(400, "corpo JSON: { email, nome, papel: admin|leitor }");
    await criarUsuario(env.DB, { email, nome, papel: c.papel === "leitor" ? "leitor" : "admin", por: "token de administrador" });
    return json({ ok: true, usuarios: await listarUsuarios(env.DB) });
  }
  const midia = /^\/admin\/criativos\/(\d+)(-capa)?\.(png|webm)$/.exec(path);
  if (midia && method === "GET") return midiaCriativo(env, midia[1], midia[2] ?? "", midia[3]);
  throw new HttpError(404, "não encontrado");
}

async function midiaCriativo(env: Env, id: string, sufixo: string, ext: string): Promise<Response> {
  if (!env.CRIATIVOS) throw new HttpError(503, "R2 CRIATIVOS não configurado");
  const obj = await env.CRIATIVOS.get(`criativos/${id}${sufixo}.${ext}`);
  if (!obj) throw new HttpError(404, "mídia não encontrada");
  return new Response(obj.body, { headers: { "content-type": ext === "webm" ? "video/webm" : "image/png", "cache-control": "private, max-age=300" } });
}

/** Quem está no painel: sessão por cookie, ou o token de administrador na URL. */
async function quemNoPainel(request: Request, url: URL, env: Env): Promise<Quem | null> {
  const s = await sessaoDoPedido(request, env);
  if (s) return s;
  return bearerOk(request, env.ADMIN_TOKEN, url) ? { email: "admin", nome: "administrador (token)", papel: "admin" } : null;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/health") {
        return json({ ok: true, configurado: {
          admin_token: Boolean(env.ADMIN_TOKEN), login: Boolean(env.LOGIN_SEGREDO), email: Boolean(env.EMAIL),
          meta_token: Boolean(env.META_ADS_TOKEN), meta_conta: Boolean(env.META_AD_ACCOUNT_ID), meta_pagina: Boolean(env.META_PAGE_ID), meta_conjunto_criador: Boolean(env.META_ADSET_CRIADOR_ID),
          eventos_meta: eventosAtivos(env), eventos_teste: Boolean(env.META_TEST_EVENT_CODE), webhook: Boolean(env.WEBHOOK_TOKEN), pagamento_token: Boolean(env.PAGAMENTO_TOKEN),
          openrouter: Boolean(env.OPENROUTER_API_KEY), navegador: Boolean(env.BROWSER), r2: Boolean(env.CRIATIVOS), alerta_emails: Boolean(env.ALERTA_EMAILS), paginas: Boolean(env.CRIADOR_PAGINAS || env.CRIADOR_LINK),
        } });
      }
      if (path === "/captura.js" && request.method === "GET") return new Response(scriptCaptura(env.APP_URL ?? url.origin), { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=3600", ...CORS } });
      if (path === "/lead") {
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
        if (request.method === "POST") return receberLead(env.DB, request);
      }
      const wh = /^\/webhook\/pagamento\/([a-z]+)$/.exec(path);
      if (wh && request.method === "POST") {
        const r = await receberWebhook(env, wh[1], request);
        if (r.tocados.length) ctx.waitUntil(eventosDosTocados(env, r.tocados));
        return json(r.corpo, r.status);
      }
      if (path === "/entrar" && request.method === "GET") return new Response(paginaEntrar(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      const login = await rotasLogin(path, request, env);
      if (login) return login;

      if (path === "/painel" || path.startsWith("/painel/")) {
        const quem = await quemNoPainel(request, url, env);
        if (!quem) return Response.redirect(`${url.origin}/entrar`, 302);
        const q = url.searchParams.get("token") ? `?token=${encodeURIComponent(url.searchParams.get("token")!)}` : "";
        if (path === "/painel" && request.method === "GET") {
          const [p, m] = await Promise.all([painelAgentes(env), lerMetricas(env.DB)]);
          const extras = { eventos: await resumoEventos(env.DB), eventos_ativos: eventosAtivos(env), ingestao: await resumoIngestao(env.DB) };
          return new Response(paginaPainel(p, m, extras, quem, q), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        }
        const midia = /^\/painel\/criativos\/(\d+)(-capa)?\.(png|webm)$/.exec(path);
        if (midia && request.method === "GET") return midiaCriativo(env, midia[1], midia[2] ?? "", midia[3]);
        const acao = /^\/painel\/criativos\/(\d+)\/(publicar|reprovar|melhorar)$/.exec(path);
        if (acao && request.method === "POST") {
          const form = await request.formData().catch(() => null);
          const feedback = String(form?.get("feedback") ?? "");
          const r = await acaoCriativo(env, Number(acao[1]), acao[2] as AcaoCriativo, feedback, quem.email, { renderPng: renderDe(env), renderWebm: renderWebmDe(env) });
          return Response.redirect(`${url.origin}/painel${q}${q ? "&" : "?"}aviso=${encodeURIComponent(r.mensagem)}#criativos`, 303);
        }
        throw new HttpError(404, "não encontrado");
      }

      if (!bearerOk(request, env.ADMIN_TOKEN, url)) return json({ error: env.ADMIN_TOKEN ? "não autorizado" : "ADMIN_TOKEN não configurado: grave com `npx wrangler secret put ADMIN_TOKEN`" }, 401);
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
        if (eventosAtivos(env)) await varrerEventos(env);
        await rodarAnalista(env);
        await rodarEquipe(env, "cron", fetch, new Date(), renderDe(env), renderWebmDe(env));
      })());
    } else {
      ctx.waitUntil(rodarVigiaHorario(env));
    }
  },
} satisfies ExportedHandler<Env>;
