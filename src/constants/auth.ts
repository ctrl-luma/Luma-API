export const COGNITO_GROUPS = {
  OWNER: 'owner',
  USER: 'user',
} as const;

export type CognitoGroup = typeof COGNITO_GROUPS[keyof typeof COGNITO_GROUPS];

// Database role mappings (different from Cognito groups)
export const DB_ROLES = {
  OWNER: 'owner',
  MANAGER: 'manager',
  BARTENDER: 'bartender',
  BARBACK: 'barback',
  ADMIN: 'admin',
} as const;

export type DbRole = typeof DB_ROLES[keyof typeof DB_ROLES];

// Map database roles to Cognito groups
export function mapDbRoleToCognitoGroup(dbRole: DbRole): CognitoGroup {
  switch (dbRole) {
    case DB_ROLES.OWNER:
    case DB_ROLES.MANAGER:
    case DB_ROLES.ADMIN:
      return COGNITO_GROUPS.OWNER;
    case DB_ROLES.BARTENDER:
    case DB_ROLES.BARBACK:
    default:
      return COGNITO_GROUPS.USER;
  }
}