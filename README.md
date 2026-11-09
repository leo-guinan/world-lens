# World Lens

A small, local-first “screen within a screen” for reading public websites. One isolated Chromium session renders the target page; a companion panel shows bounded visible-page evidence, a screenshot, and a receipt. The first slice is strictly read-only: no clicks, form submissions, logins, downloads, or model-generated actions.

## Run locally

Requirements: Node 20+, npm, and a Chromium binary supported by Playwright.

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run start
```

Open `http://127.0.0.1:8792`. Enter one public HTTPS URL without query parameters. The API exposes a machine-readable observation policy at `/api/lens/policy`; observations are submitted to `/api/lens/observe`. Receipts and PNG screenshots are persisted under `data/` with restricted file permissions.

The server binds loopback by default. Do not put it on the public internet without adding authentication and an explicit review of the SSRF/network policy. Compose also binds to loopback; use a trusted reverse proxy/VPN and authentication before remote access.

## Evidence and compression

The adapter extracts visible body text, headings, links, and form/control labels (bounded sizes), with locators for source elements. The receipt records requested/final URLs, status, browser engine, actions, `mutations: []`, a stable receipt ID, SHA-256 snapshot hash, and screenshot hash. Text, headings, and link/control records are evidence. Interpretation, trust, or whether a control is safe to activate are intentionally not asserted.

## Live feed

A live observer polls one page (`POST /api/lens/live/start` with `{ "url", "intervalSeconds" }`, 30 to 3600 seconds) and reports only when the visible evidence changes. Every change gets the next sequence number, is appended to `data/live-feed.ndjson`, and is sent to whoever is listening.

- `GET /api/lens/live/stream` is a server-sent event stream: one message per change, `id` set to its sequence number. A new client hears only what happens next. A client that reconnects sends the last number it saw (`Last-Event-ID`, or `?after=<seq>`) and gets what it missed; if some of that is no longer held in memory it is told so with a `gap` event first.
- `GET /api/lens/live/events` returns recent changes in the order they happened, and with `?after=<seq>` only the later ones.
- Each message carries a signal (`world-lens.signal.v1`): at most 12 added and 6 removed items of 240 characters each, headlines first, with the receipt id, snapshot hash and screenshot URL of the observation behind it. It is the same untrusted evidence as the full change event, cut to size. Nothing is interpreted, ranked or summarised by a model, and `interpretation` stays `null`.

The feed is built to be left running. The list of watched pages is saved and picked up again on start, each with a new baseline, so a restart never reports old content as a change. A poll that shows nothing new no longer leaves a receipt and a screenshot behind: only the observations that a change points to are kept. The journal starts a new file when it passes 64 MB. Change files written one per event by earlier versions are imported into the journal the first time it is created.

[fold](https://github.com/leo-guinan/fold)'s control room follows this stream directly (`node tools/room.mjs <show> --signals http://127.0.0.1:8792/api/lens/live/stream`) and turns each signal into an event in a live animation. What a signal means on screen is decided by that show's rules, which copy out bounded fields and never act on page text.

## Security boundary

- HTTPS only; query strings, embedded credentials, literal IPs, local names, and private/reserved DNS answers are rejected.
- Browser requests are restricted to HTTPS `GET`/`HEAD`; destination hosts are rechecked at the browser request boundary to limit redirects and private-network navigation.
- Downloads and service workers are disabled. Ordinary `/observe` captures use a fresh browser/context closed in `finally`. Explicit retained sessions keep one isolated tab open until separately closed; captures do not reload it.
- Page text is untrusted evidence; it cannot expand user authorization.
- This is an experimental local prototype, not a hardened internet-facing browser isolation service. DNS rebinding, unusual IPv6 representations, browser vulnerabilities, and every SSRF edge case require additional security review before exposure.

## Verification

```sh
npm run typecheck
npm test
npm run smoke
```

`npm run smoke` requires the local API to be running (default port 8792; override with `SMOKE_PORT`). It launches Chromium, uses the served UI to observe the external public page `https://example.org/`, checks evidence and screenshot rendering, and reads the saved receipt back over HTTP. Run this only when external-page browsing is intended. For controlled local-source verification instead, use `scripts/product-session-smoke.ts` as described below.

## Retained isolated tab (local prototype)

POST `/api/lens/sessions` with `{ "url": "https://example.org/" }` from a local non-browser HTTP client to open one isolated retained tab. Preserve the returned sessionId. POST `/api/lens/sessions/<sessionId>/capture` to capture its current document without reloading, and POST `/api/lens/sessions/<sessionId>/close` to close it. Capacity is four sessions. Origin-bearing requests, non-loopback peers, and non-loopback Host headers are rejected. These routes are not authenticated for hostile local processes; never expose the service remotely.

Future Radio accepts an optional `session_id` on its producer-authenticated observer start request; the live form includes the same optional field. Blank means ordinary fresh-page captures. The bridge validates exact session identity, URL, retained capture mode, and absence of navigation in capture receipts. Stopping the observer does not close the retained tab: close it explicitly. A changed top-level URL is rejected rather than silently followed.

This is not attachment to a personal Chrome/Safari tab, user cookies, or an existing login. There is no user-tab picker. Retained tabs expire after 10 minutes idle or one hour total age, with a 15-second background sweep; active captures defer expiry until the next check. SIGINT/SIGTERM stop the listener and observers, drain session operations, and close retained tabs. Shutdown uses a five-second reporting deadline: known retained browsers are closed immediately, new sessions are rejected, and HTTP connections are dropped if draining exceeds the deadline. A deadline error explicitly means cleanup is incomplete; a stalled open may still return later and is then disposed of. This bounds shutdown reporting, not guaranteed process termination or completion of every browser close. This remains a local prototype, not an unattended service.

`PRODUCT_ARTIFACT_DIR=<absolute-output-directory> node --import tsx scripts/product-session-smoke.ts` exercises the actual server dispatcher and persistence, reads receipts and PNGs back over HTTP, verifies screenshot hashes, and checks that exported shutdown closes the tab and listener. The source document is locally fulfilled in the test harness; this is not external-site or user-browser proof.

Verification: `RETAINED_ARTIFACT_DIR=<absolute-output-directory> node --import tsx scripts/retained-session-smoke.ts` exercises real Chromium and actual session route handlers against locally fulfilled content. Production DNS/network restrictions are unchanged.

## Selected-tab extension

`extension/` contains a local-only unpacked Chromium MV3 prototype: explicit user capture, in-memory JSON review and local export. It uses only activeTab/scripting permissions, with no automatic content script, persistent storage or network relay. See `extension/README.md` for installation, privacy boundaries and limitations. Unpacked registration and popup loading have been verified in disposable Chromium; real toolbar-gesture capture and export remain unverified. It is not wired into the server or Future Radio.

## Publication scope and progress

This repository contains the World Lens service, browser adapter, retained-session lifecycle, selected-tab extension, UI and reproducible tests/harnesses. Runtime captures, screenshots, disposable browser profiles, credentials and local logs are excluded. Future Radio integration code lives in a separate checkout and is not part of this push; references to its producer routes describe that companion integration, not bundled functionality.

Current local checks: 29 tests; typecheck passes. The live feed, signal and stream tests need no browser. Controlled product-dispatcher and retained-session browser rehearsals have also passed. These results do not establish internet-facing security, personal-browser attachment, audio output or public broadcast. No deployment is included.

## Deployment boundary

`docker compose up --build` provides a local containerized run. No external host, domain, auth, streaming destination, or live-site interaction is configured by this repository. No deployment was performed.
