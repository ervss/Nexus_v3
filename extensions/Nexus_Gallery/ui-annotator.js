(function () {
  if (window.NexusUiAnnotator) return;

  const COLORS = [
    '#ffcf5c',
    '#71e1ff',
    '#a78bfa',
    '#ff6b9e',
    '#57d68d',
    '#ffffff',
  ];

  const state = {
    enabled: false,
    tool: 'pen',
    color: COLORS[0],
    brushSize: 6,
    strokes: [],
    notes: [],
    noteCounter: 1,
    activeStroke: null,
    activeNote: null,
    dragOffset: null,
    storageKey: null,
    savedAt: null,
  };

  const el = {};

  function getContextKey() {
    const sourceUrl = window.sourceTabContext?.sourceUrl || window.location.href;
    const sourceTitle = window.sourceTabContext?.sourceTitle || '';
    return `ui_annotator:${encodeURIComponent(sourceUrl || sourceTitle || 'popup-ui')}`;
  }

  function syncStorageKey() {
    state.storageKey = getContextKey();
    return state.storageKey;
  }

  function injectStyles() {
    if (document.getElementById('ui-annotator-style')) return;
    const style = document.createElement('style');
    style.id = 'ui-annotator-style';
    style.textContent = `
      .ui-annotator-root {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        display: none;
        pointer-events: none;
      }
      .ui-annotator-root.active {
        display: block;
      }
      .ui-annotator-root.capture-hidden .ui-annotator-toolbar,
      .ui-annotator-root.capture-hidden .ui-annotator-sidebar {
        display: none;
      }
      .ui-annotator-scrim {
        position: absolute;
        inset: 0;
        background: rgba(3, 6, 12, 0.18);
        backdrop-filter: blur(1px);
      }
      .ui-annotator-toolbar {
        position: absolute;
        top: 12px;
        left: 12px;
        right: 12px;
        z-index: 2;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        border-radius: 16px;
        background: rgba(7, 11, 22, 0.9);
        border: 1px solid rgba(255,255,255,0.12);
        box-shadow: 0 18px 36px rgba(0,0,0,0.25);
        backdrop-filter: blur(16px);
        pointer-events: auto;
      }
      .ui-annotator-group {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .ui-annotator-btn {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.06);
        color: rgba(255,255,255,0.95);
        border-radius: 12px;
        padding: 8px 12px;
        font: inherit;
        cursor: pointer;
        box-shadow: 0 8px 18px rgba(0,0,0,0.15);
      }
      .ui-annotator-btn.active {
        background: linear-gradient(135deg, rgba(113,225,255,0.24), rgba(167,139,250,0.18));
        border-color: rgba(113,225,255,0.55);
      }
      .ui-annotator-btn.danger {
        background: rgba(255,107,107,0.12);
        border-color: rgba(255,107,107,0.3);
      }
      .ui-annotator-btn.primary {
        background: linear-gradient(135deg, rgba(113,225,255,0.20), rgba(167,139,250,0.16));
        border-color: rgba(113,225,255,0.45);
      }
      .ui-annotator-status {
        color: rgba(255,255,255,0.7);
        font-size: 0.8rem;
        padding: 0 6px;
        min-width: 220px;
        text-overflow: ellipsis;
        overflow: hidden;
        white-space: nowrap;
      }
      .ui-annotator-stage {
        position: absolute;
        inset: 70px 0 0 0;
        pointer-events: none;
      }
      .ui-annotator-canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: auto;
        cursor: crosshair;
      }
      .ui-annotator-notes {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }
      .ui-annotator-note {
        position: absolute;
        min-width: 200px;
        max-width: 280px;
        background: linear-gradient(180deg, rgba(255,247,202,0.98), rgba(255,235,150,0.96));
        color: #1d1b11;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.7);
        box-shadow: 0 18px 36px rgba(0,0,0,0.25);
        padding: 10px;
        pointer-events: auto;
      }
      .ui-annotator-note-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        font-size: 0.72rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        font-weight: 700;
        user-select: none;
        cursor: grab;
        margin-bottom: 8px;
      }
      .ui-annotator-note-body {
        min-height: 56px;
        outline: none;
        white-space: pre-wrap;
        line-height: 1.35;
        font-size: 0.92rem;
      }
      .ui-annotator-sidebar {
        position: absolute;
        top: 78px;
        right: 12px;
        bottom: 12px;
        width: 296px;
        z-index: 2;
        display: flex;
        flex-direction: column;
        gap: 10px;
        pointer-events: auto;
      }
      .ui-annotator-card {
        background: rgba(7, 11, 22, 0.9);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 16px;
        padding: 12px;
        box-shadow: 0 18px 36px rgba(0,0,0,0.22);
        backdrop-filter: blur(16px);
        color: rgba(255,255,255,0.94);
      }
      .ui-annotator-card h3 {
        margin: 0 0 10px;
        font-size: 0.8rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: rgba(255,255,255,0.65);
      }
      .ui-annotator-swatches {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .ui-annotator-swatch {
        width: 28px;
        height: 28px;
        border-radius: 999px;
        border: 2px solid rgba(255,255,255,0.18);
        cursor: pointer;
      }
      .ui-annotator-swatch.active {
        border-color: white;
        transform: scale(1.08);
      }
      .ui-annotator-range-row {
        display: flex;
        gap: 10px;
        align-items: center;
        margin-top: 10px;
        color: rgba(255,255,255,0.7);
        font-size: 0.82rem;
      }
      .ui-annotator-range-row input[type="range"] {
        flex: 1;
        accent-color: #71e1ff;
      }
      .ui-annotator-note-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-height: 100%;
        overflow: auto;
      }
      .ui-annotator-note-item {
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 14px;
        padding: 10px;
      }
      .ui-annotator-note-item .head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        color: rgba(255,255,255,0.68);
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .ui-annotator-note-item .body {
        min-height: 56px;
        outline: none;
        white-space: pre-wrap;
        line-height: 1.35;
        font-size: 0.9rem;
      }
      .ui-annotating * {
        user-select: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureDom() {
    if (el.root) return;
    injectStyles();

    const root = document.createElement('div');
    root.id = 'ui-annotator-root';
    root.className = 'ui-annotator-root';
    root.innerHTML = `
      <div class="ui-annotator-scrim"></div>
      <div class="ui-annotator-toolbar">
        <div class="ui-annotator-group">
          <button class="ui-annotator-btn" data-tool="move">Move</button>
          <button class="ui-annotator-btn active" data-tool="pen">Pen</button>
          <button class="ui-annotator-btn" data-tool="highlight">Highlight</button>
          <button class="ui-annotator-btn" data-tool="note">Note</button>
          <button class="ui-annotator-btn" data-action="undo">Undo</button>
          <button class="ui-annotator-btn danger" data-action="clear">Clear</button>
          <button class="ui-annotator-btn" data-action="close">Close</button>
        </div>
        <div class="ui-annotator-status" data-role="status">Annotate UI mode ready</div>
        <div class="ui-annotator-group">
          <button class="ui-annotator-btn primary" data-action="copy-summary">Copy summary</button>
          <button class="ui-annotator-btn primary" data-action="copy-json">Copy JSON</button>
          <button class="ui-annotator-btn primary" data-action="download-json">Download JSON</button>
          <button class="ui-annotator-btn primary" data-action="download-png">Download PNG</button>
        </div>
      </div>
      <div class="ui-annotator-stage">
        <canvas class="ui-annotator-canvas"></canvas>
        <div class="ui-annotator-notes"></div>
      </div>
      <aside class="ui-annotator-sidebar">
        <div class="ui-annotator-card">
          <h3>Tool settings</h3>
          <div class="ui-annotator-swatches"></div>
          <div class="ui-annotator-range-row">
            <span>Size</span>
            <input data-role="size" type="range" min="2" max="30" value="6">
            <span data-role="size-label">6</span>
          </div>
          <div style="margin-top:10px;color:rgba(255,255,255,0.66);font-size:0.82rem;line-height:1.45;">
            Klikni <strong>Note</strong> a potom do popupu, ak chceš vložiť sticky poznámku.
            Kresli nad samotným extension UI, nie nad zdrojovou stránkou.
          </div>
        </div>
        <div class="ui-annotator-card">
          <h3>Context</h3>
          <div data-role="context" style="font-size:0.82rem;color:rgba(255,255,255,0.72);line-height:1.45;word-break:break-word;"></div>
        </div>
        <div class="ui-annotator-card" style="flex:1;min-height:0;display:flex;flex-direction:column;">
          <h3>Notes</h3>
          <div class="ui-annotator-note-list" data-role="note-list"></div>
        </div>
      </aside>
    `;
    document.body.appendChild(root);

    el.root = root;
    el.status = root.querySelector('[data-role="status"]');
    el.canvas = root.querySelector('.ui-annotator-canvas');
    el.stage = root.querySelector('.ui-annotator-stage');
    el.notes = root.querySelector('.ui-annotator-notes');
    el.noteList = root.querySelector('[data-role="note-list"]');
    el.context = root.querySelector('[data-role="context"]');
    el.size = root.querySelector('[data-role="size"]');
    el.sizeLabel = root.querySelector('[data-role="size-label"]');
    el.swatches = root.querySelector('.ui-annotator-swatches');
    el.ctx = el.canvas.getContext('2d');
    el.ctx.lineCap = 'round';
    el.ctx.lineJoin = 'round';

    root.querySelectorAll('[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });
    root.querySelector('[data-action="undo"]').addEventListener('click', undo);
    root.querySelector('[data-action="clear"]').addEventListener('click', clearAll);
    root.querySelector('[data-action="close"]').addEventListener('click', close);
    root.querySelector('[data-action="copy-summary"]').addEventListener('click', copySummary);
    root.querySelector('[data-action="copy-json"]').addEventListener('click', copyJson);
    root.querySelector('[data-action="download-json"]').addEventListener('click', downloadJson);
    root.querySelector('[data-action="download-png"]').addEventListener('click', downloadPng);
    el.size.addEventListener('input', () => {
      state.brushSize = Number(el.size.value) || 6;
      el.sizeLabel.textContent = String(state.brushSize);
      saveSoon();
    });
    el.canvas.addEventListener('pointerdown', onPointerDown);
    el.canvas.addEventListener('pointermove', onPointerMove);
    el.canvas.addEventListener('pointerup', onPointerUp);
    el.canvas.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('resize', () => {
      resizeCanvas();
      renderNotes();
    });
    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    createSwatches();
    updateContextSummary();
  }

  function updateContextSummary() {
    const lines = [];
    if (window.sourceTabContext?.sourceTitle) lines.push(window.sourceTabContext.sourceTitle);
    if (window.sourceTabContext?.sourceUrl) lines.push(window.sourceTabContext.sourceUrl);
    lines.push(`Window: ${window.sourceTabContext?.sourceWindowId || '-'}`);
    lines.push(`Tab: ${window.sourceTabContext?.sourceTabId || '-'}`);
    el.context.textContent = lines.join('\n');
  }

  function createSwatches() {
    el.swatches.innerHTML = '';
    COLORS.forEach((color) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ui-annotator-swatch' + (state.color === color ? ' active' : '');
      btn.style.background = color;
      btn.title = color;
      btn.addEventListener('click', () => {
        state.color = color;
        createSwatches();
        saveSoon();
      });
      el.swatches.appendChild(btn);
    });
  }

  function setStatus(text) {
    el.status.textContent = text;
  }

  function setTool(tool) {
    state.tool = tool;
    el.root.querySelectorAll('[data-tool]').forEach((btn) => btn.classList.toggle('active', btn.dataset.tool === tool));
    el.canvas.style.cursor = tool === 'note' ? 'copy' : 'crosshair';
    setStatus(`Tool: ${tool}`);
  }

  function getViewportRect() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function resizeCanvas() {
    const width = Math.max(1, Math.round(window.innerWidth));
    const height = Math.max(1, Math.round(window.innerHeight));
    if (el.canvas.width !== width || el.canvas.height !== height) {
      el.canvas.width = width;
      el.canvas.height = height;
      redraw();
    }
  }

  function pointFromEvent(ev) {
    const rect = el.canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height)),
    };
  }

  function roundRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function drawStroke(stroke) {
    if (!stroke?.points?.length) return;
    const width = el.canvas.width || 1;
    const height = el.canvas.height || 1;
    el.ctx.save();
    el.ctx.globalAlpha = stroke.tool === 'highlight' ? 0.24 : 1;
    el.ctx.strokeStyle = stroke.color;
    el.ctx.lineWidth = stroke.width;
    el.ctx.beginPath();
    stroke.points.forEach((point, index) => {
      const x = point.x * width;
      const y = point.y * height;
      if (index === 0) el.ctx.moveTo(x, y);
      else el.ctx.lineTo(x, y);
    });
    el.ctx.stroke();
    el.ctx.restore();
  }

  function redraw() {
    el.ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
    state.strokes.forEach(drawStroke);
    if (state.activeStroke) drawStroke(state.activeStroke);
  }

  function makeNote(note) {
    const node = document.createElement('div');
    node.className = 'ui-annotator-note';
    node.dataset.id = note.id;
    node.style.left = `${note.x * 100}%`;
    node.style.top = `${note.y * 100}%`;

    const head = document.createElement('div');
    head.className = 'ui-annotator-note-head';
    head.innerHTML = `<span>${note.id}</span><span>drag</span>`;
    const body = document.createElement('div');
    body.className = 'ui-annotator-note-body';
    body.contentEditable = 'true';
    body.spellcheck = false;
    body.textContent = note.text || '';

    head.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      state.activeNote = note;
      state.dragOffset = {
        x: ev.clientX,
        y: ev.clientY,
      };
      head.setPointerCapture(ev.pointerId);
    });

    body.addEventListener('input', () => {
      note.text = body.textContent || '';
      scheduleSave(true);
    });

    node.appendChild(head);
    node.appendChild(body);
    return node;
  }

  function renderNotes() {
    el.notes.innerHTML = '';
    el.noteList.innerHTML = '';

    state.notes.forEach((note) => {
      const node = makeNote(note);
      el.notes.appendChild(node);

      const item = document.createElement('div');
      item.className = 'ui-annotator-note-item';
      item.innerHTML = `
        <div class="head"><span>${note.id}</span><span>${Math.round(note.x * 100)}%, ${Math.round(note.y * 100)}%</span></div>
        <div class="body" contenteditable="true" spellcheck="false"></div>
      `;
      const body = item.querySelector('.body');
      body.textContent = note.text || '';
      body.addEventListener('input', () => {
        note.text = body.textContent || '';
        const inline = el.notes.querySelector(`.ui-annotator-note[data-id="${CSS.escape(note.id)}"] .ui-annotator-note-body`);
        if (inline && inline.textContent !== note.text) inline.textContent = note.text;
        scheduleSave(true);
      });
      el.noteList.appendChild(item);
    });
  }

  function addNoteAt(point) {
    const id = `N${String(state.noteCounter++).padStart(2, '0')}`;
    state.notes.push({ id, x: point.x, y: point.y, text: '' });
    renderNotes();
    scheduleSave(true);
    requestAnimationFrame(() => {
      const inline = el.notes.querySelector(`.ui-annotator-note[data-id="${CSS.escape(id)}"] .ui-annotator-note-body`);
      inline?.focus();
    });
  }

  function undo() {
    if (state.strokes.length) state.strokes.pop();
    else if (state.notes.length) state.notes.pop();
    renderNotes();
    redraw();
    saveSoon(true);
  }

  function clearAll() {
    state.strokes = [];
    state.notes = [];
    renderNotes();
    redraw();
    saveSoon(true);
  }

  function onPointerDown(ev) {
    if (!state.enabled) return;
    if (state.tool === 'move') return;
    if (state.tool === 'note') {
      addNoteAt(pointFromEvent(ev));
      return;
    }
    ev.preventDefault();
    state.activeStroke = {
      tool: state.tool === 'highlight' ? 'highlight' : 'pen',
      color: state.color,
      width: state.tool === 'highlight' ? Math.max(12, state.brushSize * 3) : state.brushSize,
      points: [pointFromEvent(ev)],
    };
    el.canvas.setPointerCapture(ev.pointerId);
    redraw();
  }

  function onPointerMove(ev) {
    if (!state.enabled) return;
    if (state.activeStroke) {
      state.activeStroke.points.push(pointFromEvent(ev));
      redraw();
    }
  }

  function onPointerUp(ev) {
    if (!state.enabled) return;
    if (state.activeStroke) {
      if (state.activeStroke.points.length > 1) state.strokes.push(state.activeStroke);
      state.activeStroke = null;
      redraw();
      saveSoon(true);
    }
    try { el.canvas.releasePointerCapture(ev.pointerId); } catch {}
  }

  function onWindowPointerMove(ev) {
    if (!state.enabled || !state.activeNote || !state.dragOffset) return;
    const rect = getViewportRect();
    const x = Math.min(1, Math.max(0, ev.clientX / rect.width));
    const y = Math.min(1, Math.max(0, ev.clientY / rect.height));
    state.activeNote.x = x;
    state.activeNote.y = y;
    const node = el.notes.querySelector(`.ui-annotator-note[data-id="${CSS.escape(state.activeNote.id)}"]`);
    if (node) {
      node.style.left = `${x * 100}%`;
      node.style.top = `${y * 100}%`;
    }
    const items = [...el.noteList.querySelectorAll('.ui-annotator-note-item')];
    const idx = state.notes.indexOf(state.activeNote);
    const item = items[idx];
    if (item) item.querySelector('.head span:last-child').textContent = `${Math.round(x * 100)}%, ${Math.round(y * 100)}%`;
    saveSoon();
  }

  function onWindowPointerUp() {
    state.activeNote = null;
    state.dragOffset = null;
  }

  function saveSoon(force = false) {
    if (!state.enabled) return;
    if (saveTimer) clearTimeout(saveTimer);
    const commit = async () => {
      syncStorageKey();
      const payload = serialize();
      payload.updatedAt = Date.now();
      await chrome.storage.local.set({ [state.storageKey]: payload });
      state.savedAt = payload.updatedAt;
      setStatus(`Autosaved ${new Date(payload.updatedAt).toLocaleTimeString()}`);
    };
    saveTimer = setTimeout(commit, force ? 10 : 350);
    return saveTimer;
  }

  let saveTimer = null;

  function serialize() {
    return {
      version: 1,
      type: 'popup-ui-annotator',
      context: {
        sourceUrl: window.sourceTabContext?.sourceUrl || '',
        sourceTitle: window.sourceTabContext?.sourceTitle || '',
        sourceTabId: window.sourceTabContext?.sourceTabId || null,
        sourceWindowId: window.sourceTabContext?.sourceWindowId || null,
        pageHref: window.location.href,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      color: state.color,
      brushSize: state.brushSize,
      strokes: state.strokes,
      notes: state.notes,
      updatedAt: state.savedAt || Date.now(),
    };
  }

  async function loadSaved() {
    syncStorageKey();
    const saved = await chrome.storage.local.get([state.storageKey]);
    const payload = saved[state.storageKey];
    if (!payload) return;
    if (Array.isArray(payload.strokes)) state.strokes = payload.strokes;
    if (Array.isArray(payload.notes)) state.notes = payload.notes;
    if (payload.color) state.color = payload.color;
    if (Number.isFinite(payload.brushSize)) state.brushSize = payload.brushSize;
    state.noteCounter = Math.max(1, ...state.notes.map((note) => Number(String(note.id).replace(/\D/g, '')) || 0)) + 1;
    el.size.value = String(state.brushSize);
    el.sizeLabel.textContent = String(state.brushSize);
    createSwatches();
    renderNotes();
    redraw();
  }

  async function copyJson() {
    await navigator.clipboard.writeText(JSON.stringify(serialize(), null, 2));
    setStatus('JSON copied');
  }

  async function copySummary() {
    const lines = [
      `Source: ${window.sourceTabContext?.sourceTitle || 'popup UI'}`,
      `URL: ${window.sourceTabContext?.sourceUrl || '-'}`,
      `Notes: ${state.notes.length}`,
      `Strokes: ${state.strokes.length}`,
      '',
    ];
    state.notes.forEach((note, index) => {
      lines.push(`${index + 1}. ${note.id}: ${note.text || '(empty)'}`);
    });
    await navigator.clipboard.writeText(lines.join('\n'));
    setStatus('Summary copied');
  }

  async function downloadJson() {
    const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' });
    downloadBlob(blob, `nexus-ui-annotator-${Date.now()}.json`);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function downloadPng() {
    try {
      const currentWindow = await chrome.windows.getCurrent();
      el.root.classList.add('capture-hidden');
      const dataUrl = await chrome.tabs.captureVisibleTab(currentWindow.id, { format: 'png' });
      el.root.classList.remove('capture-hidden');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `nexus-ui-annotator-${Date.now()}.png`;
      a.click();
      setStatus('PNG downloaded');
    } catch (err) {
      el.root.classList.remove('capture-hidden');
      console.warn(err);
      setStatus(`PNG capture failed: ${err?.message || err}`);
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function open() {
    ensureDom();
    state.enabled = true;
    el.root.classList.add('active');
    document.body.classList.add('ui-annotating');
    resizeCanvas();
    renderNotes();
    redraw();
    setStatus('Annotating popup UI');
    loadSaved().catch((err) => setStatus(`Load failed: ${err?.message || err}`));
  }

  function close() {
    state.enabled = false;
    el.root?.classList.remove('active');
    document.body.classList.remove('ui-annotating');
    setStatus('Annotate UI off');
  }

  function toggle() {
    if (state.enabled) close();
    else open();
  }

  window.NexusUiAnnotator = {
    open,
    close,
    toggle,
    isOpen: () => state.enabled,
    serialize,
  };

  const bootIfNeeded = () => {
    syncStorageKey();
    ensureDom();
    if (window.location.search.includes('uiDebug=1')) {
      open();
    }
  };

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', bootIfNeeded, { once: true });
  } else {
    bootIfNeeded();
  }
})();
