/**
 * Login do painel: e-mail → código de 6 dígitos → sessão em cookie HttpOnly.
 *
 *   POST /auth/codigo  { email }            manda o código (resposta igual para e-mail cadastrado ou não)
 *   POST /auth/entrar  { email, codigo }    confere e abre a sessão (cookie gt_sessao, 7 dias)
 *   GET  /auth/eu                           quem está logado, ou 401
 *   POST /auth/sair
 *   GET/POST/DELETE /auth/usuarios[/<email>]   só administradores: lista, convida, remove
 *
 * Só entra quem está em `usuarios` e ativo. O primeiro administrador é criado por POST /admin/usuarios (com o
 * ADMIN_TOKEN). Código e token ficam no banco só como HMAC com LOGIN_SEGREDO. Sem o Email Service ligado, o
 * código é impresso no log do Worker (`npm run tail`), o que serve para uma pessoa só; com e-mail, vai por e-mail.
 */
import { EMPRESA } from "./config/negocio.ts";

export const CODIGO_MINUTOS = 10;
export const CODIGO_TENTATIVAS = 5;
export const SESSAO_DIAS = 7;
export const COOKIE = "gt_sessao";
export const PEDIDOS_POR_HORA = 5;
export const INTERVALO_PEDIDO_S = 60;

export interface EnvLogin {
  DB: D1Database;
  APP_URL?: string;
  LOGIN_SEGREDO?: string;
  EMAIL_REMETENTE?: string;
  EMAIL?: { send(m: { to: string; from: string | { email: string; name: string }; subject: string; html: string; text: string }): Promise<{ messageId: string }> };
}
export type Papel = "admin" | "leitor";
export interface Quem { email: string; nome: string; papel: Papel }

export function normalizarEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(e) && e.length <= 254 ? e : null;
}
export function gerarCodigo(): string {
  const limite = Math.floor(0xffffffff / 1_000_000) * 1_000_000, buf = new Uint32Array(1);
  for (;;) { crypto.getRandomValues(buf); if (buf[0] < limite) return String(buf[0] % 1_000_000).padStart(6, "0"); }
}
export function gerarToken(): string {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function hmac(segredo: string, texto: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(texto)))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function iguais(a: string, b: string): boolean { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i += 1) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
export function lerCookie(header: string | null, nome: string): string | null {
  if (!header) return null;
  for (const p of header.split(";")) { const i = p.indexOf("="); if (i > 0 && p.slice(0, i).trim() === nome) return p.slice(i + 1).trim() || null; }
  return null;
}
export function cookieSessao(token: string, segundos: number): string { return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${segundos}`; }

export function emailDoCodigo(nome: string, codigo: string): { subject: string; html: string; text: string } {
  const cod = `${codigo.slice(0, 3)} ${codigo.slice(3)}`;
  const text = `Olá, ${nome}!\n\nSeu código para entrar no painel (${EMPRESA}) é: ${cod}\n\nEle vale por ${CODIGO_MINUTOS} minutos e só funciona uma vez. Se não foi você que pediu, ignore este e-mail.`;
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:24px;background:#f3f6f5;font-family:Arial,sans-serif;color:#16303b"><div style="max-width:440px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e2e8e6;padding:28px"><p style="font-size:16px">Olá, ${nome}!</p><p style="color:#5A6B73">Use este código para entrar no painel de ${EMPRESA}:</p><p style="font-size:34px;font-weight:700;letter-spacing:6px;text-align:center;background:#f3f6f5;border-radius:8px;padding:14px 0">${cod}</p><p style="font-size:13px;color:#5A6B73">Vale por ${CODIGO_MINUTOS} minutos e só funciona uma vez. Se não foi você que pediu, ignore este e-mail.</p></div></body></html>`;
  return { subject: `Seu código de acesso: ${cod}`, html, text };
}
export function resp(dados: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(dados), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
}
export async function corpoJson(request: Request): Promise<Record<string, unknown> | null> {
  try { const v = await request.json(); return v && typeof v === "object" ? (v as Record<string, unknown>) : null; } catch { return null; }
}
const agoraIso = () => new Date().toISOString();
const depoisIso = (ms: number) => new Date(Date.now() + ms).toISOString();

export async function usuarioAtivo(db: D1Database, email: string): Promise<{ nome: string; papel: Papel } | null> {
  return (await db.prepare("SELECT nome, papel FROM usuarios WHERE email = ?1 AND ativo = 1").bind(email).first<{ nome: string; papel: Papel }>()) ?? null;
}
export async function sessaoDoPedido(request: Request, env: EnvLogin): Promise<Quem | null> {
  const token = lerCookie(request.headers.get("cookie"), COOKIE);
  if (!token || !env.LOGIN_SEGREDO || token.length > 100) return null;
  const row = await env.DB.prepare("SELECT s.email, s.expira_em, u.nome, u.papel FROM login_sessoes s JOIN usuarios u ON u.email = s.email AND u.ativo = 1 WHERE s.token_hash = ?1").bind(await hmac(env.LOGIN_SEGREDO, `sessao:${token}`)).first<{ email: string; expira_em: string; nome: string; papel: Papel }>();
  if (!row || row.expira_em <= agoraIso()) return null;
  return { email: row.email, nome: row.nome, papel: row.papel };
}

/** Cria (ou reativa) um usuário. Usado por /admin/usuarios (token) e /auth/usuarios (admin logado). */
export async function criarUsuario(db: D1Database, u: { email: string; nome: string; papel: Papel; por: string }): Promise<void> {
  await db.prepare("INSERT INTO usuarios (email, nome, papel, ativo, criado_em, convidado_por) VALUES (?1, ?2, ?3, 1, ?4, ?5) ON CONFLICT (email) DO UPDATE SET nome = excluded.nome, papel = excluded.papel, ativo = 1, convidado_por = excluded.convidado_por").bind(u.email, u.nome, u.papel, agoraIso(), u.por).run();
}
export async function listarUsuarios(db: D1Database): Promise<Array<Record<string, unknown>>> {
  return (await db.prepare("SELECT email, nome, papel, ativo, criado_em, convidado_por, ultimo_acesso_em FROM usuarios ORDER BY ativo DESC, nome").all<Record<string, unknown>>()).results;
}

async function pedirCodigo(request: Request, env: EnvLogin): Promise<Response> {
  const email = normalizarEmail((await corpoJson(request))?.email);
  if (!email) return resp({ erro: "Digite um e-mail válido." }, 400);
  const agora = Date.now();
  const recentes = (await env.DB.prepare("SELECT em FROM login_pedidos WHERE email = ?1 AND em > ?2 ORDER BY em DESC").bind(email, new Date(agora - 3_600_000).toISOString()).all<{ em: string }>()).results;
  if (recentes.length >= PEDIDOS_POR_HORA) return resp({ erro: "Muitos pedidos de código para este e-mail. Tente de novo em uma hora." }, 429);
  if (recentes[0] && agora - Date.parse(recentes[0].em) < INTERVALO_PEDIDO_S * 1000) return resp({ erro: "Espere um minuto antes de pedir outro código." }, 429);
  await env.DB.prepare("INSERT INTO login_pedidos (email, em) VALUES (?1, ?2)").bind(email, new Date(agora).toISOString()).run();
  await env.DB.prepare("DELETE FROM login_pedidos WHERE em < ?1").bind(new Date(agora - 86_400_000).toISOString()).run();
  const usuario = await usuarioAtivo(env.DB, email);
  if (!usuario) return resp({ ok: true }); // mesma resposta: não revela quem está cadastrado
  if (!env.LOGIN_SEGREDO) return resp({ erro: "LOGIN_SEGREDO não configurado (npx wrangler secret put LOGIN_SEGREDO)." }, 503);
  const codigo = gerarCodigo();
  await env.DB.prepare("INSERT INTO login_codigos (email, codigo_hash, expira_em, tentativas, criado_em) VALUES (?1, ?2, ?3, 0, ?4) ON CONFLICT(email) DO UPDATE SET codigo_hash = excluded.codigo_hash, expira_em = excluded.expira_em, tentativas = 0, criado_em = excluded.criado_em")
    .bind(email, await hmac(env.LOGIN_SEGREDO, `codigo:${email}:${codigo}`), depoisIso(CODIGO_MINUTOS * 60_000), agoraIso()).run();
  if (!env.EMAIL) { console.log(`login: código para ${email}: ${codigo} (e-mail não configurado; veja em npm run tail)`); return resp({ ok: true, aviso: "e-mail não configurado: o código está no log do Worker (npm run tail)" }); }
  try {
    await env.EMAIL.send({ to: email, from: { email: env.EMAIL_REMETENTE ?? "acesso@exemplo.com.br", name: `${EMPRESA} · painel` }, ...emailDoCodigo(usuario.nome, codigo) });
  } catch (e) {
    console.error(`login: falha ao enviar código (${(e as { code?: string }).code ?? String(e)})`);
    await env.DB.prepare("DELETE FROM login_codigos WHERE email = ?1").bind(email).run();
    return resp({ erro: "Não deu para enviar o e-mail agora. Tente de novo em instantes." }, 502);
  }
  return resp({ ok: true });
}

async function entrar(request: Request, env: EnvLogin): Promise<Response> {
  const corpo = await corpoJson(request);
  const email = normalizarEmail(corpo?.email), codigo = typeof corpo?.codigo === "string" ? corpo.codigo.replace(/\D/g, "") : "";
  if (!email || codigo.length !== 6 || !env.LOGIN_SEGREDO) return resp({ erro: "Digite o código de 6 dígitos." }, 400);
  const row = await env.DB.prepare("SELECT codigo_hash, expira_em, tentativas FROM login_codigos WHERE email = ?1").bind(email).first<{ codigo_hash: string; expira_em: string; tentativas: number }>();
  if (!row || row.expira_em <= agoraIso()) return resp({ erro: "Esse código venceu ou não existe. Peça um código novo." }, 401);
  if (row.tentativas >= CODIGO_TENTATIVAS) { await env.DB.prepare("DELETE FROM login_codigos WHERE email = ?1").bind(email).run(); return resp({ erro: "Muitas tentativas erradas. Peça um código novo." }, 401); }
  if (!iguais(row.codigo_hash, await hmac(env.LOGIN_SEGREDO, `codigo:${email}:${codigo}`))) {
    await env.DB.prepare("UPDATE login_codigos SET tentativas = tentativas + 1 WHERE email = ?1").bind(email).run();
    return resp({ erro: "Código incorreto." }, 401);
  }
  const usuario = await usuarioAtivo(env.DB, email);
  await env.DB.prepare("DELETE FROM login_codigos WHERE email = ?1").bind(email).run();
  if (!usuario) return resp({ erro: "Este e-mail não tem acesso ao painel." }, 403);
  const token = gerarToken(), segundos = SESSAO_DIAS * 86_400;
  await env.DB.prepare("INSERT INTO login_sessoes (token_hash, email, criado_em, expira_em, visto_em, agente) VALUES (?1, ?2, ?3, ?4, ?3, ?5)").bind(await hmac(env.LOGIN_SEGREDO, `sessao:${token}`), email, agoraIso(), depoisIso(segundos * 1000), (request.headers.get("user-agent") ?? "").slice(0, 200)).run();
  await env.DB.prepare("DELETE FROM login_sessoes WHERE expira_em < ?1").bind(agoraIso()).run();
  await env.DB.prepare("UPDATE usuarios SET ultimo_acesso_em = ?1 WHERE email = ?2").bind(agoraIso(), email).run();
  return resp({ ok: true, email, nome: usuario.nome, papel: usuario.papel }, 200, { "set-cookie": cookieSessao(token, segundos) });
}

async function sair(request: Request, env: EnvLogin): Promise<Response> {
  const token = lerCookie(request.headers.get("cookie"), COOKIE);
  if (token && env.LOGIN_SEGREDO) await env.DB.prepare("DELETE FROM login_sessoes WHERE token_hash = ?1").bind(await hmac(env.LOGIN_SEGREDO, `sessao:${token}`)).run();
  return resp({ ok: true }, 200, { "set-cookie": cookieSessao("", 0) });
}

async function usuarios(path: string, request: Request, env: EnvLogin, quem: Quem): Promise<Response> {
  if (quem.papel !== "admin") return resp({ erro: "Só administradores gerenciam usuários." }, 403);
  if (path === "/auth/usuarios" && request.method === "GET") return resp({ usuarios: await listarUsuarios(env.DB), voce: quem.email });
  if (path === "/auth/usuarios" && request.method === "POST") {
    const c = await corpoJson(request);
    const email = normalizarEmail(c?.email), nome = typeof c?.nome === "string" ? c.nome.trim().slice(0, 80) : "";
    if (!email || !nome || (c?.papel !== "admin" && c?.papel !== "leitor")) return resp({ erro: "Informe email, nome e papel (admin ou leitor)." }, 400);
    await criarUsuario(env.DB, { email, nome, papel: c.papel, por: quem.email });
    return resp({ ok: true, usuarios: await listarUsuarios(env.DB) });
  }
  const m = /^\/auth\/usuarios\/([^/]+)$/.exec(path);
  if (m && request.method === "DELETE") {
    const alvo = normalizarEmail(decodeURIComponent(m[1]));
    if (!alvo) return resp({ erro: "e-mail inválido" }, 400);
    if (alvo === quem.email) return resp({ erro: "Você não pode remover a si mesmo." }, 409);
    await env.DB.batch([env.DB.prepare("UPDATE usuarios SET ativo = 0 WHERE email = ?1").bind(alvo), env.DB.prepare("DELETE FROM login_sessoes WHERE email = ?1").bind(alvo), env.DB.prepare("DELETE FROM login_codigos WHERE email = ?1").bind(alvo)]);
    return resp({ ok: true, usuarios: await listarUsuarios(env.DB) });
  }
  return resp({ erro: "não encontrado" }, 404);
}

/** Trata /auth/*; devolve null se o caminho não for de login. */
export async function rotasLogin(path: string, request: Request, env: EnvLogin): Promise<Response | null> {
  if (!path.startsWith("/auth/")) return null;
  if (path === "/auth/eu" && request.method === "GET") { const s = await sessaoDoPedido(request, env); return s ? resp(s) : resp({ erro: "sem sessão" }, 401); }
  if (path.startsWith("/auth/usuarios")) { const quem = await sessaoDoPedido(request, env); return quem ? usuarios(path, request, env, quem) : resp({ erro: "sessão expirada ou inválida" }, 401); }
  if (request.method !== "POST") return resp({ erro: "método não permitido" }, 405);
  if (path === "/auth/codigo") return pedirCodigo(request, env);
  if (path === "/auth/entrar") return entrar(request, env);
  if (path === "/auth/sair") return sair(request, env);
  return resp({ erro: "não encontrado" }, 404);
}

/** Página de entrada (/entrar): e-mail → código, em HTML + um pouco de JavaScript. */
export function paginaEntrar(): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrar · ${EMPRESA}</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f7f5;color:#1e333b;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}form{background:#fff;border:1px solid #d9e2dd;border-radius:12px;padding:28px;width:min(380px,92vw)}h1{font-size:20px;margin:0 0 6px}p{color:#5a6b73;margin:0 0 16px;font-size:14px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #c9d4ce;border-radius:8px;font-size:16px;margin:0 0 12px}button{width:100%;padding:12px;border:0;border-radius:8px;background:#0e6b3a;color:#fff;font-size:16px;font-weight:600;cursor:pointer}.erro{color:#b42318;font-size:14px;margin:8px 0 0}</style></head>
<body><form id="f"><h1>${EMPRESA} · painel</h1><p id="p">Digite seu e-mail. Você recebe um código de 6 dígitos para entrar.</p><input id="email" type="email" placeholder="seu@email.com" required autofocus><input id="codigo" inputmode="numeric" placeholder="código de 6 dígitos" maxlength="7" style="display:none"><button id="b">Receber código</button><div class="erro" id="e"></div></form>
<script>
var etapa=1,f=document.getElementById("f"),em=document.getElementById("email"),co=document.getElementById("codigo"),e=document.getElementById("e"),p=document.getElementById("p"),b=document.getElementById("b");
f.onsubmit=function(ev){ev.preventDefault();e.textContent="";b.disabled=true;
 var corpo=etapa===1?{email:em.value}:{email:em.value,codigo:co.value};
 fetch(etapa===1?"/auth/codigo":"/auth/entrar",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(corpo)}).then(function(r){return r.json().then(function(j){return[r.ok,j]})}).then(function(x){b.disabled=false;
  if(!x[0]){e.textContent=x[1].erro||"Não deu certo.";return}
  if(etapa===1){etapa=2;co.style.display="block";co.focus();b.textContent="Entrar";p.textContent=x[1].aviso||"Código enviado. Vale por 10 minutos.";}
  else{location.href="/painel";}
 }).catch(function(){b.disabled=false;e.textContent="Sem conexão."});};
</script></body></html>`;
}
