# URL Shortener: Scalability Experiment Plan

## Goal

Build a URL shortener and learn system design by **measuring** how it scales. Everything runs on one machine in Docker containers with deliberately tiny CPU/RAM limits, so a single instance saturates quickly. Then we add instances (horizontal scaling) and check whether throughput really goes up.

## Core features (keep it small)

- `POST /shorten` takes a long URL and returns a short code
- `GET /{code}` redirects (301/302) to the original URL
- Read-heavy workload (~100:1 reads to writes), which is realistic for a shortener

## Architecture

```
            load generator (k6 / wrk / locust)
                         |
                     [ nginx ]          <- load balancer (round-robin)
                    /    |    \
              [app1] [app2] ... [appN]  <- stateless, CPU/RAM limited
                    \    |    /
                  [ Redis ]             <- cache (hot short codes)
                         |
                  [ PostgreSQL ]        <- source of truth
```

- **App**: stateless HTTP service (language TBD, e.g. Go/Python/Node). No local state so any instance can serve any request.
- **Nginx**: load balancer in front of N app replicas.
- **Redis**: cache for redirects (cache-aside), also useful for ID generation.
- **Postgres**: persistent storage of `code -> long_url`.

## Short code generation

Start simple, then compare:
1. Auto-increment ID from the DB encoded in base62
2. Random 7-char base62 code with collision check

(Distributed counter / pre-allocated ID ranges per instance is a later topic.)

## Resource limits (the key part of the experiment)

Use `docker compose` limits, for example for each app container:

```yaml
deploy:
  resources:
    limits:
      cpus: "0.25"
      memory: 128M
```

Pick limits so one instance falls over at roughly 100-300 req/s. We tune this empirically.

## Experiments

Run the same load test each time and record req/s, p50/p95/p99 latency, error rate, and CPU/mem usage (`docker stats`).

| # | Setup | Question |
|---|-------|----------|
| 1 | 1 app + Postgres, no cache | What is the baseline ceiling? |
| 2 | 1 app + Postgres + Redis | How much does caching help? |
| 3 | 2 / 4 / 8 apps behind nginx | Does throughput scale linearly? |
| 4 | Scale apps further | Where is the next bottleneck (nginx? DB? Redis? host CPU)? |
| 5 | Kill an app container mid-test | Does the system keep serving? |
| 6 | Constrain DB too, add read replica (optional) | How do we scale the data layer? |

**Caveat:** all containers share the host's CPU cores, so scaling will flatten once the host (or the load generator itself) is saturated. That is itself a useful lesson, so we note where it happens.

## Tools

- Docker + docker compose
- Load testing: k6 (or wrk / locust)
- Monitoring: `docker stats` first; optionally Prometheus + Grafana later

## Steps

1. Scaffold project and `docker-compose.yml` (app, postgres)
2. Implement the app (shorten + redirect)
3. Add resource limits and write the load test script
4. Run experiment 1 (baseline) and record results
5. Add Redis cache, run experiment 2
6. Add nginx and scale replicas (`docker compose up --scale app=N`), run experiments 3-4
7. Failure test (experiment 5)
8. Write up results in `results.md` (numbers + what we learned)

## Open decisions

- App language/framework
- Load testing tool
- 301 (permanent, browser-cached) vs 302 (every hit reaches the server). 302 is better for measuring load.
