import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename, cp } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { config } from './config.js';
import { fetchBma } from './sources/bma.js';
import { evaluate, updateHistory } from './alerts.js';
import { channels, dispatch } from './notify.js';

const statePath = join(config.dataDir, 'state.json');
const readJson = (p, d) => readFile(p, 'utf8').then(JSON.parse, () => d);
async function writeJson(p, v) {
  await writeFile(`${p}.tmp`, JSON.stringify(v));
  await rename(`${p}.tmp`, p);
}

let store = { alertState: null, history: {}, snapshot: null, recentAlerts: [] };
const chans = channels(config.notify);

async function poll() {
  const now = Date.now();
  const { canals, pumps } = await fetchBma(config.districts, { now, staleMinutes: config.staleMinutes });
  const history = updateHistory(store.history, canals, { now, historyHours: config.historyHours });
  const { alerts, state } = evaluate(store.alertState, canals, history, config, now);
  await dispatch(alerts, chans);

  const recentAlerts = [
    ...alerts.map(({ station, ...a }) => ({ ...a, stationId: station?.id, at: now })),
    ...store.recentAlerts,
  ].slice(0, 50);
  store = { alertState: state, history, snapshot: { fetchedAt: now, canals, pumps }, recentAlerts };
  await writeJson(statePath, store);

  const count = (lv) => canals.filter((s) => s.status === lv).length;
  console.log(
    `[poll] ${new Date(now).toLocaleString('th-TH')} canals=${canals.length} ` +
      `critical=${count('critical')} warning=${count('warning')} offline=${count('offline')} ` +
      `pumps=${pumps.length} alerts=${alerts.length}`,
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
});

/** Write the dashboard's data files next to a copy of public/ for static hosting. */
async function exportSite(dir) {
  await cp('public', dir, { recursive: true });
  await writeFile(join(dir, 'status.json'), JSON.stringify(statusPayload()));
  await writeFile(join(dir, 'history.json'), JSON.stringify(store.history));
  console.log(`[export] ${dir}`);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

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
    try {
      const body = await readFile(join('public', file));
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  }).listen(config.port, () => console.log(`[web] http://localhost:${config.port}`));
}

await mkdir(config.dataDir, { recursive: true });
store = { ...store, ...(await readJson(statePath, {})) };
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
