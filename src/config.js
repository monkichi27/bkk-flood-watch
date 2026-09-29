import { readFileSync, existsSync } from 'node:fs';

// Minimal .env loader so the project runs with zero dependencies.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;
const list = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

export const config = {
  districts: list(env.DISTRICTS, ['ประเวศ', 'สวนหลวง', 'บางกะปิ', 'ลาดพร้าว']),
  pollMinutes: Number(env.POLL_MINUTES || 5),
  port: Number(env.PORT || 3000),
  // Rapid-rise alert: rise of at least this many metres within the window.
  riseThresholdM: Number(env.RISE_THRESHOLD_M || 0.1),
  riseWindowMinutes: Number(env.RISE_WINDOW_MINUTES || 60),
  // Colour bands by distance from water surface to the lower bank (metres).
  dangerFreeboardM: Number(env.DANGER_FREEBOARD_M || 0.3),
  watchFreeboardM: Number(env.WATCH_FREEBOARD_M || 0.6),
  // A reading older than this is treated as stale / sensor offline.
  staleMinutes: Number(env.STALE_MINUTES || 60),
  alertCooldownMinutes: Number(env.ALERT_COOLDOWN_MINUTES || 120),
  historyHours: Number(env.HISTORY_HOURS || 48),
  // Snapshot BMA traffic cameras within this distance of a station; 0 turns cameras off.
  cctvRadiusKm: Number(env.CCTV_RADIUS_KM || 1.5),
  dataDir: env.DATA_DIR || 'data',
  notify: {
    ntfyTopic: env.NTFY_TOPIC,
    ntfyServer: env.NTFY_SERVER || 'https://ntfy.sh',
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID,
    lineToken: env.LINE_CHANNEL_ACCESS_TOKEN,
    lineTo: env.LINE_TO,
    discordWebhook: env.DISCORD_WEBHOOK_URL,
  },
};
