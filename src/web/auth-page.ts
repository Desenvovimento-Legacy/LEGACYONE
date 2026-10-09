/**
 * Tela de entrada da IARIS: login (e-mail + senha + código do autenticador, se ligado) e
 * primeiro acesso por convite (/convite#t=TOKEN). O token fica no fragmento
 * (#), que o navegador não envia em requisições nem em Referer, e é retirado
 * do endereço assim que lido.
 * Atenção: o script vive dentro de um template literal — não use crase nem
 * cifrão-chave nele.
 */
export const AUTH_HTML = /* html */ `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>IARIS — Entrar</title>
<style>
  :root { --bg: #F3F6F9; --panel: #FFFFFF; --line: #E2E8F0; --ink: #0F172A; --muted: #64748B; --teal: #0F9D8F; --teal-ink: #0B7A6F; --teal-bg: #E7F7F4; --red: #B91C1C; --field: #F8FAFC; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px; background: var(--bg); color: var(--ink); font: 14px/1.45 "Segoe UI", system-ui, -apple-system, sans-serif; }
  .box { width: 100%; max-width: 420px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 28px 26px; box-shadow: 0 1px 3px rgba(15, 23, 42, .06); }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
  .brand b { font-size: 24px; letter-spacing: .1em; color: var(--ink); display: block; }
  .brand small { color: var(--muted); font-size: 11px; }
  h1 { font-size: 17px; margin: 0 0 4px; } p.sub { margin: 0 0 18px; color: var(--muted); font-size: 13px; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 14px 0 5px; }
  input { width: 100%; font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--field); color: var(--ink); }
  input:focus { outline: 2px solid var(--teal); outline-offset: 1px; }
  input.code { letter-spacing: .4em; font-size: 20px; text-align: center; font-family: Consolas, ui-monospace, monospace; }
  button { width: 100%; margin-top: 20px; font: inherit; font-weight: 700; padding: 11px 14px; border-radius: 8px; border: 0; background: var(--teal); color: #fff; cursor: pointer; }
  button:hover { background: var(--teal-ink); }
  button[disabled] { opacity: .5; cursor: wait; }
  .err { color: var(--red); margin-top: 14px; min-height: 1em; font-size: 13px; }
  .ok { color: var(--teal-ink); background: var(--teal-bg); padding: 8px 10px; border-radius: 8px; }
  .qr { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 10px; width: 200px; margin: 6px auto 8px; }
  .qr svg { display: block; width: 100%; height: auto; }
  .key { font-family: Consolas, ui-monospace, monospace; font-size: 13px; text-align: center; color: var(--ink); word-break: break-all; }
  ol { padding-left: 18px; color: var(--muted); font-size: 13px; margin: 0 0 6px; } ol li { margin: 4px 0; }
  .foot { margin-top: 18px; font-size: 11px; color: var(--muted); text-align: center; }
</style>
</head>
<body>
<main class="box">
  <div class="brand">
    <svg width="34" height="34" viewBox="0 0 30 30" fill="none" stroke="#0F9D8F" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="9" r="2.2"></circle><circle cx="21" cy="7" r="2.2"></circle><circle cx="15" cy="16" r="2.2"></circle><circle cx="23" cy="20" r="2.2"></circle><circle cx="9" cy="22" r="2.2"></circle><path d="M10 10l3.5 4.5M19.5 8.5L16 14M17 17l4.5 2M13.2 17.5L10.5 20.5M15 18.2V27"></path></svg>
    <div><b>IARIS</b><small>Inteligência Artificial para Resultados, Integração e Soluções</small></div>
  </div>
  <div id="view"></div>
  <div class="foot">Acesso registrado na auditoria.</div>
</main>
<script>
var $ = function (id) { return document.getElementById(id); };
var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
function post(u, action, body) {
  return fetch(u, { method: "POST", headers: { "X-IARIS-Acao": action, "content-type": "application/json" }, body: JSON.stringify(body || {}) })
    .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.erro || "Falha (" + r.status + ")"); return b; }); });
}
function busy(form, on) { var b = form.querySelector("button"); b.disabled = on; }

function viewLogin(msg) {
  $("view").innerHTML = '<p class="sub">Carregando…</p>';
  fetch("/api/login/dispositivo", { cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return { confiavel: false, duasEtapas: true }; }).then(function (d) {
    var noCode = Boolean(d && d.duasEtapas === false);
    var trusted = noCode || Boolean(d && d.confiavel);
    $("view").innerHTML = '<h1>Entrar</h1><p class="sub">' + (noCode ? 'Use o e-mail e a senha.' : trusted ? 'Este computador está liberado: basta o e-mail e a senha.' : 'Use o e-mail, a senha e o código de 6 dígitos do aplicativo autenticador.') + '</p>' +
      (msg ? '<p class="ok">' + esc(msg) + '</p>' : '') +
      '<form id="f" autocomplete="on"><label for="email">E-mail</label><input id="email" type="email" autocomplete="username" required>' +
      '<label for="pw">Senha</label><input id="pw" type="password" autocomplete="current-password" required>' +
      (trusted ? '' :
        '<label for="code">Código do autenticador</label><input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>' +
        '<label style="display:flex;gap:8px;align-items:center;font-weight:400;margin-top:10px"><input type="checkbox" id="trust" style="width:auto;margin:0"> Confiar neste computador por 30 dias (só no seu computador)</label>') +
      '<button type="submit">Entrar</button><div class="err" id="err" role="alert"></div></form>' +
      (trusted && !noCode ? '<p class="sub" style="margin-top:14px"><a href="#" id="forget">Não é seu computador? Voltar a pedir o código aqui</a></p>' : '');
    $("email").focus();
    var fg = $("forget");
    if (fg) fg.addEventListener("click", function (ev) { ev.preventDefault(); post("/api/login/esquecer", "login", {}).then(function () { viewLogin("Pronto: este computador volta a pedir o código."); }); });
    $("f").addEventListener("submit", function (ev) {
      ev.preventDefault(); var f = ev.target; busy(f, true); $("err").textContent = "";
      var body = { email: $("email").value, password: $("pw").value, code: $("code") ? $("code").value : "", confiar: Boolean($("trust") && $("trust").checked) };
      post("/api/login", "login", body)
        .then(function () { location.replace("/"); })
        .catch(function (e) { $("err").textContent = e.message; if ($("code")) $("code").value = ""; busy(f, false); });
    });
  });
}

var inviteToken = null;
function viewInvite() {
  var m = /[#&]t=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) { inviteToken = m[1]; history.replaceState(null, "", "/convite"); }
  if (!inviteToken) { $("view").innerHTML = '<h1>Convite</h1><p class="err">Link de convite incompleto. Abra o link exatamente como recebeu.</p>'; return; }
  $("view").innerHTML = '<p class="sub">Abrindo o convite…</p>';
  post("/api/convite/abrir", "convite", { token: inviteToken }).then(function (c) {
    var otp = c.duasEtapas !== false;
    $("view").innerHTML = '<h1>Primeiro acesso</h1><p class="sub">' + esc(c.name) + ' · ' + esc(c.email) + '<br>Perfil: ' + esc(c.roleLabel) + '</p>' +
      (otp ? '<ol><li>Instale um autenticador no celular (Google Authenticator ou Microsoft Authenticator).</li><li>Leia o QR abaixo com o aplicativo.</li><li>Crie a senha e digite o código de 6 dígitos que aparece no aplicativo.</li></ol>' +
        '<div class="qr">' + c.qrSvg + '</div><div class="key">Sem câmera? Digite a chave:<br>' + esc(c.secretBase32) + '</div>' : '<p class="sub">Crie sua senha para entrar.</p>') +
      '<form id="f"><label for="pw">Crie uma senha (mínimo 12 caracteres)</label><input id="pw" type="password" autocomplete="new-password" minlength="12" required>' +
      '<label for="pw2">Repita a senha</label><input id="pw2" type="password" autocomplete="new-password" minlength="12" required>' +
      (otp ? '<label for="code">Código do autenticador</label><input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>' : '') +
      '<button type="submit">Ativar acesso</button><div class="err" id="err" role="alert"></div></form>';
    $("f").addEventListener("submit", function (ev) {
      ev.preventDefault(); var f = ev.target; $("err").textContent = "";
      if ($("pw").value !== $("pw2").value) { $("err").textContent = "As senhas não são iguais."; return; }
      busy(f, true);
      post("/api/convite/ativar", "convite", { token: inviteToken, password: $("pw").value, code: $("code") ? $("code").value : "" })
        .then(function () { inviteToken = null; history.replaceState(null, "", "/"); viewLogin(otp ? "Acesso ativado. Entre com seu e-mail, senha e um código novo do autenticador." : "Acesso ativado. Entre com seu e-mail e senha."); })
        .catch(function (e) { $("err").textContent = e.message; if ($("code")) $("code").value = ""; busy(f, false); });
    });
  }).catch(function (e) { $("view").innerHTML = '<h1>Convite</h1><p class="err">' + esc(e.message) + '</p>'; });
}

if (location.pathname === "/convite") viewInvite(); else viewLogin();
</script>
</body>
</html>`;
