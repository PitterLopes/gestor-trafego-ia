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
