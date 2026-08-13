/**
 * Global sliding-window rate throttle for OpenRouter API calls.
 *
 * All callers (ai-checker, report-generator) await `aiThrottle.acquire()`
 * before making any OpenRouter API call. This proactively prevents 429 errors
 * instead of relying on SDK retry/backoff which causes cascading delays under bulk load.
 *
 * The limit is read from configStore on every acquire() so UI changes take effect
 * without a restart.
 */

let _cfg: any = null;
function cfg() {
  if (!_cfg) _cfg = require('./config-store').configStore;
  return _cfg;
}

class AiThrottle {
  private readonly timestamps: number[] = [];
  private readonly pending: Array<() => void> = [];
  private flushing = false;
  private readonly windowMs = 60_000;
  // Safety cap: reject new acquire() calls if this many are already waiting.
  // Prevents unbounded memory growth when a bulk batch outruns drain speed.
  private readonly maxQueueDepth = 500;

  private getMax(): number {
    try { return Math.max(1, cfg().get('openrouter_rpm')); } catch { return 25; }
  }

  /** Wait for an available OpenRouter API rate-limit slot. */
  acquire(): Promise<void> {
    if (this.pending.length >= this.maxQueueDepth) {
      return Promise.reject(new Error(`AI rate-limit queue full (${this.maxQueueDepth} waiting). Retry later.`));
    }
    return new Promise(resolve => {
      this.pending.push(resolve);
      if (!this.flushing) void this.flush();
    });
  }

  private async flush(): Promise<void> {
    this.flushing = true;
    while (this.pending.length > 0) {
      const now = Date.now();
      const cutoff = now - this.windowMs;
      let i = 0;
      while (i < this.timestamps.length && this.timestamps[i] <= cutoff) i++;
      if (i > 0) this.timestamps.splice(0, i);

      if (this.timestamps.length < this.getMax()) {
        this.timestamps.push(now);
        this.pending.shift()!();
      } else {
        const waitMs = this.timestamps[0] + this.windowMs - now + 1;
        await new Promise(r => setTimeout(r, Math.max(waitMs, 20)));
      }
    }
    this.flushing = false;
  }

  /** How many callers are currently waiting for a slot. */
  get pendingCount() { return this.pending.length; }
}

export const aiThrottle = new AiThrottle();
