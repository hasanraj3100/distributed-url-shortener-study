# Report: URL Shortener Scalability Experiment

## Method

Host for all systems: Intel Core i5-12400 (6 cores / 12 threads), 16 GB RAM, Linux Mint 22.3, Docker 29.9.2.
Load test for all systems: k6, `loadtest-ramp.js`, open model (arrival rate), 5 s request timeout, 80% `GET /{code}` (redirects disabled, check for `302`) and 20% `POST /shorten` (check for `201`), reads spread over 200 pre-created codes.

SLO: error rate < 1% and p99 latency < 1 s.

Each system is measured in two steps:

1. **Ramp** from 50 to 2000 req/s over 4 minutes, aborting when the SLO is broken. This only locates the rough breaking point. It overestimates it, because k6 evaluates thresholds over the whole run (the fast early requests mask the slow ones for a few seconds) and because each rate lasts under a second, too short for a queue to build up.
2. **Fixed rate** for 60 s (`START_RATE=END_RATE`, `RAMP=60s`, `PRE_VUS=500`) at rates below the ramp abort point. The **sustained rate** is the highest fixed rate that runs the full 60 s within the SLO.

Requests sent exclude the 200 setup requests that seed the short codes; the SLO thresholds ignore them too.

## Comparison

| System | Setup | Sustained rate | p99 at that rate |
|---|---|---|---|
| 1 | 1 app (0.1 CPU) + Postgres | ~190 req/s | 510 ms |

---

## System 1: single app instance, 0.1 CPU

### Architecture diagram

```
        k6
        |
        |  :8080
        v
  +-----------+
  |    app    |   Go
  +-----------+
        |
        |  pgx pool (max 10)
        v
  +-----------+
  | postgres  |
  +-----------+
```

### Spec

| Component | Image | Replicas | CPU limit | Memory limit |
|---|---|---|---|---|
| app | Go binary on alpine 3.20 | 1 | 0.1 | 128 MB |
| postgres | postgres:16-alpine | 1 | 1.0 | 512 MB |

- Cache: none
- Load balancer: none
- Short code: Postgres sequence ID encoded in base62
- Redirect type: 302

### Report table

Ramp: two runs aborted on p99 > 1 s at ~269 and ~302 req/s; used only to pick the fixed rates.

| Metric | 180 req/s | 190 req/s | 230 req/s |
|---|---|---|---|
| Result | Passed, 60 s | Passed, 60 s | Aborted after ~11 s |
| Served | ~180 req/s | ~190 req/s | ~196 req/s |
| Peak in flight | 38 | 73 | 430 |
| Errors | 0% | 0% | 0% |
| Latency median | 0.74 ms | 1.59 ms | 1.29 s |
| Latency p95 | 170 ms | 256 ms | 2.92 s |
| Latency p99 | 313 ms | 510 ms | 3.64 s |
| Write p99 | 389 ms | 782 ms | 3.93 s |

Capacity is ~196 req/s: above it the queue grows every second (430 in flight after 11 s at 230 req/s) until requests time out. Writes set the limit, with about twice the read p99, and the tail below capacity comes from CPU throttling (the app may run only 10 ms of every 100 ms).

**Result: sustains ~190 req/s within the SLO.**
