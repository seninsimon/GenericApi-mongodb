import client from "@prometheus-io/client";

// Prometheus metrics, exposed on GET /metrics (see app.ts).
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const dbQueryDuration = new client.Histogram({
  name: "db_query_duration_seconds",
  help: "PostgreSQL query duration",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const slowQueries = new client.Counter({
  name: "db_slow_queries_total",
  help: "Queries slower than SLOW_QUERY_MS",
  registers: [registry],
});

export const jobsProcessed = new client.Counter({
  name: "jobs_processed_total",
  help: "Background jobs finished",
  labelNames: ["type", "status"],
  registers: [registry],
});
