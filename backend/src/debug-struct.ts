import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();
import { db } from './db';
import { getDecryptedToken } from './services/auth';
import { getChildsMaterials } from './ddp/gena-client';
import { initDDPConnections } from './ddp/connection-pool';

const STUDENT_PLATFORM = 'PGZ72WGhTfYcE4ncy';
const MATERIAL = '8dYXsorRqAcRHszwx';

async function main() {
  await initDDPConnections().catch(() => {});
  const t = await db.query(`SELECT id FROM teachers LIMIT 1`);
  const loginToken = await getDecryptedToken(t.rows[0].id);
  if (!loginToken) { console.log('no token'); process.exit(1); }

  const materials = await getChildsMaterials(loginToken, STUDENT_PLATFORM);
  console.log('total materials:', materials.length);

  // Top-level keys of a material object
  if (materials[0]) console.log('material keys:', Object.keys(materials[0]).join(', '));

  // Find the specific failing material
  const m = materials.find((x: any) => x.materialId === MATERIAL || x._id === MATERIAL);
  if (!m) {
    console.log(`MATERIAL ${MATERIAL} NOT FOUND in getChildsMaterials response`);
    // show a sample of materialIds
    console.log('sample materialIds:', materials.slice(0, 5).map((x: any) => x.materialId || x._id));
  } else {
    console.log('FOUND material. Full object:');
    console.log(JSON.stringify(m, null, 1).slice(0, 1500));
    console.log('interactiveData:', JSON.stringify(m.interactiveData));
    console.log('status field:', m.status);
    console.log('hw field:', JSON.stringify(m.hw)?.slice(0, 200));
  }

  // How many have a trainerToken at all? Count by presence + status
  let withToken = 0, doneStatus = 0, doneByActivity = 0;
  for (const x of materials) {
    if (x.interactiveData?.trainerToken) withToken++;
    if (x.status === 'done') doneStatus++;
    const last = x.activity?.filter((a: any) => a.t === 'changeStatus')?.slice(-1)[0];
    if (last?.d?.to === 'done') doneByActivity++;
  }
  console.log(`\nwithTrainerToken=${withToken}/${materials.length}  status==done=${doneStatus}  doneByActivity=${doneByActivity}`);

  process.exit(0);
}
main().catch(e => { console.error('ERR', e?.message || e); process.exit(1); });
