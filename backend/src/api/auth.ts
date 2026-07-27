import { Router, Request, Response } from 'express';
import { loginWithCredentials, getTeacherById, issueSessionToken, refreshPlatformToken } from '../services/auth';
import { requireAuth, AuthRequest } from '../middleware/auth-middleware';
import { audit } from '../lib/audit';

const router = Router();

router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password required' });
    return;
  }

  try {
    const { sessionToken, teacher } = await loginWithCredentials(email, password);

    const ttlMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    res.cookie('session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: ttlMs,
    });

    audit({ teacherId: teacher.teacherId, action: 'login', ipAddress: req.ip });
    res.json({ teacher });
  } catch (err: any) {
    console.error('Login error:', err.message);
    res.status(401).json({ error: 'Invalid credentials or platform unavailable' });
  }
});

router.post('/logout', (req: Request, res: Response) => {
  res.clearCookie('session');
  res.status(204).end();
});

router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  const teacher = await getTeacherById(req.teacherId!);
  if (!teacher) {
    res.status(401).json({ error: 'Teacher not found' });
    return;
  }
  res.json({ teacher });
});

// POST /api/auth/refresh — issue a fresh session JWT (extends browser session).
// No password needed — valid session is proof of identity.
router.post('/refresh', requireAuth, async (req: AuthRequest, res: Response) => {
  const teacher = await getTeacherById(req.teacherId!);
  if (!teacher) { res.status(401).json({ error: 'Teacher not found' }); return; }

  const newToken = issueSessionToken(teacher.teacherId, teacher.platformUserId);
  const ttlMs = 7 * 24 * 60 * 60 * 1000;
  res.cookie('session', newToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: ttlMs,
  });
  res.json({ ok: true, teacher });
});

// POST /api/auth/refresh-platform — refresh the Gena platform token.
// Called when the frontend detects platformError: 'Login token expired'.
router.post('/refresh-platform', requireAuth, async (req: AuthRequest, res: Response) => {
  const ok = await refreshPlatformToken(req.teacherId!);
  if (ok) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Не удалось обновить токен платформы. Войдите снова.' });
  }
});

export default router;
