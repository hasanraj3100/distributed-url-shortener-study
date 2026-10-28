# url-shortener

A small URL shortener I use to learn system design by measuring it instead of guessing.

The app is deliberately boring: Go, Postgres, two endpoints. The interesting part is squeezing it into tiny Docker CPU limits, pushing load at it until it breaks, and writing down where and why.

## What it does

- `POST /shorten` with `{"url": "https://..."}` returns a short code
- `GET /{code}` redirects (302) to the original URL

Codes are a Postgres sequence ID encoded in base62.

## Run it

```
docker compose up -d --build
```

The app listens on `:8080`. It runs as one instance limited to 0.1 CPU, with Postgres behind it.

```
curl -X POST localhost:8080/shorten -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'
```

## Load test

```
docker run --rm -i --network host -v "$PWD":/work -w /work grafana/k6 run loadtest-ramp.js
```

80% reads, 20% writes, open model. It ramps from 50 to 2000 req/s and stops as soon as the SLO breaks (errors < 1%, p99 < 1 s). For a fixed rate, set `START_RATE` and `END_RATE` to the same value and `RAMP=60s`. The other knobs are at the top of the script.

The ramp only finds roughly where things break. The real number comes from 60 s fixed-rate runs just below it.

## Results so far

| System | Setup | Sustained |
|---|---|---|
| 1 | 1 app (0.1 CPU) + Postgres | ~190 req/s |

Details in [reports.md](reports.md). What I want to try next is in [plan.md](plan.md).
