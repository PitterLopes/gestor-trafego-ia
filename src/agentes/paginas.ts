/**
 * Landing pages da empresa: o Worker baixa cada página (CRIADOR_PAGINAS), extrai o texto, e um modelo barato
 * resume em JSON (promessa, benefícios, provas, preço, chamada, público). O resumo fica em paginas_resumo e é
 * renovado só quando o texto da página muda ou passou mais de uma semana. O Criador recebe o resumo da página
 * de destino para a promessa do anúncio bater com o que a pessoa encontra ao clicar; o verificador o recebe
 * como mais uma fonte do que pode ser afirmado.
 */
import { sha256Hex } from "../util.ts";
import { chamarLlm } from "./llm.ts";
import type { LlmEnv } from "./llm.ts";

export const PAGINA_RENOVAR_DIAS = 7;
export const PAGINA_TEXTO_MAX = 8_000;

export interface PaginasEnv extends LlmEnv {
  CRIADOR_PAGINAS?: string; // URLs separadas por vírgula
  CRIADOR_LINK?: string;
  LLM_MODELO_VERIFICADOR?: string;
}

export interface ResumoPagina {
  promessa_principal: string;
  beneficios: string[];
  provas: string[];
  preco: string;
  chamada: string;
  publico: string;
}

const ESQUEMA_RESUMO = {
  type: "object",
  additionalProperties: false,
  required: ["promessa_principal", "beneficios", "provas", "preco", "chamada", "publico"],
  properties: {
    promessa_principal: { type: "string" },
    beneficios: { type: "array", items: { type: "string" } },
    provas: { type: "array", items: { type: "string" }, description: "Fatos verificáveis que a página afirma (números, garantias, integrações). Vazio se não houver." },
    preco: { type: "string" },
    chamada: { type: "string", description: "O que a página pede que a pessoa faça." },
    publico: { type: "string" },
  },
} as const;

const SISTEMA_RESUMO = `Você lê o texto de uma landing page e devolve, em JSON e em português do Brasil, o que ela promete, os benefícios que lista (no máximo 8), as provas que apresenta (no máximo 6; só o que está escrito, sem inventar), o preço como aparece, a chamada para ação e o público a que fala. Frases curtas, uma linha cada. Não acrescente nada que não esteja no texto.`;

export function urlsConfiguradas(env: PaginasEnv): string[] {
  const lista = (env.CRIADOR_PAGINAS ?? env.CRIADOR_LINK ?? "").split(",").map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u));
  return [...new Set(lista)];
}

/** HTML → texto corrido: tira script/style/nav, tags e espaço repetido. Suficiente para um resumo. */
const ENTIDADES: Record<string, string> = { nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
function decodificar(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, nome: string) => ENTIDADES[nome.toLowerCase()] ?? m);
}

export function extrairTexto(html: string): string {
  const semBlocos = html.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const titulo = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const metas = [...semBlocos.matchAll(/<meta[^>]+(?:name|property)=["'](?:description|og:title|og:description)["'][^>]*content=["']([^"']*)["']/gi)].map((m) => m[1]);
  const corpo = semBlocos
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  return decodificar([titulo.trim(), ...metas, corpo].filter(Boolean).join("\n")).slice(0, PAGINA_TEXTO_MAX);
}

export async function lerResumos(db: D1Database): Promise<Array<{ url: string; resumo: ResumoPagina | null; atualizado_em: string; erro: string | null }>> {
  const r = await db.prepare("SELECT url, resumo_json, atualizado_em, erro FROM paginas_resumo ORDER BY url").all<Record<string, unknown>>();
  return r.results.map((x) => ({ url: String(x.url), resumo: x.resumo_json ? (JSON.parse(String(x.resumo_json)) as ResumoPagina) : null, atualizado_em: String(x.atualizado_em), erro: x.erro == null ? null : String(x.erro) }));
}

/** Atualiza as páginas vencidas (ou todas, com `forcar`). Devolve o que fez com cada uma. */
export async function atualizarPaginas(env: PaginasEnv, fetchFn: typeof fetch = fetch, agora = new Date(), forcar = false): Promise<Array<{ url: string; resultado: string }>> {
  const out: Array<{ url: string; resultado: string }> = [];
  const atuais = new Map((await lerResumos(env.DB)).map((p) => [p.url, p]));
  for (const url of urlsConfiguradas(env)) {
    const atual = atuais.get(url);
    const idadeDias = atual ? (agora.getTime() - new Date(atual.atualizado_em).getTime()) / 86_400_000 : Infinity;
    if (!forcar && atual?.resumo && idadeDias < PAGINA_RENOVAR_DIAS) { out.push({ url, resultado: `ok, ${Math.floor(idadeDias)} dias` }); continue; }
    try {
      const res = await fetchFn(url, { headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (compatible; GestorTrafegoIA/1.0)" }, redirect: "follow" });
      const html = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const texto = extrairTexto(html);
      if (texto.length < 200) throw new Error("página sem texto suficiente");
      const hash = await sha256Hex(texto);
      const velho = await env.DB.prepare("SELECT texto_hash FROM paginas_resumo WHERE url = ?1").bind(url).first<{ texto_hash: string }>();
      if (!forcar && velho?.texto_hash === hash && atual?.resumo) {
        await env.DB.prepare("UPDATE paginas_resumo SET atualizado_em = ?2, erro = NULL WHERE url = ?1").bind(url, agora.toISOString()).run();
        out.push({ url, resultado: "texto igual, resumo mantido" });
        continue;
      }
      const r = await chamarLlm<ResumoPagina>(env, { agente: "paginas", modelo: env.LLM_MODELO_VERIFICADOR || "anthropic/claude-haiku-5.5", modeloReserva: "deepseek/deepseek-v4.1-flash", sistema: SISTEMA_RESUMO, usuario: `URL: ${url}\n\nTEXTO DA PÁGINA:\n${texto}`, esquema: ESQUEMA_RESUMO as unknown as Record<string, unknown>, nomeEsquema: "resumo_pagina", temperatura: 0, maxTokens: 2000, raciocinio: "none" }, fetchFn, agora);
      if (!r.ok) throw new Error(r.erro);
      await env.DB
        .prepare("INSERT INTO paginas_resumo (url, texto_hash, resumo_json, modelo, atualizado_em, erro) VALUES (?1, ?2, ?3, ?4, ?5, NULL) ON CONFLICT (url) DO UPDATE SET texto_hash = excluded.texto_hash, resumo_json = excluded.resumo_json, modelo = excluded.modelo, atualizado_em = excluded.atualizado_em, erro = NULL")
        .bind(url, hash, JSON.stringify(r.dados), r.modelo, agora.toISOString())
        .run();
      out.push({ url, resultado: "resumida" });
    } catch (e) {
      await env.DB.prepare("INSERT INTO paginas_resumo (url, texto_hash, resumo_json, atualizado_em, erro) VALUES (?1, '', '', ?2, ?3) ON CONFLICT (url) DO UPDATE SET erro = excluded.erro").bind(url, agora.toISOString(), String(e).slice(0, 500)).run();
      out.push({ url, resultado: `erro: ${String(e)}` });
    }
  }
  return out;
}

/** Resumo da página de destino, para o prompt. */
export function paginaParaModelo(p: { url: string; resumo: ResumoPagina | null } | undefined): string {
  if (!p?.resumo) return "";
  const r = p.resumo;
  return `PÁGINA DE DESTINO (${p.url}): a pessoa que clica no anúncio cai aqui; a promessa do anúncio tem que bater com ela.\n- Promessa: ${r.promessa_principal}\n- Benefícios: ${r.beneficios.join("; ")}\n- Provas que a página apresenta: ${r.provas.length ? r.provas.join("; ") : "nenhuma"}\n- Preço: ${r.preco}\n- Chamada: ${r.chamada}\n- Público: ${r.publico}`;
}
