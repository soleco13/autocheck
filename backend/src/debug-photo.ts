import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();
import { db } from './db';
import { getDecryptedToken } from './services/auth';
import { getChildsMaterials } from './ddp/gena-client';
import { getMaterialSessionState } from './ddp/edik-client';
import { initDDPConnections } from './ddp/connection-pool';

/**
 * Live probe for photo-answer tasks (CFileLoader).
 *
 *   npx ts-node src/debug-photo.ts <platformStudentId> [materialId]
 *
 * Prints where uploaded files land in the session state and whether the file
 * `src` URL is fetchable server-side (public vs presigned/expiring).
 */
const STUDENT = process.argv[2] || process.env.PROBE_STUDENT || '';
const MATERIAL = process.argv[3] || process.env.PROBE_MATERIAL || '';

function scanForFiles(obj: any, path: string, hits: Array<{ path: string; value: any }>, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return;
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (/filesinternal|fileloader|attachments/i.test(k)) hits.push({ path: p, value: v });
    if (v && typeof v === 'object') {
      // A file entry looks like { data: { status, fileId, src } }
      if ((v as any)?.data?.src || (v as any)?.data?.fileId) hits.push({ path: p, value: v });
      scanForFiles(v, p, hits, depth + 1);
    }
  }
}

async function main() {
  if (!STUDENT) {
    console.error('usage: ts-node src/debug-photo.ts <platformStudentId> [materialId]');
    process.exit(1);
  }
  await initDDPConnections().catch(() => {});
  const t = await db.query('SELECT id FROM teachers LIMIT 1');
  const loginToken = await getDecryptedToken(t.rows[0].id);
  if (!loginToken) { console.error('no platform token in DB'); process.exit(1); }

  const materials = await getChildsMaterials(loginToken, STUDENT);
  console.log(`materials for student: ${materials.length}`);

  const targets = MATERIAL
    ? materials.filter((m: any) => m.materialId === MATERIAL || m._id === MATERIAL)
    : materials.filter((m: any) => m.interactiveData?.trainerToken);

  if (targets.length === 0) { console.error('no matching material with trainerToken'); process.exit(1); }

  for (const m of targets) {
    const trainerToken: string | undefined = m.interactiveData?.trainerToken;
    if (!trainerToken) continue;
    console.log(`\n===== material ${m.materialId} (status=${m.status}) =====`);

    const rawState = await getMaterialSessionState(trainerToken).catch((e: any) => {
      console.error('getMaterialSessionState failed:', e?.message);
      return null;
    });
    if (!rawState) continue;

    console.log('top-level keys:', Object.keys(rawState).join(', '));
    console.log('vars keys:', Object.keys(rawState.vars || {}).join(', '));
    console.log('securedVars keys:', Object.keys(rawState.securedVars || {}).slice(0, 40).join(', '));

    const hits: Array<{ path: string; value: any }> = [];
    scanForFiles(rawState.securedVars, 'securedVars', hits);
    scanForFiles(rawState.vars, 'vars', hits);

    if (hits.length === 0) {
      console.log('→ NO file/photo entries found in this session state');
      continue;
    }

    for (const h of hits) {
      console.log(`\n[${h.path}]`);
      console.log(JSON.stringify(h.value, null, 1).slice(0, 1200));
      const src: string | undefined =
        h.value?.data?.src ||
        (h.value && typeof h.value === 'object'
          ? (Object.values(h.value).find((x: any) => x?.data?.src) as any)?.data?.src
          : undefined);
      if (src) {
        console.log('→ src:', src);
        try {
          const r = await fetch(src, { signal: AbortSignal.timeout(15000) });
          const buf = Buffer.from(await r.arrayBuffer());
          console.log(`   fetch: HTTP ${r.status}  content-type=${r.headers.get('content-type')}  bytes=${buf.length}`);
        } catch (e: any) {
          console.log('   fetch FAILED:', e?.message);
        }
      }
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error('ERR', e?.message || e); process.exit(1); });
