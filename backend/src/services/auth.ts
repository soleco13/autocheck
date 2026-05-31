import jwt from 'jsonwebtoken';
import { db } from '../db';
import { encrypt, decrypt, hashPassword } from '../lib/encryption';
import { loginTeacher as genaLogin } from '../ddp/gena-client';
import { loginToEdik } from '../ddp/edik-client';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const SESSION_TTL = 24 * 60 * 60; // 24 hours in seconds

export interface TeacherSession {
  teacherId: string;
  platformUserId: string;
  email: string;
  fullName: string | null;
}

export async function loginWithCredentials(email: string, password: string): Promise<{
  sessionToken: string;
  teacher: TeacherSession;
}> {
  // Authenticate with the platform (Gena)
  const loginResult = await genaLogin(email, password);
  const encryptedToken = encrypt(loginResult.token);

  // Also try to authenticate with Edik (editor) — same email/password, separate session store
  let edikEncryptedToken: string | null = null;
  let edikTokenExpires: Date | null = null;
  try {
    const edikResult = await loginToEdik(email, password);
    edikEncryptedToken = encrypt(edikResult.token);
    edikTokenExpires = edikResult.tokenExpires;
    console.log('[auth] Edik login OK, userId:', edikResult.userId);
  } catch (err: any) {
    console.warn('[auth] Edik login skipped (teacher may not have editor account):', err.message?.slice(0, 80));
  }

  // Upsert teacher record
  const result = await db.query(`
    INSERT INTO teachers (platform_user_id, email, encrypted_login_token, token_expires_at, edik_encrypted_token, edik_token_expires_at, last_login_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
    ON CONFLICT (platform_user_id) DO UPDATE SET
      email = EXCLUDED.email,
      encrypted_login_token = EXCLUDED.encrypted_login_token,
      token_expires_at = EXCLUDED.token_expires_at,
      edik_encrypted_token = COALESCE(EXCLUDED.edik_encrypted_token, teachers.edik_encrypted_token),
      edik_token_expires_at = COALESCE(EXCLUDED.edik_token_expires_at, teachers.edik_token_expires_at),
      last_login_at = NOW(),
      updated_at = NOW()
    RETURNING id, platform_user_id, email, full_name
  `, [loginResult.userId, email, encryptedToken, loginResult.tokenExpires, edikEncryptedToken, edikTokenExpires]);

  const teacher = result.rows[0];

  const sessionToken = jwt.sign(
    { teacherId: teacher.id, platformUserId: teacher.platform_user_id },
    JWT_SECRET,
    { expiresIn: SESSION_TTL }
  );

  return {
    sessionToken,
    teacher: {
      teacherId: teacher.id,
      platformUserId: teacher.platform_user_id,
      email: teacher.email,
      fullName: teacher.full_name,
    },
  };
}

export function verifySessionToken(token: string): { teacherId: string; platformUserId: string } {
  return jwt.verify(token, JWT_SECRET) as { teacherId: string; platformUserId: string };
}

export async function getTeacherById(teacherId: string): Promise<TeacherSession | null> {
  const result = await db.query(
    'SELECT id, platform_user_id, email, full_name FROM teachers WHERE id = $1',
    [teacherId]
  );
  if (!result.rows[0]) return null;
  const t = result.rows[0];
  return {
    teacherId: t.id,
    platformUserId: t.platform_user_id,
    email: t.email,
    fullName: t.full_name,
  };
}

export async function getDecryptedToken(teacherId: string): Promise<string | null> {
  const result = await db.query(
    'SELECT encrypted_login_token, token_expires_at FROM teachers WHERE id = $1',
    [teacherId]
  );
  if (!result.rows[0]) return null;

  const { encrypted_login_token, token_expires_at } = result.rows[0];
  if (new Date(token_expires_at) < new Date()) {
    return null; // Token expired
  }

  return decrypt(encrypted_login_token);
}

export async function getDecryptedEdikToken(teacherId: string): Promise<string | null> {
  const result = await db.query(
    'SELECT edik_encrypted_token, edik_token_expires_at, edik_resume_encrypted FROM teachers WHERE id = $1',
    [teacherId]
  );
  if (!result.rows[0]) return null;

  const { edik_encrypted_token, edik_token_expires_at, edik_resume_encrypted } = result.rows[0];

  // Prefer auto-login token (from login flow), fall back to manually-set resume token
  if (edik_encrypted_token) {
    if (!edik_token_expires_at || new Date(edik_token_expires_at) > new Date()) {
      return decrypt(edik_encrypted_token);
    }
  }

  if (edik_resume_encrypted) {
    return decrypt(edik_resume_encrypted);
  }

  return null;
}
