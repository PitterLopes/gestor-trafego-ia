/**
 * Template de vídeo "tela do produto": a conversa acontece dentro de uma imitação da tela de atendimento do seu
 * sistema (config/negocio.ts → TELA_PRODUTO: endereço, menu lateral, abas, lista de conversas com selo
 * Normal/Urgente, cabeçalho "#protocolo - Contato" com o setor, botões Transferir/Prioridade/Fechar/Cancelar,
 * cartões com nome e data/hora, aviso de transferência, campo T.campo). Fica dentro do visual
 * da marca (logo, preço grande, título com destaque, botão), com as cores de TELA_PRODUTO.cores.
 *
 * Dois formatos: "quadrado" 1080×1080 (feed) e "story" 1080×1920 (stories e reels). Desenhado num <canvas> e
 * gravado pela própria página (MediaRecorder WebM), como o chat_video.ts; render.ts espera window.__video.
 */
import { LOGO_DATA_URI } from "./logo.ts";
import { TELA_PRODUTO } from "../../config/negocio.ts";

export type FormatoVideo = "quadrado" | "story";
export const TAMANHOS: Record<FormatoVideo, { largura: number; altura: number }> = {
  quadrado: { largura: 1080, altura: 1080 },
  story: { largura: 1080, altura: 1920 },
};

export interface MensagemSistema {
  de: "cliente" | "atendente" | "evento";
  texto: string;
}

export interface RoteiroSistema {
  titulo_imagem: string; // com [[destaque]]
  contato: string; // "Marcos Padaria"
  setor: string; // "Fiscal"
  atendente: string; // "Ana"
  protocolo: string; // "9070"
  conversa: MensagemSistema[];
  promessa: string; // "linha 1 | linha 2"
  preco: string; // linha de preço completa
  dia: string; // "05/11/2026"
  segundos?: number;
}

/** "Ana · Fiscal" → "Ana"; "Fiscal · Escritório" → "Fiscal". */
export const primeiroNome = (s: string, padrao: string): string => (s.split(/[·|\-–]/)[0] ?? "").trim() || padrao;

/** Protocolo citado na conversa (#9070) ou um número estável derivado do texto. */
export function protocoloDe(conversa: Array<{ texto: string }>, semente: string): string {
  for (const m of conversa) { const x = /#\s?(\d{3,6})/.exec(m.texto); if (x) return x[1]; }
  let h = 0;
  for (const ch of semente) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return String(4000 + (h % 5000));
}

export function htmlChatSistema(r: RoteiroSistema, formato: FormatoVideo): string {
  const { largura: W, altura: H } = TAMANHOS[formato];
  const m = /R\$\s?(\d+)/.exec(r.preco);
  const dados = JSON.stringify({ ...r, valor: m ? m[1] : "25", formato, segundos: Math.min(30, Math.max(8, r.segundos ?? 15)) });
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=Poppins:wght@400;500;600&display=swap">
<style>html,body{margin:0;background:${TELA_PRODUTO.cores.fundo_fim};width:${W}px;height:${H}px;overflow:hidden}canvas{display:block}</style></head>
<body><canvas id="c" width="${W}" height="${H}"></canvas>
<script>
(function () {
  var R = ${dados};
  // zona de segurança: o 9:16 é o mesmo quadro 1:1, centralizado; acima e abaixo só o fundo (o Reels e os Stories
  // cobrem o topo e a base com nome da página, legenda e botões). Todo o layout é o do quadrado (STORY = false).
  var W = ${W}, H = ${H}, FPS = 30, STORY = false, Q = 1080, OFF = Math.round((H - Q) / 2);
  var cv = document.getElementById("c"), ctx = cv.getContext("2d");
  var logo = new Image(); logo.src = ${JSON.stringify(LOGO_DATA_URI)};
  var F = "'Plus Jakarta Sans', 'Helvetica Neue', Arial, sans-serif", UI = "'Poppins', 'Helvetica Neue', Arial, sans-serif";
  var T = ${JSON.stringify(TELA_PRODUTO)};
  var VERDE_CLARO = T.cores.destaque, TINTA = "#1F2D33", CINZA = "#7A868C", LINHA = "#E3E8EA", MENTA = T.cores.balao_atendente, FUNDO_CHAT = T.cores.fundo_chat, VERDE_UI = T.cores.ui;

  function arred(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function linhas(texto, maxW, font) {
    ctx.font = font; var out = [], atual = "";
    texto.split(/\\s+/).forEach(function (p) { var t = atual ? atual + " " + p : p; if (ctx.measureText(t).width > maxW && atual) { out.push(atual); atual = p; } else atual = t; });
    if (atual) out.push(atual);
    return out;
  }
  function corta(texto, maxW) { if (ctx.measureText(texto).width <= maxW) return texto; while (texto.length > 1 && ctx.measureText(texto + "…").width > maxW) texto = texto.slice(0, -1); return texto + "…"; }
  function iniciais(nome) { var p = nome.trim().split(/\\s+/); return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase(); }

  // título com [[destaque]] em verde claro, quebrando dentro de maxW
  function titulo(x, y, maxW, tam, maxLinhas) {
    ctx.font = "800 " + tam + "px " + F; ctx.textBaseline = "alphabetic";
    var partes = [], marcado = false;
    R.titulo_imagem.split(/(\\[\\[|\\]\\])/).forEach(function (s) { if (s === "[[") marcado = true; else if (s === "]]") marcado = false; else if (s) s.split(/\\s+/).forEach(function (w) { if (w) partes.push({ w: w, m: marcado }); }); });
    var ls = [[]], larg = 0, esp = ctx.measureText(" ").width;
    partes.forEach(function (p) { var w = ctx.measureText(p.w).width; if (larg + w > maxW && ls[ls.length - 1].length) { ls.push([]); larg = 0; } ls[ls.length - 1].push(p); larg += w + esp; });
    ls.slice(0, maxLinhas).forEach(function (l, i) { var xx = x; l.forEach(function (p) { ctx.fillStyle = p.m ? VERDE_CLARO : "#fff"; ctx.fillText(p.w, xx, y + i * tam * 1.12); xx += ctx.measureText(p.w).width + esp; }); });
    return y + Math.min(ls.length, maxLinhas) * tam * 1.12;
  }
  function seloLogo(x, y, h) {
    var lw = 0, lh = h * 0.56;
    if (logo.complete && logo.naturalWidth) lw = lh * logo.naturalWidth / logo.naturalHeight;
    var w = Math.max(lw + h * 0.9, h * 2.6);
    ctx.fillStyle = "#fff"; arred(x, y, w, h, h / 2); ctx.fill();
    if (lw) ctx.drawImage(logo, x + (w - lw) / 2, y + (h - lh) / 2, lw, lh);
  }
  function botao(x, y, h, texto) {
    ctx.font = "800 " + Math.round(h * 0.4) + "px " + F; var w = ctx.measureText(texto).width + h * 1.1;
    ctx.fillStyle = "#fff"; arred(x, y, w, h, h / 2); ctx.fill();
    ctx.fillStyle = T.cores.fundo_fim; ctx.textBaseline = "middle"; ctx.fillText(texto, x + h * 0.55, y + h / 2 + 1); ctx.textBaseline = "alphabetic";
    return w;
  }

  // ---------- roteiro no tempo ----------
  var seg = R.segundos, n = R.conversa.length, inicio = 1.0, fim = seg - (STORY ? 1.5 : 3.2), passo = n ? (fim - inicio) / n : 1;
  function estado(t) {
    var vis = 0, prox = -1, prog = 0;
    for (var i = 0; i < n; i++) {
      var ti = inicio + i * passo;
      if (t >= ti) vis = i + 1;
      else { var antes = Math.min(1.1, passo * 0.7); if (t >= ti - antes) { prox = i; prog = (t - (ti - antes)) / antes; } break; }
    }
    return { vis: vis, prox: prox, prog: prog, painel: STORY ? 0 : Math.max(0, Math.min(1, (t - (seg - 3)) / 0.5)) };
  }
  function hora(i) { var min = 33 + i * 2; return R.dia + " " + (9 + Math.floor(min / 60)) + ":" + String(min % 60).padStart(2, "0"); }

  // ---------- a tela do sistema ----------
  var OUTROS = T.conversas;
  var CORES = ["#5B7083", "#B5784A", "#4E7FA6", "#8B6BB1", "#B4556E", "#5E8C6A", "#A07C3B"];

  // ícones de linha simples, 14×14, no estilo do menu do sistema
  function icone(tipo, x, y, cor) {
    ctx.save(); ctx.strokeStyle = cor; ctx.fillStyle = cor; ctx.lineWidth = 1.6; ctx.lineJoin = "round"; ctx.beginPath();
    if (tipo === "grade") { ctx.rect(x, y, 6, 6); ctx.rect(x + 8, y, 6, 6); ctx.rect(x, y + 8, 6, 6); ctx.rect(x + 8, y + 8, 6, 6); }
    else if (tipo === "fone") { ctx.arc(x + 7, y + 8, 6, Math.PI, 0); ctx.moveTo(x + 1, y + 8); ctx.lineTo(x + 1, y + 12); ctx.moveTo(x + 13, y + 8); ctx.lineTo(x + 13, y + 12); }
    else if (tipo === "balao") { ctx.arc(x + 7, y + 6.5, 6.5, 0, Math.PI * 2); ctx.moveTo(x + 3, y + 11); ctx.lineTo(x + 1, y + 14); ctx.lineTo(x + 6, y + 13); }
    else if (tipo === "predio") { ctx.rect(x + 1, y + 2, 12, 12); ctx.moveTo(x + 4, y + 6); ctx.lineTo(x + 6, y + 6); ctx.moveTo(x + 8, y + 6); ctx.lineTo(x + 10, y + 6); ctx.moveTo(x + 4, y + 10); ctx.lineTo(x + 6, y + 10); ctx.moveTo(x + 8, y + 10); ctx.lineTo(x + 10, y + 10); }
    else if (tipo === "pessoa") { ctx.arc(x + 7, y + 4.5, 3.5, 0, Math.PI * 2); ctx.moveTo(x + 1, y + 14); ctx.quadraticCurveTo(x + 7, y + 5, x + 13, y + 14); }
    else if (tipo === "rede") { ctx.arc(x + 3, y + 3, 2, 0, Math.PI * 2); ctx.moveTo(x + 13, y + 3); ctx.arc(x + 11, y + 3, 2, 0, Math.PI * 2); ctx.moveTo(x + 9, y + 11); ctx.arc(x + 7, y + 11, 2, 0, Math.PI * 2); ctx.moveTo(x + 4, y + 5); ctx.lineTo(x + 6, y + 9); ctx.moveTo(x + 10, y + 5); ctx.lineTo(x + 8, y + 9); }
    else if (tipo === "arvore") { ctx.rect(x + 4, y, 6, 4); ctx.rect(x, y + 10, 5, 4); ctx.rect(x + 9, y + 10, 5, 4); ctx.moveTo(x + 7, y + 4); ctx.lineTo(x + 7, y + 7); ctx.moveTo(x + 2.5, y + 10); ctx.lineTo(x + 2.5, y + 7); ctx.lineTo(x + 11.5, y + 7); ctx.lineTo(x + 11.5, y + 10); }
    else if (tipo === "megafone") { ctx.moveTo(x + 1, y + 5); ctx.lineTo(x + 5, y + 5); ctx.lineTo(x + 12, y + 1); ctx.lineTo(x + 12, y + 13); ctx.lineTo(x + 5, y + 9); ctx.lineTo(x + 1, y + 9); ctx.closePath(); }
    else if (tipo === "grafico") { ctx.moveTo(x, y + 14); ctx.lineTo(x + 14, y + 14); ctx.rect(x + 2, y + 8, 2.5, 5); ctx.rect(x + 6, y + 4, 2.5, 9); ctx.rect(x + 10, y + 1, 2.5, 12); }
    else if (tipo === "engrenagem") { ctx.arc(x + 7, y + 7, 3, 0, Math.PI * 2); for (var k = 0; k < 8; k++) { var an = k * Math.PI / 4; ctx.moveTo(x + 7 + Math.cos(an) * 4.5, y + 7 + Math.sin(an) * 4.5); ctx.lineTo(x + 7 + Math.cos(an) * 6.5, y + 7 + Math.sin(an) * 6.5); } }
    else if (tipo === "diamante") { ctx.moveTo(x + 3, y + 2); ctx.lineTo(x + 11, y + 2); ctx.lineTo(x + 14, y + 6); ctx.lineTo(x + 7, y + 14); ctx.lineTo(x, y + 6); ctx.closePath(); ctx.moveTo(x, y + 6); ctx.lineTo(x + 14, y + 6); }
    else if (tipo === "peca") { ctx.rect(x + 1, y + 4, 9, 9); ctx.moveTo(x + 10, y + 7); ctx.arc(x + 11.5, y + 8.5, 1.8, 0, Math.PI * 2); ctx.moveTo(x + 7, y + 4); ctx.arc(x + 5.5, y + 2.5, 1.8, 0, Math.PI * 2); }
    else if (tipo === "lupa") { ctx.arc(x + 6, y + 6, 4.5, 0, Math.PI * 2); ctx.moveTo(x + 9.5, y + 9.5); ctx.lineTo(x + 13, y + 13); }
    ctx.stroke(); ctx.restore();
  }

  function janela(x, y, w, h, t) {
    var st = estado(t);
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,.28)"; ctx.shadowBlur = 50; ctx.shadowOffsetY = 18; ctx.fillStyle = "#fff"; arred(x, y, w, h, 22); ctx.fill(); ctx.restore();
    ctx.save(); arred(x, y, w, h, 22); ctx.clip();
    // barra do navegador
    var bh = 46; ctx.fillStyle = "#EEF1F2"; ctx.fillRect(x, y, w, bh);
    ["#FF5F57", "#FEBC2E", "#28C840"].forEach(function (c, i) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x + 26 + i * 22, y + bh / 2, 7, 0, Math.PI * 2); ctx.fill(); });
    ctx.fillStyle = "#fff"; arred(x + 104, y + 9, 360, 28, 8); ctx.fill();
    ctx.fillStyle = "#4A585E"; ctx.font = "400 17px " + UI; ctx.textBaseline = "middle"; ctx.fillText(T.url, x + 118, y + bh / 2 + 1);
    var top = y + bh, alt = h - bh;
    // menu lateral do sistema, com os nomes (igual ao print)
    var sw = Math.round(w * 0.155); ctx.fillStyle = "#fff"; ctx.fillRect(x, top, sw, alt); ctx.fillStyle = LINHA; ctx.fillRect(x + sw - 1, top, 1, alt);
    if (logo.complete && logo.naturalWidth) { var lh0 = 26, lw0 = lh0 * logo.naturalWidth / logo.naturalHeight; ctx.drawImage(logo, x + 14, top + 14, Math.min(lw0, sw - 24), lh0 * Math.min(lw0, sw - 24) / lw0); }
    var MENU = T.menu.map(function (it) { return it ? [it.nome, it.icone, it.submenu ? 1 : 0, it.selo || "", it.ativo] : null; });
    var my = top + 66, passoM = Math.min(STORY ? 46 : 38, (alt - 80) / MENU.length);
    MENU.forEach(function (it) {
      if (!it) { ctx.fillStyle = LINHA; ctx.fillRect(x + 12, my - passoM * 0.35, sw - 24, 1); my += passoM * 0.3; return; }
      var ativo = Boolean(it[4]), cor = ativo ? VERDE_UI : "#2D3A40";
      icone(it[1], x + 22, my - 7, cor);
      ctx.fillStyle = cor; ctx.font = (ativo ? "500 " : "400 ") + "13px " + UI; ctx.textBaseline = "middle"; ctx.fillText(it[0], x + 46, my);
      if (it[2]) { ctx.fillText("›", x + sw - 18, my); }
      if (it[3]) { var pw0 = ctx.measureText(it[0]).width; ctx.font = "600 10px " + UI; var nw = ctx.measureText(it[3]).width + 12; ctx.fillStyle = VERDE_UI; arred(x + 52 + pw0, my - 8, nw, 16, 8); ctx.fill(); ctx.fillStyle = "#fff"; ctx.fillText(it[3], x + 58 + pw0, my + 1); }
      my += passoM;
    });
    // barra do topo do app: "☰ Chat" e os ícones à direita
    var tb = 46; ctx.fillStyle = "#fff"; ctx.fillRect(x + sw, top, w - sw, tb); ctx.fillStyle = LINHA; ctx.fillRect(x + sw, top + tb, w - sw, 1);
    ctx.fillStyle = TINTA; ctx.font = "500 19px " + UI; ctx.textBaseline = "middle";
    for (var b3 = 0; b3 < 3; b3++) ctx.fillRect(x + sw + 18, top + 16 + b3 * 6, 16, 2);
    ctx.fillText(T.titulo_tela, x + sw + 44, top + tb / 2 + 1);
    icone("pessoa", x + w - 104, top + 15, TINTA); icone("megafone", x + w - 74, top + 15, TINTA);
    ctx.fillStyle = "#E9EEF0"; ctx.beginPath(); ctx.arc(x + w - 30, top + tb / 2, 13, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = TINTA; ctx.font = "500 12px " + UI; ctx.fillText("A", x + w - 34, top + tb / 2 + 1);
    var top2 = top + tb + 1, alt2 = alt - tb - 1;
    // lista de conversas: abas com ícone e contador, busca e as conversas
    var lx = x + sw, lw = Math.round(w * (STORY ? 0.33 : 0.28));
    ctx.fillStyle = "#fff"; ctx.fillRect(lx, top2, lw, alt2); ctx.fillStyle = LINHA; ctx.fillRect(lx + lw - 1, top2, 1, alt2);
    var ABAS = T.abas, aw = (lw - 16) / 4;
    ABAS.forEach(function (ab, i) {
      var ax = lx + 8 + i * aw + aw / 2, ativo = i === 0, cor = ativo ? VERDE_UI : CINZA;
      icone(i === 2 ? "predio" : "pessoa", ax - 7, top2 + 10, cor);
      if (ab[1]) { ctx.font = "600 9px " + UI; var bw0 = Math.max(16, ctx.measureText(ab[1]).width + 8); ctx.fillStyle = VERDE_UI; arred(ax + 2, top2 + 4, bw0, 14, 7); ctx.fill(); ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.fillText(ab[1], ax + 2 + (bw0 - ctx.measureText(ab[1]).width) / 2, top2 + 11.5); }
      ctx.font = (ativo ? "500 " : "400 ") + "12px " + UI; ctx.fillStyle = cor; ctx.textBaseline = "middle"; ctx.fillText(ab[0], ax - ctx.measureText(ab[0]).width / 2, top2 + 40);
      if (ativo) ctx.fillRect(ax - aw / 2 + 6, top2 + 52, aw - 12, 2);
    });
    ctx.fillStyle = LINHA; ctx.fillRect(lx, top2 + 54, lw - 1, 1);
    ctx.strokeStyle = "#D5DCDF"; ctx.lineWidth = 1; arred(lx + 10, top2 + 64, lw - 20, 32, 6); ctx.stroke(); ctx.fillStyle = "#9AA5AA"; ctx.font = "400 13px " + UI; ctx.fillText("Pesquise por conversas", lx + 20, top2 + 80);
    ctx.fillStyle = LINHA; ctx.fillRect(lx + lw - 48, top2 + 64, 1, 32); icone("lupa", lx + lw - 36, top2 + 73, CINZA);
    top = top2 - 30; // a lista começa logo abaixo da busca (as conversas usam top + 134)
    alt = alt2 + 30;
    var ultima = st.vis ? R.conversa[st.vis - 1] : null;
    var lista = OUTROS.slice(0, 1).concat([[R.contato, ultima ? ultima.texto : "Novo atendimento", st.vis ? hora(st.vis - 1).slice(-5) : "09:33", "Normal", true]]).concat(OUTROS.slice(1));
    var ry = top + 134, rh = 64;
    lista.forEach(function (c, i) {
      if (ry > top + alt) return;
      if (c[4]) { ctx.fillStyle = "#E4E8EA"; ctx.fillRect(lx, ry, lw - 1, rh); }
      ctx.strokeStyle = CORES[i % CORES.length]; ctx.lineWidth = 2.5; ctx.fillStyle = "#F1F3F4"; ctx.beginPath(); ctx.arc(lx + 36, ry + rh / 2, 21, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = TINTA; ctx.font = "600 14px " + UI; ctx.fillText(iniciais(c[0]), lx + 36 - ctx.measureText(iniciais(c[0])).width / 2, ry + rh / 2 + 1);
      var tx = lx + 66, tmax = lw - 66 - 70;
      ctx.font = "500 15px " + UI; ctx.fillStyle = TINTA; ctx.fillText(corta(c[0], tmax), tx, ry + 22);
      ctx.font = "400 13px " + UI; ctx.fillStyle = CINZA; ctx.fillText(corta(c[1], tmax), tx, ry + 44);
      ctx.font = "600 11px " + UI; var sel = c[3], swd = ctx.measureText(sel).width + 12;
      ctx.fillStyle = sel === "Urgente" ? "#FDE3E3" : "#E1ECFA"; arred(lx + lw - 14 - swd, ry + 12, swd, 18, 4); ctx.fill();
      ctx.fillStyle = sel === "Urgente" ? "#D23B3B" : "#3B6FB6"; ctx.fillText(sel, lx + lw - 8 - swd, ry + 21);
      ctx.font = "400 11px " + UI; ctx.fillStyle = CINZA; ctx.fillText(c[2], lx + lw - 14 - ctx.measureText(c[2]).width, ry + 46);
      ctx.fillStyle = LINHA; ctx.fillRect(lx + 12, ry + rh - 1, lw - 24, 1);
      ry += rh;
    });
    // conversa aberta (abaixo da barra do topo)
    top = top2; alt = alt2;
    var cx = lx + lw, cw = x + w - cx;
    ctx.fillStyle = "#fff"; ctx.fillRect(cx, top, cw, 104); ctx.fillStyle = LINHA; ctx.fillRect(cx, top + 104, cw, 1);
    ctx.fillStyle = "#F1F3F4"; ctx.strokeStyle = "#5B7083"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx + 34, top + 34, 20, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = TINTA; ctx.font = "600 13px " + UI; ctx.fillText(iniciais(R.contato), cx + 34 - ctx.measureText(iniciais(R.contato)).width / 2, top + 35);
    ctx.font = "500 17px " + UI; ctx.fillText(corta("#" + R.protocolo + "  -  " + R.contato, cw - 80), cx + 64, top + 24);
    ctx.font = "400 14px " + UI; ctx.fillStyle = "#4A585E"; ctx.fillText(corta(T.origem.replace("{setor}", R.setor.toUpperCase()), cw - 80), cx + 64, top + 48);
    var bx = cx + 14;
    T.botoes.forEach(function (b) { ctx.font = "400 13px " + UI; var bw = ctx.measureText(b).width + 20; if (bx + bw > cx + cw - 8) return; ctx.strokeStyle = "#CBD3D6"; ctx.lineWidth = 1; arred(bx, top + 66, bw, 28, 6); ctx.stroke(); ctx.fillStyle = TINTA; ctx.fillText(b, bx + 10, top + 81); bx += bw + 8; });
    var corpoY = top + 105, corpoH = alt - 105 - 64;
    ctx.fillStyle = FUNDO_CHAT; ctx.fillRect(cx, corpoY, cw, corpoH);
    ctx.strokeStyle = "rgba(43,168,74,.10)"; ctx.lineWidth = 2;
    for (var px = cx + 30; px < cx + cw; px += 90) for (var py = corpoY + 30; py < corpoY + corpoH; py += 90) { arred(px, py, 26, 18, 5); ctx.stroke(); }
    // cartões (de baixo para cima: mostra os últimos que couberem)
    var font = "400 14px " + UI, lh = 20, maxW = cw * 0.72 - 28, cartoes = [];
    for (var i = 0; i < st.vis; i++) {
      var msg = R.conversa[i];
      if (msg.de === "evento") { ctx.font = "500 13px " + UI; cartoes.push({ ev: true, texto: "⇄  " + msg.texto, w: ctx.measureText("⇄  " + msg.texto).width + 30, h: 30 }); continue; }
      var ls = linhas(msg.texto, maxW, font), bw = 0; ctx.font = font; ls.forEach(function (l) { bw = Math.max(bw, ctx.measureText(l).width); });
      cartoes.push({ m: msg, ls: ls, w: Math.max(bw + 28, 190), h: 32 + ls.length * lh + 16, hora: hora(i) });
    }
    var proxMsg = st.prox >= 0 ? R.conversa[st.prox] : null;
    if (proxMsg && proxMsg.de === "cliente") cartoes.push({ digitando: true, w: 52, h: 24 });
    var total = 0, gap = 14, lim = corpoH - 24, ini = 0;
    for (var j = cartoes.length - 1; j >= 0; j--) { if (total + cartoes[j].h + gap > lim) { ini = j + 1; break; } total += cartoes[j].h + gap; }
    var yy = corpoY + corpoH - 12 - total;
    cartoes.slice(ini).forEach(function (c) {
      if (c.ev) { var ex = cx + (cw - c.w) / 2; ctx.fillStyle = "#fff"; arred(ex, yy, c.w, c.h, 20); ctx.fill(); ctx.fillStyle = TINTA; ctx.font = "500 13px " + UI; ctx.fillText(c.texto, ex + 18, yy + c.h / 2 + 1); yy += c.h + gap; return; }
      var doCliente = c.digitando || c.m.de === "cliente", x0 = doCliente ? cx + 16 : cx + cw - 16 - c.w;
      ctx.save(); ctx.shadowColor = "rgba(0,0,0,.08)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2; ctx.fillStyle = doCliente ? "#fff" : MENTA; arred(x0, yy, c.w, c.h, 12); ctx.fill(); ctx.restore();
      if (c.digitando) { for (var k = 0; k < 3; k++) { ctx.globalAlpha = 0.45 + 0.4 * Math.max(0, Math.sin(t * 6 - k * 0.9)); ctx.fillStyle = "#9AA5AA"; ctx.beginPath(); ctx.arc(x0 + 17 + k * 9, yy + 12 - Math.max(0, Math.sin(t * 6 - k * 0.9)) * 1.5, 2.6, 0, Math.PI * 2); ctx.fill(); } ctx.globalAlpha = 1; yy += c.h + gap; return; }
      var nome = doCliente ? R.contato : R.atendente;
      ctx.fillStyle = doCliente ? "#E9EEF0" : "#fff"; ctx.beginPath(); ctx.arc(x0 + 20, yy + 16, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = TINTA; ctx.font = "600 9px " + UI; ctx.fillText(nome[0].toUpperCase(), x0 + 20 - ctx.measureText(nome[0].toUpperCase()).width / 2, yy + 17);
      ctx.font = "600 12px " + UI; ctx.fillText(nome, x0 + 32, yy + 17);
      ctx.font = font; ctx.fillStyle = TINTA; c.ls.forEach(function (l, k) { ctx.fillText(l, x0 + 14, yy + 38 + k * lh); });
      ctx.font = "italic 400 10px " + UI; ctx.fillStyle = "#9AA5AA"; ctx.fillText(c.hora + (doCliente ? "" : "  ✓✓"), x0 + c.w - 12 - ctx.measureText(c.hora + (doCliente ? "" : "  ✓✓")).width, yy + c.h - 9);
      yy += c.h + gap;
    });
    // campo de digitação: a próxima resposta da atendente aparece sendo digitada
    var iy = top + alt - 64; ctx.fillStyle = "#fff"; ctx.fillRect(cx, iy, cw, 64); ctx.fillStyle = LINHA; ctx.fillRect(cx, iy, cw, 1);
    ctx.strokeStyle = "#D5DCDF"; ctx.lineWidth = 1; arred(cx + 16, iy + 12, cw - 32 - (STORY ? 0 : 172), 40, 20); ctx.stroke();
    var dig = proxMsg && proxMsg.de === "atendente" ? proxMsg.texto.slice(0, Math.floor(proxMsg.texto.length * Math.min(1, st.prog * 1.2))) : "";
    ctx.font = "400 13px " + UI; ctx.fillStyle = dig ? TINTA : "#9AA5AA"; ctx.fillText(corta(dig ? dig + (Math.floor(t * 3) % 2 ? "|" : "") : T.campo, cw - 90 - (STORY ? 0 : 150)), cx + 34, iy + 33);
    if (!STORY) { ctx.fillStyle = "#4A585E"; ctx.font = "400 13px " + UI; ctx.strokeStyle = "#9AA5AA"; ctx.strokeRect(cx + cw - 160, iy + 25, 14, 14); ctx.fillText("Comentário interno", cx + cw - 140, iy + 33); }
    ctx.restore();
  }

  function fundo() {
    var g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, T.cores.fundo); g.addColorStop(1, T.cores.fundo_fim);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  function desenhar(t) {
    fundo();
    ctx.save(); ctx.translate(0, OFF);
    var H = Q; // dentro do quadro, a altura é a do quadrado
    seloLogo(40, 34, 64);
    var yT = titulo(40, 160, W - 80, 46, 2);
    janela(36, Math.max(yT + 24, 238), W - 72, H - Math.max(yT + 24, 238) - 124, t);
    botao(40, H - 100, 70, T.botao);
    ctx.fillStyle = "#fff"; ctx.textBaseline = "alphabetic"; ctx.font = "800 64px " + F; var pre = "R$" + R.valor; var wp = ctx.measureText(pre).width;
    ctx.font = "700 26px " + F; var wl = ctx.measureText(T.unidade_preco).width;
    var xr = W - 40 - Math.max(wp, wl); ctx.font = "800 64px " + F; ctx.fillText(pre, xr, H - 50);
    ctx.fillStyle = VERDE_CLARO; ctx.font = "700 26px " + F; ctx.fillText(T.unidade_preco, xr, H - 22);
    var st = estado(t);
    if (st.painel > 0) {
      var pw = W - 160, ph = 240, px = 80, py = (H - ph) / 2 + (1 - st.painel) * 40; ctx.globalAlpha = st.painel;
      ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.fillRect(0, -OFF, W, Q + 2 * OFF);
      var g2 = ctx.createLinearGradient(px, py, px + pw, py + ph); g2.addColorStop(0, T.cores.fundo); g2.addColorStop(1, T.cores.fundo_fim);
      ctx.fillStyle = g2; arred(px, py, pw, ph, 30); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "800 48px " + F;
      R.promessa.split("|").map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 2).forEach(function (l, k) { ctx.fillText(l, px + 44, py + 92 + k * 60); });
      ctx.fillStyle = VERDE_CLARO; ctx.font = "600 28px " + F; ctx.fillText(R.preco, px + 44, py + 206);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  window.__desenhar = desenhar;
  function gravar() {
    var stream = cv.captureStream(FPS), partes = [];
    var tipo = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].filter(function (m) { return window.MediaRecorder && MediaRecorder.isTypeSupported(m); })[0];
    if (!tipo) { window.__video = { erro: "MediaRecorder sem WebM" }; return; }
    var rec = new MediaRecorder(stream, { mimeType: tipo, videoBitsPerSecond: 6000000 });
    rec.ondataavailable = function (e) { if (e.data && e.data.size) partes.push(e.data); };
    rec.onstop = function () {
      // capa: o quadro com a conversa quase toda, sem o painel final
      desenhar(Math.max(0, fim - 0.2));
      var capa = cv.toDataURL("image/png").split(",")[1];
      var blob = new Blob(partes, { type: "video/webm" }), fr = new FileReader();
      fr.onload = function () { window.__video = { base64: String(fr.result).split(",")[1], tipo: tipo, bytes: blob.size, capa: capa }; };
      fr.readAsDataURL(blob);
    };
    var t0 = performance.now();
    rec.start(250);
    function quadro() { var t = (performance.now() - t0) / 1000; desenhar(Math.min(t, seg)); if (t < seg) requestAnimationFrame(quadro); else { desenhar(seg); setTimeout(function () { rec.stop(); }, 200); } }
    requestAnimationFrame(quadro);
  }
  // ?quadro=<segundos>: só desenha aquele instante, sem gravar (prévia)
  function pronto() { var q = /[?&]quadro=([\\d.]+)/.exec(location.search); if (q) { desenhar(Number(q[1])); window.__pronto = true; return; } desenhar(0); window.__pronto = true; gravar(); }
  var fontes = document.fonts ? Promise.all([document.fonts.load("800 60px 'Plus Jakarta Sans'"), document.fonts.load("400 18px 'Poppins'"), document.fonts.load("600 18px 'Poppins'")]).catch(function () {}) : Promise.resolve();
  var esperaLogo = new Promise(function (res) { if (logo.complete) res(); else { logo.onload = res; logo.onerror = res; setTimeout(res, 3000); } });
  Promise.all([fontes, esperaLogo]).then(pronto, pronto);
})();
</script></body></html>`;
}
