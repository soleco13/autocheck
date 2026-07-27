import { db } from '../db';
import { logger } from './logger';

// ── Parameter catalogue ───────────────────────────────────────────────────────
export interface ParamMeta {
  label:       string;
  description: string;
  category:    'ai' | 'platform_gena' | 'platform_edik' | 'checks' | 'cache' | 'rag';
  type:        'int';
  default:     number;
  min:         number;
  max:         number;
  /** false = restart required for change to take effect */
  live:        boolean;
  unit?:       string;
}

export const PARAM_META: Record<string, ParamMeta> = {
  // ── ИИ-проверка ─────────────────────────────────────────────────────────────
  ai_concurrency: {
    label: 'Параллельных ИИ-вызовов', unit: 'вызовов',
    description: 'Сколько ответов ученика проверяется ИИ одновременно в рамках одной работы.',
    category: 'ai', type: 'int', default: 5, min: 1, max: 10, live: true,
  },
  worker_concurrency: {
    label: 'Параллельных задач воркера', unit: 'задач',
    description: 'Сколько работ воркер обрабатывает одновременно. Изменение вступает в силу после перезапуска.',
    category: 'ai', type: 'int', default: 5, min: 1, max: 20, live: false,
  },
  anthropic_rpm: {
    label: 'Anthropic — лимит вызовов в минуту', unit: 'вызовов/мин',
    description: 'Максимум запросов к Claude API в минуту (глобально). Держите ниже лимита аккаунта Anthropic.',
    category: 'ai', type: 'int', default: 25, min: 5, max: 500, live: true,
  },

  // ── Платформа Gena ──────────────────────────────────────────────────────────
  gena_max_concurrent: {
    label: 'Gena — макс. одновременных запросов', unit: 'запросов',
    description: 'Семафор на параллельные DDP-вызовы к Gena. Защищает от перегрузки платформы.',
    category: 'platform_gena', type: 'int', default: 8, min: 1, max: 20, live: false,
  },
  gena_global_rpm: {
    label: 'Gena — лимит в минуту (глобально)', unit: 'запросов/мин',
    description: 'Максимум запросов к Gena в минуту от всех учителей вместе.',
    category: 'platform_gena', type: 'int', default: 200, min: 20, max: 600, live: false,
  },
  gena_per_teacher_rpm: {
    label: 'Gena — лимит в минуту (на учителя)', unit: 'запросов/мин',
    description: 'Максимум запросов к Gena в минуту от одного учителя. При массовой проверке нужно не менее 60.',
    category: 'platform_gena', type: 'int', default: 60, min: 5, max: 300, live: false,
  },
  gena_call_timeout_s: {
    label: 'Gena — таймаут вызова', unit: 'сек',
    description: 'Если Gena не ответила за это время — запрос отменяется.',
    category: 'platform_gena', type: 'int', default: 15, min: 5, max: 60, live: true,
  },
  gena_circuit_threshold: {
    label: 'Gena — порог circuit breaker', unit: 'ошибок',
    description: 'После стольких ошибок подряд все запросы к Gena блокируются на время восстановления.',
    category: 'platform_gena', type: 'int', default: 5, min: 2, max: 20, live: true,
  },
  gena_circuit_recovery_s: {
    label: 'Gena — восстановление circuit breaker', unit: 'сек',
    description: 'Сколько секунд circuit breaker остаётся открытым перед пробной попыткой.',
    category: 'platform_gena', type: 'int', default: 60, min: 15, max: 300, live: true,
  },

  // ── Платформа Edik ──────────────────────────────────────────────────────────
  edik_max_concurrent: {
    label: 'Edik — макс. одновременных запросов', unit: 'запросов',
    description: 'Семафор на параллельные DDP-вызовы к Edik.',
    category: 'platform_edik', type: 'int', default: 5, min: 1, max: 15, live: false,
  },
  edik_global_rpm: {
    label: 'Edik — лимит в минуту (глобально)', unit: 'запросов/мин',
    description: 'Максимум запросов к Edik в минуту от всех учителей вместе.',
    category: 'platform_edik', type: 'int', default: 120, min: 10, max: 600, live: false,
  },
  edik_per_teacher_rpm: {
    label: 'Edik — лимит в минуту (на учителя)', unit: 'запросов/мин',
    description: 'Максимум запросов к Edik в минуту от одного учителя.',
    category: 'platform_edik', type: 'int', default: 60, min: 5, max: 300, live: false,
  },
  edik_call_timeout_s: {
    label: 'Edik — таймаут вызова', unit: 'сек',
    description: 'Если Edik не ответил за это время — запрос отменяется.',
    category: 'platform_edik', type: 'int', default: 15, min: 5, max: 60, live: true,
  },
  edik_circuit_threshold: {
    label: 'Edik — порог circuit breaker', unit: 'ошибок',
    description: 'После стольких ошибок подряд все запросы к Edik блокируются.',
    category: 'platform_edik', type: 'int', default: 5, min: 2, max: 20, live: true,
  },
  edik_circuit_recovery_s: {
    label: 'Edik — восстановление circuit breaker', unit: 'сек',
    description: 'Сколько секунд circuit breaker Edik остаётся открытым.',
    category: 'platform_edik', type: 'int', default: 60, min: 15, max: 300, live: true,
  },

  // ── Проверки ─────────────────────────────────────────────────────────────────
  bulk_max_items: {
    label: 'Максимум работ в массовой проверке', unit: 'работ',
    description: 'Максимальное количество работ в одном запросе /checks/bulk.',
    category: 'checks', type: 'int', default: 100, min: 10, max: 2000, live: true,
  },
  inline_bulk_concurrency: {
    label: 'Параллельных inline-задач (без Redis)', unit: 'задач',
    description: 'Сколько работ обрабатывается одновременно в inline-режиме (без Redis/BullMQ). Слишком высокое значение перегружает платформу.',
    category: 'checks', type: 'int', default: 5, min: 1, max: 20, live: true,
  },
  stuck_job_timeout_min: {
    label: 'Таймаут зависших задач', unit: 'мин',
    description: 'Задачи в статусе processing дольше этого времени автоматически помечаются как failed.',
    category: 'checks', type: 'int', default: 15, min: 5, max: 120, live: true,
  },
  check_rate_per_min: {
    label: 'Проверок в минуту на учителя', unit: '/мин',
    description: 'Rate limit на POST /checks для одного учителя. Читается на каждый запрос — вступает в силу сразу.',
    category: 'checks', type: 'int', default: 30, min: 5, max: 200, live: true,
  },
  bulk_rate_per_min: {
    label: 'Массовых запросов в минуту на учителя', unit: '/мин',
    description: 'Rate limit на POST /checks/bulk для одного учителя. Вступает в силу сразу.',
    category: 'checks', type: 'int', default: 5, min: 1, max: 30, live: true,
  },

  // ── RAG / Учебники ───────────────────────────────────────────────────────────
  rag_mode: {
    label: 'Режим проверки',
    description: 'ИИ (0) — проверка только на основе знаний модели. Учебники (1) — ИИ опирается исключительно на загруженные учебники.',
    category: 'rag', type: 'int', default: 0, min: 0, max: 1, live: true,
  },
  rag_index_concurrency: {
    label: 'Параллельных задач индексирования', unit: 'задач',
    description: 'Сколько PDF-учебников обрабатывается одновременно. Изменение вступает в силу после перезапуска.',
    category: 'rag', type: 'int', default: 1, min: 1, max: 3, live: false,
  },
  rag_top_k: {
    label: 'Чанков контекста на проверку', unit: 'чанков',
    description: 'Сколько фрагментов учебника передаётся ИИ при каждой проверке ответа. Больше = точнее, но дороже.',
    category: 'rag', type: 'int', default: 5, min: 1, max: 15, live: true,
  },

  // ── Кеш ──────────────────────────────────────────────────────────────────────
  works_cache_ttl_min: {
    label: 'Кеш работ ученика', unit: 'мин',
    description: 'Как долго хранится кеш работ ученика с платформы до повторного запроса.',
    category: 'cache', type: 'int', default: 5, min: 1, max: 60, live: true,
  },
};

// ── Store ─────────────────────────────────────────────────────────────────────
class ConfigStore {
  private cache = new Map<string, number>();

  get(key: string): number {
    if (this.cache.has(key)) return this.cache.get(key)!;
    return PARAM_META[key]?.default ?? 0;
  }

  async set(key: string, value: number): Promise<void> {
    const meta = PARAM_META[key];
    if (!meta) throw new Error(`Unknown config key: ${key}`);
    const clamped = Math.max(meta.min, Math.min(meta.max, Math.round(value)));
    await db.query(
      `INSERT INTO system_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, String(clamped)],
    );
    this.cache.set(key, clamped);
  }

  async reset(key: string): Promise<void> {
    const meta = PARAM_META[key];
    if (!meta) throw new Error(`Unknown config key: ${key}`);
    await db.query('DELETE FROM system_config WHERE key = $1', [key]);
    this.cache.delete(key);
  }

  async load(): Promise<void> {
    try {
      const result = await db.query('SELECT key, value FROM system_config');
      for (const row of result.rows) {
        if (PARAM_META[row.key]) this.cache.set(row.key, parseInt(row.value, 10));
      }
      logger.info(`[config] Loaded ${result.rows.length} custom system params`);
    } catch {
      logger.warn('[config] system_config table not ready — using defaults');
    }
  }

  all(): Record<string, { value: number; isCustom: boolean; meta: ParamMeta }> {
    const out: Record<string, { value: number; isCustom: boolean; meta: ParamMeta }> = {};
    for (const [key, meta] of Object.entries(PARAM_META)) {
      out[key] = { value: this.get(key), isCustom: this.cache.has(key), meta };
    }
    return out;
  }
}

export const configStore = new ConfigStore();
