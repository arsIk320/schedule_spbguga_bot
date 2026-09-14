import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

class LocalStatement {
  constructor(owner, sql, bindings = []) {
    this.owner = owner;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new LocalStatement(this.owner, this.sql, bindings);
  }

  _statement() {
    return this.owner.database.prepare(this.sql);
  }

  _runSync() {
    const statement = this._statement();
    if (statement.columns().length > 0) {
      const results = statement.all(...this.bindings).map((row) => ({ ...row }));
      return { success: true, results, meta: { changes: 0, last_row_id: 0 } };
    }
    const result = statement.run(...this.bindings);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
  }

  async run() {
    return this._runSync();
  }

  async first(column) {
    const row = this._statement().get(...this.bindings);
    if (!row) return null;
    return column === undefined ? { ...row } : (row[column] ?? null);
  }

  async all() {
    return {
      success: true,
      results: this._statement().all(...this.bindings).map((row) => ({ ...row })),
    };
  }

  async raw() {
    const statement = this._statement();
    statement.setReturnArrays(true);
    return statement.all(...this.bindings);
  }
}

/** A small asynchronous D1-compatible interface backed by Node's built-in SQLite. */
export function createLocalDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

  const adapter = {
    database,
    prepare(sql) {
      return new LocalStatement(adapter, sql);
    },
    async batch(statements) {
      if (!Array.isArray(statements)) throw new TypeError('Expected an array of statements');
      if (statements.some((item) => !(item instanceof LocalStatement) || item.owner !== adapter)) {
        throw new TypeError('All statements must belong to this database');
      }
      // Keep the entire transaction synchronous so another async handler cannot interleave.
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement._runSync());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(sql) {
      database.exec(sql);
      return { success: true };
    },
    async close() {
      database.close();
    },
  };
  return adapter;
}
