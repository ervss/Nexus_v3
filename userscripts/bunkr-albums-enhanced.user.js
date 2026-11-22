// ==UserScript==
// @name Bunkr Albums Enhanced with Sorting
// @namespace https://github.com/WendysBro/bunkr-albums-autoload-previews
// @version 1.8.4
// @description Adds infinite scroll, hover previews, sorting (with dates & size), and filtering to Bunkr Albums pages
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
// @connect localhost
// @connect 127.0.0.1
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
// @connect scdn.st
// @connect *.scdn.st
// @connect balbums.st
// @icon https://www.google.com/s2/favicons?sz=64&domain=bunkrrr.org
// ==/UserScript==

(function () {
	'use strict';
	if (window.__nexusBaeArchive) return;
	window.__nexusBaeArchive = true;

	const CONFIG = {
		previewDelay: 250,
		maxPreviews: 60,
		previewSize: '220px',
		scrollThreshold: 600,
		maxAlbumPagesToScan: 250,
		concurrentAlbumFetches: 5,
		concurrentAlbumPageFetches: 3,
		maxGlobalFileRows: 0, // 0 = one scrollable combined library, no pagination
		globalFileRenderChunk: 48, // keep large fetched libraries responsive; append more while the gallery scrolls
		fetchRenderEveryAlbums: 8,
		defaultLoadMorePages: 5,   // "Load +5 pages" button
		maxAutoLoadPages: 120,     // hard ceiling for "Load all"
	};
	const STORAGE_KEYS = {
		resultSort: 'bae_result_sort',
		libraryCollapsed: 'bae_library_collapsed',
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

	function releaseSearchThumbs(root = document) {
		root.querySelectorAll('img.thumb-img, img.grid-images_box-img').forEach((img) => {
			img.decoding = 'async';
			if (/this\.remove\s*\(/.test(img.getAttribute('onerror') || '')) {
				img.removeAttribute('onerror');
				img.addEventListener('error', () => {
					if (img.dataset.baeRetried === '1') return;
					img.dataset.baeRetried = '1';
					const src = img.getAttribute('src');
					if (src) img.src = src;
				});
			}
		});
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

	function normalizeSearchText(value) {
		return String(value || '')
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, '')
			.toLowerCase()
			.replace(/[_\-.]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	}

	function injectArchiveControlStyles() {
		if (document.getElementById('bae-archive-control-styles')) return;
		const style = document.createElement('style');
		style.id = 'bae-archive-control-styles';
		style.textContent = `
body main.cont { max-width:min(1960px,calc(100vw - 32px)) !important; }
.bae-command-center { position:relative; z-index:24; margin:14px 0 18px; overflow:hidden; border:1px solid #2d3440; border-radius:20px; background:#0d1015; box-shadow:0 22px 70px rgba(0,0,0,.34); color:#f3f6f8; }
.bae-discovery-hero { display:grid; grid-template-columns:minmax(270px,.72fr) minmax(420px,1.45fr); gap:28px; align-items:end; padding:24px 26px; background:radial-gradient(circle at 84% 0,rgba(39,207,184,.13),transparent 36%),linear-gradient(118deg,#11161c 0,#0b0e13 72%); border-bottom:1px solid #29313b; }
.bae-discovery-kicker { display:block; margin-bottom:9px; color:#4fe0ca; font:650 12px/1.2 system-ui,sans-serif; }
.bae-discovery-copy h2 { margin:0; max-width:620px; color:#f7fafb; font:750 clamp(24px,2.1vw,38px)/1.04 system-ui,sans-serif; letter-spacing:-.035em; }
.bae-discovery-copy p { margin:10px 0 0; max-width:58ch; color:#929ba7; font:500 13px/1.55 system-ui,sans-serif; }
.bae-search-shell { position:relative; display:grid; gap:8px; }
.bae-search-shell > label { color:#dce4e8; font:650 12px/1.25 system-ui,sans-serif; }
.bae-search-wrap { position:relative; }
.bae-search-icon { position:absolute; left:16px; top:50%; width:18px; height:18px; transform:translateY(-50%); color:#58dac8; pointer-events:none; }
.bae-global-filter { width:100%; min-height:58px !important; padding:0 108px 0 47px !important; border-color:#3f4d59 !important; border-radius:14px !important; background:#171d24 !important; color:#fff !important; font-size:16px !important; box-shadow:inset 0 1px 0 rgba(255,255,255,.035); }
.bae-global-filter::placeholder { color:#727d88; }
.bae-search-shortcut { position:absolute; right:13px; top:50%; transform:translateY(-50%); padding:5px 8px; border:1px solid #3c4650; border-radius:7px; color:#8c98a3; font:650 10px/1 system-ui,sans-serif; pointer-events:none; }
.bae-search-submit { min-height:34px; padding:0 13px; border:1px solid #55cbbb; border-radius:9px; background:#12332f; color:#b8fff0; font:700 11px/1 system-ui,sans-serif; cursor:pointer; }
.bae-search-submit:hover { background:#19463f; }
.bae-search-hint { color:#78838e; font:500 11px/1.3 system-ui,sans-serif; }
.bae-command-main { display:grid; grid-template-columns:minmax(260px,.9fr) minmax(480px,1.65fr) minmax(240px,.8fr); gap:10px; padding:12px; }
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
.bae-command-sub { display:flex; align-items:center; gap:8px; padding:0 14px 11px; overflow:auto; }
.bae-preset { min-height:28px !important; padding:0 9px !important; color:#b9bec9 !important; }
.bae-load-more, .bae-load-custom, .bae-load-all { min-height:28px !important; padding:0 10px !important; }
.bae-load-all { border-color:#b9ff2c !important; color:#cdff6b !important; }
.bae-load-count { min-height:28px !important; width:64px; text-align:center; }
.bae-page-info { margin-left:auto; color:#8b909b; font:600 10px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace; white-space:nowrap; }
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
.bae-file-results-panel { margin:0 0 18px; border:1px solid #28343f; border-radius:18px; background:#0a0f15; overflow:hidden; box-shadow:0 24px 70px rgba(0,0,0,.25); }
.bae-file-results-panel.is-collapsed { box-shadow:0 12px 34px rgba(0,0,0,.2); }
.bae-results-head { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:16px 18px; border-bottom:1px solid #26313b; background:#10161d; }
.bae-results-head--focus { position:sticky; top:0; z-index:2; }
.bae-results-title { display:grid; gap:3px; }
.bae-results-title strong { color:#edf4f5; font:720 16px/1.2 system-ui,sans-serif; }
.bae-results-title span { color:#7e8b96; font:500 11px/1.35 system-ui,sans-serif; }
.bae-results-tools { display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
.bae-result-search { width:min(260px,28vw); min-height:34px !important; padding:0 10px !important; border:1px solid #35424e !important; border-radius:9px !important; background:#171f27 !important; color:#dce4e8 !important; font:600 11px/1.2 system-ui,sans-serif !important; }
.bae-result-sort { min-height:34px; padding:0 30px 0 10px; border:1px solid #35424e; border-radius:9px; background:#171f27; color:#dce4e8; font:600 11px/1.2 system-ui,sans-serif; }
.bae-combined-toggle,.bae-duration-fetch,.bae-batch-fetch { min-height:34px; padding:0 10px; border:1px solid #3e716a; border-radius:9px; background:#102822; color:#86ebd8; font:700 10px/1 system-ui,sans-serif; cursor:pointer; }
.bae-batch-fetch:disabled { cursor:not-allowed; opacity:.48; }
.bae-combined-toggle.is-active { border-color:#b9ff2c; background:#21300f; color:#d7ff80; }
.bae-results-grid { max-height:min(76vh,790px); overflow:auto; padding:12px; display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:11px; scrollbar-color:#40505e #0a0f15; }
.bae-file-results-panel .bae-results-grid { transition:max-height .26s ease,padding .26s ease,opacity .18s ease; }
.bae-file-results-panel.is-collapsed .bae-results-grid { max-height:0; min-height:0; padding-top:0; padding-bottom:0; opacity:0; overflow:hidden; pointer-events:none; }
.bae-file-results-panel.is-collapsed .bae-results-tools > :not(.bae-library-drawer-toggle) { display:none; }
.bae-file-results-panel.is-collapsed .bae-results-tools { margin-left:auto; }
.bae-library-drawer-toggle { min-height:34px; padding:0 10px; border:1px solid #445360; border-radius:9px; background:#151d25; color:#dbe4e7; font:700 10px/1 system-ui,sans-serif; cursor:pointer; }
.bae-library-drawer-toggle:hover { border-color:#69d9c6; color:#fff; }
.bae-result-card { position:relative; min-width:0; overflow:hidden; border:1px solid #27333e; border-radius:13px; background:#111820; transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease; }
.bae-result-card.is-selected { border-color:#67d8c9; box-shadow:0 0 0 1px rgba(103,216,201,.28),0 12px 30px rgba(0,0,0,.28); }
.bae-result-card:hover { transform:translateY(-2px); border-color:#4a746f; box-shadow:0 12px 30px rgba(0,0,0,.28); }
.bae-result-media { position:relative; aspect-ratio:16/10; overflow:hidden; background:#070a0e; cursor:pointer; }
.bae-result-select { position:absolute; z-index:2; top:8px; right:8px; display:inline-flex; align-items:center; gap:5px; padding:5px 7px; border:1px solid rgba(216,244,241,.26); border-radius:8px; background:rgba(7,12,16,.84); color:#e9f7f5; font:700 10px/1 system-ui,sans-serif; cursor:pointer; backdrop-filter:blur(8px); }
.bae-result-select input { width:13px; height:13px; accent-color:#62d8c6; cursor:pointer; }
.bae-result-import { border-color:#4fae88 !important; background:#123427 !important; color:#c5ffe1 !important; }
.bae-result-media img { width:100%; height:100%; display:block; object-fit:cover; transition:transform .28s ease; }
.bae-result-card:hover .bae-result-media img { transform:scale(1.025); }
.bae-result-media::after { content:'Play'; position:absolute; left:50%; top:50%; transform:translate(-50%,-45%); padding:8px 12px; border-radius:999px; background:rgba(5,10,14,.82); color:#fff; font:700 11px/1 system-ui,sans-serif; opacity:0; transition:opacity .16s ease,transform .16s ease; backdrop-filter:blur(8px); }
.bae-result-card:hover .bae-result-media::after,.bae-result-media:focus-visible::after { opacity:1; transform:translate(-50%,-50%); }
.bae-result-badge { position:absolute; left:8px; bottom:8px; padding:4px 7px; border:1px solid rgba(255,255,255,.14); border-radius:7px; background:rgba(7,11,15,.78); color:#eaf2f3; font:700 10px/1 system-ui,sans-serif; backdrop-filter:blur(8px); }
.bae-result-body { display:grid; gap:8px; padding:10px; }
.bae-result-name { min-height:32px; overflow:hidden; color:#f0f4f5; font:650 12px/1.35 system-ui,sans-serif; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.bae-result-album { overflow:hidden; color:#49cfbd; font:600 10px/1.25 system-ui,sans-serif; white-space:nowrap; text-overflow:ellipsis; }
.bae-result-meta { display:flex; align-items:center; gap:7px; color:#83909c; font:550 10px/1.2 system-ui,sans-serif; }
.bae-result-actions { display:flex; gap:6px; }
.bae-result-actions button,.bae-result-actions a { display:inline-flex; min-height:30px; align-items:center; justify-content:center; border:1px solid #35424e; border-radius:8px; background:#18212a; color:#dce5e7; font:650 10px/1 system-ui,sans-serif; text-decoration:none; cursor:pointer; }
.bae-result-actions button { flex:1; }
.bae-result-actions a { width:32px; }
.bae-result-actions button:hover,.bae-result-actions a:hover { border-color:#55cbbb; color:#fff; }
.bae-results-empty { padding:34px 18px; text-align:center; color:#84919d; font:500 13px/1.5 system-ui,sans-serif; }
.bae-combined-mode .bae-command-center,.bae-combined-mode .bae-workspace > .grid,.bae-combined-mode .bae-dashboard { display:none !important; }
.bae-combined-mode .bae-workspace { display:block; }
.bae-combined-mode .bae-file-results-panel { margin-top:0; }
.bae-album-meta { letter-spacing:.01em; }
.bae-video-quality { background:rgba(255,255,255,.025); }
@media (max-width:1680px) { .bae-results-grid { grid-template-columns:repeat(5,minmax(0,1fr)); } }
@media (max-width:1380px) { .bae-results-grid { grid-template-columns:repeat(4,minmax(0,1fr)); } .bae-command-main { grid-template-columns:1fr 1.5fr; } .bae-command-main .bae-command-group:last-child { grid-column:1/-1; } }
@media (max-width:1080px) { .bae-discovery-hero { grid-template-columns:1fr; } .bae-command-main { grid-template-columns:1fr; } .bae-command-main .bae-command-group:last-child { grid-column:auto; } .bae-workspace { grid-template-columns:1fr; } .bae-dashboard { position:relative; top:auto; grid-template-columns:1fr 2fr; } .bae-results-grid { grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media (max-width:720px) { body main.cont { max-width:calc(100vw - 18px) !important; } .bae-discovery-hero { padding:19px 16px; gap:18px; } .bae-global-filter { min-height:52px !important; padding-right:16px !important; } .bae-search-shortcut { display:none; } .bae-dashboard { grid-template-columns:1fr; } .bae-command-group { flex-wrap:wrap; } .bae-results-head { align-items:flex-start; flex-direction:column; } .bae-results-tools { width:100%; justify-content:flex-start; } .bae-result-search { width:100%; } .bae-results-grid { grid-template-columns:repeat(2,minmax(0,1fr)); padding:8px; gap:8px; } }
@media (max-width:430px) { .bae-results-grid { grid-template-columns:1fr; } }
@media (prefers-reduced-motion:reduce) { .bae-command-center button,.bae-result-card,.bae-result-media img,.bae-result-media::after { transition:none; } }
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
<div class="bae-discovery-hero">
  <div class="bae-discovery-copy">
    <span class="bae-discovery-kicker">Your fetched Bunkr library</span>
    <h2>Find the video, not the album.</h2>
    <p>Index album and video titles first. Album thumbnails load with that index. Duration and playback stay on demand.</p>
  </div>
  <div class="bae-search-shell">
    <label for="bae-library-search">Search fetched videos and album titles</label>
    <div class="bae-search-wrap">
      <svg class="bae-search-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="m21 21-4.35-4.35m1.35-5.15A6.5 6.5 0 1 1 5 11.5a6.5 6.5 0 0 1 13 0Z"/></svg>
      <input id="bae-library-search" class="bae-global-filter" type="search" autocomplete="off" placeholder="Search the fetched library: creator, scene, filename or album…">
      <span class="bae-search-shortcut">Press /</span>
    </div>
    <button class="bae-search-submit" type="button">Search fetched library</button>
    <span class="bae-search-hint">Type freely, then press Enter or Search to filter the fetched library.</span>
  </div>
</div>
<div class="bae-command-main">
  <div class="bae-command-group">
    <label class="bae-field"><span>Albums</span><input class="bae-fetch-count" type="number" min="1" max="5000" value="100" title="Visible albums to fetch"></label>
    <button class="bae-primary bae-fetch">Index visible</button>
    <button class="bae-fetch-all" title="Index video titles for every album currently visible">Index all visible</button>
	<span class="bae-page-info">page ?</span>
  </div>
	<div class="bae-command-group bae-command-group--refine">
    <label class="bae-field"><span>Min videos</span><input class="bae-min-count" type="number" min="0" value="0"></label>
    <label class="bae-field"><span>Min size</span><input class="bae-min-size" type="text" placeholder="1 GB"></label>
    <label class="bae-field"><span>Updated</span><select class="bae-updated-within"><option value="0">Any time</option><option value="7">7 days</option><option value="14">2 weeks</option><option value="30">1 month</option><option value="90">3 months</option><option value="180">6 months</option></select></label>
    <label class="bae-field"><span>Estimate</span><select class="bae-quality-min"><option value="0">Any</option><option value="1">Standard+</option><option value="2">High+</option><option value="3">Very high</option></select></label>
    <button class="bae-apply">Apply filters</button>
  </div>
  <div class="bae-command-group">
    <label class="bae-field bae-field--grow"><span>Sort</span><select class="bae-sort"><option value="default">Default</option><option value="newest">Newest update</option><option value="size">Largest videos</option><option value="count">Most videos</option><option value="name">Name AâZ</option><option value="oldest">Oldest first</option></select></label>
    <button class="bae-reset">Reset</button>
  </div>
</div>
<div class="bae-command-sub">
  <span class="bae-command-title">Pages</span>
  <button class="bae-load-more" data-pages="5">Load +5 pages</button>
  <button class="bae-load-more" data-pages="10">+10</button>
  <input class="bae-load-count" type="number" min="1" max="120" value="5" title="How many further pages to load">
  <button class="bae-load-custom">Load N</button>
  <button class="bae-load-all">Load all</button>
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
		// Infinity => every visible album, however many pages have been loaded.
		controls.querySelector('.bae-fetch-all').addEventListener('click', () => {
			window.dispatchEvent(new CustomEvent('bae-fetch-visible', { detail: Infinity }));
		});
		const submitGlobalSearch = () => window.dispatchEvent(new CustomEvent('bae-global-filter', { detail: globalFilter.value || '' }));
		controls.querySelector('.bae-search-submit').addEventListener('click', submitGlobalSearch);
		globalFilter.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitGlobalSearch(); } });
		controls.querySelector('.bae-apply').addEventListener('click', applyFilters);
		[minCountInput, minSizeInput, updatedWithinSelect, qualityMinSelect].forEach((input) => input.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilters(); }));
		sortSelect.addEventListener('change', () => sortAlbums(sortSelect.value));
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
		const loadCountInput = controls.querySelector('.bae-load-count');
		const emitLoadPages = (pages) => window.dispatchEvent(new CustomEvent('bae-load-pages', { detail: pages }));
		controls.querySelectorAll('.bae-load-more').forEach((button) => button.addEventListener('click', () => {
			emitLoadPages(parseInt(button.dataset.pages || '5', 10) || 5);
		}));
		controls.querySelector('.bae-load-custom').addEventListener('click', () => {
			emitLoadPages(parseInt(loadCountInput.value || '5', 10) || 5);
		});
		loadCountInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') emitLoadPages(parseInt(loadCountInput.value || '5', 10) || 5);
		});
		controls.querySelector('.bae-load-all').addEventListener('click', () => window.dispatchEvent(new CustomEvent('bae-load-all')));

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
		dashboard.innerHTML = `<div class="bae-dashboard-head"><span class="bae-dashboard-title">Album signal</span><span class="bae-dashboard-live">local scan</span></div><div class="bae-stat-grid"><div class="bae-stat"><strong data-stat="fetched">0</strong><span>Fetched</span></div><div class="bae-stat"><strong data-stat="visible">0</strong><span>Visible</span></div><div class="bae-stat"><strong data-stat="videos">0</strong><span>Videos</span></div><div class="bae-stat"><strong data-stat="size">0 B</strong><span>Video size</span></div><div class="bae-stat"><strong data-stat="fresh">0</strong><span>Updated â¤30d</span></div><div class="bae-stat"><strong data-stat="quality">0</strong><span>High estimate</span></div></div><div class="bae-signal-label"><span>100-album signal</span><span>fresh â old</span></div><div class="bae-signal-strip"></div><p class="bae-dashboard-note">Signals are calculated locally from fetched video metadata. Quality is an estimate based on average size per video.</p>`;
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
		try {
			const parsed = new URL(normalized);
			const parts = parsed.pathname.split('/').filter(Boolean);
			if (parts.length > 2 && /^\d+$/.test(parts[parts.length - 1])) parts.pop();
			return `${parsed.origin}/${parts.join('/')}`;
		} catch {
			return normalized;
		}
	}

	function getAlbumDedupKeyFromCard(card) {
		if (!card) return '';

		const link = card.querySelector("a[href*='/a/']") || card.querySelector("a[href^='https://bunkr.']");
		if (link && link.href) {
			try {
				const parsed = new URL(link.href);
				const parts = parsed.pathname.split('/').filter(Boolean);
				if (parts.length > 2 && /^\d+$/.test(parts[parts.length - 1])) parts.pop();
				const pathKey = `/${parts.join('/')}`;
				if (pathKey && pathKey !== '/') return pathKey.toLowerCase();
			} catch {
				const href = link.getAttribute('href') || '';
				const pathOnly = href.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
				const parts = pathOnly.split('/').filter(Boolean);
				if (parts.length > 2 && /^\d+$/.test(parts[parts.length - 1])) parts.pop();
				const cleaned = `/${parts.join('/')}`;
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

	function fetchTextCrossOrigin(url, options = {}) {
		const method = options.method || 'GET';
		const headers = options.headers || {};
		return new Promise((resolve, reject) => {
			if (typeof GM_xmlhttpRequest !== 'function') {
				fetch(url, { method, headers, body: options.body })
					.then(async (response) => resolve({ ok: response.ok, status: response.status, text: await response.text() }))
					.catch(reject);
				return;
			}
			GM_xmlhttpRequest({
				method,
				url,
				headers,
				data: options.body,
				timeout: options.timeout || 12000,
				onload: (response) => resolve({
					ok: response.status >= 200 && response.status < 300,
					status: response.status,
					text: response.responseText || '',
				}),
				onerror: () => reject(new Error('Cross-origin request failed')),
				ontimeout: () => reject(new Error('Cross-origin request timed out')),
			});
		});
	}

	function cleanPlayableMediaUrl(candidate, baseUrl = '') {
		if (!candidate) return '';
		let value = String(candidate)
			.trim()
			.replace(/^['"]+|['"]+$/g, '')
			.replace(/\\u0026/gi, '&')
			.replace(/\\\//g, '/')
			.replace(/\\/g, '/')
			.replace(/&amp;/gi, '&');
		if (value.startsWith('//')) value = 'https:' + value;
		try {
			const url = new URL(value, baseUrl || undefined).href;
			const lower = url.toLowerCase();
			const isVideo = /\.(mp4|mkv|mov|webm|m4v|avi|m3u8)(\?|$)/i.test(lower)
				|| lower.includes('media-files') || lower.includes('scdn.st') || lower.includes('get.bunkr');
			return isVideo ? url : '';
		} catch {
			return '';
		}
	}

	function mediaUrlFromResponse(data, baseUrl) {
		return cleanPlayableMediaUrl(data?.url || data?.data?.url || data?.stream?.url, baseUrl);
	}

	const bunkrStreamCache = new Map();

	// Resolve a Bunkr file landing page to its short-lived, directly playable CDN URL.
	async function resolveBunkrStreamUrl(filePageUrl) {
		const cached = bunkrStreamCache.get(filePageUrl);
		if (cached && Date.now() - cached.createdAt < 4 * 60 * 1000) return cached.url;

		const parsed = new URL(filePageUrl);
		const pathParts = parsed.pathname.split('/').filter(Boolean);
		if (pathParts.length < 2 || !['f', 'v'].includes(pathParts[0])) {
			const directUrl = cleanPlayableMediaUrl(filePageUrl);
			if (directUrl) return directUrl;
			throw new Error('This item does not have a playable Bunkr video URL.');
		}
		const slug = pathParts[1];
		const slugNoExt = slug.replace(/\.(mp4|mkv|mov|webm|m4v|avi|ts)$/i, '');
		const origin = parsed.origin;
		const headers = { 'Referer': filePageUrl, 'Origin': origin };
		let streamUrl = '';

		for (const currentSlug of [...new Set([slugNoExt, slug])]) {
			const data = await postJsonCrossOrigin(`${origin}/api/vs`, { slug: currentSlug }, headers).catch(() => null);
			let candidate = data?.url;
			if (candidate && data?.encrypted) candidate = decodeBunkrUrl(candidate, Number(data.timestamp) || 0);
			streamUrl = cleanPlayableMediaUrl(candidate, origin);
			if (streamUrl) break;
		}

		if (!streamUrl) {
			const signed = await fetchTextCrossOrigin(`${origin}/api/sign?v=${encodeURIComponent(slugNoExt)}`, {
				headers: { 'Accept': 'application/json', 'Referer': filePageUrl },
			}).catch(() => null);
			if (signed?.ok) {
				try { streamUrl = mediaUrlFromResponse(JSON.parse(signed.text), origin); } catch {}
			}
		}

		if (!streamUrl) {
			const signed = await postJsonCrossOrigin(`${origin}/api/sign`, { v: slugNoExt, slug: slugNoExt }, headers).catch(() => null);
			streamUrl = mediaUrlFromResponse(signed, origin);
		}

		if (!streamUrl) {
			const page = await fetchTextCrossOrigin(filePageUrl, {
				headers: { 'Accept': 'text/html,application/xhtml+xml', 'Referer': origin + '/' },
			}).catch(() => null);
			if (page?.ok) {
				const html = page.text;
				const match = html.match(/(?:jsCDN|signUrl)\s*[:=]\s*["']([^"']+)["']/i)
					|| html.match(/<(?:source|video)[^>]+src=["']([^"']+)["']/i)
					|| html.match(/["'](https?:\/\/[^"'\s]+(?:\.(?:mp4|mkv|mov|webm|m4v|avi|m3u8)|media-files|scdn\.st|get\.bunkr)[^"'\s]*)["']/i);
				streamUrl = cleanPlayableMediaUrl(match?.[1], origin);
			}
		}

		if (!streamUrl) throw new Error('Unable to resolve a playable stream for this Bunkr file.');
		bunkrStreamCache.set(filePageUrl, { url: streamUrl, createdAt: Date.now() });
		return streamUrl;
	}

	function fetchVideoBlobUrl(directMediaUrl, referer) {
		return new Promise((resolve, reject) => {
			if (typeof GM_xmlhttpRequest !== 'function') {
				reject(new Error('GM_xmlhttpRequest unavailable'));
				return;
			}
			GM_xmlhttpRequest({
				method: 'GET',
				url: directMediaUrl,
				responseType: 'blob',
				headers: {
					Referer: referer || location.href,
					'User-Agent': navigator.userAgent,
				},
				timeout: 90000,
				onload: (res) => {
					if (res.status >= 200 && res.status < 300 && res.response) {
						try { resolve(URL.createObjectURL(res.response)); }
						catch (error) { reject(error); }
						return;
					}
					reject(new Error(`HTTP ${res.status}`));
				},
				onerror: () => reject(new Error('Blob fetch failed')),
				ontimeout: () => reject(new Error('Blob fetch timed out')),
			});
		});
	}

	async function startVideoPlayback(videoEl) {
		if (!videoEl) return;
		videoEl.autoplay = true;
		videoEl.playsInline = true;
		videoEl.controls = true;
		try {
			await videoEl.play();
		} catch {
			videoEl.muted = true;
			try { await videoEl.play(); } catch { /* browser still blocked */ }
		}
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
			// Continue from whatever page the user is actually on. Hard-coding 2 meant
			// that opening ?page=3 and loading more re-fetched pages 2, 3, 4… so the
			// first two "loads" only produced duplicates that dedupe threw away.
			const currentPage = parseInt(new URLSearchParams(window.location.search).get('page') || '1', 10);
			this.nextPage = (Number.isFinite(currentPage) && currentPage > 0 ? currentPage : 1) + 1;
			this.loading = false;
			this.previewTimeout = null;
			this.domObserver = null;
			this.reconcileTimer = null;
			this.albumCache = new Map();
			this.persistentAlbumCache = { version: PERSISTENT_CACHE_VERSION, entries: {} };
			this.persistentCacheSaveTimer = null;
			this.selectedAlbumUrls = new Set();
			this.selectedFetchedVideoUrls = new Set();
			this.activeGlobalFilter = '';
			this.activeMinCount = 0;
			this.activeMinSizeBytes = 0;
			this.activeUpdatedWithinDays = 0;
			this.activeQualityMin = 0;
			this.selectionMode = false;
			this.resultSort = localStorage.getItem(STORAGE_KEYS.resultSort) || 'newest';
			this.searchRenderTimer = null;
			this.libraryRenderTimer = null;
			this.combinedView = false;
			this.libraryDrawerCollapsed = localStorage.getItem(STORAGE_KEYS.libraryCollapsed) === '1';
			this.compareSlots = { A: null, B: null };
			this.playerModal = null;
			this.floatingPlayers = null;
			this.isTopAlbumsPage = window.location.pathname.includes('/topalbums');
			this.initialized = false;
			this.totalPages = 0;      // parsed from "page 3 of 51"
			this.reachedEnd = false;
			this.batchLoading = false; // a Load +N / Load all run is in progress

			// Register bridge listener early so extension requests are not missed
			// while init() is still wiring UI/observers on heavy pages.
			this.bridge = new BaeExtensionBridge(this);
			this.bridge.setReady();
			setTimeout(() => releaseSearchThumbs(), 0);
			const boot = () => {
				this.persistentAlbumCache = loadPersistentAlbumCache();
				this.init();
			};
			if (typeof requestIdleCallback === 'function') requestIdleCallback(boot, { timeout: 700 });
			else setTimeout(boot, 50);
		}

		init() {
			releaseSearchThumbs();
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
				clearTimeout(this.searchRenderTimer);
				this.searchRenderTimer = setTimeout(() => this.applyGlobalFilter(this.activeGlobalFilter), 90);
			});
			window.addEventListener('bae-min-filter', (e) => {
				const { minCount, minSizeRaw, updatedWithinDays, qualityMin } = e?.detail || {};
				this.activeMinCount = parseInt(minCount || '0', 10) || 0;
				this.activeMinSizeBytes = parseSizeToBytes(minSizeRaw || '') || 0;
				this.activeUpdatedWithinDays = parseInt(updatedWithinDays || '0', 10) || 0;
				this.activeQualityMin = parseInt(qualityMin || '0', 10) || 0;
				this.applyGlobalFilter(this.activeGlobalFilter);
				const hidden = Array.from(getAlbumsGridContainer(document)?.children || []).filter(a => a.style.display === 'none').length;
				this.emitStatus(`Filters applied â ${hidden} albums hidden.`);
			});
			window.addEventListener('bae-fetch-visible', async (e) => {
				// detail may be Infinity ("fetch all visible"), which parseInt cannot carry.
				const raw = e?.detail;
				const count = raw === Infinity ? Infinity : parseInt(raw ?? '100', 10);
				await this.fetchVisibleAlbums(Number.isFinite(count) || count === Infinity ? count : 100);
			});
			window.addEventListener('bae-load-pages', async (e) => {
				const pages = parseInt((e && e.detail) || `${CONFIG.defaultLoadMorePages}`, 10);
				await this.loadMorePages(Number.isFinite(pages) ? pages : CONFIG.defaultLoadMorePages, `+${pages} pages`);
			});
			window.addEventListener('bae-load-all', async () => { await this.loadAllPages(); });
			this.totalPages = this.getTotalPages(document);
			this.updateLoadMoreUi();
			const paintLibrary = () => this.renderGlobalFileResults([]);
			if (typeof requestIdleCallback === 'function') requestIdleCallback(paintLibrary, { timeout: 400 });
			else setTimeout(paintLibrary, 0);
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

		// Build the URL for page N while preserving every search parameter the user
		// actually has active (search, mode, per, sort, ...). Rebuilding the query
		// from scratch used to drop mode/per/sort, so "load more" silently pulled a
		// differently-filtered result set than the one already on screen.
		buildPageUrl(page) {
			const params = new URLSearchParams(window.location.search);
			params.set('page', String(page));
			const path = this.isTopAlbumsPage ? '/topalbums' : '/';
			return `${path}?${params.toString()}`;
		}

		// Total page count as printed by Bunkr ("page 3 of 51"). Used to stop
		// "Load all" at the real end instead of probing until an empty response.
		getTotalPages(doc = document) {
			// textContent, not innerText: pages parsed via DOMParser have no layout,
			// so innerText is unreliable there (and undefined outside a browser).
			const text = (doc.body?.textContent || '').replace(/\s+/g, ' ');
			const m = text.match(/page\s+\d+\s+of\s+([\d,]+)/i);
			return m ? parseInt(m[1].replace(/,/g, ''), 10) || 0 : 0;
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
			// A batch load owns nextPage while it runs; letting scroll interleave here
			// would make both advance the same counter and skip pages.
			if (this.loading || this.batchLoading || this.reachedEnd) return;
			const scrollPosition = window.innerHeight + window.scrollY;
			if (scrollPosition >= document.body.offsetHeight - CONFIG.scrollThreshold) {
				this.loadNextPage();
			}
		}

		async loadNextPage() {
			if (this.loading) return 0;
			this.loading = true;
			try {
				return await this.loadPageInto(this.nextPage);
			} finally {
				this.loading = false;
			}
		}

		// Fetch a single results page and append its cards to the live grid.
		// Returns how many NEW (post-dedupe) cards landed on the page, so callers
		// can tell "page was empty" apart from "page was all duplicates".
		async loadPageInto(page) {
			const container = getAlbumsGridContainer(document);
			if (!container) return 0;

			const response = await fetch(this.buildPageUrl(page));
			if (!response.ok) throw new Error(`Failed to load page ${page}`);

			const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
			if (!this.totalPages) this.totalPages = this.getTotalPages(doc);
			const newAlbums = getAlbumCards(doc);
			// A page with no cards at all is the real end-of-results signal.
			if (!newAlbums.length) return 0;

			// Count by identity, not by child-count delta: the MutationObserver also
			// runs dedupeAlbums() on a timer, so comparing container.children.length
			// before/after can read 0 purely because dedupe fired in between — which
			// the caller would misread as "no more results" and stop early.
			const seenBefore = new Set(
				getAlbumCards(document).map((el) => getAlbumDedupKeyFromCard(el)).filter(Boolean));
			newAlbums.forEach((album) => this.setupHoverPreview(album));
			container.append(...newAlbums);
			this.dedupeAlbums();
			const added = getAlbumCards(document)
				.map((el) => getAlbumDedupKeyFromCard(el))
				.filter((key) => key && !seenBefore.has(key)).length;

			this.hydrateVisibleAlbumsFromPersistentCache();
			if (page >= this.nextPage) this.nextPage = page + 1;
			// Newly appended cards start unstyled; re-run the active filter so they
			// obey the same rules as everything already on screen.
			this.applyGlobalFilter(this.activeGlobalFilter);
			this.reapplyActiveSort();
			this.updateDashboard();
			return added;
		}

		// Re-run whichever sort the user picked in our own control, so appended
		// pages get merged into the existing order instead of being stuck at the
		// bottom. (The old code grabbed document.querySelector('select') — the
		// FIRST select on the page, which is Bunkr's own "per page" dropdown.)
		reapplyActiveSort() {
			const sortSelect = this.qs('.bae-sort');
			const method = sortSelect?.value;
			if (method && method !== 'default') sortAlbums(method);
		}

		// Load a run of pages back-to-back. Sequential on purpose: Bunkr throttles
		// bursts, and a parallel fan-out here reliably starts returning empty pages
		// that look like "end of results".
		async loadMorePages(pageCount, label) {
			if (this.loading || this.batchLoading) {
				this.emitStatus('Already loading pages…');
				return;
			}
			this.batchLoading = true;
			const target = Math.max(1, pageCount || 1);
			let loaded = 0;
			let addedTotal = 0;

			try {
				for (let i = 0; i < target; i++) {
					const page = this.nextPage;
					if (this.totalPages && page > this.totalPages) {
						this.emitStatus(`Reached the last page (${this.totalPages}). ${addedTotal} album(s) added.`);
						break;
					}
					this.emitStatus(`Loading page ${page}${this.totalPages ? ` of ${this.totalPages}` : ''} — ${label} (${loaded}/${target})…`);
					// eslint-disable-next-line no-await-in-loop
					const added = await this.loadPageInto(page).catch((error) => {
						console.error('[Bunkr Albums Enhanced]', error);
						return -1;
					});
					if (added < 0) {
						this.emitStatus(`Page ${page} failed to load — stopped after ${addedTotal} album(s).`);
						break;
					}
					// Only treat "nothing new" as the end when there is no trustworthy
					// page count. A single duplicate page mid-run must not abort a
					// long load that still has real pages ahead of it.
					if (added === 0 && !this.totalPages) {
						this.emitStatus(`No more results. ${addedTotal} album(s) added.`);
						this.reachedEnd = true;
						break;
					}
					loaded += 1;
					addedTotal += added;
					// Small breather between pages so the server keeps answering.
					// eslint-disable-next-line no-await-in-loop
					if (i < target - 1) await new Promise((r) => setTimeout(r, 220));
				}
				if (!this.reachedEnd) {
					const total = getAlbumCards(document).length;
					this.emitStatus(`Loaded ${loaded} page(s) · +${addedTotal} albums · ${total} on screen.`);
				}
			} finally {
				this.batchLoading = false;
				this.updateLoadMoreUi();
			}
		}

		// "Load all" walks to the end of the result set. Capped so a 51-page search
		// cannot turn into an unbounded crawl if the page-count parse ever fails.
		async loadAllPages() {
			const known = this.totalPages || this.getTotalPages(document);
			if (known) this.totalPages = known;
			const remaining = this.totalPages
				? Math.max(0, this.totalPages - this.nextPage + 1)
				: CONFIG.maxAutoLoadPages;
			if (!remaining) {
				this.emitStatus('Everything is already loaded.');
				return;
			}
			await this.loadMorePages(Math.min(remaining, CONFIG.maxAutoLoadPages), 'load all');
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

			const normalized = normalizeSearchText(rawTerm);
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
					const albumName = normalizeSearchText(getAlbumTitleFromCard(album));
					const cachedIndex = normalizeSearchText(album.dataset.previewIndex || '');
					const albumUrl = getNormalizedAlbumUrl(getAlbumUrlFromCard(album));
					const metadata = albumUrl ? this.albumCache.get(albumUrl) : null;
					const cachedAlbumName = normalizeSearchText(metadata?.albumName || '');
					const cachedFiles = (metadata?.files || [])
						.map((file) => `${file.title || ''} ${file.size || ''}`)
						.join(' ')
						.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
					const haystack = `${albumName} ${cachedAlbumName} ${cachedIndex} ${cachedFiles}`;
					if (!terms.every((term) => haystack.includes(term))) {
						album.style.display = 'none';
						return;
					}
				}

				// Min file count (only if data fetched â dataset.totalSizeBytes is set after fetch)
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

			const rows = [];
			this.albumCache.forEach((metadata) => {
				const albumName = normalizeSearchText(metadata.albumName || '');
				(metadata.files || []).forEach((file) => {
					const title = normalizeSearchText(file.title || '');
					const size = normalizeSearchText(file.size || '');
					const haystack = `${title} ${size} ${albumName}`;
					if (terms.every((t) => haystack.includes(t))) {
						const fileUrl = metadata.albumDomain ? `https://${metadata.albumDomain}${file.href || ''}` : '';
						rows.push({
							albumName: metadata.albumName || 'Album',
							albumDomain: metadata.albumDomain,
							albumUrl: metadata.albumUrl || '',
							duration: Number(file.duration || 0) || (typeof metaByUrl !== 'undefined' ? Number(metaByUrl.get(fileUrl)?.duration || 0) : 0),
							file,
						});
					}
				});
			});

			const sortRows = () => {
				if (this.resultSort === 'largest') rows.sort((a, b) => parseSizeToBytes(b.file.size) - parseSizeToBytes(a.file.size));
				else if (this.resultSort === 'duration') rows.sort((a, b) => (b.duration || 0) - (a.duration || 0));
				else if (this.resultSort === 'name') rows.sort((a, b) => (a.file.title || '').localeCompare(b.file.title || ''));
				else if (this.resultSort === 'album') rows.sort((a, b) => a.albumName.localeCompare(b.albumName));
				else rows.sort((a, b) => (b.file.timestamp || 0) - (a.file.timestamp || 0));
			};
			sortRows();
			const limited = CONFIG.maxGlobalFileRows > 0 ? rows.slice(0, CONFIG.maxGlobalFileRows) : rows;
			const initiallyRendered = Math.min(CONFIG.globalFileRenderChunk, limited.length);

			panel.innerHTML = '';
			const header = document.createElement('div');
			panel.classList.toggle('is-collapsed', this.libraryDrawerCollapsed);
			header.className = `bae-results-head${this.combinedView ? ' bae-results-head--focus' : ''}`;
			const title = document.createElement('div');
			title.className = 'bae-results-title';
			const titleStrong = document.createElement('strong');
			titleStrong.textContent = this.combinedView ? 'Combined fetched album' : 'Fetched video library';
			const titleMeta = document.createElement('span');
			titleMeta.textContent = `${this.albumCache.size} fetched albums · ${rows.length} total videos · ${terms.length ? `${rows.length} match${rows.length === 1 ? '' : 'es'}` : 'all videos'}${this.selectedFetchedVideoUrls.size ? ` · ${this.selectedFetchedVideoUrls.size} selected` : ''}${limited.length !== rows.length ? ` · showing ${limited.length}` : ''}${limited.length > initiallyRendered ? ` · rendering ${initiallyRendered}/${limited.length}` : ''}`;
			title.append(titleStrong, titleMeta);
			const tools = document.createElement('div');
			tools.className = 'bae-results-tools';
			const importSelected = document.createElement('button');
			importSelected.className = 'bae-combined-toggle bae-result-import';
			importSelected.type = 'button';
			importSelected.textContent = this.selectedFetchedVideoUrls.size ? `Import selected (${this.selectedFetchedVideoUrls.size})` : 'Import selected';
			importSelected.disabled = !this.selectedFetchedVideoUrls.size;
			importSelected.addEventListener('click', () => this.importFetchedVideoRows(rows.filter((row) => this.selectedFetchedVideoUrls.has(this.getFetchedVideoKey(row)))));
			const allSelected = rows.length > 0 && rows.every((row) => this.selectedFetchedVideoUrls.has(this.getFetchedVideoKey(row)));
			const selectAll = document.createElement('button');
			selectAll.className = 'bae-batch-fetch';
			selectAll.type = 'button';
			selectAll.textContent = allSelected ? 'Clear selection' : `Select all (${rows.length})`;
			selectAll.addEventListener('click', () => this.setFetchedVideoSelection(rows, !allSelected));
			const fetchSelected = document.createElement('button');
			fetchSelected.className = 'bae-batch-fetch';
			fetchSelected.type = 'button';
			fetchSelected.textContent = this.selectedFetchedVideoUrls.size ? `Fetch selected (${this.selectedFetchedVideoUrls.size})` : 'Fetch selected';
			fetchSelected.title = 'Fetch preview and page details only for selected videos';
			fetchSelected.disabled = !this.selectedFetchedVideoUrls.size;
			fetchSelected.addEventListener('click', () => this.fetchFetchedVideoDetails(rows.filter((row) => this.selectedFetchedVideoUrls.has(this.getFetchedVideoKey(row))), 'selected videos'));
			const fetchAllDetails = document.createElement('button');
			fetchAllDetails.className = 'bae-batch-fetch';
			fetchAllDetails.type = 'button';
			fetchAllDetails.textContent = `Fetch all details (${rows.length})`;
			fetchAllDetails.title = 'Fetch preview and page details for every matching video';
			fetchAllDetails.disabled = !rows.length;
			fetchAllDetails.addEventListener('click', () => this.fetchFetchedVideoDetails(rows, 'matching videos'));
			if (this.combinedView) {
				const combinedSearch = document.createElement('input');
				combinedSearch.className = 'bae-result-search';
				combinedSearch.type = 'search';
				combinedSearch.placeholder = 'Search combined album…';
				combinedSearch.value = this.activeGlobalFilter;
				combinedSearch.setAttribute('aria-label', 'Search combined fetched album');
				const submitCombinedSearch = () => window.dispatchEvent(new CustomEvent('bae-global-filter', { detail: combinedSearch.value || '' }));
				combinedSearch.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); submitCombinedSearch(); } });
				const combinedSearchButton = document.createElement('button');
				combinedSearchButton.className = 'bae-search-submit';
				combinedSearchButton.type = 'button';
				combinedSearchButton.textContent = 'Search';
				combinedSearchButton.addEventListener('click', submitCombinedSearch);
				tools.append(combinedSearch, combinedSearchButton);
			}
			const sort = document.createElement('select');
			sort.className = 'bae-result-sort';
			sort.setAttribute('aria-label', 'Sort fetched videos');
			sort.innerHTML = '<option value="newest">Newest first</option><option value="largest">Largest first</option><option value="duration">Longest duration</option><option value="name">Video name A–Z</option><option value="album">Album name A–Z</option>';
			sort.value = this.resultSort;
			sort.addEventListener('change', () => {
				this.resultSort = sort.value;
				localStorage.setItem(STORAGE_KEYS.resultSort, this.resultSort);
				this.renderGlobalFileResults(terms);
			});
			const combined = document.createElement('button');
			combined.className = `bae-combined-toggle${this.combinedView ? ' is-active' : ''}`;
			combined.textContent = this.combinedView ? 'Exit combined view' : 'Open as combined album';
			combined.addEventListener('click', () => this.setCombinedView(!this.combinedView));
			const drawerToggle = document.createElement('button');
			drawerToggle.className = 'bae-library-drawer-toggle';
			drawerToggle.type = 'button';
			drawerToggle.textContent = this.libraryDrawerCollapsed ? '▸ Show gallery' : '▾ Hide gallery';
			drawerToggle.setAttribute('aria-expanded', this.libraryDrawerCollapsed ? 'false' : 'true');
			drawerToggle.addEventListener('click', () => this.setLibraryDrawerCollapsed(!this.libraryDrawerCollapsed));
			const durationFetch = document.createElement('button');
			durationFetch.className = 'bae-duration-fetch';
			durationFetch.textContent = 'Fetch durations';
			durationFetch.title = 'Fetch duration metadata using the Nexus helper';
			durationFetch.style.display = document.querySelector('button[data-act="fetchmeta"]') ? '' : 'none';
			durationFetch.addEventListener('click', () => document.querySelector('button[data-act="fetchmeta"]')?.click());
			tools.append(selectAll, fetchSelected, fetchAllDetails, importSelected, durationFetch, combined, sort, drawerToggle);
			header.append(title, tools);
			panel.appendChild(header);

			const list = document.createElement('div');
			list.className = limited.length ? 'bae-results-grid' : 'bae-results-empty';
			if (limited.length) {
				const appendNextChunk = () => {
					const start = list.children.length;
					const nextRows = limited.slice(start, start + CONFIG.globalFileRenderChunk);
					if (!nextRows.length) return;
					const fragment = document.createDocumentFragment();
					nextRows.forEach((row) => fragment.appendChild(this.buildFileResultItem(row)));
					list.appendChild(fragment);
				};
				appendNextChunk();
				let appendQueued = false;
				list.addEventListener('scroll', () => {
					if (appendQueued || list.scrollTop + list.clientHeight < list.scrollHeight - 480) return;
					appendQueued = true;
					requestAnimationFrame(() => { appendQueued = false; appendNextChunk(); });
				}, { passive: true });
			}
			else list.textContent = this.albumCache.size
				? 'No videos match this search. Try fewer words or a different spelling.'
				: 'Index visible albums to build a fast searchable video-title library. Fetch a card only when you need its preview or details.';

			panel.appendChild(list);
			panel.style.display = 'block';
		}

		setCombinedView(enabled) {
			this.combinedView = !!enabled;
			document.body.classList.toggle('bae-combined-mode', this.combinedView);
			this.renderGlobalFileResults(normalizeSearchText(this.activeGlobalFilter).split(/\s+/).filter(Boolean));
		}

		setLibraryDrawerCollapsed(collapsed) {
			this.libraryDrawerCollapsed = !!collapsed;
			localStorage.setItem(STORAGE_KEYS.libraryCollapsed, this.libraryDrawerCollapsed ? '1' : '0');
			const panel = this.qs('.bae-file-results-panel');
			panel?.classList.toggle('is-collapsed', this.libraryDrawerCollapsed);
			const toggle = this.qs('.bae-library-drawer-toggle', panel);
			if (toggle) {
				toggle.textContent = this.libraryDrawerCollapsed ? '▸ Show gallery' : '▾ Hide gallery';
				toggle.setAttribute('aria-expanded', this.libraryDrawerCollapsed ? 'false' : 'true');
			}
		}

		getFetchedVideoUrl(row) {
			return `https://${row.albumDomain}${row.file.href}`;
		}

		getFetchedVideoKey(row) {
			return this.getFetchedVideoUrl(row);
		}

		toggleFetchedVideoSelection(row, selected) {
			const key = this.getFetchedVideoKey(row);
			if (selected) this.selectedFetchedVideoUrls.add(key);
			else this.selectedFetchedVideoUrls.delete(key);
			this.renderGlobalFileResults(normalizeSearchText(this.activeGlobalFilter).split(/\s+/).filter(Boolean));
		}

		setFetchedVideoSelection(rows, selected) {
			rows.forEach((row) => {
				const key = this.getFetchedVideoKey(row);
				if (selected) this.selectedFetchedVideoUrls.add(key);
				else this.selectedFetchedVideoUrls.delete(key);
			});
			this.renderGlobalFileResults(normalizeSearchText(this.activeGlobalFilter).split(/\s+/).filter(Boolean));
		}

		getFetchedImportPort() {
			try {
				return Number(JSON.parse(localStorage.getItem('bunkr-suite:album:prefs:v1') || '{}').port) || 8000;
			} catch {
				return 8000;
			}
		}

		gmImportFetch(url, body) {
			if (typeof GM_xmlhttpRequest !== 'function') return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
			return new Promise((resolve, reject) => GM_xmlhttpRequest({
				method: 'POST', url, headers: { 'Content-Type': 'application/json' }, data: body, timeout: 30000,
				onload: (response) => resolve({ ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => { try { return JSON.parse(response.responseText || '{}'); } catch { return {}; } } }),
				onerror: () => reject(new Error('Nexus dashboard is unreachable.')),
				ontimeout: () => reject(new Error('Nexus import timed out.')),
			}));
		}

		async importFetchedVideoRows(rows) {
			const uniqueRows = Array.from(new Map(rows.map((row) => [this.getFetchedVideoKey(row), row])).values());
			if (!uniqueRows.length) return;
			const candidates = uniqueRows.map((row) => ({
				url: this.getFetchedVideoUrl(row), source_url: this.getFetchedVideoUrl(row), title: row.file.title || 'Bunkr video',
				thumbnail: row.file.thumbSrc || '', duration: row.duration || 0, file_size_mb: Number((parseSizeToBytes(row.file.size) / (1024 ** 2)).toFixed(2)),
				source: 'bunkr', tags: ['bunkr', 'balbums'],
			}));
			const port = this.getFetchedImportPort();
			this.emitStatus(`Queuing ${candidates.length} selected video(s) for import…`);
			try {
				const payload = JSON.stringify({ batch_name: `Bunkr archive · ${this.activeGlobalFilter || 'fetched library'}`, candidates });
				const response = await this.gmImportFetch(`http://localhost:${port}/api/v1/intake/import`, payload);
				const data = await response.json().catch(() => ({}));
				if (!response.ok) throw new Error(data.detail || `Server ${response.status}`);
				this.selectedFetchedVideoUrls.clear();
				this.emitStatus(`Queued ${data.job?.total_items ?? candidates.length} video(s) for import — job #${data.job?.id ?? '?'}.`);
				this.renderGlobalFileResults(normalizeSearchText(this.activeGlobalFilter).split(/\s+/).filter(Boolean));
			} catch (error) {
				this.emitStatus(`Import failed: ${error.message || error}`);
			}
		}

		async fetchFileDetails(row, button, options = {}) {
			const fileUrl = this.getFetchedVideoUrl(row);
			if (button) { button.disabled = true; button.textContent = 'Loading…'; }
			try {
				const doc = await this.fetchDocumentWithRetry(fileUrl, 2);
				const rawThumb = this.qs('meta[property="og:image"], meta[name="twitter:image"]', doc)?.getAttribute('content') || '';
				if (rawThumb && !row.file.thumbSrc && !/video\.svg|placeholder|\/icon/i.test(rawThumb)) {
					row.file.thumbSrc = new URL(rawThumb, fileUrl).href;
				}
				const detailTitle = this.qs('meta[property="og:title"], title', doc)?.getAttribute('content') || this.qs('title', doc)?.textContent?.trim() || '';
				if (detailTitle && !row.file.title) row.file.title = detailTitle;
				row.file.detailFetched = true;
				const metadata = this.albumCache.get(getNormalizedAlbumUrl(row.albumUrl));
				if (metadata) this.queuePersistentAlbumSave(metadata);
				if (options.render !== false) this.renderGlobalFileResults(normalizeSearchText(this.activeGlobalFilter).split(/\s+/).filter(Boolean));
			} catch (error) {
				if (button) { button.disabled = false; button.textContent = 'Fetch details'; }
				this.emitStatus(`Could not fetch details: ${error.message || error}`);
			}
		}

		async fetchFetchedVideoDetails(rows, label) {
			const pending = rows.filter((row) => !row.file.detailFetched);
			if (!pending.length) {
				this.emitStatus('Details are already loaded for these videos.');
				return;
			}
			let complete = 0;
			this.emitStatus(`Fetching details: 0/${pending.length}`);
			await this.processWithConcurrency(pending, 4, async (row) => {
				await this.fetchFileDetails(row, null, { render: false });
				complete += 1;
				if (complete === pending.length || complete % 12 === 0) this.emitStatus(`Fetching details: ${complete}/${pending.length}`);
			});
			this.emitStatus(`Loaded details for ${complete} ${label}.`);
			this.renderGlobalFileResults(normalizeSearchText(this.activeGlobalFilter).split(/\s+/).filter(Boolean));
		}

		buildFileResultItem(row) {
			const fileUrl = this.getFetchedVideoUrl(row);
			const dateText = row.file.timestamp ? new Date(row.file.timestamp).toLocaleDateString('en-GB') : 'n/a';

			const item = document.createElement('div');
			item.className = 'bae-result-card';

			const media = document.createElement('div');
			media.className = 'bae-result-media';
			media.tabIndex = 0;
			media.setAttribute('role', 'button');
			media.setAttribute('aria-label', `Play ${row.file.title || 'video'}`);

			const thumb = document.createElement('img');
			if (row.file.thumbSrc) {
				thumb.src = row.file.thumbSrc;
				thumb.onerror = () => { thumb.style.display = 'none'; };
			} else {
				thumb.style.display = 'none';
			}
			thumb.alt = row.file.title ? `Preview for ${row.file.title}` : 'Video preview';
			thumb.loading = 'lazy';
			thumb.decoding = 'async';

			const sizeBadge = document.createElement('span');
			sizeBadge.className = 'bae-result-badge';
			sizeBadge.textContent = row.file.size || 'Size unknown';
			const selectLabel = document.createElement('label');
			selectLabel.className = 'bae-result-select';
			const select = document.createElement('input');
			select.type = 'checkbox';
			select.checked = this.selectedFetchedVideoUrls.has(this.getFetchedVideoKey(row));
			select.setAttribute('aria-label', `Select ${row.file.title || 'video'} for import`);
			select.addEventListener('click', (event) => event.stopPropagation());
			select.addEventListener('change', () => this.toggleFetchedVideoSelection(row, select.checked));
			selectLabel.append(select, document.createTextNode('Select'));
			item.classList.toggle('is-selected', select.checked);
			media.append(thumb, sizeBadge, selectLabel);

			const textWrap = document.createElement('div');
			textWrap.className = 'bae-result-body';

			const title = document.createElement('div');
			title.textContent = row.file.title || 'Untitled';
			title.className = 'bae-result-name';
			title.title = title.textContent;

			const album = document.createElement('div');
			album.className = 'bae-result-album';
			album.textContent = row.albumName;
			album.title = row.albumName;
			const sub = document.createElement('div');
			sub.className = 'bae-result-meta';
			const durationText = row.duration ? `${Math.floor(row.duration / 60)}:${String(Math.floor(row.duration % 60)).padStart(2, '0')}` : 'duration n/a';
			sub.textContent = `${dateText} · ${row.file.size || 'size unknown'} · ${durationText}`;

			const actions = document.createElement('div');
			actions.className = 'bae-result-actions';

			const playBtn = document.createElement('button');
			playBtn.textContent = 'Play';
			const play = (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.openPlayerModal(fileUrl, row.file.title || 'Untitled');
			};
			playBtn.addEventListener('click', play);
			media.addEventListener('click', play);
			media.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') play(e); });
			const detailsBtn = document.createElement('button');
			detailsBtn.textContent = row.file.detailFetched ? 'Details loaded' : 'Fetch details';
			detailsBtn.disabled = !!row.file.detailFetched;
			detailsBtn.title = 'Fetch preview and page details for this video only';
			detailsBtn.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.fetchFileDetails(row, detailsBtn); });

			const openBtn = document.createElement('a');
			openBtn.href = fileUrl;
			openBtn.target = '_blank';
			openBtn.rel = 'noopener noreferrer';
			openBtn.textContent = '↗';
			openBtn.title = 'Open video source';
			openBtn.setAttribute('aria-label', 'Open video source');
			const albumBtn = document.createElement('a');
			albumBtn.href = row.albumUrl || fileUrl;
			albumBtn.target = '_blank';
			albumBtn.rel = 'noopener noreferrer';
			albumBtn.textContent = 'A';
			albumBtn.title = 'Open source album';
			albumBtn.setAttribute('aria-label', 'Open source album');

			const importBtn = document.createElement('button');
			importBtn.className = 'bae-result-import';
			importBtn.textContent = 'Import';
			importBtn.title = 'Import this video into Nexus';
			importBtn.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.importFetchedVideoRows([row]); });
			actions.append(playBtn, detailsBtn, importBtn, albumBtn, openBtn);
			textWrap.append(title, album, sub, actions);
			item.append(media, textWrap);
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
				video.autoplay = true;
				video.playsInline = true;
				video.preload = 'auto';
				video.style = 'width:100%; max-height:75vh; border-radius:8px; background:#000;';
				const iframe = document.createElement('iframe');
				iframe.className = 'bae-player-iframe';
				iframe.allow = 'autoplay *; encrypted-media *; fullscreen *; picture-in-picture *';
				iframe.referrerPolicy = 'origin';
				iframe.style = 'display:none; width:100%; height:min(75vh, 620px); border:0; border-radius:8px; background:#000;';

				head.append(hTitle, close);
				card.append(head, video, iframe);
				overlay.appendChild(card);
				overlay.addEventListener('click', (e) => {
					if (e.target === overlay) this.closePlayerModal();
				});
				document.body.appendChild(overlay);
				this.playerModal = overlay;
			}

			const titleEl = this.qs('.bae-player-title', this.playerModal);
			const videoEl = this.qs('.bae-player-video', this.playerModal);
			const iframeEl = this.qs('.bae-player-iframe', this.playerModal);
			const requestId = Symbol('bae-player-request');
			this.playerRequestId = requestId;
			if (this.playerBlobUrl) {
				URL.revokeObjectURL(this.playerBlobUrl);
				this.playerBlobUrl = null;
			}

			const autoplayNativeIframe = () => {
				let attempts = 0;
				const tick = () => {
					if (this.playerRequestId !== requestId || !iframeEl) return;
					try {
						const doc = iframeEl.contentDocument || iframeEl.contentWindow?.document;
						const video = doc?.querySelector('video');
						if (video && video.paused) {
							video.muted = false;
							video.play().catch(() => {
								video.muted = true;
								video.play().catch(() => {});
							});
						}
					} catch { /* cross-origin bunkr page */ }
					attempts += 1;
					if (attempts < 16) setTimeout(tick, 250);
				};
				iframeEl.addEventListener('load', tick, { once: true });
				setTimeout(tick, 400);
			};

			const switchToNativePlayer = () => {
				if (this.playerRequestId !== requestId || !iframeEl) return;
				if (videoEl) {
					videoEl.pause();
					videoEl.removeAttribute('src');
					videoEl.load();
					videoEl.style.display = 'none';
				}
				const nativeUrl = url.replace(/\/f\//i, '/v/');
				iframeEl.style.display = 'block';
				iframeEl.src = nativeUrl;
				autoplayNativeIframe();
				if (titleEl) titleEl.textContent = `${title} — playing with Bunkr's native player.`;
			};

			const playDirect = async (streamUrl, label = title) => {
				if (this.playerRequestId !== requestId || !videoEl) return;
				if (iframeEl) { iframeEl.style.display = 'none'; iframeEl.src = 'about:blank'; }
				videoEl.style.display = 'block';
				videoEl.muted = false;
				videoEl.src = streamUrl;
				videoEl.currentTime = 0;
				if (titleEl) titleEl.textContent = label;
				await startVideoPlayback(videoEl);
			};

			if (titleEl) titleEl.textContent = `${title} — resolving…`;
			if (videoEl) {
				videoEl.style.display = 'block';
				videoEl.removeAttribute('src');
				videoEl.load();
			}
			if (iframeEl) { iframeEl.style.display = 'none'; iframeEl.src = 'about:blank'; }
			this.playerModal.style.display = 'flex';

			try {
				const streamUrl = await resolveBunkrStreamUrl(url);
				if (!cleanPlayableMediaUrl(streamUrl)) throw new Error('Resolver did not return a media URL.');
				let handedOff = false;
				if (videoEl) {
					videoEl.onerror = async () => {
						if (handedOff || this.playerRequestId !== requestId) return;
						handedOff = true;
						if (titleEl) titleEl.textContent = `${title} — buffering stream…`;
						try {
							const blobUrl = await fetchVideoBlobUrl(streamUrl, url);
							if (this.playerRequestId !== requestId) {
								URL.revokeObjectURL(blobUrl);
								return;
							}
							this.playerBlobUrl = blobUrl;
							await playDirect(blobUrl, title);
						} catch (error) {
							console.warn('[Bunkr Albums Enhanced] Blob playback failed; using native Bunkr player', error);
							switchToNativePlayer();
						}
					};
				}
				await playDirect(streamUrl);
			} catch (error) {
				console.warn('[Bunkr Albums Enhanced] Stream resolution failed; using native Bunkr player', { url, error });
				switchToNativePlayer();
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
			const iframeEl = this.qs('.bae-player-iframe', this.playerModal);
			if (iframeEl) { iframeEl.src = 'about:blank'; iframeEl.style.display = 'none'; }
			if (this.playerBlobUrl) {
				URL.revokeObjectURL(this.playerBlobUrl);
				this.playerBlobUrl = null;
			}
			this.playerRequestId = null;
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
			if (titleEl) titleEl.textContent = `${slot}: resolvingâ¦`;
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

		scheduleLibraryRender() {
			clearTimeout(this.libraryRenderTimer);
			this.libraryRenderTimer = setTimeout(() => this.applyGlobalFilter(this.activeGlobalFilter), 350);
		}

		updateLoadMoreUi() {
			const info = this.qs('.bae-page-info');
			if (!info) return;
			const loadedThrough = this.nextPage - 1;
			const total = this.totalPages ? ` of ${this.totalPages}` : '';
			const albums = getAlbumCards(document).length;
			info.textContent = this.reachedEnd
				? `all pages loaded · ${albums} albums`
				: `through page ${loadedThrough}${total} · ${albums} albums`;

			const atEnd = this.reachedEnd || (this.totalPages && this.nextPage > this.totalPages);
			this.qsa('.bae-load-more, .bae-load-custom, .bae-load-all').forEach((b) => {
				b.disabled = !!atEnd;
				b.style.opacity = atEnd ? '.45' : '';
				b.style.cursor = atEnd ? 'not-allowed' : '';
			});
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
				resultsLayout: 'grid',
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
					files: Array.isArray(stored.files) ? stored.files : [],
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
				detailsReady: !!metadata.detailsReady,
				files: (metadata.files || []).map((file) => ({
					href: file.href || '',
					title: file.title || '',
					size: file.size || '',
					isVideo: !!file.isVideo,
					thumbSrc: file.thumbSrc || '',
					detailFetched: !!file.detailFetched,
					timestamp: file.timestamp || 0,
				})),
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
				signal.title = `${getAlbumTitleFromCard(album) || 'Album'}${newest ? ` Â· ${Math.max(0, Math.floor(ageDays))}d` : ' Â· not fetched'}`;
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
			// Try multiple selectors â bunkr card structure varies
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
				parts.push('ð ' + new Date(metadata.newestTimestamp).toLocaleDateString('en-GB'));
			}
			if (metadata.fileCount) parts.push(metadata.fileCount + ' Videos');
			const text = parts.join(' â¢ ');
			if (!text) return;

			// Try structured badge first
			let metaNode = this.ensureAlbumMetaBadge(album);
			// Hard fallback â just find or create directly on album root
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
				cacheBadge.textContent = isAlbumCacheFresh(metadata) ? 'cached' : 'cached Â· refresh due';
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
			qualityBadge.textContent = `â ${quality.label} Â· Ã ${formatBytes(quality.averageBytes)}/video`;
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
			const image = Array.from(item.querySelectorAll('.grid-images_box-img, img')).find((candidate) => {
				const source = candidate.getAttribute('data-src')
					|| candidate.getAttribute('data-lazy-src')
					|| candidate.getAttribute('data-original')
					|| candidate.getAttribute('src')
					|| '';
				return source && !/video\.svg|placeholder|icon/i.test(source);
			});
			const rawThumb = image?.getAttribute('data-src')
				|| image?.getAttribute('data-lazy-src')
				|| image?.getAttribute('data-original')
				|| image?.getAttribute('src')
				|| '';
			const title = item.querySelector('p')?.textContent?.trim()
				|| item.querySelector('.grid-images_box-name')?.textContent?.trim()
				|| fileLink.textContent?.trim()
				|| fileLink.getAttribute('title')?.trim()
				|| image?.getAttribute('alt')?.trim()
				|| href.split('/').pop()?.replace(/[-_]+/g, ' ').trim()
				|| 'Untitled';
			const size = extractSizeFromText(text) || this.qs('.grid-images_box-size', item)?.textContent?.trim() || '';
			const dateText = extractDateFromText(text);
			const dateObj = dateText ? parseBunkrDate(dateText) : null;
			// On the current Bunkr album page, only this badge distinguishes a
			// video from an image, archive, or other file type.
			const isVideo = !!this.qs('.type-Video', item);

			return {
				href,
				title,
				size,
				isVideo,
				thumbSrc: rawThumb,
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
				const wantsAlbumDetails = options.indexOnly === false;
				if ((cached.files || []).length && isAlbumCacheFresh(cached) && (!wantsAlbumDetails || cached.detailsReady)) return cached;
			}

			const firstDoc = await this.fetchDocumentWithRetry(albumUrl);
			const albumDomain = this.getAlbumDomain(albumUrl);
			const headerText = this.qs('h1 + p', firstDoc)?.textContent?.trim() || '';
			const metaMatch = headerText.match(/\(([^)]+)\)/);
			const albumMeta = metaMatch ? metaMatch[1] : '';

			const discoveredUrls = this.getAlbumPageUrls(firstDoc, albumUrl).slice(0, CONFIG.maxAlbumPagesToScan);
			const docs = [firstDoc];
			const extraPageUrls = discoveredUrls.filter((u) => u !== albumUrl);
			await this.processWithConcurrency(extraPageUrls, CONFIG.concurrentAlbumPageFetches, async (pageUrl) => {
				const doc = await this.fetchDocumentWithRetry(pageUrl, 2).catch(() => null);
				if (doc) docs.push(doc);
			});
			const indexOnly = options.indexOnly !== false;

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
					try {
						file.thumbSrc = file.thumbSrc ? new URL(file.thumbSrc, albumUrl).href : '';
					} catch {
						file.thumbSrc = '';
					}
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
				detailsReady: !indexOnly,
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

		async fetchDocumentWithRetry(url, attempts = 3) {
			let lastError = null;
			for (let attempt = 1; attempt <= attempts; attempt++) {
				try {
					const response = await fetch(url);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					return new DOMParser().parseFromString(await response.text(), 'text/html');
				} catch (error) {
					lastError = error;
					if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 240 * attempt));
				}
			}
			throw lastError || new Error('Album request failed');
		}

		async fetchVisibleAlbums(limit = 100) {
			// limit may be Infinity ("fetch all visible") — slice handles that fine,
			// but `limit || 100` would turn a legitimate Infinity into itself and 0
			// into 100, so normalise explicitly.
			const cap = limit === Infinity ? Infinity : Math.max(1, Number(limit) || 100);
			const albumUrls = this.getVisibleAlbums()
				.slice(0, cap)
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
			const failed = [];
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
					try {
						await this.fetchAlbumData(realUrl, album);
					} catch (error) {
						failed.push({ url: realUrl, message: error?.message || 'Fetch failed' });
					}
					done += 1;
					this.updateDashboard();
					if (done % CONFIG.fetchRenderEveryAlbums === 0 || done === selected.length) this.scheduleLibraryRender();
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
			const successful = selected.length - failed.length;
			this.emitStatus(failed.length
				? `Fetched ${successful}/${selected.length} albums · ${failed.length} failed after retries.`
				: `Fetched video metadata for ${selected.length} album(s).`);
			if (emitBridgeProgress) {
				this.bridge.emitFetchProgress(requestId, 'complete', {
					total: selected.length,
					processed: done,
					status: failed.length ? `Fetched ${successful}/${selected.length} albums.` : `Fetched video metadata for ${selected.length} album(s).`,
					failed,
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
			this.previewTimeout = setTimeout(async () => {
				if (this.selectionMode) return;
				if (container.innerHTML.trim()) {
					container.style.display = 'flex';
					return;
				}

				try {
					const albumElement = container.closest('.rounded-xl.bg-mute.border-b, a.card[href*="/a/"]');
					const cached = this.albumCache.get(getNormalizedAlbumUrl(albumUrl));
					const hasThumbs = (cached?.files || []).some((file) => file.thumbSrc);
					const data = await this.fetchAlbumData(albumUrl, albumElement, { requireFiles: true, indexOnly: hasThumbs });

					container.innerHTML = '';

					// Info Bar
					const infoBar = document.createElement('div');
					infoBar.style = 'width: 100%; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; border-bottom: 1px solid #444; padding-bottom: 8px;';

					const searchInput = document.createElement('input');
					searchInput.placeholder = 'ð Filter videos...';
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
					copyBtn.textContent = 'ð Links';
					copyBtn.style = 'background: #1f2937; color: #fff; border: 1px solid #4b5563; border-radius: 8px; padding: 7px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;';
					copyBtn.addEventListener('click', (e) => {
						e.preventDefault();
						e.stopPropagation();
						const visibleItems = Array.from(container.querySelectorAll('.preview-item-wrapper'))
							.filter(el => el.style.display !== 'none');
						const links = visibleItems.map(el => el.getAttribute('data-url')).join('\n');
						navigator.clipboard.writeText(links).then(() => {
							const oldText = copyBtn.textContent;
							copyBtn.textContent = 'â Copied!';
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
							infoContent += ` â¢ ${oldestStr}`;
						} else {
							infoContent += ` â¢ ${oldestStr} â ${newestStr}`;
						}
					}
					if (!infoContent) {
						infoContent = `${data.fileCount} Videos`;
					} else if (data.fileCount) {
						infoContent += ` â¢ ${data.fileCount} Videos`;
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
				vidBadge.textContent = 'â¶';
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
			// Ignore if clicking anywhere inside the preview area or any Nexus suite UI (Quick Peek, checkbox, badge, modal)
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
