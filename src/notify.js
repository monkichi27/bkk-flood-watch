const PRIORITY = { danger: 5, watch: 4, ok: 3 };
const post = (url, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
  });

/** Build the channel list from config; each channel is (alert) => Promise. */
export function channels(n) {
  const out = [];
  if (n.ntfyTopic)
    out.push([
      'ntfy',
      (a) =>
        post(`${n.ntfyServer}/${n.ntfyTopic}`, a.body, {
          'Content-Type': 'text/plain; charset=utf-8',
          // Header values must be ASCII; ntfy accepts RFC 2047 encoded titles.
          Title: `=?UTF-8?B?${Buffer.from(a.title).toString('base64')}?=`,
          Priority: String(PRIORITY[a.severity] ?? 3),
          Tags: a.severity === 'danger' ? 'rotating_light' : 'ocean',
          ...(a.station?.url ? { Click: a.station.url } : {}),
        }),
    ]);
  if (n.telegramToken && n.telegramChatId)
    out.push([
      'telegram',
      (a) =>
        post(`https://api.telegram.org/bot${n.telegramToken}/sendMessage`, {
          chat_id: n.telegramChatId,
          text: `${a.title}\n${a.body}`,
          disable_web_page_preview: true,
        }),
    ]);
  if (n.lineToken && n.lineTo)
    out.push([
      'line',
      (a) =>
        post(
          'https://api.line.me/v2/bot/message/push',
          { to: n.lineTo, messages: [{ type: 'text', text: `${a.title}\n${a.body}` }] },
          { Authorization: `Bearer ${n.lineToken}` },
        ),
    ]);
  if (n.discordWebhook)
    out.push(['discord', (a) => post(n.discordWebhook, { content: `**${a.title}**\n${a.body}` })]);
  return out;
}

export async function dispatch(alerts, chans) {
  for (const a of alerts) {
    console.log(`[alert] ${a.title}\n        ${a.body.replaceAll('\n', '\n        ')}`);
    const results = await Promise.allSettled(chans.map(([, send]) => send(a)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.error(`[notify:${chans[i][0]}] ${r.reason.message}`);
    });
  }
}
