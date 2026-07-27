import SimpleDDP from 'simpleddp';
import ws from 'ws';
import { logger } from '../lib/logger';

const MONTI_WS  = 'wss://app.montiapm.com/websocket';
const APP_ID    = process.env.MONTI_APP_ID || '';
const TOKEN     = process.env.MONTI_RESUME_TOKEN || '';
const RANGE_MS  = 3_600_000; // last hour

export interface RTPoint  { ts: number; wait: number; db: number; http: number; compute: number; async: number }
export interface THPoint  { ts: number; rpm: number }
export interface ERPoint  { ts: number; count: number }
export interface FSPoint  { ts: number; kb: number }

export interface MontiMetrics {
  responseTime: { wait: number; db: number; http: number; compute: number; async: number; total: number }
  errorRate:    number
  throughput:   number
  fetchedDocKb: number
  timeseries: {
    responseTime: RTPoint[]
    throughput:   THPoint[]
    errors:       ERPoint[]
    fetchedDoc:   FSPoint[]
  }
  updatedAt:    number
  connected:    boolean
}

export type MontiStatus = 'ok' | 'degraded' | 'overloaded' | 'disconnected'

const EMPTY: MontiMetrics = {
  responseTime: { wait: 0, db: 0, http: 0, compute: 0, async: 0, total: 0 },
  errorRate: 0, throughput: 0, fetchedDocKb: 0,
  timeseries: { responseTime: [], throughput: [], errors: [], fetchedDoc: [] },
  updatedAt: 0, connected: false,
};

let ddp: any = null;
let snap: MontiMetrics = { ...EMPTY };

// metricSubId → { dataKey, data }
const store = new Map<string, { dataKey: string; data: { rows: any[][] } }>();

function uid(): string {
  return Math.random().toString(36).slice(2, 18);
}

function avg(rows: any[][], col: number, n = 3): number {
  const slice = rows.slice(-n);
  if (!slice.length) return 0;
  return slice.reduce((s, r) => s + (r[col] ?? 0), 0) / slice.length;
}

function rebuild() {
  const get = (key: string) =>
    [...store.values()].find(v => v.dataKey?.includes(key));

  const rt = get('responseTimeBreakdown');
  const th = get('methodThroughput');
  const er = get('methodErrors');
  const fs = get('methodAvgFetchedDocSize');

  const rtRows: any[][] = rt?.data?.rows ?? [];
  const thRows: any[][] = th?.data?.rows ?? [];
  const erRows: any[][] = er?.data?.rows ?? [];
  const fsRows: any[][] = fs?.data?.rows ?? [];

  const w  = avg(rtRows, 1);
  const db = avg(rtRows, 2);
  const h  = avg(rtRows, 3);
  const cp = avg(rtRows, 5);
  const as = avg(rtRows, 6);

  snap = {
    responseTime: { wait: w, db, http: h, compute: cp, async: as, total: w + db + h + cp + as },
    errorRate:    avg(erRows, 1),
    throughput:   avg(thRows, 1),
    fetchedDocKb: avg(fsRows, 1) / 1024,
    timeseries: {
      responseTime: rtRows.slice(-48).map(r => ({
        ts: r[0], wait: r[1] ?? 0, db: r[2] ?? 0,
        http: r[3] ?? 0, compute: r[5] ?? 0, async: r[6] ?? 0,
      })),
      throughput:  thRows.slice(-48).map(r => ({ ts: r[0], rpm: r[1] ?? 0 })),
      errors:      erRows.slice(-48).map(r => ({ ts: r[0], count: r[1] ?? 0 })),
      fetchedDoc:  fsRows.slice(-48).map(r => ({ ts: r[0], kb: (r[1] ?? 0) / 1024 })),
    },
    updatedAt: Date.now(),
    connected: ddp?.connected ?? false,
  };
}

function sub(metricType: string) {
  const id = uid();
  try {
    ddp.subscribe('kadiraData.observeMetrics', id, metricType, {
      time: null, range: RANGE_MS, appId: APP_ID, realtime: true, groupByHost: false,
    });
  } catch { /* ignore — will retry on reconnect */ }
  return id;
}

async function onConnected() {
  logger.info('[Monti] connected — authenticating');
  try {
    await ddp.call('login', { resume: TOKEN });
    snap.connected = true;
    logger.info('[Monti] authenticated — subscribing');
    [
      'timeseries.responseTimeBreakdown-c',
      'timeseries.methodThroughput-c',
      'timeseries.methodErrors-c',
      'timeseries.methodAvgFetchedDocSize-c',
    ].forEach(m => sub(m));
  } catch (err: any) {
    logger.error({ msg: err.message }, '[Monti] auth failed');
  }
}

function onData(msg: any) {
  if (msg?.collection !== 'kadira-data-collection') return;
  const { metricSub, dataKey, data } = msg.fields ?? {};
  if (metricSub && data) { store.set(metricSub, { dataKey, data }); rebuild(); }
}

export async function initMontiClient(): Promise<void> {
  if (!APP_ID || !TOKEN) {
    logger.warn('[Monti] MONTI_APP_ID / MONTI_RESUME_TOKEN not set — monitoring disabled');
    return;
  }

  ddp = new (SimpleDDP as any)({
    endpoint: MONTI_WS, SocketConstructor: ws,
    reconnectInterval: 20_000, maxReconnectInterval: 120_000, reconnectBackoffMultiplier: 1.5,
  });

  ddp.on('error', (err: Error) => {
    if (!err.message?.includes('ECONNREFUSED') && !err.message?.includes('ETIMEDOUT'))
      logger.warn({ msg: err.message }, '[Monti] ws error');
  });
  ddp.on('disconnected', () => {
    logger.warn('[Monti] disconnected');
    snap = { ...snap, connected: false };
    store.clear();
  });
  ddp.on('connected', onConnected);
  ddp.on('added',   onData);
  ddp.on('changed', onData);

  await ddp.connect();
}

export function getMontiMetrics(): MontiMetrics { return snap; }

export function getMontiStatus(): MontiStatus {
  if (!snap.connected || snap.updatedAt === 0) return 'disconnected';
  const db = snap.responseTime.db;
  const er = snap.errorRate;
  if (db > 700 || er > 8) return 'overloaded';
  if (db > 350 || er > 3) return 'degraded';
  return 'ok';
}

export function isMontiEnabled(): boolean { return Boolean(APP_ID && TOKEN); }
