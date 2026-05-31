import SimpleDDP from 'simpleddp';
import ws from 'ws';
import { decrypt } from './lib/encryption';

const TOKEN_ENCRYPTION_KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
process.env.TOKEN_ENCRYPTION_KEY = TOKEN_ENCRYPTION_KEY;

const GENA_URL = 'wss://platform.good-teach.itgen.io/websocket';
const ENCRYPTED = 'x1PwSZ3PSkBjfzgd8Eujdh47lXZFCyKbj9L+5PBDhobgSOwu3R69MBJHN5/Q6h0cMCYzr/rwZK92+IatzC2qI/VCPcLVRCSYAqoV';

process.on('unhandledRejection', (reason) => {
  // suppress — subscription errors are handled inline
});

async function callSafe(client: any, method: string, ...args: any[]): Promise<any> {
  return new Promise((resolve) => {
    client.call(method, ...args).then(resolve).catch((err: any) => {
      resolve({ __error: err.reason || err.error || err.message || String(err) });
    });
  });
}

async function wait(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}

async function main() {
  const loginToken = decrypt(ENCRYPTED);
  console.log('Token len:', loginToken.length);

  const client = new (SimpleDDP as any)({
    endpoint: GENA_URL,
    SocketConstructor: ws,
    reconnectInterval: 5000,
  });

  await new Promise<void>((resolve) => {
    client.on('connected', () => {
      console.log('✅ Connected');
      resolve();
    });
  });

  // Resume login
  const loginResult = await callSafe(client, 'login', { resume: loginToken });
  console.log('Login:', loginResult.__error ? `FAIL: ${loginResult.__error}` : `OK, userId=${loginResult.id}`);

  if (loginResult.__error) {
    process.exit(1);
  }

  // Try various methods
  console.log('\n--- Methods ---');
  const methods: [string, object | undefined][] = [
    ['api.users.getChildsListWithFinishedLessons', undefined],
    ['api.users.getChildsListWithFinishedLessons', {}],
    ['api.users.getMyProfile', undefined],
    ['api.users.getMyInfo', undefined],
    ['api.users.getMyData', undefined],
    ['api.users.getProfile', undefined],
    ['api.users.getMyRoles', undefined],
    ['api.users.getMySubscriptions', undefined],
    ['api.users.getStudentsForTrainer', undefined],
    ['api.users.getChildsList2', undefined],
    ['api.users.getChildsListExtended', undefined],
    ['api.users.getChildsListWithProgress', undefined],
  ];

  for (const [method, params] of methods) {
    const args = params !== undefined ? [params as object] : [];
    const r = await callSafe(client, method, ...args);
    if (r.__error) {
      const errMsg = r.__error as string;
      const isNotFound = errMsg.includes('not found') || errMsg.includes('Not found');
      if (!isNotFound) {
        console.log(`${method}: FAIL -> ${errMsg}`);
      }
      // skip "not found" - not useful
    } else {
      const preview = JSON.stringify(r).slice(0, 200);
      console.log(`${method}: OK -> ${preview}`);
    }
  }

  await wait(500);
  process.exit(0);
}

main().catch(console.error);
