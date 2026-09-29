# bkk-flood-watch

Node ≥22, no dependencies. `npm test` (node:test, fixtures in test/fixtures from 28 Sep 2026).
`node src/index.js --once --out <dir>` - one poll + static site export; `PORT=3123 node src/index.js` - local dashboard.

## Data gotchas
- weather.bangkok.go.th times out from non-Thai IPs → polling must run on a machine in Thailand; it also returns sporadic 403s (getJson retries).
- BMA `priorityStatus`/warning/critical are unreliable (placeholders -0.2/0, values in cm like 320/450, marks far below the bank). Colour/sort/alerts use `risk` from freeboard = min(left_bank,right_bank) − wl_in; BMA status is secondary only.
- Bank heights ≤0 or ≥10 are treated as missing (`bankLevel`).
- Bump `STATE_VERSION` (src/alerts.js) when alert state meaning changes; old state is discarded on load.
- CCTV (src/sources/cctv.js, cpudapp.bangkok.go.th/bmatraffic = bmatraffic.com): often 502/520 and slow. `show.aspx` returns a frame only for a session that loaded `index.aspx` then `PlayVideo.aspx?ID=`; otherwise a blank white PNG labelled image/jpeg (check JPEG magic bytes). Switching cameras in one session can return the previous camera's frame → fresh session per snapshot. `index.aspx` omits a varying set of working cameras per load → the list is accumulated (7 days). PlayVideo can't be iframed (CSP frame-ancestors).

## Deploy
- `.github/workflows/poll.yml` runs on self-hosted runner label `bkk`, workflow_dispatch only. GitHub `schedule:` never fired on this repo — don't re-add it.
- Runner machine triggers every 5 min via launchd: `scripts/trigger-poll.sh` + `scripts/th.bkk-flood-watch.trigger.plist` (setup in README).
- macOS runner needs `gtar` (`brew install gnu-tar`) for actions/upload-pages-artifact.
- State persists on the force-pushed `data` branch (state.json + cctv/*.jpg); site = GitHub Pages (Actions source).
- Repo is public: never commit `.env`; fork-PR workflows require approval.

## Conventions
- User-facing text (page, alerts, README) in Thai; code comments in English.
