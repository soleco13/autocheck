import { logger } from './logger';

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** Wraps a promise with a hard timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const race = new Promise<T>((_, reject) => {
    t = setTimeout(() => reject(new Error('PLATFORM_TIMEOUT')), ms);
  });
  return Promise.race([promise, race]).finally(() => clearTimeout(t));
}

/** Binary semaphore — limits concurrent executions. */
class Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}

  acquire(): Promise<void> {
    if (this.running < this.max) { this.running++; return Promise.resolve(); }
    return new Promise(res => this.queue.push(res));
  }

  release(): void {
    this.running = Math.max(0, this.running - 1);
    const next = this.queue.shift();
    if (next) { this.running++; next(); }
  }

  get active() { return this.running; }
  get queued() { return this.queue.length; }
}

/** Sliding-window rate limiter keyed by string (teacherToken or 'global'). */
class RateLimiter {
  private readonly windows = new Map<string, { count: number; reset: number }>();
  constructor(private readonly max: number, private readonly windowMs: number) {}

  allow(key: string): boolean {
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || now > w.reset) {
      this.windows.set(key, { count: 1, reset: now + this.windowMs });
      return true;
    }
    if (w.count >= this.max) return false;
    w.count++;
    return true;
  }

  /** Remove stale windows to prevent memory leak. */
  gc(): void {
    const now = Date.now();
    for (const [k, w] of this.windows) if (now > w.reset) this.windows.delete(k);
  }
}

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Circuit breaker: CLOSED → OPEN after N failures → HALF_OPEN after recovery → CLOSED on success. */
class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private lastFailureAt = 0;

  constructor(
    private readonly failThreshold: number,
    private readonly recoveryMs: number,
    private readonly name: string,
  ) {}

  isOpen(): boolean {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureAt >= this.recoveryMs) {
        this.state = 'HALF_OPEN';
        logger.warn(`[CB:${this.name}] → HALF_OPEN (testing recovery)`);
        return false;
      }
      return true;
    }
    return false;
  }

  onSuccess(): void {
    if (this.state !== 'CLOSED') logger.info(`[CB:${this.name}] → CLOSED (recovered)`);
    this.failures = 0;
    this.state = 'CLOSED';
  }

  onFailure(): void {
    this.failures++;
    this.lastFailureAt = Date.now();
    if (this.failures >= this.failThreshold && this.state !== 'OPEN') {
      this.state = 'OPEN';
      logger.error(`[CB:${this.name}] → OPEN after ${this.failures} failures. Pausing ${this.recoveryMs / 1000}s.`);
    }
  }

  get currentState(): CircuitState { return this.state; }
}

/** Deduplicates identical in-flight calls — returns the same Promise to all callers. */
class InFlightDedup {
  private readonly cache = new Map<string, Promise<any>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.cache.get(key);
    if (existing) return existing as Promise<T>;
    const p = fn().finally(() => this.cache.delete(key));
    this.cache.set(key, p);
    return p;
  }

  get size() { return this.cache.size; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error sanitization — never expose internal DDP method names or platform URLs
// ─────────────────────────────────────────────────────────────────────────────
const INTERNAL_PATTERNS = [
  /api\.[a-zA-Z.-]+/g,           // DDP method names like api.materials.getChildsMaterials
  /wss?:\/\/[^\s]+/g,            // WebSocket URLs
  /https?:\/\/[^\s]+/g,          // HTTP URLs
  /(good-teach|itgen\.io)/gi,    // Platform domain
  /\b[A-Za-z0-9+/]{40,}\b/g,    // Long base64 tokens
];

export function sanitizePlatformError(err: any): Error {
  let msg: string = err?.reason || err?.message || 'Platform error';

  // Generic messages for well-known errors — never expose internals
  if (msg.includes('PLATFORM_TIMEOUT'))   return new Error('Платформа не ответила вовремя');
  if (msg.includes('CIRCUIT_OPEN'))       return new Error('Платформа временно недоступна. Повторите позже.');
  if (msg.includes('RATE_LIMIT'))         return new Error('Слишком много запросов к платформе. Подождите минуту.');
  if (msg.includes('not-authorized') || msg.includes('NOT_AUTHORIZED')) return new Error('Нет доступа к материалу на платформе');
  if (msg.includes('[404]'))              return new Error('Материал не найден на платформе');
  if (msg.includes('Auth failed') || msg.includes('DDP auth')) return new Error('Ошибка авторизации на платформе');

  // Strip internal details from unknown errors
  for (const pattern of INTERNAL_PATTERNS) msg = msg.replace(pattern, '[internal]');
  return new Error(msg.slice(0, 200));
}

// ─────────────────────────────────────────────────────────────────────────────
// PlatformGuard — ties everything together
// ─────────────────────────────────────────────────────────────────────────────
export interface GuardConfig {
  /** Max simultaneous calls to this platform. */
  maxConcurrent: number;
  /** Max calls per minute globally (all teachers). */
  globalRpm: number;
  /** Max calls per minute per teacher token. */
  perTeacherRpm: number;
  /** Hard timeout per DDP call (ms). */
  callTimeoutMs: number;
  /** Failures before circuit opens. */
  failureThreshold: number;
  /** How long circuit stays OPEN before HALF_OPEN retry (ms). */
  recoveryMs: number;
}

export class PlatformGuard {
  private readonly semaphore: Semaphore;
  private readonly globalRL: RateLimiter;
  private readonly perTeacherRL: RateLimiter;
  private readonly cb: CircuitBreaker;
  private readonly dedup: InFlightDedup;
  private readonly cfg: GuardConfig;

  constructor(private readonly name: string, cfg: GuardConfig) {
    this.cfg = cfg;
    this.semaphore   = new Semaphore(cfg.maxConcurrent);
    this.globalRL    = new RateLimiter(cfg.globalRpm, 60_000);
    this.perTeacherRL = new RateLimiter(cfg.perTeacherRpm, 60_000);
    this.cb          = new CircuitBreaker(cfg.failureThreshold, cfg.recoveryMs, name);
    this.dedup       = new InFlightDedup();

    // Periodic GC for rate limiter maps (every 5 min)
    setInterval(() => { this.globalRL.gc(); this.perTeacherRL.gc(); }, 5 * 60_000).unref();
  }

  /**
   * Execute a platform call through all guard layers.
   * @param teacherKey - Teacher identifier for per-user rate limiting (use hashed token)
   * @param dedupKey   - If set, identical in-flight calls with same key share one Promise
   * @param fn         - The actual DDP call to make
   */
  async call<T>(teacherKey: string, dedupKey: string | null, fn: () => Promise<T>): Promise<T> {
    // 1. Circuit breaker
    if (this.cb.isOpen()) {
      throw new Error('CIRCUIT_OPEN');
    }

    // 2. Global rate limit
    if (!this.globalRL.allow('global')) {
      logger.warn(`[Guard:${this.name}] Global rate limit hit`);
      throw new Error('RATE_LIMIT_GLOBAL');
    }

    // 3. Per-teacher rate limit
    if (!this.perTeacherRL.allow(teacherKey)) {
      logger.warn(`[Guard:${this.name}] Per-teacher rate limit hit for key …${teacherKey.slice(-6)}`);
      throw new Error('RATE_LIMIT_TEACHER');
    }

    // 4. Acquire concurrency slot (queues if all slots busy)
    await this.semaphore.acquire();

    const execute = () => withTimeout(fn(), this.cfg.callTimeoutMs);

    try {
      const result = dedupKey
        ? await this.dedup.run(dedupKey, execute)
        : await execute();

      this.cb.onSuccess();
      logger.debug({ platform: this.name, concurrent: this.semaphore.active, inflight: this.dedup.size }, 'platform call ok');
      return result;
    } catch (err: any) {
      this.cb.onFailure();
      throw sanitizePlatformError(err);
    } finally {
      this.semaphore.release();
    }
  }

  status() {
    return {
      platform: this.name,
      circuit: this.cb.currentState,
      concurrent: this.semaphore.active,
      queued: this.semaphore.queued,
      inflight: this.dedup.size,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton guards — one per external platform
// ─────────────────────────────────────────────────────────────────────────────

/** Guard for Gena (platform.good-teach.itgen.io) */
export const genaGuard = new PlatformGuard('Gena', {
  maxConcurrent:    5,    // max 5 DDP calls in-flight simultaneously
  globalRpm:        80,   // max 80 platform calls/min across all teachers
  perTeacherRpm:    20,   // max 20 calls/min per teacher
  callTimeoutMs:    15_000,
  failureThreshold: 5,    // open circuit after 5 consecutive failures
  recoveryMs:       60_000,
});

/** Guard for Edik (editor.good-teach.itgen.io) */
export const edikGuard = new PlatformGuard('Edik', {
  maxConcurrent:    3,
  globalRpm:        40,
  perTeacherRpm:    10,
  callTimeoutMs:    15_000,
  failureThreshold: 5,
  recoveryMs:       60_000,
});

/** Derive a stable per-teacher key from a login token (never log full token). */
export function teacherKey(loginToken: string): string {
  // Use last 12 chars — enough for bucketing, not enough to reconstruct token
  return loginToken.slice(-12);
}
