// db-adapters: browse and query PostgreSQL, MySQL / MariaDB, Oracle, MongoDB and SQL Server.
const vscode = require("vscode");
const { TYPES } = require("./src/adapters");
const { assertReadOnlySql, isWriteSql, MONGO_WRITE_OPS, stripLineComments } = require("./src/adapters/common");
const { ConnectionManager, readOnly } = require("./src/connections");
const { ConnectionTree } = require("./src/tree");
const { ResultsPanel, QueryResultsView } = require("./src/resultsPanel");
const { ConnectionForm } = require("./src/connectionForm");
const { exportBatches, BATCH_SIZE } = require("./src/export");

let manager;
let tree;
let queryResults;
const queryDocs = new Map(); // document uri -> connection id
const runLens = new vscode.EventEmitter(); // fires when queryDocs changes

function activate(context) {
  manager = new ConnectionManager(context);
  tree = new ConnectionTree(manager);
  const view = vscode.window.createTreeView("dbViewer.connections", { treeDataProvider: tree, showCollapseAll: true });

  const cmd = (name, fn) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(name, async (...args) => {
        try {
          await fn(...args);
        } catch (err) {
          vscode.window.showErrorMessage(`db-adapters: ${err.message}`);
        }
      })
    );

  cmd("dbViewer.addConnection", () => ConnectionForm.show(manager));
  cmd("dbViewer.editConnection", (node) => ConnectionForm.show(manager, manager.get(node.connId)));
  cmd("dbViewer.removeConnection", async (node) => {
    const cfg = manager.get(node.connId);
    const ok = await vscode.window.showWarningMessage(`Remove connection "${cfg.name}"?`, { modal: true }, "Remove");
    if (ok === "Remove") await manager.remove(cfg.id);
  });
  cmd("dbViewer.disconnect", (node) => manager.disconnect(node.connId));
  cmd("dbViewer.refresh", (node) => tree.refresh(node));
  cmd("dbViewer.openTable", openTable);
  cmd("dbViewer.newQuery", newQuery);
  cmd("dbViewer.runQuery", runQuery);
  cmd("dbViewer.exportQuery", exportQuery);

  queryResults = new QueryResultsView();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(QueryResultsView.id, queryResults, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // "▶ Run" above the first line of every query editor.
    vscode.languages.registerCodeLensProvider([{ scheme: "untitled" }, { scheme: "file" }], {
      onDidChangeCodeLenses: runLens.event,
      provideCodeLenses(doc) {
        const cfg = manager.get(queryDocs.get(doc.uri.toString()));
        if (!cfg) return [];
        const title = `$(play) Run on ${cfg.name}`;
        const top = new vscode.Range(0, 0, 0, 0);
        return [
          new vscode.CodeLens(top, { title, command: "dbViewer.runQuery" }),
          new vscode.CodeLens(top, { title: "$(export) Export CSV", command: "dbViewer.exportQuery" }),
        ];
      },
    }),
    runLens
  );

  const updateContext = () => {
    const ed = vscode.window.activeTextEditor;
    vscode.commands.executeCommand("setContext", "dbViewer.isQueryEditor", !!ed && queryDocs.has(ed.document.uri.toString()));
  };
  context.subscriptions.push(
    view,
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.workspace.onDidCloseTextDocument((doc) => queryDocs.delete(doc.uri.toString())),
    manager.onDidChange(() => runLens.fire()),
    // Read-only is applied at connect time (e.g. Postgres session), so reconnect on change.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("dbViewer.readOnly")) manager.disconnectAll();
    })
  );
}

async function deactivate() {
  if (manager) await manager.disconnectAll();
}

// ---- Data ----------------------------------------------------------------

function openTable(node) {
  const cfg = manager.get(node.connId);
  const pageSize = vscode.workspace.getConfiguration("dbViewer").get("pageSize", 100);
  const name = `${node.schema}.${node.table}`;
  return ResultsPanel.show(
    `table:${node.connId}:${node.schema}:${node.table}`,
    `${node.schema}.${node.table} · ${cfg.name}`,
    async (page, view) => {
      const a = await manager.adapter(node.connId);
      return { ...(await a.fetchTable(node.schema, node.table, pageSize, page * pageSize, view)), pageSize };
    },
    {
      paged: true,
      name,
      cancel: () => manager.cancel(node.connId),
      // Every page with the current sort/filters.
      exportAll: (view) =>
        exportOnOwnConnection(node.connId, name, async function* (a) {
          for (let offset = 0; ; offset += BATCH_SIZE) {
            const r = await a.fetchTable(node.schema, node.table, BATCH_SIZE, offset, view);
            yield r;
            if (r.rows.length < BATCH_SIZE) break;
          }
        }),
    }
  );
}

async function newQuery(node) {
  let connId = node && node.connId;
  if (!connId) connId = await pickConnection();
  if (!connId) return;
  const cfg = manager.get(connId);
  const t = TYPES[cfg.type];
  const kind = await vscode.window.showQuickPick(
    [
      { label: "SELECT", description: cfg.type === "mongo" ? "find" : "", kind: "select" },
      { label: "INSERT", kind: "insert" },
      { label: "UPDATE", kind: "update" },
      { label: "DELETE", kind: "delete" },
      { label: "Empty", description: "blank editor", kind: "" },
    ].map((k) => (k.kind && k.kind !== "select" && readOnly(cfg) ? { ...k, detail: "Needs a Read-write connection" } : k)),
    { placeHolder: `New query on ${cfg.name}` }
  );
  if (!kind) return;

  const placeholder = cfg.type === "mongo" ? "collection" : "table_name";
  let content = "";
  if (kind.kind && node && node.kind === "table") {
    // Real column names make the INSERT/UPDATE/DELETE templates ready to fill in.
    const cols = await manager
      .adapter(connId)
      .then((a) => a.getColumns(node.schema, node.table))
      .catch(() => []);
    content = t.sample(kind.kind, node.schema, node.table, cols);
  } else if (kind.kind) {
    content = t.sample(kind.kind, node && node.kind === "schema" ? node.schema : t.defaultSchema(cfg), placeholder);
  }
  const doc = await vscode.workspace.openTextDocument({ language: t.language, content });
  queryDocs.set(doc.uri.toString(), connId);
  runLens.fire();
  await vscode.window.showTextDocument(doc);
  vscode.commands.executeCommand("setContext", "dbViewer.isQueryEditor", true);
}

async function pickConnection() {
  const all = manager.list();
  if (!all.length) throw new Error("Add a connection first.");
  if (all.length === 1) return all[0].id;
  const pick = await vscode.window.showQuickPick(
    all.map((c) => ({ label: c.name, description: TYPES[c.type].label, id: c.id })),
    { placeHolder: "Run on which connection?" }
  );
  return pick && pick.id;
}

// The editor's query (or selection) and its connection, after the read-only check.
async function editorQuery(ed) {
  const key = ed.document.uri.toString();
  let connId = queryDocs.get(key);
  if (!connId || !manager.get(connId)) {
    connId = await pickConnection();
    if (!connId) return;
    queryDocs.set(key, connId);
    runLens.fire();
  }
  const cfg = manager.get(connId);
  const text = (ed.selection.isEmpty ? ed.document.getText() : ed.document.getText(ed.selection)).trim();
  if (!text) throw new Error("Query is empty.");
  const ro = readOnly(cfg);
  if (ro && cfg.type !== "mongo") assertReadOnlySql(text);
  return { connId, cfg, text, ro, write: !ro && isWriteQuery(cfg.type, text) };
}

async function runQuery() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const q = await editorQuery(ed);
  if (!q) return;
  const { connId, cfg, text, ro, write } = q;
  const settings = vscode.workspace.getConfiguration("dbViewer");
  const maxRows = settings.get("maxRows", 1000);
  if (write && settings.get("confirmWrites", true)) {
    const ok = await vscode.window.showWarningMessage(
      `Run a statement that changes data or schema on "${cfg.name}"?`,
      { modal: true, detail: text.length > 500 ? text.slice(0, 500) + "…" : text },
      "Run"
    );
    if (ok !== "Run") return;
  }

  await queryResults.show(cfg.name, async () => {
    const a = await manager.adapter(connId);
    return a.runQuery(text, maxRows, { readOnly: ro });
  }, ed, {
    name: "query",
    cancel: () => manager.cancel(connId),
    exportAll: write ? null : () => exportAllRows(connId, text),
  });
  // CREATE / DROP etc. may change what the tree shows.
  if (write) tree.refresh();
}

// Export the editor's query straight to CSV, without showing it in the grid first.
async function exportQuery() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const q = await editorQuery(ed);
  if (!q) return;
  // Also in read-only mode, where a MongoDB write op would otherwise export a plain find.
  if (isWriteQuery(q.cfg.type, q.text)) throw new Error("Export needs a query that returns rows.");
  await exportAllRows(q.connId, q.text);
}

function exportAllRows(connId, text) {
  return exportOnOwnConnection(connId, "query", (a) => a.streamQuery(text, BATCH_SIZE));
}

// Run an export on a connection of its own so the shared one stays free for
// browsing. read(adapter) yields { columns, rows } batches.
function exportOnOwnConnection(connId, name, read) {
  let a = null;
  return exportBatches(
    name,
    async function* () {
      a = await manager.open(connId);
      try {
        yield* read(a);
      } finally {
        await a.close().catch(() => {});
      }
    },
    // Stop the statement; adapters without cancel() (MongoDB) are closed instead.
    async () => {
      if (a) await (a.cancel ? a.cancel() : a.close());
    }
  );
}

function isWriteQuery(type, text) {
  if (type !== "mongo") return isWriteSql(text);
  try {
    const q = JSON.parse(stripLineComments(text));
    return MONGO_WRITE_OPS.some((op) => q[op] !== undefined) || (Array.isArray(q.aggregate) && /"\$(out|merge)"/.test(text));
  } catch {
    return false; // The adapter reports the parse error.
  }
}

module.exports = { activate, deactivate };
