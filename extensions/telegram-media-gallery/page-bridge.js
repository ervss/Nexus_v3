(() => {
  const BRIDGE_VERSION = 5;
  const MAX_PARALLEL = 2;
  const HARD_MAX_PARALLEL = 4;

  // starý bridge ostával v MAIN world po reload extensionu — vždy pretlač novú verziu
  if (window.__nxTgGalleryBridgeVersion === BRIDGE_VERSION && window.__nxTgGalleryBridgeHandler) {
    document.documentElement.dataset.nxTgBridgeVersion = String(BRIDGE_VERSION);
    return;
  }

  if (typeof window.__nxTgGalleryBridgeHandler === "function") {
    window.removeEventListener("message", window.__nxTgGalleryBridgeHandler);
  }

  const queue = Array.isArray(window.__nxTgGalleryQueue) ? window.__nxTgGalleryQueue : [];
  window.__nxTgGalleryQueue = queue;
  window.__nxTgGalleryBridgeVersion = BRIDGE_VERSION;
  document.documentElement.dataset.nxTgBridgeVersion = String(BRIDGE_VERSION);
  document.documentElement.dataset.nxTgBridgeInjected = "1";

  let active = 0;
  let maxParallel = Number(window.__nxTgGalleryMaxParallel) || MAX_PARALLEL;
  let seq = Number(window.__nxTgGallerySeq) || 0;
  let lastPublish = 0;

  function setMaxParallel(next) {
    maxParallel = Math.max(MAX_PARALLEL, Math.min(HARD_MAX_PARALLEL, Number(next) || MAX_PARALLEL));
    window.__nxTgGalleryMaxParallel = maxParallel;
    return maxParallel;
  }

  async function readMessage(peerId, mid) {
    const peer = Number(peerId);
    const id = Number(mid);
    let msg = null;
    try {
      if (typeof apiManagerProxy !== "undefined" && apiManagerProxy.getMessageByPeer) {
        msg = await apiManagerProxy.getMessageByPeer(peer, id);
      }
    } catch (_) {}
    if (!msg) {
      try {
        msg = await rootScope.managers.appMessagesManager.getMessageByPeer(peer, id);
      } catch (_) {}
    }
    return msg || null;
  }

  function packMessage(msg) {
    if (!msg) return null;
    const doc = msg.media && msg.media.document;
    if (!doc) return { size: 0, fileName: "", duration: 0 };
    let fileName = "";
    let duration = 0;
    for (const attr of doc.attributes || []) {
      if (attr._ === "documentAttributeFilename") fileName = attr.file_name || attr.fileName || "";
      if (attr._ === "documentAttributeVideo") duration = attr.duration || 0;
    }
    return {
      size: Number(doc.size) || 0,
      fileName,
      duration,
      mime: doc.mime_type || doc.mimeType || "",
    };
  }

  function snapshot() {
    return queue.map((job) => ({
      id: job.id,
      peerId: job.peerId,
      mid: job.mid,
      fileName: job.fileName,
      size: job.size,
      status: job.status,
      done: job.done,
      total: job.total,
      error: job.error || "",
      percent: job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0,
    }));
  }

  function publish(force = false) {
    const now = Date.now();
    if (!force && now - lastPublish < 200) return;
    lastPublish = now;
    window.postMessage({
      source: "nx-tg-gallery",
      direction: "queue",
      queue: snapshot(),
      maxParallel,
      active,
      bridgeVersion: BRIDGE_VERSION,
    }, "*");
  }

  function reply(requestId, payload) {
    window.postMessage({
      source: "nx-tg-gallery",
      direction: "res",
      requestId,
      ...payload,
    }, "*");
  }

  function enqueue(items) {
    let added = 0;
    for (const row of items || []) {
      const peerId = String(row.peerId || "");
      const mid = String(row.mid || "");
      if (!peerId || !mid) continue;
      const exists = queue.some((job) => (
        job.peerId === peerId
        && job.mid === mid
        && (job.status === "queued" || job.status === "downloading")
      ));
      if (exists) continue;
      queue.push({
        id: `dl-${++seq}`,
        peerId,
        mid,
        fileName: "",
        size: 0,
        status: "queued",
        done: 0,
        total: 0,
        error: "",
        deferred: null,
      });
      added += 1;
    }
    window.__nxTgGallerySeq = seq;
    while (queue.length > 80) {
      const idx = queue.findIndex((job) => job.status === "done" || job.status === "error" || job.status === "cancelled");
      if (idx < 0) break;
      queue.splice(idx, 1);
    }
    publish(true);
    pump();
    return added;
  }

  async function runJob(job) {
    try {
      const msg = await readMessage(job.peerId, job.mid);
      if (job.status === "cancelled") return;
      const doc = msg && msg.media && msg.media.document;
      if (!doc) {
        job.status = "error";
        job.error = "no-document";
        publish(true);
        return;
      }
      const meta = packMessage(msg);
      job.fileName = meta.fileName || `${job.mid}.mp4`;
      job.size = meta.size || 0;
      job.total = meta.size || 0;
      publish(true);

      // false = skutočné uloženie na disk (true len cache)
      const deferred = appDownloadManager.downloadToDisc({
        media: doc,
        fileName: job.fileName || undefined,
      }, false);
      job.deferred = deferred;

      if (deferred && typeof deferred.addNotifyListener === "function") {
        deferred.addNotifyListener((progress) => {
          if (!progress || job.status === "cancelled") return;
          job.done = Number(progress.done) || 0;
          job.total = Number(progress.total) || job.total || 0;
          if (progress.fileName) job.fileName = progress.fileName;
          publish(false);
        });
      }

      await deferred;
      if (job.status === "cancelled") return;
      job.done = job.total || job.done;
      job.status = "done";
      publish(true);
    } catch (error) {
      if (job.status === "cancelled") return;
      job.status = "error";
      job.error = String(error && error.message ? error.message : error).slice(0, 160);
      publish(true);
    } finally {
      job.deferred = null;
    }
  }

  function startJob(job) {
    if (!job || job.status !== "queued") return false;
    job.status = "downloading";
    active += 1;
    publish(true);
    Promise.resolve()
      .then(() => runJob(job))
      .finally(() => {
        active = Math.max(0, active - 1);
        publish(true);
        pump();
      });
    return true;
  }

  function pump() {
    // default 2 naraz; FORCE môže dočasne zdvihnúť strop až na 4
    while (active < maxParallel) {
      const job = queue.find((row) => row.status === "queued");
      if (!job) break;
      startJob(job);
    }
  }

  function forceDownload(id) {
    const job = id
      ? queue.find((row) => row.id === id && row.status === "queued")
      : queue.find((row) => row.status === "queued");
    if (!job) return false;
    // zdvihni limit o 1 (max 4), potom okamžite naštartuj tento job
    setMaxParallel(Math.max(maxParallel, active + 1));
    if (job.status !== "queued") return false;
    if (active >= maxParallel) setMaxParallel(active + 1);
    return startJob(job);
  }

  function cancelJob(id) {
    const job = queue.find((row) => row.id === id);
    if (!job) return false;
    if (job.status === "queued") {
      job.status = "cancelled";
      publish(true);
      return true;
    }
    if (job.status === "downloading") {
      job.status = "cancelled";
      try {
        if (job.deferred && typeof job.deferred.cancel === "function") job.deferred.cancel();
      } catch (_) {}
      publish(true);
      return true;
    }
    return false;
  }

  function clearFinished() {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (["done", "error", "cancelled"].includes(queue[i].status)) queue.splice(i, 1);
    }
    publish(true);
  }

  async function forwardToSaved(items) {
    const myId = rootScope && rootScope.myId;
    if (!myId) throw new Error("no-self");
    const groups = new Map();
    for (const row of items || []) {
      const fromPeerId = Number(row.peerId);
      const mid = Number(row.mid);
      if (!fromPeerId || !mid) continue;
      if (!groups.has(fromPeerId)) groups.set(fromPeerId, []);
      groups.get(fromPeerId).push(mid);
    }
    if (!groups.size) return { forwarded: 0, groups: 0 };
    let forwarded = 0;
    let groupsOk = 0;
    for (const [fromPeerId, mids] of groups) {
      await rootScope.managers.appMessagesManager.forwardMessages({
        peerId: myId,
        fromPeerId,
        mids,
      });
      forwarded += mids.length;
      groupsOk += 1;
    }
    return { forwarded, groups: groupsOk };
  }

  async function onMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "nx-tg-gallery" || data.direction !== "req") return;
    const { requestId, type } = data;
    if (!requestId || !type) return;

    if (type === "ping") {
      reply(requestId, {
        ok: true,
        pong: true,
        bridgeVersion: BRIDGE_VERSION,
        maxParallel: MAX_PARALLEL,
      });
      return;
    }

    if (type === "meta") {
      const msg = await readMessage(data.peerId, data.mid);
      reply(requestId, { ok: !!msg, meta: packMessage(msg) });
      return;
    }

    if (type === "meta-batch") {
      const items = Array.isArray(data.items) ? data.items : [];
      const metas = {};
      await Promise.all(items.map(async (row) => {
        const msg = await readMessage(row.peerId, row.mid);
        metas[row.mid] = packMessage(msg);
      }));
      reply(requestId, { ok: true, metas });
      return;
    }

    if (type === "download" || type === "download-enqueue") {
      const added = enqueue(Array.isArray(data.items) ? data.items : []);
      reply(requestId, {
        ok: added > 0 || queue.some((job) => job.status === "queued" || job.status === "downloading"),
        added,
        queue: snapshot(),
        maxParallel,
        bridgeVersion: BRIDGE_VERSION,
      });
      return;
    }

    if (type === "download-queue-get") {
      reply(requestId, {
        ok: true,
        queue: snapshot(),
        maxParallel,
        active,
        bridgeVersion: BRIDGE_VERSION,
      });
      return;
    }

    if (type === "download-force") {
      const ok = forceDownload(data.id);
      reply(requestId, {
        ok,
        queue: snapshot(),
        maxParallel,
        active,
        error: ok ? "" : "no-queued-job",
      });
      return;
    }

    if (type === "download-cancel") {
      reply(requestId, { ok: cancelJob(data.id), queue: snapshot(), maxParallel });
      return;
    }

    if (type === "download-clear-finished") {
      clearFinished();
      reply(requestId, { ok: true, queue: snapshot() });
      return;
    }

    if (type === "forward-saved") {
      try {
        const result = await forwardToSaved(Array.isArray(data.items) ? data.items : []);
        reply(requestId, {
          ok: result.forwarded > 0,
          forwarded: result.forwarded,
          groups: result.groups,
        });
      } catch (error) {
        reply(requestId, {
          ok: false,
          error: String(error && error.message ? error.message : error).slice(0, 160),
        });
      }
    }
  }

  window.__nxTgGalleryBridgeHandler = onMessage;
  window.__nxTgGalleryBridge = true;
  window.addEventListener("message", onMessage);

  // po hot-reloadi dobehni front s novou paralelkou
  active = queue.filter((job) => job.status === "downloading").length;
  for (const job of queue) {
    if (job.status === "downloading" && !job.deferred) job.status = "queued";
  }
  active = 0;
  pump();
})();
