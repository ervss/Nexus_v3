(() => {
    'use strict';

    const dialog = document.getElementById('mega-hub');
    if (!dialog) return;
    const ui = Object.fromEntries([...dialog.querySelectorAll('[data-mh]')].map(el => [el.dataset.mh, el]));
    const base = '/api/v1/mega/hub';
    const preferenceKey = 'nexus.megaHub.layout';
    const labels = {
        empty: 'V tomto odkaze sa nenašli žiadne videá.',
        unavailable: 'MEGA odkaz alebo vybraný podpriečinok je nedostupný.',
        open_in_mega: 'Otvorte odkaz v MEGA a odošlite ho cez MEGA Helper.',
        retry: 'MEGA teraz neodpovedá. Skúste znova.',
    };
    const byName = (a, b) => a.name.localeCompare(b.name, 'sk', { numeric: true, sensitivity: 'base' });
    const qualityRank = { SD: 1, '480p': 2, '720p': 3, '1080p': 4, '1440p': 5, '4K': 6 };
    const sizeLabel = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    function timeLabel(seconds) {
        if (seconds <= 0) return '';
        const parts = [Math.floor(seconds / 60) % 60, Math.floor(seconds) % 60].map(value => String(value).padStart(2, '0'));
        if (seconds >= 3600) parts.unshift(String(Math.floor(seconds / 3600)));
        return parts.join(':');
    }
    let entry = null;
    let folder = '';
    let chosen = new Set();
    let visible = [];
    let page = 0;
    let pageSize = 15;
    let splitLoading = false;
    let playing = null;
    let loadId = 0;
    let listId = 0;
    let renderTimer;
    let inboxTimer;
    let importing = false;
    let removing = false;
    let rethumbing = false;
    let rethumbController = null;
    let metadataWorkers = 0;
    const metadataQueue = new Map();
    const metadataAttempted = new Set();

    async function api(path, body) {
        const response = await fetch(`${base}${path}`, body === undefined ? { cache: 'no-store' } : {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : `Chyba servera (${response.status})`);
        return result;
    }

    function button(text, action, className = '') {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = className;
        el.textContent = text;
        el.addEventListener('click', action);
        return el;
    }

    function notice(text = '', error = false, { toast = null } = {}) {
        ui.message.textContent = text;
        ui.message.hidden = !text;
        ui.message.classList.toggle('mh-error', error);
        const isTransient = !text || /^(Načítavam|Overujem|Obnovujem|Ukladám)/.test(text);
        const shouldToast = toast !== null ? toast : (Boolean(text) && (error || !isTransient));
        if (shouldToast && window.NexusToast && typeof window.NexusToast.show === 'function') {
            window.NexusToast.show(text, error ? 'error' : 'check_circle', error ? 'error' : 'success', error ? 5000 : 3500);
        }
    }

    async function loadInbox(reportError = false) {
        const seq = ++listId;
        try {
            const data = await api('/entries');
            if (!dialog.open || seq !== listId) return;
            const key = JSON.stringify(data.entries.map(item => [item.id, item.updated_at, item.id === entry?.id]));
            if (ui.entries.dataset.key === key) return;
            ui.entries.dataset.key = key;
            ui['entry-count'].textContent = data.entries.length;
            const rows = data.entries.map(item => {
                const row = button('', () => openEntry(item.id), 'mh-entry');
                row.setAttribute('aria-pressed', String(item.id === entry?.id));
                const title = document.createElement('strong');
                title.textContent = item.title;
                const info = document.createElement('small');
                info.textContent = `${item.count} videí${item.partial ? ' · neúplný zoznam' : ''}`;
                row.append(title, info);
                return row;
            });
            ui.entries.replaceChildren(...rows);
        } catch (error) {
            if (reportError && dialog.open && seq === listId) notice(error.message, true);
        }
    }

    async function openEntry(id, preserve = false) {
        const seq = ++loadId;
        if (!preserve) notice('Načítavam priečinok…');
        try {
            const result = await api(`/entries/${id}`);
            if (!dialog.open || seq !== loadId) return;
            const same = entry?.id === result.id;
            if (!same) {
                rethumbController?.abort();
                closePlayer();
                ui.filters.reset();
                chosen = new Set();
                metadataAttempted.clear();
            } else {
                const cards = new Map(entry.videos.map(card => [card.id, card]));
                result.videos = result.videos.map(card => {
                    const old = cards.get(card.id);
                    return old ? { ...card, width: card.width || old.width, height: card.height || old.height,
                        duration: card.duration || old.duration, quality: card.width ? card.quality : old.quality || card.quality,
                        thumb: card.thumb.includes('?v=') ? card.thumb : (old.thumb.includes('?v=') ? old.thumb : card.thumb) } : card;
                });
            }
            entry = result;
            if (!same || (folder !== entry.scope && !entry.folders.some(item => item.id === folder))) folder = entry.scope;
            const selectable = new Set(entry.videos.map(card => card.id));
            chosen = new Set([...chosen].filter(id => selectable.has(id)));
            ui.empty.hidden = true;
            ui.detail.hidden = false;
            if (!preserve) notice(entry.partial ? 'Zobrazuje sa obsah, ktorý sa podarilo načítať.' : '');
            renderFolder(!preserve);
            await loadInbox();
        } catch (error) {
            if (dialog.open && seq === loadId) notice(error.message, true);
        }
    }

    function changeFolder(id) {
        folder = id;
        renderFolder(true);
    }

    function renderFolder(resetLimit) {
        const folders = new Map(entry.folders.map(item => [item.id, item]));
        const crumbs = [];
        let cursor = folders.get(folder);
        while (cursor) {
            const current = cursor;
            crumbs.unshift(button(current.name, () => changeFolder(current.id)));
            cursor = folders.get(current.parent);
        }
        ui.title.textContent = folders.get(folder)?.name || entry.title;
        ui.source.href = `${base}/entries/${entry.id}/source${folder === entry.scope ? '' : `?folder=${encodeURIComponent(folder)}`}`;
        ui.crumbs.replaceChildren(button('Koreň', () => changeFolder(entry.scope)), ...crumbs);
        const children = entry.folders.filter(item => item.parent === folder).sort(byName);
        ui.folders.replaceChildren(...children.map(item => button(`▸ ${item.name}`, () => changeFolder(item.id))));
        renderGrid(resetLimit);
    }

    function inRange(value, min, max) {
        if (!min && !max) return true;
        return value > 0 && (!min || value >= Number(min)) && (!max || value <= Number(max));
    }

    function usesMetadataFilters() {
        const form = ui.filters.elements;
        return form.quality.value || form.durationMin.value || form.durationMax.value || ['quality', 'duration'].includes(form.sort.value);
    }

    function filterCards() {
        const form = ui.filters.elements;
        const directories = new Set([folder]);
        if (form.recursive.checked) {
            const children = new Map();
            for (const item of entry.folders) {
                if (!children.has(item.parent)) children.set(item.parent, []);
                children.get(item.parent).push(item.id);
            }
            for (const dir of directories) (children.get(dir) || []).forEach(id => directories.add(id));
        }
        const query = form.query.value.trim().toLocaleLowerCase('sk');
        const quality = form.quality.value;
        const dimension = {
            date: card => card.timestamp, size: card => card.size, duration: card => card.duration,
            quality: card => qualityRank[card.quality] || 0,
        }[form.sort.value];
        const matching = entry.videos.filter(card => directories.has(card.parent)
            && (!query || card.name.toLocaleLowerCase('sk').includes(query))
            && inRange(card.size / 1024 ** 2, form.sizeMin.value, form.sizeMax.value))
            .sort((a, b) => (dimension ? dimension(b) - dimension(a) : 0) || byName(a, b));
        if (usesMetadataFilters()) matching.forEach(queueMetadata);
        return matching.filter(card => (!quality || (card.quality || 'unknown') === quality)
            && inRange(card.duration / 60, form.durationMin.value, form.durationMax.value));
    }

    function updateSelection() {
        const pending = usesMetadataFilters() && (metadataQueue.size || metadataWorkers);
        ui.stats.textContent = `${visible.length} videí · ${chosen.size} vybraných${pending ? ' · načítavam metadáta' : ''}`;
        const busy = importing || removing;
        ui.import.disabled = busy || !entry.videos.some(card => !card.library_id && chosen.has(card.id));
        ui.select.disabled = busy || !visible.some(card => !chosen.has(card.id));
        ui.clear.disabled = busy || !chosen.size;
        ui['remove-videos'].disabled = busy || !chosen.size;
        ui['remove-entry'].disabled = busy;
        ui.split.disabled = removing || splitLoading || (!chosen.size && !visible.length);
        if (ui.rethumb) {
            ui.rethumb.disabled = !rethumbing && (busy || (!chosen.size && !visible.length));
            ui.rethumb.classList.toggle('is-running', rethumbing);
            ui.rethumb.textContent = rethumbing
                ? '⏹ Zastaviť náhľady'
                : chosen.size ? `✨ Zlepšiť vybrané (${chosen.size})` : '✨ Zlepšiť náhľady';
        }
    }

    function applyRethumbResult(cardId, data) {
        if (!entry || !data?.thumb) return;
        const card = entry.videos.find(item => item.id === cardId);
        if (!card) return;
        card.thumb = data.thumb;
        for (const key of ['width', 'height', 'duration', 'quality']) {
            if (data[key]) card[key] = data[key];
        }
        const node = [...ui.grid.children].find(el => el.megaCard?.id === cardId);
        if (node) {
            const img = node.querySelector('img');
            if (img) {
                img.hidden = false;
                img.src = card.thumb;
            }
            updateCardMetadata(node, card);
        }
    }

    async function rethumbSingle(card, btn, node) {
        if (!entry || !card || btn.disabled) return;
        const entryId = entry.id;
        btn.disabled = true;
        btn.classList.add('is-working');
        try {
            const data = await api(`/entries/${entryId}/videos/${card.id}/rethumb`, { reroll: true });
            if (entry?.id === entryId && data.ok) {
                applyRethumbResult(card.id, data);
                notice(`✨ Náhľad vylepšený: ${card.name}`);
            }
        } catch (error) {
            if (entry?.id === entryId) notice(error.message || 'Zlepšenie náhľadu zlyhalo.', true);
        } finally {
            btn.disabled = false;
            btn.classList.remove('is-working');
            if (node?.isConnected) updateSelection();
        }
    }

    async function rethumbBatch() {
        if (rethumbing) {
            rethumbController?.abort();
            return;
        }
        if (!entry || importing || removing) return;
        const targets = chosen.size
            ? entry.videos.filter(card => chosen.has(card.id))
            : visible.slice(page * pageSize, (page + 1) * pageSize);
        if (!targets.length) return;

        const ids = targets.slice(0, 200).map(card => card.id);
        const entryId = entry.id;
        rethumbing = true;
        rethumbController = new AbortController();
        updateSelection();
        notice(`✨ Zlepšujem náhľady · 0/${ids.length}…`);

        let done = 0;
        let failed = 0;
        let cancelled = false;
        try {
            const response = await fetch(`${base}/entries/${entryId}/rethumb`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids, reroll: false }),
                signal: rethumbController.signal,
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(typeof err.detail === 'string' ? err.detail : `Chyba servera (${response.status})`);
            }
            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (reader) {
                const { value, done: streamDone } = await reader.read();
                if (streamDone) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    let ev;
                    try { ev = JSON.parse(trimmed); } catch { continue; }
                    if (entry?.id !== entryId) continue;
                    if (ev.type === 'progress') {
                        done = ev.done ?? done;
                        failed = ev.failed ?? failed;
                        if (ev.ok && ev.id) applyRethumbResult(ev.id, ev);
                        notice(`✨ Zlepšujem náhľady · ${done + failed}/${ev.total || ids.length}${failed ? ` (${failed} chýb)` : ''}…`);
                    } else if (ev.type === 'done') {
                        done = ev.done ?? done;
                        failed = ev.failed ?? failed;
                    }
                }
            }
        } catch (error) {
            if (error?.name === 'AbortError') {
                cancelled = true;
            } else if (entry?.id === entryId) {
                notice(error.message || 'Zlepšenie náhľadov zlyhalo.', true);
                rethumbing = false;
                rethumbController = null;
                updateSelection();
                return;
            }
        } finally {
            rethumbing = false;
            rethumbController = null;
            if (dialog.open && entry?.id === entryId) {
                updateSelection();
                if (cancelled) {
                    notice(`Zlepšovanie náhľadov zastavené · hotovo ${done}/${ids.length}${failed ? ` (${failed} chýb)` : ''}.`);
                } else {
                    notice(`✨ Náhľady zlepšené: ${done}/${ids.length}${failed ? ` · neúspešné: ${failed}` : ''}.`, done === 0 && failed > 0);
                }
            }
        }
    }

    function cardNode(card) {
        const node = ui.card.content.firstElementChild.cloneNode(true);
        const play = node.querySelector('button.mh-thumb');
        play.setAttribute('aria-label', `Prehrať ${card.name}`);
        play.addEventListener('click', () => playVideo(card));
        const rethumbBtn = node.querySelector('.mh-card-rethumb');
        if (rethumbBtn) {
            rethumbBtn.setAttribute('aria-label', `Zlepšiť náhľad pre ${card.name}`);
            rethumbBtn.addEventListener('click', event => {
                event.stopPropagation();
                rethumbSingle(card, rethumbBtn, node);
            });
        }
        const image = node.querySelector('img');
        image.addEventListener('error', () => { image.hidden = true; });
        image.src = card.thumb;
        const title = node.querySelector('strong');
        title.textContent = card.name;
        title.title = card.name;
        updateCardMetadata(node, card);
        const box = node.querySelector('input');
        box.setAttribute('aria-label', `Vybrať ${card.name}`);
        box.disabled = importing || removing;
        box.checked = chosen.has(card.id);
        box.addEventListener('change', () => {
            if (box.checked) chosen.add(card.id);
            else chosen.delete(card.id);
            updateSelection();
        });
        node.megaCard = card;
        return node;
    }

    function updateCardMetadata(node, card) {
        const duration = node.querySelector('.mh-duration');
        const quality = node.querySelector('.mh-quality');
        const size = node.querySelector('.mh-size');
        duration.textContent = timeLabel(card.duration);
        quality.textContent = card.quality && card.quality !== 'unknown' ? card.quality : '';
        size.textContent = card.size ? sizeLabel(card.size) : '';
        duration.title = duration.textContent ? `Dĺžka: ${duration.textContent}` : '';
        quality.title = quality.textContent ? `Kvalita: ${quality.textContent}` : '';
        size.title = size.textContent ? `Veľkosť: ${size.textContent}` : '';
        node.querySelector('small').textContent = card.library_id ? '✓ V galérii' : '';
    }

    const observer = new IntersectionObserver((updates) => {
        for (const update of updates) {
            if (!update.isIntersecting) continue;
            observer.unobserve(update.target);
            queueMetadata(update.target.megaCard);
        }
    }, { root: dialog.querySelector('.mh-workspace'), rootMargin: '100px' });

    function gridSize() {
        const [columns, rows] = ui.layout.value.split('x').map(Number);
        const width = ui.grid.clientWidth;
        return Math.min(columns, width > 600 ? columns : width > 390 ? 3 : 2) * rows;
    }

    function renderGrid(resetPage = false) {
        if (!entry) return;
        pageSize = gridSize();
        visible = filterCards();
        const pages = Math.max(1, Math.ceil(visible.length / pageSize));
        page = resetPage ? 0 : Math.min(page, pages - 1);
        observer.disconnect();
        const nodes = visible.slice(page * pageSize, (page + 1) * pageSize).map(cardNode);
        if (!nodes.length) {
            const empty = document.createElement('p');
            empty.textContent = 'V tomto zobrazení nie sú žiadne videá.';
            ui.grid.replaceChildren(empty);
        } else {
            ui.grid.replaceChildren(...nodes);
            nodes.forEach(node => observer.observe(node));
        }
        ui.pages.hidden = pages <= 1;
        ui['page-label'].textContent = `${page + 1} / ${pages}`;
        ui['page-back'].disabled = page === 0;
        ui['page-next'].disabled = page + 1 >= pages;
        updateSelection();
    }

    function queueMetadata(card) {
        if ((card.width && card.height && card.duration) || metadataAttempted.has(card.metadata)) return;
        metadataAttempted.add(card.metadata);
        metadataQueue.set(card.metadata, { entryId: entry.id, card });
        pumpMetadata();
    }

    function pumpMetadata() {
        while (dialog.open && metadataWorkers < 3 && metadataQueue.size) {
            const [url, task] = metadataQueue.entries().next().value;
            metadataQueue.delete(url);
            if (entry?.id !== task.entryId) continue;
            metadataWorkers++;
            fetch(url).then(response => response.ok ? response.json() : null).then(meta => {
                const card = entry?.id === task.entryId && entry.videos.find(item => item.id === task.card.id);
                if (!meta || !card || !dialog.open || !(meta.width || meta.duration)) return;
                for (const key of ['width', 'height', 'duration', 'quality']) if (meta[key]) card[key] = meta[key];
                // Update the visible card in place so a grid rebuild cannot interrupt a click.
                const node = [...ui.grid.children].find(el => el.megaCard === card);
                if (node) {
                    updateCardMetadata(node, card);
                }
                if (usesMetadataFilters()) scheduleGrid();
            }).catch(() => {}).finally(() => {
                metadataWorkers--;
                pumpMetadata();
                if (dialog.open && !metadataWorkers && !metadataQueue.size) updateSelection();
            });
        }
    }

    function scheduleGrid() {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(() => renderGrid(), 180);
    }

    function playVideo(card) {
        if (!card) return;
        playing = { card, list: playing?.list || [...visible] };
        const index = playing.list.findIndex(item => item.id === card.id);
        ui.previous.disabled = index <= 0;
        ui.next.disabled = index >= playing.list.length - 1;
        ui['player-title'].textContent = card.name;
        ui['player-status'].textContent = 'Načítavam video…';
        ui['player-source'].hidden = true;
        ui['player-source'].href = `${base}/entries/${entry.id}/source?video=${encodeURIComponent(card.id)}`;
        ui['player-download'].hidden = !card.download;
        if (card.download) ui['player-download'].href = card.download;
        ui.player.hidden = false;
        ui.video.src = card.stream;
        ui.video.play().catch(() => {});
        ui['close-player'].focus();
    }

    function closePlayer() {
        if (!playing) return;
        const card = playing.card;
        playing = null;
        ui.video.pause();
        ui.video.removeAttribute('src');
        ui.video.load();
        ui.player.hidden = true;
        [...ui.grid.children].find(el => el.megaCard?.id === card.id)?.querySelector('button')?.focus();
    }

    async function saveSelection() {
        if (importing || removing || !entry || !chosen.size) return;
        const id = entry.id;
        const ids = entry.videos.filter(card => !card.library_id && chosen.has(card.id)).map(card => card.id);
        if (!ids.length) return;
        let added = 0;
        let skipped = 0;
        let errorText = '';
        importing = true;
        renderGrid();
        try {
            for (let i = 0; i < ids.length; i += 100) {
                if (dialog.open) notice(`Ukladám výber do galérie · ${i}/${ids.length}`);
                const chunk = ids.slice(i, i + 100);
                const result = await api(`/entries/${id}/import`, { ids: chunk });
                added += result.added;
                skipped += result.skipped;
                if (entry?.id === id) chunk.forEach(item => chosen.delete(item));
            }
        } catch (error) {
            errorText = error.message;
        } finally {
            importing = false;
            if (added) document.dispatchEvent(new CustomEvent('mega-hub-imported'));
            if (dialog.open && entry?.id === id) await openEntry(id, true);
            if (dialog.open) notice(`${added} uložených · ${skipped} už v galérii${errorText ? ` · ${errorText}` : ''}`, Boolean(errorText));
        }
    }

    async function removeFromHub(wholeEntry) {
        if (!entry || importing || removing || (!wholeEntry && !chosen.size)) return;
        const { id, title, updated_at } = entry;
        const ids = [...chosen];
        const subject = wholeEntry ? `celú položku „${title}“` : `${ids.length} vybraných videí`;
        if (!window.confirm(`Odstrániť ${subject} z MEGA Hubu? Súbory na MEGA aj videá v galérii zostanú uložené.`)) return;
        removing = true;
        renderGrid();
        try {
            const path = `/entries/${id}${wholeEntry ? '' : '/videos'}/remove`;
            const result = await api(path, wholeEntry ? { updated_at } : { updated_at, ids });
            if (entry?.id === id && wholeEntry) {
                ++loadId;
                closePlayer();
                entry = null;
                chosen.clear();
                visible = [];
                observer.disconnect();
                metadataQueue.clear();
                ui.grid.replaceChildren();
                ui.detail.hidden = true;
                ui.empty.hidden = false;
                notice('Položka bola odstránená z MEGA Hubu.');
            } else if (entry?.id === id) {
                await openEntry(id, true);
                if (entry?.id === id) notice(`Z MEGA Hubu odstránené: ${result.removed}.`);
            }
            await loadInbox();
        } catch (error) {
            if (entry?.id === id) notice(error.message, true);
        } finally {
            removing = false;
            if (dialog.open) renderGrid();
        }
    }

    async function open(id) {
        if (!dialog.open) {
            dialog.showModal();
            inboxTimer = setInterval(() => loadInbox(), 4000);
        }
        await loadInbox(true);
        if (id && dialog.open) await openEntry(id);
    }

    function ensureSplitPlayer() {
        if (document.documentElement.dataset.nexusSplitReady === '1') return Promise.resolve();
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/static/nexus-universal-splitscreen.js?v=mega-hub';
            script.onload = () => {
                if (document.documentElement.dataset.nexusSplitReady === '1') resolve();
                else reject(new Error('Nexus Split Screen sa nepodarilo spustiť.'));
            };
            script.onerror = () => { script.remove(); reject(new Error('Nexus Split Screen sa nepodarilo načítať.')); };
            document.documentElement.dataset.mhSplitBundled = '1';
            document.head.append(script);
        });
    }

    async function launchSplit() {
        const cards = chosen.size ? entry.videos.filter(card => chosen.has(card.id))
            : visible.slice(page * pageSize, (page + 1) * pageSize);
        if (!cards.length || splitLoading) return;
        splitLoading = true;
        updateSelection();
        try {
            await ensureSplitPlayer();
            if (!dialog.open) return;
            const picker = document.getElementById('nuss-picker-modal');
            const overlay = document.getElementById('nuss-overlay');
            const active = el => el && getComputedStyle(el).display !== 'none';
            const items = cards.map(card => ({
                url: new URL(card.stream, location.href).href, title: card.name,
                poster: new URL(card.thumb, location.href).href, duration: card.duration,
                size: card.size, quality: card.quality,
            }));
            document.dispatchEvent(new CustomEvent('nexus-gallery-split-picker', { detail: JSON.stringify(items) }));
            if (!active(picker)) throw new Error('Nexus Split Screen neotvoril výber videí.');
            const returnToHub = new MutationObserver(() => {
                if (active(picker) || active(overlay)) return;
                returnToHub.disconnect();
                requestAnimationFrame(() => {
                    open();
                    renderGrid();
                });
            });
            for (const element of [picker, overlay].filter(Boolean)) returnToHub.observe(element, { attributes: true, attributeFilter: ['style', 'hidden'] });
            dialog.close();
        } catch (error) {
            notice(error.message, true);
        } finally {
            splitLoading = false;
            updateSelection();
        }
    }

    function applyLayout() {
        const [columns, rows] = ui.layout.value.split('x');
        ui.grid.style.setProperty('--mh-cols', columns);
        ui.grid.style.setProperty('--mh-rows', rows);
    }

    function resizeTo(width, height) {
        dialog.style.setProperty('--mh-width', `${Math.round(Math.max(560, Math.min(2064, innerWidth - 32, width)))}px`);
        dialog.style.setProperty('--mh-height', `${Math.round(Math.max(400, Math.min(1380, innerHeight - 32, height)))}px`);
    }

    function resetSize() {
        dialog.style.removeProperty('--mh-width');
        dialog.style.removeProperty('--mh-height');
    }

    ui.resize.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        const { width, height } = dialog.getBoundingClientRect();
        const { clientX, clientY, pointerId } = event;
        const move = next => resizeTo(width + 2 * (next.clientX - clientX), height + 2 * (next.clientY - clientY));
        ui.resize.setPointerCapture(pointerId);
        dialog.classList.add('mh-resizing');
        ui.resize.addEventListener('pointermove', move);
        ui.resize.addEventListener('lostpointercapture', () => {
            ui.resize.removeEventListener('pointermove', move);
            dialog.classList.remove('mh-resizing');
        }, { once: true });
    });
    ui.resize.addEventListener('dblclick', resetSize);
    ui.resize.addEventListener('keydown', event => {
        const delta = { ArrowLeft: [-32, 0], ArrowRight: [32, 0], ArrowUp: [0, -32], ArrowDown: [0, 32] }[event.key];
        if (!delta && !['Home', 'Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        if (!delta) { resetSize(); return; }
        const { width, height } = dialog.getBoundingClientRect();
        resizeTo(width + delta[0], height + delta[1]);
    });
    try {
        const previousLayout = localStorage.getItem(preferenceKey);
        if ([...ui.layout.options].some(option => option.value === previousLayout)) ui.layout.value = previousLayout;
    } catch { /* Browser storage is optional. */ }
    applyLayout();
    new ResizeObserver(() => {
        if (dialog.open && entry && gridSize() !== pageSize) renderGrid();
    }).observe(ui.grid);

    document.querySelectorAll('[data-open-mega-hub]').forEach(trigger => trigger.addEventListener('click', () => open()));
    window.addEventListener('keydown', event => {
        if (event.code !== 'KeyM' || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || event.isComposing) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat && !dialog.open) open();
    }, { capture: true });
    ui.close.addEventListener('click', () => dialog.close());
    ui['close-player'].addEventListener('click', closePlayer);
    ui.previous.addEventListener('click', () => playing && playVideo(playing.list[playing.list.indexOf(playing.card) - 1]));
    ui.next.addEventListener('click', () => playing && playVideo(playing.list[playing.list.indexOf(playing.card) + 1]));
    ui.video.addEventListener('playing', () => { ui['player-status'].textContent = ''; });
    ui.video.addEventListener('error', async () => {
        const current = playing;
        if (!current) return;
        ui['player-status'].textContent = 'Video sa nepodarilo prehrať v prehliadači.';
        ui['player-source'].hidden = false;
        if (ui.video.error?.code === 3) return;
        try {
            const response = await fetch(current.card.stream, { headers: { Range: 'bytes=0-0' } });
            if (playing === current && response.status === 509) ui['player-status'].textContent = 'MEGA dosiahla limit prenosu. Skúste neskôr.';
            await response.body?.cancel();
        } catch { /* The source link remains available. */ }
    });
    dialog.addEventListener('cancel', event => {
        if (playing) { event.preventDefault(); closePlayer(); }
    });
    dialog.addEventListener('close', () => {
        rethumbController?.abort();
        closePlayer();
        clearInterval(inboxTimer);
        clearTimeout(renderTimer);
        observer.disconnect();
        metadataQueue.clear();
        metadataAttempted.clear();
        const url = new URL(location.href);
        if (url.searchParams.has('mega_hub')) {
            url.searchParams.delete('mega_hub');
            history.replaceState(null, '', url);
        }
        document.dispatchEvent(new CustomEvent('nexus-mega-hub-updated'));
    });
    ui.add.addEventListener('submit', async event => {
        event.preventDefault();
        const field = ui.add.elements.url;
        const submit = ui.add.querySelector('button');
        submit.disabled = true;
        notice('Overujem MEGA odkaz…');
        try {
            const result = await api('/entries', { url: field.value.trim() });
            if (!result.entry) { notice(labels[result.status], true); return; }
            field.value = '';
            await openEntry(result.entry.id);
            if (!entry?.partial) notice(result.status === 'exists' ? 'Tento odkaz už je v MEGA Hube.' : 'Pridané do MEGA Hubu.');
        } catch (error) {
            notice(error.message, true);
        } finally {
            submit.disabled = false;
        }
    });
    ui.refresh.addEventListener('click', async () => {
        const id = entry.id;
        ui.refresh.disabled = true;
        notice('Obnovujem MEGA priečinok…');
        try {
            const result = await api(`/entries/${id}/refresh`, {});
            if (entry?.id !== id) return;
            if (result.status === 'updated') await openEntry(id, true);
            notice(result.entry ? 'Obsah bol obnovený.' : labels[result.status], !result.entry);
        } catch (error) {
            if (entry?.id === id) notice(error.message, true);
        } finally {
            ui.refresh.disabled = false;
        }
    });
    ui.filters.addEventListener('submit', event => event.preventDefault());
    ui.filters.addEventListener('input', () => { page = 0; scheduleGrid(); });
    ui.filters.addEventListener('reset', () => { page = 0; scheduleGrid(); });
    ui.select.addEventListener('click', () => {
        visible.forEach(card => chosen.add(card.id));
        renderGrid();
    });
    ui.clear.addEventListener('click', () => { chosen.clear(); renderGrid(); });
    ui['remove-videos'].addEventListener('click', () => removeFromHub(false));
    ui['remove-entry'].addEventListener('click', () => removeFromHub(true));
    ui.layout.addEventListener('change', () => {
        try { localStorage.setItem(preferenceKey, ui.layout.value); } catch { /* Browser storage is optional. */ }
        applyLayout();
        renderGrid(true);
    });
    function changePage(step) {
        page += step;
        renderGrid();
        ui.grid.scrollIntoView({ block: 'nearest' });
    }
    ui['page-back'].addEventListener('click', () => changePage(-1));
    ui['page-next'].addEventListener('click', () => changePage(1));
    ui.rethumb?.addEventListener('click', rethumbBatch);
    ui.split.addEventListener('click', launchSplit);
    ui.import.addEventListener('click', saveSelection);
    window.nexusMegaHub = {
        open: id => open(id),
        reload: () => loadInbox(true),
    };
    const deepLink = Number(new URLSearchParams(location.search).get('mega_hub'));
    if (Number.isSafeInteger(deepLink) && deepLink > 0) open(deepLink);
})();
