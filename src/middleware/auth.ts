import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify, errors, type JWTPayload } from 'jose';
import { env } from '../config/env.js';
import { ForbiddenError } from '../utils/errors.js';

export interface AuthenticatedRequest extends Request {
  userId: string;
  userEmail?: string;
  accessToken?: string;
}

interface SupabaseJwtPayload extends JWTPayload {
  sub: string;
  email?: string;
}

const normalizeUrl = (value: string): string => (
  value.endsWith('/') ? value.slice(0, -1) : value
);

const supabaseUrl = normalizeUrl(env.SUPABASE_URL);
const issuer = `${supabaseUrl}/auth/v1`;
const jwks = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`), {
  headers: {
    apikey: env.SUPABASE_ANON_KEY,
  },
});

const verifySupabaseToken = async (token: string): Promise<SupabaseJwtPayload> => {
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: 'authenticated',
  });
  return payload as SupabaseJwtPayload;
};

export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing authorization header' });
      return;
    }

    const token = authHeader.slice(7);

    const payload = await verifySupabaseToken(token);
    if (!payload.sub) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    // Attach user info to request
    (req as AuthenticatedRequest).userId = payload.sub;
    (req as AuthenticatedRequest).userEmail =
      typeof payload.email === 'string' ? payload.email : undefined;
    (req as AuthenticatedRequest).accessToken = token;

    next();
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      res.status(401).json({ error: 'Token expired' });
      return;
    }
    if (error instanceof errors.JWTClaimValidationFailed && error.claim === 'aud') {
      res.status(401).json({ error: 'Invalid token audience' });
      return;
    }
    res.status(401).json({ error: 'Invalid token' });
    return;
  }
};

const parseCsv = (value?: string): string[] =>
  value
    ? value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
    : [];

export const requireDailyGenerationAdmin = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const authReq = req as AuthenticatedRequest;
  const allowedEmails = parseCsv(env.DAILY_GENERATION_ADMIN_EMAILS);
  const allowedUserIds = parseCsv(env.DAILY_GENERATION_ADMIN_USER_IDS);

  if (allowedEmails.length === 0 && allowedUserIds.length === 0) {
    next(new ForbiddenError('Daily generation admin access not configured'));
    return;
  }

  if (
    allowedUserIds.includes(authReq.userId) ||
    (authReq.userEmail && allowedEmails.includes(authReq.userEmail))
  ) {
    next();
    return;
  }

  next(new ForbiddenError('Admin access required'));
};

/**
 * Optional authentication middleware
 * Attaches user info if valid token is present, but allows request to proceed without auth
 */
export const optionalAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      // No auth header, continue without user info
      next();
      return;
    }

    const token = authHeader.slice(7);

    const payload = await verifySupabaseToken(token);
    if (payload.sub) {
      (req as AuthenticatedRequest).userId = payload.sub;
      (req as AuthenticatedRequest).userEmail =
        typeof payload.email === 'string' ? payload.email : undefined;
    }

    next();
  } catch {
    // Invalid token, continue without user info
    next();
  }
};
