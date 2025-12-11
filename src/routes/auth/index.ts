import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { authService } from '../../services/auth';
import { cognitoService } from '../../services/auth/cognito';
import { logger } from '../../utils/logger';
import { query } from '../../db';
import { config } from '../../config';
import signupRoutes from './signup';
import { sendPasswordResetEmail } from '../../services/email/template-sender';
import { cacheService, CacheKeys } from '../../services/redis/cache';

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
    emailAlerts: z.boolean(),
    marketingEmails: z.boolean(),
    weeklyReports: z.boolean(),
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
        emailAlerts: user.email_alerts,
        marketingEmails: user.marketing_emails,
        weeklyReports: user.weekly_reports,
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
  username: z.string().optional(), // Optional username for SECRET_HASH
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

  logger.info('Token refresh request received', {
    hasRefreshToken: !!validated.refreshToken,
    hasUsername: !!validated.username,
    username: validated.username,
    refreshTokenPreview: validated.refreshToken?.substring(0, 50) + '...'
  });

  try {
    const tokens = await authService.refreshTokens(validated.refreshToken, validated.username);
    
    logger.info('Token refresh successful', {
      hasAccessToken: !!tokens.accessToken,
      hasRefreshToken: !!tokens.refreshToken,
      expiresIn: tokens.expiresIn
    });
    
    return c.json(tokens);
  } catch (error: any) {
    logger.error('Token refresh error', { 
      error: error.message || error,
      stack: error.stack,
      name: error.name
    });
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
  newPassword: z.string().min(8).regex(
    /^(?=.*[0-9])(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?])(?=.*[a-z])(?=.*[A-Z]).+$/,
    'Password must contain at least 1 number, 1 special character, 1 uppercase letter, and 1 lowercase letter'
  ),
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
            emailAlerts: z.boolean(),
            marketingEmails: z.boolean(),
            weeklyReports: z.boolean(),
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
      emailAlerts: dbUser.email_alerts,
      marketingEmails: dbUser.marketing_emails,
      weeklyReports: dbUser.weekly_reports,
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

    // Since user is authenticated, directly set the new password
    await authService.setNewPassword(
      payload.userId,
      validated.newPassword
    );

    logger.info('Password changed', { userId: payload.userId });

    return c.json({ message: 'Password changed successfully' });
  } catch (error: any) {
    logger.error('Password change error', { error });
    
    if (error.issues) {
      return c.json({ error: 'Invalid password format', details: error.issues }, 400);
    }
    
    if (error.message === 'Invalid token' || error.message === 'Token expired') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    return c.json({ error: 'Failed to change password' }, 500);
  }
});

// Update user profile endpoint
const UpdateProfileRequestSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().regex(/^\d{10}$/, 'Phone must be 10 digits').optional(),
});

const updateProfileRoute = createRoute({
  method: 'patch',
  path: '/auth/profile',
  summary: 'Update user profile',
  tags: ['Authentication'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: UpdateProfileRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Profile updated successfully',
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
            emailAlerts: z.boolean(),
            marketingEmails: z.boolean(),
            weeklyReports: z.boolean(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid request data',
    },
    401: {
      description: 'Unauthorized',
    },
  },
});

app.openapi(updateProfileRoute, async (c) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = await authService.verifyToken(token);
    const body = await c.req.json();
    const validated = UpdateProfileRequestSchema.parse(body);

    // Update user in database
    const updates: Record<string, any> = {};
    const params: any[] = [];
    let paramIndex = 1;

    if (validated.firstName !== undefined) {
      updates.first_name = `$${paramIndex++}`;
      params.push(validated.firstName);
    }

    if (validated.lastName !== undefined) {
      updates.last_name = `$${paramIndex++}`;
      params.push(validated.lastName);
    }

    if (validated.phone !== undefined) {
      updates.phone = `$${paramIndex++}`;
      params.push(validated.phone);
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    // Add updated_at
    updates.updated_at = 'NOW()';

    // Build UPDATE query
    const setClause = Object.entries(updates)
      .map(([field, placeholder]) => `${field} = ${placeholder}`)
      .join(', ');

    params.push(payload.userId);

    const result = await query<any>(
      `UPDATE users SET ${setClause} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    if (!result[0]) {
      return c.json({ error: 'User not found' }, 404);
    }

    const updatedUser = result[0];

    // Update Cognito attributes if configured
    if (config.aws.cognito.userPoolId) {
      const cognitoAttributes: Record<string, string> = {};
      
      if (validated.firstName !== undefined) {
        cognitoAttributes.given_name = validated.firstName;
      }
      
      if (validated.lastName !== undefined) {
        cognitoAttributes.family_name = validated.lastName;
      }
      
      if (validated.phone !== undefined) {
        cognitoAttributes.phone_number = `+1${validated.phone}`;
      }

      if (Object.keys(cognitoAttributes).length > 0) {
        await cognitoService.updateUserAttributes(updatedUser.email, cognitoAttributes);
      }
    }

    // Invalidate user cache to ensure fresh data on next request
    await cacheService.del(CacheKeys.user(payload.userId));
    await cacheService.del(CacheKeys.userByEmail(updatedUser.email));

    logger.info('User profile updated', { 
      userId: payload.userId, 
      updatedFields: Object.keys(validated) 
    });

    return c.json({
      id: updatedUser.id,
      email: updatedUser.email,
      firstName: updatedUser.first_name || undefined,
      lastName: updatedUser.last_name || undefined,
      phone: updatedUser.phone || undefined,
      organizationId: updatedUser.organization_id,
      role: updatedUser.role,
      emailAlerts: updatedUser.email_alerts,
      marketingEmails: updatedUser.marketing_emails,
      weeklyReports: updatedUser.weekly_reports,
    });
  } catch (error: any) {
    logger.error('Update profile error', { error });
    
    if (error.issues) {
      return c.json({ error: 'Invalid request data', details: error.issues }, 400);
    }
    
    if (error.message === 'Invalid token' || error.message === 'Token expired') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    return c.json({ error: 'Failed to update profile' }, 500);
  }
});

// Forgot password endpoint
const ForgotPasswordRequestSchema = z.object({
  email: z.string().email(),
});

const forgotPasswordRoute = createRoute({
  method: 'post',
  path: '/auth/forgot-password',
  summary: 'Request password reset',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: ForgotPasswordRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Password reset email sent if email exists',
      content: {
        'application/json': {
          schema: z.object({
            message: z.string(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid request',
    },
  },
});

app.openapi(forgotPasswordRoute, async (c) => {
  const body = await c.req.json();
  const validated = ForgotPasswordRequestSchema.parse(body);

  try {
    // Create password reset token (returns null if user doesn't exist)
    const tokenId = await authService.createPasswordResetToken(validated.email);
    
    logger.info('Password reset token creation result', {
      email: validated.email,
      tokenCreated: !!tokenId,
      tokenId
    });
    
    if (tokenId) {
      // Send password reset email
      await sendPasswordResetEmail(validated.email, tokenId);
    }
    
    // Always return success to prevent email enumeration
    logger.info('Password reset requested', { 
      email: validated.email, 
      tokenCreated: !!tokenId 
    });
    
    return c.json({ 
      message: 'If an account exists with this email, a password reset link has been sent.' 
    });
  } catch (error) {
    logger.error('Forgot password error', { error, email: validated.email });
    
    // Still return success even on error to prevent enumeration
    return c.json({ 
      message: 'If an account exists with this email, a password reset link has been sent.' 
    });
  }
});

// Reset password endpoint
const ResetPasswordRequestSchema = z.object({
  token: z.string().uuid(),
  password: z.string().min(8).regex(
    /^(?=.*[0-9])(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?])(?=.*[a-z])(?=.*[A-Z]).+$/,
    'Password must contain at least 1 number, 1 special character, 1 uppercase letter, and 1 lowercase letter'
  ),
});

const resetPasswordRoute = createRoute({
  method: 'post',
  path: '/auth/reset-password',
  summary: 'Reset password using token',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: ResetPasswordRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Password reset successful',
      content: {
        'application/json': {
          schema: z.object({
            message: z.string(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid or expired token',
    },
  },
});

app.openapi(resetPasswordRoute, async (c) => {
  const body = await c.req.json();
  const validated = ResetPasswordRequestSchema.parse(body);

  try {
    const success = await authService.resetPassword(validated.token, validated.password);
    
    if (!success) {
      return c.json({ 
        error: 'Invalid or expired reset token' 
      }, 400);
    }
    
    logger.info('Password reset completed', { tokenId: validated.token });
    
    return c.json({ 
      message: 'Password has been reset successfully' 
    });
  } catch (error: any) {
    logger.error('Reset password error', { error, token: validated.token });
    
    if (error.issues) {
      return c.json({ 
        error: 'Invalid password format', 
        details: error.issues 
      }, 400);
    }
    
    return c.json({ 
      error: 'Failed to reset password' 
    }, 500);
  }
});

// Validate reset token endpoint (optional - for frontend to check if token is valid)
const ValidateResetTokenRequestSchema = z.object({
  token: z.string().uuid(),
});

const validateResetTokenRoute = createRoute({
  method: 'post',
  path: '/auth/validate-reset-token',
  summary: 'Check if password reset token is valid',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: ValidateResetTokenRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Token is valid',
      content: {
        'application/json': {
          schema: z.object({
            valid: z.boolean(),
            email: z.string().optional(),
          }),
        },
      },
    },
  },
});

app.openapi(validateResetTokenRoute, async (c) => {
  const body = await c.req.json();
  const validated = ValidateResetTokenRequestSchema.parse(body);

  try {
    const user = await authService.validatePasswordResetToken(validated.token);
    
    return c.json({ 
      valid: !!user,
      email: user?.email
    });
  } catch (error) {
    logger.error('Validate reset token error', { error, token: validated.token });
    
    return c.json({ 
      valid: false 
    });
  }
});

// Notification preferences endpoint
const NotificationPreferencesSchema = z.object({
  emailAlerts: z.boolean().optional(),
  marketingEmails: z.boolean().optional(),
  weeklyReports: z.boolean().optional(),
});

const updateNotificationPreferencesRoute = createRoute({
  method: 'patch',
  path: '/auth/notification-preferences',
  summary: 'Update notification preferences',
  tags: ['Authentication'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: NotificationPreferencesSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Notification preferences updated',
      content: {
        'application/json': {
          schema: z.object({
            emailAlerts: z.boolean(),
            marketingEmails: z.boolean(),
            weeklyReports: z.boolean(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid request data',
    },
    401: {
      description: 'Unauthorized',
    },
  },
});

app.openapi(updateNotificationPreferencesRoute, async (c) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = await authService.verifyToken(token);
    const body = await c.req.json();
    const validated = NotificationPreferencesSchema.parse(body);

    // Build update query
    const updates: Record<string, any> = {};
    const params: any[] = [];
    let paramIndex = 1;

    if (validated.emailAlerts !== undefined) {
      updates.email_alerts = `$${paramIndex++}`;
      params.push(validated.emailAlerts);
    }

    if (validated.marketingEmails !== undefined) {
      updates.marketing_emails = `$${paramIndex++}`;
      params.push(validated.marketingEmails);
    }

    if (validated.weeklyReports !== undefined) {
      updates.weekly_reports = `$${paramIndex++}`;
      params.push(validated.weeklyReports);
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No preferences to update' }, 400);
    }

    // Add updated_at
    updates.updated_at = 'NOW()';

    // Build UPDATE query
    const setClause = Object.entries(updates)
      .map(([field, placeholder]) => `${field} = ${placeholder}`)
      .join(', ');

    params.push(payload.userId);

    const result = await query<any>(
      `UPDATE users SET ${setClause} WHERE id = $${paramIndex} 
       RETURNING email_alerts, marketing_emails, weekly_reports`,
      params
    );

    if (!result[0]) {
      return c.json({ error: 'User not found' }, 404);
    }

    const prefs = result[0];

    // Invalidate user cache to ensure fresh data on next request
    await cacheService.del(CacheKeys.user(payload.userId));
    
    // Also get user email to invalidate email-based cache
    const user = await authService.getUserById(payload.userId);
    if (user) {
      await cacheService.del(CacheKeys.userByEmail(user.email));
    }

    logger.info('Notification preferences updated', {
      userId: payload.userId,
      preferences: validated
    });

    return c.json({
      emailAlerts: prefs.email_alerts,
      marketingEmails: prefs.marketing_emails,
      weeklyReports: prefs.weekly_reports,
    });
  } catch (error: any) {
    logger.error('Update notification preferences error', { error });
    
    if (error.issues) {
      return c.json({ error: 'Invalid request data', details: error.issues }, 400);
    }
    
    if (error.message === 'Invalid token' || error.message === 'Token expired') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    return c.json({ error: 'Failed to update notification preferences' }, 500);
  }
});

export default app;