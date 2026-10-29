/**
 * Template "tudo misturado" (1080×1350, feed 4:5): título grande com destaque, um "celular" com conversas
 * misturadas (config/negocio.ts, fictícias) e o painel com a promessa e a linha de preço. Tudo inline (CSS, logo
 * em base64, fonte do Google) para o Browser Rendering abrir sem arquivo externo. Para trocar a logo, rode
 * `node scripts/logo.mjs caminho/da/logo.png`.
 */
import { LOGO_DATA_URI } from "./logo.ts";
import { EMPRESA, TEMPLATE_CABECALHO, TEMPLATE_CONVERSAS } from "../../config/negocio.ts";

export const TEMPLATE_LARGURA = 1080;
export const TEMPLATE_ALTURA = 1350;

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

/** [[trecho]] vira <mark>trecho</mark>; o resto é escapado. */
export function tituloComDestaque(t: string): string {
  return t.split(/(\[\[[^\]]+\]\])/g).map((p) => (p.startsWith("[[") ? `<mark>${esc(p.slice(2, -2))}</mark>` : esc(p))).join("");
}

export function htmlEscritorio(x: { titulo_imagem: string; promessa: string; preco: string }): string {
  const promessa = x.promessa.split("|").map((l) => esc(l.trim())).filter(Boolean).join("<br>");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700;800&display=swap">
<style>
:root{--navy:#1F3B47;--lime:#6BD34B;--mint:#B6F0C2;--g1:#0E6B3A;--g3:#073A20;--ink:#16303B;--grey:#6B7C84}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1080px;height:1350px;background:#fff;-webkit-font-smoothing:antialiased}
body{font-family:'Plus Jakarta Sans','Helvetica Neue',Arial,sans-serif;color:var(--ink);overflow:hidden}
.canvas{position:relative;width:1080px;height:1350px;overflow:hidden;background:linear-gradient(180deg,#F6FAF7 0%,#E9F3EC 100%)}
mark{background:linear-gradient(transparent 58%,var(--lime) 58%,var(--lime) 92%,transparent 92%);color:inherit;padding:0 4px;margin:0 -4px}
.logo{position:absolute;left:56px;top:50px;width:232px;display:block}
h1{position:absolute;left:56px;top:142px;width:968px;font-size:64px;line-height:1.1;font-weight:800;color:var(--navy);letter-spacing:-1.2px}
.phone{position:absolute;left:56px;top:470px;width:968px;background:#fff;border-radius:30px;box-shadow:0 26px 60px rgba(31,59,71,.20);overflow:hidden}
.phone .top{height:68px;background:#1B6B45;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 30px;font-weight:800;font-size:27px}
.phone .top small{font-weight:600;font-size:21px;opacity:.85}
.row{display:flex;align-items:center;height:80px;padding:0 26px;border-bottom:1px solid #EEF2F0;gap:20px}
.row:last-child{border-bottom:0}
.av{width:52px;height:52px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:21px;color:#fff}
.tx{flex:1;min-width:0}
.nm{font-weight:800;font-size:25px;color:var(--ink);display:flex;align-items:center;gap:12px;white-space:nowrap}
.sn{font-size:21px;color:var(--grey);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
.tag{font-size:16px;font-weight:800;border-radius:8px;padding:3px 10px;letter-spacing:.2px}
.t1{background:#FFE9C7;color:#9A5B00}.t2{background:#DCEBFF;color:#1B54A8}.t3{background:#EBDDFF;color:#6B2FB3}
.rt{text-align:right;flex:none;width:76px}
.rt .tm{font-size:19px;color:var(--grey);font-weight:600}
.bd{display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:30px;border-radius:15px;background:#2DBE60;color:#fff;font-weight:800;font-size:17px;margin-top:5px;padding:0 8px}
.panel{position:absolute;left:56px;top:1086px;width:968px;height:206px;border-radius:30px;background:linear-gradient(135deg,var(--g1),var(--g3));color:#fff;padding:34px 40px}
.panel b{display:block;font-size:44px;line-height:1.12;font-weight:800;letter-spacing:-.8px}
.panel span{display:block;margin-top:16px;font-size:27px;font-weight:600;color:var(--mint);line-height:1.25}
</style></head><body>
<div class="canvas">
  <img class="logo" src="${LOGO_DATA_URI}" alt="${esc(EMPRESA)}">
  <h1>${tituloComDestaque(x.titulo_imagem)}</h1>
  <div class="phone">
    <div class="top"><span>${esc(TEMPLATE_CABECALHO.titulo)}</span><small>${esc(TEMPLATE_CABECALHO.nota)}</small></div>
${TEMPLATE_CONVERSAS.map((c) => `    <div class="row"><div class="av" style="background:${esc(c.cor)}">${esc(c.iniciais)}</div><div class="tx"><div class="nm">${esc(c.nome)}${c.setor ? ` <span class="tag ${c.tom}">${esc(c.setor)}</span>` : ""}</div><div class="sn">${esc(c.mensagem)}</div></div><div class="rt"><div class="tm">${esc(c.hora)}</div>${c.badge ? `<div class="bd">${esc(c.badge)}</div>` : ""}</div></div>`).join("\n")}
  </div>
  <div class="panel"><b>${promessa}</b><span>${esc(x.preco)}</span></div>
</div></body></html>`;
}
