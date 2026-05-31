import { connectGena } from './gena-client';
import { connectEdik } from './edik-client';

export async function initDDPConnections(): Promise<void> {
  try {
    await connectGena();
  } catch (err) {
    console.warn('[DDP] Could not connect to Gena:', (err as Error).message);
  }

  try {
    await connectEdik();
  } catch (err) {
    console.warn('[DDP] Could not connect to Edik:', (err as Error).message);
  }
}
