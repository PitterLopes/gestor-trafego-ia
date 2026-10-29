/**
 * Captura do clique na landing page, para a atribuição ir do anúncio até o pagamento.
 *
 *   GET  /captura.js   script para colocar em qualquer landing page (veja docs/landing.md)
 *   POST /lead         { email, telefone, nome, fbclid, gclid, fbp, utm, pagina } → tabela leads (público, com CORS)
 *
 * O script guarda fbclid/gclid/utm_* que vieram na URL (localStorage, 90 dias), preenche campos ocultos com esses
 * nomes em todo formulário, acrescenta os mesmos parâmetros aos links do checkout (data-captura-links) e, quando um
 * formulário com e-mail ou telefone é enviado, manda o lead para /lead. Quando o mesmo e-mail/telefone aparecer no
 * pagamento, o cliente herda o clique (src/fontes/ingestao.ts) e o evento Purchase sai com fbc.
 */
import { nowIso } from "./util.ts";

export const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };

export function scriptCaptura(appUrl: string): string {
  return `(function(){try{
var K="gt_clique",DIAS=90,q=new URLSearchParams(location.search),chaves=["fbclid","gclid","utm_source","utm_medium","utm_campaign","utm_content","utm_term"];
var g={};try{g=JSON.parse(localStorage.getItem(K)||"{}")||{}}catch(e){g={}}
if(g.exp&&g.exp<Date.now())g={};
var novo=false;chaves.forEach(function(k){var v=q.get(k);if(v){g[k]=v.slice(0,300);novo=true}});
if(novo){g.exp=Date.now()+DIAS*864e5;g.pagina=location.href.split("?")[0];try{localStorage.setItem(K,JSON.stringify(g))}catch(e){}}
function fbp(){var m=document.cookie.match(/(?:^|; )_fbp=([^;]+)/);return m?decodeURIComponent(m[1]):""}
function preencher(form){chaves.forEach(function(k){if(!g[k])return;var i=form.querySelector('input[name="'+k+'"]');if(!i){i=document.createElement("input");i.type="hidden";i.name=k;form.appendChild(i)}i.value=g[k]})}
function links(){var dom=(document.currentScript&&document.currentScript.getAttribute("data-captura-links"))||"";if(!dom)return;dom.split(",").forEach(function(d){d=d.trim();if(!d)return;document.querySelectorAll('a[href*="'+d+'"]').forEach(function(a){try{var u=new URL(a.href);chaves.forEach(function(k){if(g[k]&&!u.searchParams.get(k))u.searchParams.set(k,g[k])});a.href=u.toString()}catch(e){}})})}
function valor(form,nomes){for(var i=0;i<nomes.length;i++){var el=form.querySelector('[name*="'+nomes[i]+'" i],[type="'+nomes[i]+'"],[id*="'+nomes[i]+'" i]');if(el&&el.value)return el.value}return""}
function enviar(form){var email=valor(form,["email","e-mail"]),tel=valor(form,["tel","phone","whats","celular","fone"]),nome=valor(form,["nome","name"]);if(!email&&!tel)return;
 var utm={};chaves.slice(2).forEach(function(k){if(g[k])utm[k]=g[k]});
 var corpo=JSON.stringify({email:email,telefone:tel,nome:nome,fbclid:g.fbclid||"",gclid:g.gclid||"",fbp:fbp(),utm:utm,pagina:location.href.split("?")[0]});
 if(navigator.sendBeacon){navigator.sendBeacon(${JSON.stringify(appUrl)}+"/lead",new Blob([corpo],{type:"application/json"}))}else{fetch(${JSON.stringify(appUrl)}+"/lead",{method:"POST",headers:{"content-type":"application/json"},body:corpo,keepalive:true})}}
function pronto(){document.querySelectorAll("form").forEach(function(f){preencher(f);if(!f.__gt){f.__gt=1;f.addEventListener("submit",function(){enviar(f)})}});links()}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",pronto);else pronto();
new MutationObserver(function(){pronto()}).observe(document.documentElement,{childList:true,subtree:true});
window.gtCaptura={dados:g,enviarLead:function(d){var corpo=JSON.stringify(Object.assign({fbclid:g.fbclid||"",gclid:g.gclid||"",fbp:fbp(),pagina:location.href.split("?")[0]},d));return fetch(${JSON.stringify(appUrl)}+"/lead",{method:"POST",headers:{"content-type":"application/json"},body:corpo})}};
}catch(e){}})();`;
}

const s = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export async function receberLead(db: D1Database, request: Request): Promise<Response> {
  let corpo: Record<string, unknown> | null = null;
  try { corpo = (await request.json()) as Record<string, unknown>; } catch { corpo = null; }
  const email = s(corpo?.email)?.toLowerCase() ?? null, telefone = s(corpo?.telefone, 40);
  if (!corpo || (!email && !telefone)) return new Response(JSON.stringify({ error: "informe email ou telefone" }), { status: 400, headers: { "content-type": "application/json", ...CORS } });
  const utm = corpo.utm && typeof corpo.utm === "object" ? JSON.stringify(corpo.utm).slice(0, 1000) : null;
  await db.prepare("INSERT INTO leads (email, telefone, nome, fbclid, gclid, fbp, utm_json, pagina, criado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
    .bind(email, telefone, s(corpo.nome, 120), s(corpo.fbclid, 300), s(corpo.gclid, 300), s(corpo.fbp, 100), utm, s(corpo.pagina, 500), nowIso()).run();
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", ...CORS } });
}
