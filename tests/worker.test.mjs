import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker, { DB_SCHEMA, handleUpdate, runReminders, TelegramError } from '../src/worker.mjs';
import { createLocalDatabase } from '../scripts/sqlite-adapter.mjs';

const OWNER = 12345;
const SCHEDULE = 'Пн | 09:00 | Математика | Иванов И.И. | 305 | Корпус А, 3 этаж';
const DUE = new Date('2026-09-14T05:45:00.000Z');

function update(updateId, text, userId = OWNER, extras = {}) {
  return {
    update_id: updateId,
    message: { from: { id: userId }, chat: { id: userId, type: 'private' }, text, ...extras },
  };
}

async function fixture(t, { databasePath = ':memory:', initialize = true } = {}) {
  const database = createLocalDatabase(databasePath);
  if (initialize) await database.exec(DB_SCHEMA);
  const calls = [];
  let handler = () => undefined;
  let webhookUrl = '';
  const env = {
    DB: database,
    BOT_TOKEN: '12345:TEST_TOKEN_NEVER_SENT_TO_NETWORK',
    WEBHOOK_SECRET: 'test_secret_123456789012345678901234567890',
    OWNER_ID: String(OWNER),
    DEFAULT_TIMEZONE: 'Europe/Moscow',
    TELEGRAM_FETCH: async (url, options = {}) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://api.telegram.org');
      const method = parsed.pathname.startsWith('/file/') ? 'download' : parsed.pathname.split('/').at(-1);
      const call = { method, payload: options.body ? JSON.parse(options.body) : {}, url };
      calls.push(call);
      const response = await handler(call);
      if (response !== undefined) return response;
      if (method === 'download') return new Response(SCHEDULE, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      if (method === 'setWebhook') webhookUrl = call.payload.url;
      const result = method === 'getWebhookInfo' ? { url: webhookUrl, pending_update_count: 0 }
        : method === 'getFile' ? { file_path: 'documents/schedule.txt' }
          : method === 'sendMessage' ? { message_id: calls.length } : true;
      return Response.json({ ok: true, result });
    },
  };
  t.after(() => env.DB.close());
  return {
    env, calls,
    setHandler(value) { handler = value; },
    clearCalls() { calls.length = 0; },
    messages() { return calls.filter(call => call.method === 'sendMessage'); },
    settings(chatId = OWNER) {
      return env.DB.prepare('SELECT * FROM user_settings WHERE chat_id = ?').bind(String(chatId)).first();
    },
  };
}

async function importSchedule(f, text = SCHEDULE, updateId = 1) {
  await handleUpdate(update(updateId, text), f.env);
  f.clearCalls();
}

test('каждый пользователь получает отдельное расписание; групповые чаты игнорируются', async t => {
  const f = await fixture(t);
  await handleUpdate(update(1, SCHEDULE, 777), f.env);
  await handleUpdate(update(2, '/pause', 777), f.env);
  await handleUpdate(update(3, SCHEDULE, OWNER, { chat: { id: -100, type: 'group' } }), f.env);
  assert.equal(f.messages().length, 2);
  assert.equal((await f.env.DB.prepare('SELECT COUNT(*) AS count FROM jobs').first()).count, 2);
  assert.equal(JSON.parse((await f.settings(777)).schedule)[0].subject, 'Математика');
  assert.equal((await f.settings(777)).paused, 1);
  assert.equal(await f.settings(), null);
  await handleUpdate(update(4, '/id', 777), f.env);
  assert.equal(f.messages().length, 3);
  assert.match(f.messages().at(-1).payload.text, /Telegram ID: 777/);
  assert.equal((await f.env.DB.prepare('SELECT COUNT(*) AS count FROM jobs').first()).count, 3);
  await handleUpdate(update(5, '/start'), f.env);
  assert.equal((await f.settings()).timezone, 'Europe/Moscow');
});

test('webhook отклоняет неверный секрет до обработки; принимает подписанный запрос', async t => {
  const f = await fixture(t);
  const request = secret => new Request('https://bot.example/telegram', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(update(1, SCHEDULE)),
  });
  assert.equal((await worker.fetch(request('wrong-secret'), f.env)).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.settings(), null);
  assert.equal((await worker.fetch(request(f.env.WEBHOOK_SECRET), f.env)).status, 200);
  assert.equal(JSON.parse((await f.settings()).schedule)[0].subject, 'Математика');
});

test('текстовый импорт сохраняется атомарно: ошибка новой строки сохраняет старое расписание', async t => {
  const f = await fixture(t);
  await importSchedule(f);
  const saved = (await f.settings()).schedule;
  await handleUpdate(update(2, `${SCHEDULE}\n${SCHEDULE.replace('09:00', '24:00')}`), f.env);
  assert.equal((await f.settings()).schedule, saved);
  assert.match(f.messages().at(-1).payload.text, /Строка 2:/);
  assert.match(f.messages().at(-1).payload.text, /Старые данные сохранены/);
  assert.equal((await f.env.DB.prepare('SELECT done FROM jobs WHERE key = ?').bind('update:2').first()).done, 1);
});

test('один Telegram update применяется и подтверждается только один раз', async t => {
  const f = await fixture(t);
  const message = update(123, SCHEDULE);
  await handleUpdate(message, f.env);
  await handleUpdate(message, f.env);
  assert.equal(f.messages().length, 1);
  assert.equal((await f.env.DB.prepare('SELECT COUNT(*) AS count FROM jobs').first()).count, 1);
  assert.equal(JSON.parse((await f.settings()).schedule).length, 1);
});

test('повтор /pause после сбоя ответа не отменяет более новый /resume', async t => {
  const f = await fixture(t);
  await importSchedule(f);
  f.setHandler(call => { if (call.method === 'sendMessage') throw new Error('Simulated offline transport'); });
  await assert.rejects(handleUpdate(update(10, '/pause'), f.env), TelegramError);
  assert.equal((await f.settings()).paused, 1);
  f.setHandler(() => undefined);
  await handleUpdate(update(11, '/resume'), f.env);
  assert.equal((await f.settings()).paused, 0);
  await handleUpdate(update(10, '/pause'), f.env);
  assert.equal((await f.settings()).paused, 0);
  assert.equal((await f.env.DB.prepare('SELECT done FROM jobs WHERE key = ?').bind('update:10').first()).done, 1);
});

test('доставленное напоминание не повторяется после повторного открытия SQLite', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'class-reminder-worker-'));
  const databasePath = join(directory, 'test.sqlite');
  const f = await fixture(t, { databasePath });
  // Cleanup only these known temporary files, after the connection has closed.
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(databasePath + suffix)) unlinkSync(databasePath + suffix);
    }
    rmdirSync(directory);
  });
  await importSchedule(f);
  await runReminders(f.env, DUE);
  assert.equal(f.messages().length, 1);
  await f.env.DB.close();
  f.env.DB = createLocalDatabase(databasePath);
  await runReminders(f.env, new Date('2026-09-14T05:46:00Z'));
  assert.equal(f.messages().length, 1);
  const job = await f.env.DB.prepare("SELECT done FROM jobs WHERE key LIKE 'reminder:%'").first();
  assert.equal(job.done, 1);
});

test('два одновременных запуска используют атомарный SQL lease и отправляют один раз', async t => {
  const f = await fixture(t);
  await importSchedule(f);
  f.setHandler(async call => {
    if (call.method === 'sendMessage') await new Promise(resolve => setImmediate(resolve));
  });
  await Promise.all([runReminders(f.env, DUE), runReminders(f.env, DUE)]);
  assert.equal(f.messages().length, 1);
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE key LIKE 'reminder:%' AND done = 1").first()).count, 1);
});

test('сетевой сбой освобождает lease, следующий запуск до пары повторяет доставку', async t => {
  const f = await fixture(t);
  await importSchedule(f);
  t.mock.method(console, 'error', () => {});
  let offline = true;
  f.setHandler(call => { if (offline && call.method === 'sendMessage') throw new Error('Offline'); });
  await runReminders(f.env, DUE);
  let job = await f.env.DB.prepare("SELECT done, lease_until FROM jobs WHERE key LIKE 'reminder:%'").first();
  assert.equal(job.done, 0);
  assert.equal(job.lease_until, 0);
  offline = false;
  await runReminders(f.env, new Date('2026-09-14T05:46:00Z'));
  job = await f.env.DB.prepare("SELECT done FROM jobs WHERE key LIKE 'reminder:%'").first();
  assert.equal(job.done, 1);
  assert.equal(f.messages().length, 2);
  assert.match(f.messages().at(-1).payload.text, /14 минут/);
});

test('после начала пары напоминания не отправляются, включая задержку внутри цикла', async t => {
  const f = await fixture(t);
  await importSchedule(f, `${SCHEDULE}\n${SCHEDULE.replace('Математика', 'Физика')}`);
  await runReminders(f.env, new Date('2026-09-14T06:00:00Z'));
  assert.equal(f.messages().length, 0);
  let clock = 1_000_000;
  t.mock.method(Date, 'now', () => clock);
  f.setHandler(call => { if (call.method === 'sendMessage') clock += 20_000; });
  await runReminders(f.env, new Date('2026-09-14T05:59:50Z'));
  assert.equal(f.messages().length, 1);
});

test('число минут в следующем сообщении пересчитывается после медленной доставки', async t => {
  const f = await fixture(t);
  await importSchedule(f, `${SCHEDULE}\n${SCHEDULE.replace('Математика', 'Физика')}`);
  let clock = 1_000_000;
  t.mock.method(Date, 'now', () => clock);
  f.setHandler(call => { if (call.method === 'sendMessage') clock += 61_000; });
  await runReminders(f.env, DUE);
  assert.equal(f.messages().length, 2);
  assert.match(f.messages()[0].payload.text, /15 минут/);
  assert.match(f.messages()[1].payload.text, /14 минут/);
});

test('/pause останавливает доставку, /resume возвращает её', async t => {
  const f = await fixture(t);
  await importSchedule(f);
  await handleUpdate(update(2, '/pause'), f.env);
  f.clearCalls();
  await runReminders(f.env, DUE);
  assert.equal(f.messages().length, 0);
  await handleUpdate(update(3, '/resume'), f.env);
  f.clearCalls();
  await runReminders(f.env, DUE);
  assert.equal(f.messages().length, 1);
});

test('Telegram 403 автоматически ставит напоминания на паузу', async t => {
  const f = await fixture(t);
  await importSchedule(f);
  f.setHandler(call => call.method === 'sendMessage'
    ? Response.json({ ok: false, error_code: 403, description: 'Forbidden' }, { status: 403 }) : undefined);
  await runReminders(f.env, DUE);
  assert.equal((await f.settings()).paused, 1);
  assert.equal((await f.env.DB.prepare("SELECT done FROM jobs WHERE key LIKE 'reminder:%'").first()).done, 1);
  f.clearCalls();
  await runReminders(f.env, new Date('2026-09-14T05:46:00Z'));
  assert.equal(f.calls.length, 0);
});

test('названия и расположение передаются простым текстом без HTML/Markdown интерпретации', async t => {
  const f = await fixture(t);
  await importSchedule(f, 'Пн | 09:00 | <b>Алгебра</b> & геометрия | Иванов_И | 305 | Корпус [А], 3 этаж');
  await runReminders(f.env, DUE);
  const payload = f.messages()[0].payload;
  assert.equal(payload.chat_id, String(OWNER));
  assert.equal('parse_mode' in payload, false);
  assert.match(payload.text, /<b>Алгебра<\/b> & геометрия/);
  assert.match(payload.text, /Корпус \[А\], 3 этаж/);
  assert.match(payload.text, /Иванов_И/);
});

test('напоминания доставляются каждому пользователю в его личный чат', async t => {
  const f = await fixture(t);
  await handleUpdate(update(1, SCHEDULE, OWNER), f.env);
  await handleUpdate(update(2, SCHEDULE, 777), f.env);
  f.clearCalls();
  await runReminders(f.env, DUE);
  const chatIds = f.messages().map(call => String(call.payload.chat_id)).sort();
  assert.deepEqual(chatIds, ['12345', '777']);
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE key LIKE 'reminder:%' AND done = 1").first()).count, 2);
});

test('утреннее расписание приходит около 07:00 по часовому поясу пользователя один раз в день', async t => {
  const f = await fixture(t);
  await importSchedule(f);
  f.clearCalls();
  await runReminders(f.env, new Date('2026-09-14T04:00:00.000Z')); // 07:00 Europe/Moscow
  assert.equal(f.messages().length, 1);
  assert.match(f.messages()[0].payload.text, /Расписание на сегодня/);
  assert.match(f.messages()[0].payload.text, /Математика/);
  await runReminders(f.env, new Date('2026-09-14T04:01:00.000Z'));
  assert.equal(f.messages().length, 1);
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE key LIKE 'daily:%' AND done = 1").first()).count, 1);
});

test('форма маршрутов сохраняет подсказку, которая попадает в напоминание', async t => {
  const f = await fixture(t);
  const request = body => new Request('https://bot.example/rooms', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await worker.fetch(request({ secret: 'wrong', action: 'list' }), f.env)).status, 403);
  const saved = await worker.fetch(request({ secret: f.env.WEBHOOK_SECRET, action: 'save', room: '305', directions: 'Корпус А, 3 этаж, направо' }), f.env);
  assert.equal(saved.status, 200);
  assert.match((await saved.json()).message, /сохранён/);
  await importSchedule(f);
  await runReminders(f.env, DUE);
  assert.match(f.messages()[0].payload.text, /Корпус А, 3 этаж, направо/);
});

test('пользователь выбирает одну из трёх английских групп', async t => {
  const f = await fixture(t);
  await handleUpdate(update(1, '/start'), f.env);
  await handleUpdate(update(2, '/english 2'), f.env);
  f.clearCalls();
  await handleUpdate(update(3, '/week'), f.env);
  const text = f.messages()[0].payload.text;
  assert.match(text, /Антипова Е\.Е\./);
  assert.doesNotMatch(text, /Мухтабарова О\.И\./);
  assert.equal((await f.settings()).english_group, '2');
});

test('таблица расписания показывает все три английские подгруппы', async t => {
  const f = await fixture(t);
  await handleUpdate(update(1, '/start'), f.env);
  await handleUpdate(update(2, '/english 2'), f.env);
  f.clearCalls();
  await handleUpdate(update(3, '/table'), f.env);
  const text = f.messages()[0].payload.text;
  assert.match(text, /Мухтабарова О\.И\./);
  assert.match(text, /Антипова Е\.Е\./);
  assert.match(text, /Яковлева К\.М\./);
});

test('импорт .txt читает UTF-8; неверная кодировка и слишком большой файл сохраняют старые данные', async t => {
  const f = await fixture(t);
  const document = { file_id: 'fake-file-id', file_name: 'schedule.txt', file_size: 200 };
  await handleUpdate(update(1, '', OWNER, { document }), f.env);
  assert.equal(f.calls.some(call => call.method === 'getFile'), true);
  assert.equal(f.calls.some(call => call.method === 'download'), true);
  const saved = (await f.settings()).schedule;
  assert.equal(JSON.parse(saved)[0].room, '305');
  f.clearCalls();
  f.setHandler(call => call.method === 'download' ? new Response(new Uint8Array([0xff, 0xfe, 0xff])) : undefined);
  await handleUpdate(update(2, '', OWNER, { document }), f.env);
  assert.equal((await f.settings()).schedule, saved);
  assert.match(f.messages().at(-1).payload.text, /UTF-8/);
  f.clearCalls();
  await handleUpdate(update(3, '', OWNER, { document: { ...document, file_size: 32_769 } }), f.env);
  assert.equal((await f.settings()).schedule, saved);
  assert.equal(f.calls.some(call => call.method === 'getFile'), false);
  assert.match(f.messages().at(-1).payload.text, /32 КБ/);
});

test('setup защищён секретом, создаёт схему и регистрирует webhook без раскрытия токена', async t => {
  const f = await fixture(t, { initialize: false });
  const setup = secret => new Request('https://bot.example/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret, action: 'connect' }),
  });
  const wrong = await worker.fetch(setup('wrong-secret'), f.env);
  assert.equal(wrong.status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'settings'").first()).count, 0);
  const connected = await worker.fetch(setup(f.env.WEBHOOK_SECRET), f.env);
  assert.equal(connected.status, 200);
  assert.match((await connected.json()).message, /Telegram подключён/);
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'user_settings'").first()).count, 1);
  await handleUpdate(update(1, '/start'), f.env);
  assert.equal((await f.settings()).timezone, 'Europe/Moscow');
  const webhook = f.calls.find(call => call.method === 'setWebhook').payload;
  assert.equal(webhook.url, 'https://bot.example/telegram');
  assert.equal(webhook.secret_token, f.env.WEBHOOK_SECRET);
  assert.equal(webhook.max_connections, 1);
  assert.deepEqual(webhook.allowed_updates, ['message']);
  assert.ok(f.calls.some(call => call.method === 'setMyCommands'));
  const page = await worker.fetch(new Request('https://bot.example/setup'), f.env);
  assert.equal((await page.text()).includes(f.env.BOT_TOKEN), false);
});
