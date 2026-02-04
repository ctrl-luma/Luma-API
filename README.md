# Luma API

Backend API for Luma - Stripe-integrated POS system for mobile bars and events.

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Hono (Ultra-fast web framework)
- **Database**: PostgreSQL 17
- **Cache**: Redis 8
- **Queue**: BullMQ
- **Real-time**: Socket.io
- **Payments**: Stripe
- **API Documentation**: OpenAPI/Swagger
- **Language**: TypeScript

## Quick Start

1. Clone the repository
2. Copy `.env.example` to `.env` and update values
3. Start the infrastructure:
   ```bash
   docker-compose up -d
   ```
4. Install dependencies:
   ```bash
   npm install
   ```
5. Run development server:
   ```bash
   npm run dev
   ```

## API Documentation

Once running, visit:
- Swagger UI: http://localhost:3334/swagger
- OpenAPI JSON: http://localhost:3334/openapi.json

## Docker Services

- **PostgreSQL**: Port 5432
- **Redis**: Port 6379
- **PGAdmin**: Port 5050 (admin@luma.io / admin)
- **Redis Commander**: Port 8081

## Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run lint` - Run ESLint
- `npm run typecheck` - Run TypeScript type checking
- `npm test` - Run tests

## Architecture

The API follows a modular architecture:

- `/src/routes` - API route handlers
- `/src/services` - Business logic
- `/src/db` - Database models and migrations
- `/src/middleware` - Express middleware
- `/src/utils` - Utility functions
- `/src/types` - TypeScript type definitions


TO clear redis cache
 docker exec -it luma_redis redis-cli FLUSHALL

## Apple Wallet Certificates

Two certificate files are required for Apple Wallet pass generation. Both are gitignored and must be present in the repo root.

| File | Purpose | Expires | Renewal |
|------|---------|---------|---------|
| `apple-wallet.p12` | Pass signing certificate (Pass Type ID: `pass.co.lumapos.ticket`) | **2027-03-03** | Regenerate in Apple Developer portal under Certificates > Pass Type ID, export as .p12 |
| `wwdr-g4.pem` | Apple WWDR G4 intermediate certificate | **2030-12-10** | Download from https://www.apple.com/certificateauthority/ (G4), convert: `openssl x509 -inform der -in AppleWWDRCAG4.cer -out wwdr-g4.pem` |

When renewing `apple-wallet.p12`, update `APPLE_WALLET_CERT_PASSWORD` in `.env` if the passphrase changes.
 