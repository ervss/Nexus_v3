# Vertical Video Sidecar

A Manifest V3 Chrome extension that keeps a queue of discoverable videos in a compact, dark left-edge dock. It is designed for 9:16 clips: browsing continues in the page while the selected clip plays independently in Sidecar.

## What it does

- Right-click an HTML `<video>` and choose **Add video to Sidecar playlist**; use **Play video in Sidecar now** only when you intentionally want to replace the current clip. The popup exposes the same two actions.
- Keeps a persistent queue in Chrome local extension storage; adding to the playlist never replaces or reloads the active video. Click an item or its `▶` button to play it, use `⇩` to download its direct media URL, drag cards to reorder them, or remove/clear items.
- Each queue card checks the local Nexus dashboard and shows `NEXUS` when the source is already known; `DISK` additionally means Nexus reports a local/on-disk storage type.
- Keeps a compact, persistent playback history (up to 120 distinct videos), including the last watched position. Open **Playback history** under the queue to resume a video or return it to the queue; **Clear** removes only history, not the queue.
- Accepts batches of up to 100 selected direct URLs from **Nexus Video Selector** and deduplicates them into a queue of up to 500 videos. The two unpacked extension IDs are derived from the exact supplied project paths; Sidecar allowlists only this Selector build, while preserving the existing Chrome storage identity.
- Plays direct MP4/WebM URLs and HLS `.m3u8` URLs. The HLS option uses a local, CSP-safe hls.js bundle after the one-time build below; native HLS is used when Chrome exposes it.
- Gives playback controls for play/pause, previous/next, seek keys, volume/mute, rate from 0.25× to 4×, loop, `fit` / `fill`, zoom, horizontal and vertical pan, rotation, and mirroring.
- Use the **⛶** button beside the title to enter cinema mode: the video uses the entire Sidecar height. In that mode, `Fit` keeps every pixel visible and `Fill` uses the full frame by cropping edges; `Esc` returns to the detailed controls.
- Adds a Picture tuning drawer for brightness, contrast, saturation, hue, softening, and sharpness. **FX** runs a local WebGL unsharp-mask shader when the host permits CORS pixel access; it fails closed when it cannot.

## Install on Windows / Chrome

1. Open PowerShell in this folder.
2. For reliable HLS on desktop Chrome, run `npm install` and then `npm run build:hls`. This copies `hls.js` into `vendor/`; the extension never downloads or executes remote code.
3. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this folder.
4. Open any page with a normal HTML video. Right-click that video → **Add video to Sidecar playlist**. The collapsible dock opens at the left edge of that tab.

The keyboard shortcut `Alt+Shift+V` adds the most recently clicked/right-clicked video on the active tab. Drag the timeline at the bottom of the video to seek. Inside the focused dock: `Space` play/pause, `J` / `L` previous/next, arrows seek 5 seconds, `Shift` + arrows seek 30 seconds, and `Home` / `End` jump to the start/end.

## Self-check

Run `npm run check`. It checks the Manifest V3 declaration, required files, and the local HLS wiring. Then verify manually:

1. Load the unpacked folder with no manifest errors.
2. Add a publicly accessible MP4 or WebM and confirm it continues while the page scrolls.
3. Add two videos; drag their queue cards, remove one, reload Chrome, and confirm the remaining queue is retained.
4. Test fit/fill, zoom/pan, speed, volume, loop, and the shortcut.
5. Test one `.m3u8` source after `npm run build:hls`; if its server allows the playlist and segments, it should start in the panel.

## Architecture and important limits

The content script only reads metadata from actual HTML `<video>` elements in the page when you explicitly use the popup, click a video, or invoke the context-menu action. It sends the chosen direct URL, title, page URL, and poster to the extension service worker. The worker validates `http(s)` URLs, stores the queue in `chrome.storage.local`, and asks the top frame to mount a Chrome-extension-origin iframe at the left edge. If that cannot be mounted, it falls back to Chrome's native side panel. Nothing is uploaded or sent to a third party.

This broad site access is required because the requested feature must discover video elements on arbitrary sites. It does **not** bypass a website's access controls. A direct public video may play cross-origin because the browser can load it as media, while canvas/WebGL pixel processing requires that media server to send an appropriate CORS header. Signed URLs can expire. Referrer/cookie/header-bound URLs may also fail because an extension panel is a different browser origin.

Before each direct MP4/HLS load, Sidecar installs one session-only request rule for extension media requests. It supplies the source site's **origin-only Referer**, which fixes common CDN anti-hotlink failures without exposing the full page path. The rule is replaced for the next active video and disappears when Chrome exits. Cookie-bound, expiring or DRM media can still fail.

`blob:` URLs are intentionally not queued: they belong to the original tab's temporary document session and cannot safely be transferred to an extension page. Players built with MediaSource often expose only such a blob URL. DRM / EME streams (for example Widevine), protected embeds, encrypted or tokenized streams cannot be extracted or bypassed; playback remains in the original site player. The extension does not attempt to circumvent those protections. HLS works only when the playlist and its segments are reachable by the browser/hls.js; encrypted/DRM HLS does not.

The **FX** control uses a compact unsharp-mask fragment shader and only enables pixel processing when the browser grants canvas/WebGL access to the video. Brightness, contrast, saturation, hue and softening use CSS controls and do not require pixel readback.

## RTX Video Super Resolution

An extension cannot reliably turn on or control NVIDIA RTX Video Super Resolution through a Chrome extension API. When hardware acceleration is on in Chrome and RTX Video enhancement is enabled in NVIDIA App / the driver, NVIDIA and Chrome may apply it to supported video playback paths. That is driver/browser-owned, varies by GPU/driver/site/video pipeline, and must be considered an optional system-level enhancement rather than a guaranteed extension feature.
