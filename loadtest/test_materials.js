const http = require('http');
const https = require('https');

// Use the JWT from the login response (stored in cookie)
// We'll login via API to get a fresh token
async function request(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'localhost', port: 3001, path, method, headers: headers || {} };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        // Extract Set-Cookie header
        const setCookie = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: data, headers: res.headers, cookie: setCookie });
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('TIMEOUT')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function main() {
  // 1. Login
  console.log('Logging in as shkolastudent16@yandex.ru...');
  const loginResp = await request('POST', '/api/auth/login',
    '{"email":"shkolastudent16@yandex.ru","password":"123456"}',
    { 'Content-Type': 'application/json' });

  if (loginResp.status !== 200) {
    console.error('Login failed:', loginResp.status, loginResp.body.slice(0, 200));
    return;
  }

  const teacher = JSON.parse(loginResp.body).teacher;
  console.log('Logged in as:', teacher.email || teacher.teacherId);

  // Extract session cookie
  const sessionCookie = (loginResp.cookie || []).join('; ');
  const authHeader = { 'Cookie': sessionCookie };

  // 2. Test materials pages
  console.log('\n=== MATERIALS ENDPOINT TIMING ===');

  for (const pg of [1, 2, 3, 4, 5]) {
    const t0 = Date.now();
    const r = await request('GET', `/api/materials?page=${pg}&pageSize=10`, null, authHeader);
    const ms = Date.now() - t0;
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      console.log(`Page ${pg}: ${ms}ms | materials=${d.materials.length} total=${d.pagination.total}`);
    } else {
      const d = JSON.parse(r.body);
      console.log(`Page ${pg}: ${ms}ms | HTTP ${r.status} | ${d.error || '?'}`);
    }
  }

  // 3. Test with filter (should also use cache)
  console.log('\n=== FILTERED QUERIES (all from cache) ===');
  const queries = [
    '/api/materials?page=1&pageSize=10&grade=5',
    '/api/materials?page=1&pageSize=10&search=math',
    '/api/materials?page=2&pageSize=20',
  ];
  for (const q of queries) {
    const t0 = Date.now();
    const r = await request('GET', q, null, authHeader);
    const ms = Date.now() - t0;
    const d = JSON.parse(r.body);
    console.log(`${q.slice(-40)}: ${ms}ms | HTTP ${r.status} | count=${d.materials?.length || 0}`);
  }
}

main().catch(console.error);
