import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { PlatformUser, UserRole } from '../types/lasu.ts';
import { adminAuth } from './firebaseAdmin.ts';
import { db, DEMO_MODE_ENABLED, IS_PRODUCTION, requirePersistentDatabase } from './db.ts';

let cachedDevSecret: string | null = null;

export function validateSecurityConfig(): void {
  const raw = (process.env.SESSION_SECRET || '').trim();
  if (IS_PRODUCTION && raw.length < 32) {
    throw new Error(
      'FATAL: SESSION_SECRET environment variable must be set to a random secret of at least 32 characters in production.'
    );
  }
}

export function getSessionSecret(): string {
  const raw = (process.env.SESSION_SECRET || '').trim();
  if (IS_PRODUCTION) {
    if (raw.length < 32) {
      throw new Error('SESSION_SECRET must be at least 32 characters in production.');
    }
    return raw;
  }
  if (raw.length >= 16) return raw;
  if (!cachedDevSecret) {
    cachedDevSecret = crypto.randomBytes(32).toString('hex');
  }
  return cachedDevSecret;
}

export function getInitialAdminEmails(): Set<string> {
  const raw = process.env.INITIAL_ADMIN_EMAIL || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export interface AuthenticatedContext {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  isDemoToken: boolean;
  user: PlatformUser | null;
}

export interface RequestWithAuth extends Request {
  authContext?: AuthenticatedContext;
}

export function signDemoToken(uid: string): string {
  if (IS_PRODUCTION || !DEMO_MODE_ENABLED) {
    throw new Error('Demo token signing is disabled when production mode or ENABLE_DEMO_MODE=false is active.');
  }
  const secret = getSessionSecret();
  const payload = Buffer.from(
    JSON.stringify({ uid, exp: Date.now() + 24 * 60 * 60 * 1000, demo: true })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `demo.${payload}.${sig}`;
}

export function verifyDemoToken(token: string): { uid: string } | null {
  if (IS_PRODUCTION || !DEMO_MODE_ENABLED || !token.startsWith('demo.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, payload, sig] = parts;
  const secret = getSessionSecret();
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      uid: string;
      exp: number;
      demo: boolean;
    };
    if (!parsed.demo || parsed.exp < Date.now()) return null;
    return { uid: parsed.uid };
  } catch {
    return null;
  }
}

export async function resolveAuthFromHeader(authHeader?: string): Promise<AuthenticatedContext | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  // 1. Check demo token (strictly non-production and only when DEMO_MODE_ENABLED)
  if (token.startsWith('demo.')) {
    const demoPayload = verifyDemoToken(token);
    if (!demoPayload) return null;
    const user = await db.getUserByUid(demoPayload.uid);
    if (!user || !user.isDemo) return null;
    return {
      uid: user.uid,
      email: user.email,
      emailVerified: true,
      displayName: user.displayName,
      isDemoToken: true,
      user,
    };
  }

  // 2. Verify genuine Firebase ID Token
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    const email = (decoded.email || '').toLowerCase();
    const emailVerified = Boolean(decoded.email_verified);
    let user = (await db.getUserByUid(decoded.uid)) || (email ? await db.getUserByEmail(email) : null);

    // Optional initial admin provisioning strictly from INITIAL_ADMIN_EMAIL env var when zero system admins exist
    const allowedInitialAdmins = getInitialAdminEmails();
    if (!user && email && emailVerified && allowedInitialAdmins.has(email)) {
      const hasExistingAdmin = await db.hasAnySystemAdmin();
      if (!hasExistingAdmin) {
        const depts = await db.listDepartments();
        const defaultDept = depts[0];
        const now = new Date().toISOString();
        user = {
          uid: decoded.uid,
          email,
          displayName: decoded.name || 'LASU System Administrator',
          role: 'system_admin',
          departmentId: defaultDept?.id || 'dept_admin',
          departmentName: defaultDept?.name || 'Faculty Administration',
          facultyName: defaultDept?.facultyName || 'Faculty of Engineering',
          status: 'active',
          isDemo: false,
          createdAt: now,
          updatedAt: now,
        };
        await db.saveUser(user);
        await db.addAuditLog({
          actorUid: user.uid,
          actorName: user.displayName,
          actorRole: 'system_admin',
          action: 'ADMIN_BOOTSTRAPPED_FROM_ENV',
          targetType: 'user',
          targetId: user.uid,
          details: `Provisioned initial system_admin via INITIAL_ADMIN_EMAIL (${user.email}).`,
          departmentId: user.departmentId,
        });
      }
    }

    return {
      uid: decoded.uid,
      email,
      emailVerified,
      displayName: decoded.name || user?.displayName || email.split('@')[0] || 'LASU User',
      isDemoToken: false,
      user,
    };
  } catch {
    return null;
  }
}

export async function requireAuth(req: RequestWithAuth, res: Response, next: NextFunction) {
  if (!db.isAvailable()) {
    requirePersistentDatabase(req, res, next);
    return;
  }
  const ctx = await resolveAuthFromHeader(req.headers.authorization);
  if (!ctx) {
    res.status(401).json({ error: 'Authentication required. Please sign in to continue.' });
    return;
  }
  req.authContext = ctx;
  next();
}

export function requireRole(allowedRoles: UserRole[]) {
  return (req: RequestWithAuth, res: Response, next: NextFunction) => {
    const user = req.authContext?.user;
    if (!user) {
      res.status(403).json({
        error: 'Account activation required before accessing this resource.',
        code: 'ACCOUNT_NOT_ACTIVATED',
      });
      return;
    }
    if (user.status !== 'active') {
      res.status(403).json({
        error: 'Your account is pending verification or suspended. Contact your department administrator.',
        code: 'ACCOUNT_INACTIVE',
      });
      return;
    }
    if (!allowedRoles.includes(user.role)) {
      res.status(403).json({
        error: 'You do not have permission to perform this action.',
        code: 'FORBIDDEN',
      });
      return;
    }
    next();
  };
}

export function canAccessDepartment(user: PlatformUser, departmentId: string): boolean {
  if (user.role === 'system_admin') return true;
  if (user.role === 'department_admin') return user.departmentId === departmentId;
  return false;
}

// Sliding-window rate limiter
const rateBuckets = new Map<string, number[]>();

export function checkRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;
  const timestamps = (rateBuckets.get(key) || []).filter((ts) => ts > cutoff);
  if (timestamps.length >= maxRequests) {
    rateBuckets.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  rateBuckets.set(key, timestamps);
  return true;
}
