/**
 * Template de vídeo "conversa no chat" (1080×1920, Reels/Stories): a mesma tela do criativo estático, mas com a
 * conversa acontecendo. É desenhado num <canvas> (o único jeito de gravar dentro do navegador sem ffmpeg):
 * título com destaque, um telefone com o cabeçalho do setor e as mensagens entrando uma a uma com "digitando…",
 * e no fim o painel com a promessa e a linha de preço. A própria página grava o canvas com MediaRecorder
 * (WebM/VP9) e entrega o resultado em window.__video; render.ts espera por ele. Nada de IA generativa.
 */
import { LOGO_DATA_URI } from "./logo.ts";

export const VIDEO_LARGURA = 1080;
export const VIDEO_ALTURA = 1920;
export const VIDEO_FPS = 30;

export interface Mensagem {
  de: "cliente" | "atendente";
  texto: string;
}

export interface RoteiroVideo {
  titulo_imagem: string; // com [[destaque]]
  setor: string; // cabeçalho do chat, ex.: "Fiscal · Escritório Contábil"
  atendente: string; // nome de quem responde, ex.: "Ana · Fiscal"
  conversa: Mensagem[];
  promessa: string; // "linha 1 | linha 2"
  preco: string;
  segundos?: number;
}

export function htmlChatVideo(r: RoteiroVideo): string {
  const dados = JSON.stringify({ ...r, segundos: Math.min(30, Math.max(8, r.segundos ?? 15)) });
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700;800&display=swap">
<style>html,body{margin:0;background:#fff;width:${VIDEO_LARGURA}px;height:${VIDEO_ALTURA}px;overflow:hidden}canvas{display:block}</style></head>
<body><canvas id="c" width="${VIDEO_LARGURA}" height="${VIDEO_ALTURA}"></canvas>
<script>
(function () {
  var R = ${dados};
  var W = ${VIDEO_LARGURA}, H = ${VIDEO_ALTURA}, FPS = ${VIDEO_FPS};
  var cv = document.getElementById("c"), ctx = cv.getContext("2d");
  var logo = new Image(); logo.src = ${JSON.stringify(LOGO_DATA_URI)};
  var FONT = "'Plus Jakarta Sans', 'Helvetica Neue', Arial, sans-serif";
  var NAVY = "#1F3B47", LIME = "#6BD34B", MINT = "#B6F0C2", INK = "#16303B", GREY = "#6B7C84";

  // ---------- texto ----------
  function linhas(texto, maxW, font) {
    ctx.font = font; var out = [], atual = "";
    texto.split(/\\s+/).forEach(function (p) {
      var t = atual ? atual + " " + p : p;
      if (ctx.measureText(t).width > maxW && atual) { out.push(atual); atual = p; } else atual = t;
    });
    if (atual) out.push(atual);
    return out;
  }
  // título com [[destaque]]: desenha palavra a palavra, com a faixa verde atrás das destacadas
  function titulo(y) {
    var font = "800 60px " + FONT; ctx.font = font; ctx.textBaseline = "alphabetic";
    var partes = [], marcado = false;
    R.titulo_imagem.split(/(\\[\\[|\\]\\])/).forEach(function (s) { if (s === "[[") marcado = true; else if (s === "]]") marcado = false; else if (s) s.split(/\\s+/).forEach(function (w) { if (w) partes.push({ w: w, m: marcado }); }); });
    var ls = [[]], larg = 0, maxW = W - 112, esp = ctx.measureText(" ").width;
    partes.forEach(function (p) { var w = ctx.measureText(p.w).width; if (larg + w > maxW && ls[ls.length - 1].length) { ls.push([]); larg = 0; } ls[ls.length - 1].push(p); larg += w + esp; });
    ls.forEach(function (l, i) {
      var x = 56, yy = y + i * 70;
      l.forEach(function (p) {
        var w = ctx.measureText(p.w).width;
        if (p.m) { ctx.fillStyle = LIME; ctx.fillRect(x - 4, yy - 22, w + 8, 26); }
        ctx.fillStyle = NAVY; ctx.fillText(p.w, x, yy); x += w + esp;
      });
    });
    return y + ls.length * 70;
  }
  function arred(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  // ---------- roteiro no tempo ----------
  var seg = R.segundos, n = R.conversa.length;
  var inicio = 1.2, fim = seg - 3.2, passo = n ? (fim - inicio) / n : 1;
  function estado(t) {
    // quantas mensagens já apareceram e se há "digitando" para a próxima
    var vis = 0, digitando = -1;
    for (var i = 0; i < n; i++) { var ti = inicio + i * passo; if (t >= ti) vis = i + 1; else { if (t >= ti - Math.min(0.9, passo * 0.6)) digitando = i; break; } }
    return { vis: vis, digitando: digitando, painel: Math.max(0, Math.min(1, (t - (seg - 3)) / 0.5)) };
  }

  function desenhar(t) {
    var g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#F6FAF7"); g.addColorStop(1, "#E9F3EC");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (logo.complete && logo.naturalWidth) { var lw = 232, lh = lw * logo.naturalHeight / logo.naturalWidth; ctx.drawImage(logo, 56, 60, lw, lh); }
    var yT = titulo(230);
    // telefone
    var px = 56, py = Math.max(yT + 40, 400), pw = W - 112, ph = H - py - 330;
    ctx.save(); ctx.shadowColor = "rgba(31,59,71,.2)"; ctx.shadowBlur = 60; ctx.shadowOffsetY = 26; ctx.fillStyle = "#fff"; arred(px, py, pw, ph, 30); ctx.fill(); ctx.restore();
    ctx.save(); arred(px, py, pw, ph, 30); ctx.clip();
    ctx.fillStyle = "#1B6B45"; ctx.fillRect(px, py, pw, 92);
    ctx.fillStyle = "#fff"; ctx.font = "800 30px " + FONT; ctx.textBaseline = "middle"; ctx.fillText(R.setor, px + 36, py + 46);
    ctx.font = "600 24px " + FONT; ctx.fillStyle = "rgba(255,255,255,.85)"; var a = R.atendente; ctx.fillText(a, px + pw - 36 - ctx.measureText(a).width, py + 46);
    ctx.fillStyle = "#EFF4F1"; ctx.fillRect(px, py + 92, pw, ph - 92);
    // mensagens
    var st = estado(t), y = py + 92 + 36, font = "600 30px " + FONT, maxW = pw * 0.72 - 56;
    var bolhas = [];
    for (var i = 0; i < st.vis; i++) {
      var m = R.conversa[i], ls = linhas(m.texto, maxW, font), bw = 0;
      ls.forEach(function (l) { bw = Math.max(bw, ctx.measureText(l).width); });
      bw += 56; var bh = ls.length * 40 + 36;
      bolhas.push({ m: m, ls: ls, bw: bw, bh: bh });
    }
    if (st.digitando >= 0) bolhas.push({ digitando: true, m: R.conversa[st.digitando], bw: 120, bh: 64 });
    // se não couber, rola: mostra as últimas
    var total = 0; bolhas.forEach(function (b) { total += b.bh + 18; });
    var limite = ph - 92 - 72; while (total > limite && bolhas.length > 1) { total -= bolhas[0].bh + 18; bolhas.shift(); }
    bolhas.forEach(function (b) {
      var doCliente = b.m.de === "cliente", x = doCliente ? px + 28 : px + pw - 28 - b.bw;
      ctx.fillStyle = doCliente ? "#fff" : "#D9FDD3"; arred(x, y, b.bw, b.bh, 18); ctx.fill();
      if (b.digitando) { ctx.fillStyle = GREY; for (var k = 0; k < 3; k++) { var osc = Math.sin(t * 6 + k) * 4; ctx.beginPath(); ctx.arc(x + 36 + k * 24, y + 32 + osc, 7, 0, Math.PI * 2); ctx.fill(); } }
      else { ctx.fillStyle = INK; ctx.font = font; ctx.textBaseline = "alphabetic"; b.ls.forEach(function (l, k) { ctx.fillText(l, x + 28, y + 42 + k * 40); }); }
      y += b.bh + 18;
    });
    ctx.restore();
    // painel final
    if (st.painel > 0) {
      var yP = H - 300 + (1 - st.painel) * 60; ctx.globalAlpha = st.painel;
      var g2 = ctx.createLinearGradient(px, yP, px + pw, yP + 220); g2.addColorStop(0, "#0E6B3A"); g2.addColorStop(1, "#073A20");
      ctx.fillStyle = g2; arred(px, yP, pw, 236, 30); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "800 44px " + FONT; ctx.textBaseline = "alphabetic";
      R.promessa.split("|").map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 2).forEach(function (l, k) { ctx.fillText(l, px + 40, yP + 74 + k * 52); });
      ctx.fillStyle = MINT; ctx.font = "600 27px " + FONT; ctx.fillText(R.preco, px + 40, yP + 200);
      ctx.globalAlpha = 1;
    }
  }

  // ---------- gravação ----------
  function gravar() {
    var stream = cv.captureStream(FPS), partes = [];
    var tipo = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].filter(function (m) { return window.MediaRecorder && MediaRecorder.isTypeSupported(m); })[0];
    if (!tipo) { window.__video = { erro: "MediaRecorder sem WebM" }; return; }
    var rec = new MediaRecorder(stream, { mimeType: tipo, videoBitsPerSecond: 6000000 });
    rec.ondataavailable = function (e) { if (e.data && e.data.size) partes.push(e.data); };
    rec.onstop = function () {
      var blob = new Blob(partes, { type: "video/webm" }), fr = new FileReader();
      fr.onload = function () { window.__video = { base64: String(fr.result).split(",")[1], tipo: tipo, bytes: blob.size, capa: cv.toDataURL("image/png").split(",")[1] }; };
      fr.readAsDataURL(blob);
    };
    var t0 = performance.now();
    rec.start(250);
    function quadro() {
      var t = (performance.now() - t0) / 1000;
      desenhar(Math.min(t, seg));
      if (t < seg) requestAnimationFrame(quadro); else { desenhar(seg); setTimeout(function () { rec.stop(); }, 200); }
    }
    requestAnimationFrame(quadro);
  }
  function pronto() { desenhar(0); window.__pronto = true; gravar(); }
  var fontes = document.fonts ? document.fonts.load("800 60px 'Plus Jakarta Sans'").catch(function () {}) : Promise.resolve();
  var esperaLogo = new Promise(function (res) { if (logo.complete) res(); else { logo.onload = res; logo.onerror = res; setTimeout(res, 3000); } });
  Promise.all([fontes, esperaLogo]).then(pronto, pronto);
})();
</script></body></html>`;
}
