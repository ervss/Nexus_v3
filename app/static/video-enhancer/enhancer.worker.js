import WebSR from '@websr/websr';

let gpu, sr, canvas, quality = 'm', content = 'rl', effects = { sharpen: true, color: true };
let busy = false, inputWidth = 0, inputHeight = 0;
const model = () => `anime4k/cnn-2x-${quality}`;
const weightsUrl = () => `/static/video-enhancer/weights/cnn-2x-${quality}-${content}.json`;

async function prepare() {
  // WebSR.destroy() destroys its GPUDevice too. Never reuse that device.
  if (sr) { await sr.destroy(); sr = null; gpu = null; }
  if (!gpu) gpu = await WebSR.initWebGPU();
  if (!gpu) throw new Error('WebGPU is unavailable on this device.');
  const weights = await (await fetch(weightsUrl())).json();
  sr = new WebSR({ canvas, gpu, network_name: model(), weights });
  inputWidth = 0; inputHeight = 0;
  gpu.lost.then(info => { if (info.reason !== 'destroyed') self.postMessage({ type: 'error', message: `GPU device lost: ${info.message}` }); });
}

let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(() => handle(data)).catch(error => {
    if (data.frame) data.frame.close();
    busy = false;
    self.postMessage({ type: 'error', message: error.message });
  });
};

async function handle(data) {
  try {
    if (data.type === 'init') {
      canvas = data.canvas; quality = data.quality; content = data.content;
      await prepare(); self.postMessage({ type: 'ready' });
    } else if (data.type === 'settings') {
      quality = data.quality; content = data.content; effects = data.effects;
      await prepare(); self.postMessage({ type: 'ready' });
    } else if (data.type === 'frame') {
      if (busy || !sr) { data.frame.close(); return; }
      busy = true;
      try {
        // The library's resize path destroys and then reuses its device.
        // Recreate the instance/device ourselves when an adaptive stream changes size.
        if (inputWidth && (inputWidth !== data.frame.width || inputHeight !== data.frame.height)) await prepare();
        inputWidth = data.frame.width; inputHeight = data.frame.height;
        gpu.pushErrorScope('validation');
        await sr.render(data.frame);
        const validationError = await gpu.popErrorScope();
        if (validationError) throw new Error(validationError.message);
        await gpu.queue.onSubmittedWorkDone();
        self.postMessage({ type: 'rendered', timestamp: data.timestamp, width: canvas.width, height: canvas.height });
      } finally { data.frame.close(); busy = false; }
    } else if (data.type === 'dispose') {
      if (sr) await sr.destroy(); sr = null; self.close();
    }
  } catch (error) { if (data.frame) data.frame.close(); busy = false; self.postMessage({ type: 'error', message: error.message }); }
}
