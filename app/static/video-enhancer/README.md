# Nexus video enhancer

Client-side WebGPU upscale for the native Nexus player. The original `<video>` continues to play and carry audio; a worker renders frames to an `OffscreenCanvas`. Export uses local MP4 parsing, WebCodecs H.264 encode, AAC sample passthrough, and MP4 muxing. No video data is sent to a server or external API. Model weight files are served by Nexus itself.

## Build and run

```bash
npm install
npm run build:enhancer
npm start
```

`index.html` and `netflix.html` load `bootstrap.bundle.js`. It attaches automatically to native video elements inside `.player-overlay .player-box`. For another player:

For the standalone example, run `python -m http.server 8766 --directory app` from the repository root, then open `http://localhost:8766/test-video-enhancer.html`. Do not open the HTML with `file://`; browser modules, workers and WebGPU need an HTTP origin. Enter an HTTP(S) MP4/HLS URL or use the public online sample buttons. HLS uses the existing self-hosted Hls.js. A local file picker is also available.

```js
import { attachVideoEnhancer } from '/static/video-enhancer/VideoEnhancer.js';
const enhancer = attachVideoEnhancer(document.querySelector('video'));
// Call enhancer.destroy() when removing the player.
```

The direct import example requires bundling the module first, because the source module has browser-compatible syntax but its worker dependencies are bundled separately. In a bundled application, import the source module normally.

Dependencies: `@websr/websr`, `mp4box`, `mp4-muxer`, plus existing `esbuild`. Medium real-life weights are the default. Small, Medium and Large, and real-life, animation and 3D weights are available locally.

## Test

Use Chrome 120+ on a secure origin or localhost. Open a native player, start the video, select **Enhance**, and check the `AI 2×` resolution label. Select **Compare 50/50** to see original on the left and AI output on the right. Select **Original** to restore the original player. The enhancer panel provides Play/Pause, Mute, seek, and Fullscreen while the canvas covers native video controls. Try the quality selector and both filters. **Process & Download** requires H.264 MP4 input and AAC audio if an audio track exists. For a cross-origin video without CORS, select a local copy of the MP4. Use **Cancel** to stop. After export, download or replace the player source with the blob URL. Check codec, audio and dimensions with `ffprobe`.

When WebGPU is unavailable, Enhance applies local CSS/SVG sharpen and color filters and states that AI upscale is unavailable. Export remains unavailable. Safari/iOS may enter this fallback.

## Current limits

- Export accepts H.264 MP4 with AAC or no audio. Other codecs show an error instead of silently dropping audio.
- Online native MP4 and HLS/MediaSource playback can be enhanced. A direct cross-origin MP4 loaded without `crossorigin` is checked using a cancellable one-byte CORS request, then reloaded with `crossorigin="anonymous"`, preserving position and playback state. The response body is cancelled after headers, even if the host ignores Range. Failed checks retain normal playback and explain the basic-filter fallback. Hosts without CORS need a compatible existing Nexus stream proxy; embedded third-party iframe players and DRM media are not supported. This is a browser security boundary.
- Export currently holds the source, extracted samples, and output in browser memory. For safety it accepts only clips of at most 30 seconds, source files of at most 128 MB, and output of at most 4 million pixels for Small/Medium or 1.5 million for Large. The worker repeats these checks before creating WebGPU resources. Longer or higher-resolution exports need a streaming demux/mux architecture and bounded GPU resource use.
- Real-time FPS depends on GPU, browser and resolution; Small is the performance choice. WebSR itself is marked unstable by its author.
- Live preview uses its own Play/Pause, Mute, seek, and Fullscreen controls because the canvas covers native `<video>` controls.
- 2× frame interpolation is not implemented. A future RIFE integration would need an independently verified WebGPU model and frame timing path.

## Online preview verification — 2026-10-11

Real browser clicks in the running Nexus application and standalone demo (WebGPU-capable Chromium in-app browser):

| Source | Input → AI output | Observed result |
| --- | --- | --- |
| Nexus online Camwhores source, `/stream_proxy/30697.mp4` | 1920×1088 → 3840×2176 | 669 processed frames over approximately 23 seconds; 27–29 FPS near the end |
| Direct HTTPS MDN `flower.mp4` | 960×540 → 1920×1080 | CORS changed from unset to anonymous; 43 processed frames before the short clip ended |
| Mux public HLS 480p stream | 848×480 → 1696×960 | 3160 processed frames by media time 55.34s; 58–60 FPS; Small → Medium and both filters off remained live |

The HLS paused comparison showed matching scenes on both sides. Its source time was 55.340179s and the last processed frame timestamp 55.3399s. Audio stays on the original video element; perceptual lip-sync was not independently measured. These results prove running local neural inference and a changing output, not a quantified improvement in perceived image quality, nor performance on every GPU or streaming host. HLS here was segmented video-on-demand, not an indefinite live broadcast. No online batch export was tested in this pass.

The test exposed and fixed frozen output after settings changes: WebSR destroys its GPUDevice when disposing a model, so it cannot be reused. Preview now recreates the device when changing models or input dimensions; CSS filter changes do not rebuild the model. Each rendered acknowledgement waits for submitted GPU work and checks validation errors. Turning both filters off now explicitly sets `filter: none`.

Evidence: `test-results/video-enhancer/online-hls-verified.jpg`, `online-hls-full.jpg`, and `nexus-online-controls.jpg`. The canvas `data-rendered-frames` and `data-media-time` attributes provide DOM-visible diagnostics after successful worker renders. The local `blob:` URL for HLS is a MediaSource assembled from online segments, not a locally selected video file.
