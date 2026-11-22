# Nexus Deck 1.1.1 – playback recovery

The player first uses the normal Nexus range endpoint. On a media error or a
25-second startup/buffering timeout, it refreshes the source through
`/api/v1/stream/resolve/{id}`. The response determines MP4 versus HLS, preserves
opaque proxy sessions, and supplies the exact fresh upstream URL to the proxy.
MP4 without a provider session has one final native browser retry. That retry
does not request CORS; canvas FX may be unavailable on that source.

Recovery is bounded: one resolution and one optional direct retry per load.
Switching videos or stopping invalidates outstanding responses and removes the
previous resume listener. Recovery preserves playback position. A failed source
can be retried with the Play button; errors are displayed in the player.
Lite retains its server-managed refresh endpoint, local files retain their
local stream, and MEGA uses its decrypted stream endpoint.

Run regression checks with:

```powershell
node --test tests/nexus_deck_playback.test.mjs
```

For browser verification, the preview serves the actual extension files and
forwards requests to the running Nexus on port 8000:

```powershell
node tests/nexus_deck_preview.cjs
```

The optional `NEXUS_DECK_FAIL_ONCE_ID` environment variable makes exactly one
initial media request return 403, for exercising recovery against a real source.
`NEXUS_DECK_PREVIEW_PORT` overrides the default local port 18765. These test
options belong only to the preview server, not the extension.

Live Chrome verification on 2026-10-07:

| Source | Result in the actual Deck UI served over localhost |
| --- | --- |
| Bunkr, available CDN | Playback progressed, readyState 4 |
| Filester | Playback progressed, readyState 4 |
| Pixeldrain | Playback progressed, readyState 4 |
| Turbo | Playback progressed, readyState 4 |
| Bunkr, injected initial 403 | Resolver returned 200, media returned 206, playback progressed |
| Bunkr `/f/nTsHtxZjaYh2t` | CDN returned 503; fresh proxy and native retry could not play it |
| XVideos sample | Resolver reported no playable stream; player displayed the error |

These checks exercise the real browser and media decoding. They do not verify
the installed extension's chrome-extension origin or side-panel lifecycle.
Browser automation blocks `chrome://extensions`; the installed Deck must be
reloaded manually there, then its side panel closed and reopened.
