import { LEVEL_RANK, LEVEL_TH } from './sources/bma.js';

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
 * Compare current canal readings against the previous run and decide what to send.
 * `state` is null on the very first run, which produces a one-off situation summary.
 */
export function evaluate(state, canals, history, cfg, now = Date.now()) {
  const alerts = [];
  const next = { stations: {}, initialized: true };
  const prev = state?.stations ?? {};
  const cooldown = cfg.alertCooldownMinutes * 60_000;

  for (const s of canals) {
    const p = prev[s.id] ?? {};
    const before = p.status ?? 'normal';
    // Sensors drop out often; remember the last real status so an offline blip
    // neither fires an alert nor hides a change once readings resume.
    const st = { status: s.status === 'offline' ? before : s.status, lastRiseAlert: p.lastRiseAlert ?? 0 };
    next.stations[s.id] = st;
    if (!state?.initialized) continue;

    if (s.status !== 'offline' && s.status !== before) {
      const up = LEVEL_RANK[s.status] > LEVEL_RANK[before];
      alerts.push({
        type: up ? 'escalate' : 'improve',
        severity: s.status,
        station: s,
        title: `${up ? '🔺' : '🔻'} ${s.name} (${s.district}) ${LEVEL_TH[before]} → ${LEVEL_TH[s.status]}`,
        body: `ระดับน้ำ ${fmt(s.level)} | เตือนภัย ${fmt(s.warning)} | วิกฤต ${fmt(s.critical)}`,
      });
    }

    const rise = riseOver(history[s.id] ?? [], cfg.riseWindowMinutes, now);
    if (s.status !== 'offline' && rise >= cfg.riseThresholdM && now - st.lastRiseAlert > cooldown) {
      st.lastRiseAlert = now;
      alerts.push({
        type: 'rise',
        severity: s.status === 'normal' ? 'warning' : s.status,
        station: s,
        title: `⚠️ น้ำขึ้นเร็ว ${s.name} (${s.district}) +${cm(rise)} ใน ${cfg.riseWindowMinutes} นาที`,
        body: `ระดับน้ำ ${fmt(s.level)} | สถานะ ${LEVEL_TH[s.status]} | วิกฤต ${fmt(s.critical)}`,
      });
    }
  }

  if (!state?.initialized) {
    const hot = canals.filter((s) => s.status === 'warning' || s.status === 'critical');
    if (hot.length) alerts.push(summaryAlert(canals, cfg.districts));
  }
  return { alerts, state: next };
}

export function summaryAlert(canals, districts) {
  const lines = districts.map((d) => {
    const own = canals.filter((s) => s.district?.includes(d));
    const c = (lv) => own.filter((s) => s.status === lv).length;
    return `• ${d}: วิกฤต ${c('critical')} | เตือนภัย ${c('warning')} | ปกติ ${c('normal')} | ขัดข้อง ${c('offline')}`;
  });
  const worst = canals
    .filter((s) => s.status === 'critical' && s.critical !== null && s.level !== null)
    .sort((a, b) => b.level - b.critical - (a.level - a.critical))
    .slice(0, 5)
    .map((s) => `  - ${s.name} ${fmt(s.level)} (เกินวิกฤต ${cm(s.level - s.critical)})`);
  return {
    type: 'summary',
    severity: canals.some((s) => s.status === 'critical') ? 'critical' : 'warning',
    title: '🌊 สรุปสถานการณ์ระดับน้ำคลอง',
    body: [...lines, ...(worst.length ? ['จุดที่น้ำสูงเกินวิกฤตมากที่สุด:', ...worst] : [])].join('\n'),
  };
}
