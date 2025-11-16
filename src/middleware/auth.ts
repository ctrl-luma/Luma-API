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

export const auth = (): MiddlewareHandler => {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization');
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const token = authHeader.substring(7);

    try {
      const payload = await authService.verifyToken(token);
      
      c.set('user', {
        userId: payload.userId,
        email: payload.email,
        organizationId: payload.organizationId,
        role: payload.role,
      });

      await next();
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

    await next();
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
      } catch (error) {
        // Ignore error for optional auth
      }
    }

    await next();
  };
};