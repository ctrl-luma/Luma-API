import bcrypt from 'bcrypt';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { query } from '../../db';
import { User } from '../../db/models';
import { cacheService, CacheKeys } from '../redis/cache';
import { cognitoService } from './cognito';
import { normalizeEmail } from '../../utils/email';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface JWTPayload {
  userId: string;
  email: string;
  organizationId: string;
  role: string;
  sessionId?: string;
  type: 'access' | 'refresh';
}

export class AuthService {

  async register(params: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
    organizationId: string;
    role?: string;
  }): Promise<User> {
    const existingUser = await this.getUserByEmail(params.email);
    if (existingUser) {
      throw new Error('User already exists');
    }

    const passwordHash = await bcrypt.hash(params.password, 10);

    const userResult = await query<User>(
      `INSERT INTO users (
        email, password_hash, first_name, last_name,
        organization_id, role
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        params.email,
        passwordHash,
        params.firstName,
        params.lastName,
        params.organizationId,
        params.role || 'bartender'
      ]
    );

    const user = userResult[0];

    if (config.aws.cognito.userPoolId) {
      try {
        await cognitoService.createUser({
          email: params.email,
          temporaryPassword: params.password,
          attributes: {
            'custom:user_id': user.id,
            'custom:organization_id': user.organization_id,
            'custom:role': user.role,
            'given_name': params.firstName || '',
            'family_name': params.lastName || '',
          },
        });

        await cognitoService.addUserToGroup(params.email, user.role);
        await cognitoService.setUserPassword(params.email, params.password, true);
      } catch (error) {
        logger.error('Failed to create Cognito user, rolling back', error);
        await query('DELETE FROM users WHERE id = $1', [user.id]);
        throw error;
      }
    }

    await cacheService.set(CacheKeys.user(user.id), user, { ttl: 3600 });
    await cacheService.set(CacheKeys.userByEmail(user.email), user, { ttl: 3600 });

    logger.info('User registered', { userId: user.id, email: user.email });
    return user;
  }

  async login(email: string, password: string): Promise<AuthTokens> {
    const user = await this.getUserByEmail(email);
    if (!user || !user.is_active) {
      throw new Error('Invalid credentials');
    }

    if (config.aws.cognito.userPoolId) {
      try {
        const cognitoAuth = await cognitoService.authenticateUser(email, password);
        
        if (cognitoAuth.challengeName === 'NEW_PASSWORD_REQUIRED') {
          throw new Error('Password change required');
        }

        await this.updateLastLogin(user.id);

        return {
          accessToken: cognitoAuth.idToken!,
          refreshToken: cognitoAuth.refreshToken!,
          expiresIn: cognitoAuth.expiresIn!,
        };
      } catch (error: any) {
        if (error.name === 'NotAuthorizedException') {
          throw new Error('Invalid credentials');
        }
        throw error;
      }
    }

    if (!user.password_hash) {
      throw new Error('Password not set');
    }

    throw new Error('Local authentication not supported. Please use Cognito.');
  }

  async generateTokens(_user: User): Promise<AuthTokens> {
    throw new Error('Local token generation not supported. Please use Cognito.');
  }

  async refreshTokens(refreshToken: string): Promise<AuthTokens> {
    if (config.aws.cognito.userPoolId) {
      try {
        const cognitoAuth = await cognitoService.refreshTokens(refreshToken);
        
        return {
          accessToken: cognitoAuth.idToken!,
          refreshToken: refreshToken,
          expiresIn: cognitoAuth.expiresIn!,
        };
      } catch (error) {
        logger.error('Failed to refresh Cognito tokens', error);
        throw new Error('Invalid refresh token');
      }
    }

    throw new Error('Local token refresh not supported. Please use Cognito.');
  }

  async verifyToken(token: string): Promise<JWTPayload> {
    if (config.aws.cognito.userPoolId) {
      try {
        const cognitoPayload = await cognitoService.verifyIdToken(token);
        
        return {
          userId: cognitoPayload['custom:user_id'],
          email: cognitoPayload.email,
          organizationId: cognitoPayload['custom:organization_id'],
          role: cognitoPayload['custom:role'],
          type: 'access',
        };
      } catch (error) {
        logger.error('Failed to verify Cognito token', error);
        throw new Error('Invalid token');
      }
    }

    throw new Error('Local token verification not supported. Please use Cognito.');
  }

  async logout(refreshToken: string): Promise<void> {
    await query(
      `DELETE FROM sessions WHERE refresh_token = $1`,
      [refreshToken]
    );

    logger.info('User logged out');
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.getUserById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    if (config.aws.cognito.userPoolId) {
      try {
        await cognitoService.authenticateUser(user.email, currentPassword);
        await cognitoService.setUserPassword(user.email, newPassword, true);
      } catch (error: any) {
        if (error.name === 'NotAuthorizedException') {
          throw new Error('Current password is incorrect');
        }
        throw error;
      }
    } else if (user.password_hash) {
      const isValidPassword = await bcrypt.compare(currentPassword, user.password_hash);
      if (!isValidPassword) {
        throw new Error('Current password is incorrect');
      }
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    
    await query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [newPasswordHash, userId]
    );

    await query(
      `DELETE FROM sessions WHERE user_id = $1`,
      [userId]
    );

    logger.info('Password changed', { userId });
  }

  async getUserById(userId: string): Promise<User | null> {
    const cached = await cacheService.get<User>(CacheKeys.user(userId));
    if (cached) {
      return cached;
    }

    const result = await query<User>(
      `SELECT * FROM users WHERE id = $1`,
      [userId]
    );

    if (result.length === 0) {
      return null;
    }

    const user = result[0];
    await cacheService.set(CacheKeys.user(userId), user, { ttl: 3600 });

    return user;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const normalized = normalizeEmail(email);
    const cached = await cacheService.get<User>(CacheKeys.userByEmail(normalized));
    if (cached) {
      return cached;
    }

    const result = await query<User>(
      `SELECT * FROM users WHERE email = $1`,
      [normalized]
    );

    if (result.length === 0) {
      return null;
    }

    const user = result[0];
    await cacheService.set(CacheKeys.userByEmail(normalized), user, { ttl: 3600 });

    return user;
  }

  private async updateLastLogin(userId: string): Promise<void> {
    await query(
      `UPDATE users SET last_login = NOW() WHERE id = $1`,
      [userId]
    );
  }
}

export const authService = new AuthService();