/**
 * Renderiza o HTML de um criativo em PNG com o Browser Rendering da Cloudflare (binding BROWSER). Fica num
 * módulo à parte porque o pacote só roda dentro do Worker: os testes injetam uma função falsa no lugar desta.
 */
import puppeteer from "@cloudflare/puppeteer";
import type { BrowserWorker } from "@cloudflare/puppeteer";

export async function renderizarPng(browser: BrowserWorker, html: string, largura: number, altura: number): Promise<Uint8Array> {
  const b = await puppeteer.launch(browser);
  try {
    const page = await b.newPage();
    await page.setViewport({ width: largura, height: altura, deviceScaleFactor: 1 });
    // "load" basta: a página é toda inline. A fonte do Google é a única coisa que vem da rede; espera por ela
    // com um teto, senão a captura sai com a fonte reserva, o que é melhor do que não sair.
    await page.setContent(html, { waitUntil: "load", timeout: 45_000 });
    await page.evaluate("Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise(function (r) { setTimeout(r, 8000); })]).then(function () { return true; })");
    const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: largura, height: altura } });
    return new Uint8Array(png as Uint8Array);
  } finally {
    await b.close();
  }
}

/**
 * Grava o vídeo de um template que desenha em canvas e entrega window.__video (templates/chat_video.ts).
 * A gravação acontece em tempo real dentro do navegador (15 s de vídeo = 15 s de espera).
 */
export async function renderizarWebm(browser: BrowserWorker, html: string, largura: number, altura: number, segundos: number): Promise<{ webm: Uint8Array; capa: Uint8Array; tipo: string }> {
  const b = await puppeteer.launch(browser);
  try {
    const page = await b.newPage();
    await page.setViewport({ width: largura, height: altura, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load", timeout: 45_000 });
    const r = (await page.waitForFunction("window.__video", { timeout: (segundos + 25) * 1000, polling: 500 }).then(() => page.evaluate("window.__video"))) as { base64?: string; capa?: string; tipo?: string; erro?: string };
    if (!r || r.erro || !r.base64 || !r.capa) throw new Error(r?.erro ?? "o navegador não entregou o vídeo");
    const dec = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    return { webm: dec(r.base64), capa: dec(r.capa), tipo: r.tipo ?? "video/webm" };
  } finally {
    await b.close();
  }
}
