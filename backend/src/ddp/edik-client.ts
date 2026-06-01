import SimpleDDP from 'simpleddp';
import ws from 'ws';
import { hashPassword } from '../lib/encryption';
import { edikGuard, teacherKey, sanitizePlatformError } from '../lib/platform-guard';
import { logger } from '../lib/logger';

const EDIK_URL = 'wss://editor.good-teach.itgen.io/websocket';

let client: any = null;
let currentEdikToken: string | null = null;
let edikAuthInProgress = false;

export function getEdikClient(): any {
  if (!client) {
    client = new (SimpleDDP as any)({
      endpoint: EDIK_URL,
      SocketConstructor: ws,
      reconnectInterval: 5000,
      maxReconnectInterval: 60_000,
      reconnectBackoffMultiplier: 2,
    });

    client.on('error', (err: Error) => {
      if (!err.message?.includes('ECONNREFUSED') && !err.message?.includes('ETIMEDOUT')) {
        console.error('[Edik DDP] error:', err.message);
      }
    });

    client.on('disconnected', () => {
      logger.warn('[Edik DDP] disconnected');
      currentEdikToken = null;
      edikAuthInProgress = false;
    });
    client.on('connected', () => logger.info('[Edik DDP] connected'));
  }
  return client;
}

export async function connectEdik(): Promise<void> {
  const c = getEdikClient();
  if (!c.connected) {
    await c.connect();
    console.log('✅ Edik DDP connected');
  }
}

/**
 * Login to Edik with email + password.
 * Returns the Edik resume token and expiry.
 */
export async function loginToEdik(email: string, password: string): Promise<{ token: string; tokenExpires: Date; userId: string }> {
  const c = getEdikClient();
  if (!c.connected) await connectEdik();

  const digest = hashPassword(password);
  const result = await c.call('login', {
    user: { email },
    password: { digest, algorithm: 'sha-256' },
  });
  currentEdikToken = result.token;
  return {
    userId: result.id,
    token: result.token,
    tokenExpires: new Date(result.tokenExpires),
  };
}

/**
 * Authenticates to Edik using a stored Edik resume token.
 */
export async function ensureEdikAuthenticated(edikResumeToken: string): Promise<void> {
  const c = getEdikClient();
  if (!c.connected) await connectEdik();
  if (currentEdikToken === edikResumeToken && !edikAuthInProgress) return;

  edikAuthInProgress = true;
  try {
    logger.debug('[Edik] Resume auth...');
    const result = await c.call('login', { resume: edikResumeToken });
    currentEdikToken = result.token || edikResumeToken;
    logger.debug('[Edik] Resume auth OK');
  } catch (err: any) {
    currentEdikToken = null;
    edikAuthInProgress = false;
    throw new Error(`[Edik] Auth failed: ${err?.reason || err?.message || err}`);
  }
  edikAuthInProgress = false;
}

// getMaterialSessionState works WITHOUT user auth — JWT provides authorization.
export async function getMaterialSessionState(token: string): Promise<any> {
  const c = getEdikClient();
  if (!c.connected) await connectEdik();
  // Dedupe: same session state requested by multiple concurrent checks → one call
  return edikGuard.call(
    'anon',  // no teacher context — keyed globally
    `edik:sessionState:${token}`,
    () => c.call('api.materials-sessions.getMaterialSessionState', { token }),
  );
}

// Optional: get material title. Requires Edik user auth. Falls back to null on NOT_AUTHORIZED.
export async function getMaterialBySession(accessToken: string, loginToken?: string): Promise<any> {
  const c = getEdikClient();
  if (!c.connected) await connectEdik();
  const tk = loginToken ? teacherKey(loginToken) : 'anon';
  try {
    if (loginToken) await ensureEdikAuthenticated(loginToken);
    return await edikGuard.call(
      tk,
      `edik:bySession:${accessToken}`,
      () => c.call('api.materials-sessions.getMaterialBySession', { accessToken }),
    );
  } catch (err: any) {
    if (err.message?.includes('NOT_AUTHORIZED') || err.message?.includes('not-authorized') || err.message?.includes('доступа')) {
      return null;
    }
    throw err;
  }
}

export async function getMaterial(materialId: string): Promise<any> {
  const c = getEdikClient();
  if (!c.connected) await connectEdik();
  return edikGuard.call(
    'anon',
    `edik:material:${materialId}`,
    () => c.call('api.materials.getMaterial', { materialId }),
  );
}

export async function getChildMaterialsEdik(childId: string, lessonId?: string): Promise<any[]> {
  const c = getEdikClient();
  if (!c.connected) await connectEdik();
  const params: any = { childId };
  if (lessonId) params.lessonId = lessonId;
  return edikGuard.call(
    'anon',
    null,
    () => c.call('api.materials.getChildsMaterials', params),
  );
}

/**
 * Attempts to get a JWT from Edik for a given materialId + studentId.
 * These methods live on Edik, not on Gena.
 */
export async function getMaterialSessionJwtFromEdik(
  materialId: string,
  studentId: string,
  loginToken?: string,
): Promise<string | null> {
  const c = getEdikClient();
  if (!c.connected) await connectEdik();
  const tk = loginToken ? teacherKey(loginToken) : 'anon';

  // Try methods in order — stop at first success
  const attempts: Array<[string, object]> = [
    ['api.materials-sessions.createSession',   { materialId, studentId }],
    ['api.materials-sessions.createSession',   { materialId, childId: studentId }],
    ['api.materials-sessions.getTeacherToken', { materialId }],
    ['api.materials-sessions.getViewToken',    { materialId }],
    ['api.materials-sessions.getSession',      { materialId }],
  ];

  for (const [method, params] of attempts) {
    try {
      const result = await edikGuard.call(
        tk,
        null,  // no dedup — each attempt is distinct
        () => c.call(method, params),
      );
      if (!result) continue;
      const r = result as any;
      const jwt = r.accessToken || r.token || r.jwt || r.sessionToken ||
                  (typeof result === 'string' ? result : null);
      if (jwt && typeof jwt === 'string' && jwt.split('.').length === 3) {
        return jwt;
      }
    } catch (err: any) {
      // 404 → method doesn't exist on this platform — try next silently
      if (!err.message?.includes('[404]') && !err.message?.includes('не найден')) {
        logger.debug({ msg: err.message?.slice(0, 60) }, '[Edik] session JWT attempt failed');
      }
    }
  }
  return null;
}
