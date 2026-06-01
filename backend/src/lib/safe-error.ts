/**
 * Returns a safe error message for HTTP responses.
 * Never exposes internal platform details, SQL errors, or stack traces to clients.
 */
export function safeError(err: any): string {
  const msg: string = err?.message || String(err);

  // Known categories → friendly Russian messages
  if (msg.includes('PLATFORM_TIMEOUT') || msg.includes('не ответила вовремя'))
    return 'Платформа не ответила вовремя. Попробуйте позже.';
  if (msg.includes('CIRCUIT_OPEN') || msg.includes('временно недоступна'))
    return 'Платформа временно недоступна. Попробуйте через минуту.';
  if (msg.includes('RATE_LIMIT'))
    return 'Слишком много запросов. Подождите минуту.';
  if (msg.includes('Login token expired') || msg.includes('Auth failed'))
    return 'Сессия истекла. Пожалуйста, войдите снова.';
  if (msg.includes('not found') || msg.includes('Not found'))
    return 'Запись не найдена.';
  if (msg.includes('not-authorized') || msg.includes('NOT_AUTHORIZED'))
    return 'Нет доступа к этому ресурсу.';

  // Postgres errors — don't expose column names, constraints, etc.
  if (msg.includes('duplicate key') || msg.includes('unique constraint'))
    return 'Такая запись уже существует.';
  if (msg.includes('violates') || msg.includes('constraint'))
    return 'Ошибка при сохранении данных. Проверьте введённые значения.';
  if (msg.includes('connection') || msg.includes('ECONNREFUSED'))
    return 'Ошибка соединения с базой данных. Попробуйте позже.';

  // Generic fallback — safe but uninformative
  return 'Внутренняя ошибка сервера. Попробуйте позже.';
}
