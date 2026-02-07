# Luma-API - Backend API Documentation

> **For full ecosystem context, see the root [CLAUDE.md](../CLAUDE.md)**

## Project Overview

Luma API is the backend service powering the Luma POS ecosystem - a Stripe-integrated mobile payment system for mobile bars, food trucks, pop-up vendors, and event merchants.

**Tech Stack:**
- **Framework:** Hono v4.6.14 (ultra-fast edge-ready web framework)
- **Runtime:** Node.js 20+, TypeScript 5.7
- **Database:** PostgreSQL 17
- **Cache:** Redis 8
- **Queue:** BullMQ v5.63
- **Auth:** AWS Cognito + JWT
- **Payments:** Stripe v19.3 (Connect, Terminal, Webhooks)
- **Email:** Resend with centralized HTML template
- **Geocoding:** Google Maps Geocoding API
- **Real-time:** Socket.IO v4.8

---

## Critical Development Rules

### Cache Invalidation (MANDATORY)

When updating ANY user data in PostgreSQL, you **MUST** invalidate the Redis cache:

```typescript
// After ANY user UPDATE query, add this:
await cacheService.del(CacheKeys.user(userId));
await cacheService.del(CacheKeys.userByEmail(userEmail));
```

**Why:** The app caches users by both ID and email. Failing to invalidate causes stale data.

**Required after:**
- Profile updates
- Password changes
- Notification preference updates
- Role/permissions changes
- Avatar updates
- Session version changes
- Any field modification in the `users` table

### Single Session Enforcement

The app enforces one active session per user. Logging in on a new device kicks out previous sessions.

**Flow:**
1. On login: `session_version` incremented in DB
2. Socket emits `SESSION_KICKED` to existing connections
3. API validates `X-Session-Version` header on requests
4. Mismatched version returns 401 with `code: 'SESSION_KICKED'`

**Files involved:**
- `db/migrations/025_add_session_version_to_users.sql`
- `src/services/auth/index.ts` - `incrementSessionVersion()`, `getSessionVersion()`
- `src/middleware/auth.ts` - Header validation
- `src/services/socket/index.ts` - `SESSION_KICKED` event

---

## Directory Structure

```
Luma-API/
├── src/
│   ├── config/
│   │   ├── index.ts                 # Zod-validated environment config
│   │   └── platform-fees.ts         # Subscription tier fee calculations
│   ├── db/
│   │   ├── index.ts                 # PostgreSQL connection pool
│   │   ├── migrate.ts               # Auto-migration runner
│   │   └── models/
│   │       ├── index.ts             # TypeScript interfaces
│   │       └── subscription.ts      # Subscription types
│   ├── middleware/
│   │   ├── auth.ts                  # JWT verification, session check
│   │   ├── error-handler.ts         # Global error handling
│   │   └── request-id.ts            # Request ID generation
│   ├── routes/
│   │   ├── auth/                    # Authentication routes
│   │   ├── stripe/                  # Stripe webhooks & Connect
│   │   ├── catalogs.ts              # Menu management
│   │   ├── products.ts              # Product library
│   │   ├── catalog-products.ts      # Per-catalog pricing
│   │   ├── categories.ts            # Product categories
│   │   ├── orders.ts                # Order management
│   │   ├── customers.ts             # Customer tracking
│   │   ├── billing.ts               # Subscription management
│   │   ├── staff.ts                 # Staff invitations
│   │   ├── splits.ts                # Revenue splits
│   │   ├── tips.ts                  # Tip pooling
│   │   ├── events.ts                # Events & ticketing
│   │   ├── menu.ts                  # Public external menu (unauthenticated)
│   │   └── preorders.ts             # Vendor preorder management (authenticated)
│   ├── services/
│   │   ├── auth/                    # Auth + Cognito
│   │   ├── email/                   # Resend + centralized template
│   │   ├── geocoder/                # Google Maps geocoding
│   │   ├── stripe/                  # Stripe + Terminal
│   │   ├── redis/                   # Cache layer
│   │   ├── socket/                  # Socket.IO
│   │   └── queue/                   # BullMQ workers
│   └── index.ts                     # Server entry
├── db/
│   ├── init.sql                     # Initial schema
│   └── migrations/                  # 001-033 migration files
└── docker-compose.yml               # Local dev services
```

---

## API Routes Reference

### Authentication (`/auth/*`)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/auth/login` | User login (returns tokens + sessionVersion) |
| POST | `/auth/signup` | Registration with org creation |
| POST | `/auth/refresh` | Token refresh |
| POST | `/auth/logout` | Invalidate tokens |
| GET | `/auth/me` | Get current user (cached) |
| PATCH | `/auth/profile` | Update profile |
| PATCH | `/auth/notification-preferences` | Update email prefs |
| POST | `/auth/avatar` | Upload profile picture |
| DELETE | `/auth/avatar` | Remove profile picture |
| POST | `/auth/forgot-password` | Request reset email |
| POST | `/auth/reset-password` | Complete reset |
| POST | `/auth/validate-reset-token` | Check token validity |

### Catalogs (`/catalogs/*`)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/catalogs` | List org catalogs |
| POST | `/catalogs` | Create catalog |
| GET | `/catalogs/{id}` | Get single catalog |
| PUT | `/catalogs/{id}` | Update catalog |
| DELETE | `/catalogs/{id}` | Delete catalog |

### Categories (`/catalogs/{catalogId}/categories`)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/categories` | List categories |
| POST | `/categories` | Create category |
| PATCH | `/categories/{id}` | Update category |
| DELETE | `/categories/{id}` | Delete category |
| POST | `/categories/reorder` | Reorder categories |

### Products

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/products` | List org product library |
| POST | `/products` | Create product |
| PATCH | `/products/{id}` | Update product |
| DELETE | `/products/{id}` | Delete product |
| GET | `/catalogs/{id}/products` | List catalog products (with pricing) |
| POST | `/catalogs/{id}/products` | Add product to catalog |
| PATCH | `/catalogs/{id}/products/{id}` | Update catalog product |
| DELETE | `/catalogs/{id}/products/{id}` | Remove from catalog |
| POST | `/catalogs/{id}/products/reorder` | Reorder products |

### Orders (`/orders`)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/orders` | List orders |
| POST | `/orders` | Create order |
| GET | `/orders/{id}` | Get order details |
| PATCH | `/orders/{id}` | Update order |
| POST | `/orders/{id}/refund` | Refund order |

### Stripe Terminal (Tap to Pay)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/stripe/terminal/location` | Get/create terminal location |
| POST | `/stripe/terminal/connection-token` | Get SDK connection token |
| POST | `/stripe/terminal/payment-intent` | Create payment intent |
| GET | `/stripe/terminal/payment-intent/{id}/status` | Check payment status |
| POST | `/stripe/terminal/payment-intent/{id}/send-receipt` | Send receipt email |
| POST | `/stripe/terminal/payment-intent/{id}/simulate` | Test mode simulation |

### Stripe Connect

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/stripe/connect/status` | Get Connect account status |
| POST | `/stripe/connect/create-account` | Start onboarding |
| GET | `/stripe/connect/dashboard` | Dashboard metrics |
| GET | `/stripe/connect/analytics` | Analytics data |
| GET | `/stripe/connect/transactions` | Transaction history |
| GET | `/stripe/connect/balance` | Account balance |
| POST | `/stripe/connect/payouts` | Create payout |

### Staff & Tips

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET/POST | `/staff` | List/invite staff |
| PATCH/DELETE | `/staff/{id}` | Update/disable staff |
| POST | `/staff/{token}/accept` | Accept invitation |
| GET/POST | `/tips/pools` | List/create tip pools |
| POST | `/tips/pools/{id}/finalize` | Finalize tip pool |
| GET/POST | `/catalogs/{id}/splits` | Revenue splits |

### Events & Ticketing

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/events` | List public events |
| POST | `/events` | Create event |
| GET | `/events/:id` | Get event details |
| PUT | `/events/:id` | Update event |
| DELETE | `/events/:id` | Delete event |
| GET | `/events/:id/tickets` | List tickets sold |
| POST | `/events/:id/tickets/:ticketId/refund` | Refund ticket |
| POST | `/events/:id/ticket-tiers` | Create ticket tier |
| PATCH | `/events/:id/ticket-tiers/:tierId` | Update tier |
| DELETE | `/events/:id/ticket-tiers/:tierId` | Delete tier |
| POST | `/tickets/:ticketId/scan` | Scan ticket QR code |
| GET | `/tickets/:ticketId/qr.png` | Get ticket QR image |
| GET | `/tickets/:ticketId/wallet/apple` | Apple Wallet pass |
| GET | `/tickets/:ticketId/wallet/google` | Google Wallet pass |

### External Menus — Public (Unauthenticated)

These endpoints power the customer-facing menu on the marketing site. No auth required.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/menu/public/{slug}` | Fetch catalog with products and categories (requires `preorder_enabled = true`) |
| POST | `/menu/public/{slug}/preorder` | Create preorder (with optional Stripe payment) |
| GET | `/menu/public/{slug}/preorder/{id}` | Get preorder status (requires `?email=` query param) |
| POST | `/menu/public/{slug}/preorder/{id}/cancel` | Customer cancels preorder (requires email match, only if `pending`) |

**Create preorder request body:**
```typescript
{
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  paymentType: 'pay_now' | 'pay_at_pickup';
  items: { catalogProductId: string; quantity: number; notes?: string }[];
  tipAmount?: number;
  orderNotes?: string;
  paymentMethodId?: string; // Required for pay_now
}
```

**Pay Now flow:** API clones the Stripe payment method to the connected account, creates a PaymentIntent with `application_fee_amount`, and confirms immediately. Refunds are issued automatically on cancellation.

### Preorders — Vendor Management (Authenticated)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/preorders` | List preorders (filter by `catalogId`, `status`, paginated) |
| GET | `/preorders/stats` | Dashboard stats (counts by status, today's revenue) |
| GET | `/preorders/{id}` | Get preorder details |
| PATCH | `/preorders/{id}/status` | Update status (`confirmed`, `preparing`, `ready`) |
| POST | `/preorders/{id}/complete` | Mark picked up (pass `stripePaymentIntentId` for pay_at_pickup) |
| POST | `/preorders/{id}/cancel` | Vendor cancels (auto-refunds paid orders, optional reason) |

**Status transitions:** `pending → confirmed → preparing → ready → picked_up` (or `cancelled` from any non-terminal state)

### Webhooks

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/stripe/webhook` | Stripe events |
| POST | `/stripe/connect-webhooks` | Connect events |
| POST | `/apple-webhooks` | App Store subscriptions |
| POST | `/google-webhooks` | Google Play subscriptions |

---

## Database Schema

### Core Tables

**users**
```sql
id UUID PRIMARY KEY,
email VARCHAR UNIQUE,
password_hash VARCHAR,
first_name, last_name, phone VARCHAR,
organization_id UUID FK,
role user_role,                    -- 'owner' | 'user' | 'admin'
is_active BOOLEAN DEFAULT true,
cognito_user_id VARCHAR UNIQUE,
session_version INTEGER DEFAULT 0,
-- Notification preferences
email_alerts, marketing_emails, weekly_reports BOOLEAN DEFAULT true,
avatar_image_id VARCHAR,
-- Staff invite fields
invited_by UUID, invite_token VARCHAR, invite_expires_at, invite_accepted_at,
-- Timestamps
last_login, created_at, updated_at
```

**catalogs** - Event/location-specific menus
```sql
id, organization_id FK, name, description, location, date,
is_active, show_tip_screen, prompt_for_email,
tip_percentages JSON,              -- [15, 18, 20, 25]
allow_custom_tip BOOLEAN,
tax_rate DECIMAL,
layout_type VARCHAR,               -- 'grid' | 'list' | 'large-grid' | 'compact'
-- Preorder settings (migration 048)
preorder_enabled BOOLEAN DEFAULT false,
slug VARCHAR(200) UNIQUE,          -- Public menu URL: /menu/{slug}
preorder_payment_mode VARCHAR(20) DEFAULT 'both', -- 'pay_now' | 'pay_at_pickup' | 'both'
pickup_instructions TEXT,
estimated_prep_time INTEGER DEFAULT 10  -- minutes
```

**products** - Organization product library (no pricing)
```sql
id, organization_id FK, name, description,
image_id, image_url
```

**catalog_products** - Per-catalog pricing
```sql
id, catalog_id FK, product_id FK, category_id FK,
price DECIMAL(10,2),               -- In dollars (NOT cents)
sort_order, is_active,
UNIQUE(catalog_id, product_id)
```

**orders**
```sql
id, organization_id FK, catalog_id FK, customer_id FK, user_id FK,
order_number, status, payment_method,
subtotal, tax_amount, tip_amount, total_amount DECIMAL(10,2),  -- All in dollars
stripe_payment_intent_id, stripe_charge_id,
customer_email, notes, metadata JSONB
```

**subscriptions** - Multi-platform support
```sql
id, user_id FK, organization_id FK,
tier subscription_tier,            -- 'starter' | 'pro' | 'enterprise'
status subscription_status,
platform subscription_platform,    -- 'stripe' | 'apple' | 'google'
-- Stripe fields
stripe_subscription_id, stripe_customer_id,
-- Apple fields
apple_original_transaction_id, apple_product_id,
-- Google fields
google_purchase_token, google_order_id,
-- Billing
monthly_price, transaction_fee_rate, features JSONB
```

**preorders** - Customer preorders from external menus (migration 049)
```sql
id UUID PRIMARY KEY,
organization_id UUID FK, catalog_id UUID FK,
order_number VARCHAR(20),          -- Format: PRE-YYYYMMDD-XXXX
customer_name, customer_email, customer_phone,
payment_type VARCHAR(20),          -- 'pay_now' | 'pay_at_pickup'
subtotal, tax_amount, tip_amount, total_amount DECIMAL(10,2), -- All in DOLLARS
stripe_payment_intent_id, stripe_charge_id,
platform_fee_cents INTEGER DEFAULT 0,
status preorder_status DEFAULT 'pending',
  -- ENUM: pending | confirmed | preparing | ready | picked_up | cancelled
estimated_ready_at TIMESTAMPTZ,
ready_at TIMESTAMPTZ,
picked_up_at TIMESTAMPTZ, picked_up_by UUID FK → users,
order_notes TEXT, internal_notes TEXT,
session_id VARCHAR(64), customer_ip INET,  -- Fraud tracking
created_at, updated_at
```

**preorder_items** - Line items for preorders (migration 050)
```sql
id UUID PRIMARY KEY,
preorder_id UUID FK → preorders ON DELETE CASCADE,
catalog_product_id UUID, product_id UUID,
name VARCHAR(255),                 -- Snapshot at time of order
unit_price DECIMAL(10,2),          -- In dollars
quantity INTEGER CHECK (quantity > 0),
notes TEXT                         -- Per-item customer notes (e.g., "no onions")
```

**stripe_connected_accounts**
```sql
id, organization_id FK, stripe_account_id,
charges_enabled, payouts_enabled, details_submitted,
onboarding_state,                  -- 'not_started' | 'incomplete' | 'active' | etc.
requirements_currently_due[], requirements_past_due[],
external_account_last4, external_account_bank_name
```

### Key Relationships

- Products are **org-level** (no price); pricing is **per-catalog** via `catalog_products`
- Categories are **catalog-specific** (not reusable org-wide)
- **Two monetary formats exist:**
  - `orders` table (`subtotal`, `tip_amount`, `total_amount`, `tax_amount`): **`DECIMAL(10,2)` in dollars** — use `parseFloat()`, do NOT divide by 100
  - `order_payments` table (`amount`, `tip_amount`): **`INTEGER` in cents** — use `parseInt()`, divide by 100 to display
  - Stripe API responses: **Integer cents** — divide by 100 to display
- Customers auto-created on first purchase

---

## Socket.IO Events

```typescript
// Order events
ORDER_CREATED, ORDER_UPDATED, ORDER_COMPLETED, ORDER_FAILED, ORDER_REFUNDED
PAYMENT_RECEIVED, TIP_UPDATED, REVENUE_UPDATE

// Catalog events
CATALOG_CREATED, CATALOG_UPDATED, CATALOG_DELETED
PRODUCT_CREATED, PRODUCT_UPDATED, PRODUCT_DELETED
CATEGORY_CREATED, CATEGORY_UPDATED, CATEGORY_DELETED

// Preorder events
PREORDER_CREATED, PREORDER_UPDATED, PREORDER_READY
PREORDER_COMPLETED, PREORDER_CANCELLED

// User events
USER_UPDATED, ORGANIZATION_UPDATED, CONNECT_STATUS_UPDATED
SUBSCRIPTION_UPDATED, SESSION_KICKED
```

**Rooms:**
- `org:{organizationId}` - All org users
- `user:{userId}` - Individual user
- `catalog:{catalogId}` - Catalog subscribers
- `preorder:{preorderId}` - Customer tracking (public namespace)

**Public namespace (`/public`):** Allows unauthenticated Socket.IO connections for customer-facing real-time features. Clients can join `preorder:{id}` and `event:{id}` rooms only.

---

## BullMQ Queues

| Queue | Purpose | Retries |
|-------|---------|---------|
| `payment-processing` | Process Stripe payments | 3 |
| `email-notifications` | Send templated emails | 3 |
| `webhook-delivery` | Retry failed webhooks | 5 |
| `report-generation` | Generate PDF reports | 3 |
| `payout-processing` | Process tip-outs/splits | 3 |

---

## Platform Fees

```typescript
// Applied via application_fee_amount on Stripe charges
PLATFORM_FEES = {
  starter:    { percentRate: 0.002, fixedCents: 3 },   // 0.2% + $0.03
  pro:        { percentRate: 0.001, fixedCents: 1 },   // 0.1% + $0.01
  enterprise: { percentRate: 0, fixedCents: 0 }        // Custom
}
```

---

## Environment Variables

```bash
# Server
NODE_ENV=local|development|production
PORT=3334
API_URL=http://localhost:3334

# Database
DATABASE_URL=postgresql://luma:luma_password@localhost:5432/luma_db
DB_SSL=false

# Redis
REDIS_URL=redis://localhost:6379

# Stripe
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_xxx

# AWS Cognito
COGNITO_USER_POOL_ID=us-east-2_xxxxx
COGNITO_CLIENT_ID=xxxxx
COGNITO_CLIENT_SECRET=xxxxx

# Email (Resend)
RESEND_API_KEY=re_xxxxx
EMAIL_DEFAULT_FROM=no-reply@lumapos.co
DASHBOARD_URL=https://portal.lumapos.co
SITE_URL=https://lumapos.co

# Google Maps Geocoding
GOOGLE_MAPS_API_KEY=AIzaSyXXXXXXX

# CORS
CORS_ORIGIN=http://localhost:3001,http://localhost:3333

# Images
IMAGE_FILE_SERVER_URL=https://images.lumapos.co
IMAGE_MAX_SIZE_BYTES=5242880
IMAGE_STORAGE_PATH=/data/images
```

---

## Development Setup

```bash
# Start infrastructure
docker-compose up -d

# Install dependencies
npm install

# Run development server (migrations auto-run)
npm run dev

# Build for production
npm run build
npm start

# Run tests
npm test
npm run test:coverage
```

### Ports
| Service | Port |
|---------|------|
| Luma API | 3334 |
| PostgreSQL | 5432 |
| Redis | 6379 |
| PgAdmin | 5050 |
| Redis Commander | 8081 |

---

## Common Patterns

### OpenAPI Route Definition
```typescript
const myRoute = createRoute({
  method: 'post',
  path: '/endpoint',
  tags: ['Category'],
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: zodSchema } } }
  },
  responses: { 200: { ... }, 401: { ... } }
});

app.openapi(myRoute, async (c) => {
  const payload = await verifyAuth(c.req.header('Authorization'));
  // ... handler
});
```

### Redis Cache — What's Cached & When to Invalidate

**Service:** `src/services/redis/cache.ts` — Key prefix: `luma:cache:`

**Only user-related data is cached in Redis.** Catalogs, products, orders, preorders, events, and organizations are queried directly from PostgreSQL each time — no Redis caching.

#### Cached Data

| Key Pattern | Data | TTL | Set By |
|-------------|------|-----|--------|
| `user:{userId}` | Full user row | 1 hour | `getUserById()`, login, registration, staff accept |
| `user:email:{email}` | Full user row | 1 hour | `getUserByEmail()`, login, registration, staff accept |
| `session:version:{userId}` | Session version integer | 7 days | Login (app source), `getSessionVersion()` fallback |

#### When You MUST Invalidate (MANDATORY)

After **ANY** modification to the `users` table, you must delete **both** cache keys:

```typescript
await cacheService.del(CacheKeys.user(userId));
await cacheService.del(CacheKeys.userByEmail(userEmail));
```

**All mutation points that require this:**

| Mutation | Location |
|----------|----------|
| Profile update (name, phone) | `routes/auth/index.ts` |
| Avatar upload/delete | `routes/auth/index.ts` |
| Notification preferences | `routes/auth/index.ts` |
| Onboarding completion | `routes/auth/index.ts` |
| Password change/reset | `services/auth/index.ts` |
| Session version increment (login) | `services/auth/index.ts` |
| Staff invite accept | `services/staff/index.ts` |
| Staff update/disable/enable/delete | `services/staff/index.ts` |
| Subscription changes (Stripe/Apple/Google webhooks) | `routes/stripe/webhooks.ts`, `routes/apple-webhooks.ts`, `routes/google-webhooks.ts` |
| Billing sync | `routes/billing.ts` |

**If you add a new endpoint or service that updates the `users` table, you MUST add cache invalidation.** Missing this causes stale user data across the entire app (profile, subscription tier, permissions, session enforcement).

#### Redis Beyond Caching

Redis is also used by **BullMQ** for job queues (same Redis instance):
- `payment-processing`, `email-notifications`, `webhook-delivery`, `report-generation`, `payout-processing`

**Not in Redis:** Geocoder results (in-memory Map), email template HTML (in-memory string).

### Socket Emission
```typescript
socketService.emit(SocketEvents.ORDER_CREATED, {
  organizationId,
  data: { orderId, orderNumber, totalAmount }
}, [`org:${organizationId}`]);
```

### Email Template System
All emails use a centralized HTML template for consistent branding:

```typescript
// src/services/email/template-sender.ts
import { sendTemplatedEmail } from './template-sender';

// Send any email using the centralized template
await sendTemplatedEmail(to, {
  subject: 'Your Subject',
  email_title: 'Email Title',
  email_content: '<p>HTML content here</p>',
  cta_url: 'https://...',      // Optional button
  cta_text: 'Click Here',      // Optional button text
});
```

**Template location:** `src/services/email/templates/email-template.html`

**Available email functions:**
- `sendWelcomeEmail()` - New user welcome
- `sendPasswordResetEmail()` - Password reset link
- `sendTicketConfirmationEmail()` - Event ticket with QR codes
- `sendTicketRefundEmail()` - Ticket refund notification
- `sendTicketReminderEmail()` - Day-before event reminder
- `sendStaffInviteEmail()` - Staff invitation
- `sendOrderConfirmationEmail()` - Order confirmation
- `sendReceiptEmail()` - Payment receipt
- `sendPayoutEmail()` - Payout confirmation
- `sendPreorderConfirmationEmail()` - Preorder placed (with tracking URL)
- `sendPreorderReadyEmail()` - Order ready for pickup
- `sendPreorderCancelledEmail()` - Preorder cancelled (with refund status)

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| CORS errors | Check `CORS_ORIGIN` includes all frontend origins |
| Stale user data | Ensure cache invalidation after user updates |
| Email failures | Verify Resend API key and domain verification |
| Auth issues | Check Cognito config and JWT expiration |
| Session kicked unexpectedly | Check `session_version` increment logic |
| Geocoding failures | Check Google Maps API key and billing enabled |

---

## Security Notes

- All passwords hashed with BCrypt (10 salt rounds)
- Password reset tokens are SHA256 hashed before storage
- JWT tokens have expiration (15min access, 7d refresh)
- Input validation with Zod on all endpoints
- Parameterized queries prevent SQL injection
- Webhook signatures verified (Stripe, Apple, Google)

---

**Remember:** This is a financial application handling payments and user data. Always prioritize security, data integrity, and proper error handling.
