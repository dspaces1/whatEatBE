import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ForbiddenError } from '../utils/errors.js';

export interface AuthenticatedRequest extends Request {
  userId: string;
  userEmail?: string;
}

interface SupabaseJwtPayload {
  sub: string;
  email?: string;
  aud: string;
  role: string;
  iss: string;
  iat: number;
  exp: number;
  app_metadata?: {
    provider?: string;
    providers?: string[];
  };
  user_metadata?: Record<string, unknown>;
}

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

    // Verify the Supabase JWT
    const payload = jwt.verify(token, env.SUPABASE_JWT_SECRET) as SupabaseJwtPayload;

    // Validate it's an authenticated user token
    if (payload.aud !== 'authenticated') {
      res.status(401).json({ error: 'Invalid token audience' });
      return;
    }

    // Attach user info to request
    (req as AuthenticatedRequest).userId = payload.sub;
    (req as AuthenticatedRequest).userEmail = payload.email;

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Token expired' });
      return;
    }
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    next(error);
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

    // Verify the Supabase JWT
    const payload = jwt.verify(token, env.SUPABASE_JWT_SECRET) as SupabaseJwtPayload;

    // Validate it's an authenticated user token
    if (payload.aud === 'authenticated') {
      // Attach user info to request
      (req as AuthenticatedRequest).userId = payload.sub;
      (req as AuthenticatedRequest).userEmail = payload.email;
    }

    next();
  } catch {
    // Invalid token, continue without user info
    next();
  }
};




