# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Copy email templates to dist (TypeScript doesn't copy non-ts files)
RUN cp -r src/services/email/templates dist/services/email/

# Production stage
FROM node:20-alpine
WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy built application
COPY --from=builder /app/dist ./dist

# Copy database files
COPY db ./db

# Copy public assets (wallet badges, etc.)
COPY public ./public

# Copy Apple Wallet signing certificates
COPY --from=builder /app/apple-wallet-cert.pem /app/apple-wallet-key.pem /app/wwdr-g4.pem ./

# Create image storage directory (will be overridden by PVC mount in production)
RUN mkdir -p /data/images/.tmp

# Change ownership to nodejs user
RUN chown -R nodejs:nodejs /app /data/images

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]