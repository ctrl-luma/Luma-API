# Luma-API Scalability Recommendations

Remaining infrastructure improvements to support high-traffic production use. Ordered by priority.

---

## Completed

- [x] **Socket.IO Redis Adapter** — Cross-instance event broadcasting via `@socket.io/redis-adapter`
- [x] **DB Connection Pool** — Increased from 20 to 50 per pod (150 total across 3 replicas)
- [x] **Composite DB Indexes** — Migration 059 adds 10 indexes for common query patterns

---

## 1. Horizontal Pod Autoscaler (HPA)

**Current:** Fixed 3 replicas in prod. No auto-scaling.

**Problem:** Traffic spikes (busy event night, flash sale) exhaust capacity. Quiet periods waste resources.

**Fix:** Add an HPA resource targeting CPU utilization.

```yaml
# k8s/prod-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: luma-api
  namespace: luma
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: luma-api
  minReplicas: 3
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300  # Wait 5 min before scaling down
```

**Prerequisite:** Metrics Server must be installed in the cluster (`kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`).

**Apply:** `kubectl apply -f k8s/prod-hpa.yaml`

---

## 2. PostgreSQL High Availability

**Current:** Single StatefulSet replica. 1Gi request / 2Gi limit. 50Gi storage on Longhorn. postgres:15-alpine.

**Problem:** Single point of failure. DB goes down = entire platform is dead. No read replicas means analytics queries compete with payment transactions.

**Options (pick one):**

### Option A: Managed Database (Recommended)
Switch to AWS RDS, Google Cloud SQL, or DigitalOcean Managed Databases. Gets you:
- Automatic failover
- Read replicas for analytics
- Automated backups and point-in-time recovery
- No manual patching

Update `DATABASE_URL` env var in the deployment to point to the managed instance. Remove `postgres.yaml` from k8s.

### Option B: CloudNativePG Operator
If staying self-hosted on Kubernetes:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: luma-db
  namespace: luma
spec:
  instances: 3        # 1 primary + 2 replicas
  storage:
    size: 50Gi
    storageClass: longhorn
  resources:
    requests:
      memory: 1Gi
      cpu: 500m
    limits:
      memory: 2Gi
      cpu: "1"
  postgresql:
    parameters:
      max_connections: "200"
      shared_buffers: "512MB"
```

To route read queries to replicas, use the read-only service endpoint (`luma-db-ro`) for analytics/dashboard/reporting queries.

---

## 3. Redis High Availability

**Current:** Single replica. 512MB memory limit. 5Gi persistent storage. `redis:7-alpine` with `--appendonly yes`.

**Problem:** Redis failure = cache gone + all BullMQ job queues stop processing (payments, emails, webhooks stall).

**Options:**

### Option A: Managed Redis (Recommended)
AWS ElastiCache, Google Memorystore, or Upstash. Automatic failover and monitoring included.

### Option B: Redis Sentinel on Kubernetes
Deploy 3 Redis nodes with Sentinel for automatic failover:

```bash
helm install redis-ha bitnami/redis \
  --set architecture=replication \
  --set replica.replicaCount=2 \
  --set sentinel.enabled=true \
  --set master.persistence.size=5Gi \
  --set master.resources.limits.memory=1Gi \
  --namespace luma
```

Update `REDIS_URL` to point to the Sentinel-aware endpoint.

---

## 4. BullMQ Worker Concurrency

**Current:** All 5 queues use concurrency of 5. At 3 pods = 15 concurrent jobs per queue type.

**Problem:** During a busy event with 100 simultaneous orders, email notifications queue up. Payment processing may lag.

**Fix:** Tune concurrency per queue based on workload characteristics in `src/services/queue/index.ts`:

| Queue | Current | Recommended | Rationale |
|-------|---------|-------------|-----------|
| `payment-processing` | 5 | 10 | Payment confirmation is time-sensitive |
| `email-notifications` | 5 | 15 | Email is I/O-bound (Resend API), can handle more concurrency |
| `webhook-delivery` | 5 | 10 | Webhooks should retry quickly |
| `report-generation` | 5 | 3 | CPU-heavy, reduce to avoid starving other work |
| `payout-processing` | 5 | 5 | Low volume, current setting is fine |

Alternatively, run BullMQ workers as a **separate Kubernetes Deployment** so they can scale independently from the API pods.

---

## 5. Application-Level Rate Limiting

**Current:** Redis-based rate limiting exists for auth endpoints (login: 10/15min, signup: 5/15min, forgot-password: 5/15min). Nginx ingress has a global 100 req/60s per IP limit.

**Missing:** No rate limiting on general API endpoints. A single user or bot could hammer `/orders`, `/stripe/connect/dashboard`, or `/catalogs` endpoints.

**Fix:** Add a general-purpose rate limiter middleware:

```typescript
// Suggested limits for general API routes
const generalRateLimit = createRateLimit({
  windowMs: 60_000,       // 1 minute
  max: 200,               // 200 requests per minute per user
  keyGenerator: (c) => c.get('userId') || c.req.header('x-forwarded-for') || 'anonymous',
});

// Apply to all authenticated routes
app.use('/catalogs/*', generalRateLimit);
app.use('/orders/*', generalRateLimit);
app.use('/stripe/*', generalRateLimit);
app.use('/events/*', generalRateLimit);
app.use('/invoices/*', generalRateLimit);
```

---

## 6. APM / Observability

**Current:** Winston logging only. No metrics, no distributed tracing, no alerting.

**Problem:** No visibility into response times, error rates, queue depths, or slow queries. Issues are found when users report them, not proactively.

**Recommended stack:**

| Tool | Purpose |
|------|---------|
| **Prometheus + Grafana** | Metrics dashboards (free, self-hosted) |
| **Datadog or New Relic** | Full APM with tracing (paid, easiest) |

**Key metrics to track:**
- API response time (p50, p95, p99)
- Error rate by endpoint
- DB connection pool utilization (`pool.totalCount`, `pool.idleCount`, `pool.waitingCount`)
- Redis memory usage and hit rate
- BullMQ queue depth and processing latency
- Socket.IO connected clients count
- Stripe webhook processing time

For a quick win, expose a `/metrics` endpoint with `prom-client`:

```typescript
import { register, collectDefaultMetrics, Histogram } from 'prom-client';
collectDefaultMetrics();

const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests',
  labelNames: ['method', 'route', 'status'],
});
```

---

## 7. Marketing Site Static Export

**Current:** `Luma-Marketing` runs as a Next.js SSR server (`output: 'standalone'`).

**Problem:** Every page view requires server-side rendering. Under traffic spikes (event promotions, social media links), the marketing server becomes a bottleneck.

**Fix:** Switch to static export for the marketing site since most pages are static content:

```js
// Luma-Marketing/next.config.js
const nextConfig = {
  output: 'export',  // Was 'standalone'
};
```

Then serve from a CDN (Cloudflare Pages, Vercel, S3+CloudFront). The onboarding flow that requires dynamic behavior can use client-side API calls.

---

## 8. Database Table Partitioning (Long-term)

**Current:** `orders` and `audit_logs` tables grow unbounded.

**Problem:** At scale (100k+ orders), queries slow down. VACUUM and index maintenance take longer.

**Fix:** Partition the `orders` table by month:

```sql
-- Convert orders to a partitioned table (requires migration)
CREATE TABLE orders_partitioned (
  LIKE orders INCLUDING ALL
) PARTITION BY RANGE (created_at);

-- Create monthly partitions
CREATE TABLE orders_y2026_m01 PARTITION OF orders_partitioned
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE orders_y2026_m02 PARTITION OF orders_partitioned
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
-- ... etc
```

Also consider an **archive strategy**: move orders older than 12 months to an `orders_archive` table to keep the hot table small.

---

## Priority Roadmap

| Timeline | Item | Effort |
|----------|------|--------|
| **This week** | 1. HPA | 30 min |
| **This week** | 4. BullMQ concurrency tuning | 15 min |
| **This month** | 5. General rate limiting | 1-2 hours |
| **This month** | 2. PostgreSQL HA (managed DB) | Half day |
| **This month** | 3. Redis HA (managed Redis) | Half day |
| **This quarter** | 6. APM / Observability | 1-2 days |
| **This quarter** | 7. Marketing site static export | 1-2 hours |
| **Long-term** | 8. Table partitioning | Half day |
