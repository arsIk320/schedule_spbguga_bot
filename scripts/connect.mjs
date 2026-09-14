function configuration() {
  const secret = process.env.WEBHOOK_SECRET ?? '';
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret) || secret.startsWith('REPLACE_')) {
    throw new Error('Укажите WEBHOOK_SECRET: от 32 до 256 случайных латинских букв, цифр, символов _ или -.');
  }
  let url;
  try { url = new URL(process.argv[2]); } catch {
    throw new Error('Передайте HTTPS-адрес опубликованного Worker: npm run connect -- https://имя.workers.dev');
  }
  if (process.argv.length !== 3 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !['/', ''].includes(url.pathname)
      || /(?:localhost|example\.(?:com|org|net)|\.invalid$|\.test$|\.localhost$)/i.test(url.hostname)
      || /(?:your[-_.]|replace[-_.]|[<>])/i.test(url.href)) {
    throw new Error('Нужен настоящий HTTPS-адрес Worker без /setup, /telegram, пароля, query-параметров или шаблонных значений.');
  }
  return { secret, setupUrl: `${url.origin}/setup` };
}

async function connect({ secret, setupUrl }) {
  let response;
  try {
    // The authenticated setup endpoint creates the schema before enabling Telegram,
    // sets the command menu, and verifies getWebhookInfo using the deployed bot token.
    response = await fetch(setupUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, action: 'connect' }),
      redirect: 'error',
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new Error('Не удалось связаться с Worker. Проверьте адрес и подключение к сети.');
  }
  if (response.status === 403) throw new Error('WEBHOOK_SECRET в .env не совпадает с секретом опубликованного Worker.');
  if (!response.ok) {
    throw new Error(`Подключение не выполнено (код ${response.status}). Проверьте BOT_TOKEN, WEBHOOK_SECRET и привязку базы DB в настройках Worker.`);
  }
  let result;
  try { result = await response.json(); } catch {
    throw new Error('Worker вернул неподходящий ответ. Проверьте адрес и опубликуйте актуальную версию проекта.');
  }
  // Do not print arbitrary server responses, request URLs, or secrets.
  if (typeof result.message !== 'string' || !result.message.startsWith('✅ Telegram подключён.')) {
    throw new Error('Worker не подтвердил подключение Telegram. Проверьте состояние через страницу /setup.');
  }
  console.log('Таблицы подготовлены, webhook и меню команд настроены. Telegram подтвердил подключение.');
  const pending = result.message.match(/Ожидают обработки: (\d+)/);
  if (pending) console.log(`Ожидающих обновлений: ${pending[1]}.`);
  if (result.message.includes('ошибке доставки')) {
    console.log('Telegram сообщает о недавней ошибке доставки. Проверьте состояние на странице /setup.');
  }
  console.log('Отправьте своему боту /id, укажите OWNER_ID в настройках Worker, затем отправьте /start.');
  console.log('Убедитесь, что в Cloudflare включён Cron Trigger каждую минуту.');
}

try {
  await connect(configuration());
} catch (error) {
  // All errors above contain only controlled descriptions, never raw fetch errors.
  console.error(error.message);
  process.exitCode = 1;
}
