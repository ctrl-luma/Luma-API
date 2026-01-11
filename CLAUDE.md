# Claude AI Assistant Documentation for Luma API

## Project Overview

Luma API is a backend service for a Stripe-integrated POS system designed for mobile bars and events. It's built with:
- **Framework**: Hono.js with OpenAPI/Swagger documentation
- **Database**: PostgreSQL with automatic migrations
- **Authentication**: AWS Cognito + local JWT
- **Email**: Amazon SES with HTML templates
- **Cache**: Redis
- **Queue**: BullMQ
- **Deployment**: Docker on Kubernetes

## Critical Development Rules

### 🔥 CACHE INVALIDATION REQUIREMENT
**MANDATORY**: When updating any user data in PostgreSQL, you MUST invalidate the Redis cache:

```typescript
// After ANY user UPDATE query, add this:
await cacheService.del(CacheKeys.user(userId));
await cacheService.del(CacheKeys.userByEmail(userEmail));
```

**Why**: The app caches users by both ID and email. Failing to invalidate cache will cause stale data to be returned by `/auth/me` and other endpoints.

**Examples of when cache invalidation is required**:
- Profile updates
- Password changes  
- Notification preference updates
- Role changes
- Any field modification in the `users` table

## Architecture Overview

### Core Services
- **Auth Service** (`src/services/auth/index.ts`): User management, JWT tokens, Cognito integration
- **Email Service** (`src/services/email/`): SES integration with HTML templates
- **Stripe Service** (`src/services/stripe/`): Payment processing, webhooks
- **Cache Service** (`src/services/redis/cache.ts`): Redis caching layer
- **Queue Service** (`src/services/queue/`): Background job processing
- **Image Service** (`src/services/images/index.ts`): Profile picture uploads to file server

### Database
- **Location**: `src/db/`
- **Migrations**: Auto-run on server start from `db/migrations/`
- **Models**: TypeScript interfaces in `src/db/models/`
- **Connection**: PostgreSQL with connection pooling

### Routes Structure
```
/auth/*           - Authentication (login, register, password reset, profile)
/organizations/*  - Organization management
/stripe/*         - Payment webhooks
/contact          - Contact form
```

## Environment Configuration

### Required Environment Variables
```bash
# Database
DATABASE_URL=postgresql://user:pass@host:port/db
DB_SSL=false

# Redis
REDIS_URL=redis://localhost:6379

# AWS Services
AWS_REGION=us-east-2
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx

# Cognito
COGNITO_USER_POOL_ID=xxx
COGNITO_CLIENT_ID=xxx
COGNITO_CLIENT_SECRET=xxx

# Email
EMAIL_DEFAULT_FROM=no-reply@lumapos.co
DASHBOARD_URL=https://portal.lumapos.co
SITE_URL=https://lumapos.co
CONTACT_URL=https://lumapos.co/contact

# Stripe
STRIPE_SECRET_KEY=sk_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_xxx

# CORS
CORS_ORIGIN=http://localhost:3001,http://localhost:3333,https://portal.lumapos.co

# Image File Server (profile pictures)
IMAGE_FILE_SERVER_URL=https://images.lumapos.co  # or https://dev.images.lumapos.co for dev
IMAGE_MAX_SIZE_BYTES=5242880  # 5MB default
```

## Key Features

### Authentication System
- **Cognito Integration**: Primary auth with AWS Cognito
- **Local Fallback**: BCrypt for password hashing
- **JWT Tokens**: Access + refresh token flow
- **Password Reset**: Email-based with 10-minute expiration tokens
- **User Roles**: owner, admin, user, bartender

### Email System
- **Templates**: HTML email templates in `src/services/email/templates/`
- **Template Engine**: Custom variable replacement (not Handlebars)
- **Email Types**: Welcome, password reset, order confirmation, receipts, payouts
- **Template Variables**:
  ```typescript
  {
    subject: string;
    email_title: string;
    email_content: string; // HTML content
    cta_url?: string;      // Button URL
    cta_text?: string;     // Button text
    site_url: string;
    dashboard_url: string;
    security_notice?: boolean;
  }
  ```

### Database Schema

#### Users Table
```sql
users (
  id UUID PRIMARY KEY,
  email VARCHAR UNIQUE,
  password_hash VARCHAR,
  first_name VARCHAR,
  last_name VARCHAR,
  phone VARCHAR,
  organization_id UUID,
  role VARCHAR,
  is_active BOOLEAN DEFAULT true,
  cognito_user_id VARCHAR,

  -- Notification Preferences (added in migration 006)
  email_alerts BOOLEAN DEFAULT true,
  marketing_emails BOOLEAN DEFAULT true,
  weekly_reports BOOLEAN DEFAULT true,

  -- Profile Picture (added in migration 010)
  avatar_image_id VARCHAR,  -- ID of image stored on file server

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
)
```

#### Password Reset Tokens Table
```sql
password_reset_tokens (
  id UUID PRIMARY KEY,           -- Used in reset URL
  user_id UUID REFERENCES users(id),
  token_hash VARCHAR(255),       -- SHA256 hashed token
  expires_at TIMESTAMP,          -- 10 minute expiration
  used_at TIMESTAMP,             -- NULL until used
  created_at TIMESTAMP DEFAULT NOW()
)
```

### API Endpoints

#### Authentication
- `POST /auth/login` - User login
- `POST /auth/refresh` - Refresh access token
- `POST /auth/logout` - Logout
- `GET /auth/me` - Get current user info
- `PATCH /auth/profile` - Update user profile
- `PATCH /auth/notification-preferences` - Update notification settings
- `POST /auth/avatar` - Upload or replace profile picture (multipart/form-data)
- `DELETE /auth/avatar` - Delete profile picture
- `POST /auth/forgot-password` - Request password reset
- `POST /auth/reset-password` - Complete password reset
- `POST /auth/validate-reset-token` - Check if reset token is valid

#### Organizations
- `GET /organizations/:id` - Get organization details
- `PATCH /organizations/:id` - Update organization

#### Stripe Webhooks
- `POST /stripe/webhooks` - Main Stripe webhooks
- `POST /stripe/connect-webhooks` - Stripe Connect webhooks

### Notification Preferences

Users have three notification settings:
- **emailAlerts**: Important updates (transaction alerts, account updates)
- **marketingEmails**: Feature updates and promotional content  
- **weeklyReports**: Business performance summaries

Default values for new users: All set to `true`

### Profile Picture Upload

Users can upload profile pictures which are stored on a separate image file server.

**Architecture**:
- Backend writes images to PVC mounted at `/data/images/<id>`
- nginx serves images publicly at `IMAGE_FILE_SERVER_URL/images/<id>`
- Image IDs are stored in the `users.avatar_image_id` column

**Upload Flow**:
1. User sends `POST /auth/avatar` with multipart form data containing `file` field
2. Backend validates file type and size
3. If user has existing avatar, the same ID is used (overwrite)
4. File is written atomically (temp file + rename) to prevent serving partial uploads
5. User's `avatar_image_id` is updated in database
6. Cache is invalidated
7. Response includes `avatarUrl` pointing to the public URL

**Constraints**:
- **Allowed types**: `image/png`, `image/jpeg`, `image/webp`, `image/gif`
- **Max size**: Configured via `IMAGE_MAX_SIZE_BYTES` (default 5MB)
- **Storage path**: `/data/images/<id>` (PVC mount point)

**User responses include avatarUrl**:
- `POST /auth/login` - Returns `user.avatarUrl`
- `GET /auth/me` - Returns `avatarUrl`
- `PATCH /auth/profile` - Returns `avatarUrl`
- `POST /auth/avatar` - Returns `avatarUrl` and `avatarImageId`

**Delete**: `DELETE /auth/avatar` removes the image file and clears `avatar_image_id`

### Password Reset Flow

1. User requests reset via `POST /auth/forgot-password`
2. System creates UUID token ID and stores hashed version in DB
3. Email sent with link: `${DASHBOARD_URL}/reset-password?token=${tokenId}`
4. User clicks link, frontend validates token via `POST /auth/validate-reset-token`
5. User submits new password via `POST /auth/reset-password`
6. System validates token, updates password in both DB and Cognito
7. All user tokens for that user are invalidated

### Email Templates

Located in `src/services/email/templates/email-template.html`

Template functions:
- `sendWelcomeEmail(email, userData)`
- `sendPasswordResetEmail(email, tokenId)` 
- `sendOrderConfirmationEmail(email, orderData)`
- `sendReceiptEmail(email, receiptData)`
- `sendPayoutEmail(email, payoutData)`

## Development Guidelines

### Adding New Endpoints
1. Define Zod schema for request/response
2. Create OpenAPI route with `createRoute()`
3. Implement handler with proper error handling
4. Add authentication if required
5. Update this documentation

### Database Changes
1. Create migration file in `db/migrations/` with incrementing number
2. Use format: `XXX_descriptive_name.sql`
3. Migrations auto-run on server startup
4. Update TypeScript interfaces in `src/db/models/`

### Cache Management
- Cache keys defined in `src/services/redis/cache.ts`
- User data cached by both ID and email
- TTL: 1 hour for user data
- **CRITICAL**: Always invalidate cache after user updates

### Error Handling
- Use structured logging with Winston
- Return consistent error formats
- Log security events (auth failures, etc.)
- Don't expose internal errors to clients

### Security Considerations
- All passwords hashed with BCrypt (salt rounds: 10)
- Password reset tokens are hashed before storage
- JWT tokens have expiration
- CORS configured for specific origins
- Input validation with Zod
- SQL injection prevention with parameterized queries

### Single Session Enforcement
The app enforces single session per user - signing in on a new device kicks out the old session.

**How it works:**
1. **On login**: `session_version` is incremented in the database and returned to the client
2. **Socket notification**: `SESSION_KICKED` event is emitted to existing connections before login completes
3. **API validation**: Client sends `X-Session-Version` header; if lower than DB version, returns 401 with `code: 'SESSION_KICKED'`
4. **Redis cache**: Session version is cached in Redis for fast auth middleware checks

**Files involved:**
- `db/migrations/025_add_session_version_to_users.sql` - Adds `session_version` column
- `src/services/auth/index.ts` - `incrementSessionVersion()`, `getSessionVersion()`, emits Socket event on login
- `src/middleware/auth.ts` - Checks `X-Session-Version` header against current session version
- `src/services/socket/index.ts` - `SESSION_KICKED` event definition

**Client implementation:**
- Store `sessionVersion` from login response
- Send `X-Session-Version` header with all requests
- Handle `SESSION_KICKED` error code (401) by logging out and showing alert
- Listen for `session:kicked` socket event for immediate notification

## Troubleshooting

### Common Issues

1. **CORS Errors**: Ensure all HTTP methods are in `allowMethods` array in `src/index.ts`
2. **Cache Issues**: Check if cache invalidation was added after user updates
3. **Email Failures**: Verify SES identity verification and sandbox mode status
4. **Migration Errors**: Check PostgreSQL connection and migration file syntax
5. **Auth Issues**: Verify Cognito configuration and JWT token validity

### Debugging Tips
- Check logs for structured error information
- Use `/auth/me` to verify token validity
- Check Redis cache contents during development
- Verify environment variables are loaded correctly

### Database Connection Issues
- Verify `DATABASE_URL` format
- Check SSL settings with `DB_SSL` environment variable
- Ensure database exists and user has proper permissions

## Testing

- Test framework: Vitest
- Run tests: `npm test`
- Coverage: `npm run test:coverage`
- Watch mode: `npm run test:watch`

## Deployment

- Build: `npm run build`
- Start: `npm start`
- Development: `npm run dev`
- Docker builds: `npm run build:dev` or `npm run build:prod`

## Scripts

```json
{
  "dev": "tsx watch src/index.ts",
  "build": "tsc", 
  "start": "node dist/index.js",
  "test": "vitest",
  "lint": "eslint . --ext .ts",
  "typecheck": "tsc --noEmit"
}
```

## Important Files

- `src/index.ts` - Main server entry point
- `src/config/index.ts` - Environment configuration
- `src/db/migrate.ts` - Database migration system
- `src/middleware/` - Custom middleware
- `src/utils/logger.ts` - Winston logging configuration
- `CLAUDE.md` - This documentation file

---

**Remember**: This is a financial application handling payments and user data. Always prioritize security, data integrity, and proper error handling.