/**
 * AutoCheck Precise Load Test — within rate limits, measures real latencies
 */
const http = require('http');
const { performance } = require('perf_hooks');
const fs = require('fs');

const TOKEN = fs.readFileSync('E:/TestAutoCheck/token.txt', 'utf8').trim();

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost', port: 3001, path, method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('TIMEOUT')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function measureLatencies(name, fn, iterations = 50) {
  const latencies = [];
  const statuses = {};
  let errors = 0;

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    try {
      const r = await fn();
      latencies.push(performance.now() - t0);
      statuses[r.status] = (statuses[r.status] || 0) + 1;
    } catch (e) {
      errors++;
      latencies.push(performance.now() - t0);
    }
    // Small pause to avoid rate limits (300/min = 5/sec)
    await new Promise(r => setTimeout(r, 20));
  }

  const sorted = latencies.sort((a, b) => a - b);
  const p = (pct) => sorted[Math.floor(sorted.length * pct / 100)] || 0;
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;

  return {
    name, iterations,
    latency: {
      min:  p(0).toFixed(2),
      avg:  avg.toFixed(2),
      p50:  p(50).toFixed(2),
      p75:  p(75).toFixed(2),
      p90:  p(90).toFixed(2),
      p95:  p(95).toFixed(2),
      p99:  p(99).toFixed(2),
      max:  p(100).toFixed(2),
    },
    statuses, errors,
  };
}

async function concurrentTest(name, fn, concurrency, totalRequests) {
  // Run exactly totalRequests at given concurrency
  const latencies = [];
  const statuses = {};
  const start = performance.now();
  let cursor = 0;

  async function worker() {
    while (cursor < totalRequests) {
      const i = cursor++;
      if (i >= totalRequests) break;
      const t0 = performance.now();
      try {
        const r = await fn();
        latencies.push(performance.now() - t0);
        statuses[r.status] = (statuses[r.status] || 0) + 1;
      } catch {
        latencies.push(performance.now() - t0);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  const elapsed = (performance.now() - start) / 1000;
  const sorted = latencies.sort((a, b) => a - b);
  const p = (pct) => sorted[Math.floor(sorted.length * pct / 100)] || 0;

  return {
    name, concurrency, total: latencies.length, elapsed,
    rps: (latencies.length / elapsed).toFixed(1),
    latency: {
      p50: p(50).toFixed(1), p90: p(90).toFixed(1), p99: p(99).toFixed(1),
      max: p(100).toFixed(1),
    },
    statuses,
  };
}

function print(r) {
  if (r.elapsed) {
    console.log(`\n[${r.name}]`);
    console.log(`  Concurrency: ${r.concurrency} | Total: ${r.total} | RPS: ${r.rps} | Time: ${r.elapsed.toFixed(2)}s`);
    console.log(`  Latency: p50=${r.latency.p50}ms  p90=${r.latency.p90}ms  p99=${r.latency.p99}ms  max=${r.latency.max}ms`);
    console.log(`  Status codes: ${JSON.stringify(r.statuses)}`);
  } else {
    console.log(`\n[${r.name}]`);
    console.log(`  Samples: ${r.iterations} | Errors: ${r.errors}`);
    console.log(`  Latency: min=${r.latency.min}  avg=${r.latency.avg}  p50=${r.latency.p50}  p75=${r.latency.p75}  p90=${r.latency.p90}  p95=${r.latency.p95}  p99=${r.latency.p99}  max=${r.latency.max} ms`);
    console.log(`  Status codes: ${JSON.stringify(r.statuses)}`);
  }
}

async function main() {
  console.log('=== AutoCheck Precise Load Test ===');
  console.log(new Date().toISOString() + '\n');

  // ── Warm up ──────────────────────────────────────────────────────────
  await request('GET', '/api/health');
  await new Promise(r => setTimeout(r, 500));

  // ── Test 1: Health endpoint baseline ─────────────────────────────────
  console.log('Running Test 1: Health endpoint...');
  print(await measureLatencies('GET /health (no auth, no DB)',
    () => request('GET', '/api/health'), 30));

  await new Promise(r => setTimeout(r, 2000));

  // ── Test 2: JWT verify latency ────────────────────────────────────────
  console.log('Running Test 2: Auth/me (JWT verify + DB lookup)...');
  print(await measureLatencies('GET /auth/me (JWT verify + 1 DB query)',
    () => request('GET', '/api/auth/me'), 30));

  await new Promise(r => setTimeout(r, 2000));

  // ── Test 3: Students list CTE query ───────────────────────────────────
  console.log('Running Test 3: Students list...');
  print(await measureLatencies('GET /students (CTE query, 285 students)',
    () => request('GET', '/api/students'), 30));

  await new Promise(r => setTimeout(r, 2000));

  // ── Test 4: Batch job status ──────────────────────────────────────────
  console.log('Running Test 4: Batch job status (50 IDs)...');
  const ids50 = Array.from({length: 50}, (_, i) =>
    `00000000-0000-0000-0000-${String(i).padStart(12,'0')}`);
  print(await measureLatencies('POST /checks/jobs/status (50 fake IDs)',
    () => request('POST', '/api/checks/jobs/status', { ids: ids50 }), 30));

  await new Promise(r => setTimeout(r, 2000));

  // ── Test 5: Batch status with 500 IDs ────────────────────────────────
  console.log('Running Test 5: Batch job status (500 IDs)...');
  const ids500 = Array.from({length: 500}, (_, i) =>
    `00000000-0000-0000-0000-${String(i).padStart(12,'0')}`);
  print(await measureLatencies('POST /checks/jobs/status (500 fake IDs)',
    () => request('POST', '/api/checks/jobs/status', { ids: ids500 }), 20));

  await new Promise(r => setTimeout(r, 2000));

  // ── Test 6: Settings system ───────────────────────────────────────────
  console.log('Running Test 6: Settings...');
  print(await measureLatencies('GET /settings/system (in-memory read)',
    () => request('GET', '/api/settings/system'), 30));

  await new Promise(r => setTimeout(r, 2000));

  // ── Test 7: AI usage stats (DB aggregation) ───────────────────────────
  console.log('Running Test 7: AI usage stats...');
  print(await measureLatencies('GET /settings/ai-usage (SUM aggregation)',
    () => request('GET', '/api/settings/ai-usage'), 30));

  await new Promise(r => setTimeout(r, 2000));

  // ── Test 8: Concurrent students queries (N teachers simultaneously) ───
  console.log('Running Test 8: Concurrent student queries (5 concurrent)...');
  print(await concurrentTest('GET /students (5 concurrent, 50 total)',
    () => request('GET', '/api/students'), 5, 50));

  await new Promise(r => setTimeout(r, 3000));

  // ── Test 9: Concurrent batch status (simulating bulk poll) ────────────
  console.log('Running Test 9: Concurrent batch status (10 concurrent pollers)...');
  print(await concurrentTest('POST /checks/jobs/status (10 concurrent, 100 total)',
    () => request('POST', '/api/checks/jobs/status', { ids: ids50 }), 10, 100));

  // ── Rate limiter analysis ─────────────────────────────────────────────
  console.log('\n\n=== RATE LIMITER ANALYSIS ===');
  console.log('Firing 320 requests in 1 second to test rate limit behavior...');
  const rlStart = performance.now();
  const rlResults = await Promise.all(
    Array.from({length: 320}, () => request('GET', '/api/students'))
  );
  const rlElapsed = performance.now() - rlStart;
  const rl200 = rlResults.filter(r => r.status === 200).length;
  const rl429 = rlResults.filter(r => r.status === 429).length;
  console.log(`  ${rl200} OK, ${rl429} rate-limited in ${rlElapsed.toFixed(0)}ms`);
  console.log(`  Rate limit effective: ${rl200} requests passed (limit: 300/min → ~5/sec burst)`);
  console.log(`  Time until window resets for next batch: ~${(60000 - rlElapsed).toFixed(0)}ms`);
}

main().catch(console.error);
