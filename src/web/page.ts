/**
 * Tela local da AIRES (uma página, rotas por #). Abrir e navegar só faz GET
 * (banco). Ações humanas e a busca na Receita são POST com confirmação.
 * Atenção: o script abaixo vive dentro de um template literal — não use crase
 * nem cifrão-chave nele; monte textos por concatenação.
 */
export const PAGE_HTML = /* html */ `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIRES</title>
<style>
  :root {
    --bg: #0B1622; --panel: #111F2E; --panel2: #0E1B29; --line: #1E3247; --line2: #1A2C3E;
    --ink: #E6EEF5; --ink2: #B8C9D8; --muted: #8FA5B8; --faint: #6F8496;
    --teal: #3FC1B4; --teal-ink: #7FE0D4; --teal-bg: #0F2A26; --teal-line: #1E4A43;
    --blue: #4A9BE0; --blue-ink: #9CCBF3; --blue-bg: #10243A; --blue-line: #24507A;
    --amber: #E8A33D; --amber-ink: #F5C77E; --amber-bg: #2A2112; --amber-line: #5A4520;
    --red-ink: #F7A39C; --off: #3A4F63;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 "Segoe UI", system-ui, -apple-system, sans-serif; }
  a { color: #7FC8F2; text-decoration: none; } a:hover { color: #fff; text-decoration: underline; }
  .mono { font-family: Consolas, "Cascadia Mono", ui-monospace, monospace; }
  .app { display: flex; flex-wrap: wrap; min-height: 100vh; }
  nav.side { flex: 1 1 240px; max-width: 260px; background: #0A1420; border-right: 1px solid var(--line); padding: 20px 14px; display: flex; flex-direction: column; gap: 18px; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 0 6px; }
  .brand b { font-size: 21px; letter-spacing: .1em; color: #fff; }
  .brand small { display: block; font-size: 11px; color: var(--muted); }
  .grp { display: flex; flex-direction: column; gap: 2px; }
  .grp > span { padding: 0 10px 6px; font-size: 10px; font-weight: 700; letter-spacing: .12em; color: var(--faint); }
  .nav { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 7px; color: #C9D8E4; font-size: 13px; }
  .nav:hover { background: #13243A; text-decoration: none; color: #fff; }
  .nav.on { background: #17293B; color: #fff; font-weight: 700; }
  .nav .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .nav .badge { margin-left: auto; background: var(--amber); color: #1B1206; font-size: 11px; font-weight: 800; border-radius: 999px; padding: 1px 7px; }
  .nav.dis { color: #5B6F82; pointer-events: none; }
  main { flex: 999 1 640px; min-width: 0; display: flex; flex-direction: column; }
  header.top { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; padding: 16px 28px; border-bottom: 1px solid var(--line); background: var(--panel2); }
  header.top h1 { margin: 0; font-size: 20px; }
  header.top .sub { font-size: 12px; color: var(--muted); }
  .pills { margin-left: auto; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12px; }
  .pill { padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line); color: var(--ink2); }
  .pill.ok { background: var(--teal-bg); color: var(--teal-ink); border-color: var(--teal-line); }
  .content { padding: 22px 28px 48px; display: flex; flex-direction: column; gap: 20px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px; }
  .card h2 { margin: 0 0 12px; font-size: 16px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); gap: 12px; }
  .kpi { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .kpi span { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
  .kpi b { display: block; font-size: 30px; font-weight: 600; margin: 2px 0; }
  .kpi small { color: var(--muted); font-size: 12px; }
  .cols { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
  .wide { flex: 999 1 600px; min-width: 0; display: flex; flex-direction: column; gap: 20px; }
  .narrow { flex: 1 1 340px; min-width: 0; display: flex; flex-direction: column; gap: 20px; }
  .procs { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); gap: 10px; }
  .proc { background: var(--panel2); border: 1px solid var(--line2); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; min-height: 104px; }
  .proc.OPERANDO { border-color: var(--teal-line); } .proc.EM_CONSTRUCAO { border-color: var(--blue-line); }
  .proc .h { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-weight: 700; }
  .proc p { margin: 0; font-size: 12px; color: var(--ink2); }
  .proc small { margin-top: auto; font-size: 11px; color: var(--muted); }
  .sdot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .OPERANDO .sdot, .sdot.OPERANDO { background: var(--teal); } .EM_CONSTRUCAO .sdot, .sdot.EM_CONSTRUCAO { background: var(--blue); } .PLANEJADO .sdot, .sdot.PLANEJADO { background: var(--off); }
  .scroll { overflow-x: auto; }
  .pipe { min-width: 1080px; display: grid; grid-template-columns: 180px repeat(10, minmax(0, 1fr)); gap: 6px; }
  .pipe .hd { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; text-align: center; }
  .pipe .hd:first-child { text-align: left; }
  .cell { border-radius: 6px; padding: 6px; font-size: 11px; line-height: 1.3; text-align: center; display: flex; align-items: center; justify-content: center; min-height: 44px; }
  .cell.done { background: var(--teal-bg); color: var(--teal-ink); border: 1px solid var(--teal-line); }
  .cell.run { background: var(--blue-bg); color: var(--blue-ink); border: 1px solid var(--blue-line); }
  .cell.wait { background: var(--amber-bg); color: var(--amber-ink); border: 1px solid var(--amber-line); }
  .cell.future { color: #5B6F82; border: 1px dashed #2A3F55; }
  .ent b { display: block; font-size: 13px; } .ent small { color: var(--muted); font-size: 11px; }
  .queue { background: #1A1A10; border-color: var(--amber-line); }
  .queue h2 { color: var(--amber-ink); }
  .qi { background: #221F12; border: 1px solid #4A3A1C; border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
  .qi .meta { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: #C9A86A; }
  .qi p { margin: 0; font-size: 12px; color: #D9CBB0; }
  .ev { display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line2); }
  .ev .t { font-size: 11px; color: var(--muted); padding-top: 2px; }
  .ev .ty { font-size: 11px; font-weight: 600; color: var(--teal-ink); overflow-wrap: anywhere; }
  .ev p { margin: 2px 0; font-size: 12px; color: #C6D4E0; } .ev small { font-size: 11px; color: var(--faint); }
  button { font: inherit; font-weight: 700; padding: 9px 14px; border-radius: 7px; border: 0; background: #2E6DA4; color: #fff; cursor: pointer; }
  button.warn { background: var(--amber); color: #1B1206; }
  button[disabled] { opacity: .5; cursor: not-allowed; }
  input[type=month], select { font: inherit; padding: 7px 10px; border-radius: 6px; border: 1px solid #2A3F55; background: var(--panel); color: #fff; }
  label.chk { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink); margin-right: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line2); vertical-align: top; font-size: 13px; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 600; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .st { font-weight: 700; } .ok { color: var(--teal-ink); } .wr { color: var(--amber-ink); } .bad { color: var(--red-ink); } .mut { color: var(--muted); font-weight: 400; }
  .empty { color: var(--muted); padding: 8px 0; }
  .toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); background: #E6EEF5; color: #0B1622; padding: 10px 16px; border-radius: 8px; display: none; max-width: 90vw; font-weight: 600; }
  .row { cursor: pointer; } .row:hover td { background: #13243A; }
  .tl { font-size: 12px; color: var(--ink2); margin: 6px 0 0; padding-left: 16px; }
  h3.sec { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin: 16px 0 6px; }
</style>
</head>
<body>
<div class="app">
  <nav class="side" aria-label="Menu principal">
    <div class="brand">
      <svg width="32" height="32" viewBox="0 0 30 30" fill="none" stroke="#3FC1B4" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="9" r="2.2"></circle><circle cx="21" cy="7" r="2.2"></circle><circle cx="15" cy="16" r="2.2"></circle><circle cx="23" cy="20" r="2.2"></circle><circle cx="9" cy="22" r="2.2"></circle><path d="M10 10l3.5 4.5M19.5 8.5L16 14M17 17l4.5 2M13.2 17.5L10.5 20.5M15 18.2V27"></path></svg>
      <div><b>AIRES</b><small>Inteligência Artificial para Resultados, Integração e Soluções</small></div>
    </div>
    <div class="grp"><span>OPERAÇÃO</span>
      <a class="nav" href="#/central" data-r="central"><span class="dot" style="background:#3FC1B4"></span>Central de agentes</a>
      <a class="nav" href="#/fila" data-r="fila"><span class="dot" style="background:#3FC1B4"></span>Fila humana<span class="badge" id="qbadge" hidden></span></a>
      <a class="nav" href="#/cases" data-r="cases"><span class="dot" style="background:#3FC1B4"></span>Cases e fechamento</a>
    </div>
    <div class="grp"><span>PROCESSOS</span>
      <a class="nav" href="#/processos" data-r="processos"><span class="dot" style="background:#3FC1B4"></span>Todos os processos</a>
    </div>
    <div class="grp"><span>CLIENTES</span>
      <a class="nav" href="#/empresas" data-r="empresas"><span class="dot" style="background:#3FC1B4"></span>Empresas</a>
      <a class="nav" href="#/receita" data-r="receita"><span class="dot" style="background:#3FC1B4"></span>Receita Federal</a>
      <a class="nav" href="#/documentos" data-r="documentos"><span class="dot" style="background:#3FC1B4"></span>Documentos fiscais</a>
    </div>
    <div class="grp"><span>CONTROLE</span>
      <a class="nav" href="#/regras" data-r="regras"><span class="dot" style="background:#3FC1B4"></span>Regras e legislação</a>
      <a class="nav dis" href="#/central"><span class="dot" style="background:#3A4F63"></span>Revisão independente</a>
      <a class="nav dis" href="#/central"><span class="dot" style="background:#3A4F63"></span>Auditoria</a>
    </div>
  </nav>
  <main>
    <header class="top">
      <div><h1 id="title">Central de agentes</h1><div class="sub" id="subtitle"></div></div>
      <div class="pills"><span class="pill ok">Sistema operando</span><span class="pill mono" id="meter">SERPRO –</span></div>
    </header>
    <div class="content" id="view"><div class="empty">Carregando…</div></div>
  </main>
</div>
<div class="toast" id="toast"></div>
<script>
var $ = function (id) { return document.getElementById(id); };
var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
var brl = function (v) { return v == null ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); };
var d = function (iso) { return iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : "—"; };
var dt = function (iso) { return iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "nunca"; };
var hm = function (iso) { var x = new Date(iso); return new Date().toDateString() === x.toDateString() ? x.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }) : dt(iso); };
var mm = function (c) { return c.slice(5, 7) + "/" + c.slice(0, 4); };
function toast(m) { var t = $("toast"); t.textContent = m; t.style.display = "block"; clearTimeout(t._h); t._h = setTimeout(function () { t.style.display = "none"; }, 6000); }
function asJson(r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.erro || "HTTP " + r.status); return b; }); }
function getJson(u) { return fetch(u, { cache: "no-store" }).then(asJson); }
function post(u, action, body) { return fetch(u, { method: "POST", headers: { "X-AIRES-Acao": action, "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then(asJson); }
function setHead(t, s) { $("title").textContent = t; $("subtitle").textContent = s || ""; }
function lastClosedMonth() { var n = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })); n.setDate(1); n.setMonth(n.getMonth() - 1); return n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0"); }
var STATUS_LABEL = { OPERANDO: "operando", EM_CONSTRUCAO: "em construção", PLANEJADO: "planejado" };

function loadCentral() {
  return getJson("/api/central").then(function (c) {
    $("meter").textContent = "SERPRO " + c.billedToday + "/" + c.dailyLimit + " hoje";
    var b = $("qbadge"); b.hidden = !c.human.length; b.textContent = c.human.length;
    return c;
  });
}

function queueItemHtml(q) {
  var head = '<div class="meta mono"><span>' + esc(q.type) + '</span><span>' + dt(q.since) + '</span></div><b>' + esc(q.entity || "—") + '</b><p>' + esc(q.title) + '</p>';
  if (q.kind === "services") {
    var svc = [["CONTABIL", "Contábil", 1], ["FISCAL", "Fiscal", 1], ["FOLHA", "Folha", 1], ["SOCIETARIO", "Societário", 1], ["FINANCEIRO", "Financeiro", 0], ["IRPF", "IRPF", 0]];
    var boxes = svc.map(function (s) { return '<label class="chk"><input type="checkbox" value="' + s[0] + '"' + (s[2] ? " checked" : "") + '> ' + s[1] + '</label>'; }).join("");
    return '<div class="qi" data-q="' + q.id + '">' + head + '<div>' + boxes + '</div>' +
      '<div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap"><div><label for="ini-' + q.id + '" style="display:block;font-size:12px;color:#C9A86A;margin-bottom:4px">Início da responsabilidade</label>' +
      '<input type="month" id="ini-' + q.id + '"></div><button class="warn" data-act="services" data-id="' + q.id + '">Confirmar</button></div></div>';
  }
  if (q.kind === "rules") {
    return '<div class="qi">' + head + '<p>' + esc(q.impact) + '</p><div><a class="nav" style="display:inline-flex;background:#E8A33D;color:#1B1206;font-weight:700" href="#/regras">Revisar e aprovar regras</a></div></div>';
  }
  if (q.kind === "ciencia") {
    return '<div class="qi">' + head + '<p>' + esc(q.impact) + '</p><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="warn" data-act="ciencia" data-id="' + q.id + '">Aprovar ciência</button><a class="nav" style="display:inline-flex" href="#/documentos/' + q.id + '">Ver as notas</a></div></div>';
  }
  if (q.kind === "approve") {
    return '<div class="qi">' + head + '<p>' + esc(q.impact) + '</p><div><button class="warn" data-act="approve" data-id="' + q.id + '">Aprovar conclusão</button></div></div>';
  }
  return '<div class="qi">' + head + '<p>' + esc(q.impact) + '</p></div>';
}

function eventsHtml(evs) {
  if (!evs.length) return '<div class="empty">Nenhum evento ainda.</div>';
  return evs.map(function (e) {
    return '<div class="ev"><span class="t mono">' + hm(e.at) + '</span><div><span class="ty mono">' + esc(e.type) + '</span><p>' + esc((e.entity ? e.entity + " · " : "") + e.text) + '</p><small>agente ' + esc(e.agent) + '</small></div></div>';
  }).join("");
}

function viewCentral() {
  setHead("Central de agentes", "O que a AIRES está fazendo agora, em todas as empresas e processos");
  return loadCentral().then(function (c) {
    var k = c.kpis;
    var kpis = [
      ["Empresas", k.entities, "monitoradas", "#fff"],
      ["Agentes operando", k.agentsOperating, "de " + k.agentsTotal + " previstos", "#7FE0D4"],
      ["Em andamento", k.inProgress, "Cases executando", "#9CCBF3"],
      ["Fila humana", k.humanQueue, "só exceções", "#F5C77E"],
      ["Aguardando cliente", k.waitingClient, k.waitingExternal + " aguardando órgão externo", "#fff"],
      ["Toques humanos", k.humanTouchesPerClient, "por cliente", "#fff"]
    ].map(function (x) { return '<div class="kpi"><span>' + x[0] + '</span><b class="mono" style="color:' + x[3] + '">' + x[1] + '</b><small>' + x[2] + '</small></div>'; }).join("");
    var procs = c.processes.map(function (p) {
      return '<a class="proc ' + p.status + '" href="#/processos" style="text-decoration:none;color:inherit"><div class="h"><span>' + esc(p.name) + '</span><span class="sdot"></span></div><p>' + esc(p.summary) + '</p><small class="mono">' + STATUS_LABEL[p.status] + ' · ' + esc(p.phase) + '</small></a>';
    }).join("");
    var pipe = '<div class="pipe"><span class="hd">Empresa</span>' + c.stages.map(function (s) { return '<span class="hd">' + esc(s) + '</span>'; }).join("") +
      c.pipeline.map(function (r) {
        return '<div class="ent"><a href="#/empresa/' + r.id + '" style="color:#E6EEF5"><b>' + esc(r.name) + '</b></a><small class="mono">' + esc(r.cnpj) + '</small></div>' + r.cells.map(function (x) { return '<div class="cell ' + x.kind + '">' + esc(x.text) + '</div>'; }).join("");
      }).join("") + '</div>';
    $("view").innerHTML =
      '<section class="kpis">' + kpis + '</section>' +
      '<div class="cols"><div class="wide">' +
        '<section class="card"><h2>Processos</h2><div class="procs">' + procs + '</div></section>' +
        '<section class="card"><h2>Esteira por empresa</h2><div class="scroll">' + pipe + '</div></section>' +
      '</div><div class="narrow">' +
        '<section class="card queue"><h2>Fila humana</h2>' + (c.human.length ? c.human.map(queueItemHtml).join("") : '<div class="empty">Nada esperando você.</div>') + '</section>' +
        '<section class="card"><h2>Barramento de eventos</h2>' + eventsHtml(c.events.slice(0, 12)) + '</section>' +
      '</div></div>';
  });
}

function viewFila() {
  setHead("Fila humana", "Só o que a AIRES não pode decidir sozinha. Cada decisão fica registrada na auditoria.");
  return loadCentral().then(function (c) {
    $("view").innerHTML = '<section class="card queue" style="max-width:820px"><h2>' + c.human.length + ' item(ns) esperando você</h2>' +
      (c.human.length ? c.human.map(queueItemHtml).join("") : '<div class="empty">Nada esperando você.</div>') + '</section>';
  });
}

function viewCases() {
  setHead("Cases e fechamento", "Toda operação é um Case, com cada mudança de situação registrada");
  return getJson("/api/cases").then(function (r) {
    var rows = r.cases.map(function (c, i) {
      var cls = c.status === "COMPLETED" ? "ok" : (c.status.indexOf("WAITING") === 0 || c.status === "IN_REVIEW") ? "wr" : "";
      var tl = '<ul class="tl" hidden id="tl-' + i + '">' + c.transitions.map(function (t) { return '<li>' + dt(t.at) + ' · ' + esc(t.fromPt) + ' → ' + esc(t.toPt) + (t.reason ? ' · ' + esc(t.reason) : '') + ' <span class="mut">(' + esc(t.actor) + ')</span></li>'; }).join("") + '</ul>';
      return '<tr class="row" data-tl="' + i + '"><td><b>' + esc(c.type) + '</b>' + tl + '</td><td>' + esc(c.entity || "—") + '</td><td>' + esc(c.agent) + '</td><td class="st ' + cls + '">' + esc(c.statusPt) + '</td><td class="num">' + c.openPending + '</td><td>' + dt(c.updatedAt) + '</td></tr>';
    }).join("");
    $("view").innerHTML = '<section class="card"><h2>Cases</h2><div class="scroll"><table><thead><tr><th>Case</th><th>Empresa</th><th>Agente</th><th>Situação</th><th class="num">Pendências</th><th>Atualizado</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6" class="empty">Nenhum Case.</td></tr>') + '</tbody></table></div><div class="empty">Clique no Case para ver o histórico. O fechamento mensal (fiscal, folha, contábil) aparece aqui quando esses motores entrarem em operação.</div></section>';
  });
}

function viewProcessos() {
  setHead("Processos", "Todos os processos da AIRES e a situação de cada um");
  return loadCentral().then(function (c) {
    var rows = c.processes.map(function (p) {
      return '<tr><td><span class="sdot ' + p.status + '" style="display:inline-block;margin-right:8px"></span><b>' + esc(p.name) + '</b></td><td>' + esc(p.summary) + '</td><td>' + STATUS_LABEL[p.status] + '</td><td>' + esc(p.phase) + '</td><td class="mono">' + esc(p.agents.join(", ")) + '</td></tr>';
    }).join("");
    $("view").innerHTML = '<section class="card"><div class="scroll"><table><thead><tr><th>Processo</th><th>O que faz</th><th>Situação</th><th>Fase</th><th>Agentes</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>';
  });
}

/* ---------------- Receita Federal (busca mensal) ---------------- */
var rf = { comp: lastClosedMonth(), state: null, selected: null, busy: false };
function viewReceita() {
  setHead("Receita Federal", "PGDAS-D, DAS e pagamentos por competência. Abrir esta tela não consulta a Receita.");
  return getJson("/api/competencia/" + rf.comp).then(function (s) {
    rf.state = s;
    var left = s.dailyLimit - s.billedToday;
    var today = new Date().toISOString().slice(0, 10);
    var rows = s.entities.map(function (e) {
      var st = !e.lastFetchedAt ? '<span class="mut">não buscado</span>' : e.declarations === 0 ? (today <= s.pgdasDeadline ? '<span class="st wr">a declarar até ' + d(s.pgdasDeadline).slice(0, 5) + '</span>' : '<span class="st bad">não declarado</span>') : '<span class="st ok">declarado</span>' + (e.declarations > 1 ? ' <span class="mut">(' + (e.declarations - 1) + ' retif.)</span>' : '');
      var das = !e.lastFetchedAt ? '—' : e.das === 0 ? '<span class="mut">sem DAS emitido</span>' : e.dasPaid > 0 ? '<span class="st ok">' + brl(e.dasPaidTotal) + '</span><div class="mut" style="font-size:12px">em ' + d(e.dasPaidOn) + '</div>' : '<span class="st wr">pagamento ainda não identificado</span>';
      var oth = !e.lastFetchedAt ? '—' : !e.otherCount ? '<span class="mut">nenhum</span>' : brl(e.otherTotal) + '<div class="mut" style="font-size:12px">' + e.otherCount + ' guia(s)</div>';
      var can = s.integraConfigured && left >= s.callsPerSearch && !rf.busy;
      return '<tr class="row" data-ent="' + e.id + '"><td><b>' + esc(e.name) + '</b><div class="mut mono" style="font-size:12px">' + esc(e.cnpj) + '</div></td><td>' + (e.poaValidTo ? 'até ' + d(e.poaValidTo) : '<span class="bad">não verificada</span>') + '</td><td>' + st + '</td><td class="num">' + das + '</td><td class="num">' + oth + '</td><td>' + dt(e.lastFetchedAt) + '</td><td class="num"><button data-buscar="' + e.id + '"' + (can ? '' : ' disabled') + '>Buscar</button></td></tr>';
    }).join("");
    $("view").innerHTML = '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><label for="comp" class="mut">Competência</label><input type="month" id="comp" value="' + rf.comp + '"><span class="mut">Prazo do PGDAS-D: ' + d(s.pgdasDeadline) + ' · cada Buscar = ' + s.callsPerSearch + ' consultas cobradas · clique na empresa para ver o detalhe</span></div>' +
      '<section class="card"><div class="scroll"><table><thead><tr><th>Empresa</th><th>Procuração e-CAC</th><th>PGDAS-D</th><th class="num">DAS pago</th><th class="num">Outros federais</th><th>Última busca</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div></section><section class="card" id="det" hidden></section>';
    $("comp").addEventListener("change", function () { rf.comp = $("comp").value; route(); });
    if (rf.selected) showDetail(rf.selected);
  });
}
function showDetail(id) {
  rf.selected = id;
  var e = rf.state.entities.find(function (x) { return x.id === id; });
  if (!e) return;
  getJson("/api/empresa/" + id + "/competencia/" + rf.comp).then(function (x) {
    var decl = x.declarations.length ? '<table><tr><th>Número</th><th>Tipo</th><th>Transmitida</th><th>Malha</th></tr>' + x.declarations.map(function (r) { return '<tr><td class="mono">' + esc(r.number) + '</td><td>' + (r.operation === "ORIGINAL" ? "Original" : "Retificadora") + '</td><td>' + dt(r.transmittedAt) + '</td><td>' + esc(r.malha || "—") + '</td></tr>'; }).join("") + '</table>' : '<div class="empty">Nenhuma declaração.</div>';
    var das = x.das.length ? '<table><tr><th>DAS</th><th>Emitido</th><th>PGDAS-D diz</th><th class="num">Pagamento identificado</th></tr>' + x.das.map(function (r) { return '<tr><td class="mono">' + esc(r.number) + '</td><td>' + dt(r.issuedAt) + '</td><td>' + (r.paidFlag === true ? "pago" : r.paidFlag === false ? "não consta pagamento" : "—") + '</td><td class="num">' + (r.payment ? brl(r.payment.total) + " em " + d(r.payment.collectedOn) : "ainda não identificado") + '</td></tr>'; }).join("") + '</table>' : '<div class="empty">Nenhum DAS emitido.</div>';
    var oth = x.otherPayments.length ? '<table><tr><th>Documento</th><th>Receita</th><th>PA</th><th>Pago em</th><th class="num">Valor</th></tr>' + x.otherPayments.map(function (r) { return '<tr><td>' + esc(r.documentType || "—") + '<div class="mut mono" style="font-size:11px">' + esc(r.documentNumber) + '</div></td><td>' + esc(r.revenueCode || "—") + (r.composition.length ? '<div class="mut" style="font-size:11px">' + r.composition.map(esc).join("<br>") + '</div>' : '') + '</td><td>' + (r.competence ? mm(r.competence) : "—") + '</td><td>' + d(r.collectedOn) + '</td><td class="num">' + brl(r.total) + (r.fineAndInterest ? '<div class="mut" style="font-size:11px">inclui multa+juros ' + brl(r.fineAndInterest) + '</div>' : '') + '</td></tr>'; }).join("") + '</table>' : '<div class="empty">Nenhum outro pagamento federal no mês e no seguinte.</div>';
    var det = $("det"); det.hidden = false;
    det.innerHTML = '<h2>' + esc(e.legalName) + ' — ' + mm(x.competence) + '</h2><div class="mut">última busca: ' + dt(x.lastFetchedAt) + ' · prazo do PGDAS-D: ' + d(x.pgdasDeadline) + '</div><h3 class="sec">Declarações PGDAS-D</h3>' + decl + '<h3 class="sec">DAS da competência</h3>' + das + '<h3 class="sec">Outros pagamentos federais</h3>' + oth;
  }).catch(function (err) { toast(err.message); });
}
function buscar(id) {
  var s = rf.state; var e = s.entities.find(function (x) { return x.id === id; });
  var msg = "Buscar " + mm(rf.comp + "-01") + " de " + e.name + " na Receita?\\n\\nIsso faz " + s.callsPerSearch + " consultas cobradas pelo SERPRO (hoje: " + s.billedToday + " de " + s.dailyLimit + ").";
  if (e.lastFetchedAt) msg += "\\n\\nJá buscado em " + dt(e.lastFetchedAt) + ". Buscar de novo só vale se algo mudou na Receita.";
  if (!window.confirm(msg)) return;
  rf.busy = true;
  post("/api/empresa/" + id + "/competencia/" + rf.comp + "/buscar", "buscar").then(function (b) { toast("Busca concluída: " + b.calls + " consultas cobradas."); rf.selected = id; })
    .catch(function (err) { toast("Busca não feita: " + err.message); })
    .then(function () { rf.busy = false; return loadCentral(); }).then(route);
}


/* ---------------- Empresas ---------------- */
var SRC = { CLIENT: "cliente", OFFICE: "escritório", EXTERNAL: "órgão externo" };
function viewEmpresas() {
  setHead("Empresas", "Clientes do escritório e a situação da implantação de cada um");
  return getJson("/api/empresas").then(function (r) {
    var rows = r.entities.map(function (e) {
      return '<tr class="row" data-goto="#/empresa/' + e.id + '"><td><b>' + esc(e.legal_name) + '</b><div class="mut mono" style="font-size:12px">' + esc(e.cnpj) + '</div></td><td>' + esc((e.regime || "—").replace("_", " ").toLowerCase()) + '</td><td>' + (e.start ? d(e.start) : '<span class="wr st">a definir</span>') + '</td><td class="num">' + e.open_items + '</td></tr>';
    }).join("");
    $("view").innerHTML = '<section class="card"><div class="scroll"><table><thead><tr><th>Empresa</th><th>Regime</th><th>Responsabilidade desde</th><th class="num">Itens em aberto</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>' +
      '<section class="card"><h2>Certificados A1 dos clientes</h2><p class="mut" style="margin:0 0 12px;font-size:13px">Os .pfx ficam em C:\\\\AIRES\\\\cofre\\\\clientes (pode ser em subpasta, com o CNPJ no nome do arquivo) e a senha no segredos.env (CERT_CNPJ_PASSWORD). A AIRES confere senha, CNPJ e validade; não consulta nenhum órgão.</p>' +
      '<button data-act="certs">Conferir certificados no cofre</button><div id="certs" style="margin-top:12px"></div></section>';
  });
}
function viewEmpresa(id) {
  return getJson("/api/empresa/" + id).then(function (e) {
    setHead(e.legalName, e.cnpj + (e.uf ? " · " + e.uf : "") + (e.activityStartedAt ? " · desde " + d(e.activityStartedAt) : ""));
    var f = e.facts;
    var facts = [
      ["Regime", (f.regime || "a definir").replace("_", " ").toLowerCase()],
      ["Responsabilidade da Legacy desde", f.responsibilityStart ? d(f.responsibilityStart) : "a definir"],
      ["Serviços", e.services.length ? e.services.map(function (s) { return s.name; }).join(", ") : "a definir"],
      ["Remuneração (folha ou pró-labore)", f.remuneration ? "sim · pela DCTFWeb paga" : "não identificada"],
      ["Empregados", f.employees ? "sim · INSS de empregados (1082)" : "não identificados"],
      ["Atividade de serviço (ISS)", f.serviceActivity ? "sim" : "não"]
    ].map(function (x) { return '<tr><td class="mut">' + x[0] + '</td><td>' + esc(x[1]) + '</td></tr>'; }).join("");
    var acc = e.access.map(function (a) {
      var cls = a.status === "OK" ? "ok" : a.status === "PENDENTE" ? "wr" : "mut";
      return '<tr><td>' + esc(a.system) + '</td><td class="st ' + cls + '">' + esc(a.status.toLowerCase()) + '</td><td class="mut">' + esc(a.detail) + '</td></tr>';
    }).join("");
    var obl = e.obligations.length ? e.obligations.map(function (o) {
      var nx = o.next.length ? o.next.map(function (n) { return d(n.due) + ' <span class="mut">(' + (o.periodicity === "ANUAL" ? n.competence.slice(0, 4) : mm(n.competence)) + ')</span>' + (n.adjustReason ? '<div class="wr" style="font-size:11px">' + esc(n.adjustReason) + '</div>' : ''); }).join("<br>") : '<span class="wr">prazo a cadastrar</span>';
      return '<tr><td><b>' + esc(o.name) + '</b><div class="mut" style="font-size:12px">' + esc(o.legal_basis) + ' · v' + o.version + (o.newer_pending ? ' <span class="wr">(versão nova aguardando aprovação)</span>' : '') + '</div></td><td>' + esc(o.sphere.toLowerCase()) + ' · ' + esc(o.periodicity.toLowerCase()) + '</td><td>' + d(o.valid_from) + '</td><td>' + nx + '</td></tr>';
    }).join("") : '<tr><td colspan="4" class="empty">Mapa ainda não gerado: precisa da data de início e das regras aprovadas.</td></tr>';
    var chk = e.checklist.map(function (p) {
      var cls = p.status === "OPEN" ? "wr" : "ok";
      return '<tr><td>' + esc(p.required_information) + '<div class="mut" style="font-size:12px">' + esc(p.impact) + '</div></td><td>' + esc(SRC[p.responsible_source] || p.responsible_source) + '</td><td>' + esc(p.caseType || "—") + '</td><td class="st ' + cls + '">' + (p.status === "OPEN" ? "pendente" : "resolvido") + '</td></tr>';
    }).join("");
    var cs = e.cases.map(function (c) { return '<tr><td>' + esc(c.type) + '</td><td class="st ' + (c.status === "COMPLETED" ? "ok" : "wr") + '">' + esc(c.statusPt) + '</td><td>' + dt(c.updatedAt) + '</td></tr>'; }).join("");
    $("view").innerHTML =
      '<div class="cols"><div class="wide">' +
        '<section class="card"><h2>Mapa de obrigações</h2><div class="scroll"><table><thead><tr><th>Obrigação</th><th>Esfera</th><th>Desde</th><th>Próximos vencimentos</th></tr></thead><tbody>' + obl + '</tbody></table></div></section>' +
        '<section class="card"><h2>Checklist da implantação</h2><div class="scroll"><table><thead><tr><th>Item</th><th>Responsável</th><th>Case</th><th>Situação</th></tr></thead><tbody>' + chk + '</tbody></table></div></section>' +
      '</div><div class="narrow">' +
        '<section class="card"><h2>Perfil</h2><table>' + facts + '</table></section>' +
        '<section class="card"><h2>Mapa de acessos</h2><table>' + acc + '</table></section>' +
        '<section class="card"><h2>Cases</h2><table>' + cs + '</table></section>' +
      '</div></div>';
  });
}

/* ---------------- Documentos fiscais ---------------- */
var KIND = { NFE: "NF-e completa", RES_NFE: "resumo de NF-e", EVENTO: "evento", RES_EVENTO: "resumo de evento", OUTRO: "outro" };
var CI = { APROVADA: "ciência aprovada · envio à SEFAZ pendente", ENVIADA: "ciência enviada", REGISTRADA: "ciência registrada", REJEITADA: "ciência rejeitada" };
function viewDocumentos(entityId) {
  setHead("Documentos fiscais", "NF-e e eventos que a SEFAZ distribui para cada empresa. A busca é automática e não tem custo.");
  return getJson("/api/documentos" + (entityId ? "?empresa=" + entityId : "")).then(function (r) {
    var st = r.status.map(function (e) {
      var last = e.lastQueryAt ? dt(e.lastQueryAt) + '<div class="mut" style="font-size:12px">' + esc((e.lastStatus || "") + " " + (e.lastMessage || "")) + '</div>' : '<span class="mut">nunca</span>';
      var next = !e.hasCertificate ? '<span class="wr">sem certificado</span>' : e.nextAllowedAt && new Date(e.nextAllowedAt) > new Date() ? 'a partir de ' + hm(e.nextAllowedAt) : 'agora';
      if (e.blockedBySequence) next = '<span class="bad st">parada</span><div class="mut" style="font-size:12px">outro sistema já baixa as notas deste CNPJ</div>';
      var row = '<tr><td><a href="#/documentos/' + e.id + '" style="color:#E6EEF5"><b>' + esc(e.name) + '</b></a><div class="mut mono" style="font-size:12px">' + esc(e.cnpj) + '</div></td><td class="num">' + e.fullNfe + '</td><td class="num">' + e.summaries + '</td><td class="num">' + e.documents + '</td><td>' + last + '</td><td>' + next + '</td><td class="num"><button data-act="dfe" data-id="' + e.id + '"' + (e.hasCertificate && r.configured ? '' : ' disabled') + '>Buscar agora</button></td></tr>';
      if (e.blockedBySequence) row += '<tr><td colspan="7" style="background:#221F12"><b class="wr">Busca parada para não renovar o bloqueio.</b> <span class="mut">Informe o último NSU do sistema que já baixa as notas (ou desligue a busca nele) e a AIRES continua daí, depois da espera de 1 hora.</span><div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><input id="nsu-' + e.id + '" inputmode="numeric" placeholder="último NSU (ex.: 000000000012345)" style="font:inherit;padding:7px 10px;border-radius:6px;border:1px solid #2A3F55;background:#111F2E;color:#fff;min-width:260px"><button class="warn" data-act="nsu" data-id="' + e.id + '">Usar este NSU</button></div></td></tr>';
      return row;
    }).join("");
    var docs = r.documents.map(function (x) {
      var what = x.kind === "EVENTO" || x.kind === "RES_EVENTO" ? esc(x.eventDesc || ("evento " + (x.eventType || ""))) : esc(KIND[x.kind] || x.kind) + (x.situation === "3" ? ' <span class="bad">cancelada</span>' : x.situation === "2" ? ' <span class="bad">denegada</span>' : '');
      var ci = x.kind !== "RES_NFE" ? "" : x.hasFull ? '<span class="ok">XML completo</span>' : x.ciencia ? '<span class="wr">' + esc(CI[x.ciencia] || x.ciencia) + '</span>' : x.situation === "1" ? '<span class="wr">aguarda sua ciência</span>' : '';
      return '<tr><td>' + (x.issuedAt ? dt(x.issuedAt) : "—") + '</td><td>' + esc(x.entity) + '</td><td><b>' + esc(x.issuerName || "—") + '</b><div class="mut mono" style="font-size:11px">' + esc(x.issuerDoc || "") + '</div></td><td>' + what + '<div>' + ci + '</div></td><td class="num">' + (x.total ? brl(x.total) : "—") + '</td><td class="mono" style="font-size:11px">' + esc(x.accessKey || "") + '</td></tr>';
    }).join("");
    $("view").innerHTML = '<section class="card"><h2>Busca na SEFAZ por empresa</h2><div class="scroll"><table><thead><tr><th>Empresa</th><th class="num">NF-e completas</th><th class="num">Resumos</th><th class="num">Documentos</th><th>Última consulta</th><th>Próxima consulta</th><th></th></tr></thead><tbody>' + st + '</tbody></table></div>' +
      '<div class="empty">Regra da SEFAZ: sem nota nova, a próxima consulta só depois de 1 hora (fora disso o CNPJ fica bloqueado por 1 hora). A AIRES segue essa regra sozinha.</div></section>' +
      '<section class="card"><h2>' + (entityId ? "Documentos da empresa" : "Documentos recebidos") + ' (' + r.documents.length + ')</h2>' + (entityId ? '<div style="margin-bottom:8px"><a href="#/documentos">ver todas as empresas</a></div>' : '') +
      '<div class="scroll"><table><thead><tr><th>Emissão</th><th>Empresa</th><th>Emitente</th><th>Documento</th><th class="num">Valor</th><th>Chave</th></tr></thead><tbody>' + (docs || '<tr><td colspan="6" class="empty">Nenhum documento recebido ainda.</td></tr>') + '</tbody></table></div></section>';
  });
}

/* ---------------- Regras ---------------- */
function viewRegras() {
  setHead("Regras e legislação", "Catálogo de obrigações. Nenhuma regra vale sem a aprovação do responsável técnico.");
  return getJson("/api/regras").then(function (r) {
    var pend = r.rules.filter(function (x) { return !x.approved_by; }).length;
    var rows = r.rules.map(function (x) {
      var ADJ = { NEXT_BUSINESS_DAY: "em dia não útil, prorroga", PREVIOUS_BUSINESS_DAY: "em dia não útil, antecipa", NONE: "sem ajuste" };
      var due = !x.due ? '<span class="wr">a cadastrar</span>' : (x.due.kind === "annual" ? "anual, " + String(x.due.day).padStart(2, "0") + "/" + String(x.due.month).padStart(2, "0") : "dia " + x.due.day + " do mês seguinte") + (x.due.adjust ? '<div class="mut" style="font-size:12px">' + ADJ[x.due.adjust] + '</div>' : '');
      return '<tr><td><b>' + esc(x.name) + '</b><div class="mut mono" style="font-size:11px">' + esc(x.code) + ' v' + x.version + (!x.approved_by && x.in_use_version ? ' · em uso: v' + x.in_use_version : '') + '</div></td><td>' + esc(x.sphere.toLowerCase()) + '</td><td>' + due + '</td><td>' + esc(x.legal_basis) + (x.notes ? '<div class="mut" style="font-size:12px">' + esc(x.notes) + '</div>' : '') + '</td><td class="st ' + (x.approved_by ? "ok" : "wr") + '">' + (x.approved_by ? "aprovada por " + esc(x.approved_by) : "proposta") + '</td></tr>';
    }).join("");
    $("view").innerHTML = '<section class="card"><h2>' + r.rules.length + ' regras · ' + pend + ' aguardando aprovação</h2><div class="scroll"><table><thead><tr><th>Regra</th><th>Esfera</th><th>Prazo</th><th>Fundamento</th><th>Situação</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="empty">Calendário: fins de semana e feriados nacionais. Na dúvida a AIRES usa a data mais cedo: dia só sem expediente bancário (Carnaval, Paixão, Corpus Christi) antecipa, mas não prorroga. Feriados municipais ainda não entram.</div>' +
      (pend ? '<div style="margin-top:14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><button class="warn" data-act="rules">Aprovar ' + pend + ' regra(s)</button><span class="mut">Confira prazos e fundamentos antes de aprovar. A aprovação fica na auditoria em seu nome e completa os mapas das empresas.</span></div>' : '') + '</section>';
  });
}

/* ---------------- ações ---------------- */
document.addEventListener("click", function (ev) {
  var b = ev.target.closest("button[data-act]");
  if (b) {
    var id = b.dataset.id;
    if (b.dataset.act === "services") {
      var box = document.querySelector('[data-q="' + id + '"]');
      var services = Array.prototype.slice.call(box.querySelectorAll("input[type=checkbox]:checked")).map(function (i) { return i.value; });
      var month = $("ini-" + id).value;
      if (!month) { toast("Informe o mês de início da responsabilidade."); return; }
      if (!services.length) { toast("Escolha ao menos um serviço."); return; }
      if (!window.confirm("Confirmar serviços (" + services.join(", ") + ") a partir de " + mm(month + "-01") + "?\\n\\nA decisão fica registrada na auditoria em seu nome.")) return;
      b.disabled = true;
      post("/api/pendencia/" + id + "/servicos", "confirmar", { services: services, startDate: month + "-01" })
        .then(function (r) { toast("Registrado. Implantação " + (r.caseStatus === "IN_REVIEW" ? "pronta para sua aprovação." : "atualizada.")); })
        .catch(function (err) { toast(err.message); b.disabled = false; })
        .then(route);
    }
    if (b.dataset.act === "rules") {
      if (!window.confirm("Aprovar as regras propostas?\\n\\nConfira prazos e fundamentos. A aprovação fica registrada na auditoria em seu nome.")) return;
      b.disabled = true;
      post("/api/regras/aprovar", "aprovar").then(function (r) { toast(r.approved + " regra(s) aprovada(s); " + r.obligationsAdded + " obrigação(ões) adicionada(s) aos mapas."); }).catch(function (err) { toast(err.message); b.disabled = false; }).then(function () { return loadCentral(); }).then(route);
    }
    if (b.dataset.act === "certs") {
      b.disabled = true;
      post("/api/certificados/conferir", "conferir").then(function (r) {
        $("certs").innerHTML = '<table><thead><tr><th>Empresa</th><th>Situação</th><th>Validade</th></tr></thead><tbody>' + r.results.map(function (x) {
          return '<tr><td><b>' + esc(x.name) + '</b><div class="mut mono" style="font-size:12px">' + esc(x.cnpj) + '</div></td><td class="st ' + (x.status === "OK" ? "ok" : "wr") + '">' + esc(x.message) + (x.hint ? '<div class="mut mono" style="font-size:11px;font-weight:400">' + esc(x.hint) + '</div>' : '') + '</td><td>' + (x.validTo ? d(x.validTo) : '—') + '</td></tr>';
        }).join("") + '</tbody></table>';
      }).catch(function (err) { toast(err.message); }).then(function () { b.disabled = false; });
    }
    if (b.dataset.act === "dfe") {
      b.disabled = true;
      post("/api/empresa/" + id + "/notas/buscar", "buscar-notas").then(function (r) {
        var msg = r.outcome === "aguardando" ? "A SEFAZ só pode ser consultada de novo a partir de " + hm(r.nextAllowedAt) + "." : r.outcome === "sem_certificado" ? "Sem certificado utilizável no cofre." : r.outcome === "erro" ? "Falha na consulta: " + r.statusMessage : r.documents + " documento(s) novo(s) em " + r.calls + " consulta(s). SEFAZ: " + r.statusCode + " " + (r.statusMessage || "");
        toast(msg);
      }).catch(function (err) { toast(err.message); }).then(function () { return loadCentral(); }).then(route);
    }
    if (b.dataset.act === "nsu") {
      var v = $("nsu-" + id).value.trim();
      if (!/^[0-9]{1,15}$/.test(v)) { toast("NSU deve ter só números."); return; }
      if (!window.confirm("Continuar a busca deste CNPJ a partir do NSU " + v + "?\\n\\nNotas com NSU menor não serão baixadas pela AIRES. A decisão fica na auditoria em seu nome.")) return;
      b.disabled = true;
      post("/api/empresa/" + id + "/notas/nsu", "confirmar", { nsu: v }).then(function (r) { toast("NSU ajustado. Próxima consulta a partir de " + hm(r.nextAllowedAt) + "."); }).catch(function (err) { toast(err.message); b.disabled = false; }).then(route);
    }
    if (b.dataset.act === "ciencia") {
      if (!window.confirm("Aprovar a ciência da operação para todas as NF-e desta empresa que aguardam?\\n\\nCiência não confirma nem recusa a operação: só libera o XML completo. A aprovação fica na auditoria em seu nome.")) return;
      b.disabled = true;
      post("/api/empresa/" + id + "/ciencia/aprovar", "aprovar").then(function (r) { toast(r.approved + " NF-e com ciência aprovada. O envio à SEFAZ entra na próxima etapa."); }).catch(function (err) { toast(err.message); b.disabled = false; }).then(function () { return loadCentral(); }).then(route);
    }
    if (b.dataset.act === "approve") {
      if (!window.confirm("Aprovar a conclusão deste Case?\\n\\nA aprovação fica registrada na auditoria em seu nome.")) return;
      b.disabled = true;
      post("/api/case/" + id + "/aprovar", "aprovar").then(function () { toast("Case concluído."); }).catch(function (err) { toast(err.message); b.disabled = false; }).then(route);
    }
    return;
  }
  var bb = ev.target.closest("button[data-buscar]");
  if (bb) { ev.stopPropagation(); if (!bb.disabled) buscar(bb.dataset.buscar); return; }
  var tr = ev.target.closest("tr[data-ent]");
  if (tr) { showDetail(tr.dataset.ent); return; }
  var tg = ev.target.closest("tr[data-goto]");
  if (tg) { location.hash = tg.dataset.goto; return; }
  var tc = ev.target.closest("tr[data-tl]");
  if (tc) { var u = $("tl-" + tc.dataset.tl); if (u) u.hidden = !u.hidden; }
});

var ROUTES = { documentos: viewDocumentos, central: viewCentral, fila: viewFila, cases: viewCases, processos: viewProcessos, receita: viewReceita, empresas: viewEmpresas, empresa: viewEmpresa, regras: viewRegras };
function route() {
  var parts = location.hash.replace(/^#\\/?/, "").split("/");
  var r = parts[0] || "central";
  if (!ROUTES[r]) r = "central";
  var navR = r === "empresa" ? "empresas" : r;
  Array.prototype.forEach.call(document.querySelectorAll(".nav[data-r]"), function (a) { a.classList.toggle("on", a.dataset.r === navR); });
  return ROUTES[r](parts[1]).catch(function (err) { toast(err.message); });
}
window.addEventListener("hashchange", route);
route();
</script>
</body>
</html>`;
