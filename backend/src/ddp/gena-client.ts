import SimpleDDP from 'simpleddp';
import ws from 'ws';
import { hashPassword } from '../lib/encryption';

const GENA_URL = 'wss://platform.good-teach.itgen.io/websocket';

let client: any = null;
let currentAuthToken: string | null = null;
let authInProgress = false;

export function getGenaClient(): any {
  if (!client) {
    client = new (SimpleDDP as any)({
      endpoint: GENA_URL,
      SocketConstructor: ws,
      reconnectInterval: 5000,
    });
    client.on('error', (err: Error) => console.error('[Gena DDP] error:', err.message));
    client.on('disconnected', () => {
      console.warn('[Gena DDP] disconnected — clearing auth state');
      currentAuthToken = null;
    });
    client.on('connected', () => console.log('[Gena DDP] connected'));
  }
  return client;
}

export async function connectGena(): Promise<void> {
  const c = getGenaClient();
  if (!c.connected) {
    await c.connect();
    console.log('✅ Gena DDP connected');
  }
}

export interface LoginResult {
  userId: string;
  token: string;
  tokenExpires: Date;
}

export async function loginTeacher(email: string, password: string): Promise<LoginResult> {
  const c = getGenaClient();
  if (!c.connected) await connectGena();

  const digest = hashPassword(password);
  console.log('[Gena] Calling login with email:', email);
  const result = await c.call('login', {
    user: { email },
    password: { digest, algorithm: 'sha-256' },
  });
  currentAuthToken = result.token;
  return {
    userId: result.id,
    token: result.token,
    tokenExpires: new Date(result.tokenExpires),
  };
}

async function ensureAuthenticated(loginToken: string): Promise<void> {
  const c = getGenaClient();
  if (!c.connected) await connectGena();
  if (currentAuthToken === loginToken && !authInProgress) return;

  authInProgress = true;
  try {
    console.log('[Gena] Resume login...');
    const result = await c.call('login', { resume: loginToken });
    currentAuthToken = result.token || loginToken;
    console.log('[Gena] Resume login OK, userId:', result.id);
  } catch (err: any) {
    currentAuthToken = null;
    authInProgress = false;
    throw new Error(`DDP auth failed: ${err?.reason || err?.message || err}`);
  }
  authInProgress = false;
}

export async function callGena(loginToken: string, method: string, ...params: any[]): Promise<any> {
  await ensureAuthenticated(loginToken);
  const c = getGenaClient();

  console.log(`[Gena] Calling method: ${method}`, params.length ? JSON.stringify(params) : '');
  try {
    const result = await c.call(method, ...params);
    console.log(`[Gena] ${method} OK, result type:`, typeof result, Array.isArray(result) ? `length=${result.length}` : '');
    return result;
  } catch (err: any) {
    const errMsg = err?.reason || err?.message || String(err);
    console.error(`[Gena] ${method} FAILED:`, JSON.stringify(err));
    throw new Error(`DDP method ${method} failed: ${errMsg}`);
  }
}

/**
 * Returns teacher's student list.
 * Primary: api.clazzes.getMyStudents (confirmed from HAR).
 * Fallback: api.users.getTrainerChilds.
 */
export async function getMyStudents(loginToken: string, teacherPlatformId?: string): Promise<any[]> {
  try {
    const result = await callGena(loginToken, 'api.clazzes.getMyStudents', {});
    if (Array.isArray(result) && result.length > 0) {
      console.log(`[Gena] getMyStudents: ${result.length} students, keys:`, Object.keys(result[0]));
      return result;
    }
    for (const key of ['students', 'children', 'data', 'items']) {
      if (result?.[key] && Array.isArray(result[key]) && result[key].length > 0) return result[key];
    }
  } catch (err: any) {
    console.warn('[Gena] getMyStudents failed:', err.message);
  }

  // Fallback: trainer account method
  if (teacherPlatformId) {
    try {
      const result = await callGena(loginToken, 'api.users.getTrainerChilds', { trainerId: teacherPlatformId });
      if (Array.isArray(result)) {
        console.log(`[Gena] getTrainerChilds fallback: ${result.length} students`);
        return result;
      }
    } catch (err: any) {
      console.warn('[Gena] getTrainerChilds failed:', err.message);
    }
  }

  return [];
}

/**
 * Returns list of materials for a student from Gena.
 * API expects childsIds array (not singular childId).
 * Response: [{_id: childId, materials: [{materialId, activity, interactiveData}]}]
 */
export async function getChildsMaterials(
  loginToken: string,
  childId: string,
  teacherPlatformId?: string
): Promise<any[]> {
  // Platform API uses childsIds (array), not childId (string)
  // trainerId is NOT passed — the API works without it and may filter incorrectly with it
  const params: any = { childsIds: [childId] };
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const delay = 100 * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
      console.log(`[Gena] getChildsMaterials retry ${attempt}/${maxAttempts}`);
    }
    try {
      const result = await callGena(loginToken, 'api.materials.getChildsMaterials', params);
      if (Array.isArray(result) && result.length > 0) {
        // Response is [{_id: childId, materials: [...]}]
        const studentData = result.find((r: any) => r._id === childId) || result[0];
        const materials: any[] = studentData?.materials || [];
        console.log(`[Gena] getChildsMaterials: ${materials.length} materials for child ${childId}`);
        return materials;
      }
      return [];
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('[404]')) return [];
      if (attempt === maxAttempts) {
        console.warn('[Gena] getChildsMaterials all retries exhausted:', msg.slice(0, 80));
      }
    }
  }
  return [];
}

/**
 * Attempts to get a JWT for a specific material session from Gena.
 * The JWT is used to call Edik (getMaterialBySession / getMaterialSessionState).
 * Returns null if no method works — caller falls back to TEST_JWT.
 */
export async function getMaterialSessionJwt(
  loginToken: string,
  sessionOrMaterialId: string,
  studentId: string
): Promise<string | null> {
  const attempts: Array<[string, object]> = [
    ['api.materials-sessions.getSession',      { sessionId: sessionOrMaterialId }],
    ['api.materials-sessions.getById',         { id: sessionOrMaterialId }],
    ['api.materials-sessions.getTeacherToken', { sessionId: sessionOrMaterialId }],
    ['api.materials-sessions.getViewToken',    { sessionId: sessionOrMaterialId }],
    ['api.materials-sessions.createSession',   { materialId: sessionOrMaterialId, studentId }],
    ['api.materials-sessions.createSession',   { materialId: sessionOrMaterialId, childId: studentId }],
  ];

  for (const [method, params] of attempts) {
    try {
      const result = await callGena(loginToken, method, params);
      if (!result) continue;
      const jwt = result.accessToken || result.token || result.jwt || result.sessionToken ||
                  (typeof result === 'string' ? result : null);
      if (jwt && typeof jwt === 'string' && jwt.split('.').length === 3) {
        console.log(`[Gena] getMaterialSessionJwt OK via ${method}`);
        return jwt;
      }
    } catch (err: any) {
      // Silently skip 404s; log others
      if (!err.message?.includes('[404]')) {
        console.warn(`[Gena] ${method} failed:`, err.message?.slice(0, 60));
      }
    }
  }
  return null;
}

// In-memory cache for material titles (30-min TTL)
let _titleCacheTime = 0;
let _titleCache: Map<string, string> | null = null;
const TITLE_CACHE_TTL = 30 * 60 * 1000;

/**
 * Returns a materialId → title map using getAllBranchesWithMaterialsBySkills.
 * Result is cached in memory for 30 minutes.
 */
export async function getMaterialTitleMap(loginToken: string): Promise<Map<string, string>> {
  const now = Date.now();
  if (_titleCache && (now - _titleCacheTime) < TITLE_CACHE_TTL) {
    return _titleCache;
  }
  const map = new Map<string, string>();
  try {
    await ensureAuthenticated(loginToken);
    const branches = await callGena(loginToken, 'api.materials.getAllBranchesWithMaterialsBySkills', {});
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        if (!Array.isArray(branch.materials)) continue;
        for (const mat of branch.materials) {
          if (mat._id && mat.title) map.set(mat._id, mat.title);
        }
      }
    }
  } catch (err: any) {
    console.warn('[gena] getMaterialTitleMap failed:', err.message?.slice(0, 80));
  }
  _titleCache = map;
  _titleCacheTime = now;
  return map;
}

/**
 * Fetches teacher's classrooms from the platform.
 * Method: api.classRooms.getClassRooms (confirmed via DDP exploration).
 * Response: [{ _id, name, childs: [{ id: platformStudentId, fullName }] }]
 */
export async function getMyClazzes(loginToken: string): Promise<any[]> {
  try {
    const result = await callGena(loginToken, 'api.classRooms.getClassRooms', {});
    if (Array.isArray(result) && result.length > 0) {
      console.log(`[Gena] getMyClazzes: ${result.length} classrooms`);
      return result;
    }
  } catch (err: any) {
    console.warn('[Gena] api.classRooms.getClassRooms failed:', err.message?.slice(0, 80));
  }
  return [];
}

/**
 * Subscribes to materials.myNew and returns the newMaterials map:
 * { materialId: [platformStudentId1, platformStudentId2, ...] }
 * These are students with unreviewed submissions for each material.
 */
export async function getNewMaterialsMap(loginToken: string): Promise<Record<string, string[]>> {
  const c = getGenaClient();
  if (!c.connected) await connectGena();
  await ensureAuthenticated(loginToken);

  const collected: any[] = [];
  const listener = c.on('added', (msg: any) => {
    if (msg?.collection === 'materials-new' && msg.fields) {
      collected.push(msg.fields);
    }
  });

  let sub: any;
  try {
    sub = c.subscribe('materials.myNew');
    await Promise.race([
      sub.ready(),
      new Promise(r => setTimeout(r, 5000)),
    ]);
  } catch { /* ignore */ }

  await new Promise(r => setTimeout(r, 500));
  try { listener?.stop(); } catch { /* ignore */ }
  try { sub?.stop(); } catch { /* ignore */ }

  const combined: Record<string, string[]> = {};
  for (const doc of collected) {
    const nm = doc.newMaterials || {};
    for (const [mid, sids] of Object.entries(nm)) {
      if (!combined[mid]) combined[mid] = [];
      if (Array.isArray(sids)) combined[mid].push(...(sids as string[]));
    }
  }
  return combined;
}
