/**
 * Biblioteca de referência do Criador: o que a conta já aprendeu com dinheiro de verdade. Junta, por anúncio,
 * o texto do criativo (ads_anuncios) com o desempenho em 28 dias (ads_anuncio_diario) e separa os melhores e
 * os piores por custo por cadastro, mais o histórico dos criativos que o próprio Criador publicou. Vai para o
 * prompt como "isto funciona / isto não", nunca como texto para copiar.
 */
import { diaBrt } from "../anuncios.ts";
import { addDays } from "../util.ts";

/** Gasto mínimo em 28 dias para um anúncio entrar no ranking: abaixo disso o custo por cadastro é ruído. */
export const BIBLIOTECA_GASTO_MIN_CENTS = 15_000;
/** Cadastros mínimos para um anúncio contar como "funciona": com 2 ou 3 o custo por cadastro é sorte. */
export const BIBLIOTECA_CADASTROS_MIN = 5;
export const BIBLIOTECA_TOP = 3;

export interface AnuncioReferencia {
  anuncio_id: string;
  anuncio: string;
  status: string | null;
  titulo: string | null;
  texto: string | null;
  gasto_28d: number;
  cadastros_28d: number;
  custo_cadastro_cents: number | null;
  gerado_pelo_criador: boolean;
}

export interface Biblioteca {
  melhores: AnuncioReferencia[];
  piores: AnuncioReferencia[];
  do_criador: AnuncioReferencia[];
  media_conta_cents: number | null;
}

const n = (v: unknown): number => Number(v ?? 0) || 0;

export async function montarBiblioteca(db: D1Database, agora = new Date()): Promise<Biblioteca> {
  const de = diaBrt(addDays(agora, -27));
  const r = await db
    .prepare(
      `SELECT a.anuncio_id, a.anuncio, a.status, a.titulo, a.texto,
         COALESCE(SUM(d.gasto_cents), 0) AS gasto, COALESCE(SUM(d.resultados), 0) AS cadastros,
         (SELECT COUNT(*) FROM ads_criativos c WHERE c.ad_id = a.anuncio_id) AS do_criador
       FROM ads_anuncios a LEFT JOIN ads_anuncio_diario d ON d.plataforma = a.plataforma AND d.anuncio_id = a.anuncio_id AND d.dia >= ?1
       WHERE a.plataforma = 'meta' GROUP BY a.anuncio_id`,
    )
    .bind(de)
    .all<Record<string, unknown>>();
  const todos: AnuncioReferencia[] = r.results.map((x) => {
    const gasto = n(x.gasto), cad = n(x.cadastros);
    return { anuncio_id: String(x.anuncio_id), anuncio: String(x.anuncio), status: x.status == null ? null : String(x.status), titulo: x.titulo == null ? null : String(x.titulo), texto: x.texto == null ? null : String(x.texto), gasto_28d: gasto, cadastros_28d: cad, custo_cadastro_cents: cad > 0 ? Math.round(gasto / cad) : null, gerado_pelo_criador: n(x.do_criador) > 0 };
  });
  const comTexto = todos.filter((a) => a.gasto_28d >= BIBLIOTECA_GASTO_MIN_CENTS && (a.texto || a.titulo));
  const comCadastro = comTexto.filter((a) => a.custo_cadastro_cents != null).sort((a, b) => a.custo_cadastro_cents! - b.custo_cadastro_cents!);
  const semCadastro = comTexto.filter((a) => a.custo_cadastro_cents == null).sort((a, b) => b.gasto_28d - a.gasto_28d);
  const gastoTotal = comCadastro.reduce((s, a) => s + a.gasto_28d, 0), cadTotal = comCadastro.reduce((s, a) => s + a.cadastros_28d, 0);
  const melhores = comCadastro.filter((a) => a.cadastros_28d >= BIBLIOTECA_CADASTROS_MIN).slice(0, BIBLIOTECA_TOP);
  const pioresBase = [...semCadastro, ...comCadastro.slice().reverse()].filter((a) => !melhores.includes(a)).slice(0, BIBLIOTECA_TOP);
  return { melhores, piores: pioresBase, do_criador: todos.filter((a) => a.gerado_pelo_criador), media_conta_cents: cadTotal > 0 ? Math.round(gastoTotal / cadTotal) : null };
}

const reais = (c: number | null): string => (c == null ? "sem cadastro" : `R$ ${(c / 100).toFixed(2).replace(".", ",")}`);
const bloco = (a: AnuncioReferencia): string =>
  `- "${a.anuncio}" · ${a.custo_cadastro_cents == null ? "nenhum cadastro" : `${reais(a.custo_cadastro_cents)} por cadastro`} · R$ ${(a.gasto_28d / 100).toFixed(0)} em 28d · ${a.cadastros_28d} cadastros${a.gerado_pelo_criador ? " · gerado pelo Criador" : ""}\n  Título: ${a.titulo ?? "—"}\n  Texto: ${(a.texto ?? "—").replace(/\s+/g, " ").slice(0, 500)}`;

/** Texto para o prompt do Criador. Vazio quando a conta ainda não tem anúncio com gasto suficiente. */
export function bibliotecaParaModelo(b: Biblioteca): string {
  if (!b.melhores.length && !b.piores.length) return "";
  const partes: string[] = [];
  if (b.media_conta_cents != null) partes.push(`Custo por cadastro médio da conta em 28 dias: ${reais(b.media_conta_cents)}.`);
  if (b.melhores.length) partes.push(`O QUE FUNCIONA (melhores por custo por cadastro; aprenda o ângulo e o tom, não copie o texto):\n${b.melhores.map(bloco).join("\n")}`);
  if (b.piores.length) partes.push(`O QUE NÃO FUNCIONA (gastaram e trouxeram pouco ou nada; evite repetir a abordagem):\n${b.piores.map(bloco).join("\n")}`);
  const meus = b.do_criador.filter((a) => a.gasto_28d > 0);
  if (meus.length) partes.push(`CRIATIVOS ANTERIORES DO CRIADOR:\n${meus.map(bloco).join("\n")}`);
  return partes.join("\n\n");
}
