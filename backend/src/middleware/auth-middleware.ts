import { Request, Response, NextFunction } from 'express';
import { verifySessionToken, getTeacherById } from '../services/auth';

export interface AuthRequest extends Request {
  teacherId?: string;
  platformUserId?: string;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = req.cookies?.session || req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const payload = verifySessionToken(token);
    req.teacherId = payload.teacherId;
    req.platformUserId = payload.platformUserId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}
