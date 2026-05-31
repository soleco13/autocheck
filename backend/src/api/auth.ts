import { Router, Request, Response } from 'express';
import { loginWithCredentials, getTeacherById } from '../services/auth';
import { requireAuth, AuthRequest } from '../middleware/auth-middleware';

const router = Router();

router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password required' });
    return;
  }

  try {
    const { sessionToken, teacher } = await loginWithCredentials(email, password);

    res.cookie('session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
    });

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

export default router;
