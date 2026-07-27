/**
 * Thin Redis cache layer with graceful degradation.
 * All methods swallow errors so the app works even if Redis is down.
 * Uses a separate ioredis connection from the BullMQ queue connection.
 */
import IORedis from 'ioredis';

let _client: IORedis | null = null;

function getClient(): IORedis {
  if (!_client) {
    _client = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    _client.on('error', () => {}); // silent — cache miss is the fallback
  }
  return _client;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await getClient().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try { await getClient().setex(key, ttlSeconds, JSON.stringify(value)); } catch {}
}

export async function cacheDel(...keys: string[]): Promise<void> {
  try { if (keys.length > 0) await getClient().del(...keys); } catch {}
}

export async function cacheGetOrSet<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;
  const value = await fetcher();
  if (value !== null && value !== undefined) {
    await cacheSet(key, value, ttlSeconds);
  }
  return value;
}
