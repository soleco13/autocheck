import SimpleDDP from 'simpleddp';
import ws from 'ws';
import { hashPassword } from '../lib/encryption';

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
    });

    client.on('error', (err: Error) => {
      console.error('[Edik DDP] error:', err.message);
    });

    client.on('disconnected', () => {
      console.warn('[Edik DDP] disconnected');
      currentEdikToken = null;
    });
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
    console.log('[Edik] Resume login...');
    const result = await c.call('login', { resume: edikResumeToken });
    currentEdikToken = result.token || edikResumeToken;
    console.log('[Edik] Resume login OK, userId:', result.id);
  } catch (err: any) {
    currentEdikToken = null;
    edikAuthInProgress = false;
    throw new Error(`[Edik] Auth failed: ${err?.reason || err?.message || err}`);
  }
  edikAuthInProgress = false;
}

// getMaterialSessionState works WITHOUT user auth — JWT provides authorization.
// getMaterialBySession requires auth (returns NOT_AUTHORIZED for anonymous users).
export async function getMaterialSessionState(token: string): Promise<any> {
  const c = getEdikClient();
  if (!c.connected) await connectEdik();
  return c.call('api.materials-sessions.getMaterialSessionState', { token });
}

// Optional: get material title. Requires Edik user auth. Falls back to null on NOT_AUTHORIZED.
export async function getMaterialBySession(accessToken: string, loginToken?: string): Promise<any> {
  const c = getEdikClient();
  if (!c.connected) await connectEdik();
  try {
    if (loginToken) await ensureEdikAuthenticated(loginToken);
    return await c.call('api.materials-sessions.getMaterialBySession', { accessToken });
  } catch (err: any) {
    if (err.message?.includes('NOT_AUTHORIZED') || err.message?.includes('not-authorized')) {
      return null; // Title unavailable without Edik auth — not critical
    }
    throw err;
  }
}

export async function getMaterial(materialId: string): Promise<any> {
  const c = getEdikClient();
  if (!c.connected) await connectEdik();
  return c.call('api.materials.getMaterial', { materialId });
}

export async function getChildMaterialsEdik(childId: string, lessonId?: string): Promise<any[]> {
  const c = getEdikClient();
  if (!c.connected) await connectEdik();
  const params: any = { childId };
  if (lessonId) params.lessonId = lessonId;
  return c.call('api.materials.getChildsMaterials', params);
}

/**
 * Attempts to get a JWT from Edik for a given materialId + studentId.
 * These methods live on Edik, not on Gena.
 */
export async function getMaterialSessionJwtFromEdik(
  materialId: string,
  studentId: string
): Promise<string | null> {
  const c = getEdikClient();
  if (!c.connected) await connectEdik();

  const attempts: Array<[string, object]> = [
    ['api.materials-sessions.createSession',   { materialId, studentId }],
    ['api.materials-sessions.createSession',   { materialId, childId: studentId }],
    ['api.materials-sessions.getTeacherToken', { materialId }],
    ['api.materials-sessions.getViewToken',    { materialId }],
    ['api.materials-sessions.getSession',      { materialId }],
  ];

  for (const [method, params] of attempts) {
    try {
      const result = await c.call(method, params);
      if (!result) continue;
      const jwt = result.accessToken || result.token || result.jwt || result.sessionToken ||
                  (typeof result === 'string' ? result : null);
      if (jwt && typeof jwt === 'string' && jwt.split('.').length === 3) {
        console.log(`[Edik] getMaterialSessionJwtFromEdik OK via ${method}`);
        return jwt;
      }
    } catch (err: any) {
      if (!err.message?.includes('[404]')) {
        console.warn(`[Edik] ${method} failed:`, err.message?.slice(0, 80));
      }
    }
  }
  return null;
}
