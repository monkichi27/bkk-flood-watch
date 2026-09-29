import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename, cp } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { config } from './config.js';
import { fetchBma } from './sources/bma.js';
import { updateCctv } from './sources/cctv.js';
import { evaluate, updateHistory, trendOver, STATE_VERSION } from './alerts.js';
import { channels, dispatch } from './notify.js';

const statePath = join(config.dataDir, 'state.json');
const cctvDir = join(config.dataDir, 'cctv');
const readJson = (p, d) => readFile(p, 'utf8').then(JSON.parse, () => d);
async function writeAtomic(p, data) {
  await writeFile(`${p}.tmp`, data);
  await rename(`${p}.tmp`, p);
}
const writeJson = (p, v) => writeAtomic(p, JSON.stringify(v));

let store = { alertState: null, history: {}, snapshot: null, recentAlerts: [], cctv: null };
const chans = channels(config.notify);

async function poll() {
  const now = Date.now();
  const { canals, pumps } = await fetchBma(config.districts, {
    now,
    staleMinutes: config.staleMinutes,
    dangerFreeboardM: config.dangerFreeboardM,
    watchFreeboardM: config.watchFreeboardM,
  });
  const history = updateHistory(store.history, canals, { now, historyHours: config.historyHours });
  for (const s of canals) s.trend60 = s.risk === 'offline' ? null : trendOver(history[s.id] ?? [], 60, now);
  const { alerts, state } = evaluate(store.alertState, canals, history, config, now);
  await dispatch(alerts, chans);

  // Cameras come after alerts so a slow or down traffic site never delays them.
  let cctv = store.cctv, cameras = [];
  if (config.cctvRadiusKm > 0) {
    await mkdir(cctvDir, { recursive: true });
    ({ state: cctv, cameras } = await updateCctv(store.cctv, [...canals, ...pumps], {
      now,
      radiusKm: config.cctvRadiusKm,
      save: (id, img) => writeAtomic(join(cctvDir, `${id}.jpg`), img),
    }));
  }

  const recentAlerts = [
    ...alerts.map(({ station, ...a }) => ({ ...a, stationId: station?.id, at: now })),
    ...store.recentAlerts,
  ].slice(0, 50);
  store = { alertState: state, history, snapshot: { fetchedAt: now, canals, pumps, cameras }, recentAlerts, cctv };
  await writeJson(statePath, store);

  const count = (r) => canals.filter((s) => s.risk === r).length;
  console.log(
    `[poll] ${new Date(now).toLocaleString('th-TH')} canals=${canals.length} ` +
      `danger=${count('danger')} watch=${count('watch')} unknown=${count('unknown')} offline=${count('offline')} ` +
      `pumps=${pumps.length} alerts=${alerts.length} ` +
      `cctv=${cameras.filter((c) => c.imageAt === now).length}/${cameras.length}`,
  );
}

async function safePoll() {
  try {
    await poll();
  } catch (e) {
    console.error(`[poll] failed: ${e.message}`);
  }
}

const statusPayload = () => ({
  ...store.snapshot,
  districts: config.districts,
  recentAlerts: store.recentAlerts,
  pollMinutes: config.pollMinutes,
  dangerFreeboardM: config.dangerFreeboardM,
  watchFreeboardM: config.watchFreeboardM,
});

/** Write the dashboard's data files next to a copy of public/ for static hosting. */
async function exportSite(dir) {
  await cp('public', dir, { recursive: true });
  await writeFile(join(dir, 'status.json'), JSON.stringify(statusPayload()));
  await writeFile(join(dir, 'history.json'), JSON.stringify(store.history));
  await cp(cctvDir, join(dir, 'cctv'), { recursive: true }).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
  console.log(`[export] ${dir}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg',
};

function serve() {
  createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (v) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(v));
    };
    // Same file names the static (GitHub Pages) build writes, so the page works in both.
    if (url.pathname === '/status.json') return json(statusPayload());
    if (url.pathname === '/history.json') return json(store.history);

    const file = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    // Camera snapshots live in the data dir, at the same path the static export uses.
    const root = /^\/cctv\/\d+\.jpg$/.test(url.pathname) ? config.dataDir : 'public';
    try {
      const body = await readFile(join(root, file));
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  }).listen(config.port, () => console.log(`[web] http://localhost:${config.port}`));
}

await mkdir(config.dataDir, { recursive: true });
store = { ...store, ...(await readJson(statePath, {})) };
// Alert state from an older version compared different statuses; start it (and the alert feed) fresh.
if (store.alertState && store.alertState.version !== STATE_VERSION) store = { ...store, alertState: null, recentAlerts: [] };
console.log(
  `[start] districts=${config.districts.join(',')} every ${config.pollMinutes}m, channels: ${
    ['console', ...chans.map(([n]) => n)].join(', ')
  }`,
);

const outIdx = process.argv.indexOf('--out');
if (process.argv.includes('--once')) {
  await poll();
  if (outIdx > 0) await exportSite(process.argv[outIdx + 1]);
} else {
  await safePoll();
  setInterval(safePoll, config.pollMinutes * 60_000);
  serve();
}
