/**
 * Tela local da IARIS (uma página, rotas por #). Abrir e navegar só faz GET
 * (banco). Ações humanas e a busca na Receita são POST com confirmação.
 * Atenção: o script abaixo vive dentro de um template literal — não use crase
 * nem cifrão-chave nele; monte textos por concatenação.
 */
export const PAGE_HTML = /* html */ `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IARIS</title>
<style>
  :root {
    --bg: #F3F6F9; --panel: #FFFFFF; --panel2: #F8FAFC; --line: #E2E8F0; --line2: #EDF2F7;
    --ink: #0F172A; --ink2: #334155; --muted: #64748B; --faint: #94A3B8;
    --teal: #0F9D8F; --teal-ink: #0B7A6F; --teal-bg: #E7F7F4; --teal-line: #A8E2D9;
    --blue: #2563EB; --blue-ink: #1D4ED8; --blue-bg: #EFF5FF; --blue-line: #BFD3FB;
    --amber: #E8A33D; --amber-ink: #A95F07; --amber-bg: #FFF6E8; --amber-line: #F6D3A1;
    --red: #DC2626; --red-ink: #B91C1C; --red-bg: #FEF0F0; --red-line: #F8C4C4;
    --green: #16A34A; --green-ink: #15803D; --green-bg: #EAF8EF; --green-line: #B5E5C5;
    --off: #CBD5E1;
    --shadow: 0 1px 2px rgba(15, 23, 42, .05), 0 1px 3px rgba(15, 23, 42, .04);
  }
  * { box-sizing: border-box; }
  /* Ações por perfil: o servidor recusa de qualquer forma; aqui só some o botão. */
  body:not(.p-buscar) button[data-buscar], body:not(.p-buscar) button[data-act=decl], body:not(.p-buscar) button[data-act=dfe], body:not(.p-buscar) button[data-act=nfse],
  body:not(.p-confirmar) button[data-act=services], body:not(.p-confirmar) button[data-act=nsu], body:not(.p-confirmar) button[data-act=certs],
  body:not(.p-aprovar) button[data-act=approve], body:not(.p-aprovar) button[data-act=rules], body:not(.p-aprovar) button[data-act=srules],
  body:not(.p-aprovar) button[data-act=ciencia], body:not(.p-aprovar) button[data-act=exc], body:not(.p-aprovar) .only-aprovar,
  body:not(.p-confirmar) .only-confirmar { display: none; }
  .drop { border: 2px dashed var(--line); border-radius: 12px; padding: 16px; display: grid; gap: 8px; background: var(--panel2); }
  .drop.on { border-color: var(--teal); background: var(--teal-bg); }
  body:not(.p-confirmar) .drop { display: none; }
  .lks { display: grid; gap: 10px; }
  .lk { display: grid; grid-template-columns: minmax(0, 1.2fr) auto minmax(0, .7fr) auto minmax(0, 2fr); gap: 12px; align-items: center; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; background: var(--panel2); }
  .lk-lbl { display: block; font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); margin-bottom: 4px; }
  .lk-arrow { color: var(--teal); font-size: 18px; font-weight: 700; }
  .lk .caps { display: flex; flex-wrap: wrap; gap: 4px; }
  .ev { font-size: 12px; padding: 2px 8px; border-radius: 6px; background: var(--blue-bg); color: var(--blue-ink); border: 1px solid var(--blue-line); }
  @media (max-width: 760px) { .lk { grid-template-columns: 1fr; } .lk-arrow { transform: rotate(90deg); justify-self: start; } }
  body:not(.p-usuarios) .only-usuarios { display: none; }
  .form-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
  .form-row label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  .form-row input, .form-row select, td select { font: inherit; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); }
  .linkbox { margin-top: 12px; padding: 12px; border-radius: 10px; background: var(--teal-bg); border: 1px solid var(--teal-line); display: grid; gap: 8px; }
  .linkbox input { width: 100%; font-family: Consolas, ui-monospace, monospace; font-size: 12px; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--teal-line); background: var(--panel); color: var(--ink); }
  button.sair { background: transparent; border: 1px solid var(--line); color: var(--ink2); padding: 5px 12px; border-radius: 999px; font: inherit; font-size: 12px; cursor: pointer; }
  button.sair:hover { background: var(--panel2); }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 "Segoe UI", system-ui, -apple-system, sans-serif; }
  a { color: var(--blue); text-decoration: none; } a:hover { color: var(--blue-ink); text-decoration: underline; }
  .mono { font-family: Consolas, "Cascadia Mono", ui-monospace, monospace; }
  .app { display: flex; flex-wrap: wrap; min-height: 100vh; }
  nav.side { flex: 1 1 240px; max-width: 260px; background: var(--panel); border-right: 1px solid var(--line); padding: 20px 14px; display: flex; flex-direction: column; gap: 18px; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 0 6px; }
  .brand b { font-size: 21px; letter-spacing: .1em; color: var(--ink); }
  .brand small { display: block; font-size: 11px; color: var(--muted); line-height: 1.3; }
  .grp { display: flex; flex-direction: column; gap: 2px; }
  .grp > span { padding: 0 10px 6px; font-size: 10px; font-weight: 700; letter-spacing: .12em; color: var(--faint); }
  .nav { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 7px; color: var(--ink2); font-size: 13px; }
  .nav:hover { background: var(--panel2); text-decoration: none; color: var(--ink); }
  .nav.on { background: var(--teal-bg); color: var(--teal-ink); font-weight: 700; }
  .nav .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .nav .badge { margin-left: auto; background: var(--amber); color: #1B1206; font-size: 11px; font-weight: 800; border-radius: 999px; padding: 1px 7px; }
  .nav.dis { color: var(--faint); pointer-events: none; }
  main { flex: 999 1 640px; min-width: 0; display: flex; flex-direction: column; }
  header.top { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; padding: 16px 28px; border-bottom: 1px solid var(--line); background: var(--panel); }
  header.top h1 { margin: 0; font-size: 20px; }
  header.top .sub { font-size: 12px; color: var(--muted); }
  .pills { margin-left: auto; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12px; }
  .pill { padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line); color: var(--ink2); background: var(--panel); }
  .pill.ok { background: var(--green-bg); color: var(--green-ink); border-color: var(--green-line); }
  .content { padding: 22px 28px 48px; display: flex; flex-direction: column; gap: 20px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px; box-shadow: var(--shadow); }
  .card h2 { margin: 0 0 12px; font-size: 16px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); gap: 12px; }
  .kpi { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; box-shadow: var(--shadow); }
  .kpi span { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
  .kpi b { display: block; font-size: 30px; font-weight: 600; margin: 2px 0; }
  .kpi small { color: var(--muted); font-size: 12px; }
  .cols { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
  .wide { flex: 999 1 600px; min-width: 0; display: flex; flex-direction: column; gap: 20px; }
  .narrow { flex: 1 1 340px; min-width: 0; display: flex; flex-direction: column; gap: 20px; }
  .procs { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); gap: 10px; }
  .proc { background: var(--panel2); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; min-height: 104px; }
  .proc.OPERANDO { border-color: var(--green-line); background: var(--green-bg); } .proc.EM_CONSTRUCAO { border-color: var(--blue-line); }
  .proc .h { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-weight: 700; }
  .proc p { margin: 0; font-size: 12px; color: var(--ink2); }
  .proc small { margin-top: auto; font-size: 11px; color: var(--muted); }
  .sdot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .OPERANDO .sdot, .sdot.OPERANDO { background: var(--green); } .EM_CONSTRUCAO .sdot, .sdot.EM_CONSTRUCAO { background: var(--blue); } .PLANEJADO .sdot, .sdot.PLANEJADO { background: var(--red); }
  .scroll { overflow-x: auto; }
  .pipe { min-width: 1080px; display: grid; grid-template-columns: 180px repeat(10, minmax(0, 1fr)); gap: 6px; }
  .pipe .hd { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; text-align: center; }
  .pipe .hd:first-child { text-align: left; }
  .cell { border-radius: 6px; padding: 6px; font-size: 11px; line-height: 1.3; text-align: center; display: flex; align-items: center; justify-content: center; min-height: 44px; }
  .cell.done { background: var(--green-bg); color: var(--green-ink); border: 1px solid var(--green-line); }
  .cell.run { background: var(--blue-bg); color: var(--blue-ink); border: 1px solid var(--blue-line); }
  .cell.wait { background: var(--amber-bg); color: var(--amber-ink); border: 1px solid var(--amber-line); }
  .cell.future { color: var(--faint); border: 1px dashed var(--off); }
  .ent b { display: block; font-size: 13px; } .ent small { color: var(--muted); font-size: 11px; }
  .queue { background: var(--amber-bg); border-color: var(--amber-line); }
  .queue h2 { color: var(--amber-ink); }
  .qi { background: var(--panel); border: 1px solid var(--amber-line); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
  .qi .meta { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--amber-ink); }
  .qi p { margin: 0; font-size: 12px; color: var(--ink2); }
  .ev { display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line2); }
  .ev .t { font-size: 11px; color: var(--muted); padding-top: 2px; }
  .ev .ty { font-size: 11px; font-weight: 600; color: var(--teal-ink); overflow-wrap: anywhere; }
  .ev p { margin: 2px 0; font-size: 12px; color: var(--ink2); } .ev small { font-size: 11px; color: var(--faint); }
  button { font: inherit; font-weight: 700; padding: 9px 14px; border-radius: 7px; border: 0; background: var(--blue); color: #fff; cursor: pointer; }
  button:hover { background: var(--blue-ink); }
  button.warn { background: var(--amber); color: #1B1206; }
  button.ghost { background: transparent; border: 1px solid var(--line); color: var(--ink2); padding: 6px 12px; font-size: 12px; font-weight: 600; }
  button[disabled] { opacity: .5; cursor: not-allowed; }
  input[type=month], input:not([type]), select { font: inherit; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); }
  label.chk { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink); margin-right: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line2); vertical-align: top; font-size: 13px; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 600; background: var(--panel2); }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .st { font-weight: 700; } .ok { color: var(--green-ink); } .wr { color: var(--amber-ink); } .bad { color: var(--red-ink); } .mut { color: var(--muted); font-weight: 400; }
  .empty { color: var(--muted); padding: 8px 0; }
  .toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); background: var(--ink); color: #fff; padding: 10px 16px; border-radius: 8px; display: none; max-width: 90vw; font-weight: 600; box-shadow: 0 8px 24px rgba(15,23,42,.2); }
  .row { cursor: pointer; } .row:hover td { background: var(--panel2); }
  .tl { font-size: 12px; color: var(--ink2); margin: 6px 0 0; padding-left: 16px; }
  h3.sec { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin: 16px 0 6px; }
  /* Departamentos */
  .depts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(460px, 100%), 1fr)); gap: 16px; align-items: start; }
  .dept { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px; box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 10px; }
  .dept .dh { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .dept .dh h2 { margin: 0; font-size: 17px; }
  .meter { height: 8px; border-radius: 999px; background: var(--red-bg); overflow: hidden; border: 1px solid var(--red-line); }
  .meter i { display: block; height: 100%; background: var(--green); }
  .ag { border: 1px solid var(--line); border-left: 5px solid var(--red); border-radius: 10px; padding: 10px 12px; background: var(--panel); }
  .ag.on { border-left-color: var(--green); background: linear-gradient(90deg, var(--green-bg), var(--panel) 60%); }
  .ag .ah { display: flex; align-items: center; gap: 8px; font-weight: 700; }
  .ag .ah .tag { margin-left: auto; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: var(--red-bg); color: var(--red-ink); border: 1px solid var(--red-line); white-space: nowrap; }
  .ag.on .ah .tag { background: var(--green-bg); color: var(--green-ink); border-color: var(--green-line); }
  .lamp { width: 11px; height: 11px; border-radius: 50%; background: var(--red); box-shadow: 0 0 0 3px var(--red-bg); flex: none; }
  .ag.on .lamp { background: var(--green); box-shadow: 0 0 0 3px var(--green-bg); }
  .ag p { margin: 4px 0 6px; font-size: 12px; color: var(--ink2); }
  .caps { display: flex; flex-wrap: wrap; gap: 6px; }
  .cap { font-size: 11px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--red-line); color: var(--red-ink); background: var(--red-bg); }
  .cap.on { border-color: var(--green-line); color: var(--green-ink); background: var(--green-bg); }
  .act { font-size: 11px; color: var(--muted); margin-top: 6px; }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--ink2); align-items: center; }
  .legend span { display: inline-flex; gap: 6px; align-items: center; }
</style>
</head>
<body>
<div class="app">
  <nav class="side" aria-label="Menu principal">
    <div class="brand">
      <svg width="32" height="32" viewBox="0 0 30 30" fill="none" stroke="#0F9D8F" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="9" r="2.2"></circle><circle cx="21" cy="7" r="2.2"></circle><circle cx="15" cy="16" r="2.2"></circle><circle cx="23" cy="20" r="2.2"></circle><circle cx="9" cy="22" r="2.2"></circle><path d="M10 10l3.5 4.5M19.5 8.5L16 14M17 17l4.5 2M13.2 17.5L10.5 20.5M15 18.2V27"></path></svg>
      <div><b>IARIS</b><small>Inteligência Artificial para Resultados, Integração e Soluções</small></div>
    </div>
    <div class="grp"><span>OPERAÇÃO</span>
      <a class="nav" href="#/central" data-r="central"><span class="dot" style="background:var(--teal)"></span>Central de agentes</a>
      <a class="nav" href="#/fila" data-r="fila"><span class="dot" style="background:var(--teal)"></span>Fila humana<span class="badge" id="qbadge" hidden></span></a>
      <a class="nav" href="#/cases" data-r="cases"><span class="dot" style="background:var(--teal)"></span>Cases e fechamento</a>
    </div>
    <div class="grp"><span>DEPARTAMENTOS</span>
      <a class="nav" href="#/departamentos" data-r="departamentos"><span class="dot" style="background:var(--teal)"></span>Funcionamento dos agentes</a>
      <a class="nav" href="#/vinculos" data-r="vinculos"><span class="dot" style="background:var(--teal)"></span>Vínculos dos agentes</a>
      <a class="nav" href="#/depto/societario" data-r="depto-societario"><span class="dot" id="dd-societario" style="background:var(--off)"></span>Societário</a>
      <a class="nav" href="#/depto/fiscal" data-r="depto-fiscal"><span class="dot" id="dd-fiscal" style="background:var(--off)"></span>Fiscal</a>
      <a class="nav" href="#/depto/folha" data-r="depto-folha"><span class="dot" id="dd-folha" style="background:var(--off)"></span>Folha</a>
      <a class="nav" href="#/depto/contabil" data-r="depto-contabil"><span class="dot" id="dd-contabil" style="background:var(--off)"></span>Contábil</a>
    </div>
    <div class="grp"><span>PROCESSOS</span>
      <a class="nav" href="#/processos" data-r="processos"><span class="dot" style="background:var(--teal)"></span>Todos os processos</a>
    </div>
    <div class="grp"><span>CLIENTES</span>
      <a class="nav" href="#/empresas" data-r="empresas"><span class="dot" style="background:var(--teal)"></span>Empresas</a>
      <a class="nav" href="#/receita" data-r="receita"><span class="dot" style="background:var(--teal)"></span>Receita Federal</a>
      <a class="nav" href="#/documentos" data-r="documentos"><span class="dot" style="background:var(--teal)"></span>Documentos fiscais</a>
    </div>
    <div class="grp"><span>CONTROLE</span>
      <a class="nav" href="#/regras" data-r="regras"><span class="dot" style="background:var(--teal)"></span>Regras e legislação</a>
      <a class="nav only-usuarios" href="#/usuarios" data-r="usuarios"><span class="dot" style="background:var(--teal)"></span>Usuários e acessos</a>
      <a class="nav dis" href="#/central"><span class="dot" style="background:var(--off)"></span>Revisão independente</a>
      <a class="nav dis" href="#/central"><span class="dot" style="background:var(--off)"></span>Auditoria</a>
    </div>
  </nav>
  <main>
    <header class="top">
      <div><h1 id="title">Central de agentes</h1><div class="sub" id="subtitle"></div></div>
      <div class="pills"><span class="pill ok">Sistema operando</span><span class="pill mono" id="meter">SERPRO –</span><span class="pill" id="me">—</span><button class="sair" id="sair" type="button">Sair</button></div>
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
function asJson(r) { if (r.status === 401) { location.replace("/"); throw new Error("Sessão encerrada. Entre de novo."); } return r.json().then(function (b) { if (!r.ok) throw new Error(b.erro || "HTTP " + r.status); return b; }); }
function getJson(u) { return fetch(u, { cache: "no-store" }).then(asJson); }
function post(u, action, body) { return fetch(u, { method: "POST", headers: { "X-IARIS-Acao": action, "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then(asJson); }
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
      '<div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap"><div><label for="ini-' + q.id + '" style="display:block;font-size:12px;color:var(--amber-ink);margin-bottom:4px">Início da responsabilidade</label>' +
      '<input type="month" id="ini-' + q.id + '"></div><button class="warn" data-act="services" data-id="' + q.id + '">Confirmar</button></div></div>';
  }
  if (q.kind === "rules") {
    return '<div class="qi">' + head + '<p>' + esc(q.impact) + '</p><div><a class="nav" style="display:inline-flex;background:#E8A33D;color:#1B1206;font-weight:700" href="#/regras">Revisar e aprovar regras</a></div></div>';
  }
  if (q.kind === "divergence" && q.divergence) {
    var dv = q.divergence;
    var notes = (dv.notes || []).map(function (n) { return '<tr><td class="mono">' + esc(n.number || "—") + '</td><td class="num">' + brl(n.value) + '</td><td>' + (n.cancelledOn ? d(n.cancelledOn) : "—") + '</td><td class="mut">' + esc((n.event || "").replace(/_/g, " ").toLowerCase()) + '</td></tr>'; }).join("");
    return '<div class="qi">' + head +
      '<table style="margin:2px 0"><tr><td class="mut">Declarado no PGDAS-D</td><td class="num">' + brl(dv.declared) + '</td></tr><tr><td class="mut">NFS-e válidas</td><td class="num">' + brl(dv.nfse) + '</td></tr><tr><td><b>Diferença</b></td><td class="num"><b class="bad">' + brl(dv.difference) + '</b></td></tr></table>' +
      '<p><b>Hipótese:</b> ' + esc(dv.hypothesis) + (dv.responsibility === "ANTERIOR" ? ' <span class="wr">Período do escritório anterior.</span>' : '') + '</p>' +
      (notes ? '<details><summary class="mut" style="cursor:pointer;font-size:12px">Notas envolvidas (' + dv.notes.length + ')</summary><table><thead><tr><th>Número</th><th class="num">Valor</th><th>Cancelada em</th><th>Evento</th></tr></thead><tbody>' + notes + '</tbody></table></details>' : '') +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="warn" data-act="exc" data-dec="RETIFICAR" data-id="' + dv.case_id + '">Vou retificar o PGDAS-D</button><button class="ghost" data-act="exc" data-dec="MANTER" data-id="' + dv.case_id + '">Manter (justificar)</button>' + (dv.decision === "ADIAR" ? '' : '<button class="ghost" data-act="exc" data-dec="ADIAR" data-id="' + dv.case_id + '">Revisão posterior</button>') + '<a class="nav" style="display:inline-flex" href="#/empresa/' + dv.entity_id + '">Ver conferência</a></div></div>';
  }
  if (q.kind === "ciencia") {
    return '<div class="qi">' + head + '<p>' + esc(q.impact) + '</p><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="warn" data-act="ciencia" data-id="' + q.id + '">Aprovar ciência</button><a class="nav" style="display:inline-flex" href="#/documentos/' + q.id + '">Ver as notas</a></div></div>';
  }
  if (q.kind === "ledger") {
    return '<div class="qi">' + head + '<p>' + esc(q.impact) + '</p><div><a class="nav" style="display:inline-flex" href="#/empresa/' + q.entityId + '">Classificar movimentos</a></div></div>';
  }
  if (q.kind === "withholding") {
    return '<div class="qi">' + head + '<p>' + esc(q.impact) + '</p><div><a class="nav" style="display:inline-flex" href="#/empresa/' + q.entityId + '">Ver retenções da empresa</a></div></div>';
  }
  if (q.kind === "guide") {
    return '<div class="qi">' + head + '<p>' + esc(q.impact) + '</p><div><a class="nav" style="display:inline-flex" href="#/empresa/' + q.entityId + '">Ver guias da empresa</a></div></div>';
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
  setHead("Central de agentes", "O que a IARIS está fazendo agora, em todas as empresas e processos");
  return loadCentral().then(function (c) {
    var k = c.kpis;
    var kpis = [
      ["Empresas", k.entities, "monitoradas", "var(--ink)"],
      ["Agentes operando", k.agentsOperating, "de " + k.agentsTotal + " previstos", "var(--green-ink)"],
      ["Em andamento", k.inProgress, "Cases executando", "var(--blue-ink)"],
      ["Fila humana", k.humanQueue, "só exceções", "var(--amber-ink)"],
      ["Aguardando cliente", k.waitingClient, k.waitingExternal + " aguardando órgão externo", "var(--ink)"],
      ["Toques humanos", k.humanTouchesPerClient, "por cliente", "var(--ink)"]
    ].map(function (x) { return '<div class="kpi"><span>' + x[0] + '</span><b class="mono" style="color:' + x[3] + '">' + x[1] + '</b><small>' + x[2] + '</small></div>'; }).join("");
    var procs = c.processes.map(function (p) {
      return '<a class="proc ' + p.status + '" href="#/processos" style="text-decoration:none;color:inherit"><div class="h"><span>' + esc(p.name) + '</span><span class="sdot"></span></div><p>' + esc(p.summary) + '</p><small class="mono">' + STATUS_LABEL[p.status] + ' · ' + esc(p.phase) + '</small></a>';
    }).join("");
    var pipe = '<div class="pipe"><span class="hd">Empresa</span>' + c.stages.map(function (s) { return '<span class="hd">' + esc(s) + '</span>'; }).join("") +
      c.pipeline.map(function (r) {
        return '<div class="ent"><a href="#/empresa/' + r.id + '" style="color:var(--ink)"><b>' + esc(r.name) + '</b></a><small class="mono">' + esc(r.cnpj) + '</small></div>' + r.cells.map(function (x) { return '<div class="cell ' + x.kind + '">' + esc(x.text) + '</div>'; }).join("");
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
  setHead("Fila humana", "Só o que a IARIS não pode decidir sozinha. Cada decisão fica registrada na auditoria.");
  return loadCentral().then(function (c) {
    var def = (c.deferred || []).map(function (dv) {
      return queueItemHtml({ kind: "divergence", divergence: dv, type: "REVISAO_POSTERIOR", since: dv.since, entity: dv.entity, title: "Receita " + mm(dv.competence) + ": declarado no PGDAS-D × NFS-e prestadas não confere" });
    }).join("");
    $("view").innerHTML = '<section class="card queue" style="max-width:820px"><h2>' + c.human.length + ' item(ns) esperando você</h2>' +
      (c.human.length ? c.human.map(queueItemHtml).join("") : '<div class="empty">Nada esperando você.</div>') + '</section>' +
      (def ? '<section class="card" style="max-width:820px"><h2>Revisão posterior (' + c.deferred.length + ')</h2><div class="mut" style="font-size:12px;margin-bottom:4px">Exceções abertas que você deixou para depois. Nada foi transmitido.</div>' + def + '</section>' : '');
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
  setHead("Processos", "Todos os processos da IARIS e a situação de cada um");
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
    $("view").innerHTML = '<section class="card only-confirmar"><h2>Incluir empresa</h2>' +
      '<div class="form-row"><label>CNPJ<input id="inc-cnpj" placeholder="00.000.000/0000-00" style="width:190px"></label>' +
      '<label style="font-size:12px;display:flex;gap:6px;align-items:center"><input type="checkbox" id="inc-serpro"> Conferir procuração e regime no SERPRO agora (consulta cobrada)</label>' +
      '<button data-act="incluir">Incluir</button></div>' +
      '<p class="mut" style="margin:8px 0 0;font-size:12px">A IARIS busca o cadastro na base pública do CNPJ (estabelecimentos, CNAEs, sócios, endereço) e abre a implantação. Em seguida, na Fila humana, você informa os serviços contratados e o mês de início da responsabilidade; daí ela monta os mapas de acesso e de obrigações e a lista de documentos.</p></section>' +
      '<section class="card"><div class="scroll"><table><thead><tr><th>Empresa</th><th>Regime</th><th>Responsabilidade desde</th><th class="num">Itens em aberto</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>' +
      '<section class="card"><h2>Certificados A1 dos clientes</h2><p class="mut" style="margin:0 0 12px;font-size:13px">Os .pfx ficam em C:\\\\IARIS\\\\cofre\\\\clientes (pode ser em subpasta, com o CNPJ no nome do arquivo) e a senha no segredos.env (CERT_CNPJ_PASSWORD). A IARIS confere senha, CNPJ e validade; não consulta nenhum órgão.</p>' +
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
        '<section class="card" id="conf"><h2>Conferência da implantação: receita declarada × NFS-e prestadas</h2><div class="empty">Carregando…</div></section>' +
        '<section class="card" id="simp"><h2>Simples Nacional: cálculo do motor</h2><div class="empty">Carregando…</div></section>' +
        '<section class="card" id="guias"><h2>Guias: DAS do Simples</h2><div class="empty">Carregando…</div></section>' +
        '<section class="card" id="ret"><h2>Retenções nas NFS-e tomadas</h2><div class="empty">Carregando…</div></section>' +
        '<section class="card" id="ctb"><h2>Contabilidade</h2><div class="empty">Carregando…</div></section>' +
        '<section class="card"><h2>Checklist da implantação</h2><div class="scroll"><table><thead><tr><th>Item</th><th>Responsável</th><th>Case</th><th>Situação</th></tr></thead><tbody>' + chk + '</tbody></table></div></section>' +
      '</div><div class="narrow">' +
        '<section class="card"><h2>Perfil</h2><table>' + facts + '</table></section>' +
        '<section class="card"><h2>Mapa de acessos</h2><table>' + acc + '</table>' +
          '<details class="only-confirmar" style="margin-top:10px"><summary style="cursor:pointer;font-size:13px">Registrar acesso estadual ou municipal</summary>' +
          '<div class="form-row" style="margin-top:8px"><label>Órgão<select id="poa-org"><option value="PREFEITURA">Prefeitura (município da matriz)</option><option value="SEFAZ">SEFAZ (UF da matriz)</option></select></label>' +
          '<label>Forma de acesso<select id="poa-met"><option value="PROCURACAO">Procuração</option><option value="GOVBR">Conta gov.br</option><option value="CERTIFICADO">Certificado digital</option><option value="SENHA_PORTAL">Senha do portal (vai para o cofre)</option></select></label>' +
          '<label>Válida desde<input type="date" id="poa-ini"></label><label>Até (vazio = sem término)<input type="date" id="poa-fim"></label>' +
          '<label>Protocolo / nº<input id="poa-prot" style="width:140px"></label><label>Comprovante (opcional: termo ou print)<input type="file" id="poa-arq" accept=".pdf,.png,.jpg,.jpeg"></label>' +
          '<button class="ghost" data-act="poa">Registrar</button></div>' +
          '<div class="empty">Sem consulta automática nesses órgãos: registre como o escritório acessa (procuração, gov.br, certificado). Senha nunca é digitada aqui. Faltando ou vencida, a IARIS pede ao cliente; vencendo em até 30 dias, aparece na Fila humana.</div></details></section>' +
        '<section class="card"><h2>Cases</h2><table>' + cs + '</table></section>' +
      '</div></div>';
    loadConferencia(id);
    loadSimples(id);
    loadGuias(id);
    loadRetencoes(id);
    loadContabil(id);
    var bpoa = document.querySelector("[data-act=poa]");
    if (bpoa) bpoa.addEventListener("click", function () {
      var ini = $("poa-ini").value; if (!ini) { toast("Informe desde quando a procuração vale."); return; }
      var send = function (arquivo) {
        post("/api/empresa/" + id + "/procuracao", "confirmar", { orgao: $("poa-org").value, forma: $("poa-met").value, inicio: ini, fim: $("poa-fim").value || null, protocolo: $("poa-prot").value, arquivo: arquivo })
          .then(function (r) { toast("Acesso à " + r.name + " registrado."); viewEmpresa(id); })
          .catch(function (e) { toast(e.message); });
      };
      var f = $("poa-arq").files[0];
      if (!f) { send(null); return; }
      if (f.size > 5 * 1024 * 1024) { toast("Arquivo acima de 5 MB."); return; }
      var fr = new FileReader();
      fr.onload = function () { send({ name: f.name, data: String(fr.result).split(",")[1] || "" }); };
      fr.readAsDataURL(f);
    });
  });
}

var CTB_TABS = [["fech", "Fechamento"], ["bal", "Balancete"], ["bp", "Balanço"], ["dre", "DRE"], ["raz", "Razão"], ["forn", "Fornecedores em aberto"], ["cli", "Clientes em aberto"], ["parc", "Cadastro de parceiros"]];
var CTB = { entity: null, tab: "bal", raz: null };
function monthEnd(m) { return new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10); }
function dc(v) { var n = Number(v); return n === 0 ? '0,00' : brl(Math.abs(n).toFixed(2)) + (n > 0 ? ' D' : ' C'); }

function showCtb(id, r, tab, raz) {
  CTB.entity = id; CTB.tab = tab; if (raz) CTB.raz = raz;
  document.querySelectorAll("#ctb-tabs [data-tab]").forEach(function (b) { b.className = b.getAttribute("data-tab") === tab ? "" : "ghost"; });
  var out = $("ctb-rep"); if (!out) return;
  var end = monthEnd(r.month), ini = r.month + "-01";
  var openRaz = function (conta, nome, parceiro, parceiroNome, de) {
    showCtb(id, r, "raz", { conta: conta, nome: nome, parceiro: parceiro || "", parceiroNome: parceiroNome || "", de: de || ini, ate: end });
  };
  var wireRaz = function () {
    out.querySelectorAll("[data-raz]").forEach(function (a) {
      a.addEventListener("click", function (ev) {
        ev.preventDefault();
        openRaz(a.getAttribute("data-raz"), a.getAttribute("data-nome") || "", a.getAttribute("data-parc"), a.getAttribute("data-pnome"), a.getAttribute("data-de"));
      });
    });
  };
  if (tab === "bal") {
    var tb = r.trial.rows.map(function (x) {
      var pad = (x.level - 1) * 12;
      return '<tr' + (x.analytic ? '' : ' style="font-weight:600"') + '><td class="mono" style="padding-left:' + (8 + pad) + 'px"><a href="#" data-raz="' + esc(x.code) + '" data-nome="' + esc(x.name) + '">' + esc(x.code) + '</a></td><td>' + esc(x.name) + '</td><td class="num">' + dc(x.opening) + '</td><td class="num">' + brl(x.debit) + '</td><td class="num">' + brl(x.credit) + '</td><td class="num">' + dc(x.closing) + '</td></tr>';
    }).join("");
    out.innerHTML = '<div class="scroll"><table><thead><tr><th>Conta</th><th>Nome</th><th class="num">Saldo anterior</th><th class="num">Débitos</th><th class="num">Créditos</th><th class="num">Saldo atual</th></tr></thead><tbody>' + tb + '</tbody></table></div>' +
      '<div class="empty">Débitos ' + brl(r.trial.totals.debit) + ' · Créditos ' + brl(r.trial.totals.credit) + (r.trial.totals.balanced ? ' · <span class="ok">débitos = créditos ✓</span>' : ' · <span class="bad">não fecha</span>') + '. Clique na conta para abrir o razão. Contabilidade a partir de ' + d(r.chartFrom) + '; saldos anteriores vêm do escritório anterior (a implantar).</div>';
    wireRaz();
    return;
  }
  if (tab === "dre") {
    out.innerHTML = '<div class="empty">Carregando DRE…</div>';
    getJson("/api/empresa/" + id + "/contabil/dre?mes=" + r.month).then(function (x) {
      var rows = x.monthLines.map(function (l, i) {
        var y = x.ytdLines[i];
        var st = l.strong ? ' style="font-weight:700;border-top:1px solid #d7dde6"' : '';
        var cls = function (v) { return Number(v) < 0 ? "num bad" : "num"; };
        return '<tr' + st + '><td style="padding-left:' + (8 + l.level * 16) + 'px">' + esc(l.label) + '</td><td class="' + cls(l.value) + '">' + brl(l.value) + '</td><td class="' + cls(y.value) + '">' + brl(y.value) + '</td></tr>';
      }).join("");
      out.innerHTML = '<div class="scroll"><table><thead><tr><th>Demonstração do resultado</th><th class="num">' + r.month.slice(5, 7) + '/' + r.month.slice(0, 4) + '</th><th class="num">Acumulado ' + d(x.ytdFrom) + ' a ' + d(x.to) + '</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="empty">Montada direto do razão (grupos 3 e 4 do plano). Sem saldo de abertura do escritório anterior, o acumulado começa no início da contabilidade.</div>';
    }).catch(function (e) { out.innerHTML = '<div class="empty bad">' + esc(e.message) + '</div>'; });
    return;
  }
  if (tab === "raz") {
    var z = CTB.raz || { conta: "", nome: "", parceiro: "", parceiroNome: "", de: ini, ate: end };
    var dl = '<datalist id="ctb-accs">' + r.accounts.map(function (a) { return '<option value="' + esc(a.code) + '">' + esc(a.name) + '</option>'; }).join("") + '</datalist>';
    out.innerHTML = '<div class="form-row" style="margin-bottom:8px"><label>Conta<input id="rz-conta" list="ctb-accs" value="' + esc(z.conta) + '" placeholder="ex.: 2.1.1.01" style="width:130px"></label>' + dl +
      '<label>De<input type="date" id="rz-de" value="' + z.de + '"></label><label>Até<input type="date" id="rz-ate" value="' + z.ate + '"></label>' +
      (z.parceiro ? '<span class="mut" style="font-size:12px">Parceiro: <b>' + esc(z.parceiroNome || z.parceiro) + '</b> <a href="#" id="rz-limpa">(todos)</a></span>' : '') +
      '<button class="ghost" id="rz-ver">Ver razão</button></div><div id="rz-out">' + (z.conta ? '<div class="empty">Carregando…</div>' : '<div class="empty">Escolha a conta (ou clique numa conta do balancete).</div>') + '</div>';
    var go = function () {
      var c = $("rz-conta").value.trim(); if (!c) { toast("Informe a conta."); return; }
      CTB.raz = { conta: c, nome: "", parceiro: z.parceiro, parceiroNome: z.parceiroNome, de: $("rz-de").value, ate: $("rz-ate").value };
      var q = "?conta=" + encodeURIComponent(c) + "&de=" + CTB.raz.de + "&ate=" + CTB.raz.ate + (z.parceiro ? "&parceiro=" + encodeURIComponent(z.parceiro) : "");
      getJson("/api/empresa/" + id + "/contabil/razao" + q).then(function (x) {
        var showP = !z.parceiro;
        var lines = x.lines.map(function (l) {
          return '<tr><td>' + d(l.date) + '</td><td>' + esc(l.history) + '</td>' + (showP ? '<td>' + (l.partnerDoc ? '<a href="#" data-raz="' + esc(x.account.code) + '" data-parc="' + esc(l.partnerDoc) + '" data-pnome="' + esc(l.partner || "") + '" data-de="' + esc(r.chartFrom) + '">' + esc(l.partner || l.partnerDoc) + '</a>' : '<span class="mut">—</span>') + '</td>' : '') +
            '<td class="num">' + (Number(l.debit) ? brl(l.debit) : '') + '</td><td class="num">' + (Number(l.credit) ? brl(l.credit) : '') + '</td><td class="num">' + dc(l.balance) + '</td></tr>';
        }).join("");
        var cols = showP ? 6 : 5;
        $("rz-out").innerHTML = '<h3 style="font-size:13px;margin:4px 0 6px">' + esc(x.account.code + " " + x.account.name) + '</h3><div class="scroll"><table><thead><tr><th>Data</th><th>Histórico</th>' + (showP ? '<th>Parceiro</th>' : '') + '<th class="num">Débito</th><th class="num">Crédito</th><th class="num">Saldo</th></tr></thead><tbody>' +
          '<tr class="mut"><td colspan="' + (cols - 1) + '">Saldo anterior</td><td class="num">' + dc(x.opening) + '</td></tr>' + (lines || '<tr><td colspan="' + cols + '" class="empty">Sem movimento no período.</td></tr>') +
          '<tr style="font-weight:700"><td colspan="' + (cols - 3) + '">Totais do período</td><td class="num">' + brl(x.debit) + '</td><td class="num">' + brl(x.credit) + '</td><td class="num">' + dc(x.closing) + '</td></tr></tbody></table></div>' +
          (x.truncated ? '<div class="empty">Mostrando os 2.000 últimos lançamentos; reduza o período.</div>' : '');
        $("rz-out").querySelectorAll("[data-raz]").forEach(function (a) {
          a.addEventListener("click", function (ev) { ev.preventDefault(); openRaz(a.getAttribute("data-raz"), "", a.getAttribute("data-parc"), a.getAttribute("data-pnome"), a.getAttribute("data-de")); });
        });
      }).catch(function (e) { $("rz-out").innerHTML = '<div class="empty bad">' + esc(e.message) + '</div>'; });
    };
    $("rz-ver").addEventListener("click", go);
    var lp = $("rz-limpa"); if (lp) lp.addEventListener("click", function (ev) { ev.preventDefault(); z.parceiro = ""; z.parceiroNome = ""; CTB.raz = z; showCtb(id, r, "raz"); });
    if (z.conta) go();
    return;
  }
  if (tab === "forn" || tab === "cli") {
    var conta = tab === "forn" ? r.roles.fornecedores : r.roles.clientes;
    out.innerHTML = '<div class="empty">Carregando…</div>';
    getJson("/api/empresa/" + id + "/contabil/abertos?conta=" + conta + "&ate=" + end).then(function (x) {
      var rows = x.items.map(function (i) {
        return '<tr><td><a href="#" data-raz="' + conta + '" data-parc="' + esc(i.partnerDoc || "") + '" data-pnome="' + esc(i.partner || "") + '" data-de="' + esc(r.chartFrom) + '"><b>' + esc(i.partner || "sem identificação") + '</b></a><div class="mut mono" style="font-size:11px">' + esc(i.partnerDoc || "") + '</div></td>' +
          '<td class="num">' + brl(i.debit) + '</td><td class="num">' + brl(i.credit) + '</td><td class="num"><b>' + dc(i.balance) + '</b></td><td>' + d(i.last) + '</td></tr>';
      }).join("");
      out.innerHTML = '<div class="scroll"><table><thead><tr><th>' + (tab === "forn" ? "Fornecedor" : "Cliente") + '</th><th class="num">Débitos</th><th class="num">Créditos</th><th class="num">Em aberto</th><th>Último movimento</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="5" class="empty">Nada em aberto até ' + d(end) + '.</td></tr>') + '</tbody></table></div>' +
        '<div class="empty">Total em aberto em ' + d(end) + ': <b>' + dc(x.total) + '</b> (conta ' + conta + '). ' + (tab === "forn" ? 'Créditos = notas tomadas; débitos = pagamentos identificados no extrato.' : 'Débitos = notas emitidas; créditos = recebimentos identificados no extrato.') + ' Clique no nome para ver o razão do parceiro.</div>';
      wireRaz();
    }).catch(function (e) { out.innerHTML = '<div class="empty bad">' + esc(e.message) + '</div>'; });
    return;
  }
  if (tab === "fech") {
    out.innerHTML = '<div class="empty">Conferindo ' + r.month.slice(5, 7) + '/' + r.month.slice(0, 4) + '…</div>';
    getJson("/api/empresa/" + id + "/contabil/fechamento?mes=" + r.month).then(function (x) { renderClosing(id, r, out, x); })
      .catch(function (e) { out.innerHTML = '<div class="empty bad">' + esc(e.message) + '</div>'; });
    return;
  }
  if (tab === "bp") {
    out.innerHTML = '<div class="empty">Carregando…</div>';
    getJson("/api/empresa/" + id + "/contabil/balanco?data=" + end).then(function (x) {
      var row = function (l) { return '<tr' + (l.strong ? ' style="font-weight:700"' : '') + '><td style="padding-left:' + (8 + l.level * 16) + 'px">' + esc(l.label) + (l.code && !l.strong ? ' <span class="mut mono" style="font-size:11px">' + esc(l.code) + '</span>' : '') + '</td><td class="num">' + brl(l.value) + '</td></tr>'; };
      out.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px">' +
        '<div class="scroll"><table><tbody>' + x.assets.map(row).join("") + '</tbody></table></div>' +
        '<div class="scroll"><table><tbody>' + x.liabilities.map(row).join("") + '</tbody></table></div></div>' +
        '<div class="empty">Balanço em ' + d(x.date) + ' · ' + (x.totals.balanced ? '<span class="ok">ativo = passivo + PL ✓</span>' : '<span class="bad">diferença ' + brl(x.totals.diff) + '</span>') +
        '. Saldos desde ' + d(x.from) + ' (início da contabilidade na IARIS); saldos de abertura do escritório anterior ainda não implantados, por isso bancos, clientes e fornecedores mostram só o movimento desde então.</div>';
    }).catch(function (e) { out.innerHTML = '<div class="empty bad">' + esc(e.message) + '</div>'; });
    return;
  }
  if (tab === "parc") {
    out.innerHTML = '<div class="empty">Carregando…</div>';
    getJson("/api/empresa/" + id + "/parceiros?mes=" + r.month).then(function (x) { renderPartners(id, r, out, x); }).catch(function (e) { out.innerHTML = '<div class="empty bad">' + esc(e.message) + '</div>'; });
  }
}

var PST = {
  NO_MES: '<span class="st ok">nota no mês</span>',
  ESPERADA: '<span class="st bad">esperada, não chegou</span>',
  EVENTUAL: '<span class="st">eventual</span>',
  SEM_NOTA: '<span class="st">sem nota no período</span>'
};
var CST = { OK: '<span class="st ok">ok</span>', PENDENTE: '<span class="st bad">pendente</span>', ALERTA: '<span class="st wr">alerta</span>', NAO_SE_APLICA: '<span class="mut">não se aplica</span>' };
function renderClosing(id, r, out, x) {
  var rows = x.checks.map(function (c) {
    return '<tr><td><b>' + esc(c.label) + '</b>' + (c.blocking ? '' : ' <span class="mut" style="font-size:11px">(não bloqueia)</span>') + '<div class="mut" style="font-size:12px">' + esc(c.detail) + '</div>' +
      (c.items && c.items.length ? '<ul style="margin:4px 0 0 16px;padding:0;font-size:12px">' + c.items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join("") + '</ul>' : '') + '</td><td>' + (CST[c.status] || esc(c.status)) + '</td></tr>';
  }).join("");
  var head = x.locked
    ? '<div class="empty"><span class="st ok">competência fechada</span> em ' + dt(x.lockedAt) + ' por ' + esc(x.lockedBy) + '. Nada entra nela sem reabrir.</div>' +
      '<div class="form-row only-aprovar" style="margin:6px 0"><input id="ro-why" placeholder="motivo da reabertura" style="min-width:260px"><button class="ghost" id="ro-btn">Reabrir competência</button></div>'
    : (x.canClose
      ? '<div class="form-row only-aprovar" style="margin:6px 0"><button class="warn" id="cl-btn">Fechar ' + r.month.slice(5, 7) + '/' + r.month.slice(0, 4) + '</button><span class="mut" style="font-size:12px">Conferências sem pendência. Ao fechar, a competência fica bloqueada no razão.</span></div>'
      : '<div class="empty">Para fechar ' + r.month.slice(5, 7) + '/' + r.month.slice(0, 4) + ', resolva os itens pendentes. Os alertas não bloqueiam.</div>');
  out.innerHTML = head + '<div class="scroll"><table><thead><tr><th>Conferência</th><th>Situação</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    (x.totals ? '<div class="empty">Débitos ' + brl(x.totals.debit) + ' · Créditos ' + brl(x.totals.credit) + ' · Resultado acumulado ' + brl(x.totals.result) + '</div>' : '');
  var cb = $("cl-btn");
  if (cb) cb.addEventListener("click", function () {
    if (!window.confirm("Fechar a competência " + r.month.slice(5, 7) + "/" + r.month.slice(0, 4) + "? Nada mais será lançado nela; corrigir exige reabrir com motivo. Fica na auditoria em seu nome.")) return;
    cb.disabled = true;
    post("/api/empresa/" + id + "/contabil/fechar", "aprovar", { mes: r.month }).then(function () { toast("Competência fechada."); showCtb(id, r, "fech"); }).catch(function (e) { toast(e.message); cb.disabled = false; });
  });
  var rb = $("ro-btn");
  if (rb) rb.addEventListener("click", function () {
    var why = $("ro-why").value.trim();
    if (why.length < 5) { toast("Escreva o motivo da reabertura."); return; }
    rb.disabled = true;
    post("/api/empresa/" + id + "/contabil/reabrir", "aprovar", { mes: r.month, motivo: why }).then(function (y) { toast("Competência reaberta." + (y.posted ? " " + y.posted + " lançamento(s) que esperavam entraram." : "")); showCtb(id, r, "fech"); }).catch(function (e) { toast(e.message); rb.disabled = false; });
  });
}

function renderPartners(id, r, out, x) {
  var head = '<th>Parceiro</th><th>Serviço</th>' + x.window.map(function (m) { return '<th class="num" style="font-size:11px">' + m.slice(5, 7) + '/' + m.slice(2, 4) + '</th>'; }).join("") + '<th>No mês</th><th>Conta</th><th class="num">Em aberto</th><th>Aparece no banco como</th>';
  var table = function (list, role) {
    if (!list.length) return '<div class="empty">Nenhum ' + (role === "FORNECEDOR" ? "fornecedor" : "cliente") + ' nas notas.</div>';
    var rows = list.map(function (p) {
      var cells = p.months.map(function (m) { return '<td class="num" title="' + (m.notes ? m.notes + ' nota(s) · ' + brl(m.total) : 'sem nota') + '">' + (m.notes ? '<b>' + m.notes + '</b>' : '<span class="mut">·</span>') + '</td>'; }).join("");
      var acc = p.account ? '<span class="mono">' + esc(p.account.code) + '</span><div class="mut" style="font-size:11px">' + (p.account.source === "FORNECEDOR" ? "definida p/ fornecedor" : "pela tabela") + '</div>' : '<span class="mut">a definir</span>';
      var al = (p.aliases.length ? p.aliases.map(function (a) { return '<span class="mono" style="font-size:11px;background:#eef2f7;border-radius:4px;padding:1px 4px;margin-right:3px">' + esc(a) + '</span>'; }).join("") : '<span class="mut" style="font-size:11px">ainda não visto</span>') +
        '<div class="only-confirmar" style="margin-top:4px;display:flex;gap:4px"><input id="al-' + p.id + '" placeholder="ex.: DELTA SERV MANUT" style="width:150px;font-size:11px"><button class="ghost" data-al="' + p.id + '" style="font-size:11px;padding:2px 6px">+</button></div>';
      return '<tr><td><b>' + esc(p.name || p.doc) + '</b><div class="mut mono" style="font-size:11px">' + esc(p.doc) + ' · desde ' + d(p.firstSeen) + '</div>' +
        (p.officeClient ? '<div style="font-size:11px" class="ok">cliente do escritório: ' + esc(p.officeClient) + '</div>' : '') + '</td>' +
        '<td class="mono" style="font-size:11px">' + esc(p.codes.join(", ") || "—") + '</td>' + cells +
        '<td>' + PST[p.status] + (p.expected ? '<div class="mut" style="font-size:11px">média ' + brl(p.expected) + '</div>' : '') + '</td><td>' + acc + '</td>' +
        '<td class="num">' + (Number(p.open) ? '<a href="#" data-raz="' + (role === "FORNECEDOR" ? r.roles.fornecedores : r.roles.clientes) + '" data-parc="' + esc(p.doc) + '" data-pnome="' + esc(p.name || "") + '">' + dc(p.open) + '</a>' : '<span class="mut">—</span>') + '</td><td>' + al + '</td></tr>';
    }).join("");
    return '<div class="scroll"><table><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  };
  var miss = x.expectedMissing.length
    ? '<div class="empty"><b>' + x.expectedMissing.length + ' nota(s) esperada(s) em ' + r.month.slice(5, 7) + '/' + r.month.slice(0, 4) + ' ainda não chegaram</b> (parceiro recorrente: nota em pelo menos 2 dos 3 meses anteriores): ' +
      x.expectedMissing.map(function (e) { return esc(e.name || e.doc) + ' (' + (e.role === "FORNECEDOR" ? "fornecedor" : "cliente") + ', média ' + brl(e.expected) + ')'; }).join("; ") + '.</div>'
    : '<div class="empty">Todos os parceiros recorrentes têm nota em ' + r.month.slice(5, 7) + '/' + r.month.slice(0, 4) + '.</div>';
  out.innerHTML = miss +
    '<h3 style="font-size:13px;margin:12px 0 6px">Fornecedores (' + x.suppliers.length + ')</h3>' + table(x.suppliers, "FORNECEDOR") +
    '<h3 style="font-size:13px;margin:12px 0 6px">Clientes (' + x.customers.length + ')</h3>' + table(x.customers, "CLIENTE") +
    '<div class="empty">Cadastro montado sozinho pelas NFS-e. No extrato, a IARIS reconhece o parceiro pelo CNPJ, pelo nome ou por como ele já apareceu no banco, e usa isso para desempatar notas de mesmo valor e quitar várias notas num pagamento só (soma exata). Nunca lança só pelo nome.</div>';
  out.querySelectorAll("[data-al]").forEach(function (b) {
    b.addEventListener("click", function () {
      var pid = b.getAttribute("data-al"), v = $("al-" + pid).value.trim();
      if (!v) { toast("Escreva como aparece no extrato."); return; }
      post("/api/empresa/" + id + "/parceiros/" + pid + "/apelido", "confirmar", { texto: v }).then(function (y) {
        toast('Guardado como "' + y.pattern + '".' + (y.posted ? ' ' + y.posted + ' lançamento(s) feitos.' : ''));
        showCtb(id, r, "parc");
      }).catch(function (e) { toast(e.message); });
    });
  });
  out.querySelectorAll("[data-raz]").forEach(function (a) {
    a.addEventListener("click", function (ev) {
      ev.preventDefault();
      showCtb(id, r, "raz", { conta: a.getAttribute("data-raz"), nome: "", parceiro: a.getAttribute("data-parc"), parceiroNome: a.getAttribute("data-pnome"), de: r.chartFrom, ate: monthEnd(r.month) });
    });
  });
}

function loadContabil(id, mes) {
  return getJson("/api/empresa/" + id + "/contabil" + (mes ? "?mes=" + mes : "")).then(function (r) {
    var box = $("ctb"); if (!box) return;
    var h = '<h2>Contabilidade</h2>';
    if (!r.hasChart) {
      h += '<div class="empty">A empresa ainda não tem plano de contas. Sem ele, a IARIS não lança nada.</div>' +
        '<div class="form-row only-aprovar" style="margin-top:8px"><label>Início da contabilidade<input type="month" id="ctb-ini" value="' + lastClosedMonth() + '"></label>' +
        '<button class="warn" data-act="plano">Aplicar o plano de contas padrão do escritório</button></div>' +
        '<div class="empty">A empresa recebe uma cópia do plano padrão do escritório (o último modelo importado). Conta nova da empresa entra só nela.</div>';
      box.innerHTML = h;
      var bp = box.querySelector("[data-act=plano]");
      if (bp) bp.addEventListener("click", function () {
        var v = $("ctb-ini").value; if (!v) { toast("Informe o mês de início."); return; }
        post("/api/empresa/" + id + "/plano", "aprovar", { inicio: v }).then(function () { toast("Plano aplicado. Contabilizando notas, Simples e extratos…"); return loadContabil(id); }).catch(function (e) { toast(e.message); });
      });
      return;
    }
    var banks = r.bank.map(function (b) {
      return '<tr><td>' + esc(b.label) + '</td><td class="mono">' + esc(b.ledger_code || "—") + '</td><td class="num">' + b.transactions + '</td><td>' + (b.first_on ? d(b.first_on) + ' a ' + d(b.last_on) : '—') + '</td><td class="num">' + (b.balance !== null ? brl(b.balance) + '<div class="mut" style="font-size:11px">' + (b.balance_date ? d(b.balance_date) : "") + '</div>' : '—') + '</td></tr>';
    }).join("");
    h += '<div class="form-row only-confirmar" style="margin:4px 0 10px"><label>Extrato bancário (OFX)<input type="file" id="ctb-ofx" accept=".ofx,.OFX"></label><button class="ghost" data-act="ofx">Enviar extrato</button></div>';
    h += '<div class="scroll"><table><thead><tr><th>Conta bancária</th><th>Conta contábil</th><th class="num">Movimentos</th><th>Período</th><th class="num">Saldo no extrato</th></tr></thead><tbody>' + (banks || '<tr><td colspan="5" class="empty">Nenhum extrato recebido.</td></tr>') + '</tbody></table></div>';
    if (r.pending.length) {
      var opts = r.accounts.map(function (a) { return '<option value="' + esc(a.code) + '">' + esc(a.code + " " + a.name) + '</option>'; }).join("");
      var pend = r.pending.map(function (p, i) {
        var hyp = p.hypotheses && p.hypotheses.length ? '<div class="mut" style="font-size:11px">Hipóteses: ' + esc(p.hypotheses.join("; ")) + '</div>' : '';
        var pat = esc(((p.memo || p.payee || "").split(/\\s+/).slice(0, 3).join(" ")));
        return '<tr><td>' + d(p.posted_on) + '</td><td>' + esc([p.memo, p.payee].filter(Boolean).join(" · ") || "—") + '<div class="mut" style="font-size:11px">' + esc(p.reason) + '</div>' + hyp + '</td><td class="num ' + (Number(p.amount) < 0 ? "bad" : "ok") + '">' + brl(p.amount) + '</td>' +
          '<td class="only-confirmar"><select id="cl-acc-' + i + '"><option value="">conta…</option>' + opts + '</select>' +
          '<div style="margin-top:4px"><input id="cl-his-' + i + '" placeholder="histórico" style="width:100%"></div>' +
          '<label style="font-size:11px;display:flex;gap:4px;align-items:center;margin-top:4px"><input type="checkbox" id="cl-rule-' + i + '"> sempre que o histórico tiver <input id="cl-pat-' + i + '" value="' + pat + '" style="width:140px"></label>' +
          '<label style="font-size:11px;display:flex;gap:4px;align-items:center"><input type="checkbox" id="cl-all-' + i + '"> vale para todas as empresas</label>' +
          '<button class="ghost" data-act="classif" data-i="' + i + '" data-id="' + p.id + '" style="margin-top:4px">Lançar</button></td></tr>';
      }).join("");
      h += '<h3 style="font-size:13px;margin:12px 0 6px">Movimentos para classificar (' + (r.pendingTotal || r.pending.length) + (r.pendingTotal > r.pending.length ? ', mostrando ' + r.pending.length : '') + ')</h3><div class="scroll"><table><thead><tr><th>Data</th><th>Histórico do banco</th><th class="num">Valor</th><th class="only-confirmar">Classificação</th></tr></thead><tbody>' + pend + '</tbody></table></div>';
    }
    var br = r.bankRule || { approved: null, pending: 0 };
    if (!br.approved && br.pending) {
      h += '<h3 style="font-size:13px;margin:12px 0 6px">Movimentos típicos do banco (proposta)</h3>' +
        '<div class="empty">' + br.pending + ' movimento(s) reconhecido(s) pelo histórico do banco esperando a regra: aplicação e resgate automáticos (conta de aplicação daquele banco no plano), rendimento (receita de aplicações) e tarifa (tarifa bancária).</div>' +
        '<div class="only-aprovar" style="margin-top:6px"><button class="warn" data-act="br-aprovar">Aprovar e contabilizar</button></div>';
    }
    var rr = r.revenueRule || { approved: null, notes: 0 };
    if (!rr.approved && rr.notes) {
      h += '<h3 style="font-size:13px;margin:12px 0 6px">NFS-e emitidas com retenção do tomador (proposta)</h3>' +
        '<div class="empty">' + rr.notes + ' nota(s) emitida(s) com retenção (' + brl(rr.total) + ', retido ' + brl(rr.withheld) + ') esperando a regra. Cada nota vira: D Clientes (líquido recebido) · D IRRF / PIS-COFINS-CSLL / INSS retidos a recuperar · D ISS retido na fonte (dedução da receita, conta 3.2.1.03 nova no plano) / C Receita de serviços (valor bruto). Valores tirados da própria nota; nota com leitura divergente continua esperando.</div>' +
        '<div class="only-aprovar" style="margin-top:6px"><button class="warn" data-act="rr-aprovar">Aprovar e contabilizar as notas com retenção</button></div>';
    }
    var tk = r.taken || { pending: 0, suppliers: [] };
    if (!tk.approved) {
      var pr = tk.proposal.map(function (x) { return '<tr><td class="mono">' + esc(x.code) + '</td><td>' + esc(x.label) + '</td><td>' + (x.account ? '<span class="mono">' + esc(x.account) + '</span> ' + esc(x.accountName || "") : '<span class="mut">sem conta no plano: fica para definir pelo fornecedor</span>') + '</td></tr>'; }).join("");
      h += '<h3 style="font-size:13px;margin:12px 0 6px">NFS-e tomadas: tabela de contas por tipo de serviço (proposta)</h3>' +
        '<div class="empty">' + tk.pending + ' nota(s) tomada(s) esperando. Cada nota vira: D despesa (pela tabela ou pela conta do fornecedor) / C Fornecedores (líquido) e C retenções a recolher. Tipo de serviço fora da tabela fica para você definir pelo fornecedor.</div>' +
        '<details><summary class="mut" style="cursor:pointer;font-size:12px">Ver a tabela</summary><table><thead><tr><th>Item LC 116</th><th>Serviço</th><th>Conta</th></tr></thead><tbody>' + pr + '</tbody></table></details>' +
        '<div class="only-aprovar" style="margin-top:6px"><button class="warn" data-act="tk-aprovar">Aprovar tabela e contabilizar as tomadas</button></div>';
    }
    if (tk.suppliers.length) {
      var opts2 = r.accounts.filter(function (a) { return /^4\\./.test(a.code) || /^1\\.2\\./.test(a.code) || /^1\\.1\\.5\\./.test(a.code); }).map(function (a) { return '<option value="' + esc(a.code) + '">' + esc(a.code + " " + a.name) + '</option>'; }).join("");
      var sup = tk.suppliers.map(function (g, i) {
        return '<tr><td><b>' + esc(g.supplier || "—") + '</b><div class="mut mono" style="font-size:11px">' + esc(g.doc || "") + (g.codes.length ? ' · serviço ' + esc(g.codes.join(", ")) : '') + '</div><div class="mut" style="font-size:11px">' + esc(g.reason) + '</div></td><td class="num">' + g.notes + '</td><td class="num">' + brl(g.total.toFixed(2)) + '</td>' +
          '<td class="only-confirmar">' + (g.doc ? '<select id="sp-acc-' + i + '"><option value="">conta…</option>' + opts2 + '</select><div style="margin-top:4px"><input id="sp-his-' + i + '" placeholder="histórico (ex.: Honorários advocatícios)" style="width:100%"></div>' +
          '<label style="font-size:11px;display:flex;gap:4px;align-items:center;margin-top:4px"><input type="checkbox" id="sp-all-' + i + '"> vale para todas as empresas</label>' +
          '<button class="ghost" data-act="sp" data-i="' + i + '" data-doc="' + esc(g.doc) + '" style="margin-top:4px">Definir conta</button>' : '<span class="mut">sem CNPJ do prestador</span>') + '</td></tr>';
      }).join("");
      h += '<h3 style="font-size:13px;margin:12px 0 6px">NFS-e tomadas sem conta (' + tk.pending + ')</h3><div class="scroll"><table><thead><tr><th>Fornecedor</th><th class="num">Notas</th><th class="num">Total</th><th class="only-confirmar">Conta</th></tr></thead><tbody>' + sup + '</tbody></table></div>';
    }
    if (r.trial) {
      var sel = '<select id="ctb-mes">' + r.months.map(function (m) { return '<option value="' + m + '"' + (m === r.month ? ' selected' : '') + '>' + m.slice(5, 7) + '/' + m.slice(0, 4) + '</option>'; }).join("") + '</select>';
      h += '<div id="ctb-tabs" style="display:flex;gap:6px;margin:16px 0 8px;flex-wrap:wrap;align-items:center">' +
        CTB_TABS.map(function (t) { return '<button class="ghost" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join("") +
        '<span style="margin-left:auto;font-size:12px" class="mut">Mês ' + sel + '</span></div><div id="ctb-rep"></div>';
    } else {
      h += '<div class="empty">Nenhum lançamento ainda.</div>';
    }
    box.innerHTML = h;
    var ms = $("ctb-mes"); if (ms) ms.addEventListener("change", function () { loadContabil(id, ms.value); });
    if (r.trial) {
      box.querySelectorAll("[data-tab]").forEach(function (b) { b.addEventListener("click", function () { CTB.raz = null; showCtb(id, r, b.getAttribute("data-tab")); }); });
      showCtb(id, r, CTB.entity === id ? CTB.tab : "fech");
    }
    var bo = box.querySelector("[data-act=ofx]");
    if (bo) bo.addEventListener("click", function () {
      var f = $("ctb-ofx").files[0]; if (!f) { toast("Escolha o arquivo OFX."); return; }
      if (f.size > 10 * 1024 * 1024) { toast("Extrato acima de 10 MB."); return; }
      var fr = new FileReader();
      fr.onload = function () {
        post("/api/empresa/" + id + "/extrato", "confirmar", { name: f.name, data: String(fr.result).split(",")[1] || "" }).then(function (x) {
          toast(x.status === "REPETIDO" ? "Esse extrato já tinha sido enviado." : x.account + ": " + x.transactions + " movimento(s) novo(s)" + (x.duplicated ? ", " + x.duplicated + " já existiam" : "") + ".");
          return loadContabil(id);
        }).catch(function (e) { toast(e.message); });
      };
      fr.readAsDataURL(f);
    });
    var bra = box.querySelector("[data-act=br-aprovar]");
    if (bra) bra.addEventListener("click", function () {
      if (!window.confirm("Aprovar as regras padrão de extrato (aplicação, resgate, rendimento e tarifa)? Vale para todas as empresas e fica na auditoria em seu nome.")) return;
      bra.disabled = true;
      post("/api/contabil/extrato-padrao/aprovar", "aprovar", {}).then(function (x) { toast("Regras aprovadas. " + x.posted + " lançamento(s) feitos."); return loadContabil(id); }).catch(function (e) { toast(e.message); bra.disabled = false; });
    });
    var ra = box.querySelector("[data-act=rr-aprovar]");
    if (ra) ra.addEventListener("click", function () {
      if (!window.confirm("Aprovar a regra de receita com retenção do tomador? Vale para todas as empresas do escritório e fica na auditoria em seu nome.")) return;
      ra.disabled = true;
      post("/api/contabil/receita-retencoes/aprovar", "aprovar", {}).then(function (x) { toast("Regra aprovada. " + x.posted + " lançamento(s) feitos."); return loadContabil(id); }).catch(function (e) { toast(e.message); ra.disabled = false; });
    });
    var ta = box.querySelector("[data-act=tk-aprovar]");
    if (ta) ta.addEventListener("click", function () {
      ta.disabled = true;
      post("/api/contabil/tomadas/aprovar", "aprovar", {}).then(function (x) { toast("Tabela aprovada. " + x.posted + " lançamento(s) feitos."); return loadContabil(id); }).catch(function (e) { toast(e.message); ta.disabled = false; });
    });
    box.querySelectorAll("[data-act=sp]").forEach(function (b) {
      b.addEventListener("click", function () {
        var i = b.getAttribute("data-i"), acc = $("sp-acc-" + i).value;
        if (!acc) { toast("Escolha a conta."); return; }
        post("/api/empresa/" + id + "/fornecedor", "confirmar", { doc: b.getAttribute("data-doc"), conta: acc, historico: $("sp-his-" + i).value, escopo: $("sp-all-" + i).checked ? "ESCRITORIO" : "EMPRESA" })
          .then(function (x) { toast("Conta definida. " + x.posted + " lançamento(s) feitos."); return loadContabil(id, r.month); }).catch(function (e) { toast(e.message); });
      });
    });
    box.querySelectorAll("[data-act=classif]").forEach(function (b) {
      b.addEventListener("click", function () {
        var i = b.getAttribute("data-i");
        var acc = $("cl-acc-" + i).value, his = $("cl-his-" + i).value.trim();
        if (!acc || !his) { toast("Escolha a conta e escreva o histórico."); return; }
        var rule = $("cl-rule-" + i).checked ? { padrao: $("cl-pat-" + i).value, escopo: $("cl-all-" + i).checked ? "ESCRITORIO" : "EMPRESA" } : null;
        post("/api/movimento/" + b.getAttribute("data-id") + "/classificar", "confirmar", { conta: acc, historico: his, regra: rule }).then(function (x) {
          toast("Lançado." + (x.alsoPosted ? " A regra lançou mais " + x.alsoPosted + " movimento(s) parecido(s)." : ""));
          return loadContabil(id, r.month);
        }).catch(function (e) { toast(e.message); });
      });
    });
  }).catch(function (err) { toast(err.message); });
}

var WS = {
  PAGO: '<span class="st ok">recolhido</span>',
  PAGO_EM_ATRASO: '<span class="st wr">recolhido após o vencimento</span>',
  PAGO_DIVERGENTE: '<span class="st bad">recolhido valor diferente</span>',
  PAGO_SEM_NOTA: '<span class="mut">recolhido · sem NFS-e com retenção</span>',
  A_VENCER: '<span class="st">a vencer</span>',
  ABAIXO_DO_MINIMO: '<span class="mut">abaixo de R$ 10,00 · acumula</span>',
  PRAZO_A_APROVAR: '<a class="st wr" href="#/regras">prazo a aprovar</a>',
  PAGAMENTO_NAO_IDENTIFICADO: '<span class="st bad">recolhimento ainda não identificado</span>'
};
var SNP = { "1": "não optante", "2": "MEI", "3": "Simples" };
function loadRetencoes(id) {
  return getJson("/api/empresa/" + id + "/retencoes").then(function (r) {
    var box = $("ret"); if (!box) return;
    if (!r.taken.length && !r.rows.length) { box.innerHTML = '<h2>Retenções nas NFS-e tomadas</h2><div class="empty">Nenhuma NFS-e tomada lida ainda.</div>'; return; }
    var fed = r.rows.map(function (w) {
      var pay = w.payment ? (w.payment.collectedOn ? d(w.payment.collectedOn) : "") + '<div class="mut" style="font-size:11px">código ' + esc(w.payment.codes.join(", ")) + '</div>' : '<span class="mut">—</span>';
      var dif = w.difference && Number(w.difference) !== 0 ? '<div class="bad" style="font-size:11px">diferença ' + brl(w.difference) + '</div>' : '';
      return '<tr><td>' + mm(w.competence) + (w.responsibility === "ANTERIOR" ? '<div class="mut" style="font-size:11px">escritório anterior</div>' : '') + '</td><td>' + (w.tax === "IRRF" ? "IRRF" : "PIS/COFINS/CSLL") + '</td><td class="num">' + brl(w.withheld) + '<div class="mut" style="font-size:11px">' + w.notes + ' nota(s)</div></td><td class="num">' + (w.paid !== null ? brl(w.paid) : '<span class="mut">—</span>') + dif + '</td><td>' + (w.due ? d(w.due) : '<span class="mut">—</span>') + (w.dueReason ? '<div class="mut" style="font-size:11px">' + esc(w.dueReason) + '</div>' : '') + '</td><td>' + pay + '</td><td>' + (WS[w.status] || esc(w.status)) + '</td></tr>';
    }).join("");
    var tk = r.taken.slice(0, 13).map(function (m) {
      var iss = Number(m.iss) ? brl(m.iss) + '<div class="mut" style="font-size:11px">' + m.issByCity.map(function (c) { return esc(c.city); }).join(", ") + '</div>' : '<span class="mut">—</span>';
      var flags = (m.divergent ? '<div class="wr" style="font-size:11px">' + m.divergent + ' nota(s) com total retido diferente da soma</div>' : '') + (m.fromSimplesProvider ? '<div class="wr" style="font-size:11px">' + m.fromSimplesProvider + ' de prestador do Simples com IR/CSRF retido</div>' : '');
      var link = m.withRetention || m.divergent ? '<a href="#" data-ret="' + m.competence.slice(0, 7) + '">ver notas</a>' : '';
      return '<tr><td>' + mm(m.competence) + '</td><td class="num">' + m.notes + '</td><td class="num">' + brl(m.services) + '</td><td class="num">' + (Number(m.irrf) ? brl(m.irrf) : '—') + '</td><td class="num">' + (Number(m.csrf) ? brl(m.csrf) : '—') + '</td><td class="num">' + (Number(m.cp) ? brl(m.cp) : '—') + '</td><td class="num">' + iss + '</td><td>' + flags + link + '</td></tr>';
    }).join("");
    box.innerHTML = '<h2>Retenções nas NFS-e tomadas</h2>' +
      '<h3 style="font-size:13px;margin:6px 0">IRRF e PIS/COFINS/CSLL retidos × DARF pago</h3>' +
      '<div class="scroll"><table><thead><tr><th>Competência</th><th>Tributo</th><th class="num">Retido nas notas</th><th class="num">Recolhido</th><th>Vencimento</th><th>Pagamento</th><th>Situação</th></tr></thead><tbody>' + (fed || '<tr><td colspan="7" class="empty">Nenhuma retenção federal nas notas tomadas.</td></tr>') + '</tbody></table></div>' +
      '<h3 style="font-size:13px;margin:12px 0 6px">Notas tomadas por mês</h3>' +
      '<div class="scroll"><table><thead><tr><th>Mês</th><th class="num">Notas</th><th class="num">Serviços</th><th class="num">IRRF</th><th class="num">PIS/COFINS/CSLL</th><th class="num">INSS</th><th class="num">ISS retido</th><th></th></tr></thead><tbody>' + tk + '</tbody></table></div>' +
      '<div id="ret-notas"></div>' +
      '<div class="empty">Competência pelo mês de emissão da nota (o recolhimento segue a data do pagamento ao prestador; com o extrato, a IARIS passa a usar a data do pagamento). Só NFS-e do Emissor Nacional. ISS retido: guia municipal ainda sem fonte. Pagamentos até ' + (r.dataUntil ? d(r.dataUntil) : "—") + '.</div>';
    box.querySelectorAll("[data-ret]").forEach(function (a) {
      a.addEventListener("click", function (ev) { ev.preventDefault(); loadRetNotas(id, a.getAttribute("data-ret")); });
    });
  }).catch(function (err) { toast(err.message); });
}
function loadRetNotas(id, comp) {
  return getJson("/api/empresa/" + id + "/retencoes?competencia=" + comp).then(function (r) {
    var rows = r.notes.map(function (n) {
      var ck = n.check === "OK" ? '' : '<div class="' + (n.check === "DIVERGENTE" ? "bad" : "wr") + '" style="font-size:11px">' + (n.check === "DIVERGENTE" ? "total diferente da soma" : "nota sem total retido") + '</div>';
      var obs = (n.notes || []).map(function (x) { return '<div class="mut" style="font-size:11px">' + esc(x) + '</div>'; }).join("");
      return '<tr><td class="mono">' + esc(n.number || "—") + '<div class="mut" style="font-size:11px">' + (n.issuedAt ? d(n.issuedAt.slice(0, 10)) : "") + '</div></td><td>' + esc(n.provider || n.providerDoc || "—") + '<div class="mut" style="font-size:11px">' + esc(SNP[n.providerSimples] || "") + '</div></td><td class="num">' + brl(n.service) + '</td><td class="num">' + brl(n.irrf) + '</td><td class="num">' + brl(n.csrf) + '</td><td class="num">' + brl(n.cp) + '</td><td class="num">' + brl(n.iss) + '</td><td class="num">' + (n.totalRead !== null ? brl(n.totalRead) : '—') + ck + obs + '</td></tr>';
    }).join("");
    var box = $("ret-notas"); if (!box) return;
    box.innerHTML = '<h3 style="font-size:13px;margin:12px 0 6px">Notas com retenção · ' + comp.slice(5, 7) + '/' + comp.slice(0, 4) + '</h3><div class="scroll"><table><thead><tr><th>Nota</th><th>Prestador</th><th class="num">Serviço</th><th class="num">IRRF</th><th class="num">PIS/COFINS/CSLL</th><th class="num">INSS</th><th class="num">ISS retido</th><th class="num">Total na nota</th></tr></thead><tbody>' + (rows || '<tr><td colspan="8" class="empty">Nenhuma.</td></tr>') + '</tbody></table></div>';
  }).catch(function (err) { toast(err.message); });
}

var GS = {
  PAGO: '<span class="st ok">pago</span>',
  PAGO_EM_ATRASO: '<span class="st wr">pago após o vencimento</span>',
  A_VENCER: '<span class="st">a vencer</span>',
  DECLARADO_SEM_DAS: '<span class="st">declarado · DAS a emitir</span>',
  A_DECLARAR: '<span class="st wr">a declarar</span>',
  SEM_DEBITO: '<span class="mut">sem débito</span>',
  PAGAMENTO_NAO_IDENTIFICADO: '<span class="st bad">pagamento ainda não identificado</span>',
  DECLARACAO_NAO_IDENTIFICADA: '<span class="st bad">declaração ainda não identificada</span>'
};
function loadGuias(id) {
  return getJson("/api/empresa/" + id + "/guias").then(function (r) {
    var box = $("guias"); if (!box) return;
    var rows = r.rows.map(function (g) {
      var decl = g.declaration ? '<span class="mono" style="font-size:11px">' + esc(g.declaration.number) + '</span><div class="mut" style="font-size:11px">' + (g.declaration.operation === "RETIFICADORA" ? "retificadora" : "original") + (g.declaration.transmittedAt ? " · " + d(g.declaration.transmittedAt.slice(0, 10)) : "") + '</div>' : '<span class="mut">—</span>';
      var pay = g.payment ? (g.payment.collectedOn ? d(g.payment.collectedOn) : "") + (g.payment.principal ? '<div class="mut" style="font-size:11px">principal ' + brl(g.payment.principal) + '</div>' : '') + '<div class="mut" style="font-size:11px">' + (g.payment.source === "PAGTOWEB" ? "PagtoWeb" : "PGDAS-D") + '</div>' : '<span class="mut">—</span>';
      var calc = g.calculated && g.calculated.total ? brl(g.calculated.total) : '<span class="mut">—</span>';
      return '<tr><td>' + mm(g.competence) + (g.responsibility === "ANTERIOR" ? '<div class="mut" style="font-size:11px">escritório anterior</div>' : '') + '</td><td>' + (g.due ? d(g.due) : '<span class="wr">prazo a aprovar</span>') + (g.dueReason ? '<div class="mut" style="font-size:11px">' + esc(g.dueReason) + '</div>' : '') + '</td><td>' + decl + '</td><td class="num">' + g.das.length + '</td><td class="num">' + calc + '</td><td>' + pay + '</td><td>' + (GS[g.status] || esc(g.status)) + '</td></tr>';
    }).join("");
    box.innerHTML = '<h2>Guias: DAS do Simples</h2>' +
      '<div class="scroll"><table><thead><tr><th>Competência</th><th>Vencimento</th><th>Declaração</th><th class="num">DAS emitidos</th><th class="num">Calculado</th><th>Pagamento</th><th>Situação</th></tr></thead><tbody>' + (rows || '<tr><td colspan="7" class="empty">Sem competências.</td></tr>') + '</tbody></table></div>' +
      '<div class="empty">Situação conforme a última consulta à Receita' + (r.dataUntil ? ' (' + dt(r.dataUntil) + ')' : '') + '. Sem pagamento depois do vencimento, a IARIS diz "ainda não identificado", nunca "inadimplente". Nenhuma guia é emitida aqui.</div>';
  }).catch(function (err) { toast(err.message); });
}

var TAXN = ["IRPJ", "CSLL", "COFINS", "PIS", "CPP", "ICMS", "IPI", "ISS"];
function loadSimples(id) {
  return getJson("/api/empresa/" + id + "/simples").then(function (r) {
    var box = $("simp"); if (!box) return;
    var ST = {
      CONFERE: '<span class="st ok">confere</span>',
      DIVERGE: '<span class="st bad">diverge</span>',
      CALCULADO: '<span class="st wr">calculado · a declarar</span>',
      SEM_REFERENCIA: '<span class="mut">sem referência</span>',
      REGRA_PENDENTE: '<a class="st wr" href="#/regras">tabela a aprovar</a>',
      SEM_ANEXO: '<span class="st wr">sem anexo</span>',
      NAO_SUPORTADO: '<span class="st bad">fora do motor</span>'
    };
    var REF = { DECLARACAO: "débito declarado", DAS_PAGO: "DAS pago (principal)" };
    var rows = r.rows.map(function (x) {
      var res = x.result || {};
      var inp = x.inputs || {};
      var taxes = res.taxes ? TAXN.filter(function (t) { return Number(res.taxes[t]) !== 0; }).map(function (t) {
        var dif = res.taxDifferences && res.taxDifferences[t] ? ' <span class="bad">(' + brl(res.taxDifferences[t]) + ')</span>' : '';
        return t + ' ' + brl(res.taxes[t]) + dif;
      }).join(" · ") : "";
      var base = '<div class="mut" style="font-size:11px">RBT12 ' + (inp.rbt12 ? brl(inp.rbt12) : "—") + (inp.rbt12Proportional ? " (proporcional)" : "") + (res.bracket ? " · faixa " + res.bracket + " · alíq. efetiva " + Number(res.effectiveRate).toFixed(4).replace(".", ",") + "%" : "") + '</div>';
      var why = (res.reason ? '<div class="wr" style="font-size:11px">' + esc(res.reason) + '</div>' : '') + (res.notes && res.notes.length ? '<div class="mut" style="font-size:11px">' + esc(res.notes.join(" · ")) + '</div>' : '');
      return '<tr><td>' + mm(x.competence) + '<div class="mut" style="font-size:11px">' + (x.mode === "APURACAO" ? "apuração pelas NFS-e" : "conferência") + '</div></td>' +
        '<td class="num">' + (inp.rpa ? brl(inp.rpa) : "—") + base + '</td>' +
        '<td class="num"><b>' + (x.total === null ? "—" : brl(x.total)) + '</b>' + (taxes ? '<div class="mut" style="font-size:11px;white-space:normal">' + taxes + '</div>' : '') + '</td>' +
        '<td class="num">' + (x.reference_total === null ? "—" : brl(x.reference_total) + '<div class="mut" style="font-size:11px">' + esc(REF[x.reference_kind] || "") + '</div>') + '</td>' +
        '<td class="num">' + (x.difference === null ? "—" : brl(x.difference)) + '</td>' +
        '<td>' + (ST[x.status] || esc(x.status)) + why + '</td></tr>';
    }).join("");
    box.innerHTML = '<h2>Simples Nacional: cálculo do motor</h2>' +
      (rows ? '<div class="scroll"><table><thead><tr><th>Competência</th><th class="num">Receita do PA</th><th class="num">Calculado</th><th class="num">Referência</th><th class="num">Diferença</th><th>Situação</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<div class="empty">Sem cálculo ainda: precisa de uma declaração lida (anexo da atividade) e das tabelas aprovadas.</div>') +
      '<div class="empty">Motor determinístico, sem IA. Competência declarada: recalcula com a receita e a RBT12 declaradas e compara com o débito do PDF ou com o DAS pago. Mês fechado e não declarado: receita pelas NFS-e prestadas. Nada é transmitido.</div>';
  }).catch(function (err) { toast(err.message); });
}

function prevMonth(m) { var y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7)) - 1; if (mo < 1) { mo = 12; y--; } return y + "-" + String(mo).padStart(2, "0"); }
function loadConferencia(id) {
  return getJson("/api/empresa/" + id + "/conferencia").then(function (r) {
    var box = $("conf"); if (!box) return;
    var ST = { OK: '<span class="st ok">confere</span>', DIVERGENTE: '<span class="st bad">divergente</span>', SEM_DECLARACAO: '<span class="mut">sem declaração lida</span>' };
    var rows = r.rows.map(function (x) {
      return '<tr><td>' + mm(x.competence) + (x.responsibility === "ANTERIOR" ? '<div class="mut" style="font-size:11px">escritório anterior</div>' : '') + '</td><td class="num">' + (x.declared === null ? "—" : brl(x.declared)) + (x.regime === "CAIXA" ? '<div class="wr" style="font-size:11px">regime de caixa</div>' : '') + '</td><td class="num">' + brl(x.nfsePrestadas) + '<div class="mut" style="font-size:11px">' + x.nfseCount + ' nota(s)' + (x.cancelled ? ' · ' + x.cancelled + ' cancelada(s) fora' : '') + '</div></td><td class="num">' + (x.difference === null ? "—" : brl(x.difference)) + '</td><td>' + ST[x.status] + '</td></tr>';
    }).join("");
    var def = prevMonth(lastClosedMonth());
    var exc = r.rows.filter(function (x) { return x.status === "DIVERGENTE"; }).length;
    box.innerHTML = '<h2>Conferência da implantação: receita declarada × NFS-e prestadas</h2>' +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px"><label class="mut" for="decl-pa">Última declaração do PA</label><input type="month" id="decl-pa" value="' + def + '"><button data-act="decl" data-id="' + id + '">Buscar declaração</button><span class="mut" style="font-size:12px">1 consulta cobrada; traz a receita do PA e dos 12 meses anteriores</span></div>' +
      (rows ? '<div class="scroll"><table><thead><tr><th>Competência</th><th class="num">Receita declarada</th><th class="num">NFS-e prestadas</th><th class="num">Diferença (NFS-e − declarado)</th><th>Situação</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<div class="empty">Nenhuma declaração lida ainda.</div>') +
      (exc ? '<div class="wr" style="margin-top:8px">' + exc + ' competência(s) divergente(s) viraram exceção na <a href="#/fila">Fila humana</a>, com a hipótese e as notas envolvidas.</div>' : '') +
      '<div class="empty">NFS-e pela data de emissão (Brasília), sem as canceladas. Tolerância de R$ 1,00. Empresas que vendem por NFC-e/NF-e só fecham quando esses documentos entrarem.</div>';
  }).catch(function (err) { toast(err.message); });
}

/* ---------------- Documentos fiscais ---------------- */
var KIND = { NFE: "NF-e completa", RES_NFE: "resumo de NF-e", EVENTO: "evento", RES_EVENTO: "resumo de evento", OUTRO: "outro" };
var CI = { APROVADA: "ciência aprovada · envio à SEFAZ pendente", ENVIADA: "ciência enviada", REGISTRADA: "ciência registrada", REJEITADA: "ciência rejeitada" };
function viewDocumentos(entityId) {
  setHead("Documentos fiscais", "NF-e, CT-e e NFS-e de cada empresa. Busca sem custo no início e no fim do dia, ou quando você pedir.");
  return getJson("/api/documentos" + (entityId ? "?empresa=" + entityId : "")).then(function (r) {
    var st = r.status.map(function (e) {
      var last = e.lastQueryAt ? dt(e.lastQueryAt) + '<div class="mut" style="font-size:12px">' + esc((e.lastStatus || "") + " " + (e.lastMessage || "")) + '</div>' : '<span class="mut">nunca</span>';
      var next = !e.hasCertificate ? '<span class="wr">sem certificado</span>' : e.nextAllowedAt && new Date(e.nextAllowedAt) > new Date() ? 'a partir de ' + hm(e.nextAllowedAt) : 'agora';
      if (e.blockedBySequence) next = '<span class="bad st">parada</span><div class="mut" style="font-size:12px">outro sistema já baixa as notas deste CNPJ</div>';
      var row = '<tr><td><a href="#/documentos/' + e.id + '" style="color:var(--ink)"><b>' + esc(e.name) + '</b></a><div class="mut mono" style="font-size:12px">' + esc(e.cnpj) + '</div></td><td class="num">' + e.fullNfe + '</td><td class="num">' + e.summaries + '</td><td class="num">' + e.documents + '</td><td>' + last + '</td><td>' + next + '</td><td class="num"><button data-act="dfe" data-id="' + e.id + '"' + (e.hasCertificate && r.configured ? '' : ' disabled') + '>Buscar agora</button></td></tr>';
      if (e.blockedBySequence) row += '<tr><td colspan="7" style="background:var(--amber-bg)"><b class="wr">Busca parada para não renovar o bloqueio.</b> <span class="mut">Informe o último NSU do sistema que já baixa as notas (ou desligue a busca nele) e a IARIS continua daí, depois da espera de 1 hora.</span><div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><input id="nsu-' + e.id + '" inputmode="numeric" placeholder="último NSU (ex.: 000000000012345)" style="font:inherit;padding:7px 10px;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--ink);min-width:260px"><button class="warn" data-act="nsu" data-id="' + e.id + '">Usar este NSU</button></div></td></tr>';
      return row;
    }).join("");
    var docs = r.documents.map(function (x) {
      var what = x.kind === "EVENTO" || x.kind === "RES_EVENTO" ? esc(x.eventDesc || ("evento " + (x.eventType || ""))) : esc(KIND[x.kind] || x.kind) + (x.situation === "3" ? ' <span class="bad">cancelada</span>' : x.situation === "2" ? ' <span class="bad">denegada</span>' : '');
      var ci = x.kind !== "RES_NFE" ? "" : x.hasFull ? '<span class="ok">XML completo</span>' : x.ciencia ? '<span class="wr">' + esc(CI[x.ciencia] || x.ciencia) + '</span>' : x.situation === "1" ? '<span class="wr">aguarda sua ciência</span>' : '';
      return '<tr><td>' + (x.issuedAt ? dt(x.issuedAt) : "—") + '</td><td>' + esc(x.entity) + '</td><td><b>' + esc(x.issuerName || "—") + '</b><div class="mut mono" style="font-size:11px">' + esc(x.issuerDoc || "") + '</div></td><td>' + what + '<div>' + ci + '</div></td><td class="num">' + (x.total ? brl(x.total) : "—") + '</td><td class="mono" style="font-size:11px">' + esc(x.accessKey || "") + '</td></tr>';
    }).join("");
    var sc = r.schedule || { slots: [], last: [] };
    var lastRun = sc.last && sc.last[0] ? dt(sc.last[0].ran_at) + (sc.last[0].trigger === "PESSOA" ? ' (pedido)' : ' (horário)') : 'ainda não rodou';
    var head = '<section class="card"><h2>Busca de notas</h2><div class="form-row" style="align-items:center">' +
      '<div>Horários automáticos: <b>' + esc((sc.slots || []).join(" e ")) + '</b> · Última busca: ' + lastRun + (sc.next ? ' · Próxima: ' + dt(sc.next) : '') + '</div>' +
      '<button class="warn" data-buscar="1" id="busca-todas"' + (r.configured ? '' : ' disabled') + '>Buscar notas agora (todas as empresas)</button></div>' +
      '<div class="empty">Se o computador estiver desligado no horário, a busca roda assim que o sistema abrir. NF-e e CT-e seguem a regra da SEFAZ (sem nota nova, 1 hora de espera por CNPJ).</div></section>';
    $("view").innerHTML = head + '<section class="card"><h2>Busca na SEFAZ por empresa</h2><div class="scroll"><table><thead><tr><th>Empresa</th><th class="num">NF-e completas</th><th class="num">Resumos</th><th class="num">Documentos</th><th>Última consulta</th><th>Próxima consulta</th><th></th></tr></thead><tbody>' + st + '</tbody></table></div>' +
      '<div class="empty">Regra da SEFAZ: sem nota nova, a próxima consulta só depois de 1 hora (fora disso o CNPJ fica bloqueado por 1 hora). A IARIS segue essa regra sozinha.</div></section>' +
      '<section class="card"><h2>' + (entityId ? "Documentos da empresa" : "Documentos recebidos") + ' (' + r.documents.length + ')</h2>' + (entityId ? '<div style="margin-bottom:8px"><a href="#/documentos">ver todas as empresas</a></div>' : '') +
      '<div class="scroll"><table><thead><tr><th>Emissão</th><th>Empresa</th><th>Emitente</th><th>Documento</th><th class="num">Valor</th><th>Chave</th></tr></thead><tbody>' + (docs || '<tr><td colspan="6" class="empty">Nenhum documento recebido ainda.</td></tr>') + '</tbody></table></div></section>' +
      nfseHtml(r, entityId) +
      '<section class="card" id="xmlin"><h2>Entrada de XML (upload, pasta e CT-e)</h2><div class="empty">Carregando…</div></section>';
    loadXmlIn(entityId);
    var bt = $("busca-todas");
    if (bt) bt.addEventListener("click", function () {
      bt.disabled = true; toast("Buscando notas de todas as empresas…");
      post("/api/documentos/buscar", "buscar-notas", {}).then(function (x) {
        toast("Busca concluída: " + x.nfe + " NF-e, " + x.cte + " CT-e, " + x.nfse + " NFS-e novas" + (x.waiting ? " (" + x.waiting + " empresa(s) na espera da SEFAZ)" : "") + ".");
        return viewDocumentos(entityId);
      }).catch(function (e) { toast(e.message); bt.disabled = false; });
    });
  });
}

var DT = { NFE: "NF-e", NFCE: "NFC-e", CTE: "CT-e", NFSE: "NFS-e", EVENTO_NFE: "evento de NF-e", EVENTO_CTE: "evento de CT-e", OUTRO: "outro" };
var RL = { EMITENTE: "emitida", DESTINATARIO: "recebida", TOMADOR: "tomada", PRESTADOR: "prestada", OUTRO: "citada" };
var SRC = { UPLOAD: "upload", PASTA: "pasta", CTE_DIST: "distribuição CT-e" };
function loadXmlIn(entityId) {
  return getJson("/api/documentos/xml" + (entityId ? "?empresa=" + entityId : "")).then(function (r) {
    var box = $("xmlin"); if (!box) return;
    var sum = r.summary.map(function (x) {
      return '<tr><td>' + esc(x.entity) + '</td><td>' + esc(DT[x.doc_type] || x.doc_type) + '</td><td>' + esc(RL[x.role] || x.role) + '</td><td class="num">' + x.n + '</td><td class="num">' + (x.total ? brl(x.total) : "—") + '</td><td>' + (x.first_at ? d(x.first_at.slice(0, 10)) + ' a ' + d(x.last_at.slice(0, 10)) : "—") + '</td></tr>';
    }).join("");
    var rec = r.recent.slice(0, 30).map(function (x) {
      var st = x.status === "CANCELADO" ? ' <span class="bad">cancelado</span>' : x.status === "DENEGADO" ? ' <span class="bad">denegado</span>' : x.status === "SEM_PROTOCOLO" ? ' <span class="wr">sem protocolo</span>' : '';
      return '<tr><td>' + (x.issued_at ? dt(x.issued_at) : "—") + '</td><td>' + esc(x.entity) + '</td><td>' + esc(DT[x.doc_type] || x.doc_type) + (x.number ? ' nº ' + esc(x.number) : '') + st + '<div class="mut" style="font-size:11px">' + esc(RL[x.role] || x.role) + ' · ' + esc(SRC[x.source] || x.source) + '</div></td><td>' + esc(x.issuer_name || "—") + '</td><td class="num">' + (x.total ? brl(x.total) : "—") + '</td></tr>';
    }).join("");
    box.innerHTML = '<h2>Entrada de XML (upload, pasta e CT-e)</h2>' +
      '<div class="drop" id="drop"><b>Arraste aqui os XML ou ZIP</b><span class="mut">NF-e, NFC-e, CT-e, NFS-e e eventos. A empresa é achada pelo CNPJ do próprio documento.</span>' +
      '<div class="form-row"><input type="file" id="xmlfiles" multiple accept=".xml,.zip"><button class="warn" data-act="xmlup" type="button">Enviar</button></div></div>' +
      '<div id="xmlres"></div>' +
      (r.inbox ? '<div class="empty">Pasta de entrada: <span class="mono">' + esc(r.inbox) + '</span>. O que cair lá (ex.: XML exportado do PDV) entra sozinho a cada 2 minutos e vai para processados ou recusados. Nada é apagado.</div>' : '') +
      '<h3 class="sec">Resumo</h3><div class="scroll"><table><thead><tr><th>Empresa</th><th>Tipo</th><th>Papel</th><th class="num">Qtde</th><th class="num">Valor autorizado</th><th>Período</th></tr></thead><tbody>' + (sum || '<tr><td colspan="6" class="empty">Nenhum XML recebido por aqui ainda.</td></tr>') + '</tbody></table></div>' +
      (rec ? '<h3 class="sec">Últimos recebidos</h3><div class="scroll"><table><thead><tr><th>Emissão</th><th>Empresa</th><th>Documento</th><th>Emitente</th><th class="num">Valor</th></tr></thead><tbody>' + rec + '</tbody></table></div>' : '');
    var drop = $("drop");
    ["dragenter", "dragover"].forEach(function (e) { drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.add("on"); }); });
    ["dragleave", "drop"].forEach(function (e) { drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.remove("on"); }); });
    drop.addEventListener("drop", function (ev) { uploadXml(ev.dataTransfer.files, entityId); });
  }).catch(function (err) { toast(err.message); });
}
function uploadXml(fileList, entityId) {
  var files = Array.prototype.slice.call(fileList || []);
  if (!files.length) { toast("Escolha os arquivos XML ou ZIP."); return; }
  var total = files.reduce(function (n, f) { return n + f.size; }, 0);
  if (total > 30 * 1024 * 1024) { toast("Até 30 MB por envio. Mande em partes ou use a pasta de entrada."); return; }
  toast("Enviando " + files.length + " arquivo(s)…");
  Promise.all(files.map(function (f) {
    return new Promise(function (ok, fail) {
      var fr = new FileReader();
      fr.onload = function () { ok({ name: f.name, data: String(fr.result).split(",")[1] || "" }); };
      fr.onerror = function () { fail(new Error("Não consegui ler " + f.name)); };
      fr.readAsDataURL(f);
    });
  })).then(function (payload) { return post("/api/documentos/upload", "confirmar", { files: payload }); }).then(function (r) {
    var bad = r.items.filter(function (i) { return i.status === "SEM_EMPRESA" || i.status === "INVALIDO" || i.status === "IGNORADO"; });
    toast(r.imported + " importado(s), " + r.duplicated + " já existiam, " + r.rejected + " recusado(s).");
    return loadXmlIn(entityId).then(function () {
      if (bad.length) $("xmlres").innerHTML = '<div class="empty"><b>Recusados:</b><br>' + bad.slice(0, 30).map(function (i) { return esc(i.file) + ' — ' + esc(i.reason || i.status); }).join("<br>") + (bad.length > 30 ? '<br>…' : '') + '</div>';
    });
  }).catch(function (err) { toast(err.message); });
}

var ROLE = { PRESTADA: "prestada", TOMADA: "tomada", OUTRA: "outra", EVENTO: "evento" };
function nfseHtml(r, entityId) {
  var st = r.status.map(function (e) {
    var n = r.nfseStatus[e.id] || {};
    var last = n.lastQueryAt ? dt(n.lastQueryAt) + '<div class="mut" style="font-size:12px">' + esc((n.lastStatus || "") + (n.lastMessage ? " " + n.lastMessage : "")) + '</div>' : '<span class="mut">nunca</span>';
    var next = !e.hasCertificate ? '<span class="wr">sem certificado</span>' : n.nextAllowedAt && new Date(n.nextAllowedAt) > new Date() ? 'a partir de ' + hm(n.nextAllowedAt) : 'agora';
    return '<tr><td><b>' + esc(e.name) + '</b><div class="mut mono" style="font-size:12px">' + esc(e.cnpj) + '</div></td><td class="num">' + (n.prestadas || 0) + '</td><td class="num">' + (n.tomadas || 0) + '</td><td>' + last + '</td><td>' + next + '</td><td class="num"><button data-act="nfse" data-id="' + e.id + '"' + (e.hasCertificate && r.configured ? '' : ' disabled') + '>Buscar NFS-e</button></td></tr>';
  }).join("");
  var docs = r.nfse.map(function (x) {
    var parte = x.role === "PRESTADA" ? esc(x.taker_name || x.taker_doc || "—") : esc(x.provider_name || x.provider_doc || "—");
    return '<tr><td>' + (x.issued_at ? dt(x.issued_at) : "—") + '</td><td>' + esc(x.entity) + '</td><td>' + esc(ROLE[x.role] || x.role) + (x.event_type ? ' <span class="mut">(' + esc(x.event_type) + ')</span>' : '') + '</td><td>' + esc(x.number || "—") + '</td><td>' + parte + '</td><td class="num">' + (x.service_value ? brl(x.service_value) : "—") + (x.iss_withheld ? '<div class="wr" style="font-size:11px">ISS retido</div>' : '') + '</td></tr>';
  }).join("");
  return '<section class="card"><h2>NFS-e do Sistema Nacional</h2><div class="scroll"><table><thead><tr><th>Empresa</th><th class="num">Prestadas</th><th class="num">Tomadas</th><th>Última consulta</th><th>Próxima</th><th></th></tr></thead><tbody>' + st + '</tbody></table></div>' +
    '<div class="empty">Sequência própria, separada da NF-e. Municípios fora do padrão nacional entram por outro conector.</div>' +
    '<div class="scroll" style="margin-top:10px"><table><thead><tr><th>Emissão</th><th>Empresa</th><th>Papel</th><th>Número</th><th>Tomador / prestador</th><th class="num">Valor do serviço</th></tr></thead><tbody>' + (docs || '<tr><td colspan="6" class="empty">Nenhuma NFS-e recebida ainda.</td></tr>') + '</tbody></table></div></section>';
}

/* ---------------- Departamentos ---------------- */
function agentHtml(a) {
  var caps = a.capabilities.map(function (c) { return '<span class="cap' + (c.on ? ' on' : '') + '">' + (c.on ? '● ' : '○ ') + esc(c.name) + '</span>'; }).join("");
  var tag = a.active ? "operando" : a.status === "EM_CONSTRUCAO" ? "em construção" : "não ativo";
  var act = a.lastAt ? 'última ação ' + hm(a.lastAt) + ' · ' + a.actions24h + ' nas últimas 24 h' : (a.active ? 'sem ação registrada ainda' : '');
  return '<div class="ag' + (a.active ? ' on' : '') + '"><div class="ah"><span class="lamp"></span>' + esc(a.name) + '<span class="tag">' + tag + '</span></div><p>' + esc(a.summary) + '</p><div class="caps">' + caps + '</div>' + (act ? '<div class="act">' + act + '</div>' : '') + '</div>';
}
function deptHtml(d, full) {
  var pct = d.capabilitiesTotal ? Math.round(100 * d.capabilitiesOn / d.capabilitiesTotal) : 0;
  var agents = d.agents.map(agentHtml).join("");
  return '<section class="dept"><div class="dh"><h2>' + (full ? esc(d.name) : '<a href="#/depto/' + d.id + '" style="color:var(--ink)">' + esc(d.name) + '</a>') + '</h2><span class="mut" style="font-size:12px">' + d.activeAgents + ' de ' + d.agents.length + ' agentes operando</span></div>' +
    '<div class="mut" style="font-size:12px">' + esc(d.summary) + '</div>' +
    '<div class="meter" title="' + d.capabilitiesOn + ' de ' + d.capabilitiesTotal + ' capacidades ativas"><i style="width:' + pct + '%"></i></div><div class="mut" style="font-size:11px;margin-top:-6px">' + d.capabilitiesOn + ' de ' + d.capabilitiesTotal + ' capacidades ativas (' + pct + '%)</div>' +
    agents + '</section>';
}
function legendHtml() {
  return '<div class="legend"><span><span class="lamp" style="background:var(--green);box-shadow:0 0 0 3px var(--green-bg)"></span>operando e ativo</span><span><span class="lamp"></span>ainda não ativo</span><span><span class="cap on">● capacidade ativa</span></span><span><span class="cap">○ capacidade a construir</span></span></div>';
}
function paintDeptDots(r) {
  r.departments.forEach(function (d) { var el = $("dd-" + d.id); if (el) el.style.background = d.activeAgents ? "var(--green)" : "var(--red)"; });
}
function viewDepartamentos() {
  setHead("Funcionamento dos agentes", "Cada departamento com seus agentes: verde operando, vermelho ainda não ativo");
  return getJson("/api/departamentos").then(function (r) {
    paintDeptDots(r);
    var all = r.departments.reduce(function (n, d) { return n + d.agents.length; }, 0) + r.shared.length;
    var on = r.departments.reduce(function (n, d) { return n + d.activeAgents; }, 0) + r.shared.filter(function (a) { return a.active; }).length;
    var kpis = r.departments.map(function (d) {
      return '<a class="kpi" href="#/depto/' + d.id + '" style="text-decoration:none;color:inherit"><span>' + esc(d.name) + '</span><b class="mono" style="color:' + (d.activeAgents ? 'var(--green-ink)' : 'var(--red-ink)') + '">' + d.activeAgents + '/' + d.agents.length + '</b><small>agentes operando</small></a>';
    }).join("");
    $("view").innerHTML = '<section class="kpis"><div class="kpi"><span>Todos os agentes</span><b class="mono" style="color:var(--green-ink)">' + on + '/' + all + '</b><small>operando</small></div>' + kpis + '</section>' + legendHtml() +
      '<div class="depts">' + r.departments.map(function (d) { return deptHtml(d, false); }).join("") + '</div>' +
      '<section class="dept"><div class="dh"><h2>Comum a todos</h2></div>' + r.shared.map(agentHtml).join("") + '</section>';
  });
}
function viewDepto(id) {
  return getJson("/api/departamentos").then(function (r) {
    paintDeptDots(r);
    var d = r.departments.find(function (x) { return x.id === id; });
    if (!d) { location.hash = "#/departamentos"; return; }
    setHead(d.name, d.activeAgents + " de " + d.agents.length + " agentes operando · " + d.summary);
    $("view").innerHTML = legendHtml() + '<div style="max-width:900px">' + deptHtml(d, true) + '</div>';
  });
}

/* ---------------- Vínculos dos agentes ---------------- */
function resultText(r) {
  if (!r) return "";
  var parts = [];
  Object.keys(r).forEach(function (k) {
    var v = r[k];
    if (v === null || v === undefined || typeof v === "object") return;
    var L = { opened: "abertas", updated: "atualizadas", closed: "fechadas", calculated: "competências calculadas", changed: "mudanças", guides: "guias", documents: "documentos", calls: "consultas", status: "situação", skipped: "pulado" };
    parts.push((L[k] || k) + ": " + v);
  });
  return parts.join(" · ");
}
function viewVinculos() {
  setHead("Vínculos dos agentes", "Quando um agente termina, o próximo começa sozinho. Sem repasse manual.");
  return getJson("/api/vinculos").then(function (r) {
    var cards = r.links.map(function (l) {
      var on = l.on.map(function (e) { return '<span class="ev">' + esc(e.label) + '</span>'; }).join(" ");
      var st = l.lastAt ? 'última reação ' + hm(l.lastAt) + ' · ' + l.ok7d + ' em 7 dias' + (l.errors7d ? ' · <span class="bad">' + l.errors7d + ' com erro</span>' : '') : '<span class="mut">ainda não reagiu</span>';
      return '<div class="lk"><div class="lk-when"><span class="lk-lbl">Quando</span><div class="caps">' + on + '</div></div>' +
        '<div class="lk-arrow" aria-hidden="true">→</div>' +
        '<div class="lk-who"><span class="lk-lbl">Agente</span><b>' + esc(l.agentName) + '</b></div>' +
        '<div class="lk-arrow" aria-hidden="true">→</div>' +
        '<div class="lk-does"><span class="lk-lbl">Faz</span>' + esc(l.does) + '<div class="mut" style="font-size:12px;margin-top:4px">' + st + '</div></div></div>';
    }).join("");
    var rows = r.recent.map(function (x) {
      var res = x.status === "OK" ? esc(resultText(x.result)) : '<span class="bad">' + esc(x.error || "erro") + '</span>';
      var caused = x.caused.length ? '<div class="mut" style="font-size:11px">gerou: ' + esc(x.caused.join(", ")) + '</div>' : '';
      return '<tr><td>' + dt(x.at) + '<div class="mut" style="font-size:11px">' + x.ms + ' ms</div></td><td>' + esc(x.event) + (x.events > 1 ? ' <span class="mut">(' + x.events + ')</span>' : '') + '</td><td>' + esc(x.entity || "todas") + '</td><td><b>' + esc(x.agentName) + '</b></td><td>' + res + caused + '</td><td class="st ' + (x.status === "OK" ? "ok" : "bad") + '">' + (x.status === "OK" ? "feito" : "erro") + '</td></tr>';
    }).join("");
    $("view").innerHTML = '<section class="card"><h2>' + r.links.length + ' vínculos ativos</h2><div class="lks">' + cards + '</div>' +
      '<div class="empty">Cada evento é tratado uma vez por vínculo. Erro é refeito até 3 vezes; depois vai para a Fila humana. Nenhum vínculo transmite nada nem faz consulta cobrada.</div></section>' +
      '<section class="card"><h2>Últimas reações</h2><div class="scroll"><table><thead><tr><th>Quando</th><th>O que aconteceu</th><th>Empresa</th><th>Agente</th><th>Resultado</th><th>Situação</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6" class="empty">Nenhuma reação ainda.</td></tr>') + '</tbody></table></div></section>';
  });
}

/* ---------------- Usuários ---------------- */
var ROLES = [["LEITURA", "Leitura"], ["OPERADOR", "Operador"], ["RESPONSAVEL_TECNICO", "Responsável técnico"]];
var USTATUS = { ATIVO: '<span class="st ok">ativo</span>', CONVITE_PENDENTE: '<span class="st wr">convite pendente</span>', CONVITE_VENCIDO: '<span class="st bad">convite vencido</span>', LINK: '<span class="st ok">entra pelo link</span>', REVOGADO: '<span class="mut">revogado</span>' };
function roleSelect(id, value, attrs) {
  return '<select id="' + id + '"' + (attrs || "") + '>' + ROLES.map(function (r) { return '<option value="' + r[0] + '"' + (r[0] === value ? " selected" : "") + '>' + r[1] + '</option>'; }).join("") + '</select>';
}
function viewUsuarios() {
  setHead("Usuários e acessos", "Quem entra na IARIS e o que cada perfil pode fazer. Só o Responsável técnico administra.");
  return getJson("/api/usuarios").then(function (r) {
    var rows = r.users.map(function (u, i) {
      var me = u.email === r.me;
      var acts = '<button class="ghost" data-act="ulinkgen" data-i="' + i + '">Link de acesso</button> ' + (u.status === "REVOGADO"
        ? ''
        : (me ? '<span class="mut">você</span>' : '<button class="ghost" data-act="urevoke" data-i="' + i + '">Revogar</button>'));
      var role = u.status === "REVOGADO" ? esc(u.roleLabel || "—") : roleSelect("ur-" + i, u.role, ' data-act-change="urole" data-i="' + i + '"' + (me ? " disabled" : ""));
      return '<tr><td><b>' + esc(u.name) + '</b><div class="mut" style="font-size:12px">' + esc(u.email) + '</div></td><td>' + role + '</td><td>' + (USTATUS[u.status] || esc(u.status)) + (u.linkExpires ? '<div class="mut" style="font-size:11px">link vale até ' + dt(u.linkExpires) + (u.linkUsed ? ' · usado ' + dt(u.linkUsed) : ' · ainda não usado') + '</div>' : u.inviteExpires ? '<div class="mut" style="font-size:11px">convite vale até ' + dt(u.inviteExpires) + '</div>' : '') + '</td><td>' + (u.lastLogin ? dt(u.lastLogin) : '<span class="mut">nunca</span>') + '</td><td class="num">' + acts + '</td></tr>';
    }).join("");
    window._users = r.users;
    $("view").innerHTML =
      '<section class="card"><h2>Dar acesso a uma pessoa</h2>' +
      '<form id="uform" class="form-row"><label>Nome<input id="uname" required minlength="2" autocomplete="off"></label><label>E-mail<input id="uemail" type="email" required autocomplete="off"></label><label>Perfil' + roleSelect("urole", "LEITURA") + '</label><button class="warn" type="submit">Gerar link de acesso</button><button class="ghost" type="button" id="uinv">Convite com senha e código</button></form>' +
      '<div id="ulink"></div>' +
      (r.publicOrigin ? '<div class="empty">Endereço público ligado: <span class="mono">' + esc(r.publicOrigin) + '</span>. O convite abre no computador da pessoa.</div>' : '<div class="empty wr">Endereço público desligado: o convite só abre neste computador. Para mandar a outra pessoa, inicie a IARIS com <span class="mono">pnpm web:publico</span>.</div>') +
      '<div class="empty"><b>Link de acesso</b>: quem abrir o link entra como essa pessoa, sem senha e sem código, por 90 dias. Mande só para ela. Gerar um link novo cancela o anterior; Revogar corta o acesso na hora. Tudo o que ela fizer fica na auditoria no nome dela.</div>' +
      '<div class="empty"><b>Convite com senha e código</b>: vale 72 horas e só funciona uma vez; a pessoa cria a senha e liga o aplicativo autenticador. Nenhum e-mail é enviado: copie o link e mande pelo canal que preferir.</div></section>' +
      '<section class="card"><h2>' + r.users.length + ' usuário(s)</h2><div class="scroll"><table><thead><tr><th>Pessoa</th><th>Perfil</th><th>Situação</th><th>Último acesso</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="empty"><b>Leitura</b>: vê tudo, não executa nada. <b>Operador</b>: também busca na Receita e nas prefeituras e confirma dados. <b>Responsável técnico</b>: também aprova regras, exceções e conclusões, e administra usuários. Toda mudança fica na auditoria.</div></section>';
    $("uform").addEventListener("submit", function (ev) {
      ev.preventDefault();
      accessLink({ name: $("uname").value, email: $("uemail").value, role: $("urole").value });
    });
    $("uinv").addEventListener("click", function () {
      if (!$("uform").reportValidity()) return;
      invite({ name: $("uname").value, email: $("uemail").value, role: $("urole").value });
    });
  });
}
function showInviteLink(body, r, isLink) {
  $("ulink").innerHTML = '<div class="linkbox"><b>' + (isLink ? 'Link de acesso de ' : 'Convite de ') + esc(body.name) + ' pronto' + (r.created ? '' : ' (o link anterior deixou de valer)') + '</b><input id="ulinkv" readonly value="' + esc(r.link) + '"><div class="form-row"><button class="warn" type="button" id="ucopy">Copiar link</button><span class="mut" style="font-size:12px">Vale até ' + dt(r.expiresAt) + '. Este link aparece só agora.</span></div></div>';
  $("ucopy").addEventListener("click", function () {
    var v = $("ulinkv"); v.focus(); v.select();
    var done = function () { toast("Link copiado."); };
    if (navigator.clipboard) navigator.clipboard.writeText(v.value).then(done).catch(function () { document.execCommand("copy"); done(); });
    else { document.execCommand("copy"); done(); }
  });
}
function accessLink(body) {
  return post("/api/usuarios/link", "usuarios", body)
    .then(function (r) { return viewUsuarios().then(function () { showInviteLink(body, r, true); }); })
    .catch(function (err) { toast(err.message); });
}
function invite(body) {
  return post("/api/usuarios/convidar", "usuarios", body)
    .then(function (r) { return viewUsuarios().then(function () { showInviteLink(body, r); }); })
    .catch(function (err) { toast(err.message); });
}
document.addEventListener("change", function (ev) {
  var el = ev.target;
  if (!el.dataset || el.dataset.actChange !== "urole") return;
  var u = window._users[Number(el.dataset.i)];
  var label = el.options[el.selectedIndex].text;
  if (!window.confirm("Mudar o perfil de " + u.name + " para " + label + "?")) { el.value = u.role; return; }
  post("/api/usuarios/perfil", "usuarios", { email: u.email, role: el.value }).then(function () { toast("Perfil de " + u.name + ": " + label + "."); }).catch(function (err) { toast(err.message); }).then(route);
});

/* ---------------- Regras ---------------- */
function simplesRulesHtml(list) {
  var pend = list.filter(function (x) { return !x.approved_by && !x.superseded; }).length;
  var rows = list.map(function (x) {
    var def = x.definition || {};
    var det = def.kind === "ANEXO" ? def.brackets.map(function (b) { return b.n + "ª até " + brl(b.upTo) + ": " + b.rate.replace(".", ",") + "% − " + brl(b.deduction); }).join("<br>") + (def.localCap ? '<div class="mut" style="font-size:11px">teto do ' + def.localTax + ' ' + def.localCap.rate.replace(".", ",") + '%; diferença: ' + Object.keys(def.localCap.transfer).map(function (k) { return k + " " + def.localCap.transfer[k].replace(".", ",") + "%"; }).join(", ") + '</div>' : '')
      : "limite " + brl(def.limit) + " · sublimite " + brl(def.sublimit) + " · tolerância " + def.excessTolerance.replace(".", ",") + "%";
    return '<tr><td><b>' + esc(x.name) + '</b><div class="mut mono" style="font-size:11px">' + esc(x.code) + ' v' + x.version + '</div></td><td style="font-size:12px">' + det + '</td><td>' + esc(x.legal_basis) + (x.notes ? '<div class="mut" style="font-size:12px">' + esc(x.notes) + '</div>' : '') + '</td><td class="st ' + (x.approved_by ? "ok" : "wr") + '">' + (x.approved_by ? "aprovada por " + esc(x.approved_by) : x.superseded ? "substituída" : "proposta") + '</td></tr>';
  }).join("");
  return '<section class="card"><h2>Tabelas do Simples Nacional · ' + pend + ' aguardando aprovação</h2><div class="scroll"><table><thead><tr><th>Tabela</th><th>Faixas (alíquota − parcela a deduzir)</th><th>Fundamento</th><th>Situação</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<div class="empty">A repartição por tributo de cada faixa está na tabela. O Anexo IV já foi conferido centavo a centavo contra declarações reais; os demais foram transcritos da LC 123 e precisam de conferência antes de aprovar.</div>' +
    (pend ? '<div style="margin-top:14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><button class="warn" data-act="srules">Aprovar ' + pend + ' tabela(s)</button><span class="mut">Sem aprovação o motor não calcula. A aprovação fica na auditoria em seu nome e recalcula as empresas.</span></div>' : '') + '</section>';
}

function viewRegras() {
  setHead("Regras e legislação", "Catálogo de obrigações e tabelas de cálculo. Nenhuma regra vale sem a aprovação do responsável técnico.");
  return Promise.all([getJson("/api/regras"), getJson("/api/simples/regras")]).then(function (both) {
    var r = both[0], sr = both[1];
    var pend = r.rules.filter(function (x) { return !x.approved_by; }).length;
    var rows = r.rules.map(function (x) {
      var ADJ = { NEXT_BUSINESS_DAY: "em dia não útil, prorroga", PREVIOUS_BUSINESS_DAY: "em dia não útil, antecipa", NONE: "sem ajuste" };
      var due = !x.due ? '<span class="wr">a cadastrar</span>' : (x.due.kind === "annual" ? "anual, " + String(x.due.day).padStart(2, "0") + "/" + String(x.due.month).padStart(2, "0") : "dia " + x.due.day + " do mês seguinte") + (x.due.adjust ? '<div class="mut" style="font-size:12px">' + ADJ[x.due.adjust] + '</div>' : '');
      return '<tr><td><b>' + esc(x.name) + '</b><div class="mut mono" style="font-size:11px">' + esc(x.code) + ' v' + x.version + (!x.approved_by && x.in_use_version ? ' · em uso: v' + x.in_use_version : '') + '</div></td><td>' + esc(x.sphere.toLowerCase()) + '</td><td>' + due + '</td><td>' + esc(x.legal_basis) + (x.notes ? '<div class="mut" style="font-size:12px">' + esc(x.notes) + '</div>' : '') + '</td><td class="st ' + (x.approved_by ? "ok" : "wr") + '">' + (x.approved_by ? "aprovada por " + esc(x.approved_by) : "proposta") + '</td></tr>';
    }).join("");
    $("view").innerHTML = '<section class="card"><h2>' + r.rules.length + ' regras · ' + pend + ' aguardando aprovação</h2><div class="scroll"><table><thead><tr><th>Regra</th><th>Esfera</th><th>Prazo</th><th>Fundamento</th><th>Situação</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="empty">Calendário: fins de semana e feriados nacionais. Na dúvida a IARIS usa a data mais cedo: dia só sem expediente bancário (Carnaval, Paixão, Corpus Christi) antecipa, mas não prorroga. Feriados municipais ainda não entram.</div>' +
      (pend ? '<div style="margin-top:14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><button class="warn" data-act="rules">Aprovar ' + pend + ' regra(s)</button><span class="mut">Confira prazos e fundamentos antes de aprovar. A aprovação fica na auditoria em seu nome e completa os mapas das empresas.</span></div>' : '') + '</section>' +
      simplesRulesHtml(sr.rules);
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
    if (b.dataset.act === "srules") {
      if (!window.confirm("Aprovar as tabelas do Simples Nacional propostas?\\n\\nConfira alíquotas, parcelas a deduzir e repartição com a LC 123. A aprovação fica registrada na auditoria em seu nome.")) return;
      b.disabled = true;
      post("/api/simples/regras/aprovar", "aprovar").then(function (r) { toast(r.approved.length + " tabela(s) aprovada(s). As empresas foram recalculadas pelo agente Tributos."); }).catch(function (err) { toast(err.message); b.disabled = false; }).then(route);
    }
    if (b.dataset.act === "urevoke") {
      var ur = window._users[Number(b.dataset.i)];
      var why = window.prompt("Revogar o acesso de " + ur.name + "? Escreva o motivo (fica na auditoria).");
      if (why === null) return;
      b.disabled = true;
      post("/api/usuarios/revogar", "usuarios", { email: ur.email, reason: why }).then(function () { toast("Acesso de " + ur.name + " revogado; sessões encerradas."); }).catch(function (err) { toast(err.message); }).then(route);
    }
    if (b.dataset.act === "ulinkgen") {
      var ul = window._users[Number(b.dataset.i)];
      if (!window.confirm("Gerar link de acesso para " + ul.name + "? Quem abrir o link entra como " + ul.name + ", sem senha e sem código. Um link anterior deixa de valer.")) return;
      accessLink({ name: ul.name, email: ul.email, role: ul.role || "LEITURA" });
    }
    if (b.dataset.act === "ureinv") {
      var ui = window._users[Number(b.dataset.i)];
      if (!window.confirm("Gerar um convite novo para " + ui.name + "? O link anterior deixa de valer.")) return;
      invite({ name: ui.name, email: ui.email, role: ui.role || "LEITURA" });
    }
    if (b.dataset.act === "incluir") {
      var cn = $("inc-cnpj").value.trim();
      if (!cn) { toast("Informe o CNPJ."); return; }
      var srp = $("inc-serpro").checked;
      if (srp && !window.confirm("A conferência no SERPRO é consulta cobrada (conta no limite diário). Confirmar?")) return;
      b.disabled = true; b.textContent = "Incluindo…";
      post("/api/empresas", "confirmar", { cnpj: cn, serpro: srp }).then(function (r) {
        var nPend = r.pending.length;
        toast((r.name || "Empresa") + (r.created ? " incluída." : " já estava cadastrada.") + (nPend ? " " + nPend + " pendência(s); informe serviços e início na Fila humana." : ""));
        location.hash = nPend ? "#/fila" : "#/empresa/" + r.entityId;
      }).catch(function (err) { toast(err.message); b.disabled = false; b.textContent = "Incluir"; });
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
    if (b.dataset.act === "decl") {
      var pa = $("decl-pa").value;
      if (!pa) { toast("Escolha o PA."); return; }
      if (!window.confirm("Buscar a última declaração do PA " + mm(pa + "-01") + "?\\n\\nIsso faz 1 consulta cobrada pelo SERPRO. O PDF fica guardado e não precisa ser buscado de novo.")) return;
      b.disabled = true;
      post("/api/empresa/" + id + "/competencia/" + pa + "/declaracao", "buscar").then(function (r) {
        toast(r.found ? "Declaração lida: " + r.months + " mês(es) de receita." : "Não há declaração transmitida nesse PA.");
      }).catch(function (err) { toast(err.message); }).then(function () { b.disabled = false; return loadCentral(); }).then(function () { loadSimples(id); return loadConferencia(id); });
    }
    if (b.dataset.act === "exc") {
      var dec = b.dataset.dec, note = null;
      if (dec === "ADIAR") {
        if (!window.confirm("Deixar esta exceção para revisão posterior?\\n\\nEla sai da Fila humana, continua aberta e registrada, e nada é transmitido.")) return;
      } else if (dec === "MANTER") {
        note = window.prompt("Por que manter a declaração como está? (fica na auditoria)");
        if (!note || note.trim().length < 5) { toast("Escreva a justificativa (mínimo 5 caracteres)."); return; }
      } else if (!window.confirm("Registrar que o escritório vai retificar o PGDAS-D desta competência?\\n\\nA exceção fica aguardando a declaração retificada e fecha sozinha quando a conferência bater (use Buscar declaração depois de transmitir).")) return;
      b.disabled = true;
      post("/api/excecao/" + id + "/decidir", "aprovar", { decision: dec, note: note }).then(function () { toast(dec === "RETIFICAR" ? "Registrado: aguardando a declaração retificada." : dec === "ADIAR" ? "Movida para revisão posterior." : "Registrado: diferença mantida com justificativa."); })
        .catch(function (err) { toast(err.message); b.disabled = false; }).then(function () { return loadCentral(); }).then(route);
    }
    if (b.dataset.act === "xmlup") {
      uploadXml($("xmlfiles").files, (location.hash.split("/")[2] || null));
    }
    if (b.dataset.act === "nfse") {
      b.disabled = true;
      toast("Buscando NFS-e no Sistema Nacional…");
      post("/api/empresa/" + id + "/nfse/buscar", "buscar-notas").then(function (r) {
        toast(r.outcome === "aguardando" ? "Próxima busca a partir de " + hm(r.nextAllowedAt) + "." : r.outcome === "sem_certificado" ? "Sem certificado utilizável no cofre." : r.outcome === "erro" ? "Falha: " + r.message : r.documents + " NFS-e/evento(s) novo(s) em " + r.calls + " lote(s).");
      }).catch(function (err) { toast(err.message); }).then(route);
    }
    if (b.dataset.act === "nsu") {
      var v = $("nsu-" + id).value.trim();
      if (!/^[0-9]{1,15}$/.test(v)) { toast("NSU deve ter só números."); return; }
      if (!window.confirm("Continuar a busca deste CNPJ a partir do NSU " + v + "?\\n\\nNotas com NSU menor não serão baixadas pela IARIS. A decisão fica na auditoria em seu nome.")) return;
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

var ROUTES = { usuarios: viewUsuarios, vinculos: viewVinculos, departamentos: viewDepartamentos, depto: viewDepto, documentos: viewDocumentos, central: viewCentral, fila: viewFila, cases: viewCases, processos: viewProcessos, receita: viewReceita, empresas: viewEmpresas, empresa: viewEmpresa, regras: viewRegras };
function route() {
  var parts = location.hash.replace(/^#\\/?/, "").split("/");
  var r = parts[0] || "central";
  if (!ROUTES[r]) r = "central";
  var navR = r === "empresa" ? "empresas" : r === "depto" ? "depto-" + parts[1] : r;
  Array.prototype.forEach.call(document.querySelectorAll(".nav[data-r]"), function (a) { a.classList.toggle("on", a.dataset.r === navR); });
  return ROUTES[r](parts[1]).catch(function (err) { toast(err.message); });
}
window.addEventListener("hashchange", route);
$("sair").addEventListener("click", function () { post("/api/sair", "sair").catch(function () {}).then(function () { location.replace("/"); }); });
getJson("/api/sessao").then(function (me) {
  me.permissions.forEach(function (p) { document.body.classList.add("p-" + p); });
  $("me").textContent = me.name + " · " + me.roleLabel;
  $("me").title = me.email;
  route();
}).catch(function (err) { toast(err.message); });
getJson("/api/departamentos").then(paintDeptDots).catch(function () {});
</script>
</body>
</html>`;
