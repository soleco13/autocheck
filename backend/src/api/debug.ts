import { Router, Request, Response } from 'express';
import { getDecryptedToken } from '../services/auth';
import { callGena, getGenaClient, connectGena } from '../ddp/gena-client';
import { getEdikClient, connectEdik } from '../ddp/edik-client';
import { db } from '../db';

async function genaSubscribeAndCollect(
  loginToken: string,
  subName: string,
  subParams: any[],
  timeoutMs = 4000
): Promise<{ collections: Record<string, any[]>; error?: string }> {
  const c = getGenaClient();
  if (!c.connected) await connectGena();

  // Re-authenticate with this token
  try {
    await c.call('login', { resume: loginToken });
  } catch (e: any) {
    return { collections: {}, error: `auth failed: ${e.message}` };
  }

  const collections: Record<string, any[]> = {};
  const listener = c.on('added', (msg: any) => {
    const col = msg?.collection || '_unknown';
    if (!collections[col]) collections[col] = [];
    collections[col].push({ id: msg.id, ...msg.fields });
  });

  let sub: any;
  try {
    sub = c.subscribe(subName, ...subParams);
    await Promise.race([
      sub.ready(),
      new Promise(r => setTimeout(r, timeoutMs)),
    ]);
  } catch (e: any) {
    try { listener?.stop(); } catch { /* ignore */ }
    return { collections, error: e.message };
  }

  await new Promise(r => setTimeout(r, 500));
  try { listener?.stop(); } catch { /* ignore */ }
  try { sub?.stop(); } catch { /* ignore */ }
  return { collections };
}

async function edikSubscribeAndCollect(
  subName: string,
  subParams: any[],
  timeoutMs = 4000
): Promise<{ collections: Record<string, any[]>; error?: string }> {
  const c = getEdikClient();
  if (!c.connected) await connectEdik();

  const collections: Record<string, any[]> = {};
  const listener = c.on('added', (msg: any) => {
    const col = msg?.collection || '_unknown';
    if (!collections[col]) collections[col] = [];
    collections[col].push({ id: msg.id, ...msg.fields });
  });

  let sub: any;
  try {
    sub = c.subscribe(subName, ...subParams);
    await Promise.race([
      sub.ready(),
      new Promise(r => setTimeout(r, timeoutMs)),
    ]);
  } catch (e: any) {
    try { listener?.stop(); } catch { /* ignore */ }
    return { collections, error: e.message };
  }

  await new Promise(r => setTimeout(r, 500));
  try { listener?.stop(); } catch { /* ignore */ }
  try { sub?.stop(); } catch { /* ignore */ }
  return { collections };
}

const router = Router();

// Test any Gena DDP method
router.get('/gena', async (req: Request, res: Response) => {
  const { teacherId, method, params } = req.query as {
    teacherId?: string; method?: string; params?: string;
  };
  if (!teacherId || !method) {
    res.status(400).json({ error: 'teacherId and method required' }); return;
  }
  try {
    const token = await getDecryptedToken(teacherId);
    if (!token) { res.status(404).json({ error: 'Token not found' }); return; }
    const parsedParams = params ? JSON.parse(params) : undefined;
    const args = parsedParams !== undefined ? [parsedParams] : [];
    const result = await callGena(token, method, ...args);
    res.json({
      ok: true, type: typeof result, isArray: Array.isArray(result),
      length: Array.isArray(result) ? result.length : null,
      result: Array.isArray(result) ? result.slice(0, 5) : result,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Test any Edik DDP method (no auth)
router.get('/edik', async (req: Request, res: Response) => {
  const { method, params } = req.query as { method?: string; params?: string };
  if (!method) { res.status(400).json({ error: 'method required' }); return; }
  try {
    const c = getEdikClient();
    if (!c.connected) await connectEdik();
    const parsedParams = params ? JSON.parse(params) : undefined;
    const args = parsedParams !== undefined ? [parsedParams] : [];
    const result = await c.call(method, ...args);
    res.json({
      ok: true, type: typeof result, isArray: Array.isArray(result),
      length: Array.isArray(result) ? result.length : null,
      result: Array.isArray(result) ? result.slice(0, 5) : result,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Scan material methods for a student — tries known Gena + Edik variants
router.get('/materials-scan', async (req: Request, res: Response) => {
  const { teacherId, studentId } = req.query as { teacherId?: string; studentId?: string };
  if (!teacherId || !studentId) {
    res.status(400).json({ error: 'teacherId and studentId required' }); return;
  }

  const token = await getDecryptedToken(teacherId);
  if (!token) { res.status(404).json({ error: 'Token not found' }); return; }

  const teacherRow = await db.query('SELECT platform_user_id FROM teachers WHERE id = $1', [teacherId]);
  const studentRow = await db.query('SELECT platform_student_id FROM students WHERE id = $1', [studentId]);
  if (!teacherRow.rows[0] || !studentRow.rows[0]) {
    res.status(404).json({ error: 'Teacher or student not found' }); return;
  }

  const teacherPlatformId = teacherRow.rows[0].platform_user_id;
  const childPlatformId = studentRow.rows[0].platform_student_id;

  const methodsToTry = [
    { server: 'gena', method: 'api.materials.getChildsMaterials', params: { childId: childPlatformId } },
    { server: 'gena', method: 'api.materials.getChildsMaterials', params: { childId: childPlatformId, trainerId: teacherPlatformId } },
    { server: 'edik', method: 'api.materials.getChildsMaterials', params: { childId: childPlatformId } },
    { server: 'edik', method: 'api.materials.getChildsMaterials', params: { childId: childPlatformId, trainerId: teacherPlatformId } },
  ];

  const results: any[] = [];
  const edikClient = getEdikClient();
  if (!edikClient.connected) await connectEdik();

  for (const { server, method, params } of methodsToTry) {
    try {
      const result = server === 'gena'
        ? await callGena(token, method, params)
        : await edikClient.call(method, params);
      const isArray = Array.isArray(result);
      results.push({
        server, method, params, ok: true,
        count: isArray ? result.length : null,
        preview: isArray ? result.slice(0, 2) : result,
        keys: isArray && result.length > 0 ? Object.keys(result[0]) : null,
      });
    } catch (err: any) {
      results.push({ server, method, params, ok: false, error: err.message });
    }
  }

  res.json({ teacherPlatformId, childPlatformId, results });
});

// Test JWT acquisition for a known session ID
router.get('/jwt-scan', async (req: Request, res: Response) => {
  const { teacherId, sessionId, studentId } = req.query as {
    teacherId?: string; sessionId?: string; studentId?: string;
  };
  if (!teacherId || !sessionId) {
    res.status(400).json({ error: 'teacherId and sessionId required' }); return;
  }

  const token = await getDecryptedToken(teacherId);
  if (!token) { res.status(404).json({ error: 'Token not found' }); return; }

  const sid = studentId || '';
  const methodsToTry = [
    { method: 'api.materials-sessions.getSession',      params: { sessionId } },
    { method: 'api.materials-sessions.getById',         params: { id: sessionId } },
    { method: 'api.materials-sessions.getTeacherToken', params: { sessionId } },
    { method: 'api.materials-sessions.getViewToken',    params: { sessionId } },
    { method: 'api.materials-sessions.createSession',   params: { materialId: sessionId, studentId: sid } },
    { method: 'api.materials-sessions.createSession',   params: { materialId: sessionId, childId: sid } },
  ];

  const results: any[] = [];
  for (const { method, params } of methodsToTry) {
    try {
      const result = await callGena(token, method, params);
      results.push({ method, params, ok: true, result });
    } catch (err: any) {
      results.push({ method, params, ok: false, error: err.message });
    }
  }

  res.json({ results });
});

// Subscribe to Edik and collect documents — no auth needed
router.get('/edik-subscribe', async (req: Request, res: Response) => {
  const { sub, params } = req.query as { sub?: string; params?: string };
  if (!sub) { res.status(400).json({ error: 'sub required' }); return; }

  const subParams = params ? JSON.parse(params) : [];
  const { collections, error } = await edikSubscribeAndCollect(sub, subParams);
  const summary = Object.entries(collections).map(([col, docs]) => ({
    collection: col,
    count: docs.length,
    keys: docs.length > 0 ? Object.keys(docs[0]) : [],
    sample: docs.slice(0, 2),
  }));
  res.json({ sub, subParams, error, collections: summary });
});

// Subscribe to Gena (with teacher auth) and collect documents
router.get('/gena-subscribe', async (req: Request, res: Response) => {
  const { teacherId, sub, params } = req.query as { teacherId?: string; sub?: string; params?: string };
  if (!teacherId || !sub) { res.status(400).json({ error: 'teacherId and sub required' }); return; }

  const token = await getDecryptedToken(teacherId);
  if (!token) { res.status(404).json({ error: 'Token not found' }); return; }

  const subParams = params ? JSON.parse(params) : [];
  const { collections, error } = await genaSubscribeAndCollect(token, sub, subParams);
  const summary = Object.entries(collections).map(([col, docs]) => ({
    collection: col,
    count: docs.length,
    keys: docs.length > 0 ? Object.keys(docs[0]) : [],
    sample: docs.slice(0, 2),
  }));
  res.json({ sub, subParams, error, collections: summary });
});

// Scan Gena subscriptions to find session/material data (requires teacherId)
router.get('/gena-subscribe-scan', async (req: Request, res: Response) => {
  const { teacherId, studentPlatformId } = req.query as { teacherId?: string; studentPlatformId?: string };
  if (!teacherId) { res.status(400).json({ error: 'teacherId required' }); return; }

  const token = await getDecryptedToken(teacherId);
  if (!token) { res.status(404).json({ error: 'Token not found' }); return; }

  const sid = studentPlatformId || '';
  const subsToTry = [
    { name: 'lessons',                    params: [] },
    { name: 'myLessons',                  params: [] },
    { name: 'clazzes',                    params: [] },
    { name: 'myClazzes',                  params: [] },
    { name: 'homework',                   params: [] },
    { name: 'assignments',                params: [] },
    { name: 'materials-sessions',         params: [] },
    { name: 'materialSessions',           params: [] },
    { name: 'sessions',                   params: [] },
    { name: 'studentProgress',            params: [] },
    { name: 'results',                    params: [] },
    { name: 'materials',                  params: [] },
    ...(sid ? [
      { name: 'studentSessions',          params: [sid] },
      { name: 'childSessions',            params: [sid] },
      { name: 'lessons',                  params: [sid] },
      { name: 'materials-sessions',       params: [sid] },
    ] : []),
  ];

  const results: any[] = [];
  for (const { name, params } of subsToTry) {
    const { collections, error } = await genaSubscribeAndCollect(token, name, params, 3000);
    const total = Object.values(collections).reduce((s, a) => s + a.length, 0);
    results.push({
      name, params, ok: !error, total, error: error || null,
      collections: Object.keys(collections),
      keys: total > 0 ? Object.keys(Object.values(collections)[0]?.[0] || {}) : [],
    });
  }
  res.json({ results });
});

// Scan Edik subscriptions to find material/session data
router.get('/edik-subscribe-scan', async (_req: Request, res: Response) => {
  const subsToTry = [
    { name: 'materials.branches',       params: [] },
    { name: 'materials.branches.order', params: [] },
    { name: 'materials',                params: [] },
    { name: 'materialSessions',         params: [] },
    { name: 'materials-sessions',       params: [] },
    { name: 'sessions',                 params: [] },
  ];

  const results: any[] = [];
  for (const { name, params } of subsToTry) {
    const { collections, error } = await edikSubscribeAndCollect(name, params, 3000);
    const total = Object.values(collections).reduce((s, a) => s + a.length, 0);
    results.push({
      name, ok: !error, total, error,
      collections: Object.keys(collections),
      keys: total > 0 ? Object.keys(Object.values(collections)[0]?.[0] || {}) : [],
    });
  }
  res.json({ results });
});

// List teachers in DB
router.get('/teachers', async (_req: Request, res: Response) => {
  const result = await db.query(
    'SELECT id, email, platform_user_id, token_expires_at FROM teachers ORDER BY created_at DESC LIMIT 10'
  );
  res.json(result.rows);
});

// List students in DB
router.get('/students', async (_req: Request, res: Response) => {
  const result = await db.query(
    'SELECT id, platform_student_id, full_name, grade FROM students ORDER BY full_name LIMIT 20'
  );
  res.json(result.rows);
});

export default router;
