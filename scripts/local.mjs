import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLocalDatabase } from './sqlite-adapter.mjs';
import { DB_SCHEMA, handleUpdate, runReminders } from '../src/worker.mjs';

const TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;

function validateEnvironment() {
  if (!TOKEN_PATTERN.test(process.env.BOT_TOKEN ?? '')) {
    throw new Error('Укажите BOT_TOKEN из BotFather в файле .env.');
  }
  const ownerId = process.env.OWNER_ID || '0';
  if (!/^\d+$/.test(ownerId) || !Number.isSafeInteger(Number(ownerId))) {
    throw new Error('OWNER_ID должен быть числом или отсутствовать (для многопользовательского режима используется 0).');
  }
  const timezone = process.env.DEFAULT_TIMEZONE || 'Europe/Moscow';
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: timezone }).format();
  } catch {
    throw new Error('DEFAULT_TIMEZONE должен быть часовым поясом, например Europe/Moscow.');
  }
  return { BOT_TOKEN: process.env.BOT_TOKEN, OWNER_ID: ownerId, DEFAULT_TIMEZONE: timezone };
}

class TelegramError extends Error {
  constructor(status) {
    super('Telegram request failed');
    this.status = Number.isInteger(status) ? status : undefined;
  }
}

async function telegram(token, method, payload, signal, timeout = 40_000) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });
    const data = await response.json();
    if (!response.ok || data.ok !== true) throw new TelegramError(data.error_code || response.status);
    return data.result;
  } catch (error) {
    if (error instanceof TelegramError) throw error;
    throw new TelegramError(response?.status);
  }
}

function reportFailure(label, error) {
  // Errors from fetch can contain the request URL and therefore the bot token.
  const status = error instanceof TelegramError && error.status ? ` (код ${error.status})` : '';
  console.error(`${label}${status}. Повторная попытка будет выполнена автоматически.`);
}

function delay(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function main() {
  let env;
  try {
    env = validateEnvironment();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  const unknownArgument = process.argv.slice(2).find((arg) => arg !== '--remove-webhook');
  if (unknownArgument) {
    console.error('Неизвестный параметр запуска. Поддерживается только --remove-webhook.');
    process.exitCode = 1;
    return;
  }

  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let interval;
  let reminders;
  let db;
  try {
    // Validate the bundled schema before any change to an existing webhook.
    // The source export also lets a fresh source checkout run before npm run build.
    let schema;
    try { schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      schema = DB_SCHEMA;
    }
    db = createLocalDatabase(fileURLToPath(new URL('../data/bot.sqlite', import.meta.url)));
    await db.exec(schema);
    env.DB = db;

    const webhook = await telegram(env.BOT_TOKEN, 'getWebhookInfo', {}, shutdown.signal, 15_000);
    if (webhook.url) {
      if (!process.argv.includes('--remove-webhook')) {
        console.error('У бота включён webhook. Для перехода на локальный запуск выполните npm start -- --remove-webhook.');
        process.exitCode = 1;
        return;
      }
      await telegram(env.BOT_TOKEN, 'deleteWebhook', { drop_pending_updates: false }, shutdown.signal, 15_000);
      console.log('Webhook отключён. Ожидающие сообщения сохранены.');
    }

    const tick = () => {
      if (shutdown.signal.aborted || reminders) return;
      reminders = Promise.resolve()
        .then(() => runReminders(env))
        .catch((error) => reportFailure('Не удалось проверить напоминания', error))
        .finally(() => { reminders = undefined; });
    };
    tick();
    interval = setInterval(tick, 30_000);
    console.log('Бот запущен. Напишите ему /start. Для остановки нажмите Ctrl+C.');
    console.log('Каждый пользователь работает со своим расписанием. Отправьте боту /start в личном чате.');

    let offset = 0;
    while (!shutdown.signal.aborted) {
      try {
        const updates = await telegram(env.BOT_TOKEN, 'getUpdates', {
          offset, timeout: 25, allowed_updates: ['message'],
        }, shutdown.signal);
        for (const update of updates) {
          if (shutdown.signal.aborted) break;
          await handleUpdate(update, env);
          // A failed update is retried; only successfully handled updates are acknowledged.
          offset = update.update_id + 1;
        }
      } catch (error) {
        if (shutdown.signal.aborted) break;
        reportFailure('Не удалось обработать сообщения Telegram', error);
        await delay(error instanceof TelegramError && error.status === 409 ? 10_000 : 3_000, shutdown.signal);
      }
    }
  } catch (error) {
    if (!shutdown.signal.aborted) {
      const status = error instanceof TelegramError && error.status ? ` (код ${error.status})` : '';
      console.error(`Не удалось запустить бота${status}. Проверьте .env, подключение к сети и доступность папки data.`);
      process.exitCode = 1;
    }
  } finally {
    clearInterval(interval);
    await reminders;
    await db?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

await main();
