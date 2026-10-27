# db-adapters

A VS Code extension for browsing and querying **PostgreSQL**, **MySQL / MariaDB**, **Oracle**, **MongoDB** and **SQL Server** from the sidebar.

- Sidebar tree: connection → schema/database → table/view/collection → columns (PK shown with a key icon)
- Click a table to open its data in a grid, with Prev/Next paging and sort/filter that run in the database
- Query editor: run SQL (or a MongoDB JSON query) and see results in the **Query Results** view in the bottom panel
- Passwords and MongoDB connection strings are kept in VS Code `SecretStorage` (OS keychain), never in settings
- **Read-only by default**: write statements are blocked (see [Read-only mode](#read-only-mode))

All five drivers are pure JavaScript. Oracle uses `node-oracledb` Thin mode, so you don't need Oracle Instant Client.

## Install

```bash
cd db-adapters
npm install
npm run package          # bumps the patch version (0.0.2 -> 0.0.3) and builds db-adapters-<version>.vsix
npm run install-ext      # installs the .vsix of the current version
```

To rebuild without changing the version, use `npm run package:same`. Old `.vsix` files stay in the folder; delete them when you no longer need them.

To run it from source instead, open the `db-adapters` folder in VS Code and press `F5` (Extension Development Host).

## Usage

1. Open the **db-adapters** icon in the Activity Bar and click **+** (Add Connection).
2. A form opens with all the fields on one page. Choose a database type and fill it in:

   | Type | Fields |
   |---|---|
   | PostgreSQL | host, port (5432), database, user, password, SSL |
   | MySQL / MariaDB | host, port (3306), database (optional), user, password, SSL |
   | SQL Server | host, port (1433), database, user, password, encryption |
   | Oracle | host, port (1521), service name (for example `ORCLPDB1`), user, password |
   | MongoDB | connection string, for example `mongodb://user:pass@host:27017/?authSource=admin` or `mongodb+srv://...` |

   All types also have a connection name and an access mode: **Use default setting** (`dbViewer.readOnly`), **Read-only** or **Read-write**. Click **Test Connection** to check the settings without saving, or **Save & Connect**.

3. Expand the connection to browse it. Click a table to open its data.
4. Right-click a connection, schema or table and choose **New Query**. To run the query, click **▶ Run on _connection_** above the first line, click ▶ in the editor title, or press `Cmd+Enter` (`Ctrl+Enter` on Windows and Linux). If text is selected, only the selection runs. The result opens in the **Query Results** view in the bottom panel. **New Query** asks which statement to start with: `SELECT`, `INSERT`, `UPDATE`, `DELETE` or an empty editor. When you start from a table, the template uses its real columns and primary key, and fills each value with a default for the column type: `0` for numbers, `''` for text, today's date for dates. Change the values before you run a write.

To change data or schema (`INSERT`, `UPDATE`, `DELETE`, `CREATE`, ...), set the connection to **Read-write** and run the statement in a query editor. You are asked to confirm first (see `dbViewer.confirmWrites`). Each statement is committed right away.

### Sort and filter results

Click a column header to sort by it (ascending, descending, then off). Under each header, pick an operator, type a value and press `Enter` to filter:

| Operator | Meaning |
|---|---|
| `contains` | contains the text (case-insensitive) |
| `=`, `≠`, `>`, `≥`, `<`, `≤` | compare |
| `like`, `not like` | SQL `LIKE` pattern: `%` matches any text, `_` matches one character |
| `is null`, `not null` | is / is not NULL (no value needed) |

Filters on several columns are combined with AND. **Clear** removes the sort and all filters.

- **Table view** (a table opened from the tree): sorting and filtering run in the database, so they cover the whole table, not only the current page.
- **Query Results**: sorting and filtering work only on the rows the query returned. The **Search rows** box matches text in any column.

Right-click a connection to edit it, disconnect it or remove it. Editing opens the same form with the saved values filled in (you can't change the database type). Leave the password or connection string empty to keep the saved one.

### Cancel and export

While a query or table page is loading, click **Cancel** to stop it in the database.

To save results as CSV (UTF-8, readable by Excel):

- **Export** saves the rows shown in the grid, with the current search, filters and sort. For a query this is at most `dbViewer.maxRows` rows; for a table it is the current page.
- **Export all** saves every row: it runs the query again (or reads the whole table with the current sort/filters) on a separate connection and writes the rows in batches of 5,000, so large results don't fill memory. A notification shows the progress and has a cancel button.
- **Export CSV** above the first line of a query editor (or in the editor title) does the same as **Export all** without showing the result in the grid first.

For PostgreSQL, **Export all** reads the query through a cursor, so it must be a single `SELECT` / `WITH` statement. For MongoDB, the CSV columns come from the first 5,000 documents; fields that appear only later are left out and listed when the export finishes.

### MongoDB queries

MongoDB queries are written as JSON ([Extended JSON](https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/) is supported, for example `{"$oid": "..."}` and `{"$date": "..."}`):

```json
{ "db": "shop", "collection": "orders", "find": { "status": "paid" }, "projection": { "items": 0 }, "sort": { "_id": -1 }, "skip": 0, "limit": 50 }
```

```json
{ "collection": "orders", "aggregate": [ { "$group": { "_id": "$status", "n": { "$sum": 1 } } } ] }
```

```json
{ "collection": "orders", "count": { "status": "paid" } }
```

Writes (Read-write connections only). Without `"many": true`, `update` and `delete` change only the first matching document:

```json
{ "collection": "orders", "insert": [ { "status": "new" }, { "status": "paid" } ] }
```

```json
{ "collection": "orders", "filter": { "status": "new" }, "update": { "$set": { "status": "paid" } }, "many": true }
```

```json
{ "collection": "orders", "delete": { "status": "cancelled" }, "many": true }
```

```json
{ "collection": "orders", "create": true }
```

Lines that start with `//` are ignored. `db` defaults to the database in the connection string. Field columns in the tree are inferred from a sample of 100 documents.

## Settings

| Setting | Default | Description |
|---|---|---|
| `dbViewer.readOnly` | `true` | Block statements that change data or schema. A connection can override this |
| `dbViewer.confirmWrites` | `true` | Ask before running a statement that changes data or schema |
| `dbViewer.pageSize` | `100` | Rows per page when you open a table |
| `dbViewer.maxRows` | `1000` | Maximum rows shown for a query result |

## Read-only mode

When a connection is read-only (its own access mode, or `dbViewer.readOnly` if it uses the default):

- **SQL**: each statement must start with `SELECT`, `WITH`, `EXPLAIN`, `SHOW`, `DESC`/`DESCRIBE`, `VALUES` or `TABLE`. A statement is also blocked if it contains a keyword such as `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `EXEC`, `CALL` or `INTO`. Keywords inside string literals, quoted identifiers and comments are ignored.
- **PostgreSQL** and **MySQL / MariaDB**: the session is also set to read-only on the server.
- **MongoDB**: `insert`, `update`, `delete`, `create` and aggregations that contain `$out` or `$merge` are blocked.

The keyword check is a safety net, not a security boundary. For real protection, connect with a database user that has read-only permissions. If you change this setting, open connections reconnect.

## Limitations

- Query results are limited to `maxRows` after they are fetched. PostgreSQL and SQL Server still run the full query, so add your own `LIMIT` or `TOP` for large tables. Oracle and MongoDB stop fetching at the limit.
- If a query has several statements, only the last result set is shown.
- Table paging in SQL Server needs version 2012 or later, and in Oracle needs 12c or later (`OFFSET ... FETCH`).
- SSH tunnels aren't supported. Use `ssh -L` and connect to `localhost` instead.
- You can't edit data in the grid yet.

## Testing

There are no automated tests in this repo yet. To test by hand, start throwaway databases with Docker and add them as connections. Set each password yourself, and don't commit it:

```bash
export DBV_TEST_PASSWORD='choose-a-password'   # SQL Server needs 8+ chars with upper, lower, digit and symbol

docker run -d --name dbv-test-pg    -p 15432:5432  -e POSTGRES_PASSWORD="$DBV_TEST_PASSWORD" postgres:16-alpine
docker run -d --name dbv-test-mysql -p 13306:3306  -e MYSQL_ROOT_PASSWORD="$DBV_TEST_PASSWORD" mysql:8
docker run -d --name dbv-test-mssql -p 11433:1433  -e ACCEPT_EULA=Y -e MSSQL_PID=developer \
  -e MSSQL_SA_PASSWORD="$DBV_TEST_PASSWORD" mcr.microsoft.com/mssql/server:2022-latest
docker run -d --name dbv-test-ora   -p 11521:1521  -e ORACLE_PASSWORD="$DBV_TEST_PASSWORD" \
  -e APP_USER=app -e APP_USER_PASSWORD="$DBV_TEST_PASSWORD" gvenzl/oracle-free:23-slim-faststart
docker run -d --name dbv-test-mongo -p 17017:27017 mongo:7
```

Oracle takes a minute or two to start. `docker logs -f dbv-test-ora` prints `DATABASE IS READY TO USE!` when it's ready.

Then add these connections in the extension:

| Type | Host | Port | Database / service | User | Password |
|---|---|---|---|---|---|
| PostgreSQL | `localhost` | `15432` | `postgres` | `postgres` | `POSTGRES_PASSWORD` |
| MySQL | `localhost` | `13306` | (empty) | `root` | `MYSQL_ROOT_PASSWORD` |
| SQL Server | `localhost` | `11433` | `master` | `sa` | `MSSQL_SA_PASSWORD` (choose **Encrypt, trust server certificate**) |
| Oracle | `localhost` | `11521` | `FREEPDB1` | `app` | `APP_USER_PASSWORD` |
| MongoDB | connection string `mongodb://localhost:17017/dbv_test` | | | no auth | |

To look up a password you set earlier:

```bash
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' dbv-test-pg | grep PASSWORD
```

To test writes, set the connection's access mode to **Read-write**. When you're done, remove the containers with `docker rm -f dbv-test-pg dbv-test-mysql dbv-test-mssql dbv-test-ora dbv-test-mongo`.

## Project layout

```
extension.js            commands, connection prompts, query runner
src/connections.js      saved connections, SecretStorage, live adapters
src/connectionForm.js   Add/Edit Connection form
src/tree.js             sidebar TreeDataProvider
src/resultsPanel.js     result grid: table tabs and the Query Results panel view (paging, sort, filter)
src/adapters/           one adapter per database + shared helpers (read-only guard, filter/sort)
```

To add another database, create an adapter with `connect`, `getSchemas`, `getTables`, `getColumns`, `fetchTable`, `runQuery` and `close`, then register it in `src/adapters/index.js`.
