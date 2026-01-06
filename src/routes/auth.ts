import { Router, Request, Response, NextFunction } from 'express';
import { authService, AuthProvider } from '../services/auth.service.js';
import { AppError } from '../utils/errors.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

// Supported providers for validation
const SUPPORTED_PROVIDERS: AuthProvider[] = ['apple', 'google'];

function isValidProvider(provider: unknown): provider is AuthProvider {
  return typeof provider === 'string' && SUPPORTED_PROVIDERS.includes(provider as AuthProvider);
}

/**
 * POST /auth/signin
 * Unified sign in - exchange OAuth provider identity token for session
 * Supports: Apple (iOS), Google (Android)
 */
router.post('/signin', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { provider, idToken, fullName } = req.body;

    // Validate provider
    if (!isValidProvider(provider)) {
      throw new AppError(
        `Invalid provider. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`,
        400,
        'INVALID_PROVIDER'
      );
    }

    // Validate idToken
    if (!idToken || typeof idToken !== 'string') {
      throw new AppError('idToken is required', 400, 'MISSING_TOKEN');
    }

    const tokens = await authService.signIn({
      provider,
      idToken,
      fullName,
    });

    res.json(tokens);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /auth/refresh
 * Refresh an expired access token
 */
router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken || typeof refreshToken !== 'string') {
      throw new AppError('refreshToken is required', 400, 'MISSING_REFRESH_TOKEN');
    }

    const tokens = await authService.refreshSession({ refreshToken });

    res.json(tokens);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /auth/signout
 * Sign out the current user (requires auth)
 */
router.post('/signout', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req as AuthenticatedRequest;

    await authService.signOut(userId);

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
