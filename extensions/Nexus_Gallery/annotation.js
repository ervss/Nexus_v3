const params = new URLSearchParams(location.search);
const state = {
  source: {
    tabId: Number(params.get('sourceTabId') || 0) || null,
    windowId: Number(params.get('sourceWindowId') || 0) || null,
    url: params.get('sourceUrl') || '',
    title: params.get('sourceTitle') || '',
    launchedAt: Number(params.get('launchTs') || Date.now()) || Date.now(),
  },
  tool: 'pen',
  color: '#ffcf5c',
  brushSize: 6,
  strokes: [],
  notes: [],
  screenshotUrl: '',
  updatedAt: Date.now(),
};

const el = {
  sourceMeta: document.getElementById('sourceMeta'),
  sourceUrl: document.getElementById('sourceUrl'),
  sourceTitle: document.getElementById('sourceTitle'),
  sourceWindow: document.getElementById('sourceWindow'),
  saveStatus: document.getElementById('saveStatus'),
  shot: document.getElementById('shot'),
  wrap: document.getElementById('canvasWrap'),
  canvas: document.getElementById('drawingCanvas'),
  notesLayer: document.getElementById('notesLayer'),
  noteList: document.getElementById('noteList'),
  swatches: document.getElementById('swatches'),
  sizeRange: document.getElementById('sizeRange'),
  sizeLabel: document.getElementById('sizeLabel'),
  toolButtons: {
    move: document.getElementById('toolMove'),
    pen: document.getElementById('toolPen'),
    highlight: document.getElementById('toolHighlight'),
    note: document.getElementById('toolNote'),
  },
  btnUndo: document.getElementById('btnUndo'),
  btnClear: document.getElementById('btnClear'),
  btnCapture: document.getElementById('btnCapture'),
  btnDownloadPng: document.getElementById('btnDownloadPng'),
  btnDownloadJson: document.getElementById('btnDownloadJson'),
  btnCopyJson: document.getElementById('btnCopyJson'),
  btnCopySummary: document.getElementById('btnCopySummary'),
  btnAddNote: document.getElementById('btnAddNote'),
  btnEraseLast: document.getElementById('btnEraseLast'),
};

const ctx = el.canvas.getContext('2d');
ctx.lineCap = 'round';
ctx.lineJoin = 'round';

const palette = [
  { name: 'Sun', color: '#ffcf5c' },
  { name: 'Cyan', color: '#71e1ff' },
  { name: 'Violet', color: '#a78bfa' },
  { name: 'Rose', color: '#ff6b9e' },
  { name: 'Mint', color: '#57d68d' },
  { name: 'White', color: '#ffffff' },
];

let strokeDraft = null;
let dragNote = null;
let dragOffset = null;
let saveTimer = null;
let noteCounter = 1;

function storageKey() {
  return `nexus_annotator:${encodeURIComponent(state.source.url || state.source.title || 'untitled')}`;
}

function setStatus(text) {
  el.saveStatus.textContent = text;
}

function prettySourceText() {
  const parts = [];
  if (state.source.title) parts.push(state.source.title);
  if (state.source.url) parts.push(state.source.url);
  return parts.join(' · ') || 'Neznáma stránka';
}

function syncSourceLabels() {
  el.sourceMeta.textContent = prettySourceText();
  el.sourceUrl.textContent = `URL: ${state.source.url || '-'}`;
  el.sourceTitle.textContent = `Title: ${state.source.title || '-'}`;
  el.sourceWindow.textContent = `Window: ${state.source.windowId || '-'} / Tab: ${state.source.tabId || '-'}`;
}

function setActiveTool(tool) {
  state.tool = tool;
  Object.entries(el.toolButtons).forEach(([key, btn]) => btn.classList.toggle('active', key === tool));
  el.canvas.style.cursor = tool === 'note' ? 'copy' : 'crosshair';
}

function setBrushSize(size) {
  state.brushSize = Number(size) || 6;
  el.sizeLabel.textContent = String(state.brushSize);
  el.sizeRange.value = String(state.brushSize);
}

function createSwatches() {
  el.swatches.innerHTML = '';
  palette.forEach((swatch) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch' + (state.color === swatch.color ? ' active' : '');
    btn.title = swatch.name;
    btn.style.background = swatch.color;
    btn.addEventListener('click', () => {
      state.color = swatch.color;
      createSwatches();
      scheduleSave();
    });
    el.swatches.appendChild(btn);
  });
}

function normalizedPointFromEvent(ev) {
  const rect = el.canvas.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
  return { x, y };
}

function drawStroke(stroke) {
  if (!stroke?.points?.length) return;
  const width = el.canvas.width || 1;
  const height = el.canvas.height || 1;

  ctx.save();
  ctx.globalAlpha = stroke.tool === 'highlight' ? 0.24 : 1;
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.beginPath();
  stroke.points.forEach((point, index) => {
    const x = point.x * width;
    const y = point.y * height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

function redrawCanvas() {
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  if (!el.shot.complete || !el.shot.naturalWidth) return;
  state.strokes.forEach(drawStroke);
  if (strokeDraft) drawStroke(strokeDraft);
}

function resizeCanvas() {
  const rect = el.shot.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const nextWidth = Math.max(1, Math.round(rect.width));
  const nextHeight = Math.max(1, Math.round(rect.height));
  if (el.canvas.width === nextWidth && el.canvas.height === nextHeight) return;
  el.canvas.width = nextWidth;
  el.canvas.height = nextHeight;
  redrawCanvas();
  renderNotes();
}

function createNote(note) {
  const box = document.createElement('div');
  box.className = 'note-panel';
  box.dataset.id = note.id;
  box.style.left = `${note.x * 100}%`;
  box.style.top = `${note.y * 100}%`;

  const head = document.createElement('div');
  head.className = 'note-head';
  head.innerHTML = `<span>${note.id}</span><span>drag</span>`;

  const text = document.createElement('div');
  text.className = 'note-text';
  text.contentEditable = 'true';
  text.spellcheck = false;
  text.textContent = note.text || '';

  head.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const wrapRect = el.wrap.getBoundingClientRect();
    dragNote = note;
    dragOffset = {
      x: ev.clientX,
      y: ev.clientY,
      noteX: note.x,
      noteY: note.y,
      wrapRect,
      pointerId: ev.pointerId,
    };
    head.setPointerCapture(ev.pointerId);
  });

  text.addEventListener('input', () => {
    note.text = text.textContent || '';
    scheduleSave(true);
  });

  box.appendChild(head);
  box.appendChild(text);
  return box;
}

function renderNotes() {
  el.notesLayer.innerHTML = '';
  el.noteList.innerHTML = '';
  state.notes.forEach((note) => {
    const node = createNote(note);
    el.notesLayer.appendChild(node);

    const summary = document.createElement('div');
    summary.className = 'note-item';
    summary.innerHTML = `
      <div class="note-handle"><span>${note.id}</span><span>${Math.round(note.x * 100)}%, ${Math.round(note.y * 100)}%</span></div>
      <div class="note-body" contenteditable="true" spellcheck="false"></div>
    `;
    const body = summary.querySelector('.note-body');
    body.textContent = note.text || '';
    body.addEventListener('input', () => {
      note.text = body.textContent || '';
      const inlineBody = el.notesLayer.querySelector(`.note-panel[data-id="${CSS.escape(note.id)}"] .note-text`);
      if (inlineBody && inlineBody.textContent !== note.text) inlineBody.textContent = note.text;
      scheduleSave(true);
    });
    el.noteList.appendChild(summary);
  });
}

function addNoteAt(point, text = '') {
  const id = `N${String(noteCounter++).padStart(2, '0')}`;
  const note = { id, x: point.x, y: point.y, text };
  state.notes.push(note);
  renderNotes();
  scheduleSave(true);
  requestAnimationFrame(() => {
    const inline = el.notesLayer.querySelector(`.note-panel[data-id="${CSS.escape(id)}"] .note-text`);
    inline?.focus();
  });
}

function addCenterNote() {
  addNoteAt({ x: 0.5, y: 0.18 }, '');
}

function eraseLast() {
  if (state.strokes.length > 0) {
    state.strokes.pop();
  } else if (state.notes.length > 0) {
    state.notes.pop();
  }
  redrawCanvas();
  renderNotes();
  scheduleSave(true);
}

function clearAll() {
  state.strokes = [];
  state.notes = [];
  redrawCanvas();
  renderNotes();
  scheduleSave(true);
}

function downloadBlob(content, filename, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadJson() {
  const payload = {
    version: 1,
    source: state.source,
    createdAt: state.source.launchedAt,
    updatedAt: Date.now(),
    color: state.color,
    brushSize: state.brushSize,
    strokes: state.strokes,
    notes: state.notes,
  };
  downloadBlob(JSON.stringify(payload, null, 2), `nexus-annotator-${Date.now()}.json`, 'application/json');
}

function wrapTextLines(text, maxWidth, measureText) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (measureText(next).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function flattenToCanvas() {
  const w = el.shot.naturalWidth || el.canvas.width || 1280;
  const h = el.shot.naturalHeight || el.canvas.height || 900;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  octx.fillStyle = '#0a0f1a';
  octx.fillRect(0, 0, w, h);
  if (el.shot.src) {
    octx.drawImage(el.shot, 0, 0, w, h);
  }

  state.strokes.forEach((stroke) => {
    if (!stroke?.points?.length) return;
    octx.save();
    octx.globalAlpha = stroke.tool === 'highlight' ? 0.24 : 1;
    octx.strokeStyle = stroke.color;
    octx.lineWidth = Math.max(1, Math.round(stroke.width * (w / Math.max(1, el.canvas.width))));
    octx.lineCap = 'round';
    octx.lineJoin = 'round';
    octx.beginPath();
    stroke.points.forEach((point, index) => {
      const x = point.x * w;
      const y = point.y * h;
      if (index === 0) octx.moveTo(x, y);
      else octx.lineTo(x, y);
    });
    octx.stroke();
    octx.restore();
  });

  state.notes.forEach((note) => {
    const x = note.x * w;
    const y = note.y * h;
    const boxW = Math.min(Math.max(220, w * 0.22), 340);
    const boxH = Math.max(90, Math.ceil(String(note.text || '').split('\n').length * 22) + 26);
    const boxX = Math.min(Math.max(10, x + 18), Math.max(10, w - boxW - 10));
    const boxY = Math.min(Math.max(10, y - 10), Math.max(10, h - boxH - 10));

    octx.save();
    octx.fillStyle = 'rgba(255, 247, 202, 0.96)';
    octx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    octx.lineWidth = 2;
    roundRect(octx, boxX, boxY, boxW, boxH, 14);
    octx.fill();
    octx.stroke();
    octx.fillStyle = '#1e1b11';
    octx.font = '700 16px Inter, system-ui, sans-serif';
    octx.fillText(note.id, boxX + 14, boxY + 22);
    octx.font = '400 16px Inter, system-ui, sans-serif';
    const lines = String(note.text || '').split('\n').flatMap((line) => wrapTextLines(line, boxW - 28, (value) => octx.measureText(value)));
    let ty = boxY + 48;
    for (const line of lines.slice(0, 6)) {
      octx.fillText(line, boxX + 14, ty);
      ty += 20;
    }
    octx.restore();
  });

  return out;
}

function roundRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function downloadPng() {
  const merged = flattenToCanvas();
  merged.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, `nexus-annotated-${Date.now()}.png`, 'image/png');
  }, 'image/png');
}

async function copyJson() {
  const payload = {
    version: 1,
    source: state.source,
    createdAt: state.source.launchedAt,
    updatedAt: Date.now(),
    color: state.color,
    brushSize: state.brushSize,
    strokes: state.strokes,
    notes: state.notes,
  };
  await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
  setStatus('JSON skopírované do clipboardu');
}

async function copySummary() {
  const lines = [
    `Source: ${state.source.title || 'untitled'}`,
    `URL: ${state.source.url || '-'}`,
    `Notes: ${state.notes.length}`,
    `Strokes: ${state.strokes.length}`,
    '',
  ];
  state.notes.forEach((note, index) => {
    lines.push(`${index + 1}. ${note.id}: ${note.text || '(empty)'}`);
  });
  await navigator.clipboard.writeText(lines.join('\n'));
  setStatus('Summary skopírované do clipboardu');
}

function scheduleSave(immediate = false) {
  state.updatedAt = Date.now();
  if (saveTimer) clearTimeout(saveTimer);
  const run = async () => {
    const payload = {
      version: 1,
      source: state.source,
      color: state.color,
      brushSize: state.brushSize,
      strokes: state.strokes,
      notes: state.notes,
      updatedAt: state.updatedAt,
    };
    await chrome.storage.local.set({ [storageKey()]: payload });
    setStatus(`Autosaved ${new Date(state.updatedAt).toLocaleTimeString()}`);
  };
  saveTimer = setTimeout(run, immediate ? 10 : 400);
}

function pointerDown(ev) {
  if (state.tool === 'move') return;
  if (state.tool === 'note') {
    addNoteAt(normalizedPointFromEvent(ev));
    return;
  }
  ev.preventDefault();
  const pt = normalizedPointFromEvent(ev);
  strokeDraft = {
    tool: state.tool === 'highlight' ? 'highlight' : 'pen',
    color: state.tool === 'highlight' ? state.color : state.color,
    width: state.tool === 'highlight' ? Math.max(state.brushSize * 3, 12) : state.brushSize,
    points: [pt],
  };
  el.canvas.setPointerCapture(ev.pointerId);
  redrawCanvas();
}

function pointerMove(ev) {
  if (!strokeDraft) return;
  strokeDraft.points.push(normalizedPointFromEvent(ev));
  redrawCanvas();
}

function pointerUp(ev) {
  if (!strokeDraft) return;
  if (strokeDraft.points.length > 1) {
    state.strokes.push(strokeDraft);
    scheduleSave(true);
  }
  strokeDraft = null;
  redrawCanvas();
  try { el.canvas.releasePointerCapture(ev.pointerId); } catch {}
}

function installDragSupport() {
  window.addEventListener('pointermove', (ev) => {
    if (!dragNote || !dragOffset) return;
    const rect = el.wrap.getBoundingClientRect();
    const nx = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const ny = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
    dragNote.x = nx;
    dragNote.y = ny;
    const noteEl = el.notesLayer.querySelector(`.note-panel[data-id="${CSS.escape(dragNote.id)}"]`);
    if (noteEl) {
      noteEl.style.left = `${dragNote.x * 100}%`;
      noteEl.style.top = `${dragNote.y * 100}%`;
    }
    const item = el.noteList.querySelectorAll('.note-item')[state.notes.indexOf(dragNote)];
    if (item) item.querySelector('.note-handle span:last-child').textContent = `${Math.round(nx * 100)}%, ${Math.round(ny * 100)}%`;
    scheduleSave();
  });

  window.addEventListener('pointerup', () => {
    dragNote = null;
    dragOffset = null;
  });
}

async function captureScreenshot() {
  setStatus('Snímam aktuálny viewport...');
  try {
    const windowId = state.source.windowId ?? undefined;
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    state.screenshotUrl = dataUrl;
    el.shot.src = dataUrl;
    await new Promise((resolve) => {
      el.shot.onload = resolve;
      if (el.shot.complete) resolve();
    });
    resizeCanvas();
    setStatus('Screenshot pripravený');
  } catch (err) {
    console.warn('captureVisibleTab failed', err);
    state.screenshotUrl = '';
    el.shot.removeAttribute('src');
    setStatus('Screenshot sa nepodarilo zachytiť, annotator beží bez pozadia');
    resizeCanvas();
  }
}

async function loadSavedState() {
  const saved = await chrome.storage.local.get([storageKey()]);
  const data = saved[storageKey()];
  if (!data) return;
  if (Array.isArray(data.strokes)) state.strokes = data.strokes;
  if (Array.isArray(data.notes)) state.notes = data.notes;
  if (data.color) state.color = data.color;
  if (Number.isFinite(data.brushSize)) state.brushSize = data.brushSize;
  noteCounter = Math.max(1, ...state.notes.map((note) => Number(String(note.id).replace(/\D/g, '')) || 0)) + 1;
  setBrushSize(state.brushSize);
}

function bindUi() {
  el.toolButtons.move.addEventListener('click', () => setActiveTool('move'));
  el.toolButtons.pen.addEventListener('click', () => setActiveTool('pen'));
  el.toolButtons.highlight.addEventListener('click', () => setActiveTool('highlight'));
  el.toolButtons.note.addEventListener('click', () => setActiveTool('note'));

  el.sizeRange.addEventListener('input', () => {
    setBrushSize(el.sizeRange.value);
    scheduleSave();
  });

  el.btnUndo.addEventListener('click', () => eraseLast());
  el.btnClear.addEventListener('click', () => clearAll());
  el.btnCapture.addEventListener('click', () => captureScreenshot());
  el.btnDownloadPng.addEventListener('click', () => downloadPng());
  el.btnDownloadJson.addEventListener('click', () => downloadJson());
  el.btnCopyJson.addEventListener('click', () => copyJson());
  el.btnCopySummary.addEventListener('click', () => copySummary());
  el.btnAddNote.addEventListener('click', () => addCenterNote());
  el.btnEraseLast.addEventListener('click', () => eraseLast());

  el.canvas.addEventListener('pointerdown', pointerDown);
  el.canvas.addEventListener('pointermove', pointerMove);
  el.canvas.addEventListener('pointerup', pointerUp);
  el.canvas.addEventListener('pointercancel', pointerUp);
  window.addEventListener('resize', () => requestAnimationFrame(resizeCanvas));
  el.shot.addEventListener('load', () => requestAnimationFrame(resizeCanvas));
}

async function boot() {
  syncSourceLabels();
  createSwatches();
  setBrushSize(state.brushSize);
  setActiveTool('pen');
  bindUi();
  installDragSupport();
  await loadSavedState();
  syncSourceLabels();
  createSwatches();
  renderNotes();
  redrawCanvas();
  await captureScreenshot();
  scheduleSave(true);
}

boot().catch((err) => {
  console.error(err);
  setStatus(`Annotator error: ${err?.message || err}`);
});
