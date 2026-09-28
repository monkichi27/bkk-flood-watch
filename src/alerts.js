import { RISK_RANK, RISK_TH } from './sources/bma.js';

const fmt = (v) => (v === null || v === undefined ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(2)} ม.รทก.`);
const cm = (m) => `${Math.round(m * 100)} ซม.`;

/** Append current canal readings to history and drop points older than historyHours. */
export function updateHistory(history, canals, { now, historyHours }) {
  const cutoff = now - historyHours * 3600_000;
  const next = {};
  for (const [id, pts] of Object.entries(history)) next[id] = pts.filter((p) => p.t >= cutoff);
  for (const s of canals) {
    if (s.stale || s.level === null || !s.timestamp) continue;
    const pts = (next[s.id] ??= []);
    if (!pts.length || pts.at(-1).t !== s.timestamp) pts.push({ t: s.timestamp, v: s.level });
  }
  return next;
}

/** Rise in metres over the window: current reading minus the lowest reading inside the window. */
export function riseOver(points, windowMinutes, now) {
  const inWindow = points.filter((p) => p.t >= now - windowMinutes * 60_000);
  if (inWindow.length < 2) return 0;
  return inWindow.at(-1).v - Math.min(...inWindow.map((p) => p.v));
}

/**
 * Net change in metres over the window (latest reading minus the earliest one inside it),
 * or null when the readings span less than half the window — too short to call a trend.
 */
export function trendOver(points, windowMinutes, now) {
  const inWindow = points.filter((p) => p.t >= now - windowMinutes * 60_000);
  if (inWindow.length < 2 || inWindow.at(-1).t - inWindow[0].t < (windowMinutes * 60_000) / 2) return null;
  return Math.round((inWindow.at(-1).v - inWindow[0].v) * 100) / 100;
}

const hasRisk = (r) => r in RISK_RANK;
const freeboardText = (s) =>
  s.freeboard === null ? 'ไม่มีข้อมูลความสูงตลิ่ง' : s.freeboard < 0 ? `สูงกว่าตลิ่ง ${cm(-s.freeboard)}` : `ห่างตลิ่ง ${cm(s.freeboard)}`;

/**
 * Compare current canal readings against the previous run and decide what to send.
 * `state` is null on the very first run, which produces a one-off situation summary.
 * Alerts follow our bank-based `risk`, not BMA's status (see sources/bma.js).
 */
export function evaluate(state, canals, history, cfg, now = Date.now()) {
  const alerts = [];
  const next = { stations: {}, initialized: true, version: STATE_VERSION };
  const prev = state?.stations ?? {};
  const cooldown = cfg.alertCooldownMinutes * 60_000;

  for (const s of canals) {
    const p = prev[s.id] ?? {};
    const before = p.risk ?? 'ok';
    // Sensors drop out often; remember the last real risk so an offline blip
    // neither fires an alert nor hides a change once readings resume.
    const st = { risk: hasRisk(s.risk) ? s.risk : before, lastRiseAlert: p.lastRiseAlert ?? 0 };
    next.stations[s.id] = st;
    if (!state?.initialized) continue;

    if (hasRisk(s.risk) && s.risk !== before) {
      const up = RISK_RANK[s.risk] > RISK_RANK[before];
      alerts.push({
        type: up ? 'escalate' : 'improve',
        severity: s.risk,
        station: s,
        title: `${up ? '🔺' : '🔻'} ${s.name} (${s.district}) ${RISK_TH[before]} → ${RISK_TH[s.risk]}`,
        body: `ระดับน้ำ ${fmt(s.level)} | ${freeboardText(s)}`,
      });
    }

    const rise = riseOver(history[s.id] ?? [], cfg.riseWindowMinutes, now);
    if (s.risk !== 'offline' && rise >= cfg.riseThresholdM && now - st.lastRiseAlert > cooldown) {
      st.lastRiseAlert = now;
      alerts.push({
        type: 'rise',
        severity: s.risk === 'danger' ? 'danger' : 'watch',
        station: s,
        title: `⚠️ น้ำขึ้นเร็ว ${s.name} (${s.district}) +${cm(rise)} ใน ${cfg.riseWindowMinutes} นาที`,
        body: `ระดับน้ำ ${fmt(s.level)} | ${freeboardText(s)}`,
      });
    }
  }

  if (!state?.initialized) {
    const hot = canals.filter((s) => s.risk === 'watch' || s.risk === 'danger');
    if (hot.length) alerts.push(summaryAlert(canals, cfg.districts));
  }
  return { alerts, state: next };
}

/** Bump when the shape or meaning of saved alert state changes; older state is discarded. */
export const STATE_VERSION = 2;

export function summaryAlert(canals, districts) {
  const lines = districts.map((d) => {
    const own = canals.filter((s) => s.district?.includes(d));
    const c = (r) => own.filter((s) => s.risk === r).length;
    return `• ${d}: ใกล้ล้นตลิ่ง ${c('danger')} | เฝ้าระวัง ${c('watch')} | ปกติ ${c('ok')} | ไม่มีข้อมูลตลิ่ง ${c('unknown')} | ขัดข้อง ${c('offline')}`;
  });
  const worst = canals
    .filter((s) => s.risk === 'danger' || s.risk === 'watch')
    .sort((a, b) => a.freeboard - b.freeboard)
    .slice(0, 5)
    .map((s) => `  - ${s.name} ${freeboardText(s)}`);
  return {
    type: 'summary',
    severity: canals.some((s) => s.risk === 'danger') ? 'danger' : 'watch',
    title: '🌊 สรุปสถานการณ์ระดับน้ำคลอง',
    body: [...lines, ...(worst.length ? ['จุดที่น้ำใกล้ตลิ่งที่สุด:', ...worst] : [])].join('\n'),
  };
}
