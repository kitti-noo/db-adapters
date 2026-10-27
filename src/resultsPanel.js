// Result grid webviews. Table views open as editor tabs with Prev/Next paging and
// server-side sort/filter. Query results show in the "Query Results" view in the
// bottom panel and are sorted/filtered in the webview.
const vscode = require("vscode");
const crypto = require("crypto");
const { FILTER_OPS } = require("./adapters/common");
const { exportRows } = require("./export");

const panels = new Map(); // key -> ResultsPanel

// Drives one webview: loads results through `loader` and answers its messages.
class Grid {
  // loader(page, { filters, sort }) -> Promise<{ columns, rows, truncated?, message? }>
  // canceller() stops the statement the loader is running in the database.
  // exportAll(view) writes the whole result to CSV; name is the default file name.
  constructor(webview, prev) {
    this.webview = webview;
    this.loader = prev ? prev.loader : null;
    this.canceller = prev ? prev.canceller : null;
    this.exportAll = prev ? prev.exportAll : null;
    this.name = prev ? prev.name : "";
    this.seq = prev ? prev.seq : 0; // bumped per load/cancel so a stale result is dropped
    this.loading = false;
    this.paged = prev ? prev.paged : false;
    this.page = prev ? prev.page : 0;
    this.view = prev ? prev.view : { filters: {}, sort: null };
    this.last = prev ? prev.last : null;
    webview.html = html(crypto.randomBytes(16).toString("base64"), webview.cspSource);
    webview.onDidReceiveMessage((m) => {
      // A (re)loaded webview asks for the current result.
      if (m.type === "ready" && this.last) webview.postMessage(this.last);
      if (m.type === "page" && this.paged) {
        this.page = Math.max(0, this.page + m.delta);
        this.load();
      }
      if (m.type === "view" && this.paged) {
        this.view = cleanView(m);
        this.page = 0;
        this.load();
      }
      if (m.type === "reload" && this.loader) this.load();
      if (m.type === "cancel") this.cancel();
      if (m.type === "export") this.run(() => exportRows(this.name, cleanStrings(m.columns), cleanRows(m.rows)));
      if (m.type === "exportAll" && this.exportAll) this.run(() => this.exportAll(this.view));
    });
  }

  // Set what the next load() runs.
  set(loader, { paged = false, cancel = null, exportAll = null, name = "" } = {}) {
    this.loader = loader;
    this.paged = paged;
    this.canceller = cancel;
    this.exportAll = exportAll;
    this.name = name;
    this.page = 0;
  }

  async run(fn) {
    try {
      await fn();
    } catch (err) {
      vscode.window.showErrorMessage(`db-adapters: ${err.message}`);
    }
  }

  async load() {
    const page = this.page;
    const seq = ++this.seq;
    this.loading = true;
    this.post({ type: "loading", cancellable: !!this.canceller });
    const started = Date.now();
    try {
      const r = await this.loader(page, this.view);
      if (seq !== this.seq) return;
      this.loading = false;
      this.post({
        type: "result",
        columns: r.columns.map(String),
        rows: r.rows.map((row) => row.map(formatCell)),
        message: r.message,
        truncated: !!r.truncated,
        exportAll: !!this.exportAll,
        paged: this.paged,
        page,
        pageSize: r.pageSize,
        view: this.view,
        ms: Date.now() - started,
      });
    } catch (err) {
      if (seq !== this.seq) return;
      this.loading = false;
      this.post({ type: "error", message: err.message });
    }
  }

  // Show the run as cancelled right away; the database stops it in the background.
  async cancel() {
    if (!this.loading || !this.canceller) return;
    this.seq++;
    this.loading = false;
    this.post({ type: "cancelled" });
    try {
      await this.canceller();
    } catch (err) {
      vscode.window.showErrorMessage(`db-adapters: Cancel failed: ${err.message}`);
    }
  }

  post(msg) {
    if (msg.type !== "loading") this.last = msg;
    this.webview.postMessage(msg);
  }
}

// A table opened from the tree, shown as an editor tab.
class ResultsPanel {
  static show(key, title, loader, options) {
    let p = panels.get(key);
    if (p) {
      p.panel.title = title;
      p.panel.reveal(undefined, true);
    } else {
      p = new ResultsPanel(key, title);
      panels.set(key, p);
    }
    p.grid.set(loader, options);
    return p.grid.load();
  }

  constructor(key, title) {
    this.panel = vscode.window.createWebviewPanel("dbViewer.results", title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.grid = new Grid(this.panel.webview);
    this.panel.onDidDispose(() => panels.delete(key));
  }
}

// "Query Results" view in the bottom panel; shows the last query that ran.
class QueryResultsView {
  constructor() {
    this.grid = null;
    this.view = null;
    this._waitForView();
  }

  _waitForView() {
    this.ready = new Promise((resolve) => (this._resolveReady = resolve));
  }

  resolveWebviewView(view) {
    view.webview.options = { enableScripts: true };
    this.grid = new Grid(view.webview, this.grid);
    this.view = view;
    view.onDidDispose(() => {
      this.view = null;
      this._waitForView();
    });
    this._resolveReady();
  }

  // Reveal the view without leaving `editor`, then run `loader` into it.
  // options: { cancel, exportAll, name } (see Grid).
  async show(title, loader, editor, options) {
    if (this.view) {
      this.view.show(true);
    } else {
      // The view is created on first reveal, which also moves focus to it.
      await vscode.commands.executeCommand(`${QueryResultsView.id}.focus`);
      await this.ready;
      if (editor) await vscode.window.showTextDocument(editor.document, editor.viewColumn);
    }
    this.view.description = title;
    this.grid.set(loader, { ...options, paged: false });
    return this.grid.load();
  }
}
QueryResultsView.id = "dbViewer.queryResults";

// The webview is untrusted input: keep only string column names, known
// operators and string values. Adapters quote column names and bind values.
function cleanView(m) {
  const filters = {};
  for (const [k, f] of Object.entries(m.filters || {})) {
    if (!f || !FILTER_OPS.includes(f.op)) continue;
    const value = typeof f.value === "string" ? f.value : "";
    if (f.op === "null" || f.op === "notnull" || value !== "") filters[String(k)] = { op: f.op, value };
  }
  const s = m.sort;
  const sort = s && typeof s.col === "string" ? { col: s.col, dir: s.dir === "desc" ? "desc" : "asc" } : null;
  return { filters, sort };
}

// Rows the webview sends back for export: keep strings, numbers and booleans;
// anything else is a NULL / missing marker (see formatCell).
function cleanRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(Array.isArray).map((r) => r.map((v) => (["string", "number", "boolean"].includes(typeof v) ? v : null)));
}

function cleanStrings(a) {
  return Array.isArray(a) ? a.map(String) : [];
}

// Make every cell JSON-safe and readable. null/undefined stay distinguishable.
function formatCell(v) {
  if (v === null) return { n: true };
  if (v === undefined) return { u: true };
  if (v instanceof Date) return isNaN(v) ? String(v) : v.toISOString();
  if (Buffer.isBuffer(v)) {
    const hex = v.subarray(0, 64).toString("hex");
    return `0x${hex}${v.length > 64 ? `… (${v.length} bytes)` : ""}`;
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return v;
}

function html(nonce, cspSource) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { padding: 0; margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  .bar { position: sticky; top: 0; z-index: 2; display: flex; gap: 8px; align-items: center; padding: 6px 10px;
         background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
  .bar .status { flex: 1; opacity: .8; }
  .bar input { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
               border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; width: 200px; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
           border: none; padding: 3px 10px; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: .4; cursor: default; }
  button[hidden] { display: none; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .wrap { overflow: auto; height: calc(100vh - 38px); }
  table { border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 3px 8px; text-align: left; white-space: nowrap;
           max-width: 480px; overflow: hidden; text-overflow: ellipsis; vertical-align: top; }
  thead { position: sticky; top: 0; z-index: 1; }
  th { background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { background: var(--vscode-list-hoverBackground); }
  tr.filters th { padding: 2px; }
  tr.filters .f { display: flex; gap: 2px; }
  tr.filters select, tr.filters input { box-sizing: border-box; background: var(--vscode-input-background);
                     color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
                     padding: 2px 4px; font: inherit; }
  tr.filters select { flex: none; max-width: 76px; padding: 2px 0; }
  tr.filters input { flex: 1; width: 100%; min-width: 60px; }
  tr.filters input:disabled { opacity: .4; }
  td.rn, th.rn { opacity: .5; text-align: right; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  td.null { opacity: .45; font-style: italic; }
  .msg { padding: 12px; }
  .error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
</style>
</head>
<body>
  <div class="bar">
    <button id="prev" title="Previous page">◀</button>
    <button id="next" title="Next page">▶</button>
    <span class="status" id="status">Loading…</span>
    <button id="cancel" class="primary" title="Cancel the running query" hidden>Cancel</button>
    <input id="filter" placeholder="Search rows">
    <button id="clear" title="Clear sort and filters">Clear</button>
    <button id="reload" title="Reload">⟳</button>
    <button id="export" title="Save the rows shown here as CSV" hidden>Export</button>
    <button id="exportAll" title="Run again and save every row as CSV" hidden>Export all</button>
  </div>
  <div class="wrap" id="wrap"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let last = null;
  // Table view: sort/filters run in the database. Query result: sort/filters run here.
  let view = { filters: {}, sort: null };
  let local = { filters: {}, sort: null };
  let focusCol = null;
  let shown = []; // rows on screen after search/filter/sort, for Export

  const OPS = [['contains', 'contains'], ['=', '='], ['!=', '≠'], ['>', '>'], ['>=', '≥'], ['<', '<'], ['<=', '≤'],
               ['like', 'like'], ['notlike', 'not like'], ['null', 'is null'], ['notnull', 'not null']];
  const NO_VALUE = ['null', 'notnull'];

  $('prev').onclick = () => vscode.postMessage({ type: 'page', delta: -1 });
  $('next').onclick = () => vscode.postMessage({ type: 'page', delta: 1 });
  $('reload').onclick = () => vscode.postMessage({ type: 'reload' });
  $('export').onclick = () => last && vscode.postMessage({ type: 'export', columns: last.columns, rows: shown });
  $('exportAll').onclick = () => vscode.postMessage({ type: 'exportAll' });
  $('cancel').onclick = () => { $('cancel').disabled = true; vscode.postMessage({ type: 'cancel' }); };
  $('filter').oninput = () => last && render(last);
  $('clear').onclick = () => {
    focusCol = null;
    $('filter').value = '';
    apply({ filters: {}, sort: null });
  };

  function state() { return last && last.paged ? view : local; }

  function apply(v) {
    if (last && last.paged) { view = v; vscode.postMessage({ type: 'view', filters: v.filters, sort: v.sort }); }
    else { local = v; if (last) render(last); }
  }

  function nextSort(cur, col) {
    if (!cur || cur.col !== col) return { col, dir: 'asc' };
    return cur.dir === 'asc' ? { col, dir: 'desc' } : null;
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    $('cancel').hidden = !(m.type === 'loading' && m.cancellable);
    $('cancel').disabled = false;
    if (m.type !== 'result') $('export').hidden = $('exportAll').hidden = true;
    if (m.type === 'loading') { $('status').textContent = 'Loading…'; setPaging(false, false); }
    if (m.type === 'cancelled') {
      // Same as an error: a table view keeps its grid, a query result is cleared.
      if (last && last.paged) render(last);
      else {
        last = null;
        const div = document.createElement('div');
        div.className = 'msg';
        div.textContent = 'Query cancelled.';
        $('wrap').replaceChildren(div);
      }
      $('status').textContent = 'Cancelled';
    }
    if (m.type === 'error') {
      $('status').textContent = 'Error';
      const div = document.createElement('div');
      div.className = 'msg error';
      div.textContent = m.message;
      // Keep the grid of a table view so a bad filter can be fixed.
      if (last && last.paged) { render(last); $('status').textContent = 'Error'; $('wrap').prepend(div); }
      else { last = null; $('wrap').replaceChildren(div); }
    }
    if (m.type === 'result') {
      // Keep sort/filters across reloads, but not for a result with other columns.
      if (!m.paged && (!last || JSON.stringify(last.columns) !== JSON.stringify(m.columns))) local = { filters: {}, sort: null };
      last = m;
      if (m.view) view = m.view;
      render(m);
    }
  });

  function setPaging(prev, next) { $('prev').disabled = !prev; $('next').disabled = !next; }

  function isNull(v) { return !!v && typeof v === 'object'; }

  function cellText(v) { return isNull(v) ? (v.n ? 'NULL' : '') : String(v); }

  // Numbers (or numeric text) numerically, everything else as text.
  function compareValues(a, b) {
    const na = Number(a), nb = Number(b);
    if (String(a).trim() !== '' && String(b).trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }

  // NULL/missing last.
  function compareCells(a, b) {
    if (isNull(a) || isNull(b)) return isNull(a) === isNull(b) ? 0 : isNull(a) ? 1 : -1;
    return compareValues(a, b);
  }

  const REGEX_SPECIAL = '.*+?^$()[]{}|\\\\';
  function likeRegex(pattern) {
    let src = '';
    for (const ch of pattern) {
      src += ch === '%' ? '[\\\\s\\\\S]*' : ch === '_' ? '[\\\\s\\\\S]' : REGEX_SPECIAL.includes(ch) ? '\\\\' + ch : ch;
    }
    return new RegExp('^' + src + '$');
  }

  function matches(v, f) {
    if (f.op === 'null') return isNull(v);
    if (f.op === 'notnull') return !isNull(v);
    if (isNull(v)) return false;
    const s = String(v);
    if (f.op === 'contains') return s.toLowerCase().includes(f.value.toLowerCase());
    if (f.op === 'like') return likeRegex(f.value).test(s);
    if (f.op === 'notlike') return !likeRegex(f.value).test(s);
    const c = compareValues(s, f.value);
    return { '=': c === 0, '!=': c !== 0, '>': c > 0, '>=': c >= 0, '<': c < 0, '<=': c <= 0 }[f.op];
  }

  function filterRow(m, st) {
    const fr = document.createElement('tr');
    fr.className = 'filters';
    const blank = document.createElement('th'); blank.className = 'rn'; fr.appendChild(blank);
    const collect = () => {
      const filters = {};
      for (const cell of fr.querySelectorAll('.f')) {
        const op = cell.querySelector('select').value;
        const value = cell.querySelector('input').value.trim();
        if (NO_VALUE.includes(op) || value) filters[cell.dataset.col] = { op, value: NO_VALUE.includes(op) ? '' : value };
      }
      return filters;
    };
    for (const c of m.columns) {
      const th = document.createElement('th');
      const cell = document.createElement('div');
      cell.className = 'f';
      cell.dataset.col = c;
      const cur = st.filters[c] || { op: 'contains', value: '' };
      const select = document.createElement('select');
      for (const [op, label] of OPS) select.add(new Option(label, op, false, op === cur.op));
      select.title = 'Operator';
      const input = document.createElement('input');
      input.value = cur.value || '';
      input.placeholder = 'filter';
      input.title = 'Press Enter to apply. like / not like: % = any text, _ = one character';
      input.disabled = NO_VALUE.includes(cur.op);
      input.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        focusCol = c;
        apply({ filters: collect(), sort: state().sort });
      };
      select.onchange = () => {
        input.disabled = NO_VALUE.includes(select.value);
        focusCol = input.disabled ? null : c;
        // Apply right away unless there's nothing to compare against yet.
        if (input.disabled || input.value.trim() || st.filters[c]) apply({ filters: collect(), sort: state().sort });
        else input.focus();
      };
      cell.append(select, input);
      th.appendChild(cell);
      fr.appendChild(th);
    }
    return fr;
  }

  function render(m) {
    const paged = m.paged;
    $('prev').style.display = $('next').style.display = paged ? '' : 'none';
    $('filter').style.display = paged ? 'none' : '';
    if (paged) setPaging(m.page > 0, m.rows.length >= m.pageSize);
    $('export').hidden = !m.columns.length;
    $('exportAll').hidden = !m.columns.length || !m.exportAll;

    if (!m.columns.length) {
      $('status').textContent = (m.message || 'OK') + ' · ' + m.ms + ' ms';
      const div = document.createElement('div');
      div.className = 'msg';
      div.textContent = m.message || 'Statement executed.';
      $('wrap').replaceChildren(div);
      return;
    }

    const st = paged ? view : local;
    const q = paged ? '' : $('filter').value.trim().toLowerCase();
    let rows = m.rows.map((r, i) => ({ r, i }));
    if (!paged) {
      if (q) rows = rows.filter(({ r }) => r.some((v) => cellText(v).toLowerCase().includes(q)));
      for (const [col, f] of Object.entries(st.filters)) {
        const ci = m.columns.indexOf(col);
        if (ci >= 0) rows = rows.filter(({ r }) => matches(r[ci], f));
      }
      if (st.sort) {
        const ci = m.columns.indexOf(st.sort.col);
        if (ci >= 0) rows.sort((x, y) => compareCells(x.r[ci], y.r[ci]) * (st.sort.dir === 'desc' ? -1 : 1));
      }
    }
    const base = paged ? m.page * m.pageSize : 0;
    shown = rows.map(({ r }) => r);

    const table = document.createElement('table');
    const thead = table.createTHead();
    const head = thead.insertRow();
    const rn = document.createElement('th'); rn.className = 'rn'; rn.textContent = '#'; head.appendChild(rn);
    for (const c of m.columns) {
      const th = document.createElement('th');
      th.className = 'sortable';
      th.textContent = c + (st.sort && st.sort.col === c ? (st.sort.dir === 'desc' ? ' ▼' : ' ▲') : '');
      th.title = 'Sort by ' + c;
      th.onclick = () => apply({ filters: st.filters, sort: nextSort(st.sort, c) });
      head.appendChild(th);
    }
    thead.appendChild(filterRow(m, st));
    const body = table.createTBody();
    rows.forEach(({ r, i }) => {
      const tr = body.insertRow();
      const n = tr.insertCell(); n.className = 'rn'; n.textContent = base + i + 1;
      for (const v of r) {
        const td = tr.insertCell();
        const t = cellText(v);
        td.textContent = t;
        td.title = t;
        if (isNull(v)) td.className = 'null';
      }
    });
    $('wrap').replaceChildren(table);
    if (focusCol !== null) {
      const cell = [...table.querySelectorAll('tr.filters .f')].find((x) => x.dataset.col === focusCol);
      const el = cell && cell.querySelector('input');
      if (el && !el.disabled) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }

    let s = paged
      ? 'Rows ' + (m.rows.length ? base + 1 : 0) + '–' + (base + m.rows.length) + ' · page ' + (m.page + 1)
      : m.rows.length + ' row(s)' + (m.truncated ? ' (truncated, see dbViewer.maxRows)' : '');
    const nf = Object.keys(st.filters).length;
    if (!paged && (q || nf)) s += ' · ' + rows.length + ' shown';
    if (nf) s += ' · ' + nf + ' filter(s)';
    $('status').textContent = s + ' · ' + m.ms + ' ms';
  }

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

module.exports = { ResultsPanel, QueryResultsView, formatCell };
