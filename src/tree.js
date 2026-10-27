// Sidebar tree: connection -> schema/database -> table/view/collection -> column.
const vscode = require("vscode");
const { TYPES } = require("./adapters");
const { readOnly } = require("./connections");

const { Collapsed, None } = vscode.TreeItemCollapsibleState;

class ConnectionTree {
  constructor(manager) {
    this.manager = manager;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    manager.onDidChange(() => this.refresh());
  }

  refresh(node) {
    this._onDidChangeTreeData.fire(node);
  }

  getTreeItem(node) {
    return node.item;
  }

  async getChildren(node) {
    if (!node) return this.manager.list().map((cfg) => connectionNode(cfg, this.manager));
    try {
      const a = await this.manager.adapter(node.connId);
      if (node.kind === "connection") {
        const schemas = await a.getSchemas();
        const label = node.type === "mongo" ? "database" : "schema";
        return schemas.map((s) => schemaNode(node.connId, node.type, s, label));
      }
      if (node.kind === "schema") {
        const tables = await a.getTables(node.schema);
        if (!tables.length) return [infoNode("(empty)")];
        return tables.map((t) => tableNode(node, t));
      }
      if (node.kind === "table") {
        const cols = await a.getColumns(node.schema, node.table);
        return cols.map(columnNode);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`db-adapters: ${err.message}`);
      return [infoNode(`Error: ${err.message}`)];
    }
    return [];
  }
}

function connectionNode(cfg, manager) {
  const connected = manager.isConnected(cfg.id);
  const item = new vscode.TreeItem(cfg.name, Collapsed);
  item.id = `conn:${cfg.id}`;
  item.description = TYPES[cfg.type].label + (readOnly(cfg) ? "" : " · read-write");
  item.tooltip = manager.describe(cfg);
  item.contextValue = connected ? "connection-connected" : "connection";
  item.iconPath = new vscode.ThemeIcon(
    "database",
    connected ? new vscode.ThemeColor("testing.iconPassed") : undefined
  );
  return { kind: "connection", connId: cfg.id, type: cfg.type, item };
}

function schemaNode(connId, type, schema, label) {
  const item = new vscode.TreeItem(schema, Collapsed);
  item.id = `schema:${connId}:${schema}`;
  item.contextValue = "schema";
  item.tooltip = `${label}: ${schema}`;
  item.iconPath = new vscode.ThemeIcon(type === "mongo" ? "database" : "symbol-namespace");
  return { kind: "schema", connId, type, schema, item };
}

function tableNode(parent, t) {
  const item = new vscode.TreeItem(t.name, Collapsed);
  item.id = `table:${parent.connId}:${parent.schema}:${t.name}`;
  item.contextValue = "table";
  item.description = t.type === "view" ? "view" : undefined;
  item.iconPath = new vscode.ThemeIcon(t.type === "view" ? "eye" : t.type === "collection" ? "files" : "table");
  const node = { kind: "table", connId: parent.connId, type: parent.type, schema: parent.schema, table: t.name, item };
  item.command = { command: "dbViewer.openTable", title: "Open Table", arguments: [node] };
  return node;
}

function columnNode(c) {
  const item = new vscode.TreeItem(c.name, None);
  item.description = `${c.type}${c.nullable ? "" : " not null"}`;
  item.contextValue = "column";
  item.iconPath = new vscode.ThemeIcon(c.pk ? "key" : "symbol-field");
  return { kind: "column", item };
}

function infoNode(text) {
  const item = new vscode.TreeItem(text, None);
  item.contextValue = "info";
  return { kind: "info", item };
}

module.exports = { ConnectionTree };
