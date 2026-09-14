import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDatabase } from '../scripts/sqlite-adapter.mjs';

test('SQLite adapter supports bound reads, scalars, raw rows and mutation metadata', async () => {
  const db = createLocalDatabase(':memory:');
  try {
    await db.exec('CREATE TABLE rooms (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL)');
    const query = db.prepare('INSERT INTO rooms (name) VALUES (?)');
    const inserted = await query.bind('А-304').run();
    assert.equal(inserted.success, true);
    assert.equal(inserted.meta.changes, 1);
    assert.equal(inserted.meta.last_row_id, 1);
    await query.bind('Б-205').run();
    assert.deepEqual(await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(1).first(), { id: 1, name: 'А-304' });
    assert.equal(await db.prepare('SELECT name FROM rooms WHERE id = ?').bind(2).first('name'), 'Б-205');
    assert.equal(await db.prepare('SELECT * FROM rooms WHERE id = 99').first(), null);
    assert.equal(await db.prepare('SELECT * FROM rooms WHERE id = 99').first('name'), null);
    assert.deepEqual((await db.prepare('SELECT name FROM rooms ORDER BY id').all()).results, [{ name: 'А-304' }, { name: 'Б-205' }]);
    assert.deepEqual(await db.prepare('SELECT id, name FROM rooms ORDER BY id').raw(), [[1, 'А-304'], [2, 'Б-205']]);
  } finally { await db.close(); }
});

test('batch commits successful statements and rolls back the entire batch on constraint failure', async () => {
  const db = createLocalDatabase(':memory:');
  try {
    await db.exec('CREATE TABLE lessons (id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE)');
    const insert = db.prepare('INSERT INTO lessons (title) VALUES (?)');
    const results = await db.batch([insert.bind('Математика'), insert.bind('Физика')]);
    assert.equal(results.length, 2);
    assert.equal(results[0].meta.changes, 1);
    await assert.rejects(db.batch([insert.bind('История'), insert.bind('Математика')]));
    assert.deepEqual(await db.prepare('SELECT title FROM lessons ORDER BY id').raw(), [['Математика'], ['Физика']]);
    await insert.bind('Информатика').run();
    assert.equal(await db.prepare('SELECT COUNT(*) AS total FROM lessons').first('total'), 3);
    const reads = await db.batch([db.prepare('SELECT title FROM lessons ORDER BY id LIMIT 1')]);
    assert.deepEqual(reads[0].results, [{ title: 'Математика' }]);
  } finally { await db.close(); }
});

test('foreign keys are enforced and statements from another connection are rejected', async () => {
  const db = createLocalDatabase(':memory:');
  const other = createLocalDatabase(':memory:');
  try {
    await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE lessons (user_id INTEGER REFERENCES users(id))');
    await assert.rejects(db.prepare('INSERT INTO lessons (user_id) VALUES (99)').run());
    await assert.rejects(db.batch([other.prepare('SELECT 1')]));
    assert.equal(await db.prepare('SELECT COUNT(*) AS total FROM lessons').first('total'), 0);
  } finally { await db.close(); await other.close(); }
});

test('data survives closing and reopening the local database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'class-reminder-sqlite-'));
  const path = join(directory, 'nested', 'bot.sqlite');
  let db;
  try {
    db = createLocalDatabase(path);
    await db.exec("CREATE TABLE settings (timezone TEXT NOT NULL); INSERT INTO settings VALUES ('Europe/Moscow')");
    await db.close();
    db = createLocalDatabase(path);
    assert.equal(await db.prepare('SELECT timezone FROM settings').first('timezone'), 'Europe/Moscow');
  } finally {
    await db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
