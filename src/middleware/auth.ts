import { MiddlewareHandler } from 'hono';
import { authService } from '../services/auth';
import { logger } from '../utils/logger';

export interface AuthUser {
  userId: string;
  email: string;
  organizationId: string;
  role: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

export const auth = (options?: { skipSessionCheck?: boolean }): MiddlewareHandler => {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const token = authHeader.substring(7);

    try {
      const payload = await authService.verifyToken(token);

      // Check session version unless explicitly skipped
      // This enforces single session - if user logged in elsewhere, their session_version increased
      if (!options?.skipSessionCheck) {
        const clientSessionVersion = c.req.header('X-Session-Version');

        if (clientSessionVersion) {
          const currentSessionVersion = await authService.getSessionVersion(payload.userId);
          const clientVersion = parseInt(clientSessionVersion, 10);

          if (!isNaN(clientVersion) && clientVersion < currentSessionVersion) {
            logger.info('Session invalidated - newer session exists', {
              userId: payload.userId,
              clientVersion,
              currentVersion: currentSessionVersion,
            });

            return c.json({
              error: 'Session invalidated',
              code: 'SESSION_KICKED',
              message: 'Your session has been signed out because you signed in on another device.',
            }, 401);
          }
        }
      }

      c.set('user', {
        userId: payload.userId,
        email: payload.email,
        organizationId: payload.organizationId,
        role: payload.role,
      });

      return await next();
    } catch (error) {
      logger.error('Auth middleware error', error);
      return c.json({ error: 'Unauthorized' }, 401);
    }
  };
};

export const requireRole = (roles: string[]): MiddlewareHandler => {
  return async (c, next) => {
    const user = c.get('user');
    
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (!roles.includes(user.role)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    return await next();
  };
};

export const optionalAuth = (): MiddlewareHandler => {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization');
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      try {
        const payload = await authService.verifyToken(token);
        
        c.set('user', {
          userId: payload.userId,
          email: payload.email,
          organizationId: payload.organizationId,
          role: payload.role,
        });
      } catch {
        // Ignore error for optional auth
      }
    }

    await next();
  };
};