/**
 * AutoCheck Load Test Runner
 * Tests all major API endpoints under simulated production load
 */
const http = require('http');
const { performance } = require('perf_hooks');

const BASE = 'http://localhost:3001';
const TOKEN = require('fs').readFileSync('E:/TestAutoCheck/token.txt', 'utf8').trim();

// ── HTTP helper ────────────────────────────────────────────────────────────
function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost', port: 3001, path, method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        ...headers,
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('TIMEOUT')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Load test engine ──────────────────────────────────────────────────────
async function loadTest(name, fn, { concurrency = 10, duration = 5000 } = {}) {
  const results = { ok: 0, errors: 0, timeouts: 0, latencies: [], statusCodes: {} };
  const start = performance.now();
  const deadline = start + duration;

  async function worker() {
    while (performance.now() < deadline) {
      const t0 = performance.now();
      try {
        const r = await fn();
        const latency = performance.now() - t0;
        results.latencies.push(latency);
        if (r.status >= 200 && r.status < 400) {
          results.ok++;
        } else {
          results.errors++;
        }
        results.statusCodes[r.status] = (results.statusCodes[r.status] || 0) + 1;
      } catch (e) {
        if (e.message === 'TIMEOUT') results.timeouts++;
        else results.errors++;
        results.latencies.push(performance.now() - t0);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  const total = results.ok + results.errors + results.timeouts;
  const elapsed = (performance.now() - start) / 1000;
  const latencies = results.latencies.sort((a, b) => a - b);
  const p = (pct) => latencies[Math.floor(latencies.length * pct / 100)] || 0;

  return {
    name, total, elapsed,
    rps: (total / elapsed).toFixed(1),
    ok: results.ok, errors: results.errors, timeouts: results.timeouts,
    errorRate: ((results.errors + results.timeouts) / total * 100).toFixed(1) + '%',
    latency: {
      min:  p(0).toFixed(1),
      p50:  p(50).toFixed(1),
      p75:  p(75).toFixed(1),
      p90:  p(90).toFixed(1),
      p99:  p(99).toFixed(1),
      max:  p(100).toFixed(1),
    },
    statusCodes: results.statusCodes,
  };
}

function printResult(r) {
  console.log(`\n╔═══ ${r.name} ${'═'.repeat(Math.max(0, 50 - r.name.length))}╗`);
  console.log(`║  RPS: ${r.rps.padEnd(8)} Requests: ${String(r.total).padEnd(8)} Duration: ${r.elapsed.toFixed(1)}s`);
  console.log(`║  OK:  ${r.ok.toString().padEnd(8)} Errors:   ${r.errors.toString().padEnd(8)} Timeouts: ${r.timeouts}`);
  console.log(`║  Error rate: ${r.errorRate}`);
  console.log(`║  Latency (ms): min=${r.latency.min} p50=${r.latency.p50} p75=${r.latency.p75} p90=${r.latency.p90} p99=${r.latency.p99} max=${r.latency.max}`);
  console.log(`║  Status codes: ${JSON.stringify(r.statusCodes)}`);
  console.log(`╚${'═'.repeat(60)}╝`);
}

// ── Test scenarios ────────────────────────────────────────────────────────
async function main() {
  console.log('AutoCheck Load Test — ' + new Date().toISOString());
  console.log('Server: ' + BASE);
  console.log('='.repeat(62));

  const results = [];

  // ── 1. Health check (baseline, no auth, no DB) ────────────────────────
  console.log('\n[1/7] Health endpoint (baseline)...');
  results.push(await loadTest('GET /api/health (baseline)',
    () => request('GET', '/api/health'),
    { concurrency: 50, duration: 5000 }
  ));

  // ── 2. Students list (auth + CTE query) ──────────────────────────────
  console.log('[2/7] Students list (auth + DB CTE query)...');
  results.push(await loadTest('GET /api/students (DB query)',
    () => request('GET', '/api/students'),
    { concurrency: 20, duration: 5000 }
  ));

  // ── 3. Batch job status — main polling endpoint ────────────────────
  console.log('[3/7] Batch job status (1000-job poll)...');
  // Get real job IDs from DB - use fake UUIDs to test query performance
  const fakeIds = Array.from({length: 200}, (_, i) =>
    `00000000-0000-0000-0000-${String(i).padStart(12,'0')}`);
  results.push(await loadTest('POST /checks/jobs/status (200 IDs)',
    () => request('POST', '/api/checks/jobs/status', { ids: fakeIds }),
    { concurrency: 30, duration: 5000 }
  ));

  // ── 4. Concurrent auth middleware ─────────────────────────────────────
  console.log('[4/7] Auth middleware stress (rapid token validation)...');
  results.push(await loadTest('GET /api/auth/me (JWT verify)',
    () => request('GET', '/api/auth/me'),
    { concurrency: 50, duration: 5000 }
  ));

  // ── 5. Rate limiter behavior ──────────────────────────────────────────
  console.log('[5/7] Rate limiter burst (POST /checks flood)...');
  results.push(await loadTest('POST /api/checks (rate limit test)',
    () => request('POST', '/api/checks', { studentId: '00000000-0000-0000-0000-000000000001', platformMaterialId: 'test' }),
    { concurrency: 50, duration: 5000 }
  ));

  // ── 6. Settings system endpoint ────────────────────────────────────────
  console.log('[6/7] Settings system params...');
  results.push(await loadTest('GET /api/settings/system',
    () => request('GET', '/api/settings/system'),
    { concurrency: 20, duration: 5000 }
  ));

  // ── 7. AI usage stats (aggregation query) ────────────────────────────
  console.log('[7/7] AI usage stats (SQL aggregation)...');
  results.push(await loadTest('GET /api/settings/ai-usage (SUM query)',
    () => request('GET', '/api/settings/ai-usage'),
    { concurrency: 20, duration: 5000 }
  ));

  // ── Print all results ─────────────────────────────────────────────────
  console.log('\n\n' + '='.repeat(62));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(62));
  results.forEach(printResult);

  // ── Summary table ─────────────────────────────────────────────────────
  console.log('\n\nSUMMARY TABLE');
  console.log('─'.repeat(80));
  console.log('Endpoint'.padEnd(40) + 'RPS'.padEnd(10) + 'p50ms'.padEnd(10) + 'p99ms'.padEnd(10) + 'Errors');
  console.log('─'.repeat(80));
  results.forEach(r => {
    console.log(
      r.name.slice(0,38).padEnd(40) +
      r.rps.padEnd(10) +
      r.latency.p50.padEnd(10) +
      r.latency.p99.padEnd(10) +
      r.errorRate
    );
  });
  console.log('─'.repeat(80));
}

main().catch(console.error);
