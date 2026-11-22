import { createFile, DataStream } from 'mp4box';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import WebSR from '@websr/websr';
import { createEffects } from './effects.js';

let cancelled = false;
self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { cancelled = true; return; }
  if (data.type !== 'process') return;
  cancelled = false;
  try { await processFile(data.file, data.quality, data.content, data.effects); }
  catch (error) { self.postMessage({ type: 'error', message: error.message }); }
};

async function processFile(file, quality, content, effects) {
  if (!('VideoDecoder' in self) || !('VideoEncoder' in self)) throw new Error('WebCodecs is unavailable. Use Chrome 120+.');
  if (file.size > 128 * 1024 * 1024) throw new Error('Export limit: source MP4 must be at most 128 MB.');
  const bytes = await file.arrayBuffer();
  const mp4 = createFile();
  const samples = new Map();
  const info = await new Promise((resolve, reject) => {
    mp4.onError = reject;
    mp4.onReady = info => {
      for (const track of info.tracks) {
        if (track.type === 'video' || track.type === 'audio') {
          samples.set(track.id, []); mp4.setExtractionOptions(track.id, null, { nbSamples: 1 });
        }
      }
      mp4.start(); resolve(info);
    };
    mp4.onSamples = (id, _user, batch) => samples.get(id)?.push(...batch);
    bytes.fileStart = 0; mp4.appendBuffer(bytes); mp4.flush();
  });
  const video = info.videoTracks[0];
  if (!video || !video.codec.startsWith('avc1')) throw new Error('Batch currently supports H.264 MP4 input.');
  const duration = video.duration / video.timescale;
  const outputPixels = video.video.width * video.video.height * 4;
  const pixelLimit = quality === 'l' ? 1_500_000 : 4_000_000;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 30) throw new Error('Export limit: video must be 30 seconds or shorter.');
  if (outputPixels > pixelLimit) throw new Error(`Export limit: ${quality === 'l' ? 'Large' : 'selected model'} exceeds the safe output size (${pixelLimit.toLocaleString()} pixels).`);
  const audio = info.audioTracks.find(t => t.codec.startsWith('mp4a.40.'));
  if (info.audioTracks.length && !audio) throw new Error('Audio codec is unsupported; use an MP4 with AAC audio.');
  const videoSamples = samples.get(video.id) || [];
  if (!videoSamples.length) throw new Error('No video frames could be extracted.');
  const gpu = await WebSR.initWebGPU();
  if (!gpu) throw new Error('WebGPU is unavailable.');
  const width = video.video.width * 2, height = video.video.height * 2;
  const encoderConfig = { codec: 'avc1.640033', width, height, bitrate: Math.min(40_000_000, Math.max(4_000_000, width * height * 4)), framerate: Math.max(1, Math.min(60, Math.round(video.nb_samples / (video.duration / video.timescale)))), avc: { format: 'avc' } };
  const support = await VideoEncoder.isConfigSupported(encoderConfig);
  if (!support.supported) throw new Error('H.264 encoder cannot handle 2× resolution on this device.');
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'avc', width, height }, audio: audio ? { codec: 'aac', numberOfChannels: audio.audio.channel_count, sampleRate: audio.audio.sample_rate } : undefined, fastStart: false, firstTimestampBehavior: 'offset' });
  const outputCanvas = new OffscreenCanvas(width, height);
  const weights = await (await fetch(`/static/video-enhancer/weights/cnn-2x-${quality}-${content}.json`)).json();
  const sr = new WebSR({ canvas: outputCanvas, gpu, network_name: `anime4k/cnn-2x-${quality}`, weights });
  const post = createEffects(width, height);
  let decoder, encoder;
  try {
    let encoded = 0, rendered = 0, renderChain = Promise.resolve();
    encoder = new VideoEncoder({ output: (chunk, meta) => { muxer.addVideoChunk(chunk, meta); encoded++; }, error: error => { throw error; } });
    encoder.configure(encoderConfig);
    const description = avcDescription(mp4, video.id);
    decoder = new VideoDecoder({ output: frame => {
      renderChain = renderChain.then(async () => {
        try {
          if (cancelled) return;
          await sr.render(frame);
          post.render(outputCanvas, effects);
          const out = new VideoFrame(post.canvas, { timestamp: frame.timestamp, duration: frame.duration || undefined });
          encoder.encode(out, { keyFrame: rendered % 60 === 0 }); out.close();
          rendered++;
          if (rendered % 10 === 0) self.postMessage({ type: 'progress', value: Math.min(99, Math.round(100 * rendered / videoSamples.length)) });
        } finally { frame.close(); }
      });
    }, error: error => { throw error; } });
    decoder.configure({ codec: video.codec, codedWidth: video.video.width, codedHeight: video.video.height, description });
    // Feed one compressed frame at a time, waiting for render and encode to drain.
    for (let i = 0; i < videoSamples.length; i++) {
      if (cancelled) throw new Error('Cancelled.');
      const sample = videoSamples[i];
      decoder.decode(new EncodedVideoChunk({ type: sample.is_sync ? 'key' : 'delta', timestamp: Math.round(sample.cts * 1e6 / sample.timescale), duration: Math.round(sample.duration * 1e6 / sample.timescale), data: sample.data }));
      while (decoder.decodeQueueSize > 2 || rendered + 4 < i) await new Promise(resolve => setTimeout(resolve, 2));
    }
    await decoder.flush(); await renderChain; await encoder.flush();
    if (cancelled) throw new Error('Cancelled.');
    if (audio) for (const sample of samples.get(audio.id) || []) {
      muxer.addAudioChunkRaw(new Uint8Array(sample.data), 'key', Math.round(sample.cts * 1e6 / sample.timescale), Math.round(sample.duration * 1e6 / sample.timescale));
    }
    muxer.finalize();
    if (!target.buffer?.byteLength) throw new Error('Export produced an empty MP4.');
    self.postMessage({ type: 'complete', buffer: target.buffer, width, height, hasAudio: !!audio }, [target.buffer]);
  } finally { decoder?.close(); encoder?.close(); post.dispose(); await sr.destroy(); }
}

function avcDescription(mp4, id) {
  const track = mp4.getTrackById(id);
  const avcC = track?.mdia?.minf?.stbl?.stsd?.entries?.[0]?.avcC;
  if (!avcC) throw new Error('Missing H.264 decoder configuration.');
  const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
  avcC.write(stream);
  return new Uint8Array(stream.buffer.slice(8, stream.position));
}
