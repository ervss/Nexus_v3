/* Shared import controls. Site adapters own detection, metadata and transport. */
(function () {
  'use strict';
  const defaults = () => ({ keyword: '', tagFilter: '', qualities: [], durationMin: '', durationMax: '', sizeMin: '', sizeMax: '', dateMin: '', dateMax: '', unknown: false, hideUnfiltered: true, hideUnselected: false, hideRejected: false, onlyVideos: false, sort: 'order', direction: 'asc' });
  function matches(row, f) {
    for (const key of ['duration','size','date']) {
      const min = f[key+'Min'], max = f[key+'Max'];
      if (min && max && (key === 'date' ? min > max : Number(min) > Number(max))) return false;
    }
    // Erome albums may be photo-only; rows without a video count (other sites) are unaffected.
    if (f.onlyVideos && row.videos !== undefined && !(row.videos > 0)) return false;
    if (!String(row.title || '').toLocaleLowerCase().includes(f.keyword.trim().toLocaleLowerCase())) return false;
    const tagTerms = String(f.tagFilter || '').split(',').map(term => term.trim().toLowerCase().replace(/[\s_]+/g, '-')).filter(Boolean);
    if (tagTerms.length && !tagTerms.every(term => (row.tags || []).some(tag => String(tag).toLowerCase().includes(term)))) return false;
    if (f.qualities.length && !(row.quality > 0 ? f.qualities.includes(String(row.quality)) : f.unknown)) return false;
    for (const [key, min, max, scale] of [['duration', f.durationMin, f.durationMax, 60], ['size', f.sizeMin, f.sizeMax, 1], ['date', f.dateMin, f.dateMax, 1]]) {
      if (!min && !max) continue;
      if (!(row[key] > 0)) { if (!f.unknown) return false; continue; }
      const low = key === 'date' ? new Date(`${min}T00:00:00`).getTime() : Number(min) * scale;
      const high = key === 'date' ? new Date(`${max}T23:59:59.999`).getTime() : Number(max) * scale;
      if (min && row[key] < low || max && row[key] > high) return false;
    }
    return true;
  }
  function compare(a, b, f) {
    if (f.sort === 'order') return a.order - b.order;
    const av = a[f.sort], bv = b[f.sort];
    const missingA = f.sort === 'title' ? !av : !(av > 0);
    const missingB = f.sort === 'title' ? !bv : !(bv > 0);
    if (missingA !== missingB) return missingA ? 1 : -1;
    const diff = f.sort === 'title' ? String(av || '').localeCompare(String(bv || ''), undefined, { numeric: true, sensitivity: 'base' }) : (av || 0) - (bv || 0);
    return (f.direction === 'desc' ? -diff : diff) || a.order - b.order;
  }
  window.NVSWorkbenchModel = { defaults, matches, compare };
  window.createNVSImportWorkbench = function (api) {
    const pimpbunny = ['pimpbunny', 'fnxtube'].includes(api.site);
    const erome = api.site === 'erome';
    const showTags = pimpbunny || api.site === 'xhamster' || api.site === 'xvideos' || api.site === 'spankbang';
    const panelOpenClass = pimpbunny || erome ? 'nvs-pb-panel-open' : 'nvs-xh-panel-open';
    let panel, launcher, refreshTimer, f = defaults(), loading = false, stopLoading = false;
    let result = '', tone = '';
    const hasNext = () => api.hasNext?.() ?? true;
    // Reset keeps the user's explicit "only videos" request (hash or saved choice).
    const baseFilters = () => ({ ...defaults(), onlyVideos: !!api.onlyVideos?.() });
    const cards = () => api.rows().filter(r => r.card.isConnected);
    const unique = rows => [...new Map(rows.map(r => [r.url, r])).values()];
    const range = (key, title, type = 'number') => `<label>${title}<span class="nvs-wb-range"><input data-filter="${key}Min" type="${type}" ${type === 'number' ? 'min="0" step="any"' : ''} aria-label="${title} od" placeholder="Od"><input data-filter="${key}Max" type="${type}" ${type === 'number' ? 'min="0" step="any"' : ''} aria-label="${title} do" placeholder="Do"></span></label>`;
    function mount() {
      panel = document.createElement('section');
      panel.id = 'nvs-sort-panel'; panel.className = 'nvs-workbench'; panel.setAttribute('aria-label', 'Nexus import panel');
      panel.dataset.site = api.site || 'xhamster';
      panel.innerHTML = `<header><div><strong>NEXUS <span>Import workspace</span></strong><small>Vyber, skontroluj a importuj načítané karty.</small></div><button data-action="collapse" aria-label="Zbaliť import panel">− Zbaliť</button></header>
        <div class="nvs-wb-body"><div class="nvs-wb-summary" data-part="summary"></div>
        <div class="nvs-wb-search"><label>Hľadať v názve<input data-filter="keyword" type="search" placeholder="Keyword v názve…"></label><label>Radiť podľa<select data-filter="sort" aria-label="Radiť podľa"><option value="order">Pôvodné poradie</option><option value="quality">Kvalita</option><option value="duration">Dĺžka</option><option value="size">Veľkosť</option><option value="date">Dátum</option><option value="title">Názov</option></select></label><label>Smer<select data-filter="direction" aria-label="Smer"><option value="asc">Vzostupne ↑</option><option value="desc">Zostupne ↓</option></select></label><button type="button" data-action="sort">Zoradiť</button></div>
        <details open><summary>Filtre <span data-part="filter-count"></span></summary><div class="nvs-wb-qualities" role="group" aria-label="Kvalita">${[2160,1440,1080,720,480,360].map(q => `<label><input type="checkbox" data-quality="${q}">${q === 2160 ? '4K' : q + 'p'}</label>`).join('')}</div><div class="nvs-wb-ranges">${range('duration','Dĺžka (min)')}${range('size','Veľkosť (MB)')}${range('date','Dátum publikovania','date')}</div><label class="nvs-wb-toggle"><input data-filter="unknown" type="checkbox">Ponechať aj karty s neznámymi metadátami</label></details>
        <div class="nvs-wb-view"><label><input data-filter="hideRejected" type="checkbox">Skryť nevybrané / nevyhovujúce</label><label class="nvs-wb-columns">Karty vedľa seba<select data-part="columns" aria-label="Počet kariet vedľa seba"><option value="4">4</option><option value="5">5</option><option value="6">6</option><option value="7">7</option><option value="8">8</option></select></label><label><input data-part="autoload" type="checkbox" checked>Ďalšie strany pripájať pod seba</label><label><input data-filter="hideUnfiltered" type="checkbox" checked>Skryť nevyhovujúce</label><label><input data-filter="hideUnselected" type="checkbox">Skryť nevybrané</label><button data-action="reset">Reset filtrov</button></div><small data-part="filter-hint" role="status"></small>
        <div class="nvs-wb-actions"><button data-action="select">Vybrať vyhovujúce</button><button data-action="invert">Invertovať vyhovujúce</button><button data-action="clear">Zrušiť výber</button></div>
        <details><summary>Načítanie a metadáta</summary><div class="nvs-wb-actions nvs-wb-load"><label>Ďalšie bloky / strany<input data-part="load-count" type="number" min="1" max="50" value="1"></label><button data-action="load">+ Načítať ďalšie</button><button data-action="stop" hidden>Zastaviť načítanie</button></div><div class="nvs-wb-actions"><button data-action="missing">Doplniť chýbajúce</button><button data-action="fetch-selected">Obnoviť vybrané</button><button data-action="rescan">Znovu nájsť karty</button></div><small>Chýbajúce = kvalita, dĺžka, veľkosť alebo dátum. Zamknuté karty sa preskočia.</small><div data-part="progress" role="status" aria-live="polite"></div><progress data-part="meter" max="1" value="0"></progress></details>
        <footer><div class="nvs-wb-search"><label>Názov batchu<input id="nvs-batch-name" placeholder="Voliteľný názov…" maxlength="200"></label><label>Nexus port<select data-part="port" aria-label="Nexus port"><option>8000</option><option>8001</option><option>8002</option></select></label><button data-action="copy">Kopírovať vybrané URL</button></div><div class="nvs-wb-actions"><button data-action="import-selected" class="nvs-wb-primary"></button><button data-action="import-filtered"></button><button data-action="import-all"></button></div><small data-part="selection-note"></small><div data-part="result" role="status" aria-live="polite"></div></footer></div>`;
      document.body.appendChild(panel);
      if (pimpbunny) {
        panel.querySelector('header strong span').textContent = api.site === 'fnxtube' ? 'FNXTube' : 'PimpBunny';
        panel.querySelector('header small').textContent = '1. Vyber karty · 2. Importuj do Nexus';
        panel.querySelector('[data-filter="keyword"]').placeholder = 'Hľadať v názve…';
        panel.querySelector('[data-filter="sort"]').closest('label').classList.add('nvs-wb-sort');
        panel.querySelector('[data-filter="direction"]').closest('label').classList.add('nvs-wb-direction');
        panel.querySelector('details').open = false;
        for (const part of ['columns', 'autoload']) panel.querySelector(`[data-part="${part}"]`).closest('label').hidden = true;
        panel.querySelector('[data-filter="hideRejected"]').closest('label').hidden = true;
        const alternatives = document.createElement('details');
        alternatives.className = 'nvs-wb-alternatives';
        const summary = document.createElement('summary'); summary.textContent = 'Ďalšie možnosti importu';
        const actions = document.createElement('div'); actions.className = 'nvs-wb-actions';
        actions.append(panel.querySelector('[data-action="import-filtered"]'), panel.querySelector('[data-action="import-all"]'));
        alternatives.append(summary, actions, panel.querySelector('[data-action="copy"]'));
        const footer = panel.querySelector('footer'); footer.append(alternatives);
        panel.appendChild(footer);
        const progress = panel.querySelector('[data-part="progress"]');
        const meter = panel.querySelector('[data-part="meter"]');
        panel.querySelector('.nvs-wb-body').append(progress, meter);
        const note = document.createElement('small');
        note.textContent = 'Kvalita a veľkosť sa dopĺňajú z detailu. Náhľad videa sa neimportuje.';
        panel.querySelector('details').append(note);
      }
      if (erome) {
        panel.querySelector('header strong span').textContent = 'Erome';
        panel.querySelector('header small').textContent = 'Albumy (posty) sa pripájajú pod seba. Vyber, filtruj a importuj.';
        panel.querySelector('[data-part="columns"]').closest('label').hidden = true;
        panel.querySelector('[data-filter="keyword"]').placeholder = 'Hľadať v názve albumu…';
        const sort = panel.querySelector('[data-filter="sort"]');
        sort.insertAdjacentHTML('beforeend', '<option value="views">Zhliadnutia</option><option value="videos">Počet videí</option>');
        const only = document.createElement('label');
        only.innerHTML = '<input data-filter="onlyVideos" type="checkbox">Len albumy s videom';
        panel.querySelector('.nvs-wb-view').prepend(only);
        if (api.onlyVideos?.()) { f.onlyVideos = true; only.querySelector('input').checked = true; }
      }
      if (api.site === 'spankbang') {
        panel.querySelector('header strong span').textContent = 'SpankBang';
        panel.querySelector('header small').textContent = 'Stránky sa pripájajú pod seba. Dátum, presná kvalita a tagy sa dopĺňajú zo stránky videa.';
      }
      if (api.site === 'xvideos') {
        panel.querySelector('header strong span').textContent = 'XVideos';
        panel.querySelector('header small').textContent = 'Stránky sa pripájajú pod seba. Vyber, filtruj a odošli do Nexusu.';
        const columns = panel.querySelector('[data-part="columns"]');
        if (columns) columns.addEventListener('change', () => document.documentElement.style.setProperty('--nvs-xh-cols', columns.value));
      }
      if (showTags) {
        const tagPanel = document.createElement('section'); tagPanel.className = 'nvs-wb-tags';
        tagPanel.innerHTML = `<strong>Tagy videí <span data-part="tags-count"></span></strong><div class="nvs-wb-actions"><button data-action="tags-all">Načítať tagy</button><button data-action="tags-selected">Tagy vybraných</button><button data-action="tags-stop" hidden>Zastaviť tagy</button></div><label>Filtrovať podľa tagov<input data-filter="tagFilter" type="search" placeholder="napr. pov, deep throat"></label><small>Čiarka = všetky zadané tagy. Hľadá sa v načítaných tagoch a kategóriách videa.</small><div class="nvs-wb-tag-chips" data-part="tag-chips" role="group" aria-label="Načítané tagy"></div><div data-part="tags-progress" role="status" aria-live="polite"></div>`;
        panel.querySelector('.nvs-wb-body > .nvs-wb-search').after(tagPanel);
      }
      const savedCols = localStorage.getItem('nvs-xh-cols') || '5';
      const columns = panel.querySelector('[data-part="columns"]');
      if (columns) columns.value = ['4','5','6','7','8'].includes(savedCols) ? savedCols : '5';
      document.documentElement.style.setProperty('--nvs-xh-cols', columns?.value || '5');
      const autoload = panel.querySelector('[data-part="autoload"]');
      if (autoload) autoload.checked = localStorage.getItem('nvs-xh-autoload') !== '0';
      document.documentElement.classList.add(panelOpenClass);
      launcher = document.createElement('button'); launcher.id = 'nvs-workbench-launch'; launcher.textContent = 'NEXUS · Import'; launcher.hidden = true; document.body.appendChild(launcher);
      launcher.onclick = () => visible(true, true);
      const host = location.hostname.replace(/^www\./i, '').toLowerCase();
      const localHidden = localStorage.getItem('nvs-panel-hidden') === '1';
      if (localHidden) visible(false, false);
      if (typeof chrome !== 'undefined' && chrome?.storage?.sync) {
        chrome.storage.sync.get({ hiddenPanelHosts: [] }, (data) => {
          const hiddenHosts = (data.hiddenPanelHosts || []).map(h => String(h).replace(/^www\./i, '').toLowerCase());
          if (hiddenHosts.includes(host)) {
            visible(false, false);
          } else if (!localHidden) {
            visible(true, false);
          }
        });
      }
      panel.addEventListener('input', event => {
        const el = event.target;
        if (el.dataset.part === 'columns') {
          const cols = ['4','5','6','7','8'].includes(el.value) ? el.value : '5';
          localStorage.setItem('nvs-xh-cols', cols);
          document.documentElement.style.setProperty('--nvs-xh-cols', cols);
          window.NVSXhamsterLayout?.clean();
          return;
        }
        if (el.dataset.part === 'autoload') {
          localStorage.setItem('nvs-xh-autoload', el.checked ? '1' : '0');
          return;
        }
        if (el.dataset.filter === 'onlyVideos') { try { localStorage.setItem('nvs-erome-onlyvideos', el.checked ? '1' : '0'); } catch {} }
        if (el.dataset.filter) f[el.dataset.filter] = el.type === 'checkbox' ? el.checked : el.value;
        else if (el.dataset.quality) f.qualities = [...panel.querySelectorAll('[data-quality]:checked')].map(e => e.dataset.quality);
        else return;
        if (el.dataset.filter === 'hideRejected') {
          f.hideUnfiltered = el.checked;
          f.hideUnselected = el.checked;
          panel.querySelector('[data-filter="hideUnfiltered"]').checked = el.checked;
          panel.querySelector('[data-filter="hideUnselected"]').checked = el.checked;
        }
        if (el.dataset.filter === 'hideUnfiltered' || el.dataset.filter === 'hideUnselected') {
          f.hideRejected = !!(f.hideUnfiltered && f.hideUnselected);
          const box = panel.querySelector('[data-filter="hideRejected"]');
          if (box) box.checked = f.hideRejected;
        }
        if (el.dataset.filter === 'sort' || el.dataset.filter === 'direction') applyChosenSort();
        refresh();
      });
      const collapse = panel.querySelector('[data-action="collapse"]');
      collapse?.addEventListener('click', () => visible(false, true));
      panel.addEventListener('click', async event => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (!action) return;
        const rows = cards(), filtered = rows.filter(r => matches(r,f));
        if (action === 'reset') {
          f = baseFilters();
          for (const el of panel.querySelectorAll('[data-filter]')) { if (el.type === 'checkbox') el.checked = f[el.dataset.filter]; else el.value = f[el.dataset.filter]; }
          panel.querySelectorAll('[data-quality]').forEach(el => el.checked = false); applyChosenSort(); refresh(); return;
        }
        if (action === 'select' || action === 'invert') {
          const targets = pimpbunny ? unique(filtered) : filtered;
          for (let offset = 0; offset < targets.length; offset += 20) {
            targets.slice(offset, offset + 20).forEach(r => api.select(r.card, action === 'select' || !r.selected));
            if (offset + 20 < targets.length) await new Promise(resolve => requestAnimationFrame(resolve));
          }
          api.selectionChanged();
        }
        if (action === 'clear') api.clear();
        if (action === 'copy') api.copy();
        if (action === 'rescan') api.scan();
        if (action === 'sort') applyChosenSort();
        if (action === 'tag-chip') {
          const tag = event.target.closest('[data-tag]').dataset.tag;
          const terms = String(f.tagFilter || '').split(',').map(term => term.trim().toLowerCase().replace(/[\s_]+/g,'-')).filter(Boolean);
          f.tagFilter = (terms.includes(tag) ? terms.filter(term => term !== tag) : [...terms,tag]).join(', ');
          panel.querySelector('[data-filter="tagFilter"]').value = f.tagFilter;
        }
        if (action === 'tags-stop') api.stopTags();
        if (action === 'tags-all' || action === 'tags-selected') {
          const targets = unique(action === 'tags-selected' ? rows.filter(row => row.selected) : rows);
          try {
            const outcome = await api.loadTags(targets.map(row => row.card));
            if (!outcome.busy) message(outcome.stopped ? 'Načítanie tagov zastavené. Načítané tagy zostali zachované.' : outcome.errors ? `Tagy: ${outcome.done - outcome.errors}/${outcome.total} načítaných; ${outcome.errors} chýb. Opakovaním načítaš iba chýbajúce.` : outcome.total ? `Tagy načítané pre ${outcome.done} videí.` : 'Tagy sú už načítané.', outcome.errors ? 'warning' : '');
          } catch (error) { message(`Načítanie tagov zlyhalo: ${error.message}`, 'error'); }
        }
        if (action === 'idm' || action === 'jd2') {
        const scope = selected.length ? rows.filter(r => r.selected) : filtered;
          try {
            const count = await api.sendDownloader(unique(scope).map(r => r.card), action);
            message(`${count} odkazov skopírovaných. Vlož ich do ${action === 'idm' ? 'IDM' : 'JDownloader 2'} cez schránku.`, '');
          } catch { message('Schránka nie je dostupná. Použi Kopírovať vybrané URL.', 'warning'); }
        }
        if (action === 'missing' || action === 'fetch-selected') {
          const targets = unique(action === 'fetch-selected' ? rows.filter(r => r.selected) : rows.filter(r => !r.quality || !r.duration || !r.size || !r.date));
          const response = api.fetch(targets.map(r => r.card), action === 'fetch-selected');
          message(response.busy ? 'Scan ešte beží. Po jeho dokončení môžeš doplnenie zopakovať.' : `Zaradených ${response.queued} kariet; zamknuté preskočené: ${response.locked}.`);
        }
        if (action.startsWith('import-')) {
          const scope = action === 'import-selected' ? rows.filter(r => r.selected) : action === 'import-filtered' ? filtered : rows;
          api.import(unique(scope).map(r => r.card), panel.querySelector('[data-part="port"]').value);
        }
        if (action === 'stop') stopLoading = true;
        if (action === 'load' && !loading) {
          const input = panel.querySelector('[data-part="load-count"]');
          if (!input.checkValidity()) { input.reportValidity(); return; }
          const count = Number(input.value); if (!Number.isInteger(count) || count < 1 || count > 50) return;
          loading = true; stopLoading = false; refresh();
          try {
            const loaded = await api.load(count, () => stopLoading);
            message(api.loadStatus?.()?.exhausted
              ? `Načítané všetky dostupné videá: ${unique(cards()).length}. Ďalšie strany už nie sú.`
              : loaded ? `Načítanie ${stopLoading ? 'zastavené' : 'dokončené'}: ${loaded} blokov / strán.`
              : stopLoading ? 'Načítanie zastavené.' : 'Ďalšia stránka nie je dostupná.');
          }
          catch (error) { message(`Načítanie zlyhalo: ${error.message}`, 'error'); }
          finally { loading = false; refresh(); }
        }
        refresh();
      });
      refresh();
    }
    function applyChosenSort() {
      const sorted = [...cards()].sort((a, b) => compare(a, b, f));
      api.sort(sorted.map((row) => row.card));
    }
    function visible(value, syncToStorage = true) {
      panel.classList.toggle('nvs-panel-hidden', !value);
      launcher.hidden = value;
      document.documentElement.classList.toggle(panelOpenClass, !!value);
      try { localStorage.setItem('nvs-panel-hidden', value ? '0' : '1'); } catch {}
      if (syncToStorage && typeof chrome !== 'undefined' && chrome?.storage?.sync) {
        const host = location.hostname.replace(/^www\./i, '').toLowerCase();
        if (host) {
          chrome.storage.sync.get({ hiddenPanelHosts: [] }, (data) => {
            let hiddenHosts = (data.hiddenPanelHosts || []).map(h => String(h).replace(/^www\./i, '').toLowerCase()).filter(Boolean);
            if (value) {
              hiddenHosts = hiddenHosts.filter(h => h !== host);
            } else {
              if (!hiddenHosts.includes(host)) hiddenHosts.push(host);
            }
            chrome.storage.sync.set({ hiddenPanelHosts: hiddenHosts });
          });
        }
      }
    }
    function message(text, value = '') { result = text; tone = value; refresh(); }
    function refresh() {
      clearTimeout(refreshTimer); if (!panel) return;
      const rows = cards(), filtered = rows.filter(r => matches(r,f)), selected = rows.filter(r => r.selected);
      const shownUrls = new Set();
      for (const row of rows) {
        const match = matches(row,f);
        const duplicate = pimpbunny && shownUrls.has(row.url);
        shownUrls.add(row.url);
        row.card.classList.toggle('nvs-hidden', duplicate || f.hideUnfiltered && !match || f.hideUnselected && !row.selected);
        row.card.classList.toggle('nvs-wb-unmatched', !f.hideUnfiltered && !match);
        if (showTags && row.tagsFetched) {
          let details = row.card.querySelector('.nvs-pb-card-tags');
          if (!details) { details = document.createElement('details'); details.className = 'nvs-pb-card-tags'; details.append(document.createElement('summary'), document.createElement('span')); row.card.append(details); }
          const text = row.tags.join(', ');
          if (details.dataset.tags !== text) {
            details.dataset.tags = text;
            details.querySelector('summary').textContent = `Tagy (${row.tags.length})`;
            details.querySelector('span').textContent = text || 'Video nemá zverejnené tagy.';
          }
        }
      }
      const hidden = selected.filter(r => !matches(r,f)).length;
      panel.querySelector('[data-part="summary"]').textContent = `${unique(rows).length} načítaných · ${unique(filtered).length} vyhovuje · ${unique(selected).length} vybraných`;
      panel.querySelector('[data-part="selection-note"]').textContent = hidden ? `${unique(selected.filter(r => !matches(r,f))).length} vybraných je mimo filtrov. Import vybraných ich zahrnie.` : pimpbunny ? 'Importuje sa každé vybrané video raz, aj keď je na stránke opakovane.' : 'Import všetkých zahŕňa všetky načítané karty. Filtre ani výber ho neobmedzujú.';
      panel.querySelector('[data-part="filter-count"]').textContent = f.keyword || f.tagFilter || f.qualities.length || f.durationMin || f.durationMax || f.sizeMin || f.sizeMax || f.dateMin || f.dateMax ? '· aktívne' : '';
      const invalidRange = ['duration','size','date'].some(key => f[key+'Min'] && f[key+'Max'] && (key === 'date' ? f[key+'Min'] > f[key+'Max'] : Number(f[key+'Min']) > Number(f[key+'Max'])));
      panel.querySelector('[data-part="filter-hint"]').textContent = invalidRange ? 'Neplatný rozsah: hodnota Od musí byť menšia alebo rovná Do.'
        : !rows.length ? 'Karty zatiaľ neboli nájdené. Otvor sekciu s videami alebo použi Znovu nájsť karty.'
        : !filtered.length ? 'Žiadne karty nevyhovujú. Uprav filtre, povoľ neznáme metadáta alebo ich doplň.'
        : f.hideUnselected && !selected.length ? 'Nie je vybraná žiadna karta. Použi Vybrať vyhovujúce alebo vypni Skryť nevybrané.' : '';
      for (const [action, label, target] of [['import-selected','Import vybraných',selected],['import-filtered','Import vyhovujúcich',filtered],['import-all','Import všetkých',rows]]) {
        const button = panel.querySelector(`[data-action="${action}"]`); button.textContent = `${label} (${unique(target).length})`; button.disabled = api.importing() || !target.length;
      }
      if (pimpbunny) {
        panel.querySelector('[data-action="import-selected"]').textContent = api.importing() ? 'Importujem…' : `Importovať vybrané (${unique(selected).length})`;
        for (const action of ['select','invert','clear','copy']) panel.querySelector(`[data-action="${action}"]`).disabled = api.importing() || (['clear','copy'].includes(action) ? !selected.length : !filtered.length);
        panel.querySelector('[data-action="import-all"]').title = 'Všetky načítané videá vrátane tých mimo filtrov.';
      }
      if (showTags) {
        const loadedTags = unique(rows).filter(row => row.tagsFetched);
        const tagStatus = api.tagStatus?.() || {};
        panel.querySelector('[data-part="tags-count"]').textContent = `· ${loadedTags.length}/${unique(rows).length}`;
        panel.querySelector('[data-action="tags-all"]').disabled = tagStatus.active || !rows.length;
        panel.querySelector('[data-action="tags-selected"]').disabled = tagStatus.active || !selected.length;
        panel.querySelector('[data-action="tags-stop"]').hidden = !tagStatus.active;
        panel.querySelector('[data-part="tags-progress"]').textContent = tagStatus.active ? `Načítavam tagy: ${tagStatus.done}/${tagStatus.total} · chyby ${tagStatus.errors}` : tagStatus.stopped ? 'Načítanie zastavené.' : tagStatus.errors ? `Chyby: ${tagStatus.errors}. Načítať tagy zopakuje iba chýbajúce.` : loadedTags.length < unique(rows).length ? 'Nenačítané videá sa pri filtrovaní podľa tagov nezobrazia.' : 'Tagy načítané.';
        const counts = new Map();
        for (const row of loadedTags) for (const tag of new Set(row.tags)) counts.set(tag,(counts.get(tag) || 0) + 1);
        const active = String(f.tagFilter || '').split(',').map(term => term.trim().toLowerCase().replace(/[\s_]+/g,'-')).filter(Boolean);
        const chips = [...counts].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0,12);
        for (const tag of active) if (!chips.some(chip => chip[0] === tag)) chips.push([tag,counts.get(tag) || 0]);
        const host = panel.querySelector('[data-part="tag-chips"]'), signature = JSON.stringify([chips,active]);
        if (host.dataset.signature !== signature) {
          host.dataset.signature = signature; host.replaceChildren();
          for (const [tag,count] of chips) {
            const button = document.createElement('button'); button.type = 'button'; button.dataset.action = 'tag-chip'; button.dataset.tag = tag;
            button.textContent = `${tag.replace(/-/g,' ')} (${count})`; button.setAttribute('aria-pressed',String(active.includes(tag))); host.append(button);
          }
        }
      }
      if (api.site === 'xvideos') {
        const actions = panel.querySelector('.nvs-wb-actions');
        if (actions && !panel.querySelector('[data-action="idm"]')) {
          const idm = document.createElement('button'); idm.type='button'; idm.dataset.action='idm'; idm.textContent='Kopírovať pre IDM';
          const jd2 = document.createElement('button'); jd2.type='button'; jd2.dataset.action='jd2'; jd2.textContent='Kopírovať pre JD2';
          panel.querySelector('footer .nvs-wb-actions')?.append(idm,jd2);
        }
      }
      const status = api.status();
      panel.querySelector('[data-part="progress"]').textContent = `${status.label}: ${status.done}/${status.total} · chýbajúca veľkosť ${status.noSize} · zamknuté ${status.locked} · chyby ${status.errors}`;
      const meter = panel.querySelector('[data-part="meter"]'); meter.max = Math.max(1,status.total); meter.value = status.done;
      for (const action of ['missing','fetch-selected']) panel.querySelector(`[data-action="${action}"]`).disabled = status.active || action === 'fetch-selected' && !selected.length;
      const exhausted = api.loadStatus?.()?.exhausted;
      const loadButton = panel.querySelector('[data-action="load"]');
      loadButton.disabled = loading || !!exhausted || !hasNext();
      loadButton.textContent = exhausted ? 'Všetky strany načítané' : '+ Načítať ďalšie';
      loadButton.title = exhausted ? `Načítané všetky dostupné videá: ${unique(rows).length}.` : '';
      panel.querySelector('[data-action="stop"]').hidden = !loading;
      panel.querySelector('[data-part="result"]').textContent = result; panel.querySelector('[data-part="result"]').dataset.tone = tone;
      launcher.textContent = `NEXUS · ${unique(selected).length} vybraných · Otvoriť import`;
    }
    return { mount, refresh, visible, message, schedule() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh,120); } };
  };
})();
