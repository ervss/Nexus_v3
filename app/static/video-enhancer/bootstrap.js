import { attachVideoEnhancer } from './VideoEnhancer.js';

document.body.insertAdjacentHTML('beforeend', '<svg aria-hidden="true" width="0" height="0" style="position:absolute"><filter id="nexus-enhancer-sharpen"><feConvolveMatrix order="3" kernelMatrix="0 -0.2 0 -0.2 1.8 -0.2 0 -0.2 0" preserveAlpha="true"/></filter></svg>');

const instances = new Set();
function scan() {
  for (const video of document.querySelectorAll('.player-overlay .player-box video')) {
    if (!video.__nexusEnhancer) instances.add(attachVideoEnhancer(video));
  }
  for (const instance of instances) {
    if (!instance.video.isConnected) { instance.destroy(); instances.delete(instance); }
    else instance.attachControl();
  }
}
new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
scan();
