import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// Supported OAuth providers
export type AuthProvider = 'apple' | 'google';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  expiresAt: number;
  user: {
    id: string;
    email?: string;
    createdAt: string;
  };
}

export interface SignInRequest {
  provider: AuthProvider;
  idToken: string;
  // Apple-specific: only sent on first sign-in
  fullName?: {
    givenName?: string;
    familyName?: string;
  };
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

export const authService = {
  /**
   * Unified sign in - exchanges OAuth provider identity token for Supabase session
   * Supports: Apple, Google (and easily extensible to other providers)
   */
  async signIn(request: SignInRequest): Promise<AuthTokens> {
    const { provider, idToken, fullName } = request;

    try {
      // Exchange provider token with Supabase
      const { data, error } = await supabaseAdmin.auth.signInWithIdToken({
        provider,
        token: idToken,
      });

      if (error) {
        logger.error({ error: error.message }, `Supabase ${provider} sign in failed`);
        throw new AppError('Authentication failed', 401, 'AUTH_FAILED');
      }

      if (!data.session || !data.user) {
        throw new AppError('No session returned', 401, 'AUTH_NO_SESSION');
      }

      // Handle provider-specific post-auth logic
      await this.handleProviderMetadata(provider, data.user.id, { fullName });

      logger.info({ userId: data.user.id, provider }, `${provider} sign in successful`);

      return {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresIn: data.session.expires_in,
        expiresAt: data.session.expires_at ?? Math.floor(Date.now() / 1000) + data.session.expires_in,
        user: {
          id: data.user.id,
          email: data.user.email,
          createdAt: data.user.created_at,
        },
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      
      logger.error({ error, provider }, `${provider} sign in error`);
      throw new AppError('Authentication service error', 500, 'AUTH_SERVICE_ERROR');
    }
  },

  /**
   * Handle provider-specific metadata after successful authentication
   */
  async handleProviderMetadata(
    provider: AuthProvider,
    userId: string,
    metadata: { fullName?: SignInRequest['fullName'] }
  ): Promise<void> {
    switch (provider) {
      case 'apple':
        // Apple only sends name on first sign-in, so we must capture it
        if (metadata.fullName?.givenName || metadata.fullName?.familyName) {
          const displayName = [metadata.fullName.givenName, metadata.fullName.familyName]
            .filter(Boolean)
            .join(' ');

          if (displayName) {
            await supabaseAdmin.auth.admin.updateUserById(userId, {
              user_metadata: {
                full_name: displayName,
                given_name: metadata.fullName.givenName,
                family_name: metadata.fullName.familyName,
              },
            });
          }
        }
        break;

      case 'google':
        // Google includes name in the token automatically - Supabase handles it
        break;
    }
  },

  /**
   * Refresh an expired access token
   */
  async refreshSession(request: RefreshTokenRequest): Promise<AuthTokens> {
    const { refreshToken } = request;

    try {
      const { data, error } = await supabaseAdmin.auth.refreshSession({
        refresh_token: refreshToken,
      });

      if (error) {
        logger.error({ error: error.message }, 'Token refresh failed');
        throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN');
      }

      if (!data.session || !data.user) {
        throw new AppError('No session returned', 401, 'REFRESH_NO_SESSION');
      }

      return {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresIn: data.session.expires_in,
        expiresAt: data.session.expires_at ?? Math.floor(Date.now() / 1000) + data.session.expires_in,
        user: {
          id: data.user.id,
          email: data.user.email,
          createdAt: data.user.created_at,
        },
      };
    } catch (error) {
      if (error instanceof AppError) throw error;

      logger.error({ error }, 'Token refresh error');
      throw new AppError('Token refresh service error', 500, 'REFRESH_SERVICE_ERROR');
    }
  },

  /**
   * Sign out - invalidates the user's session
   */
  async signOut(userId: string): Promise<void> {
    try {
      const { error } = await supabaseAdmin.auth.admin.signOut(userId);
      
      if (error) {
        logger.warn({ userId, error: error.message }, 'Sign out error');
        // Don't throw - sign out should be best-effort
      }

      logger.info({ userId }, 'User signed out');
    } catch (error) {
      logger.error({ userId, error }, 'Sign out service error');
      // Don't throw - sign out should be best-effort
    }
  },
};
