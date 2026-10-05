/**
 * Página única da tela local. Abrir a página e navegar só faz GET (banco).
 * A consulta ao SERPRO só acontece no clique em "Buscar", após confirmação.
 */
export const PAGE_HTML = /* html */ `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IARIS — Receita Federal</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #fff; --ink: #14171f; --muted: #5d6573; --line: #e3e6eb;
    --brand: #0f4c81; --brand-ink: #fff; --ok: #1d7a46; --warn: #a15c00; --bad: #b42318; --chip: #eef1f5;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0f1216; --card: #171b21; --ink: #e8eaee; --muted: #9aa3b2; --line: #2a3039;
            --brand: #4a90d9; --brand-ink: #0b0d10; --ok: #4cc38a; --warn: #f0a63a; --bad: #f97066; --chip: #222831; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--ink); }
  header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 14px 24px; background: var(--card); border-bottom: 1px solid var(--line); }
  .logo { font-weight: 800; letter-spacing: .08em; color: var(--brand); font-size: 18px; }
  .office { color: var(--muted); }
  .spacer { flex: 1; }
  .meter { padding: 6px 10px; border-radius: 999px; background: var(--chip); font-variant-numeric: tabular-nums; }
  .meter.high { color: var(--warn); } .meter.full { color: var(--bad); }
  main { max-width: 1100px; margin: 0 auto; padding: 20px 16px 48px; }
  .bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  .bar label { color: var(--muted); }
  input[type=month] { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--ink); }
  .note { color: var(--muted); font-size: 13px; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
  tr:last-child td { border-bottom: 0; }
  tr.row { cursor: pointer; } tr.row:hover td { background: var(--chip); } tr.sel td { background: var(--chip); }
  .cnpj { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px; }
  .st { font-weight: 600; } .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); } .mut { color: var(--muted); font-weight: 400; }
  button { font: inherit; font-weight: 600; padding: 7px 14px; border-radius: 8px; border: 0; background: var(--brand); color: var(--brand-ink); cursor: pointer; }
  button[disabled] { opacity: .5; cursor: not-allowed; }
  .detail { margin-top: 18px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
  .detail h2 { margin: 0 0 4px; font-size: 16px; }
  .detail h3 { margin: 18px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .detail table { border: 0; } .detail td, .detail th { padding: 6px 8px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .empty { color: var(--muted); padding: 6px 0; }
  .toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 10px 16px; border-radius: 8px; display: none; max-width: 90vw; }
  .wrap { overflow-x: auto; border-radius: 10px; }
  .detail .wrap table { min-width: 560px; }
  @media (max-width: 720px) { .hide-sm { display: none; } header { padding: 12px 16px; } th, td { padding: 8px; } .cnpj { white-space: nowrap; } }
</style>
</head>
<body>
<header>
  <span class="logo">IARIS</span><span class="office" id="office"></span>
  <span class="spacer"></span>
  <span class="meter" id="meter" title="Consultas cobradas pelo SERPRO hoje, contra o teto diário do escritório">Consultas hoje: –</span>
</header>
<main>
  <div class="bar">
    <label for="comp">Competência</label>
    <input type="month" id="comp">
    <span class="note" id="hint"></span>
  </div>
  <div class="wrap"><table>
    <thead><tr><th>Empresa</th><th class="hide-sm">Procuração e-CAC</th><th>PGDAS-D</th><th class="num">DAS pago</th><th class="num">Outros federais (DARF, parcelas)</th><th class="hide-sm">Última busca</th><th></th></tr></thead>
    <tbody id="rows"><tr><td colspan="7" class="empty">Carregando…</td></tr></tbody>
  </table></div>
  <div class="note" style="margin-top:8px">Clique na empresa para ver declarações, DAS e guias da competência. Valores = pagamentos registrados na Receita (PagtoWeb). Abrir esta tela não consulta a Receita: mostra o que já foi buscado. Cada clique em <b>Buscar</b> faz <span id="cps">2</span> consultas cobradas pelo SERPRO para aquela empresa e competência.</div>
  <section class="detail" id="detail" hidden></section>
</main>
<div class="toast" id="toast"></div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const brl = (v) => v == null ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const d = (iso) => iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : "—";
const dt = (iso) => iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "nunca";
const mm = (comp) => comp.slice(5, 7) + "/" + comp.slice(0, 4);
let state = null, selected = null, busy = false;

function toast(msg) { const t = $("toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = "none", 6000); }

function lastClosedMonth() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  now.setDate(1); now.setMonth(now.getMonth() - 1);
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
}

async function getJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  const body = await r.json();
  if (!r.ok) throw new Error(body.erro || ("HTTP " + r.status));
  return body;
}

function statusCell(e) {
  if (!e.lastFetchedAt) return '<span class="st mut">não buscado</span>';
  if (e.declarations === 0) {
    const today = new Date().toISOString().slice(0, 10);
    return today <= state.pgdasDeadline
      ? '<span class="st warn">a declarar até ' + d(state.pgdasDeadline).slice(0, 5) + '</span>'
      : '<span class="st bad">não declarado</span>';
  }
  return '<span class="st ok">declarado</span>' + (e.declarations > 1 ? ' <span class="mut">(' + (e.declarations - 1) + ' retif.)</span>' : "");
}
function dasCell(e) {
  if (!e.lastFetchedAt) return '<span class="mut">—</span>';
  if (e.das === 0) return '<span class="mut">sem DAS emitido</span>';
  return e.dasPaid > 0
    ? '<span class="st ok">' + brl(e.dasPaidTotal) + '</span><div class="cnpj">em ' + d(e.dasPaidOn) + '</div>'
    : '<span class="st warn">pagamento ainda não identificado</span>';
}
function otherCell(e) {
  if (!e.lastFetchedAt) return '<span class="mut">—</span>';
  if (!e.otherCount) return '<span class="mut">nenhum</span>';
  return brl(e.otherTotal) + '<div class="cnpj">' + e.otherCount + ' guia(s)</div>';
}

function render() {
  $("office").textContent = state.office;
  $("cps").textContent = state.callsPerSearch;
  const m = $("meter");
  m.textContent = "Consultas hoje: " + state.billedToday + " de " + state.dailyLimit;
  m.className = "meter" + (state.billedToday >= state.dailyLimit ? " full" : state.billedToday >= state.dailyLimit * 0.75 ? " high" : "");
  $("hint").textContent = "Prazo do PGDAS-D desta competência: " + d(state.pgdasDeadline);
  const left = state.dailyLimit - state.billedToday;
  const rows = state.entities.map((e) => {
    const can = state.integraConfigured && left >= state.callsPerSearch && !busy;
    return '<tr class="row' + (selected === e.id ? " sel" : "") + '" data-id="' + e.id + '">' +
      '<td><div>' + esc(e.name) + '</div><div class="cnpj">' + esc(e.cnpj) + '</div></td>' +
      '<td class="hide-sm">' + (e.poaValidTo ? "até " + d(e.poaValidTo) : '<span class="bad">não verificada</span>') + '</td>' +
      '<td>' + statusCell(e) + '</td><td class="num">' + dasCell(e) + '</td><td class="num">' + otherCell(e) + '</td>' +
      '<td class="hide-sm">' + dt(e.lastFetchedAt) + '</td>' +
      '<td class="num"><button data-buscar="' + e.id + '"' + (can ? "" : " disabled") + '>Buscar</button></td></tr>';
  });
  $("rows").innerHTML = rows.join("") || '<tr><td colspan="7" class="empty">Nenhuma empresa cadastrada.</td></tr>';
}

async function load() {
  state = await getJson("/api/competencia/" + $("comp").value);
  render();
  if (selected) showDetail(selected);
}

function renderDetail(e, x) {
  const decl = x.declarations.length
    ? '<div class="wrap"><table><tr><th>Número</th><th>Tipo</th><th>Transmitida</th><th>Malha</th></tr>' + x.declarations.map((r) =>
        '<tr><td>' + esc(r.number) + '</td><td>' + (r.operation === "ORIGINAL" ? "Original" : "Retificadora") + '</td><td>' + dt(r.transmittedAt) + '</td><td>' + esc(r.malha || "—") + '</td></tr>').join("") + '</table></div>'
    : '<div class="empty">Nenhuma declaração ' + (x.lastFetchedAt ? "transmitida." : "— competência ainda não buscada.") + '</div>';
  const das = x.das.length
    ? '<div class="wrap"><table><tr><th>DAS</th><th>Emitido</th><th>PGDAS-D diz</th><th class="num">Pagamento identificado</th></tr>' + x.das.map((r) =>
        '<tr><td>' + esc(r.number) + '</td><td>' + dt(r.issuedAt) + '</td><td>' + (r.paidFlag === true ? "pago" : r.paidFlag === false ? "não consta pagamento" : "—") + '</td><td class="num">' +
        (r.payment ? brl(r.payment.total) + " em " + d(r.payment.collectedOn) : "ainda não identificado") + '</td></tr>').join("") + '</table></div>'
    : '<div class="empty">Nenhum DAS emitido para a competência.</div>';
  const other = x.otherPayments.length
    ? '<div class="wrap"><table><tr><th>Documento</th><th>Receita</th><th>PA</th><th>Pago em</th><th class="num">Valor</th></tr>' + x.otherPayments.map((r) =>
        '<tr><td>' + esc(r.documentType || "—") + '<div class="cnpj">' + esc(r.documentNumber) + '</div></td><td>' + esc(r.revenueCode || "—") +
        (r.composition.length ? '<div class="cnpj">' + r.composition.map(esc).join("<br>") + '</div>' : "") + '</td><td>' + (r.competence ? mm(r.competence) : "—") +
        '</td><td>' + d(r.collectedOn) + '</td><td class="num">' + brl(r.total) + (r.fineAndInterest ? '<div class="cnpj">inclui multa+juros ' + brl(r.fineAndInterest) + '</div>' : "") + '</td></tr>').join("") + '</table></div>'
    : '<div class="empty">Nenhum outro pagamento federal arrecadado entre ' + mm(x.competence) + ' e o mês seguinte.</div>';
  $("detail").innerHTML = '<h2>' + esc(e.legalName) + ' — ' + mm(x.competence) + '</h2><div class="note">' + esc(e.cnpj) +
    ' · última busca: ' + dt(x.lastFetchedAt) + ' · prazo do PGDAS-D: ' + d(x.pgdasDeadline) + '</div>' +
    '<h3>Declarações PGDAS-D</h3>' + decl + '<h3>DAS da competência</h3>' + das +
    '<h3>Outros pagamentos federais (arrecadados no mês e no seguinte)</h3>' + other;
  $("detail").hidden = false;
}

async function showDetail(id) {
  selected = id;
  const e = state.entities.find((x) => x.id === id);
  if (!e) return;
  render();
  renderDetail(e, await getJson("/api/empresa/" + id + "/competencia/" + $("comp").value));
}

async function buscar(id) {
  const e = state.entities.find((x) => x.id === id);
  const comp = $("comp").value;
  let msg = "Buscar " + comp.slice(5, 7) + "/" + comp.slice(0, 4) + " de " + e.name + " na Receita?\\n\\n" +
    "Isso faz " + state.callsPerSearch + " consultas cobradas pelo SERPRO (hoje: " + state.billedToday + " de " + state.dailyLimit + ").";
  if (e.lastFetchedAt) msg += "\\n\\nEsta competência já foi buscada em " + dt(e.lastFetchedAt) + ". Buscar de novo só vale se algo mudou na Receita.";
  if (!window.confirm(msg)) return;
  busy = true; render();
  try {
    const r = await fetch("/api/empresa/" + id + "/competencia/" + comp + "/buscar", { method: "POST", headers: { "X-IARIS-Acao": "buscar" } });
    const body = await r.json();
    if (!r.ok) throw new Error(body.erro || ("HTTP " + r.status));
    toast("Busca concluída: " + body.calls + " consultas cobradas.");
    selected = id;
  } catch (err) {
    toast("Busca não feita: " + err.message);
  } finally {
    busy = false;
    await load();
  }
}

$("rows").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-buscar]");
  if (b) { ev.stopPropagation(); if (!b.disabled) buscar(b.dataset.buscar); return; }
  const tr = ev.target.closest("tr.row");
  if (tr) showDetail(tr.dataset.id).catch((e) => toast(e.message));
});
$("comp").addEventListener("change", () => load().catch((e) => toast(e.message)));
$("comp").value = lastClosedMonth();
$("comp").max = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 7);
load().catch((e) => toast(e.message));
</script>
</body>
</html>`;
