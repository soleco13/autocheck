import { logger } from './logger';

// Lazy import to avoid circular dependency at module init
let _cfg: any = null;
function cfg() {
  if (!_cfg) _cfg = require('./config-store').configStore;
  return _cfg;
}

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

/** Binary semaphore — limits concurrent executions. Reads max dynamically so configStore changes apply. */
class Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly getMax: () => number) {}

  acquire(): Promise<void> {
    if (this.running < this.getMax()) { this.running++; return Promise.resolve(); }
    return new Promise(res => this.queue.push(res));
  }

  release(): void {
    this.running = Math.max(0, this.running - 1);
    // Drain multiple waiters if max increased since last check
    while (this.queue.length > 0 && this.running < this.getMax()) {
      this.running++;
      this.queue.shift()!();
    }
  }

  get active() { return this.running; }
  get queued() { return this.queue.length; }
}

/**
 * Sliding-window rate limiter that QUEUES callers instead of rejecting them.
 * When the rate limit is reached, `acquire()` waits until a slot opens rather
 * than throwing RATE_LIMIT_* errors. This prevents cascade failures under bulk load.
 */
class ThrottledRateLimiter {
  private readonly timestamps: number[] = [];
  private readonly pending: Array<() => void> = [];
  private flushing = false;

  constructor(
    private readonly getMax: () => number,
    private readonly windowMs: number,
  ) {}

  /** Resolves when a rate-limit slot is available (may wait). */
  acquire(): Promise<void> {
    return new Promise(resolve => {
      this.pending.push(resolve);
      if (!this.flushing) void this.flush();
    });
  }

  private async flush(): Promise<void> {
    this.flushing = true;
    while (this.pending.length > 0) {
      const now = Date.now();
      // Remove timestamps that have left the sliding window
      const cutoff = now - this.windowMs;
      let i = 0;
      while (i < this.timestamps.length && this.timestamps[i] <= cutoff) i++;
      if (i > 0) this.timestamps.splice(0, i);

      if (this.timestamps.length < this.getMax()) {
        this.timestamps.push(now);
        this.pending.shift()!();  // grant the slot
      } else {
        // Wait until the oldest call drops out of the window
        const waitMs = this.timestamps[0] + this.windowMs - now + 1;
        await new Promise(r => setTimeout(r, Math.max(waitMs, 10)));
      }
    }
    this.flushing = false;
  }

  get pendingCount() { return this.pending.length; }

  gc(): void {
    const cutoff = Date.now() - this.windowMs;
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i] <= cutoff) i++;
    if (i > 0) this.timestamps.splice(0, i);
  }
}

/**
 * Per-key map of ThrottledRateLimiters (one per teacher / per-resource key).
 * Each key has its own sliding window so one teacher can't exhaust another's quota.
 */
class KeyedThrottledRateLimiter {
  private readonly map = new Map<string, ThrottledRateLimiter>();

  constructor(
    private readonly getMax: () => number,
    private readonly windowMs: number,
  ) {}

  acquire(key: string): Promise<void> {
    let rl = this.map.get(key);
    if (!rl) {
      rl = new ThrottledRateLimiter(this.getMax, this.windowMs);
      this.map.set(key, rl);
    }
    return rl.acquire();
  }

  gc(): void {
    for (const [key, rl] of this.map) {
      rl.gc();
      // Evict idle limiters to prevent unbounded memory growth
      if (rl.pendingCount === 0) this.map.delete(key);
    }
  }

  pendingTotal(): number {
    let total = 0;
    for (const rl of this.map.values()) total += rl.pendingCount;
    return total;
  }
}

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Circuit breaker that reads thresholds from configStore at runtime. */
class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private lastFailureAt = 0;

  constructor(
    private readonly thresholdKey: string,
    private readonly recoveryKey: string,
    private readonly name: string,
    private readonly staticThreshold: number,
    private readonly staticRecoveryMs: number,
  ) {}

  private get threshold() {
    try { return cfg().get(this.thresholdKey); } catch { return this.staticThreshold; }
  }
  private get recoveryMs() {
    try { return cfg().get(this.recoveryKey) * 1000; } catch { return this.staticRecoveryMs; }
  }

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
    if (this.failures >= this.threshold && this.state !== 'OPEN') {
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
  /api\.[a-zA-Z.-]+/g,
  /wss?:\/\/[^\s]+/g,
  /https?:\/\/[^\s]+/g,
  /(good-teach|itgen\.io)/gi,
  /\b[A-Za-z0-9+/]{40,}\b/g,
];

export function sanitizePlatformError(err: any): Error {
  let msg: string = err?.reason || err?.message || 'Platform error';

  if (msg.includes('PLATFORM_TIMEOUT'))   return new Error('Платформа не ответила вовремя');
  if (msg.includes('CIRCUIT_OPEN'))       return new Error('Платформа временно недоступна. Повторите позже.');
  if (msg.includes('not-authorized') || msg.includes('NOT_AUTHORIZED')) return new Error('Нет доступа к материалу на платформе');
  if (msg.includes('[404]'))              return new Error('Материал не найден на платформе');
  if (msg.includes('Auth failed') || msg.includes('DDP auth')) return new Error('Ошибка авторизации на платформе');

  for (const pattern of INTERNAL_PATTERNS) msg = msg.replace(pattern, '[internal]');
  return new Error(msg.slice(0, 200));
}

// ─────────────────────────────────────────────────────────────────────────────
// PlatformGuard — ties everything together
// ─────────────────────────────────────────────────────────────────────────────
export interface GuardConfig {
  maxConcurrent: number;
  globalRpm: number;
  perTeacherRpm: number;
  callTimeoutMs: number;
  failureThreshold: number;
  recoveryMs: number;
  /** Config keys for dynamic values (live-configurable via settings UI) */
  timeoutKey: string;
  thresholdKey: string;
  recoveryKey: string;
  /** Optional config key for max concurrent (reads from configStore, falls back to maxConcurrent) */
  maxConcurrentKey?: string;
  /** Optional config keys for live-configurable RPM limits */
  globalRpmKey?: string;
  perTeacherRpmKey?: string;
}

export class PlatformGuard {
  private readonly semaphore: Semaphore;
  private readonly globalRL: ThrottledRateLimiter;
  private readonly perTeacherRL: KeyedThrottledRateLimiter;
  private readonly cb: CircuitBreaker;
  private readonly dedup: InFlightDedup;
  private readonly gcfg: GuardConfig;

  constructor(private readonly name: string, gcfg: GuardConfig) {
    this.gcfg = gcfg;
    this.semaphore = new Semaphore(
      () => { try { return gcfg.maxConcurrentKey ? cfg().get(gcfg.maxConcurrentKey) : gcfg.maxConcurrent; } catch { return gcfg.maxConcurrent; } },
    );

    const { globalRpmKey, perTeacherRpmKey } = gcfg;
    this.globalRL = new ThrottledRateLimiter(
      () => { try { return globalRpmKey ? cfg().get(globalRpmKey) : gcfg.globalRpm; } catch { return gcfg.globalRpm; } },
      60_000,
    );
    this.perTeacherRL = new KeyedThrottledRateLimiter(
      () => { try { return perTeacherRpmKey ? cfg().get(perTeacherRpmKey) : gcfg.perTeacherRpm; } catch { return gcfg.perTeacherRpm; } },
      60_000,
    );
    this.cb    = new CircuitBreaker(gcfg.thresholdKey, gcfg.recoveryKey, name, gcfg.failureThreshold, gcfg.recoveryMs);
    this.dedup = new InFlightDedup();

    // Periodically clean up idle per-teacher limiters
    setInterval(() => this.perTeacherRL.gc(), 5 * 60_000).unref();
  }

  /**
   * Execute a platform call through all guard layers.
   *
   * Rate limits THROTTLE (queue and wait) instead of reject — bulk jobs never
   * cascade-fail due to rate limits. Only circuit-open causes immediate failure.
   *
   * @param teacherKey - Per-teacher rate limit bucket key (use hashed token)
   * @param dedupKey   - If set, identical in-flight calls share one Promise
   * @param fn         - The actual DDP call
   */
  async call<T>(teacherKey: string, dedupKey: string | null, fn: () => Promise<T>): Promise<T> {
    // 1. Circuit breaker — fail-fast when platform is known-down
    if (this.cb.isOpen()) throw new Error('CIRCUIT_OPEN');

    // 2. Global rate limit — WAIT for a slot (never reject)
    await this.globalRL.acquire();

    // 3. Per-teacher rate limit — WAIT for a slot (never reject)
    await this.perTeacherRL.acquire(teacherKey);

    // 4. Re-check circuit after potentially waiting (it may have opened while we waited)
    if (this.cb.isOpen()) throw new Error('CIRCUIT_OPEN');

    // 5. Concurrency semaphore — queue until a concurrent slot opens
    await this.semaphore.acquire();

    let timeoutMs = this.gcfg.callTimeoutMs;
    try { timeoutMs = cfg().get(this.gcfg.timeoutKey) * 1000; } catch { /* use static */ }
    const execute = () => withTimeout(fn(), timeoutMs);

    try {
      const result = dedupKey
        ? await this.dedup.run(dedupKey, execute)
        : await execute();
      this.cb.onSuccess();
      logger.debug({ platform: this.name, concurrent: this.semaphore.active, inflight: this.dedup.size }, 'platform call ok');
      return result;
    } catch (err: any) {
      // Application-level errors (expired auth token, 404, method not found) are NOT
      // infrastructure failures — the platform is reachable, the request just got rejected.
      // Only count genuine infrastructure failures (timeout, connection loss) against the
      // circuit breaker so that optional/auth-failing calls don't poison it for critical ones.
      const raw = String(err?.reason || err?.message || '');
      const isAppError =
        raw.includes('not-authorized') || raw.includes('NOT_AUTHORIZED') ||
        raw.includes('[404]') || raw.includes('not found') ||
        raw.includes('Auth failed') || raw.includes('DDP auth') ||
        raw.includes('403') || raw.includes('Method not found');
      if (!isAppError) this.cb.onFailure();
      throw sanitizePlatformError(err);
    } finally {
      this.semaphore.release();
    }
  }

  status() {
    return {
      platform:       this.name,
      circuit:        this.cb.currentState,
      concurrent:     this.semaphore.active,
      queued:         this.semaphore.queued,
      inflight:       this.dedup.size,
      globalPending:  this.globalRL.pendingCount,
      teacherPending: this.perTeacherRL.pendingTotal(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton guards
// ─────────────────────────────────────────────────────────────────────────────

export const genaGuard = new PlatformGuard('Gena', {
  maxConcurrent: 8, globalRpm: 200, perTeacherRpm: 60,
  callTimeoutMs: 15_000, failureThreshold: 5, recoveryMs: 60_000,
  maxConcurrentKey: 'gena_max_concurrent',
  timeoutKey: 'gena_call_timeout_s', thresholdKey: 'gena_circuit_threshold', recoveryKey: 'gena_circuit_recovery_s',
  globalRpmKey: 'gena_global_rpm', perTeacherRpmKey: 'gena_per_teacher_rpm',
});

export const edikGuard = new PlatformGuard('Edik', {
  maxConcurrent: 5, globalRpm: 120, perTeacherRpm: 60,
  callTimeoutMs: 15_000, failureThreshold: 5, recoveryMs: 60_000,
  maxConcurrentKey: 'edik_max_concurrent',
  timeoutKey: 'edik_call_timeout_s', thresholdKey: 'edik_circuit_threshold', recoveryKey: 'edik_circuit_recovery_s',
  globalRpmKey: 'edik_global_rpm', perTeacherRpmKey: 'edik_per_teacher_rpm',
});

/** Derive a stable per-teacher key from a login token (never log full token). */
export function teacherKey(loginToken: string): string {
  return loginToken.slice(-12);
}
