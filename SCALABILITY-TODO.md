# Scalability Weak Spots

Issues to address as the platform grows. Ordered by priority.

---

## Critical

### Secrets Hardcoded in k8s Manifests
`k8s/prod-api-deployment.yaml` has Stripe keys, DB password, Cognito secrets as plain-text env vars. Should use Kubernetes Secrets via `secretKeyRef`.

### PostgreSQL Version Mismatch
- Local: `postgres:17-alpine` (docker-compose.yml)
- Production: `postgres:15-alpine` (k8s/postgres.yaml)

Different query planner behavior can cause prod-only bugs.

---

## High

### Single PostgreSQL Instance
Production runs 1 replica with no failover. If it goes down, the entire platform is dead. No read replicas, no point-in-time recovery.

**Fix:** Managed PostgreSQL (RDS/Cloud SQL) or CloudNativePG operator with streaming replication.

### Single Redis Instance
Same problem. Redis failure kills caching, BullMQ queues, Socket.IO broadcasting, and rate limiting simultaneously.

**Fix:** Managed Redis (ElastiCache/Memorystore) or Redis Sentinel/Cluster.

### Dashboard Fetches All Rows Instead of Aggregating
`src/routes/stripe/connect.ts` ~line 3141 fetches every order/preorder/ticket/invoice as individual rows and aggregates in JS via `.reduce()`.

**Fix:** Use SQL aggregation:
```sql
SELECT COUNT(*) as order_count,
  COALESCE(SUM(total_amount), 0) as total_sales,
  COUNT(DISTINCT customer_email) as unique_customers
FROM orders
WHERE organization_id = $1 AND status IN ('completed', 'refunded') AND created_at >= $2
```

### N+1 Order Item Inserts
`src/routes/orders.ts` ~line 194 inserts order items one-at-a-time in a loop. Same pattern in:
- `src/routes/menu.ts` (preorder items)
- `src/routes/invoices.ts` (invoice items, 4 locations)
- `src/routes/catalogs.ts` (catalog duplication)

**Fix:** Single multi-row INSERT or `unnest()`.

### Customers Endpoint Scans 4 Tables
`src/routes/customers.ts` ~line 94 runs a UNION ALL across orders + preorders + tickets + invoices on every request, with `LOWER()` preventing index usage.

**Fix:** Increment `total_orders`/`total_spent` on the `customers` table directly during order/preorder/ticket/invoice creation (already partially done for orders). Or use a materialized view.

---

## Medium

### No Connection Pooler
3 API pods x 50 max connections = 150 total. PostgreSQL default `max_connections` is 100. No PgBouncer in the stack.

**Fix:** Either add PgBouncer or configure PostgreSQL `max_connections=200` with tuned `shared_buffers`/`work_mem`.

### BullMQ Workers Run In-Process
All 5 queue workers (payment, email, payout, webhook, report) run inside the API process. Report generation competes with HTTP requests for CPU.

**Fix:** Separate worker deployment (`k8s/worker-deployment.yaml`) using the same image with a worker-only entrypoint.

### No General API Rate Limiting
Only auth endpoints are rate limited. All other routes including `/menu/public/*` (unauthenticated) are unprotected.

**Fix:** Add rate limits to authenticated routes (200 req/min per user) and public menu endpoints (50 req/min per IP).

### Correlated Subqueries in Events Listing
`src/routes/events.ts` ~line 247 runs 2 correlated subqueries per event for ticket counts.

**Fix:** Replace with LEFT JOIN + GROUP BY or `COUNT(*) FILTER (WHERE ...)`.

### No APM / Observability
No Prometheus metrics, no distributed tracing, no slow query alerting. Only Winston logs.

---

## Low

### No Table Partitioning
`orders`, `audit_logs`, `tickets`, `preorders` grow unbounded. At 100k+ rows, VACUUM and index maintenance become expensive.

**Fix:** Range partition by `created_at` (monthly or quarterly).

### No Audit Log Pruning
`audit_logs` table has no cleanup strategy and grows indefinitely.

**Fix:** Scheduled job to archive/delete logs older than 90 days.

### No Slow Query Detection
The `query()` wrapper in `src/db/index.ts` logs duration but has no threshold alerting.

**Fix:** Log warnings for queries exceeding 500ms. Configure PostgreSQL `log_min_duration_statement = 200`.
