// Data source: ระบบกล้อง CCTV จราจร กรุงเทพมหานคร (cpudapp.bangkok.go.th/bmatraffic, same
// system as www.bmatraffic.com). The camera list is a JS array embedded in index.aspx.
const BASE = 'https://cpudapp.bangkok.go.th/bmatraffic';
const HEADERS = { 'User-Agent': 'bkk-flood-watch/0.1 (community flood alert)' };
const LIST_TTL_MS = 3600_000;
// index.aspx leaves out a varying set of cameras on each load (579, 545, 548 within an
// hour on 29 Sep 2026) whose snapshots still work, so keep every camera seen this week.
const KEEP_UNSEEN_MS = 7 * 24 * 3600_000;
// Cameras that can stay off the list for hours at a time; used whenever the list lacks them.
const PINNED = [
  { id: '1333', name: 'ถ.ศรีนครินทร์ ตัด ถ.กรุงเทพกรีทา (แยกกรุงเทพกรีฑา)', view: null, lat: 13.75243, lon: 100.6452 },
];

// ['id','name','name_en','view','view_en',lat,lon,'ip','pin.png']
const ROW = /\['(\d+)','([^']*)','[^']*','([^']*)','[^']*',(-?[\d.]+),(-?[\d.]+),'[^']*','[^']*'\]/g;

export function parseCameras(html) {
  const start = html.indexOf('var locations = [');
  if (start < 0) throw new Error('camera list not found in bmatraffic page');
  const block = html.slice(start, html.indexOf('];', start));
  return [...block.matchAll(ROW)].map(([, id, rawName, rawView, lat, lon]) => {
    // Names often start with an internal code such as "TF1-BP-01<tab>".
    const name = rawName.replace(/\s+/g, ' ').trim().replace(/^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+ /, '');
    const view = rawView.replace(/\s+/g, ' ').trim();
    return { id, name, view: view === '-' || name.includes(view) ? null : view, lat: Number(lat), lon: Number(lon) };
  });
}

const km = (a, b) => {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

/** Cameras within radiusKm of any station, tagged with the nearest station and its district. */
export function camerasNear(cameras, stations, radiusKm) {
  const located = stations.filter((s) => s.lat && s.lon);
  return cameras.flatMap((c) => {
    let best = null, d = Infinity;
    for (const s of located) {
      const dist = km(c, s);
      if (dist < d) [best, d] = [s, dist];
    }
    return best && d <= radiusKm ? [{ ...c, near: best.name, district: best.district, km: Math.round(d * 100) / 100 }] : [];
  });
}

const request = (path, init = {}) =>
  fetch(`${BASE}/${path}`, { ...init, headers: { ...HEADERS, ...init.headers }, signal: AbortSignal.timeout(20_000) });

export async function fetchCameraList() {
  const res = await request('index.aspx');
  if (!res.ok) throw new Error(`bmatraffic index.aspx → HTTP ${res.status}`);
  return parseCameras(await res.text());
}

/**
 * show.aspx serves the camera the session last opened in PlayVideo.aspx, and only for a
 * session that has been to index.aspx. Switching cameras within one session sometimes
 * returns the previous camera's frame, so every snapshot gets a fresh session.
 */
export async function fetchSnapshot(id) {
  const home = await request('index.aspx', { method: 'HEAD' });
  if (!home.ok) throw new Error(`bmatraffic index.aspx → HTTP ${home.status}`);
  const cookie = home.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const player = await request(`PlayVideo.aspx?ID=${id}`, { headers: { cookie } });
  await player.arrayBuffer();
  const res = await request(`show.aspx?image=${id}&time=${Date.now()}`, { headers: { cookie } });
  if (!res.ok) throw new Error(`show.aspx → HTTP ${res.status}`);
  const img = Buffer.from(await res.arrayBuffer());
  // A dead camera or a session problem yields a blank PNG (labelled image/jpeg) instead.
  if (img[0] !== 0xff || img[1] !== 0xd8) throw new Error('no image (blank frame)');
  return img;
}

/**
 * Refresh the camera list at most hourly and snapshot the cameras near our stations.
 * A camera that fails keeps its previous image and time; `save(id, jpeg)` stores new ones.
 */
export async function updateCctv(prev, stations, { now = Date.now(), radiusKm, save }) {
  let { list = [], listAt = 0, imageAt = {} } = prev ?? {};
  if (now - listAt >= LIST_TTL_MS) {
    try {
      const fresh = await fetchCameraList();
      const ids = new Set(fresh.map((c) => c.id));
      list = [
        ...fresh.map((c) => ({ ...c, seenAt: now })),
        ...list.filter((c) => !ids.has(c.id) && now - c.seenAt <= KEEP_UNSEEN_MS),
      ];
      listAt = now;
    } catch (e) {
      console.warn(`[cctv] camera list: ${e.message}`);
    }
  }
  const listed = new Set(list.map((c) => c.id));
  const cams = camerasNear([...list, ...PINNED.filter((c) => !listed.has(c.id))], stations, radiusKm);
  const nextAt = {};
  await Promise.all(
    cams.map(async (c) => {
      nextAt[c.id] = imageAt[c.id] ?? null;
      try {
        await save(c.id, await fetchSnapshot(c.id));
        nextAt[c.id] = now;
      } catch (e) {
        console.warn(`[cctv] camera ${c.id}: ${e.message}`);
      }
    }),
  );
  return {
    state: { list, listAt, imageAt: nextAt },
    cameras: cams.map(({ seenAt, ...c }) => ({ ...c, imageAt: nextAt[c.id] })),
  };
}
