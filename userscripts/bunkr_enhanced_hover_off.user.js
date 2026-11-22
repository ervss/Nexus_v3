// ==UserScript==
// @name Bunkr Albums Enhanced with Sorting
// @namespace https://github.com/WendysBro/bunkr-albums-autoload-previews
// @version 1.8.1
// @description Adds infinite scroll, optional hover previews, sorting (with dates & size), and filtering to Bunkr Albums pages
// @author WendysBro
// @match https://bunkr-albums.io/
// @match https://bunkr-albums.io/?*
// @match https://bunkr-albums.io/topalbums*
// @match https://balbums.st/
// @match https://balbums.st/?*
// @match https://balbums.st/topalbums*
// @license MIT
// @homepageURL https://github.com/WendysBro/bunkr-albums-autoload-previews
// @supportURL https://github.com/WendysBro/bunkr-albums-autoload-previews/issues
// @grant GM_xmlhttpRequest
// @grant GM_getValue
// @grant GM_setValue
// @connect bunkr.la
// @connect bunkr.si
// @connect bunkr.is
// @connect bunkr.cr
// @connect bunkr.black
// @connect bunkr.su
// @connect bunkr.pk
// @connect bunkrr.su
// @connect bunkr.ws
// @connect bunkr.vc
// @connect bunkr.media
// @connect bunkr.ru
// @connect bunkr.to
// @connect bunkr.ac
// @connect bunkr.ph
// @connect bunkr.sk
// @connect bunkr.ps
// @connect bunkr.fi
// @icon https://www.google.com/s2/favicons?sz=64&domain=bunkrrr.org
// ==/UserScript==

(function () {
	'use strict';

	const CONFIG = {
		previewDelay: 250,
		maxPreviews: 60,
		previewSize: '220px',
		scrollThreshold: 600,
		maxAlbumPagesToScan: 250,
		concurrentAlbumFetches: 3,
		maxGlobalFileRows: 300,
	};
	const STORAGE_KEYS = {
		resultsLayout: 'bae_results_layout',
		hoverPreviews: 'bae_hover_previews_enabled',
	};
	const PERSISTENT_CACHE_KEY = 'bae_album_metadata_cache_v2';
	const PERSISTENT_CACHE_VERSION = 2;
	const MAX_PERSISTENT_ALBUMS = 2500;

	function loadPersistentAlbumCache() {
		try {
			const stored = GM_getValue(PERSISTENT_CACHE_KEY, null);
			if (stored && stored.version === PERSISTENT_CACHE_VERSION && stored.entries && typeof stored.entries === 'object') return stored;
		} catch (error) {
			console.warn('[Bunkr Albums Enhanced] Persistent cache unavailable:', error);
		}
		return { version: PERSISTENT_CACHE_VERSION, entries: {} };
	}

	function getPersistentAlbumKey(url) {
		try {
			const parsed = new URL(url, window.location.href);
			const parts = parsed.pathname.split('/').filter(Boolean);
			// /a/306547 is an album ID; only /a/306547/2 contains a page suffix.
			if (parts.length > 2 && /^\d+$/.test(parts[parts.length - 1])) parts.pop();
			return `/${parts.join('/')}`.toLowerCase();
		} catch {
			return String(url || '').replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
		}
	}

	function getAlbumCacheTtl(metadata) {
		const ageDays = metadata.newestTimestamp ? (Date.now() - metadata.newestTimestamp) / (24 * 60 * 60 * 1000) : Infinity;
		if (ageDays <= 30) return 24 * 60 * 60 * 1000;
		if (ageDays <= 90) return 3 * 24 * 60 * 60 * 1000;
		return 14 * 24 * 60 * 60 * 1000;
	}

	function isAlbumCacheFresh(metadata) {
		return !!(metadata && metadata.fetchedAt && Date.now() - metadata.fetchedAt < getAlbumCacheTtl(metadata));
	}

	function getAlbumsGridContainer(root = document) {
		const strict = root.querySelector('div.grid.auto-rows-max.gap-1\\.5')
			|| root.querySelector('main section .grid.gap-1\\.5')
			|| root.querySelector('main .grid.gap-1\\.5');
		if (strict) return strict;
		const candidates = Array.from(root.querySelectorAll('section.grid, div.grid'));
		return candidates.find((el) => el.querySelector('a[href*="/a/"]')) || null;
	}

	function getAlbumCards(root = document) {
		return Array.from(root.querySelectorAll('.rounded-xl.bg-mute.border-b, a.card[href*="/a/"]'));
	}

	function getAlbumUrlFromCard(card) {
		if (!card) return '';
		const selfLink = card.matches && card.matches('a[href*="/a/"]') ? card : null;
		const nestedLink = card.querySelector("a[href^='https://bunkr.'], a[href*='/a/']");
		const href = selfLink?.href || nestedLink?.href || '';
		return href || '';
	}

	function getAlbumTitleFromCard(card) {
		return (card.querySelector('p.text-subs span')?.textContent
			|| card.querySelector('h3')?.textContent
			|| '').trim();
	}

	function getAlbumFileCountFromCard(card) {
		const oldText = card.querySelector('p.text-xs span')?.textContent || '';
		const oldCount = parseInt(oldText.match(/\d+/)?.[0] || '0', 10);
		if (oldCount > 0) return oldCount;

		const spans = Array.from(card.querySelectorAll('span'));
		for (const span of spans) {
			const text = (span.textContent || '').trim().toLowerCase();
			const m = text.match(/^(\d+)\s+(?:files?|videos?)$/);
			if (m) return parseInt(m[1], 10) || 0;
		}
		return 0;
	}

	function injectArchiveControlStyles() {
		if (document.getElementById('bae-archive-control-styles')) return;
		const style = document.createElement('style');
		style.id = 'bae-archive-control-styles';
		style.textContent = `
body main.cont { max-width: min(1680px, calc(100vw - 40px)) !important; }
.bae-command-center { position:sticky; top:72px; z-index:24; margin:12px 0 16px; padding:12px; border:1px solid #2b2e36; border-radius:14px; background:rgba(11,12,14,.96); box-shadow:0 16px 44px rgba(0,0,0,.28); backdrop-filter:blur(16px); color:#e7e9ee; }
.bae-command-main { display:grid; grid-template-columns:minmax(250px,1.35fr) minmax(360px,2fr) minmax(250px,1.2fr); gap:10px; }
.bae-command-group { display:flex; align-items:flex-end; gap:7px; min-width:0; padding:9px; border:1px solid #242730; border-radius:10px; background:#111216; }
.bae-command-group--refine { flex-wrap:wrap; }
.bae-field { display:grid; gap:4px; min-width:0; }
.bae-field--grow { flex:1; }
.bae-field > span, .bae-command-title { color:#7f8490; font:700 9px/1.1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.11em; text-transform:uppercase; }
.bae-command-center input, .bae-command-center select, .bae-command-center button { min-height:34px; border:1px solid #343844; border-radius:8px; background:#17191f; color:#eef0f4; font:600 11px/1.2 system-ui,sans-serif; outline:none; }
.bae-command-center input, .bae-command-center select { padding:0 9px; }
.bae-command-center input:focus-visible, .bae-command-center select:focus-visible, .bae-command-center button:focus-visible { border-color:#b9ff2c; box-shadow:0 0 0 2px rgba(185,255,44,.17); }
.bae-command-center button { padding:0 11px; cursor:pointer; white-space:nowrap; transition:border-color .15s ease,background .15s ease,transform .15s ease; }
.bae-command-center button:hover { border-color:#646b79; background:#20232a; }
.bae-command-center button:active { transform:translateY(1px); }
.bae-command-center .bae-primary { border-color:#b9ff2c; background:#b9ff2c; color:#101207; }
.bae-command-center .bae-primary:hover { background:#c7ff55; border-color:#c7ff55; }
.bae-command-center .bae-apply { border-color:#54d6c7; color:#8af1e5; }
.bae-command-center .bae-hover-toggle { border-color:#3b4250; color:#9ba3b4; }
.bae-command-center .bae-hover-toggle.is-on { border-color:#54d6c7; color:#8af1e5; background:rgba(84,214,199,.09); }
.bae-command-sub { display:flex; align-items:center; gap:8px; margin-top:9px; padding-top:9px; border-top:1px solid #242730; overflow:auto; }
.bae-preset { min-height:28px !important; padding:0 9px !important; color:#b9bec9 !important; }
.bae-status-text { margin-left:auto; color:#8fded5; font:600 10px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace; white-space:nowrap; }
.bae-workspace { display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:16px; align-items:start; }
.bae-workspace > .grid { grid-template-columns:repeat(auto-fill,minmax(190px,1fr)) !important; gap:12px !important; min-width:0; }
.bae-dashboard { position:sticky; top:224px; display:grid; gap:12px; padding:14px; border:1px solid #2b2e36; border-radius:14px; background:#111216; color:#e7e9ee; box-shadow:0 18px 50px rgba(0,0,0,.22); }
.bae-dashboard-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.bae-dashboard-title { font:700 11px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.12em; text-transform:uppercase; }
.bae-dashboard-live { display:flex; align-items:center; gap:6px; color:#8b909b; font-size:10px; }
.bae-dashboard-live::before { content:''; width:6px; height:6px; border-radius:50%; background:#b9ff2c; box-shadow:0 0 10px rgba(185,255,44,.6); }
.bae-stat-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.bae-stat { min-height:62px; padding:10px; border:1px solid #282b34; border-radius:10px; background:#17191f; }
.bae-stat strong { display:block; color:#f4f5f7; font:700 18px/1.1 system-ui,sans-serif; }
.bae-stat span { display:block; margin-top:5px; color:#777d88; font:600 9px/1.1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.08em; text-transform:uppercase; }
.bae-signal-label { display:flex; justify-content:space-between; color:#777d88; font:600 9px/1.1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.07em; text-transform:uppercase; }
.bae-signal-strip { display:grid; grid-template-columns:repeat(20,1fr); gap:3px; min-height:32px; }
.bae-signal { min-height:11px; border-radius:2px; background:#292c34; }
.bae-signal[data-state='fresh'] { background:#54d6c7; }
.bae-signal[data-state='warm'] { background:#ffb454; }
.bae-signal[data-state='old'] { background:#555b67; }
.bae-signal[data-state='hidden'] { opacity:.2; }
.bae-dashboard-note { margin:0; color:#777d88; font:500 10px/1.45 system-ui,sans-serif; }
.bae-file-results-panel { margin:8px 0 12px; border:1px solid #334155; border-radius:10px; background:#0b1220; overflow:hidden; }
.bae-album-meta { letter-spacing:.01em; }
.bae-video-quality { background:rgba(255,255,255,.025); }
@media (max-width:1180px) { .bae-command-main { grid-template-columns:1fr; } .bae-workspace { grid-template-columns:1fr; } .bae-dashboard { position:relative; top:auto; grid-template-columns:1fr 2fr; } }
@media (max-width:720px) { body main.cont { max-width:calc(100vw - 20px) !important; } .bae-command-center { position:relative; top:auto; } .bae-dashboard { grid-template-columns:1fr; } .bae-command-group { flex-wrap:wrap; } }
@media (prefers-reduced-motion:reduce) { .bae-command-center button { transition:none; } }
`;
		document.head.appendChild(style);
	}

	function addSortingControls() {
		if (document.querySelector('.bae-command-center')) return;
		injectArchiveControlStyles();
		const gridContainer = getAlbumsGridContainer(document);
		if (!gridContainer || !gridContainer.parentElement) return;
		const parent = gridContainer.parentElement;
		const controls = document.createElement('section');
		controls.className = 'bae-command-center';
		controls.innerHTML = `
<div class="bae-command-main">
  <div class="bae-command-group">
    <label class="bae-field"><span>Albums</span><input class="bae-fetch-count" type="number" min="1" max="200" value="100" title="Visible albums to fetch"></label>
    <button class="bae-primary bae-fetch">Fetch visible</button>
    <button class="bae-layout-toggle">Results: Grid</button>
    <button class="bae-hover-toggle" title="Expand album contents when the pointer rests over a card">Hover previews: OFF</button>
  </div>
  <div class="bae-command-group bae-command-group--refine">
    <label class="bae-field bae-field--grow"><span>Find</span><input class="bae-global-filter" type="search" placeholder="Album or cached video title"></label>
    <label class="bae-field"><span>Min videos</span><input class="bae-min-count" type="number" min="0" value="0"></label>
    <label class="bae-field"><span>Min size</span><input class="bae-min-size" type="text" placeholder="1 GB"></label>
    <label class="bae-field"><span>Updated</span><select class="bae-updated-within"><option value="0">Any time</option><option value="7">7 days</option><option value="14">2 weeks</option><option value="30">1 month</option><option value="90">3 months</option><option value="180">6 months</option></select></label>
    <label class="bae-field"><span>Estimate</span><select class="bae-quality-min"><option value="0">Any</option><option value="1">Standard+</option><option value="2">High+</option><option value="3">Very high</option></select></label>
    <button class="bae-apply">Apply filters</button>
  </div>
  <div class="bae-command-group">
    <label class="bae-field bae-field--grow"><span>Sort</span><select class="bae-sort"><option value="default">Default</option><option value="newest">Newest update</option><option value="size">Largest videos</option><option value="count">Most videos</option><option value="name">Name A–Z</option><option value="oldest">Oldest first</option></select></label>
    <button class="bae-reset">Reset</button>
  </div>
</div>
<div class="bae-command-sub">
  <span class="bae-command-title">Presets</span>
  <button class="bae-preset" data-preset="fresh">Fresh videos</button>
  <button class="bae-preset" data-preset="large">Large recent</button>
  <button class="bae-preset" data-preset="quality">High estimate</button>
  <span class="bae-status-text">Ready to scan</span>
</div>`;

		const fetchCount = controls.querySelector('.bae-fetch-count');
		const globalFilter = controls.querySelector('.bae-global-filter');
		const minCountInput = controls.querySelector('.bae-min-count');
		const minSizeInput = controls.querySelector('.bae-min-size');
		const updatedWithinSelect = controls.querySelector('.bae-updated-within');
		const qualityMinSelect = controls.querySelector('.bae-quality-min');
		const sortSelect = controls.querySelector('.bae-sort');
		const layoutToggleBtn = controls.querySelector('.bae-layout-toggle');
		const hoverToggleBtn = controls.querySelector('.bae-hover-toggle');
		const applyFilters = () => window.dispatchEvent(new CustomEvent('bae-min-filter', { detail: {
			minCount: parseInt(minCountInput.value || '0', 10) || 0,
			minSizeRaw: (minSizeInput.value || '').trim(),
			updatedWithinDays: parseInt(updatedWithinSelect.value || '0', 10) || 0,
			qualityMin: parseInt(qualityMinSelect.value || '0', 10) || 0,
		} }));

		controls.querySelector('.bae-fetch').addEventListener('click', () => {
			const value = parseInt(fetchCount.value || '100', 10);
			window.dispatchEvent(new CustomEvent('bae-fetch-visible', { detail: Number.isFinite(value) ? value : 100 }));
		});
		globalFilter.addEventListener('input', (e) => window.dispatchEvent(new CustomEvent('bae-global-filter', { detail: e.target.value || '' })));
		controls.querySelector('.bae-apply').addEventListener('click', applyFilters);
		[minCountInput, minSizeInput, updatedWithinSelect, qualityMinSelect].forEach((input) => input.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilters(); }));
		sortSelect.addEventListener('change', () => sortAlbums(sortSelect.value));
		const initialLayout = localStorage.getItem(STORAGE_KEYS.resultsLayout) || 'grid';
		layoutToggleBtn.textContent = `Results: ${initialLayout === 'list' ? 'List' : 'Grid'}`;
		layoutToggleBtn.addEventListener('click', () => {
			const current = localStorage.getItem(STORAGE_KEYS.resultsLayout) || 'grid';
			const next = current === 'grid' ? 'list' : 'grid';
			localStorage.setItem(STORAGE_KEYS.resultsLayout, next);
			layoutToggleBtn.textContent = `Results: ${next === 'list' ? 'List' : 'Grid'}`;
			window.dispatchEvent(new CustomEvent('bae-results-layout', { detail: next }));
		});
		const renderHoverToggle = (enabled) => {
			hoverToggleBtn.textContent = `Hover previews: ${enabled ? 'ON' : 'OFF'}`;
			hoverToggleBtn.classList.toggle('is-on', enabled);
			hoverToggleBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
		};
		renderHoverToggle(localStorage.getItem(STORAGE_KEYS.hoverPreviews) === '1');
		hoverToggleBtn.addEventListener('click', () => {
			const enabled = localStorage.getItem(STORAGE_KEYS.hoverPreviews) !== '1';
			localStorage.setItem(STORAGE_KEYS.hoverPreviews, enabled ? '1' : '0');
			renderHoverToggle(enabled);
			window.dispatchEvent(new CustomEvent('bae-hover-previews', { detail: enabled }));
		});
		controls.querySelector('.bae-reset').addEventListener('click', () => {
			globalFilter.value = ''; minCountInput.value = '0'; minSizeInput.value = ''; updatedWithinSelect.value = '0'; qualityMinSelect.value = '0'; sortSelect.value = 'default';
			window.dispatchEvent(new CustomEvent('bae-global-filter', { detail: '' })); applyFilters(); sortAlbums('default');
		});
		controls.querySelectorAll('.bae-preset').forEach((button) => button.addEventListener('click', () => {
			const preset = button.dataset.preset;
			if (preset === 'fresh') { minCountInput.value = '5'; minSizeInput.value = ''; updatedWithinSelect.value = '14'; qualityMinSelect.value = '0'; sortSelect.value = 'newest'; }
			if (preset === 'large') { minCountInput.value = '5'; minSizeInput.value = '1 GB'; updatedWithinSelect.value = '30'; qualityMinSelect.value = '0'; sortSelect.value = 'size'; }
			if (preset === 'quality') { minCountInput.value = '3'; minSizeInput.value = ''; updatedWithinSelect.value = '90'; qualityMinSelect.value = '2'; sortSelect.value = 'size'; }
			applyFilters(); sortAlbums(sortSelect.value);
		}));
		window.addEventListener('bae-status', (e) => { controls.querySelector('.bae-status-text').textContent = (e && e.detail) || 'Ready'; });

		parent.insertBefore(controls, gridContainer);
		let fileResults = parent.querySelector('.bae-file-results-panel');
		if (!fileResults) { fileResults = document.createElement('div'); fileResults.className = 'bae-file-results-panel'; fileResults.style.display = 'none'; parent.insertBefore(fileResults, gridContainer); }
		const workspace = document.createElement('div');
		workspace.className = 'bae-workspace';
		parent.insertBefore(workspace, gridContainer);
		workspace.appendChild(gridContainer);
		const dashboard = document.createElement('aside');
		dashboard.className = 'bae-dashboard';
		dashboard.innerHTML = `<div class="bae-dashboard-head"><span class="bae-dashboard-title">Album signal</span><span class="bae-dashboard-live">local scan</span></div><div class="bae-stat-grid"><div class="bae-stat"><strong data-stat="fetched">0</strong><span>Fetched</span></div><div class="bae-stat"><strong data-stat="visible">0</strong><span>Visible</span></div><div class="bae-stat"><strong data-stat="videos">0</strong><span>Videos</span></div><div class="bae-stat"><strong data-stat="size">0 B</strong><span>Video size</span></div><div class="bae-stat"><strong data-stat="fresh">0</strong><span>Updated ≤30d</span></div><div class="bae-stat"><strong data-stat="quality">0</strong><span>High estimate</span></div></div><div class="bae-signal-label"><span>100-album signal</span><span>fresh → old</span></div><div class="bae-signal-strip"></div><p class="bae-dashboard-note">Signals are calculated locally from fetched video metadata. Quality is an estimate based on average size per video.</p>`;
		workspace.appendChild(dashboard);
	}

	function sortAlbums(method) {
		const container = getAlbumsGridContainer(document);
		if (!container) return;

		const albums = Array.from(container.children);
		if (method === 'name') {
			albums.sort((a, b) => {
				const nameA = getAlbumTitleFromCard(a).toLowerCase();
				const nameB = getAlbumTitleFromCard(b).toLowerCase();
				return nameA.localeCompare(nameB);
			});
		} else if (method === 'count') {
			albums.sort((a, b) => {
				const countA = getAlbumFileCountFromCard(a);
				const countB = getAlbumFileCountFromCard(b);
				return countB - countA;
			});
		} else if (method === 'oldest') {
			albums.sort((a, b) => {
				const dateA = parseInt(a.dataset.oldestDate || '0');
				const dateB = parseInt(b.dataset.oldestDate || '0');
				return dateA - dateB;
			});
		} else if (method === 'newest') {
			albums.sort((a, b) => {
				const dateA = parseInt(a.dataset.newestDate || '0');
				const dateB = parseInt(b.dataset.newestDate || '0');
				return dateB - dateA;
			});
		} else if (method === 'size') {
			albums.sort((a, b) => {
				const sizeA = parseFloat(a.dataset.totalSizeBytes || '0');
				const sizeB = parseFloat(b.dataset.totalSizeBytes || '0');
				return sizeB - sizeA;
			});
		} else {
			return;
		}

		albums.forEach((album) => container.appendChild(album));
	}

	// Helper function to parse file size to bytes
	function parseSizeToBytes(sizeStr) {
		if (!sizeStr) return 0;
		const normalized = sizeStr.replace(',', '.');
		const match = normalized.match(/([\d.]+)\s*(TB|GB|MB|KB|B)/i);
		if (!match) return 0;
		const value = parseFloat(match[1]);
		const unit = match[2].toUpperCase();
		const multipliers = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024, TB: 1024 * 1024 * 1024 * 1024 };
		return value * (multipliers[unit] || 0);
	}

	// Helper function to format bytes to human-readable size
	function formatBytes(bytes) {
		if (bytes === 0) return '0 B';
		if (bytes < 1024) return bytes + ' B';
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
		if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
		if (bytes < 1024 * 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
		return (bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2) + ' TB';
	}

	// This is an estimate only: without video duration we cannot derive bitrate
	// or resolution. Average bytes per video is still useful for a quick scan.
	function getVideoQualityEstimate(totalBytes, videoCount) {
		if (!totalBytes || !videoCount) return null;
		const averageBytes = totalBytes / videoCount;
		const mb = averageBytes / (1024 * 1024);
		if (mb < 150) return { label: 'Light', color: '#fbbf24', averageBytes };
		if (mb < 500) return { label: 'Standard', color: '#60a5fa', averageBytes };
		if (mb < 1500) return { label: 'High', color: '#4ade80', averageBytes };
		return { label: 'Very high', color: '#c084fc', averageBytes };
	}

	function getVideoQualityLevel(totalBytes, videoCount) {
		const estimate = getVideoQualityEstimate(totalBytes, videoCount);
		if (!estimate) return 0;
		return estimate.label === 'Very high' ? 3 : estimate.label === 'High' ? 2 : estimate.label === 'Standard' ? 1 : 0;
	}

	function extractSizeFromText(text) {
		if (!text) return '';
		const match = text.match(/([\d.,]+)\s*(TB|GB|MB|KB|B)\b/i);
		if (!match) return '';
		return `${match[1].replace(',', '.')} ${match[2].toUpperCase()}`;
	}

	function extractDateFromText(text) {
		if (!text) return '';
		const match = text.match(/\d{2}:\d{2}:\d{2}\s+\d{2}\/\d{2}\/\d{4}/);
		return match ? match[0] : '';
	}

	function getNormalizedAlbumUrl(url) {
		if (!url) return '';
		try {
			const u = new URL(url);
			u.hash = '';
			u.search = '';
			return u.toString().replace(/\/+$/, '');
		} catch {
			return (url || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
		}
	}

	function getAlbumRootKey(url) {
		const normalized = getNormalizedAlbumUrl(url);
		return normalized.replace(/\/\d+$/, '');
	}

	function getAlbumDedupKeyFromCard(card) {
		if (!card) return '';

		const link = card.querySelector("a[href*='/a/']") || card.querySelector("a[href^='https://bunkr.']");
		if (link && link.href) {
			try {
				const parsed = new URL(link.href);
				const pathKey = parsed.pathname.replace(/\/+$/, '').replace(/\/\d+$/, '');
				if (pathKey && pathKey !== '/') return pathKey.toLowerCase();
			} catch {
				const href = link.getAttribute('href') || '';
				const cleaned = href.replace(/^https?:\/\/[^/]+/i, '').replace(/\/+$/, '').replace(/\/\d+$/, '');
				if (cleaned) return cleaned.toLowerCase();
			}
		}

		const title = getAlbumTitleFromCard(card).toLowerCase();
		const meta = (card.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
		return `${title}::${meta}`;
	}

	// Decode XOR-encrypted URL returned by Bunkr /api/vs (mirrors player.enc.js logic)
	function decodeBunkrUrl(encoded, timestamp) {
		try {
			const raw = atob(encoded);
			const key = `SECRET_KEY_${Math.floor(timestamp / 3600)}`;
			let out = '';
			for (let i = 0; i < raw.length; i++) {
				out += String.fromCharCode(raw.charCodeAt(i) ^ key.charCodeAt(i % key.length));
			}
			return out;
		} catch (e) {
			return null;
		}
	}

	function postJsonCrossOrigin(url, payload, headers = {}) {
		return new Promise((resolve, reject) => {
			if (typeof GM_xmlhttpRequest !== 'function') {
				fetch(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Accept': 'application/json',
						...headers,
					},
					body: JSON.stringify(payload),
				})
					.then((response) => {
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						return response.json();
					})
					.then(resolve)
					.catch(reject);
				return;
			}

			GM_xmlhttpRequest({
				method: 'POST',
				url,
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'application/json',
					...headers,
				},
				data: JSON.stringify(payload),
				onload: (response) => {
					if (response.status < 200 || response.status >= 300) {
						reject(new Error(`HTTP ${response.status}`));
						return;
					}
					try {
						resolve(JSON.parse(response.responseText || '{}'));
					} catch (error) {
						reject(error);
					}
				},
				onerror: () => reject(new Error('Cross-origin request failed')),
				ontimeout: () => reject(new Error('Cross-origin request timed out')),
			});
		});
	}

	// Resolve the real CDN stream URL from a Bunkr file page URL using /api/vs
	async function resolveBunkrStreamUrl(filePageUrl) {
		try {
			const parsed = new URL(filePageUrl);
			const pathParts = parsed.pathname.split('/').filter(Boolean);
			if (pathParts.length < 2 || !['f', 'v'].includes(pathParts[0])) return filePageUrl;
			const slug = pathParts[1];
			const slugNoExt = slug.replace(/\.(mp4|mkv|mov|webm|m4v|avi|ts)$/i, '');
			const origin = `${parsed.protocol}//${parsed.host}`;

			const trySlug = async (s) => {
				const data = await postJsonCrossOrigin(
					`${origin}/api/vs`,
					{ slug: s },
					{
						'Referer': filePageUrl,
						'Origin': origin,
					}
				).catch(() => null);
				if (!data) return null;
				let url = data.url;
				if (url && data.encrypted) url = decodeBunkrUrl(url, Number(data.timestamp) || 0);
				if (url) return url.startsWith('//') ? 'https:' + url : url;
				return null;
			};

			const url = await trySlug(slugNoExt) || (slugNoExt !== slug ? await trySlug(slug) : null);
			if (url) return url;
		} catch (e) {}
		return filePageUrl;
	}

	// Helper function to parse Bunkr date format (HH:MM:SS DD/MM/YYYY)
	function parseBunkrDate(dateStr) {
		if (!dateStr) return null;
		// Match format like "16:43:15 12/02/2026" or "03:41:49 12/02/2026"
		const match = dateStr.match(/(\d{2}):(\d{2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})/);
		if (!match) return null;
		const [, hours, minutes, seconds, day, month, year] = match;
		// JavaScript Date: month is 0-indexed
		return new Date(year, month - 1, day, hours, minutes, seconds);
	}

	const BAE_BRIDGE_CHANNEL = 'NEXUS_BAE_BRIDGE';
	const BAE_BRIDGE_VERSION = 1;
	const BAE_BRIDGE_DEBUG = true;
	function baeBridgeDebug(...args) {
		if (!BAE_BRIDGE_DEBUG) return;
		try {
			console.log('[BAE Userscript Bridge]', ...args);
		} catch {}
	}
const BAE_BRIDGE_MAX_EXPORT_ALBUMS = 25;
const BAE_BRIDGE_MAX_ROWS_PER_ALBUM = 20;
const BAE_BRIDGE_MAX_TOTAL_ROWS = 400;
	const BAE_BRIDGE_EXTENSION_TYPES = new Set([
		'BAE_GET_STATE',
		'BAE_GET_SELECTION',
		'BAE_GET_CACHE_EXPORT',
		'BAE_FETCH_SELECTED',
		'BAE_PLAY_FILE',
		'BAE_COMPARE_SET',
	]);

	function createBridgeEnvelope(source, type, requestId, payload = {}) {
		return {
			channel: BAE_BRIDGE_CHANNEL,
			version: BAE_BRIDGE_VERSION,
			source,
			type,
			requestId,
			ts: Date.now(),
			payload: payload && typeof payload === 'object' ? payload : {},
		};
	}

	class BaeExtensionBridge {
		constructor(app) {
			this.app = app;
			this.isReady = false;
			this.boundMessageHandler = (event) => this.handleWindowMessage(event);
			window.addEventListener('message', this.boundMessageHandler);
			// Marker for quick verification from page console.
			window.__BAE_USERSCRIPT_BRIDGE_ACTIVE__ = true;
			baeBridgeDebug('listener-attached');
		}

		setReady() {
			this.isReady = true;
			baeBridgeDebug('ready');
			this.emitReady();
		}

		emitReady() {
			this.postToWindow('BAE_BRIDGE_READY', `bridge-ready-${Date.now()}`, {
				ready: true,
				capabilities: Array.from(BAE_BRIDGE_EXTENSION_TYPES),
			});
		}

		postToWindow(type, requestId, payload = {}) {
			baeBridgeDebug('post', { type, requestId });
			window.postMessage(createBridgeEnvelope('bae-userscript', type, requestId, payload), window.location.origin);
		}

		postError(requestId, code, message, details = null) {
			const payload = { code, message };
			if (details && typeof details === 'object') payload.details = details;
			this.postToWindow('BAE_ERROR', requestId, payload);
		}

		isValidEnvelope(data) {
			return !!(
				data &&
				typeof data === 'object' &&
				data.channel === BAE_BRIDGE_CHANNEL &&
				data.version === BAE_BRIDGE_VERSION &&
				data.source === 'nexus-extension' &&
				typeof data.type === 'string' &&
				typeof data.requestId === 'string' &&
				data.requestId.trim() &&
				typeof data.ts === 'number' &&
				data.payload &&
				typeof data.payload === 'object'
			);
		}

		handleWindowMessage(event) {
			// In userscript sandboxes (Tampermonkey/Violentmonkey), event.source can be
			// a wrapped/proxied window object. Do not hard-filter by source identity.
			const data = event.data;
			if (!data || typeof data !== 'object') return;
			if (data.channel !== BAE_BRIDGE_CHANNEL) return;
			if (data.source !== 'nexus-extension') return;
			baeBridgeDebug('recv', { type: data.type, requestId: data.requestId });

			if (!this.isValidEnvelope(data)) {
				if (typeof data.requestId === 'string' && data.requestId.trim()) {
					this.postError(data.requestId, 'INVALID_ENVELOPE', 'Bridge envelope validation failed.');
				}
				return;
			}

			if (!this.isReady) {
				this.postError(data.requestId, 'BRIDGE_NOT_READY', 'Userscript bridge is not ready yet.');
				return;
			}

			if (!BAE_BRIDGE_EXTENSION_TYPES.has(data.type)) return;
			this.handleRequest(data).catch((error) => {
				this.postError(data.requestId, 'INTERNAL_ERROR', error?.message || 'Unexpected bridge error.');
			});
		}

		validatePlayPayload(payload) {
			return !!(payload && typeof payload.url === 'string' && payload.url.trim());
		}

		validateComparePayload(payload) {
			return !!(
				payload &&
				(payload.slot === 'A' || payload.slot === 'B') &&
				typeof payload.url === 'string' &&
				payload.url.trim()
			);
		}

		buildCacheExport(payload) {
			const includeRows = !!payload.includeRows;
			const requestedLimit = parseInt(payload.limit || `${BAE_BRIDGE_MAX_EXPORT_ALBUMS}`, 10);
			const albumLimit = Math.max(1, Math.min(BAE_BRIDGE_MAX_EXPORT_ALBUMS, Number.isFinite(requestedLimit) ? requestedLimit : BAE_BRIDGE_MAX_EXPORT_ALBUMS));
			const requestedRowsPerAlbum = parseInt(payload.rowsPerAlbum || `${BAE_BRIDGE_MAX_ROWS_PER_ALBUM}`, 10);
			const rowsPerAlbum = Math.max(1, Math.min(BAE_BRIDGE_MAX_ROWS_PER_ALBUM, Number.isFinite(requestedRowsPerAlbum) ? requestedRowsPerAlbum : BAE_BRIDGE_MAX_ROWS_PER_ALBUM));
			const cacheEntries = Array.from(this.app.albumCache.values())
				.sort((a, b) => (b.newestTimestamp || 0) - (a.newestTimestamp || 0));
			let totalRowsIncluded = 0;

			const albums = cacheEntries.slice(0, albumLimit).map((entry) => {
				const base = {
					albumUrl: entry.albumUrl,
					albumDomain: entry.albumDomain,
					albumName: entry.albumName,
					fileCount: entry.fileCount,
					totalBytes: entry.totalBytes || 0,
					oldestTimestamp: entry.oldestTimestamp || 0,
					newestTimestamp: entry.newestTimestamp || 0,
				};
				if (!includeRows) return base;

				const remaining = Math.max(0, BAE_BRIDGE_MAX_TOTAL_ROWS - totalRowsIncluded);
				const localLimit = Math.min(rowsPerAlbum, remaining);
				const files = localLimit > 0
					? (entry.files || []).slice(0, localLimit).map((file) => ({
						href: file.href,
						title: file.title || '',
						size: file.size || '',
						isVideo: !!file.isVideo,
						thumbSrc: file.thumbSrc || '',
						timestamp: file.timestamp || 0,
					}))
					: [];
				totalRowsIncluded += files.length;
				return {
					...base,
					files,
					rowsReturned: files.length,
				};
			});

			return {
				includeRows,
				limit: albumLimit,
				rowsPerAlbum: includeRows ? rowsPerAlbum : 0,
				totalAlbums: cacheEntries.length,
				returnedAlbums: albums.length,
				totalRowsIncluded,
				albums,
			};
		}

		emitFetchProgress(requestId, stage, extra = {}) {
			this.postToWindow('BAE_FETCH_PROGRESS', requestId || `fetch-progress-${Date.now()}`, {
				stage,
				...extra,
			});
		}

		async handleRequest(message) {
			const { type, requestId, payload } = message;
			switch (type) {
				case 'BAE_GET_STATE':
					this.postToWindow('BAE_STATE', requestId, this.app.getBridgeStateSnapshot());
					return;
				case 'BAE_GET_SELECTION':
					this.postToWindow('BAE_SELECTION', requestId, this.app.getBridgeSelectionSnapshot());
					return;
				case 'BAE_GET_CACHE_EXPORT':
					this.postToWindow('BAE_CACHE_EXPORT', requestId, this.buildCacheExport(payload || {}));
					return;
				case 'BAE_FETCH_SELECTED': {
					await this.app.fetchSelectedAlbums({ requestId, emitBridgeProgress: true });
					this.postToWindow('BAE_OK', requestId, {
						action: type,
						state: this.app.getBridgeStateSnapshot(),
					});
					return;
				}
				case 'BAE_PLAY_FILE': {
					if (!this.validatePlayPayload(payload)) {
						this.postError(requestId, 'INVALID_PAYLOAD', 'BAE_PLAY_FILE requires payload.url.');
						return;
					}
					await this.app.openPlayerModal(payload.url, payload.title || 'Untitled');
					this.postToWindow('BAE_OK', requestId, {
						action: type,
						url: payload.url,
						title: payload.title || 'Untitled',
					});
					return;
				}
				case 'BAE_COMPARE_SET': {
					if (!this.validateComparePayload(payload)) {
						this.postError(requestId, 'INVALID_PAYLOAD', 'BAE_COMPARE_SET requires payload.slot and payload.url.');
						return;
					}
					await this.app.setCompareSlot(payload.slot, payload.url, payload.title || 'Untitled');
					this.postToWindow('BAE_OK', requestId, {
						action: type,
						slot: payload.slot,
						url: payload.url,
						title: payload.title || 'Untitled',
						compareSlots: this.app.getBridgeStateSnapshot().compareSlots,
					});
					return;
				}
				default:
					return;
			}
		}
	}

	class BunkrAlbumsEnhanced {
		constructor() {
			this.nextPage = 2;
			this.loading = false;
			this.previewTimeout = null;
			this.domObserver = null;
			this.reconcileTimer = null;
			this.albumCache = new Map();
			this.persistentAlbumCache = loadPersistentAlbumCache();
			this.persistentCacheSaveTimer = null;
			this.selectedAlbumUrls = new Set();
			this.activeGlobalFilter = '';
			this.activeMinCount = 0;
			this.activeMinSizeBytes = 0;
			this.activeUpdatedWithinDays = 0;
			this.activeQualityMin = 0;
			this.selectionMode = false;
			this.resultsLayout = localStorage.getItem(STORAGE_KEYS.resultsLayout) || 'grid';
			// Expanding a whole album inside a grid card causes severe layout
			// shift. Keep it opt-in; users can enable it from the command bar.
			this.hoverPreviewsEnabled = localStorage.getItem(STORAGE_KEYS.hoverPreviews) === '1';
			this.compareSlots = { A: null, B: null };
			this.playerModal = null;
			this.floatingPlayers = null;
			this.isTopAlbumsPage = window.location.pathname.includes('/topalbums');
			this.initialized = false;

			// Register bridge listener early so extension requests are not missed
			// while init() is still wiring UI/observers on heavy pages.
			this.bridge = new BaeExtensionBridge(this);
			this.bridge.setReady();
			// Defer heavy page init to next tick so bridge messages can be handled immediately.
			setTimeout(() => this.init(), 0);
		}

		init() {
			const containerReady = getAlbumsGridContainer(document);
			if (!containerReady) {
				setTimeout(() => this.init(), 350);
				return;
			}
			if (this.initialized) return;
			this.initialized = true;

			this.setupInfiniteScroll();
			this.setupAllHoverPreviews();
			this.dedupeAlbums();
			this.observeAlbumContainer();
			addSortingControls();
			this.hydrateVisibleAlbumsFromPersistentCache();
			this.updateDashboard();
			window.addEventListener('bae-global-filter', (e) => {
				this.activeGlobalFilter = (e && e.detail) || '';
				this.applyGlobalFilter(this.activeGlobalFilter);
			});
			window.addEventListener('bae-min-filter', (e) => {
				const { minCount, minSizeRaw, updatedWithinDays, qualityMin } = e?.detail || {};
				this.activeMinCount = parseInt(minCount || '0', 10) || 0;
				this.activeMinSizeBytes = parseSizeToBytes(minSizeRaw || '') || 0;
				this.activeUpdatedWithinDays = parseInt(updatedWithinDays || '0', 10) || 0;
				this.activeQualityMin = parseInt(qualityMin || '0', 10) || 0;
				this.applyGlobalFilter(this.activeGlobalFilter);
				const hidden = Array.from(getAlbumsGridContainer(document)?.children || []).filter(a => a.style.display === 'none').length;
				this.emitStatus(`Filters applied — ${hidden} albums hidden.`);
			});
			window.addEventListener('bae-results-layout', (e) => {
				this.resultsLayout = (e && e.detail) || 'grid';
				this.applyGlobalFilter(this.activeGlobalFilter);
			});
			window.addEventListener('bae-hover-previews', (e) => {
				this.hoverPreviewsEnabled = e?.detail === true;
				clearTimeout(this.previewTimeout);
				if (!this.hoverPreviewsEnabled) {
					this.qsa('.album-preview-flex').forEach((container) => {
						container.style.display = 'none';
					});
				}
				this.emitStatus(`Hover previews ${this.hoverPreviewsEnabled ? 'enabled' : 'disabled'}.`);
			});
			window.addEventListener('bae-fetch-visible', async (e) => {
				const count = parseInt((e && e.detail) || '100', 10);
				await this.fetchVisibleAlbums(Number.isFinite(count) ? count : 100);
			});
			document.addEventListener('keydown', (e) => this.handleGlobalShortcuts(e));
		}

		handleGlobalShortcuts(e) {
			if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
				const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
				if (tag !== 'input' && tag !== 'textarea') {
					e.preventDefault();
					const input = this.qs('.bae-global-filter');
					if (input) input.focus();
				}
			}

			if (e.key === 'Escape') {
				this.closePlayerModal();
				this.closeFloatingPlayers();
			}
		}

		initStickySelectionBar() {
			const bar = this.qs('.bae-sticky-selection-bar');
			if (!bar || bar.dataset.initialized === '1') return;
			bar.dataset.initialized = '1';

			const count = document.createElement('span');
			count.className = 'bae-sticky-count';
			count.style = 'color: #e2e8f0; font-size: 12px;';

			const clearBtn = document.createElement('button');
			clearBtn.textContent = 'Clear';
			clearBtn.style = 'padding: 6px 8px; border-radius: 7px; border: 1px solid #475569; background: #1e293b; color: #f8fafc; font-size: 11px; cursor: pointer;';
			clearBtn.addEventListener('click', () => this.clearAlbumSelection());

			bar.append(count, clearBtn);
		}

		updateSelectionBar() {
			const bar = this.qs('.bae-sticky-selection-bar');
			if (!bar) return;
			const count = this.qs('.bae-sticky-count', bar);
			if (count) count.textContent = `Selected: ${this.selectedAlbumUrls.size}`;
			bar.style.display = this.selectedAlbumUrls.size > 0 ? 'inline-flex' : 'none';
		}

		qs(selector, el = document) {
			return el.querySelector(selector);
		}

		qsa(selector, el = document) {
			return Array.from(el.querySelectorAll(selector));
		}

		getCurrentParams() {
			const params = new URLSearchParams(window.location.search);
			return this.isTopAlbumsPage ? { lapse: params.get('lapse') || '24h', page: this.nextPage } : { search: params.get('search') || '', page: this.nextPage };
		}

		getAlbumDomain(albumUrl) {
			const match = albumUrl.match(/https:\/\/(bunkr\.[a-z]+)/);
			return match ? match[1] : 'bunkr.cr';
		}

		setupInfiniteScroll() {
			if (!this.isLastPage()) {
				window.addEventListener('scroll', this.handleScroll.bind(this));
			}
		}

		isLastPage() {
			return !!this.qs('.text-center.text-xs.text-subtle');
		}

		handleScroll() {
			if (this.loading) return;
			const scrollPosition = window.innerHeight + window.scrollY;
			if (scrollPosition >= document.body.offsetHeight - CONFIG.scrollThreshold) {
				this.loadNextPage();
			}
		}

		async loadNextPage() {
			this.loading = true;
			const params = this.getCurrentParams();
			const url = this.isTopAlbumsPage
				? `/topalbums?lapse=${params.lapse}&page=${params.page}`
				: window.location.search.includes('search=')
					? `/?search=${encodeURIComponent(params.search)}&page=${params.page}`
					: `/?page=${params.page}`;

			try {
				const response = await fetch(url);
				if (!response.ok) throw new Error(`Failed to load page ${params.page}`);

				const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
				const newAlbums = getAlbumCards(doc);
				const container = getAlbumsGridContainer(doc) || getAlbumsGridContainer(document);

				if (newAlbums.length && container) {
					newAlbums.forEach((album) => this.setupHoverPreview(album));
					container.append(...newAlbums);
					this.dedupeAlbums();
					this.hydrateVisibleAlbumsFromPersistentCache();
					this.nextPage++;
					this.updateDashboard();

					// reapply sort if user selected a sort option
					const sortMethod = document.querySelector('select')?.value;
					if (sortMethod && sortMethod !== 'default') sortAlbums(sortMethod);
				} else {
					window.removeEventListener('scroll', this.handleScroll);
				}
			} catch (error) {
				console.error('[Bunkr Albums Enhanced]', error);
			} finally {
				this.loading = false;
			}
		}

		setupAllHoverPreviews() {
			getAlbumCards(document).forEach((album) => {
				this.setupHoverPreview(album);
			});
		}

		observeAlbumContainer() {
			const container = getAlbumsGridContainer(document);
			if (!container) return;

			this.domObserver = new MutationObserver((mutations) => {
				let hasAlbumChanges = false;
				for (const mutation of mutations) {
					if (mutation.addedNodes?.length) {
						hasAlbumChanges = true;
						break;
					}
				}

				if (!hasAlbumChanges) return;

				clearTimeout(this.reconcileTimer);
				this.reconcileTimer = setTimeout(() => {
					this.setupAllHoverPreviews();
					this.dedupeAlbums();
				}, 100);
			});

			this.domObserver.observe(container, { childList: true, subtree: false });
		}

		dedupeAlbums() {
			const container = getAlbumsGridContainer(document);
			if (!container) return;

			const seen = new Set();
			const albums = Array.from(container.children);

			albums.forEach((album) => {
				if (!(album instanceof HTMLElement)) return;
				const key = getAlbumDedupKeyFromCard(album);
				if (!key) return;
				if (seen.has(key)) {
					album.remove();
					return;
				}
				seen.add(key);
			});
		}

		applyGlobalFilter(rawTerm) {
			const container = getAlbumsGridContainer(document);
			if (!container) return;

			const normalized = (rawTerm || '').trim().toLowerCase();
			const terms = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
			this.renderGlobalFileResults(terms);

			const minCount = this.activeMinCount || 0;
			const minSize = this.activeMinSizeBytes || 0;
			const updatedWithinDays = this.activeUpdatedWithinDays || 0;
			const qualityMin = this.activeQualityMin || 0;
			const newestAllowedCutoff = updatedWithinDays > 0
				? Date.now() - (updatedWithinDays * 24 * 60 * 60 * 1000)
				: 0;

			Array.from(container.children).forEach((album) => {
				if (!(album instanceof HTMLElement)) return;

				// Text filter
				if (terms.length) {
					const albumName = getAlbumTitleFromCard(album).toLowerCase();
					const cachedIndex = (album.dataset.previewIndex || '').toLowerCase();
					const haystack = `${albumName} ${cachedIndex}`;
					if (!terms.every((term) => haystack.includes(term))) {
						album.style.display = 'none';
						return;
					}
				}

				// Min file count (only if data fetched — dataset.totalSizeBytes is set after fetch)
				if (minCount > 0 && album.dataset.totalSizeBytes !== undefined && album.dataset.totalSizeBytes !== '') {
					const fileCount = parseInt(album.dataset.fileCount || '0', 10);
					// Also check the raw card file count as fallback
					const cardCount = getAlbumFileCountFromCard(album);
					const count = fileCount || cardCount || 0;
					if (count > 0 && count < minCount) {
						album.style.display = 'none';
						return;
					}
				}

				// Min size (only if data fetched)
				if (minSize > 0 && album.dataset.totalSizeBytes) {
					const albumSize = parseFloat(album.dataset.totalSizeBytes || '0') || 0;
					if (albumSize > 0 && albumSize < minSize) {
						album.style.display = 'none';
						return;
					}
				}

				if (qualityMin > 0) {
					const albumSize = parseFloat(album.dataset.totalSizeBytes || '0') || 0;
					const videoCount = parseInt(album.dataset.fileCount || '0', 10) || 0;
					if (getVideoQualityLevel(albumSize, videoCount) < qualityMin) {
						album.style.display = 'none';
						return;
					}
				}

				// The newest timestamp comes from the newest fetched video. When this
				// filter is active, unknown dates are hidden too: they cannot prove
				// that an album is recent.
				if (newestAllowedCutoff > 0) {
					const newestTimestamp = parseInt(album.dataset.newestDate || '0', 10) || 0;
					if (!newestTimestamp || newestTimestamp < newestAllowedCutoff) {
						album.style.display = 'none';
						return;
					}
				}

				album.style.display = '';
			});
			this.updateDashboard();
		}

		renderGlobalFileResults(terms) {
			const panel = this.qs('.bae-file-results-panel');
			if (!panel) return;

			if (!terms.length) {
				panel.style.display = 'none';
				panel.innerHTML = '';
				return;
			}

			const rows = [];
			this.albumCache.forEach((metadata) => {
				const albumName = (metadata.albumName || '').toLowerCase();
				(metadata.files || []).forEach((file) => {
					const title = (file.title || '').toLowerCase();
					const size = (file.size || '').toLowerCase();
					const haystack = `${title} ${size} ${albumName}`;
					if (terms.every((t) => haystack.includes(t))) {
						rows.push({
							albumName: metadata.albumName || 'Album',
							albumDomain: metadata.albumDomain,
							file,
						});
					}
				});
			});

			if (!rows.length) {
				panel.style.display = 'block';
				panel.innerHTML = '<div style="padding:10px 12px;color:#94a3b8;font-size:12px;">No cached file matches. Use Fetch Selected first.</div>';
				return;
			}

			rows.sort((a, b) => (b.file.timestamp || 0) - (a.file.timestamp || 0));
			const limited = rows.slice(0, CONFIG.maxGlobalFileRows);

			panel.innerHTML = '';
			const header = document.createElement('div');
			header.style = 'padding:8px 12px; border-bottom:1px solid #334155; color:#cbd5e1; font-size:12px; display:flex; justify-content:space-between; align-items:center; gap:10px;';
			header.textContent = `File results: ${limited.length}/${rows.length}`;

			const mode = document.createElement('span');
			mode.style = 'color:#93c5fd; font-size:11px;';
			mode.textContent = `Mode: ${this.resultsLayout === 'list' ? 'List' : 'Grid'}`;
			header.appendChild(mode);
			panel.appendChild(header);

			const list = document.createElement('div');
			if (this.resultsLayout === 'list') {
				list.style = 'max-height: 420px; overflow: auto;';
			} else {
				list.style = 'max-height: 520px; overflow: auto; padding: 10px; display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px;';
			}

			limited.forEach((row) => {
				list.appendChild(this.buildFileResultItem(row));
			});

			panel.appendChild(list);
			panel.style.display = 'block';
		}

		buildFileResultItem(row) {
			const fileUrl = `https://${row.albumDomain}${row.file.href}`;
			const dateText = row.file.timestamp ? new Date(row.file.timestamp).toLocaleDateString('en-GB') : 'n/a';

			const item = document.createElement('div');
			item.style = this.resultsLayout === 'list'
				? 'display:flex; align-items:center; gap:10px; padding:8px 12px; border-bottom:1px solid #1e293b;'
				: 'display:flex; flex-direction:column; gap:8px; padding:8px; border:1px solid #1e293b; border-radius:8px; background:#0f172a;';

			const thumb = document.createElement('img');
			thumb.src = row.file.thumbSrc || '';
			thumb.alt = 'thumb';
			thumb.style = this.resultsLayout === 'list'
				? 'width:88px; height:50px; object-fit:cover; border-radius:4px; border:1px solid #334155; background:#020617;'
				: 'width:100%; height:150px; object-fit:cover; border-radius:6px; border:1px solid #334155; background:#020617;';

			const textWrap = document.createElement('div');
			textWrap.style = 'display:flex; flex-direction:column; min-width:0; flex:1; gap:4px;';

			const title = document.createElement('div');
			title.textContent = row.file.title || 'Untitled';
			title.style = 'font-size:12px; color:#f8fafc; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';

			const sub = document.createElement('div');
			sub.textContent = `${row.albumName} • ${row.file.size || '-'} • ${dateText}`;
			sub.style = 'font-size:11px; color:#94a3b8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';

			const actions = document.createElement('div');
			actions.style = 'display:flex; gap:6px; flex-wrap:wrap;';

			const playBtn = document.createElement('button');
			playBtn.textContent = 'Play';
			playBtn.style = 'padding:4px 8px; border-radius:6px; border:1px solid #334155; background:#1e293b; color:#f8fafc; font-size:11px; cursor:pointer;';
			playBtn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.openPlayerModal(fileUrl, row.file.title || 'Untitled');
			});

			const compareABtn = document.createElement('button');
			compareABtn.textContent = 'Compare A';
			compareABtn.style = 'padding:4px 8px; border-radius:6px; border:1px solid #334155; background:#0f766e; color:#ecfeff; font-size:11px; cursor:pointer;';
			compareABtn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.setCompareSlot('A', fileUrl, row.file.title || 'Untitled');
			});

			const compareBBtn = document.createElement('button');
			compareBBtn.textContent = 'Compare B';
			compareBBtn.style = 'padding:4px 8px; border-radius:6px; border:1px solid #334155; background:#7c2d12; color:#fff7ed; font-size:11px; cursor:pointer;';
			compareBBtn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.setCompareSlot('B', fileUrl, row.file.title || 'Untitled');
			});

			const openBtn = document.createElement('a');
			openBtn.href = fileUrl;
			openBtn.target = '_blank';
			openBtn.rel = 'noopener noreferrer';
			openBtn.textContent = 'Open';
			openBtn.style = 'padding:4px 8px; border-radius:6px; border:1px solid #334155; background:#111827; color:#cbd5e1; font-size:11px; text-decoration:none;';

			actions.append(playBtn, compareABtn, compareBBtn, openBtn);
			textWrap.append(title, sub, actions);
			item.append(thumb, textWrap);
			return item;
		}

		async openPlayerModal(url, title) {
			if (!this.playerModal) {
				const overlay = document.createElement('div');
				overlay.className = 'bae-player-modal';
				overlay.style = 'position:fixed; inset:0; z-index:100000; background:rgba(2,6,23,0.72); display:none; align-items:center; justify-content:center; padding:20px;';

				const card = document.createElement('div');
				card.style = 'width:min(1000px, 96vw); background:#0b1220; border:1px solid #334155; border-radius:10px; padding:10px;';

				const head = document.createElement('div');
				head.style = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:10px;';

				const hTitle = document.createElement('div');
				hTitle.className = 'bae-player-title';
				hTitle.style = 'color:#f8fafc; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';

				const close = document.createElement('button');
				close.textContent = 'Close';
				close.style = 'padding:5px 8px; border-radius:6px; border:1px solid #475569; background:#1e293b; color:#f8fafc; font-size:11px; cursor:pointer;';
				close.addEventListener('click', () => this.closePlayerModal());

				const video = document.createElement('video');
				video.className = 'bae-player-video';
				video.controls = true;
				video.style = 'width:100%; max-height:75vh; border-radius:8px; background:#000;';

				head.append(hTitle, close);
				card.append(head, video);
				overlay.appendChild(card);
				overlay.addEventListener('click', (e) => {
					if (e.target === overlay) this.closePlayerModal();
				});
				document.body.appendChild(overlay);
				this.playerModal = overlay;
			}

			const titleEl = this.qs('.bae-player-title', this.playerModal);
			const videoEl = this.qs('.bae-player-video', this.playerModal);
			if (titleEl) titleEl.textContent = `${title} — resolving…`;
			if (videoEl) { videoEl.removeAttribute('src'); videoEl.load(); }
			this.playerModal.style.display = 'flex';

			const streamUrl = await resolveBunkrStreamUrl(url);
			if (titleEl) titleEl.textContent = title;
			if (videoEl) {
				videoEl.src = streamUrl;
				videoEl.currentTime = 0;
				videoEl.play().catch(() => {});
			}
		}

		closePlayerModal() {
			if (!this.playerModal) return;
			const videoEl = this.qs('.bae-player-video', this.playerModal);
			if (videoEl) {
				videoEl.pause();
				videoEl.removeAttribute('src');
				videoEl.load();
			}
			this.playerModal.style.display = 'none';
		}

		ensureFloatingPlayers() {
			if (this.floatingPlayers) return;
			const root = document.createElement('div');
			root.className = 'bae-floating-players';
			root.style = 'position:fixed; left:12px; bottom:12px; z-index:100001; display:flex; gap:10px; pointer-events:none;';

			const makeSlot = (slot) => {
				const card = document.createElement('div');
				card.className = `bae-float-${slot}`;
				card.style = 'width:340px; background:rgba(2,6,23,0.96); border:1px solid #334155; border-radius:10px; padding:8px; display:none; pointer-events:auto;';

				const head = document.createElement('div');
				head.style = 'display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:6px;';
				const title = document.createElement('div');
				title.className = 'bae-float-title';
				title.style = 'font-size:11px; color:#e2e8f0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';

				const close = document.createElement('button');
				close.textContent = 'x';
				close.style = 'padding:2px 6px; border-radius:5px; border:1px solid #475569; background:#1e293b; color:#f8fafc; font-size:11px; cursor:pointer;';
				close.addEventListener('click', () => {
					const video = this.qs('video', card);
					if (video) video.pause();
					card.style.display = 'none';
					this.compareSlots[slot] = null;
				});

				const video = document.createElement('video');
				video.controls = true;
				video.style = 'width:100%; height:190px; border-radius:8px; background:#000;';

				head.append(title, close);
				card.append(head, video);
				return card;
			};

			root.append(makeSlot('A'), makeSlot('B'));
			document.body.appendChild(root);
			this.floatingPlayers = root;
		}

		async setCompareSlot(slot, url, title) {
			this.ensureFloatingPlayers();
			const card = this.qs(`.bae-float-${slot}`, this.floatingPlayers);
			if (!card) return;
			const titleEl = this.qs('.bae-float-title', card);
			const video = this.qs('video', card);
			if (titleEl) titleEl.textContent = `${slot}: resolving…`;
			if (video) { video.removeAttribute('src'); video.load(); }
			card.style.display = 'block';
			this.compareSlots[slot] = { url, title };

			const streamUrl = await resolveBunkrStreamUrl(url);
			if (titleEl) titleEl.textContent = `${slot}: ${title}`;
			if (video) {
				video.src = streamUrl;
				video.muted = slot === 'B';
				video.currentTime = 0;
				video.play().catch(() => {});
			}
		}

		closeFloatingPlayers() {
			if (!this.floatingPlayers) return;
			['A', 'B'].forEach((slot) => {
				const card = this.qs(`.bae-float-${slot}`, this.floatingPlayers);
				if (!card) return;
				const video = this.qs('video', card);
				if (video) {
					video.pause();
					video.removeAttribute('src');
					video.load();
				}
				card.style.display = 'none';
				this.compareSlots[slot] = null;
			});
		}

		emitStatus(message) {
			window.dispatchEvent(new CustomEvent('bae-status', { detail: message || '' }));
		}

		getBridgeSelectionSnapshot() {
			return {
				selectedAlbumUrls: Array.from(this.selectedAlbumUrls),
				count: this.selectedAlbumUrls.size,
			};
		}

		getBridgeStateSnapshot() {
			const cachedAlbums = Array.from(this.albumCache.values());
			const cachedFiles = cachedAlbums.reduce((sum, album) => sum + (album.fileCount || 0), 0);
			return {
				ready: true,
				selectionMode: this.selectionMode,
				resultsLayout: this.resultsLayout,
				activeGlobalFilter: this.activeGlobalFilter,
				selectedCount: this.selectedAlbumUrls.size,
				visibleAlbumCount: this.getVisibleAlbums().length,
				cache: {
					albumCount: cachedAlbums.length,
					fileCount: cachedFiles,
				},
				compareSlots: {
					A: this.compareSlots.A ? { title: this.compareSlots.A.title || '', url: this.compareSlots.A.url || '' } : null,
					B: this.compareSlots.B ? { title: this.compareSlots.B.title || '', url: this.compareSlots.B.url || '' } : null,
				},
				playerModalOpen: !!(this.playerModal && this.playerModal.style.display !== 'none'),
				capabilities: Array.from(BAE_BRIDGE_EXTENSION_TYPES),
			};
		}

		getVisibleAlbums() {
			return getAlbumCards(document).filter((album) => album.style.display !== 'none');
		}

		hydrateVisibleAlbumsFromPersistentCache() {
			const entries = this.persistentAlbumCache?.entries || {};
			let restored = 0;
			getAlbumCards(document).forEach((album) => {
				const albumUrl = getAlbumUrlFromCard(album);
				const stored = entries[getPersistentAlbumKey(albumUrl)];
				if (!stored) return;
				const metadata = {
					...stored,
					albumUrl,
					albumDomain: this.getAlbumDomain(albumUrl),
					files: [],
					fromPersistentCache: true,
				};
				this.albumCache.set(getNormalizedAlbumUrl(albumUrl), metadata);
				this.applyMetadataToAlbumCard(album, metadata);
				restored += 1;
			});
			if (restored) this.emitStatus(`Restored ${restored} cached album(s) instantly.`);
		}

		queuePersistentAlbumSave(metadata) {
			if (!metadata?.albumUrl) return;
			const key = getPersistentAlbumKey(metadata.albumUrl);
			this.persistentAlbumCache.entries[key] = {
				albumName: metadata.albumName || '',
				fileCount: metadata.fileCount || 0,
				totalBytes: metadata.totalBytes || 0,
				oldestTimestamp: metadata.oldestTimestamp || 0,
				newestTimestamp: metadata.newestTimestamp || 0,
				previewIndex: (metadata.previewIndex || '').slice(0, 2000),
				fetchedAt: metadata.fetchedAt || Date.now(),
			};
			clearTimeout(this.persistentCacheSaveTimer);
			this.persistentCacheSaveTimer = setTimeout(() => this.flushPersistentAlbumCache(), 180);
		}

		flushPersistentAlbumCache() {
			clearTimeout(this.persistentCacheSaveTimer);
			this.persistentCacheSaveTimer = null;
			try {
				const entries = Object.entries(this.persistentAlbumCache.entries || {});
				if (entries.length > MAX_PERSISTENT_ALBUMS) {
					entries.sort((a, b) => (b[1].fetchedAt || 0) - (a[1].fetchedAt || 0));
					this.persistentAlbumCache.entries = Object.fromEntries(entries.slice(0, MAX_PERSISTENT_ALBUMS));
				}
				GM_setValue(PERSISTENT_CACHE_KEY, this.persistentAlbumCache);
			} catch (error) {
				console.warn('[Bunkr Albums Enhanced] Could not save persistent album cache:', error);
			}
		}

		updateDashboard() {
			const dashboard = this.qs('.bae-dashboard');
			if (!dashboard) return;
			const cachedAlbums = Array.from(this.albumCache.values());
			const allCards = getAlbumCards(document);
			const visibleCards = allCards.filter((album) => album.style.display !== 'none');
			const totalVideos = cachedAlbums.reduce((sum, album) => sum + (album.fileCount || 0), 0);
			const totalBytes = cachedAlbums.reduce((sum, album) => sum + (album.totalBytes || 0), 0);
			const freshCutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
			const freshCount = cachedAlbums.filter((album) => (album.newestTimestamp || 0) >= freshCutoff).length;
			const highCount = cachedAlbums.filter((album) => getVideoQualityLevel(album.totalBytes || 0, album.fileCount || 0) >= 2).length;
			const stats = { fetched: cachedAlbums.length, visible: visibleCards.length, videos: totalVideos.toLocaleString(), size: formatBytes(totalBytes), fresh: freshCount, quality: highCount };
			Object.entries(stats).forEach(([key, value]) => {
				const node = this.qs(`[data-stat="${key}"]`, dashboard);
				if (node) node.textContent = `${value}`;
			});

			const strip = this.qs('.bae-signal-strip', dashboard);
			if (!strip) return;
			strip.innerHTML = '';
			allCards.slice(0, 100).forEach((album) => {
				const signal = document.createElement('span');
				signal.className = 'bae-signal';
				const newest = parseInt(album.dataset.newestDate || '0', 10) || 0;
				const ageDays = newest ? (Date.now() - newest) / (24 * 60 * 60 * 1000) : Infinity;
				signal.dataset.state = !newest ? 'unknown' : ageDays <= 30 ? 'fresh' : ageDays <= 90 ? 'warm' : 'old';
				if (album.style.display === 'none') signal.dataset.state = 'hidden';
				signal.title = `${getAlbumTitleFromCard(album) || 'Album'}${newest ? ` · ${Math.max(0, Math.floor(ageDays))}d` : ' · not fetched'}`;
				strip.appendChild(signal);
			});
		}

		selectTopVisibleAlbums(count) {
			const limit = Math.max(1, count || 10);
			const visible = this.getVisibleAlbums();
			this.clearAlbumSelection();
			visible.slice(0, limit).forEach((album) => {
				const checkbox = this.qs('.bae-select-album-checkbox', album);
				if (checkbox) {
					checkbox.checked = true;
					checkbox.dispatchEvent(new Event('change', { bubbles: true }));
				}
			});
			this.updateSelectionBar();
			this.emitStatus(`Selected ${Math.min(limit, visible.length)} albums.`);
		}

		clearAlbumSelection() {
			this.selectedAlbumUrls.clear();
			this.qsa('.bae-select-album-checkbox').forEach((cb) => {
				cb.checked = false;
			});
			this.updateSelectionBar();
			this.emitStatus('Selection cleared.');
		}

		getAlbumCardByUrl(albumUrl) {
			const key = getNormalizedAlbumUrl(albumUrl);
			return getAlbumCards(document).find((album) => {
				const href = getAlbumUrlFromCard(album);
				if (!href) return false;
				return getNormalizedAlbumUrl(href) === key;
			}) || null;
		}

		ensureAlbumMetaBadge(album) {
			// Try multiple selectors — bunkr card structure varies
			const container = this.qs('.flex-1.grid.auto-rows-max', album)
				|| this.qs('.p-3\\.5', album)
				|| this.qs('[class*="p-3"]', album)
				|| album;
			if (!container) return null;
			let meta = this.qs('.bae-album-meta', album);
			if (!meta) {
				meta = document.createElement('div');
				meta.className = 'bae-album-meta';
				meta.style = 'font-size: 11px; color: #9ca3af; margin-top: 4px; line-height: 1.3; min-height: 14px; padding: 0 4px;';
				// Insert after album title or file-count line, or append to container
				const titleLine = this.qs('p.text-subs', container) || this.qs('h3', container) || this.qs('p', container);
				if (titleLine && titleLine.parentElement) {
					titleLine.parentElement.insertBefore(meta, titleLine.nextSibling);
				} else {
					container.appendChild(meta);
				}
			}
			return meta;
		}

		ensureAlbumSelectControl(album, albumUrl) {
			if (this.qs('.bae-album-controls', album)) return;

			const controls = document.createElement('div');
			controls.className = 'bae-album-controls';
			controls.style = 'display: inline-flex; align-items: center; gap: 8px; margin: 4px 0; padding: 6px 8px; position: relative; z-index: 9999; pointer-events: auto; border: 1px solid #334155; border-radius: 8px; background: rgba(15,23,42,0.7); max-width: fit-content;';
			controls.addEventListener('click', (e) => e.stopPropagation());
			controls.addEventListener('mousedown', (e) => e.stopPropagation());
			controls.addEventListener('mouseup', (e) => e.stopPropagation());
			controls.addEventListener('pointerdown', (e) => e.stopPropagation());
			controls.addEventListener('pointerup', (e) => e.stopPropagation());

			const label = document.createElement('label');
			label.style = 'display: inline-flex; align-items: center; gap: 6px; color: #cbd5e1; font-size: 11px; cursor: pointer; user-select: none;';

			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.className = 'bae-select-album-checkbox';
			checkbox.style = 'cursor: pointer;';
			checkbox.addEventListener('click', (e) => e.stopPropagation());
			checkbox.addEventListener('change', (e) => {
				e.stopPropagation();
				const key = getNormalizedAlbumUrl(albumUrl);
				if (checkbox.checked) {
					this.selectedAlbumUrls.add(key);
				} else {
					this.selectedAlbumUrls.delete(key);
				}
				this.updateSelectionBar();
				this.emitStatus(`Selected ${this.selectedAlbumUrls.size} album(s).`);
			});

			const text = document.createElement('span');
			text.textContent = 'Select for batch fetch';
			label.addEventListener('click', (e) => e.stopPropagation());

			label.append(checkbox, text);
			controls.appendChild(label);
			album.insertBefore(controls, album.firstChild);
		}

		applyMetadataToAlbumCard(album, metadata) {
			if (!album || !metadata) return;
			album.dataset.oldestDate = metadata.oldestTimestamp ? `${metadata.oldestTimestamp}` : '0';
			album.dataset.newestDate = metadata.newestTimestamp ? `${metadata.newestTimestamp}` : '0';
			album.dataset.totalSizeBytes = `${metadata.totalBytes || 0}`;
			album.dataset.fileCount = `${metadata.fileCount || 0}`;
			album.dataset.previewIndex = metadata.previewIndex || '';

			const parts = [];
			if (metadata.totalBytes > 0) parts.push(formatBytes(metadata.totalBytes));
			if (metadata.newestTimestamp) {
				parts.push('📅 ' + new Date(metadata.newestTimestamp).toLocaleDateString('en-GB'));
			}
			if (metadata.fileCount) parts.push(metadata.fileCount + ' Videos');
			const text = parts.join(' • ');
			if (!text) return;

			// Try structured badge first
			let metaNode = this.ensureAlbumMetaBadge(album);
			// Hard fallback — just find or create directly on album root
			if (!metaNode) {
				metaNode = album.querySelector('.bae-album-meta') || document.createElement('div');
				metaNode.className = 'bae-album-meta';
				if (!metaNode.parentElement) album.appendChild(metaNode);
			}

			metaNode.textContent = text;
			metaNode.style.cssText = 'font-size:11px; color:#4ade80; font-weight:600; margin-top:4px; padding:2px 6px; line-height:1.3; display:block;';

			// Replace Bunkr's original total-file label too, so the card never
			// presents an all-file count as if it were the video count.
			const sourceCount = this.qs('p.text-xs span', album)
				|| this.qsa('span', album).find((span) => /^\d+\s+files?$/i.test((span.textContent || '').trim()));
			if (sourceCount) sourceCount.textContent = `${metadata.fileCount || 0} Videos`;
			let cacheBadge = this.qs('.bae-cache-badge', album);
			if (metadata.fromPersistentCache) {
				if (!cacheBadge) {
					cacheBadge = document.createElement('span');
					cacheBadge.className = 'bae-cache-badge';
					cacheBadge.style.cssText = 'display:inline-flex;width:fit-content;margin:4px 4px 0;padding:2px 6px;border:1px solid #343844;border-radius:999px;color:#8b909b;font:700 9px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace;text-transform:uppercase;letter-spacing:.07em;';
					metaNode.insertAdjacentElement('afterend', cacheBadge);
				}
				cacheBadge.textContent = isAlbumCacheFresh(metadata) ? 'cached' : 'cached · refresh due';
				cacheBadge.title = metadata.fetchedAt ? `Saved ${new Date(metadata.fetchedAt).toLocaleString()}` : 'Restored from Tampermonkey cache';
			} else {
				cacheBadge?.remove();
			}

			const quality = getVideoQualityEstimate(metadata.totalBytes, metadata.fileCount);
			let qualityBadge = this.qs('.bae-video-quality', album);
			if (!quality) {
				qualityBadge?.remove();
				return;
			}
			if (!qualityBadge) {
				qualityBadge = document.createElement('span');
				qualityBadge.className = 'bae-video-quality';
				qualityBadge.style.cssText = 'display:inline-flex; width:fit-content; margin:4px 4px 0; padding:2px 6px; border:1px solid; border-radius:999px; font-size:10px; font-weight:700; line-height:1.35;';
				metaNode.insertAdjacentElement('afterend', qualityBadge);
			}
			qualityBadge.textContent = `≈ ${quality.label} · Ø ${formatBytes(quality.averageBytes)}/video`;
			qualityBadge.title = 'Estimated from average video file size. Duration, bitrate, and resolution are unknown.';
			qualityBadge.style.color = quality.color;
			qualityBadge.style.borderColor = quality.color;
		}

		applyMetadataToAllMatchingCards(albumUrl, metadata) {
			const key = getNormalizedAlbumUrl(albumUrl);
			getAlbumCards(document).forEach((album) => {
				const href = getAlbumUrlFromCard(album);
				if (!href) return;
				if (getNormalizedAlbumUrl(href) !== key) return;
				this.applyMetadataToAlbumCard(album, metadata);
			});
		}

		extractFileFromItem(item) {
			const selfLink = item && item.matches && item.matches("a[href^='/f/'], a[href^='/v/'], a[href*='/f/'], a[href*='/v/']") ? item : null;
			const fileLink = selfLink || this.qs("a[href^='/f/'], a[href^='/v/'], a[href*='/f/'], a[href*='/v/']", item);
			if (!fileLink) return null;
			const href = fileLink.getAttribute('href') || '';
			if (!href) return null;

			const text = item.textContent || '';
			const title = item.querySelector('p')?.textContent?.trim() || item.querySelector('.grid-images_box-name')?.textContent?.trim() || '';
			const size = extractSizeFromText(text) || this.qs('.grid-images_box-size', item)?.textContent?.trim() || '';
			const dateText = extractDateFromText(text);
			const dateObj = dateText ? parseBunkrDate(dateText) : null;
			const img = this.qs('.grid-images_box-img', item);
			// On the current Bunkr album page, only this badge distinguishes a
			// video from an image, archive, or other file type.
			const isVideo = !!this.qs('.type-Video', item);

			return {
				href,
				title,
				size,
				isVideo,
				thumbSrc: img?.src || '',
				timestamp: dateObj ? dateObj.getTime() : 0,
			};
		}

		extractFilesFromDoc(doc) {
			const found = [];
			const candidates = this.qsa('.grid-images .theItem, .theItem, [class*="grid-images_box"], [class*="grid-images"] a[href*="/f/"], [class*="grid-images"] a[href*="/v/"]', doc);
			const sourceItems = candidates.length ? candidates : this.qsa("a[href*='/f/'], a[href*='/v/']", doc);

			sourceItems.forEach((node) => {
				const item = node.matches && node.matches('a[href*="/f/"], a[href*="/v/"]') ? node.closest('.theItem, [class*="grid-images_box"]') || node : node;
				const file = this.extractFileFromItem(item);
				if (file) found.push(file);
			});
			return found;
		}

		async fetchAlbumData(albumUrl, albumCard, options = {}) {
			const cacheKey = getNormalizedAlbumUrl(albumUrl);
			if (this.albumCache.has(cacheKey)) {
				const cached = this.albumCache.get(cacheKey);
				if (albumCard) this.applyMetadataToAlbumCard(albumCard, cached);
				const needsFileRows = !!options.requireFiles && !(cached.files || []).length;
				if (!needsFileRows && isAlbumCacheFresh(cached)) return cached;
			}

			const firstResponse = await fetch(albumUrl);
			if (!firstResponse.ok) throw new Error('Failed to load album contents');
			const firstDoc = new DOMParser().parseFromString(await firstResponse.text(), 'text/html');
			const albumDomain = this.getAlbumDomain(albumUrl);
			const headerText = this.qs('h1 + p', firstDoc)?.textContent?.trim() || '';
			const metaMatch = headerText.match(/\(([^)]+)\)/);
			const albumMeta = metaMatch ? metaMatch[1] : '';

			const discoveredUrls = this.getAlbumPageUrls(firstDoc, albumUrl).slice(0, CONFIG.maxAlbumPagesToScan);
			const docs = [firstDoc];
			const extras = await Promise.all(
				discoveredUrls
					.filter((u) => u !== albumUrl)
					.map((u) =>
						fetch(u)
							.then((res) => {
								if (!res.ok) throw new Error(`Failed page ${u}`);
								return res.text();
							})
							.then((html) => new DOMParser().parseFromString(html, 'text/html'))
							.catch(() => null)
					)
			);
			extras.forEach((d) => {
				if (d) docs.push(d);
			});

			const seen = new Set();
			const files = [];
			let totalBytes = 0;
			let oldestTimestamp = 0;
			let newestTimestamp = 0;

				docs.forEach((doc) => {
				this.extractFilesFromDoc(doc).forEach((file) => {
					if (!file) return;
					if (!file.isVideo) return;
					if (seen.has(file.href)) return;
					seen.add(file.href);
					files.push(file);
					if (file.size) totalBytes += parseSizeToBytes(file.size);
					if (file.timestamp > 0) {
						if (!oldestTimestamp || file.timestamp < oldestTimestamp) oldestTimestamp = file.timestamp;
						if (!newestTimestamp || file.timestamp > newestTimestamp) newestTimestamp = file.timestamp;
					}
				});
			});

			const metadata = {
				albumUrl,
				albumDomain,
				albumName: this.qs('h1', firstDoc)?.textContent?.trim() || getAlbumTitleFromCard(albumCard) || albumUrl,
				files,
				fileCount: files.length,
				totalBytes,
				oldestTimestamp,
				newestTimestamp,
				previewIndex: files.map((f) => (f.title || '').toLowerCase()).filter(Boolean).join(' '),
				fetchedAt: Date.now(),
				fromPersistentCache: false,
			};

			this.albumCache.set(cacheKey, metadata);
			this.queuePersistentAlbumSave(metadata);
			if (albumCard) this.applyMetadataToAlbumCard(albumCard, metadata);
			this.applyMetadataToAllMatchingCards(albumUrl, metadata);
			return metadata;
		}

		async processWithConcurrency(items, limit, worker) {
			const queue = [...items];
			const running = [];
			const max = Math.max(1, limit || 1);

			for (let i = 0; i < max; i++) {
				running.push(
					(async () => {
						while (queue.length) {
							const item = queue.shift();
							if (!item) return;
							await worker(item);
						}
					})()
				);
			}

			await Promise.all(running);
		}

		async fetchVisibleAlbums(limit = 100) {
			const albumUrls = this.getVisibleAlbums()
				.slice(0, Math.max(1, limit || 100))
				.map((album) => getNormalizedAlbumUrl(getAlbumUrlFromCard(album)))
				.filter(Boolean);

			const previousSelection = this.selectedAlbumUrls;
			this.selectedAlbumUrls = new Set(albumUrls);
			try {
				await this.fetchSelectedAlbums();
			} finally {
				this.selectedAlbumUrls = previousSelection;
			}
		}

		async fetchSelectedAlbums(options = {}) {
			const selected = Array.from(this.selectedAlbumUrls);
			const requestId = options && typeof options.requestId === 'string' ? options.requestId : '';
			const emitBridgeProgress = !!(options && options.emitBridgeProgress && this.bridge);
			if (!selected.length) {
				this.emitStatus('No albums to fetch.');
				if (emitBridgeProgress) {
					this.bridge.emitFetchProgress(requestId, 'empty', {
						total: 0,
						processed: 0,
						status: 'No albums to fetch.',
					});
				}
				return;
			}

			let done = 0;
			this.emitStatus(`Fetching albums: 0/${selected.length}`);
			if (emitBridgeProgress) {
				this.bridge.emitFetchProgress(requestId, 'start', {
					total: selected.length,
					processed: 0,
					status: `Fetching albums: 0/${selected.length}`,
				});
			}
			try {
				await this.processWithConcurrency(selected, CONFIG.concurrentAlbumFetches, async (normalizedUrl) => {
					const album = this.getAlbumCardByUrl(normalizedUrl);
					const realUrl = album ? getAlbumUrlFromCard(album) : normalizedUrl;
					if (!realUrl) return;
					await this.fetchAlbumData(realUrl, album);
					done += 1;
					this.updateDashboard();
					const status = `Fetching albums: ${done}/${selected.length}`;
					this.emitStatus(status);
					if (emitBridgeProgress) {
						this.bridge.emitFetchProgress(requestId, 'progress', {
							total: selected.length,
							processed: done,
							albumUrl: normalizedUrl,
							status,
						});
					}
				});
			} catch (error) {
				if (emitBridgeProgress) {
					this.bridge.emitFetchProgress(requestId, 'error', {
						total: selected.length,
						processed: done,
						status: error?.message || 'Fetch failed.',
					});
				}
				throw error;
			}

			this.applyGlobalFilter(this.activeGlobalFilter);
			this.flushPersistentAlbumCache();
			this.emitStatus(`Fetched video metadata for ${selected.length} album(s).`);
			if (emitBridgeProgress) {
				this.bridge.emitFetchProgress(requestId, 'complete', {
					total: selected.length,
					processed: done,
					status: `Fetched video metadata for ${selected.length} album(s).`,
					state: this.getBridgeStateSnapshot(),
				});
			}
		}

		async copySelectedFileNames() {
			const selected = Array.from(this.selectedAlbumUrls);
			if (!selected.length) {
				this.emitStatus('No albums selected.');
				return;
			}

			const blocks = [];
			for (const normalizedUrl of selected) {
				const card = this.getAlbumCardByUrl(normalizedUrl);
				const realUrl = card ? getAlbumUrlFromCard(card) : normalizedUrl;
				if (!realUrl) continue;
				const data = await this.fetchAlbumData(realUrl, card, { requireFiles: true });
				const albumName = getAlbumTitleFromCard(card) || realUrl;
				const fileLines = data.files.map((f) => `${f.title || 'Untitled'}${f.size ? ` | ${f.size}` : ''}`);
				blocks.push(`# ${albumName}`);
				blocks.push(...fileLines);
				blocks.push('');
			}

			const text = blocks.join('\n').trim();
			if (!text) {
				this.emitStatus('No file names available to copy.');
				return;
			}

			await navigator.clipboard.writeText(text);
			this.emitStatus(`Copied file names for ${selected.length} album(s).`);
		}

		getAlbumPageUrls(doc, albumUrl) {
			const urls = new Set([albumUrl]);
			const base = new URL(albumUrl);
			const baseRoot = getAlbumRootKey(albumUrl);

			this.qsa('a[href]', doc).forEach((a) => {
				try {
					const href = a.getAttribute('href');
					if (!href) return;
					const abs = new URL(href, albumUrl);
					if (abs.origin !== base.origin) return;
					if (getAlbumRootKey(abs.toString()) !== baseRoot) return;

					const hasPageQuery = /[?&]page=\d+/i.test(abs.search);
					const hasTrailingPage = /\/\d+\/?$/.test(abs.pathname);
					if (hasPageQuery || hasTrailingPage) {
						urls.add(abs.toString());
					}
				} catch {
					// ignore malformed links
				}
			});

			return Array.from(urls);
		}

		setupHoverPreview(album) {
			if (album.dataset.previewBound === '1') return;
			album.dataset.previewBound = '1';

			const albumLink = (album.matches && album.matches('a[href*="/a/"]')) ? album : this.qs("a[href^='https://bunkr.'], a[href*='/a/']", album);
			if (!albumLink) return;
			const albumUrl = albumLink.href;
			const albumTextContainer = this.qs('.flex-1.grid.auto-rows-max', album) || this.qs('.p-3\\.5', album) || album;

			this.ensureAlbumMetaBadge(album);

			let previewContainer = this.qs('.album-preview-flex', albumTextContainer);
			if (!previewContainer) {
				previewContainer = this.createPreviewContainer();
				albumTextContainer.appendChild(previewContainer);
			}

			album.addEventListener('mouseenter', () => this.showPreview(albumUrl, previewContainer));
			album.addEventListener('mouseleave', () => this.hidePreview(previewContainer));
			album.addEventListener('pointerdown', (e) => {
				if (e.target.closest('.album-preview-flex, .bae-album-controls, [class*="nexus-"], [data-nexus-prevent-nav]')) return;
				if (!this.selectionMode) return;
				e.preventDefault();
				e.stopPropagation();
			}, true);
			album.addEventListener('click', (e) => this.handleAlbumClick(e, albumUrl, previewContainer), true);
		}

		createPreviewContainer() {
			const container = document.createElement('div');
			container.className = 'album-preview-flex';
			container.style = `
display: none;
flex-wrap: wrap;
justify-content: center;
gap: 12px;
padding: 10px;
background: #222;
border-radius: 5px;
margin-top: 10px;
max-width: 100%;
overflow: hidden;
`;
			return container;
		}

		async showPreview(albumUrl, container) {
			if (!this.hoverPreviewsEnabled) return;
			this.previewTimeout = setTimeout(async () => {
				if (!this.hoverPreviewsEnabled) return;
				if (this.selectionMode) return;
				if (container.innerHTML.trim()) {
					container.style.display = 'flex';
					return;
				}

				try {
					const albumElement = container.closest('.rounded-xl.bg-mute.border-b, a.card[href*="/a/"]');
					const data = await this.fetchAlbumData(albumUrl, albumElement, { requireFiles: true });

					container.innerHTML = '';

					// Info Bar
					const infoBar = document.createElement('div');
					infoBar.style = 'width: 100%; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; border-bottom: 1px solid #444; padding-bottom: 8px;';

					const searchInput = document.createElement('input');
					searchInput.placeholder = '🔍 Filter videos...';
					searchInput.style = 'background: #111827; color: #fff; border: 1px solid #4b5563; border-radius: 8px; padding: 8px 10px; font-size: 13px; flex: 1; min-width: 260px; outline: none;';

					const filteredCountText = document.createElement('span');
					filteredCountText.style = 'color: #9ca3af; font-size: 12px; min-width: 74px; text-align: right;';
					filteredCountText.textContent = '0/0';

					searchInput.addEventListener('input', (e) => {
						const terms = (e.target.value || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
						let visible = 0;
						const cards = container.querySelectorAll('.preview-item-wrapper');
						cards.forEach(el => {
							const title = (el.getAttribute('data-title') || '').toLowerCase();
							const size = (el.getAttribute('data-size') || '').toLowerCase();
							const haystack = `${title} ${size}`;
							const match = terms.length === 0 || terms.every(t => haystack.includes(t));
							el.style.display = match ? 'flex' : 'none';
							if (match) visible++;
						});
						filteredCountText.textContent = `${visible}/${cards.length}`;
					});
					// Isolation to prevent album navigation
					['click', 'mousedown', 'mouseup', 'keydown', 'keyup'].forEach(evName => {
						searchInput.addEventListener(evName, (e) => e.stopPropagation());
					});

					const copyBtn = document.createElement('button');
					copyBtn.textContent = '📋 Links';
					copyBtn.style = 'background: #1f2937; color: #fff; border: 1px solid #4b5563; border-radius: 8px; padding: 7px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;';
					copyBtn.addEventListener('click', (e) => {
						e.preventDefault();
						e.stopPropagation();
						const visibleItems = Array.from(container.querySelectorAll('.preview-item-wrapper'))
							.filter(el => el.style.display !== 'none');
						const links = visibleItems.map(el => el.getAttribute('data-url')).join('\n');
						navigator.clipboard.writeText(links).then(() => {
							const oldText = copyBtn.textContent;
							copyBtn.textContent = '✅ Copied!';
							setTimeout(() => copyBtn.textContent = oldText, 2000);
						});
					});
					copyBtn.addEventListener('click', (e) => e.stopPropagation());

					const infoText = document.createElement('span');
					infoText.style = 'color: #cbd5e1; font-size: 12px; font-weight: 600; white-space: nowrap; margin-right: auto;';

					// Build info text with size and dates
					let infoContent = '';
					if (data.totalBytes > 0) {
						infoContent += formatBytes(data.totalBytes);
					}
					if (data.oldestTimestamp && data.newestTimestamp) {
						const oldestStr = new Date(data.oldestTimestamp).toLocaleDateString('en-GB');
						const newestStr = new Date(data.newestTimestamp).toLocaleDateString('en-GB');
						if (oldestStr === newestStr) {
							infoContent += ` • ${oldestStr}`;
						} else {
							infoContent += ` • ${oldestStr} → ${newestStr}`;
						}
					}
					if (!infoContent) {
						infoContent = `${data.fileCount} Videos`;
					} else if (data.fileCount) {
						infoContent += ` • ${data.fileCount} Videos`;
					}

					infoText.textContent = infoContent;

					infoBar.append(infoText, searchInput, filteredCountText, copyBtn);
					container.appendChild(infoBar);

					data.files.slice(0, CONFIG.maxPreviews).forEach((file) => {
						if (!file.thumbSrc || !file.href) return;
						const img = { src: file.thumbSrc };
						const fileLink = { getAttribute: () => file.href };
						this.addPreviewItem(img, fileLink, data.albumDomain, file.size, file.isVideo, file.title, container);
					});

					const renderedCards = container.querySelectorAll('.preview-item-wrapper').length;
					filteredCountText.textContent = `${renderedCards}/${renderedCards}`;

					container.style.display = 'flex';
				} catch (error) {
					console.error('[Bunkr Albums Enhanced]', error);
					container.innerHTML = '<p style="color:white">Preview unavailable</p>';
					container.style.display = 'flex';
				}
			}, CONFIG.previewDelay);
		}

		addPreviewItem(img, fileLink, domain, size, isVideo, title, container) {
			const wrapper = document.createElement('div');
			const fullUrl = `https://${domain}${fileLink.getAttribute('href')}`;
			wrapper.className = 'preview-item-wrapper';
			wrapper.setAttribute('data-title', title.toLowerCase());
			wrapper.setAttribute('data-url', fullUrl);
			wrapper.setAttribute('data-size', (size || '').toLowerCase());
			wrapper.style = `position: relative; width: min(${CONFIG.previewSize}, 42vw); transition: transform 0.1s; display: flex; flex-direction: column; gap: 4px;`;

			const thumb = document.createElement('img');
			thumb.src = img.src;
			thumb.title = title;
			thumb.style = `width: 100%; height: 138px; object-fit: cover; border-radius: 6px; cursor: pointer; border: 1px solid #444;`;
			thumb.alt = 'Preview';

			const caption = document.createElement('div');
			caption.style = 'display: flex; flex-direction: column; gap: 2px; background: rgba(15,23,42,0.88); border: 1px solid #334155; border-radius: 6px; padding: 4px 6px; min-height: 38px;';

			const titleLine = document.createElement('div');
			titleLine.textContent = title || 'Untitled';
			titleLine.style = 'color: #f8fafc; font-size: 11px; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';

			const metaLine = document.createElement('div');
			metaLine.style = 'display: flex; justify-content: space-between; align-items: center; gap: 6px; color: #cbd5e1; font-size: 10px;';

			const typeText = document.createElement('span');
			typeText.textContent = 'VIDEO';

			const sizeText = document.createElement('span');
			sizeText.textContent = size || '-';

			metaLine.append(typeText, sizeText);
			caption.append(titleLine, metaLine);

			if (isVideo) {
				const vidBadge = document.createElement('span');
				vidBadge.textContent = '▶';
				vidBadge.style = 'position: absolute; top: 4px; left: 4px; background: rgba(124, 58, 237, 0.9); color: #fff; font-size: 10px; width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; border-radius: 50%; pointer-events: none; border: 0.5px solid #fff;';
				wrapper.appendChild(vidBadge);
			}

			wrapper.addEventListener('mouseenter', () => wrapper.style.transform = 'scale(1.05)');
			wrapper.addEventListener('mouseleave', () => wrapper.style.transform = 'scale(1)');

			wrapper.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				window.open(`https://${domain}${fileLink.getAttribute('href')}`, '_blank');
			});

			wrapper.appendChild(thumb);
			wrapper.appendChild(caption);
			container.appendChild(wrapper);
		}

		hidePreview(container) {
			clearTimeout(this.previewTimeout);
			container.style.display = 'none';
		}

		handleAlbumClick(e, albumUrl, previewContainer) {
			// Ignore if clicking anywhere inside preview area or Nexus suite UI
			if (e.target.closest('.album-preview-flex, .bae-album-controls, [class*="nexus-"], [data-nexus-prevent-nav]')) {
				return;
			}
			if (this.selectionMode) {
				e.preventDefault();
				e.stopPropagation();
				const key = getNormalizedAlbumUrl(albumUrl);
				const shouldSelect = !this.selectedAlbumUrls.has(key);
				if (shouldSelect) this.selectedAlbumUrls.add(key);
				else this.selectedAlbumUrls.delete(key);
				const card = this.getAlbumCardByUrl(albumUrl);
				const checkbox = card ? this.qs('.bae-select-album-checkbox', card) : null;
				if (checkbox) checkbox.checked = shouldSelect;
				this.updateSelectionBar();
				this.emitStatus(`Selected ${this.selectedAlbumUrls.size} album(s).`);
				return;
			}
			window.location.href = albumUrl;
		}
	}

	new BunkrAlbumsEnhanced();
})();
