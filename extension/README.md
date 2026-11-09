# World Lens selected-tab slice

Local-only unpacked Chromium MV3 extension. Not installed into the operator's browser by these tests.

## Manual use

1. Open chrome://extensions, enable developer mode and Load unpacked with this extension directory.
2. Select the intended HTTP(S) tab without query, fragment or embedded credentials. This restriction does not guarantee the page is public: ordinary visible text can still be private.
3. Click the World Lens toolbar icon, then Capture selected tab. This explicit gesture is required for activeTab permission.
4. Review the entire JSON preview before Export reviewed receipt. Export stays local; there is no relay. Clear or close the popup to discard its in-memory capture.

Permissions: activeTab and scripting only. No host permissions, background worker, automatic content script, cookies, persistent storage, screenshot or network transport. The extension reads the top frame only. Form/control values, editable text and hidden nodes are excluded; visible non-form private text is not anonymized. It does not alter the page DOM.

Receipt schema: world-lens.selected-tab.v1, sourceKind user-selected-tab, HTTP status null (not fabricated), bounded text/headings, untrusted evidence and actionAuthorized false. Snapshot SHA-256 binds URL/title/text/headings. Hashing is integrity evidence, not authenticity or approval. Dynamic text may change during extraction without navigation; same-URL document races are not yet detected. Iframes, shadow DOM, screenshot corroboration, continuous observation, authenticated import and Future Radio relay remain unimplemented. The server/bridge does not accept this as a browser-service capture receipt.

## Current verification

World Lens suite: 23 tests pass, including real Chromium extraction from an inert fixture with hidden/input/textarea/script canaries excluded and DOM unchanged. Typecheck, JS syntax and diff checks pass.

scripts/selected-tab-extension-smoke.mjs loads this exact unpacked extension into disposable Chromium, reads extension registration from chrome://extensions, verifies ENABLED state and loads the actual popup with zero page errors and no automatic capture. This proves extension acceptance/popup load, not the toolbar gesture or activeTab capture/export path. That path remains manual and UNVERIFIED.

No personal profile, cookies or existing login is read during these checks. Do not send any exported receipt to a remote service without reviewing its contents and approving the exact destination.
