/**
 * Painel mínimo (GET /painel?token=ADMIN_TOKEN): uma página só, sem JavaScript, para ver o que o time está
 * fazendo: estado dos agentes, ações, criativos (com imagem), plano da semana, relatório, alertas, públicos e
 * custo de modelo. É deliberadamente simples; cada empresa pluga isto no painel que já tem.
 */
const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const reais = (c: unknown): string => (c == null ? "—" : `R$ ${(Number(c) / 100).toFixed(2).replace(".", ",")}`);
const ROT_NIVEL = ["só lê", "sombra", "executa"];

export function paginaPainel(p: Record<string, unknown>, token: string): string {
  const estado = (p.estado ?? {}) as Record<string, { nivel: number; parado: boolean }>;
  const acoes = ((p.acoes as { acoes?: Array<Record<string, unknown>> })?.acoes ?? []).slice(0, 30);
  const criativos = ((p.criativos as Array<Record<string, unknown>>) ?? []).slice(0, 8);
  const alertas = ((p.alertas as Array<Record<string, unknown>>) ?? []).slice(0, 10);
  const execucoes = ((p.execucoes as Array<Record<string, unknown>>) ?? []).slice(0, 12);
  const publicos = (p.publicos as Array<Record<string, unknown>>) ?? [];
  const plano = p.plano as { semana: string; plano: { diagnostico: string; metas: { custo_cadastro_alvo_cents: number; cadastros_semana: number }; teto_diario_sugerido_cents: number; angulos: Array<{ angulo: string; motivo: string }>; prioridades: string[] } } | null;
  const relatorio = p.relatorio as { semana: string; texto: string } | null;
  const modelos = p.modelos as { custo_24h_usd?: number; por_agente?: Array<Record<string, unknown>> } | undefined;
  const parado = estado.todos?.parado;
  const q = `?token=${encodeURIComponent(token)}`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Time de tráfego</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f4f7f5;color:#1e333b}main{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 10px}.sub{color:#5a6b73;margin:0 0 20px}
.cartao{background:#fff;border:1px solid #d9e2dd;border-radius:12px;padding:16px;margin:0 0 16px}.grade{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px 8px;border-top:1px solid #eef2f0;text-align:left;vertical-align:top}th{color:#5a6b73;font-weight:600}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;background:#e6eeea}.bom{background:#e7f6ec;color:#0e6b3a}.ruim{background:#fdecea;color:#b42318}.atencao{background:#fff3df;color:#8a5100}
.criativos{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.criativo img{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:8px;border:1px solid #d9e2dd}.criativo p{font-size:13px;color:#5a6b73;margin:6px 0 0;white-space:pre-line}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#5a6b73}.aviso{background:#fff3df;border:1px solid #f2cf94;border-radius:8px;padding:10px 12px;margin:0 0 16px}
</style></head><body><main>
<h1>Time de tráfego com IA</h1><p class="sub">${parado ? "<b>PARADO.</b> " : ""}Modelo: ${p.llm_configurado ? "ligado" : "sem chave"} · Escrita na Meta: ${p.meta_escrita_configurada ? "ligada" : "sem token"} · Custo de modelo nas últimas 24 h: US$ ${Number(modelos?.custo_24h_usd ?? 0).toFixed(3)}</p>
${parado ? '<div class="aviso">O botão de parar está acionado: nenhum agente roda. Para retomar: <span class="mono">PUT /admin/agentes/estado?agente=todos&amp;parado=0</span></div>' : ""}
<div class="grade">
<section class="cartao"><h2>Agentes</h2><table>${["analista", "gestor", "criador", "vigia", "estrategista", "relator", "publicos"].map((a) => `<tr><td><b>${a}</b></td><td><span class="tag ${estado[a]?.nivel === 2 ? "bom" : estado[a]?.nivel === 1 ? "atencao" : ""}">${ROT_NIVEL[estado[a]?.nivel ?? 0] ?? "?"}</span>${estado[a]?.parado ? ' <span class="tag ruim">parado</span>' : ""}</td></tr>`).join("")}</table>
<p class="mono">nível: PUT /admin/agentes/estado?agente=NOME&amp;nivel=0|1|2 · parar tudo: agente=todos&amp;parado=1</p></section>
<section class="cartao"><h2>Últimas rodadas</h2><table>${execucoes.map((e) => `<tr><td>${esc(e.agente)}</td><td>${esc(String(e.criado_em).slice(0, 16).replace("T", " "))}</td><td><span class="tag ${e.ok ? "bom" : "ruim"}">${e.ok ? "ok" : "erro"}</span> ${esc(e.resumo)}</td></tr>`).join("") || "<tr><td>Nenhuma rodada ainda.</td></tr>"}</table></section>
</div>
<section class="cartao"><h2>Ações (14 dias)</h2><table><tr><th>Dia</th><th>Origem</th><th>Ação</th><th>Alvo</th><th>Valor</th><th>Status</th><th>Motivo</th></tr>${acoes.map((a) => `<tr><td>${esc(a.dia)}</td><td>${esc(a.origem)}</td><td><b>${esc(a.tipo)}</b></td><td>${esc(a.alvo_nome)}</td><td>${a.valor_cents != null ? `${a.valor_anterior_cents != null ? reais(a.valor_anterior_cents) + " → " : ""}${reais(a.valor_cents)}` : ""}</td><td><span class="tag ${a.status === "executada" ? "bom" : a.status === "recusada" || a.status === "erro" ? "ruim" : "atencao"}">${esc(a.status)}</span></td><td>${esc(a.motivo)}${a.recusa ? ` <i>(${esc(a.recusa)})</i>` : ""}</td></tr>`).join("") || "<tr><td colspan=7>Nenhuma ação ainda.</td></tr>"}</table></section>
<section class="cartao"><h2>Criativos</h2><div class="criativos">${criativos.map((c) => { const copy = (c.copy ?? {}) as Record<string, string>; return `<div class="criativo">${c.imagem_chave ? `<img src="/painel/criativos/${esc(c.id)}.png${q}" alt="">` : ""}<p><span class="tag ${c.status === "publicado" ? "bom" : c.status === "sombra" ? "atencao" : "ruim"}">${esc(c.status)}</span> ${esc(c.dia)}</p><p><b>${esc(copy.headline)}</b></p><p>${esc(copy.texto_primario)}</p>${c.ad_id ? `<p class="mono">anúncio ${esc(c.ad_id)}</p>` : ""}</div>`; }).join("") || "<p>Nenhum criativo ainda.</p>"}</div></section>
<div class="grade">
<section class="cartao"><h2>Plano da semana${plano ? ` ${esc(plano.semana)}` : ""}</h2>${plano ? `<p>${esc(plano.plano.diagnostico)}</p><p><b>Meta:</b> ${reais(plano.plano.metas.custo_cadastro_alvo_cents)} por cadastro · ${esc(plano.plano.metas.cadastros_semana)} cadastros · até ${reais(plano.plano.teto_diario_sugerido_cents)}/dia</p><ul>${plano.plano.prioridades.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p><b>Ângulos:</b></p><ul>${plano.plano.angulos.map((a) => `<li><b>${esc(a.angulo)}</b> — ${esc(a.motivo)}</li>`).join("")}</ul>` : "<p>Ainda sem plano (o Estrategista escreve às segundas).</p>"}</section>
<section class="cartao"><h2>Relatório${relatorio ? ` ${esc(relatorio.semana)}` : ""}</h2><p>${relatorio ? esc(relatorio.texto) : "Ainda sem relatório (o Relator escreve às segundas)."}</p></section>
</div>
<div class="grade">
<section class="cartao"><h2>Alertas (14 dias)</h2><table>${alertas.map((a) => `<tr><td>${esc(a.dia)}</td><td><span class="tag ${a.gravidade === "grave" ? "ruim" : "atencao"}">${esc(a.gravidade)}</span></td><td><b>${esc(a.titulo)}</b><br>${esc(a.texto)}${a.acao ? `<br><i>${esc(a.acao)}</i>` : ""}</td></tr>`).join("") || "<tr><td>Nenhum alerta.</td></tr>"}</table></section>
<section class="cartao"><h2>Públicos</h2><table>${publicos.map((x) => `<tr><td>${esc(x.nome)}</td><td>${esc(x.pessoas ?? "—")} pessoas</td><td>${x.publico_id ? `<span class="tag bom">na Meta</span>` : esc(x.resposta)}</td></tr>`).join("") || "<tr><td>Ainda não gerados.</td></tr>"}</table>
<h2 style="margin-top:16px">Modelos (7 dias)</h2><table>${(modelos?.por_agente ?? []).map((m) => `<tr><td>${esc(m.agente)}</td><td class="mono">${esc(m.modelo)}</td><td>${esc(m.chamadas)} chamadas</td><td>US$ ${Number(m.custo_usd ?? 0).toFixed(3)}</td></tr>`).join("") || "<tr><td>Nenhuma chamada.</td></tr>"}</table></section>
</div>
</main></body></html>`;
}
