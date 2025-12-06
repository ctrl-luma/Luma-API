import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { authService } from '../../services/auth';
import { logger } from '../../utils/logger';
import signupRoutes from './signup';

const app = new OpenAPIHono();

// Mount signup routes
app.route('/', signupRoutes);

const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const LoginResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    phone: z.string().optional(),
    organizationId: z.string(),
    role: z.string(),
  }),
  tokens: z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresIn: z.number(),
  }),
});

const loginRoute = createRoute({
  method: 'post',
  path: '/auth/login',
  summary: 'Login to account',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: LoginRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Login successful',
      content: {
        'application/json': {
          schema: LoginResponseSchema,
        },
      },
    },
    401: {
      description: 'Invalid credentials',
    },
  },
});

app.openapi(loginRoute, async (c) => {
  const body = await c.req.json();
  const validated = LoginRequestSchema.parse(body);

  try {
    const tokens = await authService.login(validated.email, validated.password);
    const user = await authService.getUserByEmail(validated.email);

    if (!user) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    logger.info('User logged in', { userId: user.id, email: user.email });

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name || undefined,
        lastName: user.last_name || undefined,
        phone: user.phone || undefined,
        organizationId: user.organization_id,
        role: user.role,
      },
      tokens,
    });
  } catch (error: any) {
    logger.error('Login error', { error, email: validated.email });
    
    if (error.message === 'Invalid credentials') {
      return c.json({ error: 'Invalid credentials' }, 401);
    }
    
    return c.json({ error: 'Login failed' }, 500);
  }
});

const RefreshTokenRequestSchema = z.object({
  refreshToken: z.string(),
});

const EmailCheckRequestSchema = z.object({
  email: z.string().email(),
});

const EmailCheckResponseSchema = z.object({
  inUse: z.boolean(),
});

const checkEmailRoute = createRoute({
  method: 'post',
  path: '/auth/check-email',
  summary: 'Check if email is already in use',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: EmailCheckRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Email check result',
      content: {
        'application/json': {
          schema: EmailCheckResponseSchema,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
  },
});

app.openapi(checkEmailRoute, async (c) => {
  const body = await c.req.json();
  const validated = EmailCheckRequestSchema.parse(body);

  try {
    const inUse = await authService.isEmailInUse(validated.email);
    
    return c.json({ inUse }, 200);
  } catch (error) {
    logger.error('Email check error', error);
    return c.json({ error: 'Email check failed' }, 500);
  }
});

const refreshRoute = createRoute({
  method: 'post',
  path: '/auth/refresh',
  summary: 'Refresh access token',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: RefreshTokenRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Tokens refreshed',
      content: {
        'application/json': {
          schema: z.object({
            accessToken: z.string(),
            refreshToken: z.string(),
            expiresIn: z.number(),
          }),
        },
      },
    },
    401: {
      description: 'Invalid refresh token',
    },
  },
});

app.openapi(refreshRoute, async (c) => {
  const body = await c.req.json();
  const validated = RefreshTokenRequestSchema.parse(body);

  try {
    const tokens = await authService.refreshTokens(validated.refreshToken);
    
    return c.json(tokens);
  } catch (error) {
    logger.error('Token refresh error', error);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }
});

const logoutRoute = createRoute({
  method: 'post',
  path: '/auth/logout',
  summary: 'Logout from account',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: RefreshTokenRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Logged out successfully',
    },
  },
});

app.openapi(logoutRoute, async (c) => {
  const body = await c.req.json();
  const validated = RefreshTokenRequestSchema.parse(body);

  try {
    await authService.logout(validated.refreshToken);
    return c.json({ message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout error', error);
    return c.json({ message: 'Logged out successfully' }); // Always return success
  }
});

const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8),
});

const changePasswordRoute = createRoute({
  method: 'post',
  path: '/auth/change-password',
  summary: 'Change password',
  tags: ['Authentication'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: ChangePasswordRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Password changed successfully',
    },
    400: {
      description: 'Invalid current password',
    },
    401: {
      description: 'Unauthorized',
    },
  },
});

// Get current user endpoint
const getCurrentUserRoute = createRoute({
  method: 'get',
  path: '/auth/me',
  summary: 'Get current user information',
  tags: ['Authentication'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Current user information',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            email: z.string(),
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            phone: z.string().optional(),
            organizationId: z.string(),
            role: z.string(),
          }),
        },
      },
    },
    401: {
      description: 'Unauthorized',
    },
  },
});

app.openapi(getCurrentUserRoute, async (c) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = await authService.verifyToken(token);
    
    const dbUser = await authService.getUserById(payload.userId);
    
    if (!dbUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    logger.debug('Current user fetched', { userId: payload.userId });

    return c.json({
      id: dbUser.id,
      email: dbUser.email,
      firstName: dbUser.first_name || undefined,
      lastName: dbUser.last_name || undefined,
      phone: dbUser.phone || undefined,
      organizationId: dbUser.organization_id,
      role: dbUser.role,
    });
  } catch (error) {
    logger.error('Get current user error', { error });
    return c.json({ error: 'Unauthorized' }, 401);
  }
});

app.openapi(changePasswordRoute, async (c) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = await authService.verifyToken(token);
    
    const body = await c.req.json();
    const validated = ChangePasswordRequestSchema.parse(body);

    await authService.changePassword(
      payload.userId,
      validated.currentPassword,
      validated.newPassword
    );

    logger.info('Password changed', { userId: payload.userId });

    return c.json({ message: 'Password changed successfully' });
  } catch (error: any) {
    logger.error('Password change error', { error });
    
    if (error.message === 'Current password is incorrect') {
      return c.json({ error: 'Current password is incorrect' }, 400);
    }
    
    if (error.message === 'Invalid token' || error.message === 'Token expired') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    return c.json({ error: 'Failed to change password' }, 500);
  }
});

export default app;