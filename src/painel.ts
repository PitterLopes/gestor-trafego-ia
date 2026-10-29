/**
 * Painel (GET /painel): uma página só, sem framework, com o negócio (ativos, MRR, novos, cancelamentos, coortes),
 * o funil do mês (gasto → cadastros → entradas → clientes), o time (estado, rodadas, ações), os criativos com os
 * botões de aprovar / reprovar / pedir melhoria (e o vídeo quando for vídeo), plano, relatório, alertas,
 * públicos, eventos para a Meta e ingestão. Entra quem tem sessão (login por e-mail) ou o token de administrador.
 */
import { EMPRESA } from "./config/negocio.ts";
import type { Metricas } from "./metricas.ts";
import type { Quem } from "./login.ts";

const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const reais = (c: unknown): string => (c == null ? "—" : `R$ ${(Number(c) / 100).toFixed(2).replace(".", ",")}`);
const pct = (v: unknown): string => (v == null ? "—" : `${String(v).replace(".", ",")}%`);
const ROT_NIVEL = ["só lê", "sombra", "executa"];
const mesBr = (m: string): string => { const [a, mm] = m.split("-"); return `${["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"][Number(mm) - 1]}/${a.slice(2)}`; };

export interface ExtrasPainel { eventos: { por_status: Array<Record<string, unknown>>; ultimos_erros: Array<Record<string, unknown>> }; eventos_ativos: boolean; ingestao: { ultimos: Array<Record<string, unknown>>; clientes: number; pagamentos: number; com_clique: number } }

export function paginaPainel(p: Record<string, unknown>, m: Metricas, x: ExtrasPainel, quem: Quem, q: string): string {
  const estado = (p.estado ?? {}) as Record<string, { nivel: number; parado: boolean }>;
  const acoes = ((p.acoes as { acoes?: Array<Record<string, unknown>> })?.acoes ?? []).slice(0, 30);
  const criativos = ((p.criativos as Array<Record<string, unknown>>) ?? []).slice(0, 12);
  const alertas = ((p.alertas as Array<Record<string, unknown>>) ?? []).slice(0, 10);
  const execucoes = ((p.execucoes as Array<Record<string, unknown>>) ?? []).slice(0, 12);
  const publicos = (p.publicos as Array<Record<string, unknown>>) ?? [];
  const plano = p.plano as { semana: string; plano: { diagnostico: string; metas: { custo_cadastro_alvo_cents: number; cadastros_semana: number }; teto_diario_sugerido_cents: number; angulos: Array<{ angulo: string; motivo: string; formato?: string }>; prioridades: string[] } } | null;
  const relatorio = p.relatorio as { semana: string; texto: string } | null;
  const modelos = p.modelos as { custo_24h_usd?: number; por_agente?: Array<Record<string, unknown>> } | undefined;
  const conta = p.conta as { gasto_7d?: number; cadastros_7d?: number; entradas_7d?: number; clientes_7d?: number; gasto_28d?: number; cadastros_28d?: number; entradas_28d?: number; clientes_28d?: number } | undefined;
  const parado = estado.todos?.parado;
  const meses = m.meses.slice(-6);
  const custo = (g: number | undefined, n: number | undefined) => (g && n ? reais(Math.round(g / n)) : "—");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(EMPRESA)} · painel</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f4f7f5;color:#1e333b}main{max-width:1160px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 10px}.sub{color:#5a6b73;margin:0 0 20px;font-size:14px}.sub a{color:#0e6b3a}
.cartao{background:#fff;border:1px solid #d9e2dd;border-radius:12px;padding:16px;margin:0 0 16px}.grade{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 12px}.kpi{background:#f4f7f5;border-radius:10px;padding:12px}.kpi b{display:block;font-size:22px}.kpi span{font-size:12px;color:#5a6b73}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px 8px;border-top:1px solid #eef2f0;text-align:left;vertical-align:top}th{color:#5a6b73;font-weight:600}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;background:#e6eeea}.bom{background:#e7f6ec;color:#0e6b3a}.ruim{background:#fdecea;color:#b42318}.atencao{background:#fff3df;color:#8a5100}
.criativos{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}.criativo img,.criativo video{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:8px;border:1px solid #d9e2dd;background:#000}.criativo video{aspect-ratio:9/16}.criativo p{font-size:13px;color:#5a6b73;margin:6px 0 0;white-space:pre-line}
.acoes{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.acoes form{display:contents}.acoes button{border:0;border-radius:8px;padding:8px 10px;font-weight:600;cursor:pointer;font-size:13px}.b1{background:#0e6b3a;color:#fff}.b2{background:#fdecea;color:#b42318}.b3{background:#e6eeea;color:#1e333b}
.criativo textarea{width:100%;box-sizing:border-box;margin-top:8px;border:1px solid #c9d4ce;border-radius:8px;padding:8px;font:inherit;font-size:13px}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#5a6b73}.aviso{background:#fff3df;border:1px solid #f2cf94;border-radius:8px;padding:10px 12px;margin:0 0 16px}
</style></head><body><main>
<h1>${esc(EMPRESA)} · painel</h1><p class="sub">${parado ? "<b>PARADO.</b> " : ""}${esc(quem.nome)} · Modelo: ${p.llm_configurado ? "ligado" : "sem chave"} · Escrita na Meta: ${p.meta_escrita_configurada ? "ligada" : "sem token"} · Eventos para a Meta: ${x.eventos_ativos ? "ligados" : "desligados"} · Modelos nas últimas 24 h: US$ ${Number(modelos?.custo_24h_usd ?? 0).toFixed(3)}${q ? "" : ' · <a href="#" onclick="fetch(\'/auth/sair\',{method:\'POST\'}).then(function(){location.href=\'/entrar\'});return false">sair</a>'}</p>
${parado ? '<div class="aviso">O botão de parar está acionado: nenhum agente roda. Para retomar: <span class="mono">PUT /admin/agentes/estado?agente=todos&amp;parado=0</span></div>' : ""}
<div id="aviso-url"></div>

<section class="cartao"><h2>Negócio</h2>
<div class="kpis"><div class="kpi"><b>${m.hoje.ativos}</b><span>clientes ativos</span></div><div class="kpi"><b>${reais(m.hoje.mrr_cents)}</b><span>receita recorrente (MRR)</span></div><div class="kpi"><b>${m.hoje.novos_30d}</b><span>clientes novos, 30 dias</span></div><div class="kpi"><b>${m.hoje.entradas_30d}</b><span>entradas no pagamento, 30 dias</span></div><div class="kpi"><b>${pct(m.hoje.conversao_30d_pct)}</b><span>entradas que viraram cliente</span></div></div>
<table><tr><th>Mês</th><th class="n">Entradas</th><th class="n">Novos</th><th class="n">Ativos</th><th class="n">MRR</th><th class="n">Cancelaram</th><th class="n">Churn</th><th class="n">Receita</th></tr>${meses.map((r) => `<tr><td>${mesBr(r.mes)}</td><td class="n">${r.entradas}</td><td class="n">${r.novos}</td><td class="n">${r.ativos}</td><td class="n">${reais(r.mrr_cents)}</td><td class="n">${r.cancelados}</td><td class="n">${pct(r.churn_pct)}</td><td class="n">${reais(r.receita_cents)}</td></tr>`).join("") || "<tr><td colspan=8>Sem pagamentos ainda. Ligue o webhook ou importe o CSV (docs/integracoes.md).</td></tr>"}</table>
${m.coortes.length ? `<h2 style="margin-top:16px">Coortes: de quem virou cliente no mês, % que ainda pagava depois</h2><table><tr><th>Mês</th><th class="n">Clientes</th><th class="n">+1 mês</th><th class="n">+2</th><th class="n">+3</th><th class="n">+6</th></tr>${m.coortes.slice(-8).map((c) => `<tr><td>${mesBr(c.mes)}</td><td class="n">${c.clientes}</td>${c.retidos.map((r) => `<td class="n">${pct(r)}</td>`).join("")}</tr>`).join("")}</table>` : ""}
</section>

<div class="grade">
<section class="cartao"><h2>Funil dos anúncios</h2><table><tr><th></th><th class="n">7 dias</th><th class="n">28 dias</th></tr>
<tr><td>Gasto</td><td class="n">${reais(conta?.gasto_7d)}</td><td class="n">${reais(conta?.gasto_28d)}</td></tr>
<tr><td>Cadastros (a plataforma conta)</td><td class="n">${conta?.cadastros_7d ?? "—"}</td><td class="n">${conta?.cadastros_28d ?? "—"}</td></tr>
<tr><td>Entradas no pagamento</td><td class="n">${conta?.entradas_7d ?? "—"}</td><td class="n">${conta?.entradas_28d ?? "—"}</td></tr>
<tr><td>Clientes (1º pagamento)</td><td class="n">${conta?.clientes_7d ?? "—"}</td><td class="n">${conta?.clientes_28d ?? "—"}</td></tr>
<tr><td>Custo por cadastro</td><td class="n">${custo(conta?.gasto_7d, conta?.cadastros_7d)}</td><td class="n">${custo(conta?.gasto_28d, conta?.cadastros_28d)}</td></tr>
<tr><td><b>Custo por cliente</b></td><td class="n"><b>${custo(conta?.gasto_7d, conta?.clientes_7d)}</b></td><td class="n"><b>${custo(conta?.gasto_28d, conta?.clientes_28d)}</b></td></tr></table></section>
<section class="cartao"><h2>Agentes</h2><table>${["analista", "gestor", "criador", "vigia", "estrategista", "relator", "publicos"].map((a) => `<tr><td><b>${a}</b></td><td><span class="tag ${estado[a]?.nivel === 2 ? "bom" : estado[a]?.nivel === 1 ? "atencao" : ""}">${ROT_NIVEL[estado[a]?.nivel ?? 0] ?? "?"}</span>${estado[a]?.parado ? ' <span class="tag ruim">parado</span>' : ""}</td></tr>`).join("")}</table>
<p class="mono">nível: PUT /admin/agentes/estado?agente=NOME&amp;nivel=0|1|2 · parar tudo: agente=todos&amp;parado=1</p>
<h2 style="margin-top:16px">Últimas rodadas</h2><table>${execucoes.map((e) => `<tr><td>${esc(e.agente)}</td><td>${esc(String(e.criado_em).slice(0, 16).replace("T", " "))}</td><td><span class="tag ${e.ok ? "bom" : "ruim"}">${e.ok ? "ok" : "erro"}</span> ${esc(e.resumo)}</td></tr>`).join("") || "<tr><td>Nenhuma rodada ainda.</td></tr>"}</table></section>
</div>

<section class="cartao"><h2>Ações (14 dias)</h2><table><tr><th>Dia</th><th>Origem</th><th>Ação</th><th>Alvo</th><th>Valor</th><th>Status</th><th>Motivo</th></tr>${acoes.map((a) => `<tr><td>${esc(a.dia)}</td><td>${esc(a.origem)}</td><td><b>${esc(a.tipo)}</b></td><td>${esc(a.alvo_nome)}</td><td>${a.valor_cents != null ? `${a.valor_anterior_cents != null ? reais(a.valor_anterior_cents) + " → " : ""}${reais(a.valor_cents)}` : ""}</td><td><span class="tag ${a.status === "executada" ? "bom" : a.status === "recusada" || a.status === "erro" ? "ruim" : "atencao"}">${esc(a.status)}</span></td><td>${esc(a.motivo)}${a.recusa ? ` <i>(${esc(a.recusa)})</i>` : ""}</td></tr>`).join("") || "<tr><td colspan=7>Nenhuma ação ainda.</td></tr>"}</table></section>

<section class="cartao" id="criativos"><h2>Criativos do Criador</h2><p class="sub">Em <b>sombra</b> o criativo está pronto e esperando você: publicar sobe para a Meta no conjunto de teste; reprovar arquiva; "gerar nova versão" manda o seu pedido ao Criador e a versão nova volta aqui, em sombra.</p><div class="criativos">${criativos.map((c) => {
    const copy = (c.copy ?? {}) as Record<string, string>;
    const midia = c.formato === "video" && c.video_chave ? `<video controls preload="metadata" poster="/painel/criativos/${esc(c.id)}-capa.png${q}" src="/painel/criativos/${esc(c.id)}.webm${q}"></video>` : c.imagem_chave ? `<img src="/painel/criativos/${esc(c.id)}.png${q}" alt="">` : "";
    const form = (acao: string, cls: string, rot: string) => `<form method="post" action="/painel/criativos/${esc(c.id)}/${acao}${q}"><button class="${cls}" type="submit">${rot}</button></form>`;
    const botoes = c.status === "sombra" ? `<div class="acoes">${form("publicar", "b1", "Publicar na Meta")}${form("reprovar", "b2", "Reprovar")}</div><form method="post" action="/painel/criativos/${esc(c.id)}/melhorar${q}"><textarea name="feedback" rows="2" placeholder="O que melhorar? (ex.: título mais curto, falar do preço antes)" required></textarea><div class="acoes"><button class="b3" type="submit">Gerar nova versão</button></div></form>` : "";
    return `<div class="criativo">${midia}<p><span class="tag ${c.status === "publicado" ? "bom" : c.status === "sombra" ? "atencao" : "ruim"}">${esc(c.status)}</span> ${esc(c.dia)}${c.formato === "video" ? " · vídeo" : ""}${c.criativo_pai ? ` · nova versão do nº ${esc(c.criativo_pai)}` : ""}</p><p><b>${esc(copy.headline)}</b></p><p>${esc(copy.texto_primario)}</p>${c.feedback ? `<p><i>Pedido: ${esc(c.feedback)}</i></p>` : ""}${c.ad_id ? `<p class="mono">anúncio ${esc(c.ad_id)}</p>` : ""}${c.resposta && c.status === "erro" ? `<p class="mono">${esc(c.resposta)}</p>` : ""}${botoes}</div>`;
  }).join("") || "<p>Nenhum criativo ainda. Peça um: <span class=\"mono\">POST /admin/criativos/pedir?angulo=...&amp;formato=imagem|video</span></p>"}</div></section>

<div class="grade">
<section class="cartao"><h2>Plano da semana${plano ? ` ${esc(plano.semana)}` : ""}</h2>${plano ? `<p>${esc(plano.plano.diagnostico)}</p><p><b>Meta:</b> ${reais(plano.plano.metas.custo_cadastro_alvo_cents)} por cadastro · ${esc(plano.plano.metas.cadastros_semana)} cadastros · até ${reais(plano.plano.teto_diario_sugerido_cents)}/dia</p><ul>${plano.plano.prioridades.map((y) => `<li>${esc(y)}</li>`).join("")}</ul><p><b>Ângulos:</b></p><ul>${plano.plano.angulos.map((a) => `<li><b>${esc(a.angulo)}</b> (${esc(a.formato ?? "imagem")}) — ${esc(a.motivo)}</li>`).join("")}</ul>` : "<p>Ainda sem plano (o Estrategista escreve às segundas).</p>"}</section>
<section class="cartao"><h2>Relatório${relatorio ? ` ${esc(relatorio.semana)}` : ""}</h2><p style="white-space:pre-line">${relatorio ? esc(relatorio.texto) : "Ainda sem relatório (o Relator escreve às segundas)."}</p></section>
</div>
<div class="grade">
<section class="cartao"><h2>Alertas (14 dias)</h2><table>${alertas.map((a) => `<tr><td>${esc(a.dia)}</td><td><span class="tag ${a.gravidade === "grave" ? "ruim" : "atencao"}">${esc(a.gravidade)}</span></td><td><b>${esc(a.titulo)}</b><br>${esc(a.texto)}${a.acao ? `<br><i>${esc(a.acao)}</i>` : ""}</td></tr>`).join("") || "<tr><td>Nenhum alerta.</td></tr>"}</table></section>
<section class="cartao"><h2>Públicos</h2><table>${publicos.map((y) => `<tr><td>${esc(y.nome)}</td><td>${esc(y.pessoas ?? "—")} pessoas</td><td>${y.publico_id ? `<span class="tag bom">na Meta</span>` : esc(y.resposta)}</td></tr>`).join("") || "<tr><td>Ainda não gerados.</td></tr>"}</table>
<h2 style="margin-top:16px">Modelos (7 dias)</h2><table>${(modelos?.por_agente ?? []).map((r) => `<tr><td>${esc(r.agente)}</td><td class="mono">${esc(r.modelo)}</td><td>${esc(r.chamadas)} chamadas</td><td>US$ ${Number(r.custo_usd ?? 0).toFixed(3)}</td></tr>`).join("") || "<tr><td>Nenhuma chamada.</td></tr>"}</table></section>
</div>
<div class="grade">
<section class="cartao"><h2>Eventos para a Meta (30 dias)</h2><table>${x.eventos.por_status.map((e) => `<tr><td>${esc(e.evento)}</td><td><span class="tag ${e.status === "enviado" ? "bom" : e.status === "erro" ? "ruim" : "atencao"}">${esc(e.status)}</span></td><td class="n">${esc(e.n)}</td><td class="n">${reais(e.valor_cents)}</td></tr>`).join("") || `<tr><td>${x.eventos_ativos ? "Nenhum evento ainda." : "Desligados. Para ligar: META_CAPI_ATIVO=true e META_DATASET_ID no wrangler.toml."}</td></tr>`}</table>${x.eventos.ultimos_erros.length ? `<p class="mono">${x.eventos.ultimos_erros.slice(0, 3).map((e) => esc(`${e.event_id}: ${e.resposta}`)).join("<br>")}</p>` : ""}</section>
<section class="cartao"><h2>Pagamento (ingestão)</h2><p>${x.ingestao.clientes} clientes · ${x.ingestao.pagamentos} pagamentos · ${x.ingestao.com_clique} clientes com o clique do anúncio</p><table>${x.ingestao.ultimos.slice(0, 8).map((e) => `<tr><td>${esc(String(e.recebido_em).slice(0, 16).replace("T", " "))}</td><td>${esc(e.fonte)}</td><td>${esc(e.tipo)}</td><td class="n">${esc(e.clientes)} cli · ${esc(e.pagamentos)} pag</td><td>${e.erro ? `<span class="tag ruim">${esc(e.erro)}</span>` : ""}</td></tr>`).join("") || "<tr><td>Nenhum webhook recebido. Veja docs/integracoes.md.</td></tr>"}</table></section>
</div>
<script>var a=new URLSearchParams(location.search).get("aviso");if(a){var d=document.getElementById("aviso-url");d.className="aviso";d.textContent=a}</script>
</main></body></html>`;
}
