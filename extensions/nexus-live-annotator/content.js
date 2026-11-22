(() => {
  if (globalThis.__NEXUS_LIVE_ANNOTATOR__) return;

  const COLORS = ["#ff4f9a", "#ffd24a", "#5ce1e6", "#a78bfa", "#52e39b", "#ffffff"];
  const state = {
    active: false,
    loaded: false,
    tool: "select",
    color: COLORS[0],
    size: 5,
    brief: "",
    actions: [],
    draft: null,
    hoverRect: null,
    noteCounter: 1,
    saving: false,
    crop: null,
  };

  const ui = {};
  const host = document.createElement("div");
  host.id = "nexus-live-annotator-host";
  host.style.cssText = [
    "all:initial",
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "pointer-events:none",
  ].join(";");
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .nla-root {
        --ink: #eef3ff;
        --muted: #9ca7bc;
        --panel: rgba(11, 15, 25, .95);
        --panel-2: rgba(22, 28, 43, .96);
        --line: rgba(151, 168, 205, .25);
        --accent: #ff4f9a;
        display: none;
        position: fixed;
        inset: 0;
        color: var(--ink);
        font: 500 13px/1.35 "Segoe UI", Inter, system-ui, sans-serif;
        pointer-events: none;
      }
      .nla-root.active { display: block; }
      .nla-canvas {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        z-index: 1;
        cursor: crosshair;
        touch-action: none;
        pointer-events: auto;
      }
      .nla-root.selecting .nla-canvas { pointer-events: none; }
      .nla-labels {
        position: fixed;
        inset: 0;
        z-index: 2;
        overflow: hidden;
        pointer-events: none;
      }
      .nla-note {
        position: absolute;
        width: min(290px, 34vw);
        padding: 10px 12px 11px 43px;
        border: 1px solid color-mix(in srgb, var(--note-color) 75%, white 25%);
        border-radius: 12px;
        color: #fff;
        background: rgba(8, 11, 18, .93);
        box-shadow: 0 12px 32px rgba(0, 0, 0, .42);
        transform: translate(15px, -15px);
        overflow-wrap: anywhere;
      }
      .nla-note b {
        position: absolute;
        left: 10px;
        top: 9px;
        display: grid;
        width: 24px;
        height: 24px;
        place-items: center;
        border-radius: 50%;
        color: #10131d;
        background: var(--note-color);
        font: 800 11px/1 "Segoe UI", sans-serif;
      }
      .nla-note small {
        display: block;
        margin-top: 4px;
        color: #9eabc3;
        font: 600 10px/1.25 ui-monospace, "Cascadia Code", monospace;
      }
      .nla-toolbar {
        position: fixed;
        top: 14px;
        left: 50%;
        z-index: 4;
        display: grid;
        grid-template-columns: auto minmax(240px, 380px) auto;
        gap: 10px;
        width: min(1180px, calc(100vw - 28px));
        padding: 10px;
        border: 1px solid var(--line);
        border-radius: 16px;
        background: var(--panel);
        box-shadow: 0 18px 60px rgba(0, 0, 0, .48);
        backdrop-filter: blur(18px);
        transform: translateX(-50%);
        pointer-events: auto;
      }
      .nla-tools, .nla-actions, .nla-style {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .nla-tools { flex-wrap: wrap; }
      .nla-actions { justify-content: flex-end; }
      .nla-btn {
        appearance: none;
        min-height: 34px;
        padding: 7px 10px;
        border: 1px solid rgba(168, 182, 214, .22);
        border-radius: 9px;
        color: #dce5f7;
        background: #171d2b;
        font: 700 12px/1 "Segoe UI", system-ui, sans-serif;
        cursor: pointer;
      }
      .nla-btn:hover { border-color: rgba(255, 255, 255, .5); background: #20283a; }
      .nla-btn.active {
        border-color: color-mix(in srgb, var(--accent) 75%, white 25%);
        color: #fff;
        background: color-mix(in srgb, var(--accent) 23%, #171d2b 77%);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 38%, transparent);
      }
      .nla-btn.primary {
        min-width: 184px;
        border-color: #ff4f9a;
        color: #fff;
        background: linear-gradient(135deg, #ff4f9a, #a855f7);
      }
      .nla-btn.danger { color: #ff9ab6; }
      .nla-brief-wrap {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: center;
      }
      .nla-brief {
        width: 100%;
        height: 38px;
        padding: 9px 11px;
        resize: none;
        border: 1px solid rgba(168, 182, 214, .25);
        border-radius: 10px;
        outline: none;
        color: #f7f9ff;
        background: #0e131f;
        font: 600 12px/1.4 "Segoe UI", system-ui, sans-serif;
      }
      .nla-brief:focus { border-color: #ff4f9a; box-shadow: 0 0 0 3px rgba(255, 79, 154, .16); }
      .nla-color {
        width: 34px;
        height: 34px;
        padding: 2px;
        border: 1px solid rgba(168, 182, 214, .28);
        border-radius: 9px;
        background: #171d2b;
        cursor: pointer;
      }
      .nla-size { width: 74px; accent-color: #ff4f9a; }
      .nla-hover {
        display: none;
        position: fixed;
        z-index: 3;
        border: 2px solid var(--accent);
        border-radius: 8px;
        background: color-mix(in srgb, var(--accent) 11%, transparent);
        box-shadow: 0 0 0 1px rgba(0, 0, 0, .5), 0 0 24px color-mix(in srgb, var(--accent) 25%, transparent);
        pointer-events: none;
      }
      .nla-root.selecting .nla-hover.visible { display: block; }
      .nla-card {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 3;
        width: min(380px, calc(100vw - 36px));
        max-height: 46vh;
        overflow: hidden;
        border: 1px solid rgba(255, 79, 154, .45);
        border-radius: 15px;
        color: #eef3ff;
        background: linear-gradient(155deg, rgba(13, 17, 28, .96), rgba(28, 18, 39, .96));
        box-shadow: 0 18px 54px rgba(0, 0, 0, .46);
        pointer-events: none;
      }
      .nla-card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 13px;
        border-bottom: 1px solid rgba(255,255,255,.1);
        color: #ff78b4;
        font: 800 11px/1 ui-monospace, "Cascadia Code", monospace;
        letter-spacing: .11em;
        text-transform: uppercase;
      }
      .nla-card-body { padding: 11px 13px 13px; }
      .nla-card-brief {
        margin: 0 0 9px;
        color: #fff;
        font: 700 14px/1.38 "Segoe UI", system-ui, sans-serif;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .nla-card-url {
        overflow: hidden;
        color: #94a0b7;
        font: 600 10px/1.35 ui-monospace, "Cascadia Code", monospace;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .nla-card-list {
        display: grid;
        gap: 5px;
        max-height: 25vh;
        margin-top: 9px;
        overflow: hidden;
      }
      .nla-card-item {
        display: grid;
        grid-template-columns: 24px minmax(0, 1fr);
        gap: 7px;
        color: #cdd7ea;
        font-size: 11px;
      }
      .nla-card-item b {
        display: grid;
        width: 21px;
        height: 21px;
        place-items: center;
        border-radius: 50%;
        color: #12151e;
        background: var(--item-color);
        font-size: 10px;
      }
      .nla-status {
        position: fixed;
        left: 50%;
        bottom: 22px;
        z-index: 5;
        max-width: min(680px, calc(100vw - 40px));
        padding: 11px 15px;
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 12px;
        color: #fff;
        background: rgba(7, 10, 17, .94);
        box-shadow: 0 14px 42px rgba(0,0,0,.5);
        opacity: 0;
        transform: translate(-50%, 12px);
        transition: opacity .18s ease, transform .18s ease;
        pointer-events: none;
      }
      .nla-status.visible { opacity: 1; transform: translate(-50%, 0); }
      .nla-root.capture .nla-toolbar,
      .nla-root.capture .nla-hover,
      .nla-root.capture .nla-status { display: none !important; }
      @media (max-width: 900px) {
        .nla-toolbar { grid-template-columns: 1fr; }
        .nla-actions { justify-content: flex-start; flex-wrap: wrap; }
        .nla-card { max-height: 35vh; }
      }
      @media (prefers-reduced-motion: reduce) {
        .nla-status { transition: none; }
      }
    </style>
    <div class="nla-root">
      <canvas class="nla-canvas"></canvas>
      <div class="nla-labels"></div>
      <div class="nla-hover"></div>

      <div class="nla-toolbar">
        <div>
          <div class="nla-tools">
            <button class="nla-btn active" data-tool="select" title="Select a page element">◎ Prvok</button>
            <button class="nla-btn" data-tool="pen">✎ Pero</button>
            <button class="nla-btn" data-tool="highlight">▰ Zvýrazniť</button>
            <button class="nla-btn" data-tool="arrow">➜ Šípka</button>
            <button class="nla-btn" data-tool="rect">□ Rámik</button>
            <button class="nla-btn" data-tool="crop">✂ Výrez</button>
            <button class="nla-btn" data-tool="note">● Poznámka</button>
          </div>
          <div class="nla-style">
            <input class="nla-color" type="color" value="#ff4f9a" aria-label="Farba">
            <input class="nla-size" type="range" min="2" max="18" value="5" aria-label="Hrúbka">
            <button class="nla-btn" data-action="undo">↶ Späť</button>
            <button class="nla-btn danger" data-action="clear">Vymazať</button>
          </div>
        </div>

        <div class="nla-brief-wrap">
          <textarea class="nla-brief" placeholder="Čo treba zmeniť? Tento text sa objaví priamo na screenshote."></textarea>
        </div>

        <div class="nla-actions">
          <button class="nla-btn primary" data-action="save">Uložiť + kopírovať pre ChatGPT</button>
          <button class="nla-btn primary" data-action="crop-save" disabled>Kopírovať výrez</button>
          <button class="nla-btn" data-action="close">Zavrieť</button>
        </div>
      </div>

      <section class="nla-card">
        <div class="nla-card-head">
          <span>Nexus annotation</span>
          <span class="nla-card-count">0 značiek</span>
        </div>
        <div class="nla-card-body">
          <p class="nla-card-brief">Klikni na prvok alebo začni kresliť.</p>
          <div class="nla-card-url"></div>
          <div class="nla-card-list"></div>
        </div>
      </section>

      <div class="nla-status"></div>
    </div>
  `;

  ui.root = shadow.querySelector(".nla-root");
  ui.canvas = shadow.querySelector(".nla-canvas");
  ui.labels = shadow.querySelector(".nla-labels");
  ui.hover = shadow.querySelector(".nla-hover");
  ui.brief = shadow.querySelector(".nla-brief");
  ui.color = shadow.querySelector(".nla-color");
  ui.size = shadow.querySelector(".nla-size");
  ui.cardBrief = shadow.querySelector(".nla-card-brief");
  ui.cardUrl = shadow.querySelector(".nla-card-url");
  ui.cardList = shadow.querySelector(".nla-card-list");
  ui.cardCount = shadow.querySelector(".nla-card-count");
  ui.status = shadow.querySelector(".nla-status");
  ui.ctx = ui.canvas.getContext("2d");

  document.documentElement.appendChild(host);

  function storageKey() {
    return `nexus-live-annotator:${location.href}`;
  }

  function normalizedPoint(event) {
    return {
      x: Math.max(0, Math.min(1, event.clientX / Math.max(1, window.innerWidth))),
      y: Math.max(0, Math.min(1, event.clientY / Math.max(1, window.innerHeight))),
    };
  }

  function denormalize(point) {
    return {
      x: point.x * window.innerWidth,
      y: point.y * window.innerHeight,
    };
  }

  function rectToNormalized(rect) {
    return {
      x: rect.left / Math.max(1, window.innerWidth),
      y: rect.top / Math.max(1, window.innerHeight),
      width: rect.width / Math.max(1, window.innerWidth),
      height: rect.height / Math.max(1, window.innerHeight),
    };
  }

  function schedulePersist() {
    clearTimeout(schedulePersist.timer);
    schedulePersist.timer = setTimeout(() => {
      chrome.storage.local.set({
        [storageKey()]: {
          version: 1,
          brief: state.brief,
          color: state.color,
          size: state.size,
          actions: state.actions,
          noteCounter: state.noteCounter,
          updatedAt: new Date().toISOString(),
        },
      });
    }, 180);
  }

  async function loadPersisted() {
    if (state.loaded) return;
    state.loaded = true;
    const saved = (await chrome.storage.local.get(storageKey()))[storageKey()];
    if (!saved) return;
    state.brief = saved.brief || "";
    state.color = saved.color || state.color;
    state.size = Number(saved.size || state.size);
    state.actions = Array.isArray(saved.actions) ? saved.actions : [];
    state.noteCounter = Number(saved.noteCounter || 1);
    ui.brief.value = state.brief;
    ui.color.value = state.color;
    ui.size.value = String(state.size);
  }

  function showStatus(message, duration = 5200) {
    ui.status.textContent = message;
    ui.status.classList.add("visible");
    clearTimeout(showStatus.timer);
    showStatus.timer = setTimeout(() => ui.status.classList.remove("visible"), duration);
  }

  function selectorFor(element) {
    if (!(element instanceof Element)) return "";
    if (element.id) return `#${CSS.escape(element.id)}`;
    const testId = element.getAttribute("data-testid");
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    const parts = [];
    let current = element;
    for (let depth = 0; current && depth < 4; depth += 1) {
      let part = current.localName || "div";
      const className = [...current.classList]
        .filter((name) => /^[a-zA-Z][\w-]{1,40}$/.test(name))
        .slice(0, 2)
        .map((name) => `.${CSS.escape(name)}`)
        .join("");
      part += className;
      if (current.parentElement) {
        const siblings = [...current.parentElement.children].filter(
          (node) => node.localName === current.localName,
        );
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function compactText(element) {
    return String(
      element?.getAttribute?.("aria-label")
      || element?.getAttribute?.("title")
      || element?.innerText
      || element?.textContent
      || element?.localName
      || "element",
    ).replace(/\s+/g, " ").trim().slice(0, 180);
  }

  function noteText(fallback) {
    return state.brief.trim() || fallback;
  }

  function nextNoteId() {
    const id = state.noteCounter;
    state.noteCounter += 1;
    return id;
  }

  function setTool(tool) {
    state.tool = tool;
    ui.root.classList.toggle("selecting", tool === "select");
    shadow.querySelectorAll("[data-tool]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tool === tool);
    });
    ui.canvas.style.cursor = tool === "note" ? "copy" : "crosshair";
    ui.hover.classList.remove("visible");
  }

  function resizeCanvas() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    ui.canvas.width = Math.round(window.innerWidth * dpr);
    ui.canvas.height = Math.round(window.innerHeight * dpr);
    ui.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function drawPath(context, action) {
    if (!action.points?.length) return;
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = action.color;
    context.lineWidth = action.size;
    context.globalAlpha = action.type === "highlight" ? 0.28 : 1;
    context.beginPath();
    action.points.forEach((point, index) => {
      const pixel = denormalize(point);
      if (index === 0) context.moveTo(pixel.x, pixel.y);
      else context.lineTo(pixel.x, pixel.y);
    });
    context.stroke();
    context.restore();
  }

  function drawRect(context, action) {
    const start = denormalize(action.start);
    const end = denormalize(action.end);
    context.save();
    context.strokeStyle = action.color;
    context.lineWidth = action.size;
    context.setLineDash([10, 6]);
    context.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
    context.restore();
  }

  function drawArrow(context, action) {
    const start = denormalize(action.start);
    const end = denormalize(action.end);
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const head = Math.max(14, action.size * 3.5);
    context.save();
    context.strokeStyle = action.color;
    context.fillStyle = action.color;
    context.lineWidth = action.size;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
    context.beginPath();
    context.moveTo(end.x, end.y);
    context.lineTo(end.x - head * Math.cos(angle - Math.PI / 6), end.y - head * Math.sin(angle - Math.PI / 6));
    context.lineTo(end.x - head * Math.cos(angle + Math.PI / 6), end.y - head * Math.sin(angle + Math.PI / 6));
    context.closePath();
    context.fill();
    context.restore();
  }

  function drawSelection(context, action) {
    const rect = action.rect;
    context.save();
    context.strokeStyle = action.color;
    context.fillStyle = `${action.color}1f`;
    context.lineWidth = 3;
    context.setLineDash([12, 7]);
    const x = rect.x * window.innerWidth;
    const y = rect.y * window.innerHeight;
    const width = rect.width * window.innerWidth;
    const height = rect.height * window.innerHeight;
    context.fillRect(x, y, width, height);
    context.strokeRect(x, y, width, height);
    context.restore();
  }

  function renderLabels() {
    ui.labels.textContent = "";
    const notes = state.actions.filter((action) => action.type === "note" || action.type === "select");
    notes.forEach((action) => {
      const point = action.point || {
        x: action.rect.x + Math.min(action.rect.width, 0.03),
        y: action.rect.y + Math.min(action.rect.height, 0.03),
      };
      const pixel = denormalize(point);
      const note = document.createElement("div");
      note.className = "nla-note";
      note.style.left = `${Math.max(8, Math.min(window.innerWidth - 315, pixel.x))}px`;
      note.style.top = `${Math.max(8, Math.min(window.innerHeight - 110, pixel.y))}px`;
      note.style.setProperty("--note-color", action.color);
      const number = document.createElement("b");
      number.textContent = String(action.id);
      const text = document.createElement("span");
      text.textContent = action.text;
      note.append(number, text);
      if (action.selector) {
        const selector = document.createElement("small");
        selector.textContent = action.selector;
        note.appendChild(selector);
      }
      ui.labels.appendChild(note);
    });
  }

  function renderCard() {
    const notes = state.actions.filter((action) => action.type === "note" || action.type === "select");
    ui.cardBrief.textContent = state.brief.trim() || "Klikni na prvok alebo začni kresliť.";
    ui.cardUrl.textContent = `${document.title} · ${location.href}`;
    ui.cardCount.textContent = `${state.actions.length} značiek`;
    ui.cardList.textContent = "";
    notes.slice(0, 6).forEach((action) => {
      const row = document.createElement("div");
      row.className = "nla-card-item";
      row.style.setProperty("--item-color", action.color);
      const number = document.createElement("b");
      number.textContent = String(action.id);
      const text = document.createElement("span");
      text.textContent = action.text;
      row.append(number, text);
      ui.cardList.appendChild(row);
    });
  }

  function redraw() {
    ui.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const all = state.draft ? [...state.actions, state.draft] : state.actions;
    all.forEach((action) => {
      if (action.type === "pen" || action.type === "highlight") drawPath(ui.ctx, action);
      else if (action.type === "rect" || action.type === "crop") drawRect(ui.ctx, action);
      else if (action.type === "arrow") drawArrow(ui.ctx, action);
      else if (action.type === "select") drawSelection(ui.ctx, action);
    });
    renderLabels();
    renderCard();
    if (state.crop && !ui.root.classList.contains("capture")) drawRect(ui.ctx, state.crop);
    shadow.querySelector('[data-action="crop-save"]').disabled = !state.crop || state.saving;
  }

  function addNote(point) {
    state.actions.push({
      type: "note",
      id: nextNoteId(),
      point,
      text: noteText("Poznámka"),
      color: state.color,
    });
    redraw();
    schedulePersist();
  }

  function onPointerDown(event) {
    if (!state.active || state.saving || state.tool === "select") return;
    if (event.button !== 0) return;
    event.preventDefault();
    if (state.tool === "note") {
      addNote(normalizedPoint(event));
      return;
    }
    const point = normalizedPoint(event);
    state.draft = state.tool === "pen" || state.tool === "highlight"
      ? {
          type: state.tool,
          color: state.color,
          size: state.tool === "highlight" ? state.size * 4 : state.size,
          points: [point],
        }
      : {
          type: state.tool,
          color: state.color,
          size: state.size,
          start: point,
          end: point,
        };
    ui.canvas.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    if (!state.draft) return;
    const point = normalizedPoint(event);
    if (state.draft.points) state.draft.points.push(point);
    else state.draft.end = point;
    redraw();
  }

  function onPointerUp(event) {
    if (!state.draft) return;
    const action = state.draft;
    state.draft = null;
    const valid = action.points ? action.points.length > 1 : true;
    if (action.type === "crop") {
      const a = denormalize(action.start), b = denormalize(action.end);
      if (Math.abs(a.x - b.x) >= 20 && Math.abs(a.y - b.y) >= 20) {
        state.crop = action;
        showStatus("Výrez je vybraný. Pridaj poznámku a klikni Kopírovať výrez.");
      } else showStatus("Vyber oblasť veľkú aspoň 20 × 20 pixelov.");
    } else if (valid) state.actions.push(action);
    try {
      ui.canvas.releasePointerCapture(event.pointerId);
    } catch {}
    redraw();
    schedulePersist();
  }

  function eventTargetsUi(event) {
    return event.composedPath().includes(host);
  }

  function targetAt(x, y) {
    const target = document.elementFromPoint(x, y);
    if (!target || target === host || host.contains(target)) return null;
    return target;
  }

  function onSelectHover(event) {
    if (!state.active || state.tool !== "select" || eventTargetsUi(event)) return;
    const target = targetAt(event.clientX, event.clientY);
    if (!target) {
      ui.hover.classList.remove("visible");
      return;
    }
    const rect = target.getBoundingClientRect();
    ui.hover.style.left = `${rect.left}px`;
    ui.hover.style.top = `${rect.top}px`;
    ui.hover.style.width = `${rect.width}px`;
    ui.hover.style.height = `${rect.height}px`;
    ui.hover.classList.add("visible");
  }

  function onSelectClick(event) {
    if (!state.active || state.tool !== "select" || eventTargetsUi(event)) return;
    const target = targetAt(event.clientX, event.clientY);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = target.getBoundingClientRect();
    state.actions.push({
      type: "select",
      id: nextNoteId(),
      rect: rectToNormalized(rect),
      point: normalizedPoint(event),
      text: noteText(`Upraviť: ${compactText(target)}`),
      selector: selectorFor(target),
      elementText: compactText(target),
      color: state.color,
    });
    ui.hover.classList.remove("visible");
    redraw();
    schedulePersist();
  }

  function undo() {
    state.actions.pop();
    redraw();
    schedulePersist();
  }

  function clearAll() {
    state.crop = null;
    state.actions = [];
    state.noteCounter = 1;
    redraw();
    schedulePersist();
  }

  function metadata() {
    return {
      version: 1,
      title: document.title,
      url: location.href,
      host: location.host,
      capturedAt: new Date().toISOString(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
      brief: state.brief,
      actions: state.actions,
    };
  }

  function nextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  async function saveForChatGPT(cropOnly = false) {
    if (state.saving || (cropOnly && !state.crop)) return;
    state.saving = true;
    showStatus("Pripravujem anotovaný screenshot…", 10000);
    try {
      ui.root.classList.add("capture");
      if (cropOnly) shadow.querySelector(".nla-card").style.visibility = "hidden";
      redraw();
      await nextPaint();
      const capture = await chrome.runtime.sendMessage({ type: "NLA_CAPTURE_VISIBLE" });
      ui.root.classList.remove("capture");
      if (!capture?.ok || !capture.dataUrl) {
        throw new Error(capture?.error || "Screenshot capture failed");
      }

      const exportMetadata = metadata();
      let dataUrl = capture.dataUrl;
      if (cropOnly) {
        exportMetadata.crop = state.crop;
        dataUrl = await globalThis.NexusAnnotationExport.compose(dataUrl, state.crop, exportMetadata);
      }
      const saved = await chrome.runtime.sendMessage({
        type: "NLA_SAVE_ANNOTATION",
        dataUrl,
        metadata: exportMetadata,
      });
      if (!saved?.ok) throw new Error(saved?.error || "Save failed");

      if (saved.copied) {
        showStatus(
          "Uložené. Nový PNG je overene v schránke → ChatGPT → Ctrl+V → Enter.",
          12000,
        );
      } else if (saved.manualCopyOpened) {
        showStatus(
          "PNG a JSON sú uložené. Chrome zablokoval tiché kopírovanie — v otvorenom okne klikni „Skopírovať nový PNG“.",
          16000,
        );
      } else {
        showStatus(
          `PNG a JSON sú uložené. Kopírovanie zlyhalo: ${saved.copyError || "unknown error"}`,
          12000,
        );
      }
    } catch (error) {
      ui.root.classList.remove("capture");
      showStatus(`Anotáciu sa nepodarilo uložiť: ${error?.message || error}`, 12000);
    } finally {
      shadow.querySelector(".nla-card").style.visibility = "";
      state.saving = false;
      redraw();
    }
  }

  async function open() {
    await loadPersisted();
    state.active = true;
    ui.root.classList.add("active");
    setTool(state.tool);
    resizeCanvas();
    redraw();
    showStatus("Annotation mode je zapnutý. Esc ho zavrie.");
  }

  function close() {
    state.active = false;
    state.draft = null;
    ui.root.classList.remove("active", "capture");
    ui.hover.classList.remove("visible");
  }

  async function toggle() {
    if (state.active) close();
    else await open();
  }

  shadow.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => setTool(button.dataset.tool));
  });

  shadow.querySelector('[data-action="undo"]').addEventListener("click", undo);
  shadow.querySelector('[data-action="clear"]').addEventListener("click", clearAll);
  shadow.querySelector('[data-action="save"]').addEventListener("click", () => saveForChatGPT(false));
  shadow.querySelector('[data-action="crop-save"]').addEventListener("click", () => saveForChatGPT(true));
  shadow.querySelector('[data-action="close"]').addEventListener("click", close);

  ui.brief.addEventListener("input", () => {
    state.brief = ui.brief.value;
    renderCard();
    schedulePersist();
  });
  ui.color.addEventListener("input", () => {
    state.color = ui.color.value;
    ui.root.style.setProperty("--accent", state.color);
    schedulePersist();
  });
  ui.size.addEventListener("input", () => {
    state.size = Number(ui.size.value || 5);
    schedulePersist();
  });

  ui.canvas.addEventListener("pointerdown", onPointerDown);
  ui.canvas.addEventListener("pointermove", onPointerMove);
  ui.canvas.addEventListener("pointerup", onPointerUp);
  ui.canvas.addEventListener("pointercancel", onPointerUp);
  document.addEventListener("mousemove", onSelectHover, true);
  document.addEventListener("click", onSelectClick, true);
  window.addEventListener("resize", resizeCanvas);

  document.addEventListener("keydown", (event) => {
    // Only chrome.commands may handle the shortcut: a page keydown does not
    // grant activeTab, and handling both paths can toggle the overlay twice.
    if (!state.active || eventTargetsUi(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
    }
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "NLA_TOGGLE") return undefined;
    (async () => {
      try {
        await toggle();
        sendResponse({ ok: true, active: state.active });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  });

  globalThis.__NEXUS_LIVE_ANNOTATOR__ = {
    open,
    close,
    toggle,
    getState: () => ({
      active: state.active,
      tool: state.tool,
      brief: state.brief,
      actions: state.actions,
    }),
  };
})();
