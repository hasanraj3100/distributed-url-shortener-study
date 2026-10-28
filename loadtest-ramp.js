import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Gauge } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const START_RATE = Number(__ENV.START_RATE || 50);       // req/s at the start of the ramp
const END_RATE = Number(__ENV.END_RATE || 2000);         // req/s at the end of the ramp
const RAMP = __ENV.RAMP || '4m';                         // how long the climb from START_RATE to END_RATE takes
const PRE_VUS = Number(__ENV.PRE_VUS || 100);
const MAX_VUS = Number(__ENV.MAX_VUS || 3000);           // cap on in-flight requests; arrivals beyond this are dropped
const WRITE_RATIO = Number(__ENV.WRITE_RATIO || 0.2);    // 0.2 = 20% writes, 80% reads
const SEED = Number(__ENV.SEED || 200);                  // short URLs created up front for reads
const TIMEOUT = __ENV.TIMEOUT || '5s';                   // slower than this counts as a failed request

// SLO: the run aborts as soon as either one is broken.
const MAX_ERROR_RATE = Number(__ENV.MAX_ERROR_RATE || 0.01);
const P99_MS = Number(__ENV.P99_MS || 1000);
const ABORT_DELAY = __ENV.ABORT_DELAY || '10s';          // don't judge the SLO on the first few samples

// Target arrival rate at the moment each request starts. Its last value tells us where the run aborted.
const targetRate = new Gauge('target_rate');

function durationMs(s) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(s);
  if (!m) throw new Error(`unsupported duration: ${s}`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]];
}
const RAMP_MS = durationMs(RAMP);

export const options = {
  scenarios: {
    ramp: {
      // Open model with a rising arrival rate: we keep sending more requests per second
      // no matter how slow the server gets, until the SLO thresholds abort the run.
      executor: 'ramping-arrival-rate',
      startRate: START_RATE,
      timeUnit: '1s',
      stages: [{ target: END_RATE, duration: RAMP }],
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    // Scoped to the scenario so the setup requests don't count.
    'http_req_failed{scenario:ramp}': [
      { threshold: `rate<${MAX_ERROR_RATE}`, abortOnFail: true, delayAbortEval: ABORT_DELAY },
    ],
    'http_req_duration{scenario:ramp}': [
      { threshold: `p(99)<${P99_MS}`, abortOnFail: true, delayAbortEval: ABORT_DELAY },
    ],
    // Always-true thresholds; they make k6 print separate stats for reads and writes.
    'http_req_duration{op:read}': ['max>=0'],
    'http_req_duration{op:write}': ['max>=0'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function shortenBody(tag) {
  return JSON.stringify({ url: `https://example.com/${tag}` });
}

// Runs once before the test: create many short URLs so reads spread over many codes.
export function setup() {
  const codes = [];
  for (let i = 0; i < SEED; i += 50) {
    const reqs = [];
    for (let j = i; j < Math.min(i + 50, SEED); j++) {
      reqs.push(['POST', `${BASE}/shorten`, shortenBody(`seed-${j}`), { headers: JSON_HEADERS }]);
    }
    for (const res of http.batch(reqs)) {
      codes.push(res.json('code'));
    }
  }
  return { codes };
}

export default function (data) {
  const elapsed = Date.now() - exec.scenario.startTime;
  targetRate.add(START_RATE + (END_RATE - START_RATE) * Math.min(elapsed / RAMP_MS, 1));

  if (Math.random() < WRITE_RATIO) {
    const res = http.post(
      `${BASE}/shorten`,
      shortenBody(`${__VU}-${__ITER}-${Date.now()}`),
      { headers: JSON_HEADERS, tags: { op: 'write' }, timeout: TIMEOUT },
    );
    check(res, { 'write is 201': (r) => r.status === 201 });
  } else {
    const code = data.codes[Math.floor(Math.random() * data.codes.length)];
    // redirects: 0 so we measure our server, not the destination site
    const res = http.get(`${BASE}/${code}`, { redirects: 0, tags: { op: 'read' }, timeout: TIMEOUT });
    check(res, { 'read is 302': (r) => r.status === 302 });
  }
}
