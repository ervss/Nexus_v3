// scan-hud.js — Nexus Video Card Selector Live Scan HUD & Disk Cache Manager
(() => {
  'use strict';

  // Chráňme pred viacnásobnou inicializáciou
  if (window.__nvsHudInitialized) return;
  window.__nvsHudInitialized = true;

  let pill = null;
  let panel = null;
  let isOpen = false;
  try {
    isOpen = localStorage.getItem('nvs-hud-open') === '1';
  } catch { }
  let pollInterval = null;

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  }

  // ───────────────────────── Tag filter (sxyprn) ─────────────────────────
  const isSxyprn = /(^|\.)sxyprn\.(?:net|com)$/i.test(location.hostname);
  const TAG_KEY = 'nvs-tag-filter-v1';
  const tagState = { include: new Set(), exclude: new Set(), mode: 'or', sort: 'count', query: '', sig: '' };
  const cardTags = new WeakMap();
  try {
    const saved = JSON.parse(localStorage.getItem(TAG_KEY) || '{}');
    tagState.include = new Set(saved.include || []);
    tagState.exclude = new Set(saved.exclude || []);
    if (saved.mode === 'and') tagState.mode = 'and';
  } catch { }

  // Trvalé (globálne) dáta: blacklist, obľúbené ★, presety, importované URL
  const EXT_KEY = 'nvs-tag-ext-v1';
  const ext = { blacklist: new Set(), favorites: new Set(), presets: {}, imported: new Set(), hideImported: false, byScore: false };
  try {
    const s = JSON.parse(localStorage.getItem(EXT_KEY) || '{}');
    ext.blacklist = new Set(s.blacklist || []);
    ext.favorites = new Set(s.favorites || []);
    ext.presets = s.presets || {};
    ext.imported = new Set((s.imported || []).slice(-5000));
    ext.hideImported = !!s.hideImported;
  } catch { }
  function saveExt() {
    try {
      localStorage.setItem(EXT_KEY, JSON.stringify({
        blacklist: [...ext.blacklist], favorites: [...ext.favorites], presets: ext.presets,
        imported: [...ext.imported].slice(-5000), hideImported: ext.hideImported
      }));
    } catch { }
  }

  // API pre content.js: tagy karty pri importe + označenie importovaných
  window.__nvsCardTags = (card) => [...extractCardTags(card).values()];
  window.__nvsMarkImported = (urls) => {
    for (const u of urls || []) if (u) ext.imported.add(u);
    saveExt();
    refreshTags(true);
  };

  function saveTagState() {
    try {
      localStorage.setItem(TAG_KEY, JSON.stringify({
        include: [...tagState.include], exclude: [...tagState.exclude], mode: tagState.mode
      }));
    } catch { }
  }

  function getTagCards() {
    return [...document.querySelectorAll('.post_el_small')];
  }

  // Vráti Map(kľúč lowercase -> zobrazované meno) pre kartu
  function extractCardTags(card) {
    let tags = cardTags.get(card);
    if (tags && tags.__len === (card.textContent || '').length) return tags;
    tags = new Map();
    const add = (raw) => {
      const name = String(raw || '').replace(/^#/, '').trim();
      if (name.length < 2 || name.length > 40 || !/^[\p{L}\p{N}_\-]+$/u.test(name)) return;
      const key = name.toLowerCase();
      if (!tags.has(key)) tags.set(key, name);
    };
    card.querySelectorAll('a').forEach((a) => {
      const t = (a.textContent || '').trim();
      if (/^#[^\s#]+$/.test(t)) add(t);
    });
    const text = card.textContent || '';
    for (const m of text.matchAll(/#([\p{L}\p{N}_\-]{2,40})/gu)) add(m[1]);
    tags.__len = text.length;
    cardTags.set(card, tags);
    return tags;
  }

  function cardKey(card) {
    return card.dataset?.nvsUrl || card.querySelector('a[href*="/post/"]')?.getAttribute('href')?.split('?')[0] || '';
  }

  function cardMatches(card) {
    const tags = extractCardTags(card);
    for (const bl of ext.blacklist) if (tags.has(bl)) return false;
    if (ext.hideImported && ext.imported.has(cardKey(card))) return false;
    if (!tagState.include.size && !tagState.exclude.size) return true;
    for (const ex of tagState.exclude) if (tags.has(ex)) return false;
    if (!tagState.include.size) return true;
    if (tagState.mode === 'and') {
      for (const inc of tagState.include) if (!tags.has(inc)) return false;
      return true;
    }
    for (const inc of tagState.include) if (tags.has(inc)) return true;
    return false;
  }

  function applyTagFilter() {
    const active = tagState.include.size > 0 || tagState.exclude.size > 0 || ext.blacklist.size > 0 || ext.hideImported;
    let shown = 0;
    const cards = getTagCards();
    for (const card of cards) {
      const ok = !active || cardMatches(card);
      card.classList.toggle('nvs-tag-hidden', !ok);
      if (ok) shown++;
      const tags = extractCardTags(card);
      let score = 0;
      for (const f of ext.favorites) if (tags.has(f)) score++;
      card.dataset.nvsScore = String(score);
      card.classList.toggle('nvs-fav-card', score > 0);
      card.classList.toggle('nvs-imported-card', ext.imported.has(cardKey(card)));
    }
    const cnt = panel?.querySelector('#nvs-tag-count');
    if (cnt) cnt.textContent = active ? `${shown}/${cards.length} kariet` : `${cards.length} kariet`;
    return shown;
  }

  function renderTagChips() {
    const box = panel?.querySelector('#nvs-tag-chips');
    if (!box) return;
    const counts = new Map();
    const names = new Map();
    for (const card of getTagCards()) {
      for (const [k, n] of extractCardTags(card)) {
        counts.set(k, (counts.get(k) || 0) + 1);
        names.set(k, n);
      }
    }
    // vybrané tagy zobraz vždy, aj keď už na stránke nie sú
    for (const k of [...tagState.include, ...tagState.exclude, ...ext.blacklist, ...ext.favorites]) if (!counts.has(k)) { counts.set(k, 0); names.set(k, k); }

    const q = tagState.query.toLowerCase();
    let list = [...counts.keys()].filter((k) => !q || k.includes(q));
    list.sort((a, b) => {
      const sa = tagState.include.has(a) || tagState.exclude.has(a) ? 1 : 0;
      const sb = tagState.include.has(b) || tagState.exclude.has(b) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      if (tagState.sort === 'alpha') return a.localeCompare(b);
      return (counts.get(b) - counts.get(a)) || a.localeCompare(b);
    });
    list = list.slice(0, 150);

    box.textContent = '';
    for (const k of list) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'nvs-tag-chip';
      if (tagState.include.has(k)) chip.classList.add('nvs-tag-inc');
      if (tagState.exclude.has(k)) chip.classList.add('nvs-tag-exc');
      if (ext.favorites.has(k)) chip.classList.add('nvs-tag-fav');
      if (ext.blacklist.has(k)) chip.classList.add('nvs-tag-bl');
      chip.dataset.tag = k;
      chip.textContent = `${ext.blacklist.has(k) ? '🚫 ' : ''}${ext.favorites.has(k) ? '★ ' : ''}${tagState.exclude.has(k) ? '⊘ ' : ''}#${names.get(k)} ${counts.get(k)}`;
      box.appendChild(chip);
    }
    if (!list.length) box.textContent = 'Žiadne tagy.';
  }

  function refreshTags(force) {
    if (!isSxyprn || !panel) return;
    const cards = getTagCards();
    const section = panel.querySelector('#nvs-tag-section');
    if (section) section.style.display = cards.length ? '' : 'none';
    const sig = `${cards.length}|${cards[cards.length - 1]?.textContent?.length || 0}|${tagState.query}|${tagState.sort}`;
    if (!force && sig === tagState.sig) {
      // nové karty (lazy load) musia podliehať filtru
      if (tagState.include.size || tagState.exclude.size || ext.blacklist.size || ext.hideImported) applyTagFilter();
      return;
    }
    tagState.sig = sig;
    renderTagChips();
    applyTagFilter();
  }

  function toggleTag(key, exclude) {
    const from = exclude ? tagState.exclude : tagState.include;
    const other = exclude ? tagState.include : tagState.exclude;
    other.delete(key);
    if (from.has(key)) from.delete(key); else from.add(key);
    saveTagState();
    refreshTags(true);
  }

  function initTagUi() {
    if (!isSxyprn) return;
    const section = panel.querySelector('#nvs-tag-section');
    const chips = panel.querySelector('#nvs-tag-chips');
    chips.addEventListener('click', (e) => {
      const c = e.target.closest('.nvs-tag-chip');
      if (!c) return;
      const k = c.dataset.tag;
      if (e.ctrlKey || e.metaKey) {
        if (ext.blacklist.has(k)) ext.blacklist.delete(k); else { ext.blacklist.add(k); tagState.include.delete(k); }
        saveExt(); saveTagState(); refreshTags(true);
      } else if (e.altKey) {
        if (ext.favorites.has(k)) ext.favorites.delete(k); else ext.favorites.add(k);
        saveExt(); refreshTags(true);
      } else toggleTag(k, false);
    });
    chips.addEventListener('contextmenu', (e) => {
      const c = e.target.closest('.nvs-tag-chip');
      if (!c) return;
      e.preventDefault();
      toggleTag(c.dataset.tag, true);
    });
    panel.querySelector('#nvs-tag-search').addEventListener('input', (e) => {
      tagState.query = e.target.value.trim();
      refreshTags(true);
    });
    panel.querySelectorAll('.nvs-tag-mode').forEach((b) => {
      b.classList.toggle('nvs-tag-mode-on', b.dataset.mode === tagState.mode);
      b.addEventListener('click', () => {
        tagState.mode = b.dataset.mode;
        panel.querySelectorAll('.nvs-tag-mode').forEach((x) => x.classList.toggle('nvs-tag-mode-on', x === b));
        saveTagState();
        refreshTags(true);
      });
    });
    const sortBtn = panel.querySelector('#nvs-tag-sort');
    sortBtn.addEventListener('click', () => {
      tagState.sort = tagState.sort === 'count' ? 'alpha' : 'count';
      sortBtn.textContent = tagState.sort === 'count' ? '↓ počet' : 'A–Z';
      refreshTags(true);
    });
    panel.querySelector('#nvs-tag-clear').addEventListener('click', () => {
      tagState.include.clear();
      tagState.exclude.clear();
      saveTagState();
      refreshTags(true);
    });
    panel.querySelector('#nvs-tag-import').addEventListener('click', () => {
      const visible = getTagCards().filter((c) => !c.classList.contains('nvs-tag-hidden') && !c.classList.contains('nvs-hidden'));
      if (!visible.length) { alert('Žiadne karty nezodpovedajú filtru.'); return; }
      if (typeof window.__nvsImportCards === 'function') window.__nvsImportCards(visible);
      else alert('Import nie je k dispozícii.');
    });
    section.style.display = 'none';

    // Označiť / zrušiť výber
    panel.querySelector('#nvs-tag-selall').addEventListener('click', () => doSelectMatching());
    panel.querySelector('#nvs-tag-selnone').addEventListener('click', () => {
      if (typeof window.__nvsSelectCards === 'function') window.__nvsSelectCards([], true);
    });

    // Presety
    const presetSel = panel.querySelector('#nvs-tag-preset');
    const renderPresets = () => {
      presetSel.textContent = '';
      presetSel.add(new Option('— Uložené filtre —', ''));
      for (const name of Object.keys(ext.presets)) presetSel.add(new Option(name, name));
    };
    renderPresets();
    presetSel.addEventListener('change', () => {
      const p = ext.presets[presetSel.value];
      if (!p) return;
      tagState.include = new Set(p.include || []);
      tagState.exclude = new Set(p.exclude || []);
      tagState.mode = p.mode === 'and' ? 'and' : 'or';
      panel.querySelectorAll('.nvs-tag-mode').forEach((x) => x.classList.toggle('nvs-tag-mode-on', x.dataset.mode === tagState.mode));
      saveTagState();
      refreshTags(true);
    });
    panel.querySelector('#nvs-preset-save').addEventListener('click', () => {
      const name = (prompt('Názov filtra:') || '').trim();
      if (!name) return;
      ext.presets[name] = { include: [...tagState.include], exclude: [...tagState.exclude], mode: tagState.mode };
      saveExt(); renderPresets(); presetSel.value = name;
    });
    panel.querySelector('#nvs-preset-del').addEventListener('click', () => {
      if (!presetSel.value || !confirm(`Zmazať filter „${presetSel.value}"?`)) return;
      delete ext.presets[presetSel.value];
      saveExt(); renderPresets();
    });

    // Skóre (★) – zoradenie kariet
    panel.querySelector('#nvs-tag-score').addEventListener('click', (e) => {
      const cards = getTagCards();
      if (!cards.length) return;
      ext.byScore = !ext.byScore;
      cards.forEach((c, i) => { if (c.dataset.nvsOrig === undefined) c.dataset.nvsOrig = String(i); });
      const sorted = [...cards].sort((a, b) => ext.byScore
        ? (Number(b.dataset.nvsScore || 0) - Number(a.dataset.nvsScore || 0)) || (Number(a.dataset.nvsOrig) - Number(b.dataset.nvsOrig))
        : Number(a.dataset.nvsOrig) - Number(b.dataset.nvsOrig));
      const parent = cards[0].parentElement;
      const anchor = cards[cards.length - 1].nextSibling;
      for (const c of sorted) if (c.parentElement === parent) parent.insertBefore(c, anchor);
      e.currentTarget.classList.toggle('nvs-tag-mode-on', ext.byScore);
    });

    // Skryť importované
    const hideImp = panel.querySelector('#nvs-hide-imported');
    hideImp.checked = ext.hideImported;
    hideImp.addEventListener('change', () => { ext.hideImported = hideImp.checked; saveExt(); refreshTags(true); });

    // Načítať ďalšie strany
    const moreBtn = panel.querySelector('#nvs-more-load');
    moreBtn.addEventListener('click', async () => {
      if (typeof window.__nvsLoadMoreSxyprn !== 'function') { alert('Načítanie strán nie je k dispozícii.'); return; }
      const n = parseInt(panel.querySelector('#nvs-more-count').value, 10) || 1;
      const orig = moreBtn.textContent;
      moreBtn.disabled = true;
      try {
        await window.__nvsLoadMoreSxyprn(n, (i, total) => { moreBtn.textContent = `Načítavam ${i}/${total}…`; });
      } finally {
        moreBtn.disabled = false;
        moreBtn.textContent = orig;
        refreshTags(true);
      }
    });

    // Klávesové skratky (mimo inputov)
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === 't') togglePanel();
      else if (k === 'a' && isOpen) doSelectMatching();
      else if (k === 'c' && isOpen) panel.querySelector('#nvs-tag-clear').click();
    });
    refreshTags(true);
  }

  function doSelectMatching() {
    const cards = getTagCards().filter((c) => !c.classList.contains('nvs-tag-hidden') && !c.classList.contains('nvs-hidden'));
    if (!cards.length) { alert('Žiadne karty nezodpovedajú filtru.'); return; }
    if (typeof window.__nvsSelectCards === 'function') {
      const n = window.__nvsSelectCards(cards, true);
      const cnt = panel?.querySelector('#nvs-tag-count');
      if (cnt) cnt.textContent = `označených ${n}`;
    }
  }

  function createHudElements() {
    if (pill) return;

    // Plávajúci pill (spodok vľavo)
    pill = document.createElement('div');
    pill.id = 'nvs-scan-hud-pill';
    pill.innerHTML = `
      <span class="nvs-hud-pulse"></span>
      <span class="nvs-hud-pill-text">NVS: Pripravený</span>
    `;
    pill.title = 'Kliknutím otvoríte podrobný Scan HUD a správu diskovej cache';
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });

    // Panel
    panel = document.createElement('div');
    panel.id = 'nvs-scan-hud-panel';
    if (isOpen) {
      panel.classList.add('nvs-hud-open');
    }
    panel.innerHTML = `
      <div class="nvs-hud-header">
        <span>⚡ Nexus Scan HUD</span>
        <button type="button" class="nvs-hud-close" title="Zavrieť">✕</button>
      </div>
      <div class="nvs-hud-body">
        <div class="nvs-hud-stats-grid">
          <div class="nvs-hud-stat-box">
            <div class="nvs-hud-stat-val" id="nvs-hud-stat-total">0</div>
            <div class="nvs-hud-stat-lbl">Kariet</div>
          </div>
          <div class="nvs-hud-stat-box">
            <div class="nvs-hud-stat-val" style="color:#38bdf8;" id="nvs-hud-stat-verified">0</div>
            <div class="nvs-hud-stat-lbl">Fetchnutých</div>
          </div>
          <div class="nvs-hud-stat-box">
            <div class="nvs-hud-stat-val" style="color:#4ade80;" id="nvs-hud-stat-complete">0</div>
            <div class="nvs-hud-stat-lbl">Kompletných</div>
          </div>
        </div>

        <div class="nvs-hud-fields-grid">
          <div class="nvs-hud-field-box" title="Počet kariet s načítanou veľkosťou súboru">
            <div class="nvs-hud-field-val" id="nvs-hud-f-size">0/0</div>
            <div class="nvs-hud-field-lbl">💾 Veľkosť</div>
          </div>
          <div class="nvs-hud-field-box" title="Počet kariet s dĺžkou videa">
            <div class="nvs-hud-field-val" id="nvs-hud-f-dur">0/0</div>
            <div class="nvs-hud-field-lbl">⏱ Dĺžka</div>
          </div>
          <div class="nvs-hud-field-box" title="Počet kariet s kvalitou (rozlíšením)">
            <div class="nvs-hud-field-val" id="nvs-hud-f-qual">0/0</div>
            <div class="nvs-hud-field-lbl">🎞 Kvalita</div>
          </div>
          <div class="nvs-hud-field-box" title="Počet kariet s dátumom nahrania">
            <div class="nvs-hud-field-val" id="nvs-hud-f-date">0/0</div>
            <div class="nvs-hud-field-lbl">📅 Dátum</div>
          </div>
        </div>

        <div class="nvs-hud-cache-row">
          <span id="nvs-hud-cache-info">Z cache: 0</span>
          <span id="nvs-hud-missing-info" style="color:#f87171;">Chýba údaj: 0</span>
        </div>

        <div class="nvs-hud-current">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
            <span style="font-weight:700;color:#94a3b8;" id="nvs-hud-status-label">Stav: Nečinný</span>
            <span style="color:#a78bfa;font-weight:700;" id="nvs-hud-progress-text">0/0</span>
          </div>
          <div class="nvs-hud-progress-bg">
            <div class="nvs-hud-progress-bar" id="nvs-hud-progress-bar"></div>
          </div>
          <div class="nvs-hud-current-title" id="nvs-hud-curr-title" style="margin-top:6px;" title="">—</div>
        </div>

        <div class="nvs-tag-section" id="nvs-tag-section" style="display:none;">
          <div class="nvs-tag-head">
            <span>🏷 Filter podľa tagov</span>
            <span class="nvs-tag-count" id="nvs-tag-count"></span>
          </div>
          <input type="text" class="nvs-tag-search" id="nvs-tag-search" placeholder="Hľadať tag…" />
          <div class="nvs-tag-modes">
            <button type="button" class="nvs-hud-btn nvs-tag-mode nvs-tag-mode-on" data-mode="or" title="Karta musí mať aspoň jeden z vybraných tagov">ĽUB. (OR)</button>
            <button type="button" class="nvs-hud-btn nvs-tag-mode" data-mode="and" title="Karta musí mať všetky vybrané tagy">VŠETKY (AND)</button>
            <button type="button" class="nvs-hud-btn nvs-tag-sort" id="nvs-tag-sort" title="Zoradenie tagov">↓ počet</button>
          </div>
          <div class="nvs-tag-chips" id="nvs-tag-chips"></div>
          <div class="nvs-tag-hint">Klik = zahrnúť · pravý klik = vylúčiť · Alt+klik = ★ obľúbený · Ctrl+klik = 🚫 blacklist (trvalo) · skratky: T panel, A označiť zhody, C zrušiť filter</div>
          <div class="nvs-tag-modes">
            <select class="nvs-tag-search" id="nvs-tag-preset" style="flex:1;" title="Uložené filtre"><option value="">— Uložené filtre —</option></select>
            <button type="button" class="nvs-hud-btn" id="nvs-preset-save" title="Uložiť aktuálny filter">💾</button>
            <button type="button" class="nvs-hud-btn" id="nvs-preset-del" title="Zmazať vybraný filter">🗑</button>
          </div>
          <div class="nvs-tag-modes">
            <button type="button" class="nvs-hud-btn" id="nvs-tag-score" title="Zoradiť karty podľa počtu ★ obľúbených tagov">★ Zoradiť podľa skóre</button>
            <label class="nvs-tag-check"><input type="checkbox" id="nvs-hide-imported" /> skryť importované</label>
          </div>
          <div class="nvs-tag-modes">
            <select class="nvs-tag-search" id="nvs-more-count" title="Koľko ďalších strán načítať"><option>1</option><option>2</option><option selected>3</option><option>5</option><option>10</option></select>
            <button type="button" class="nvs-hud-btn" id="nvs-more-load" style="flex:3;" title="Načíta ďalšie strany pod aktuálne">＋ Načítať ďalšie strany</button>
          </div>
          <div class="nvs-tag-actions">
            <button type="button" class="nvs-hud-btn" id="nvs-tag-selall" title="Označí len karty, ktoré prešli filtrom">☑ Označiť zhody</button>
            <button type="button" class="nvs-hud-btn" id="nvs-tag-selnone" title="Zruší celý výber">☐ Zrušiť výber</button>
          </div>
          <div class="nvs-tag-actions">
            <button type="button" class="nvs-hud-btn" id="nvs-tag-clear">✕ Zrušiť filter</button>
            <button type="button" class="nvs-hud-btn" id="nvs-tag-import" style="background:#7c3aed;color:#fff;font-weight:700;">⚡ Importovať zhody</button>
          </div>
        </div>

        <div class="nvs-hud-actions">
          <button type="button" class="nvs-hud-btn" id="nvs-hud-btn-retry" title="Doplniť neoverené alebo chýbajúce karty">⚡ Doplniť chýbajúce</button>
          <button type="button" class="nvs-hud-btn" id="nvs-hud-btn-rescan" title="Znovu zoskenovať všetky karty na stránke">🔄 Prescanovať</button>
          <button type="button" class="nvs-hud-btn" id="nvs-hud-btn-import-selected" style="background:#7c3aed;color:#ffffff;font-weight:700;" title="Importovať označené videá do Nexusu (port 8000)">⚡ Import označené</button>
          <button type="button" class="nvs-hud-btn" id="nvs-hud-btn-import-all" style="background:#2563eb;color:#ffffff;font-weight:700;" title="Importovať všetky zobrazené videá do Nexusu (port 8000)">📦 Import všetky</button>
          <button type="button" class="nvs-hud-btn" id="nvs-hud-btn-export" title="Exportovať zobrazené / vybrané videá do JSON súboru">📤 Export JSON</button>
          <button type="button" class="nvs-hud-btn" id="nvs-hud-btn-cache-stats" title="Zistiť veľkosť a počet kariet v diskovej cache">💾 Disk Cache</button>
          <button type="button" class="nvs-hud-btn nvs-hud-btn-danger" id="nvs-hud-btn-stop" title="Zastaviť aktuálne bežiace skenovanie">⏹ Zastaviť</button>
          <button type="button" class="nvs-hud-btn" id="nvs-hud-btn-clear" style="color:#f87171;" title="Vymazať diskovú cache pre túto doménu">🗑 Vymazať cache</button>
        </div>

        <div>
          <div style="font-size:10.5px;color:#94a3b8;font-weight:600;margin-bottom:4px;">Záznam udalostí (Live Log):</div>
          <div class="nvs-hud-logs" id="nvs-hud-logs-container">
            <div class="nvs-hud-log-line" style="color:#64748b;">Čakám na udalosti…</div>
          </div>
        </div>
      </div>
    `;

    // Listenery
    panel.querySelector('.nvs-hud-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closePanel();
    });

    panel.querySelector('#nvs-hud-btn-retry').addEventListener('click', () => {
      if (window.__nvsRetryMissing) window.__nvsRetryMissing();
    });

    panel.querySelector('#nvs-hud-btn-rescan').addEventListener('click', () => {
      if (window.__nvsRescan) window.__nvsRescan();
      else if (window.__nvsScan) window.__nvsScan();
    });

    panel.querySelector('#nvs-hud-btn-import-selected')?.addEventListener('click', () => {
      if (typeof window.__nvsImportSelected === 'function') {
        window.__nvsImportSelected();
      } else {
        alert('Import označených nie je k dispozícii.');
      }
    });

    panel.querySelector('#nvs-hud-btn-import-all')?.addEventListener('click', () => {
      if (typeof window.__nvsImportAll === 'function') {
        window.__nvsImportAll();
      } else {
        alert('Import všetkých nie je k dispozícii.');
      }
    });

    panel.querySelector('#nvs-hud-btn-stop').addEventListener('click', () => {
      if (window.__nvsStopScan) window.__nvsStopScan();
    });

    panel.querySelector('#nvs-hud-btn-cache-stats').addEventListener('click', async () => {
      const host = location.hostname.replace(/^www\./, '');
      try {
        const res = await chrome.runtime.sendMessage({ type: 'CACHE_ADMIN', action: 'stats', host });
        if (res?.ok) {
          alert(`💾 Disk Cache (${host}):\n\nPočet uložených videí: ${res.count}\nVeľkosť na disku: ${formatBytes(res.bytes)}\nNajstarší záznam: ${res.oldest ? new Date(res.oldest).toLocaleString('sk-SK') : '—'}\nNajnovší záznam: ${res.newest ? new Date(res.newest).toLocaleString('sk-SK') : '—'}`);
        } else {
          alert('Nepodarilo sa načítať štatistiky cache: ' + (res?.error || 'neznáma chyba'));
        }
      } catch (err) {
        alert('Chyba: ' + String(err));
      }
    });

    panel.querySelector('#nvs-hud-btn-export').addEventListener('click', () => {
      if (typeof window.__nvsDoExportJson === 'function') {
        window.__nvsDoExportJson();
      } else {
        const cards = document.querySelectorAll('.post_el_small, [data-nvs-processed], article, .post');
        alert(`Export: nenašla sa funkcia exportu pre ${cards.length} kariet.`);
      }
    });

    panel.querySelector('#nvs-hud-btn-clear').addEventListener('click', async () => {
      const host = location.hostname.replace(/^www\./, '');
      if (!confirm(`Naozaj chcete vymazať celú diskovú cache pre doménu ${host}?`)) return;
      try {
        const res = await chrome.runtime.sendMessage({ type: 'CACHE_ADMIN', action: 'clear', host });
        if (res?.ok) {
          alert(`Vymazaných ${res.removed} záznamov z disku.`);
          if (window.__nvsRescan) window.__nvsRescan();
        } else {
          alert('Chyba pri mazaní cache: ' + (res?.error || 'neznáma'));
        }
      } catch (err) {
        alert('Chyba: ' + String(err));
      }
    });

    initTagUi();

    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.addEventListener('mousedown', (e) => e.stopPropagation());

    document.body.appendChild(pill);
    document.body.appendChild(panel);
  }

  function togglePanel() {
    if (isOpen) closePanel();
    else openPanel();
  }

  function openPanel() {
    if (!panel) return;
    isOpen = true;
    try { localStorage.setItem('nvs-hud-open', '1'); } catch { }
    panel.classList.add('nvs-hud-open');
    const nuss = document.getElementById('nuss-quick-selection');
    if (nuss) nuss.style.setProperty('left', '416px', 'important');
    updateHudUi();
  }

  function closePanel() {
    if (!panel) return;
    isOpen = false;
    try { localStorage.setItem('nvs-hud-open', '0'); } catch { }
    panel.classList.remove('nvs-hud-open');
    const nuss = document.getElementById('nuss-quick-selection');
    if (nuss) nuss.style.removeProperty('left');
  }

  function updateHudUi() {
    if (!pill) return;
    try { refreshTags(false); } catch { }
    const state = window.__nvsState;
    if (!state) return;

    const nuss = document.getElementById('nuss-quick-selection');
    if (nuss) {
      if (isOpen || panel?.classList.contains('nvs-hud-open')) {
        if (nuss.style.left !== '416px') nuss.style.setProperty('left', '416px', 'important');
        if (nuss.style.bottom !== '86px') nuss.style.setProperty('bottom', '86px', 'important');
        nuss.style.setProperty('z-index', '2147483647', 'important');
      } else if (nuss.style.left === '416px') {
        nuss.style.removeProperty('left');
      }
    }

    let cards = [...document.querySelectorAll('[data-nvs-processed="1"]')];
    if (!cards.length) {
      cards = [...document.querySelectorAll('.post_el_small, article, .post')];
    }
    const totalCards = cards.length;
    let fetchedCount = 0;
    let completeCount = 0;
    let sizeCount = 0;
    let durCount = 0;
    let qualCount = 0;
    let dateCount = 0;
    let cacheCount = 0;

    for (const c of cards) {
      const u = c.dataset?.nvsUrl;
      const meta = state.cardMeta?.get(c) || (u ? state.fetchCache?.get(u) : null);
      const cov = typeof window.__nvsGetCardCoverage === 'function'
        ? window.__nvsGetCardCoverage(c, meta)
        : {
            fetched: Boolean(meta && !meta.failureReason),
            hasSize: Boolean(meta?.sizeMb || meta?.sizeText),
            hasDuration: Boolean(meta?.duration),
            hasQuality: Boolean(meta?.quality),
            hasDate: Boolean(meta?.date || meta?.relDate),
            complete: Boolean((meta?.sizeMb || meta?.sizeText) && meta?.duration && meta?.quality && (meta?.date || meta?.relDate)),
            fromCache: Boolean(meta?._cacheHit),
          };
      if (cov.fetched) fetchedCount++;
      if (cov.hasSize) sizeCount++;
      if (cov.hasDuration) durCount++;
      if (cov.hasQuality) qualCount++;
      if (cov.hasDate) dateCount++;
      if (cov.complete) completeCount++;
      if (cov.fromCache) cacheCount++;
    }
    const incompleteCount = Math.max(0, totalCards - completeCount);

    const run = state.scanRun || {};
    const isBusy = Boolean(state.activeFetches > 0 || state.queue?.length > 0 || run.active);

    pill.classList.toggle('nvs-hud-pill-busy', isBusy);
    const pillText = pill.querySelector('.nvs-hud-pill-text');

    const curr = state.currentScan;
    if (isBusy) {
      const done = run.done || 0;
      const total = run.total || (done + (state.queue?.length || 0));
      const prog = total > 0 ? `${done}/${total}` : `${state.activeFetches} aktívne`;
      if (pillText) {
        if (curr?.title) {
          const shortTitle = curr.title.length > 25 ? curr.title.slice(0, 22) + '…' : curr.title;
          pillText.textContent = `Scanujem ${prog}: ${shortTitle}`;
        } else {
          pillText.textContent = `Scanujem (${prog})`;
        }
      }
    } else {
      if (pillText) {
        pillText.textContent = incompleteCount > 0 && totalCards > 0
          ? `NVS: ${fetchedCount}/${totalCards} • ${incompleteCount} neúpl.`
          : `NVS: ${fetchedCount}/${totalCards} komplet`;
      }
    }

    // Panel dáta aktualizujeme vždy, aby pri otvorení nikdy nezostal v stave 0 0 0
    if (!panel) return;

    panel.querySelector('#nvs-hud-stat-total').textContent = String(totalCards);
    panel.querySelector('#nvs-hud-stat-verified').textContent = String(fetchedCount);
    const completeEl = panel.querySelector('#nvs-hud-stat-complete');
    if (completeEl) completeEl.textContent = String(completeCount);

    const setFieldStat = (id, count) => {
      const el = panel.querySelector(id);
      if (!el) return;
      el.textContent = `${count}/${totalCards}`;
      el.style.color = totalCards > 0 && count === totalCards
        ? '#4ade80'
        : (count > 0 ? '#fbbf24' : '#f87171');
    };
    setFieldStat('#nvs-hud-f-size', sizeCount);
    setFieldStat('#nvs-hud-f-dur', durCount);
    setFieldStat('#nvs-hud-f-qual', qualCount);
    setFieldStat('#nvs-hud-f-date', dateCount);

    const cacheInfoEl = panel.querySelector('#nvs-hud-cache-info');
    if (cacheInfoEl) cacheInfoEl.textContent = `Z cache: ${cacheCount} • Sieť: ${Math.max(0, fetchedCount - cacheCount)}`;
    const missInfoEl = panel.querySelector('#nvs-hud-missing-info');
    if (missInfoEl) {
      missInfoEl.textContent = incompleteCount > 0 ? `Chýba údaj: ${incompleteCount}` : 'Všetko kompletné ✓';
      missInfoEl.style.color = incompleteCount > 0 ? '#fbbf24' : '#4ade80';
    }
    const retryBtn = panel.querySelector('#nvs-hud-btn-retry');
    if (retryBtn && !retryBtn.disabled) {
      retryBtn.textContent = incompleteCount > 0 ? `⚡ Doplniť chýbajúce (${incompleteCount})` : '✓ Všetko kompletné';
    }

    const statusLbl = panel.querySelector('#nvs-hud-status-label');
    const progText = panel.querySelector('#nvs-hud-progress-text');
    const progBar = panel.querySelector('#nvs-hud-progress-bar');
    const currTitle = panel.querySelector('#nvs-hud-curr-title');

    if (isBusy) {
      const done = run.done || 0;
      const total = Math.max(1, run.total || (done + (state.queue?.length || 0)));
      const pct = Math.min(100, Math.round((done / total) * 100));
      statusLbl.textContent = run.label || 'Skenujem karty…';
      progText.textContent = `${done}/${total} (${pct}%)`;
      progBar.style.width = `${pct}%`;
      if (curr?.title) {
        currTitle.textContent = `Aktuálne: ${curr.title}`;
        currTitle.title = curr.title;
      } else {
        currTitle.textContent = 'Aktuálne: Spracovávam…';
      }
    } else {
      statusLbl.textContent = run.label || 'Pripravený';
      progText.textContent = `${completeCount}/${totalCards}`;
      progBar.style.width = totalCards > 0 ? `${Math.round((completeCount / totalCards) * 100)}%` : '0%';
      currTitle.textContent = 'Nebeží žiadna úloha';
      currTitle.title = '';
    }

    // Renderovanie logov
    const logsContainer = panel.querySelector('#nvs-hud-logs-container');
    const logs = state.statusLog || [];
    if (logs.length > 0) {
      logsContainer.innerHTML = '';
      const recent = logs.slice(-12);
      for (const log of recent) {
        const line = document.createElement('div');
        line.className = 'nvs-hud-log-line';
        if (log.type === 'error') line.classList.add('nvs-hud-log-error');
        else if (log.type === 'done') line.classList.add('nvs-hud-log-done');
        else if (log.type === 'info') line.classList.add('nvs-hud-log-info');
        const time = new Date(log.ts).toLocaleTimeString('sk-SK');
        line.textContent = `[${time}] ${log.message}`;
        logsContainer.appendChild(line);
      }
      logsContainer.scrollTop = logsContainer.scrollHeight;
    }
  }

  // Inicializácia pri načítaní dokumentu
  function initHud() {
    createHudElements();
    updateHudUi();
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(updateHudUi, 400);
  }

  window.__nvsUpdateHud = updateHudUi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHud);
  } else {
    initHud();
  }
})();
