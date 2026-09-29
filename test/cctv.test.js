import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCameras, camerasNear, fetchSnapshot, updateCctv } from '../src/sources/cctv.js';

// Trimmed copy of cpudapp.bangkok.go.th/bmatraffic/index.aspx, 29 Sep 2026.
const PAGE = readFileSync(new URL('./fixtures/bmatraffic-index.html', import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-29T07:00:00Z');
const MIN = 60_000;

const jpeg = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]);
// What show.aspx sends when the session has no camera: a blank white 400×266 PNG.
const BLANK_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

/**
 * Stand-in for the BMA traffic site. Like the real one, show.aspx only returns a camera's
 * frame for a session that opened index.aspx and then PlayVideo.aspx for that camera.
 */
function fakeTraffic(t, frames) {
  const site = { frames, page: PAGE, down: false, calls: [] };
  const sessions = new Map();
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const u = new URL(url);
    const page = u.pathname.split('/').pop();
    const sid = init.headers?.cookie?.match(/ASP\.NET_SessionId=(\w+)/)?.[1];
    const method = init.method ?? 'GET';
    site.calls.push({ page, method, sid });
    if (site.down) return new Response('error code: 520', { status: 520 });
    if (page === 'index.aspx') {
      const id = `s${sessions.size + 1}`;
      sessions.set(id, { cam: null });
      return new Response(method === 'HEAD' ? null : site.page, {
        headers: { 'set-cookie': `ASP.NET_SessionId=${id}; path=/bmatraffic/; HttpOnly; SameSite=Lax` },
      });
    }
    if (page === 'PlayVideo.aspx') {
      if (sessions.has(sid)) sessions.get(sid).cam = u.searchParams.get('ID');
      return new Response('<html></html>');
    }
    if (page === 'show.aspx') {
      const cam = sessions.get(sid)?.cam;
      return new Response(site.frames[cam] ?? BLANK_PNG, { headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response('not found', { status: 404 });
  });
  t.mock.method(console, 'warn', () => {});
  return site;
}

test('parses the camera list, not the news or event lists on the same page', () => {
  const cams = parseCameras(PAGE);
  assert.deepEqual(cams.map((c) => c.id), ['603', '1333', '1647', '1336', '1325', '1301', '1258', '1703']);
  // Leading "TF1-BP-01<tab>" code dropped; the view repeats the name, so it is left out.
  assert.deepEqual(cams[1], {
    id: '1333',
    name: 'ถ.ศรีนครินทร์ ตัด ถ.กรุงเทพกรีทา (แยกกรุงเทพกรีฑา) หน้าไทยเพรซิเดนท์ฟูดส์',
    view: null,
    lat: 13.75243,
    lon: 100.6452,
  });
  assert.deepEqual(cams[3], { id: '1336', name: 'แยกสวนหลวง', view: 'หน้ารถมุ่งหน้าแยกศรีอุดม', lat: 13.7126, lon: 100.64409 });
  assert.equal(cams[0].name, 'แยกสีลม-นราธิวาส');
  assert.equal(cams[7].view, null); // '-'
});

test('keeps cameras within the radius and names the nearest station', () => {
  const stations = [
    { name: 'ค.ก', district: 'ประเวศ', lat: 13.75, lon: 100.65 },
    { name: 'ค.ข', district: 'สวนหลวง', lat: 13.7, lon: 100.65 },
    { name: 'ไม่มีพิกัด', district: 'บางกะปิ', lat: null, lon: null },
  ];
  const cam = (id, lat) => ({ id, name: `กล้อง ${id}`, view: null, lat, lon: 100.65 });
  // 0.01° of latitude ≈ 1.11 km.
  const near = camerasNear([cam('a', 13.76), cam('b', 13.765), cam('c', 13.701)], stations, 1.5);
  assert.deepEqual(near, [
    { ...cam('a', 13.76), near: 'ค.ก', district: 'ประเวศ', km: 1.11 },
    { ...cam('c', 13.701), near: 'ค.ข', district: 'สวนหลวง', km: 0.11 },
  ]);
});

test('a snapshot opens the camera in its own BMA session first', async (t) => {
  const site = fakeTraffic(t, { 1647: jpeg('พัฒนาการ') });
  assert.deepEqual(await fetchSnapshot('1647'), jpeg('พัฒนาการ'));
  assert.deepEqual(site.calls.map((c) => `${c.method} ${c.page} ${c.sid ?? '-'}`), [
    'HEAD index.aspx -',
    'GET PlayVideo.aspx s1',
    'GET show.aspx s1',
  ]);
});

test('the blank "no picture" frame counts as a failed snapshot', async (t) => {
  fakeTraffic(t, {}); // camera offline: the site answers 200 with the blank PNG
  await assert.rejects(fetchSnapshot('1336'), /no image/);
});

const HUAMAK = [{ name: 'ค.หัวหมาก ถ.ศรีนครินทร์', district: 'สวนหลวง', lat: 13.7239, lon: 100.6427 }]; // ~1.25 km from 1647 and 1336

test('a failed camera keeps its last image, and the camera list is refreshed hourly', async (t) => {
  const site = fakeTraffic(t, { 1647: jpeg('a'), 1336: jpeg('b') });
  const saved = [];
  const save = async (id, img) => saved.push([id, img.toString('latin1').slice(4)]);
  const run = (prev, now) => updateCctv(prev, HUAMAK, { now, radiusKm: 1.5, save });
  const listFetches = () => site.calls.filter((c) => c.page === 'index.aspx' && c.method === 'GET').length;

  const r1 = await run(null, NOW);
  assert.equal(listFetches(), 1);
  assert.deepEqual(r1.cameras.map((c) => [c.id, c.imageAt]), [['1647', NOW], ['1336', NOW]]);
  assert.deepEqual(saved.sort(), [['1336', 'b'], ['1647', 'a']]);

  delete site.frames[1336];
  saved.length = 0;
  const r2 = await run(r1.state, NOW + 5 * MIN);
  assert.equal(listFetches(), 1); // list still fresh
  assert.deepEqual(r2.cameras.map((c) => [c.id, c.imageAt]), [['1647', NOW + 5 * MIN], ['1336', NOW]]);
  assert.deepEqual(saved, [['1647', 'a']]);

  // Site down at the list refresh: keep the old list and images, and retry next poll.
  site.down = true;
  const r3 = await run(r2.state, NOW + 25 * 60 * MIN);
  assert.equal(listFetches(), 2);
  assert.deepEqual(r3.cameras.map((c) => [c.id, c.imageAt]), [['1647', NOW + 5 * MIN], ['1336', NOW]]);
  site.down = false;
  await run(r3.state, NOW + 25 * 60 * MIN + 5 * MIN);
  assert.equal(listFetches(), 3);
});

test('a camera missing from later lists stays for a week', async (t) => {
  // index.aspx leaves out a varying set of cameras (579, then 545, then 548 on 29 Sep)
  // whose snapshots still work, so one list is not the whole list.
  const site = fakeTraffic(t, { 1647: jpeg('a'), 1336: jpeg('b') });
  const run = (prev, now) => updateCctv(prev, HUAMAK, { now, radiusKm: 1.5, save: async () => {} });
  const ids = (r) => r.cameras.map((c) => c.id);

  const r1 = await run(null, NOW);
  site.page = PAGE.replace(/^\['1336'.*$/m, '');
  const r2 = await run(r1.state, NOW + 61 * MIN);
  assert.equal(site.calls.filter((c) => c.page === 'index.aspx' && c.method === 'GET').length, 2);
  assert.deepEqual(ids(r2), ['1647', '1336']);
  assert.equal(r2.cameras[1].imageAt, NOW + 61 * MIN);

  let r = r2;
  for (let day = 1; day <= 6; day++) r = await run(r.state, NOW + day * 24 * 60 * MIN);
  assert.deepEqual(ids(r), ['1647', '1336']);
  r = await run(r.state, NOW + 7 * 24 * 60 * MIN + 2 * MIN);
  assert.deepEqual(ids(r), ['1647']);
});

test('a pinned camera is used even when the list leaves it out', async (t) => {
  // แยกกรุงเทพกรีฑา (1333) was missing from every list after the morning of 29 Sep.
  const site = fakeTraffic(t, { 1333: jpeg('กรีฑา') });
  const station = [{ name: 'ค.ทดสอบ', district: 'ประเวศ', lat: 13.761, lon: 100.6452 }]; // ~0.95 km north of 1333
  const run = (prev) => updateCctv(prev, station, { now: NOW, radiusKm: 1.5, save: async () => {} });

  site.page = PAGE.replace(/^\['1333'.*$/m, '');
  const r1 = await run(null);
  assert.deepEqual(r1.cameras.map((c) => [c.id, c.near, c.imageAt]), [['1333', 'ค.ทดสอบ', NOW]]);

  site.page = PAGE; // listed again: still only once
  const r2 = await run(null);
  assert.deepEqual(r2.cameras.map((c) => c.id), ['1333']);
});
