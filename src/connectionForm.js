// Add/Edit Connection form: one webview with every field, instead of a chain of input boxes.
// Saved passwords are never sent to the webview; an empty password field keeps the saved one.
const vscode = require("vscode");
const crypto = require("crypto");
const { TYPES, createAdapter } = require("./adapters");
const { readOnly } = require("./connections");

const forms = new Map(); // connection id (or "new") -> ConnectionForm

class ConnectionForm {
  static show(manager, existing) {
    const key = existing ? existing.id : "new";
    const open = forms.get(key);
    if (open) return open.panel.reveal();
    forms.set(key, new ConnectionForm(manager, existing, key));
  }

  constructor(manager, existing, key) {
    this.manager = manager;
    this.existing = existing;
    this.panel = vscode.window.createWebviewPanel(
      "dbViewer.connectionForm",
      existing ? `Edit ${existing.name}` : "Add Connection",
      vscode.ViewColumn.Active,
      { enableScripts: true }
    );
    this.panel.webview.html = html(crypto.randomBytes(16).toString("base64"), this.panel.webview.cspSource, existing);
    this.panel.onDidDispose(() => forms.delete(key));
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
  }

  async onMessage(m) {
    if (m.type === "cancel") return this.panel.dispose();
    if (m.type !== "test" && m.type !== "save") return;
    let step = "";
    try {
      const { cfg, secret } = buildConfig(this.existing, m.form || {});
      if (m.type === "test") {
        step = "Connection failed";
        this.post("busy", "Testing…");
        const saved = this.existing ? await this.manager.getSecret(this.existing.id) : "";
        const a = createAdapter(cfg, secret !== undefined ? secret : saved || "", { readOnly: readOnly(cfg) });
        await a.connect();
        await a.close().catch(() => {});
        return this.post("ok", "Connection OK.");
      }
      step = "Couldn't save";
      this.post("busy", "Connecting…");
      const saved = await this.manager.save(cfg, secret);
      // Later saves from this form update the same connection.
      this.existing = saved;
      step = "Saved, but couldn't connect";
      await this.manager.adapter(saved.id);
      vscode.window.showInformationMessage(`db-adapters: connected to ${saved.name}.`);
      this.panel.dispose();
    } catch (err) {
      this.post("error", step ? `${step}: ${err.message}` : err.message);
    }
  }

  post(type, text) {
    this.panel.webview.postMessage({ type, text });
  }
}

// Build the saved config from the form fields. The webview is untrusted input.
function buildConfig(existing, f) {
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const type = existing ? existing.type : str(f.type);
  const t = TYPES[type];
  if (!t) throw new Error("Choose a database type.");
  const cfg = existing ? { ...existing } : { type };
  let secret;

  if (type === "mongo") {
    const uri = str(f.uri);
    if (uri) {
      const parsed = parseMongoUri(uri);
      cfg.hostLabel = parsed.hostLabel;
      cfg.database = parsed.database;
      secret = uri;
    } else if (!existing) {
      throw new Error("Connection string is required.");
    }
  } else {
    cfg.host = str(f.host);
    if (!cfg.host) throw new Error("Host is required.");
    const port = Number(str(f.port) || t.defaultPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter a port number (1-65535).");
    cfg.port = port;
    cfg.database = str(f.database) || t.defaultDatabase;
    cfg.user = str(f.user);
    // Passwords aren't trimmed: spaces can be part of them.
    const pw = typeof f.password === "string" ? f.password : "";
    if (pw || !existing) secret = pw;
    if (type === "postgres" || type === "mysql") {
      cfg.ssl = f.ssl === true;
      cfg.trustServerCertificate = false;
    }
    if (type === "mssql") {
      const enc = ["trust", "verify", "none"].includes(f.encryption) ? f.encryption : "trust";
      cfg.ssl = enc !== "none";
      cfg.trustServerCertificate = enc === "trust";
    }
  }

  cfg.readOnly = f.readOnly === "true" ? true : f.readOnly === "false" ? false : undefined;
  const dbAtHost = cfg.database ? `${cfg.database}@${cfg.host}` : cfg.host;
  cfg.name = str(f.name) || (type === "mongo" ? cfg.hostLabel : dbAtHost);
  return { cfg, secret };
}

// Keep only non-secret parts for display; the full URI goes to SecretStorage.
function parseMongoUri(uri) {
  const m = uri.match(/^(mongodb(?:\+srv)?):\/\/(?:[^@/]*@)?([^/?]+)(?:\/([^?]*))?/);
  if (!m) throw new Error("Connection string must start with mongodb:// or mongodb+srv://");
  return { hostLabel: m[2], database: m[3] ? decodeURIComponent(m[3]) : undefined };
}

function html(nonce, cspSource, existing) {
  const types = Object.fromEntries(
    Object.entries(TYPES).map(([k, t]) => [
      k,
      { label: t.label, defaultPort: t.defaultPort, databaseLabel: t.databaseLabel, defaultDatabase: t.defaultDatabase },
    ])
  );
  const e = existing || {};
  const initial = {
    editing: !!existing,
    type: e.type || "postgres",
    name: e.name || "",
    host: e.host || "localhost",
    port: e.port ? String(e.port) : "",
    database: e.database || "",
    user: e.user || "",
    ssl: !!e.ssl,
    encryption: e.ssl === false ? "none" : e.trustServerCertificate === false ? "verify" : "trust",
    readOnly: e.readOnly === true ? "true" : e.readOnly === false ? "false" : "",
    hostLabel: e.hostLabel || "",
  };
  // "<" is escaped so the data can't close the <script> tag.
  const data = JSON.stringify({ types, initial }).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 16px 20px; }
  form { max-width: 560px; display: grid; grid-template-columns: 150px 1fr; gap: 10px 12px; align-items: center; }
  h2 { grid-column: 1 / -1; margin: 0 0 6px; font-weight: 600; }
  label { opacity: .9; }
  input, select { box-sizing: border-box; width: 100%; padding: 4px 6px; font: inherit;
                  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
                  border: 1px solid var(--vscode-input-border, transparent); }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
  input[type=checkbox] { width: auto; }
  select:disabled { opacity: .6; }
  .hint { grid-column: 2; margin-top: -6px; font-size: .9em; opacity: .7; }
  .row { display: contents; }
  .hidden { display: none; }
  .actions { grid-column: 2; display: flex; gap: 8px; margin-top: 8px; }
  button { padding: 5px 14px; border: none; cursor: pointer; font: inherit;
           background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:disabled { opacity: .5; cursor: default; }
  #status { grid-column: 2; white-space: pre-wrap; min-height: 1.4em; }
  #status.error { color: var(--vscode-errorForeground); }
  #status.ok { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
</style>
</head>
<body>
<form id="form" autocomplete="off">
  <h2 id="title"></h2>

  <label for="type">Database type</label>
  <select id="type"></select>

  <label for="name">Connection name</label>
  <input id="name" placeholder="(default: database@host)">

  <div class="row" data-for="mongo">
    <label for="uri">Connection string</label>
    <input id="uri" type="password" placeholder="mongodb://user:password@localhost:27017/?authSource=admin">
    <div class="hint" id="uriHint">Stored in VS Code SecretStorage.</div>
  </div>

  <div class="row" data-for="sql">
    <label for="host">Host</label>
    <input id="host">
    <label for="port">Port</label>
    <input id="port" inputmode="numeric">
    <label for="database" id="databaseLabel">Database</label>
    <input id="database">
    <label for="user">User</label>
    <input id="user">
    <label for="password">Password</label>
    <input id="password" type="password">
  </div>

  <div class="row" data-for="postgres mysql">
    <label for="ssl">SSL</label>
    <div><input id="ssl" type="checkbox"> <label for="ssl">Use SSL (don't verify certificate)</label></div>
  </div>

  <div class="row" data-for="mssql">
    <label for="encryption">Encryption</label>
    <select id="encryption">
      <option value="trust">Encrypt, trust server certificate</option>
      <option value="verify">Encrypt, verify certificate</option>
      <option value="none">No encryption</option>
    </select>
  </div>

  <label for="readOnly">Access mode</label>
  <select id="readOnly">
    <option value="">Use default setting (dbViewer.readOnly)</option>
    <option value="true">Read-only</option>
    <option value="false">Read-write</option>
  </select>

  <div class="actions">
    <button type="submit" class="primary" id="save">Save &amp; Connect</button>
    <button type="button" id="test">Test Connection</button>
    <button type="button" id="cancel">Cancel</button>
  </div>
  <div id="status"></div>
</form>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const { types, initial } = ${data};
  const $ = (id) => document.getElementById(id);

  for (const [k, t] of Object.entries(types)) $('type').add(new Option(t.label, k));
  $('type').value = initial.type;
  $('type').disabled = initial.editing;
  $('title').textContent = initial.editing ? 'Edit connection' : 'Add connection';
  for (const id of ['name', 'host', 'port', 'database', 'user', 'encryption', 'readOnly']) $(id).value = initial[id];
  $('ssl').checked = initial.ssl;
  if (initial.editing) {
    $('password').placeholder = 'Leave empty to keep the saved password';
    $('uri').placeholder = 'Leave empty to keep the saved connection string';
    if (initial.hostLabel) $('uriHint').textContent = 'Saved host: ' + initial.hostLabel + '. Stored in VS Code SecretStorage.';
  }

  function update() {
    const type = $('type').value;
    const t = types[type];
    for (const el of document.querySelectorAll('[data-for]')) {
      const f = el.dataset.for;
      el.classList.toggle('hidden', !(f.split(' ').includes(type) || (f === 'sql' && type !== 'mongo')));
    }
    if (type !== 'mongo') {
      $('databaseLabel').textContent = t.databaseLabel;
      $('port').placeholder = String(t.defaultPort);
      $('database').placeholder = t.defaultDatabase || '(optional)';
    }
  }
  $('type').onchange = update;
  update();

  function fields() {
    return {
      type: $('type').value, name: $('name').value, uri: $('uri').value, host: $('host').value,
      port: $('port').value, database: $('database').value, user: $('user').value, password: $('password').value,
      ssl: $('ssl').checked, encryption: $('encryption').value, readOnly: $('readOnly').value,
    };
  }

  function setBusy(busy) { for (const id of ['save', 'test']) $(id).disabled = busy; }

  $('form').onsubmit = (e) => { e.preventDefault(); setBusy(true); vscode.postMessage({ type: 'save', form: fields() }); };
  $('test').onclick = () => { setBusy(true); vscode.postMessage({ type: 'test', form: fields() }); };
  $('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });

  window.addEventListener('message', (e) => {
    const m = e.data;
    $('status').textContent = m.text;
    $('status').className = m.type === 'error' ? 'error' : m.type === 'ok' ? 'ok' : '';
    setBusy(m.type === 'busy');
  });

  (initial.editing ? $('name') : $('host')).focus();
</script>
</body>
</html>`;
}

module.exports = { ConnectionForm, buildConfig };
