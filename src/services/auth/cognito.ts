import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
  CreateGroupCommand,
  ListUsersCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminResetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  MessageActionType,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export interface CognitoUser {
  username: string;
  email: string;
  emailVerified: boolean;
  enabled: boolean;
  userStatus: string;
  attributes: Record<string, string>;
  groups: string[];
}

export class CognitoService {
  private client: CognitoIdentityProviderClient;
  private userPoolId: string;
  private clientId: string;
  private idTokenVerifier: any;
  private accessTokenVerifier: any;

  constructor() {
    this.client = new CognitoIdentityProviderClient({
      region: config.aws.region || 'us-east-1',
    });

    this.userPoolId = config.aws.cognito.userPoolId || '';
    this.clientId = config.aws.cognito.clientId || '';

    if (this.userPoolId && this.clientId) {
      this.idTokenVerifier = CognitoJwtVerifier.create({
        userPoolId: this.userPoolId,
        tokenUse: 'id',
        clientId: this.clientId,
      });

      this.accessTokenVerifier = CognitoJwtVerifier.create({
        userPoolId: this.userPoolId,
        tokenUse: 'access',
        clientId: this.clientId,
      });
    }
  }

  async createUser(params: {
    email: string;
    temporaryPassword: string;
    attributes?: Record<string, string>;
    messageAction?: MessageActionType;
  }): Promise<CognitoUser> {
    try {
      const userAttributes = [
        { Name: 'email', Value: params.email },
        { Name: 'email_verified', Value: 'true' },
      ];

      if (params.attributes) {
        Object.entries(params.attributes).forEach(([key, value]) => {
          userAttributes.push({ Name: key, Value: value });
        });
      }

      const command = new AdminCreateUserCommand({
        UserPoolId: this.userPoolId,
        Username: params.email,
        UserAttributes: userAttributes,
        TemporaryPassword: params.temporaryPassword,
        MessageAction: params.messageAction || 'SUPPRESS',
      });

      const response = await this.client.send(command);

      logger.info('Cognito user created', { email: params.email });

      return this.formatUser(response.User);
    } catch (error) {
      logger.error('Failed to create Cognito user', error);
      throw error;
    }
  }

  async getUser(username: string): Promise<CognitoUser | null> {
    try {
      const command = new AdminGetUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
      });

      const response = await this.client.send(command);

      const groups = await this.getUserGroups(username);

      return {
        username: response.Username || username,
        email: this.getAttributeValue(response.UserAttributes, 'email') || '',
        emailVerified: this.getAttributeValue(response.UserAttributes, 'email_verified') === 'true',
        enabled: response.Enabled !== false,
        userStatus: response.UserStatus || '',
        attributes: this.formatAttributes(response.UserAttributes),
        groups,
      };
    } catch (error: any) {
      if (error.name === 'UserNotFoundException') {
        return null;
      }
      logger.error('Failed to get Cognito user', error);
      throw error;
    }
  }

  async updateUserAttributes(username: string, attributes: Record<string, string>) {
    try {
      const userAttributes = Object.entries(attributes).map(([key, value]) => ({
        Name: key,
        Value: value,
      }));

      const command = new AdminUpdateUserAttributesCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        UserAttributes: userAttributes,
      });

      await this.client.send(command);

      logger.info('User attributes updated', { username });
    } catch (error) {
      logger.error('Failed to update user attributes', error);
      throw error;
    }
  }

  async deleteUser(username: string) {
    try {
      const command = new AdminDeleteUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
      });

      await this.client.send(command);

      logger.info('Cognito user deleted', { username });
    } catch (error) {
      logger.error('Failed to delete Cognito user', error);
      throw error;
    }
  }

  async setUserPassword(username: string, password: string, permanent = true) {
    try {
      const command = new AdminSetUserPasswordCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        Password: password,
        Permanent: permanent,
      });

      await this.client.send(command);

      logger.info('User password set', { username, permanent });
    } catch (error) {
      logger.error('Failed to set user password', error);
      throw error;
    }
  }

  async authenticateUser(username: string, password: string) {
    try {
      const command = new AdminInitiateAuthCommand({
        UserPoolId: this.userPoolId,
        ClientId: this.clientId,
        AuthFlow: 'ADMIN_NO_SRP_AUTH',
        AuthParameters: {
          USERNAME: username,
          PASSWORD: password,
        },
      });

      const response = await this.client.send(command);

      if (response.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
        return {
          challengeName: response.ChallengeName,
          session: response.Session,
          challengeParameters: response.ChallengeParameters,
        };
      }

      return {
        idToken: response.AuthenticationResult?.IdToken,
        accessToken: response.AuthenticationResult?.AccessToken,
        refreshToken: response.AuthenticationResult?.RefreshToken,
        expiresIn: response.AuthenticationResult?.ExpiresIn,
      };
    } catch (error) {
      logger.error('Failed to authenticate user', error);
      throw error;
    }
  }

  async respondToNewPasswordChallenge(
    username: string,
    newPassword: string,
    session: string
  ) {
    try {
      const command = new AdminRespondToAuthChallengeCommand({
        UserPoolId: this.userPoolId,
        ClientId: this.clientId,
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        ChallengeResponses: {
          USERNAME: username,
          NEW_PASSWORD: newPassword,
        },
        Session: session,
      });

      const response = await this.client.send(command);

      return {
        idToken: response.AuthenticationResult?.IdToken,
        accessToken: response.AuthenticationResult?.AccessToken,
        refreshToken: response.AuthenticationResult?.RefreshToken,
        expiresIn: response.AuthenticationResult?.ExpiresIn,
      };
    } catch (error) {
      logger.error('Failed to respond to new password challenge', error);
      throw error;
    }
  }

  async refreshTokens(refreshToken: string) {
    try {
      const command = new AdminInitiateAuthCommand({
        UserPoolId: this.userPoolId,
        ClientId: this.clientId,
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        AuthParameters: {
          REFRESH_TOKEN: refreshToken,
        },
      });

      const response = await this.client.send(command);

      return {
        idToken: response.AuthenticationResult?.IdToken,
        accessToken: response.AuthenticationResult?.AccessToken,
        expiresIn: response.AuthenticationResult?.ExpiresIn,
      };
    } catch (error) {
      logger.error('Failed to refresh tokens', error);
      throw error;
    }
  }

  async verifyIdToken(token: string) {
    try {
      const payload = await this.idTokenVerifier.verify(token);
      return payload;
    } catch (error) {
      logger.error('Failed to verify ID token', error);
      throw error;
    }
  }

  async verifyAccessToken(token: string) {
    try {
      const payload = await this.accessTokenVerifier.verify(token);
      return payload;
    } catch (error) {
      logger.error('Failed to verify access token', error);
      throw error;
    }
  }

  async createGroup(groupName: string, description?: string, roleArn?: string) {
    try {
      const command = new CreateGroupCommand({
        GroupName: groupName,
        UserPoolId: this.userPoolId,
        Description: description,
        RoleArn: roleArn,
      });

      await this.client.send(command);

      logger.info('Cognito group created', { groupName });
    } catch (error: any) {
      if (error.name !== 'GroupExistsException') {
        logger.error('Failed to create Cognito group', error);
        throw error;
      }
    }
  }

  async addUserToGroup(username: string, groupName: string) {
    try {
      const command = new AdminAddUserToGroupCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        GroupName: groupName,
      });

      await this.client.send(command);

      logger.info('User added to group', { username, groupName });
    } catch (error) {
      logger.error('Failed to add user to group', error);
      throw error;
    }
  }

  async removeUserFromGroup(username: string, groupName: string) {
    try {
      const command = new AdminRemoveUserFromGroupCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        GroupName: groupName,
      });

      await this.client.send(command);

      logger.info('User removed from group', { username, groupName });
    } catch (error) {
      logger.error('Failed to remove user from group', error);
      throw error;
    }
  }

  async getUserGroups(username: string): Promise<string[]> {
    try {
      const command = new AdminListGroupsForUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
      });

      const response = await this.client.send(command);

      return response.Groups?.map(group => group.GroupName || '') || [];
    } catch (error) {
      logger.error('Failed to get user groups', error);
      return [];
    }
  }

  async listUsers(params?: {
    limit?: number;
    paginationToken?: string;
    filter?: string;
  }) {
    try {
      const command = new ListUsersCommand({
        UserPoolId: this.userPoolId,
        Limit: params?.limit,
        PaginationToken: params?.paginationToken,
        Filter: params?.filter,
      });

      const response = await this.client.send(command);

      return {
        users: response.Users?.map(user => this.formatUser(user)) || [],
        paginationToken: response.PaginationToken,
      };
    } catch (error) {
      logger.error('Failed to list users', error);
      throw error;
    }
  }

  async disableUser(username: string) {
    try {
      const command = new AdminDisableUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
      });

      await this.client.send(command);

      logger.info('User disabled', { username });
    } catch (error) {
      logger.error('Failed to disable user', error);
      throw error;
    }
  }

  async enableUser(username: string) {
    try {
      const command = new AdminEnableUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
      });

      await this.client.send(command);

      logger.info('User enabled', { username });
    } catch (error) {
      logger.error('Failed to enable user', error);
      throw error;
    }
  }

  async resetUserPassword(username: string) {
    try {
      const command = new AdminResetUserPasswordCommand({
        UserPoolId: this.userPoolId,
        Username: username,
      });

      await this.client.send(command);

      logger.info('User password reset initiated', { username });
    } catch (error) {
      logger.error('Failed to reset user password', error);
      throw error;
    }
  }

  private formatUser(user: any): CognitoUser {
    return {
      username: user.Username || '',
      email: this.getAttributeValue(user.Attributes, 'email') || '',
      emailVerified: this.getAttributeValue(user.Attributes, 'email_verified') === 'true',
      enabled: user.Enabled !== false,
      userStatus: user.UserStatus || '',
      attributes: this.formatAttributes(user.Attributes),
      groups: [],
    };
  }

  private getAttributeValue(attributes: any[] | undefined, name: string): string | undefined {
    return attributes?.find(attr => attr.Name === name)?.Value;
  }

  private formatAttributes(attributes: any[] | undefined): Record<string, string> {
    const result: Record<string, string> = {};
    attributes?.forEach(attr => {
      if (attr.Name && attr.Value) {
        result[attr.Name] = attr.Value;
      }
    });
    return result;
  }
}

export const cognitoService = new CognitoService();