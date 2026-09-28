// Data source: สำนักการระบายน้ำ กรุงเทพมหานคร (weather.bangkok.go.th).
// These are the same JSON endpoints the public BMA map pages call.
const BASE = 'https://weather.bangkok.go.th';
const HEADERS = { 'User-Agent': 'bkk-flood-watch/0.1 (community flood alert)' };

// BMA priorityStatus → our level. 0/1 = sensor down, 2 = normal, 3 = warning, 4 = critical.
const LEVELS = { 0: 'offline', 1: 'offline', 2: 'normal', 3: 'warning', 4: 'critical' };

const parseDotNetDate = (s) => {
  const m = typeof s === 'string' && s.match(/\/Date\((-?\d+)\)\//);
  return m ? Number(m[1]) : null;
};
const num = (v) => (v === null || v === undefined || v === -99 ? null : Number(v));
const inDistricts = (name, districts) => !!name && districts.some((d) => name.includes(d));

// BMA's own warning/critical marks sit far below the bank at many stations (they read as
// "above the canal's target operating level", not "about to overflow"), and some are
// placeholders (-0.2 / 0) or entered in cm (320 / 450). Our headline measure is the
// distance from the water surface to the lower bank instead.
export const RISK_RANK = { ok: 0, watch: 1, danger: 2 };
export const RISK_TH = { danger: 'ใกล้ล้นตลิ่ง', watch: 'เฝ้าระวัง', ok: 'ปกติ', unknown: 'ไม่มีข้อมูลตลิ่ง', offline: 'ขัดข้อง' };

/** Lower of the two banks, or null when BMA has no usable bank height (missing, 0, or in cm). */
export function bankLevel(left, right) {
  const banks = [num(left), num(right)].filter((v) => v !== null && v > 0 && v < 10);
  return banks.length ? Math.min(...banks) : null;
}

/** Placeholder (-0.2/0) and cm-scale thresholds are not meaningful; show them as missing. */
export const thresholdsOk = (warning, critical) =>
  warning !== null && critical !== null && critical > 0 && critical < 10 && warning <= critical;

export function riskOf({ stale, level, freeboard }, { dangerFreeboardM = 0.3, watchFreeboardM = 0.6 } = {}) {
  if (stale) return 'offline';
  if (level === null || freeboard === null) return 'unknown';
  if (freeboard < dangerFreeboardM) return 'danger';
  return freeboard < watchFreeboardM ? 'watch' : 'ok';
}

export function parseWaterStations(raw, districts, { now = Date.now(), staleMinutes = 60, ...riskOpts } = {}) {
  return raw
    .filter((r) => inDistricts(r.district_name, districts))
    .map((r) => {
      const ts = parseDotNetDate(r.site_timestamp);
      const stale = !ts || now - ts > staleMinutes * 60_000;
      const gates = [1, 2, 3, 4, 5, 6]
        .slice(0, r.water_gate_count || 0)
        .map((i) => num(r[`watergate0${i}`]));
      const level = num(r.wl_in);
      const bank = bankLevel(r.left_bank, r.right_bank);
      const freeboard = level !== null && bank !== null ? Math.round((bank - level) * 100) / 100 : null;
      return {
        id: `wl-${r.water_id}`,
        kind: 'canal',
        code: r.water_code,
        name: r.water_shortname?.trim() || r.water_name,
        canal: r.river_name,
        district: r.district_name,
        lat: r.latitude,
        lon: r.longitude,
        level,
        levelOut: num(r.wl_out01),
        warning: num(r.warning),
        critical: num(r.critical),
        thresholdsOk: thresholdsOk(num(r.warning), num(r.critical)),
        bank,
        freeboard,
        risk: riskOf({ stale, level, freeboard }, riskOpts),
        maxToday: num(r.max_in_day),
        gates,
        isGate: (r.water_gate_count || 0) > 0 || /ปตร\./.test(r.water_shortname || ''),
        // BMA's own label, kept for reference; `risk` drives colours and alerts.
        status: stale ? 'offline' : LEVELS[r.priorityStatus] ?? 'offline',
        sourceStatus: r.txtStatus,
        timestamp: ts,
        stale,
        url: r.water_url || null,
      };
    });
}

export function parsePumpStations(raw, districts, { now = Date.now(), staleMinutes = 60 } = {}) {
  // LastPump carries readings; waterTbl carries the canonical district name.
  const districtById = new Map(raw.waterTbl.map((r) => [r.pumpStation_id, r.district_name]));
  return raw.LastPump.filter((r) => inDistricts(districtById.get(r.pumpStation_id), districts)).map((r) => {
    const ts = parseDotNetDate(r.site_timestamp_station);
    const pumps = [1, 2, 3, 4, 5, 6].map((i) => r[`pump_status${i}`]).filter((v) => v !== null);
    const gates = [1, 2, 3, 4].slice(0, r.pump_gate_count || 0).map((i) => num(r[`pump_gate0${i}`]));
    return {
      id: `ps-${r.pumpStation_id}`,
      kind: 'pump',
      code: r.pumpStation_code,
      name: r.pump_shortname || r.pumpStation_name,
      district: districtById.get(r.pumpStation_id),
      lat: r.latitude,
      lon: r.longitude,
      level: num(r.water_level),
      levelOut: num(r.water_level_out),
      pumpsRunning: pumps.filter((v) => v === 1).length,
      pumpsTotal: pumps.length,
      gates,
      timestamp: ts,
      stale: !ts || now - ts > staleMinutes * 60_000,
    };
  });
}

async function getJson(url, init) {
  const res = await fetch(url, { ...init, headers: { ...HEADERS, ...init?.headers }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

export async function fetchBma(districts, opts) {
  const [water, pump] = await Promise.all([
    getJson(`${BASE}/water/PageMap/GoogleMap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'payload=',
    }),
    getJson(`${BASE}/Station/Map/GetData?id=0`),
  ]);
  return {
    canals: parseWaterStations(water, districts, opts),
    pumps: parsePumpStations(pump, districts, opts),
  };
}
