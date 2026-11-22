// ==UserScript==
// @name         Gofile Folder Grid View & Media Enhancer
// @namespace    nexus.gofile.grid.enhancer
// @version      1.6.0
// @description  Premeňte vertikálny zoznam v Gofile priečinkoch na modernú a prehľadnú 3x2 mriežku (Grid View) s veľkými náhľadmi, rýchlym ovládaním, presnými veľkosťami, Nexus Import Desk, batchmi, Source Boards a plným prehrávaním videí.
// @author       Nexus & Antigravity
// @match        https://gofile.io/*
// @match        https://*.gofile.io/*
// @icon         https://gofile.io/dist/img/favicon16.png
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_download
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function () {

  // Universal Nexus i18n helper (supports Slovak and English)
  const _getLang = () => {
    try {
      if (typeof GM_getValue === 'function') {
        const g = GM_getValue('nexus_language');
        if (g === 'en' || g === 'sk') return g;
      }
      if (typeof localStorage !== 'undefined') {
        const l = localStorage.getItem('nexus_language');
        if (l === 'en' || l === 'sk') return l;
        const v = localStorage.getItem('vipSettings');
        if (v) {
          const p = JSON.parse(v);
          if (p.language === 'en' || p.tooltipLanguage === 'en') return 'en';
          if (p.language === 'sk' || p.tooltipLanguage === 'sk') return 'sk';
        }
      }
      if (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) {
        if (document.documentElement.lang.startsWith('sk')) return 'sk';
        if (document.documentElement.lang.startsWith('en')) return 'en';
      }
      if (typeof navigator !== 'undefined' && navigator.language && navigator.language.startsWith('sk')) return 'sk';
    } catch (_) {}
    return 'en';
  };
  const _t = (sk, en) => (_getLang() === 'sk' ? sk : en);

  'use strict';

  // ────────────────────────────────────────────────────────────
  // 1. Konfigurácia a stav (Storage)
  // ────────────────────────────────────────────────────────────

  const STORAGE_PREFIX = 'gfg_pref_';

  function getPref(key, defaultValue) {
    try {
      if (typeof GM_getValue === 'function') {
        const val = GM_getValue(key, undefined);
        if (val !== undefined) return val;
      }
      const local = localStorage.getItem(STORAGE_PREFIX + key);
      return local !== null ? JSON.parse(local) : defaultValue;
    } catch {
      return defaultValue;
    }
  }

  function setPref(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
      }
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch (e) {
      console.warn('[Gofile Grid] Nepodarilo sa uložiť nastavenie:', e);
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  const state = {
    viewMode: getPref('viewMode', 'grid'), // 'grid' | 'list'
    columns: getPref('columns', 3),        // 2, 3, 4, alebo 'auto'
    hoverZoom: getPref('hoverZoom', true),
    filterText: '',
    sortMode: 'original',
    activeItems: [],
    folderContainer: null,
    observer: null
  };

  // ────────────────────────────────────────────────────────────
  // 2. CSS Štýly (Modern Dark Glassmorphism)
  // ────────────────────────────────────────────────────────────

  const STYLES = `
    /* Root premenné a farebná paleta */
    :root {
      --gfg-bg-card: #131c31;
      --gfg-bg-card-hover: #192542;
      --gfg-bg-toolbar: rgba(19, 28, 49, 0.94);
      --gfg-border: rgba(255, 255, 255, 0.08);
      --gfg-border-hover: rgba(99, 102, 241, 0.55);
      --gfg-accent: #6366f1;
      --gfg-accent-hover: #4f46e5;
      --gfg-accent-glow: rgba(99, 102, 241, 0.28);
      --gfg-text-main: #f8fafc;
      --gfg-text-muted: #94a3b8;
      --gfg-radius: 14px;
      --gfg-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.45);
      --gfg-shadow-hover: 0 14px 32px -4px rgba(0, 0, 0, 0.65), 0 0 16px var(--gfg-accent-glow);
    }

    /* Ovládací Toolbar */
    #gfg-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin: 16px 0 22px 0;
      padding: 12px 18px;
      background: var(--gfg-bg-toolbar);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--gfg-border);
      border-radius: var(--gfg-radius);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
      color: var(--gfg-text-main);
      font-family: inherit;
      z-index: 40;
      position: relative;
    }

    .gfg-toolbar-group {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .gfg-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 13px;
      font-size: 13px;
      font-weight: 500;
      color: var(--gfg-text-main);
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--gfg-border);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      user-select: none;
      outline: none;
    }

    .gfg-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.2);
      transform: translateY(-1px);
    }

    .gfg-btn.active {
      background: var(--gfg-accent);
      border-color: var(--gfg-accent);
      color: #ffffff;
      box-shadow: 0 0 12px var(--gfg-accent-glow);
    }

    .gfg-btn-secondary {
      background: rgba(99, 102, 241, 0.15);
      border-color: rgba(99, 102, 241, 0.35);
      color: #a5b4fc;
    }
    .gfg-btn-secondary:hover {
      background: rgba(99, 102, 241, 0.25);
      border-color: var(--gfg-accent);
      color: #ffffff;
    }

    .gfg-btn-import {
      background: linear-gradient(135deg, #16a34a, #22c55e);
      border-color: #4ade80;
      color: #052e16;
      font-weight: 700;
      box-shadow: 0 5px 14px rgba(34, 197, 94, 0.2);
    }
    .gfg-btn-import:hover:not(:disabled) {
      background: linear-gradient(135deg, #22c55e, #4ade80);
      border-color: #86efac;
      color: #052e16;
    }
    .gfg-btn-import:disabled {
      opacity: 0.46;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }

    .gfg-import-settings {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 4px 7px;
      border: 1px solid rgba(74, 222, 128, 0.22);
      border-radius: 9px;
      background: rgba(22, 163, 74, 0.07);
    }
    .gfg-import-settings-label {
      font-size: 11px;
      font-weight: 700;
      color: #86efac;
      white-space: nowrap;
    }
    #gfg-batch-name {
      width: 180px;
      padding: 6px 9px;
      font-size: 12px;
    }
    #gfg-batch-name:focus { width: 220px; }
    .gfg-source-board-toggle {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: #bbf7d0;
      font-size: 11.5px;
      font-weight: 600;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
    }
    .gfg-source-board-toggle input {
      width: 14px;
      height: 14px;
      margin: 0;
      accent-color: #22c55e;
      cursor: pointer;
    }

    .gfg-input {
      padding: 7px 12px 7px 32px;
      font-size: 13px;
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid var(--gfg-border);
      border-radius: 8px;
      color: var(--gfg-text-main);
      outline: none;
      width: 190px;
      transition: all 0.2s ease;
    }
    .gfg-input:focus {
      border-color: var(--gfg-accent);
      background: rgba(15, 23, 42, 0.95);
      width: 230px;
      box-shadow: 0 0 0 2px var(--gfg-accent-glow);
    }

    .gfg-search-box {
      position: relative;
      display: flex;
      align-items: center;
    }
    .gfg-search-icon {
      position: absolute;
      left: 10px;
      width: 14px;
      height: 14px;
      color: var(--gfg-text-muted);
      pointer-events: none;
    }

    .gfg-select {
      padding: 7px 10px;
      font-size: 13px;
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid var(--gfg-border);
      border-radius: 8px;
      color: var(--gfg-text-main);
      outline: none;
      cursor: pointer;
    }
    .gfg-select:focus {
      border-color: var(--gfg-accent);
    }

    .gfg-badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      font-size: 11.5px;
      font-weight: 600;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--gfg-text-muted);
    }

    .gfg-badge-accent {
      background: rgba(99, 102, 241, 0.2);
      color: #c7d2fe;
      border: 1px solid rgba(99, 102, 241, 0.3);
    }

    /* SIDECAR WORKSPACE LAYOUT */
    body.gfg-sidecar-active #layout-menu,
    body.gfg-sidecar-active aside,
    body.gfg-sidecar-active nav.sidebar {
      width: 0 !important;
      overflow: hidden !important;
      padding: 0 !important;
      margin: 0 !important;
      opacity: 0 !important;
      transition: all 0.3s ease;
    }

    body.gfg-sidecar-active #layout-wrapper {
      padding-left: 0 !important;
      margin-left: 0 !important;
    }

    #gfg-menu-toggle {
      position: fixed;
      top: 15px;
      left: 15px;
      z-index: 99999;
      background: var(--gfg-bg-toolbar);
      border: 1px solid var(--gfg-border);
      border-radius: 8px;
      color: var(--gfg-text-main);
      padding: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      transition: all 0.2s;
    }
    #gfg-menu-toggle:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.2);
    }

    #gfg-sidecar {
      position: fixed;
      top: 0;
      right: -450px; /* hidden by default */
      width: 450px;
      height: 100vh;
      background: var(--gfg-bg-toolbar);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-left: 1px solid var(--gfg-border);
      z-index: 9999;
      display: flex;
      flex-direction: column;
      transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: -10px 0 30px rgba(0,0,0,0.5);
    }

    body.gfg-sidecar-open #gfg-sidecar {
      right: 0;
    }

    body.gfg-sidecar-open main,
    body.gfg-sidecar-open #files-container,
    body.gfg-sidecar-open .files-container {
      width: calc(100% - 450px) !important;
      transition: width 0.3s ease;
    }

    #gfg-sidecar-header {
      padding: 15px;
      border-bottom: 1px solid var(--gfg-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(15, 23, 42, 0.8);
    }
    #gfg-sidecar-header h3 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: #f8fafc;
    }

    #gfg-sidecar-player-container {
      width: 100%;
      background: #000;
      position: relative !important;
      overflow: hidden !important;
      aspect-ratio: 16/9;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #gfg-sidecar-player-container video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      outline: none;
    }

    #gfg-sidecar-playlist {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .gfg-playlist-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid transparent;
    }
    .gfg-playlist-item:hover {
      background: rgba(255, 255, 255, 0.08);
    }
    .gfg-playlist-item.playing {
      background: rgba(99, 102, 241, 0.15);
      border-color: rgba(99, 102, 241, 0.4);
    }
    .gfg-playlist-thumb {
      width: 80px;
      height: 45px;
      object-fit: cover;
      border-radius: 4px;
      background: #0f172a;
      flex-shrink: 0;
    }
    .gfg-playlist-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
      overflow: hidden;
    }
    .gfg-playlist-title {
      font-size: 12.5px;
      color: #e2e8f0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 500;
    }
    .gfg-playlist-meta {
      font-size: 11px;
      color: #94a3b8;
    }
    .gfg-sidecar-close {
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      color: #94a3b8;
    }
    .gfg-sidecar-close:hover {
      background: rgba(255,255,255,0.1);
      color: #fff;
    }

    /* Vlastný overlay, ak nechceme natívny */
    .gfg-native-modal-hidden {
      display: none !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }

    /* Zoom Bar */
    #gfg-sidecar-zoom-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      background: rgba(15, 23, 42, 0.7);
      border-top: 1px solid var(--gfg-border);
      border-bottom: 1px solid var(--gfg-border);
      font-size: 12px;
      color: var(--gfg-text-muted);
      flex-shrink: 0;
    }
    .gfg-zoom-btn {
      cursor: pointer;
      padding: 2px 8px;
      border-radius: 5px;
      background: rgba(255,255,255,0.07);
      border: 1px solid var(--gfg-border);
      font-size: 14px;
      font-weight: bold;
      color: #94a3b8;
      user-select: none;
      transition: all 0.15s;
    }
    .gfg-zoom-btn:hover { background: rgba(99,102,241,0.25); color: #fff; border-color: var(--gfg-accent); }
    #gfg-zoom-label { font-size: 11.5px; font-weight: 600; color: #c7d2fe; min-width: 38px; text-align: center; }
    #gfg-playlist-header { margin-left: auto; font-size: 11px; color: #64748b; cursor: default; }

    /* Sidecar Expanded (Vertical Fullscreen) */
    #gfg-sidecar.gfg-sidecar-expanded {
      width: 45vw !important; /* Rozšírime panel */
      min-width: 500px;
    }
    /* Zrušili sme display:none pre main, pretože to zabíjalo React aplikáciu a video zmizlo */
    #gfg-sidecar.gfg-sidecar-expanded #gfg-sidecar-player-container {
      aspect-ratio: unset;
      flex: 2; /* Prehrávač zaberie oveľa viac výšky */
      min-height: 60vh;
    }

    /* Spinner animácia pre loading */
    @keyframes gfg-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    /* GRID ROZLOŽENIE */
    .gfg-grid-container {
      display: grid !important;
      gap: 20px !important;
      width: 100% !important;
      transition: all 0.3s ease !important;
    }

    .gfg-grid-container.gfg-cols-2 {
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    }
    .gfg-grid-container.gfg-cols-3 {
      grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
    }
    .gfg-grid-container.gfg-cols-4 {
      grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
    }
    .gfg-grid-container.gfg-cols-auto {
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)) !important;
    }

    @media (max-width: 1250px) {
      .gfg-grid-container.gfg-cols-3,
      .gfg-grid-container.gfg-cols-4 {
        grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
      }
    }
    @media (max-width: 768px) {
      .gfg-grid-container {
        grid-template-columns: 1fr !important;
      }
    }

    /* ŠTYLIZÁCIA KARTY V GRI-E */
    .gfg-grid-container > .gfg-card-processed {
      display: flex !important;
      flex-direction: column !important;
      font-size: 0 !important;
      color: transparent !important;
      position: relative !important;
      background: var(--gfg-bg-card) !important;
      border: 1px solid var(--gfg-border) !important;
      border-radius: var(--gfg-radius) !important;
      overflow: hidden !important;
      box-shadow: var(--gfg-shadow) !important;
      transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1), 
                  box-shadow 0.22s cubic-bezier(0.4, 0, 0.2, 1), 
                  border-color 0.22s cubic-bezier(0.4, 0, 0.2, 1) !important;
      height: 100% !important;
      box-sizing: border-box !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    .gfg-grid-container > .gfg-card-processed:hover {
      transform: translateY(-4px) !important;
      box-shadow: var(--gfg-shadow-hover) !important;
      border-color: var(--gfg-border-hover) !important;
      background: var(--gfg-bg-card-hover) !important;
    }

    .gfg-grid-container > .gfg-card-processed.gfg-selected {
      border-color: var(--gfg-accent) !important;
      box-shadow: 0 0 0 2px var(--gfg-accent), var(--gfg-shadow-hover) !important;
    }

    /* Thumbnail zóna */
    .gfg-thumb-container {
      position: relative;
      width: 100%;
      height: 200px;
      background: #090e1a;
      overflow: hidden;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .gfg-thumb-container img,
    .gfg-thumb-container video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: transform 0.35s ease;
      display: block;
    }

    .gfg-card-processed:hover .gfg-thumb-container img,
    .gfg-card-processed:hover .gfg-thumb-container video {
      transform: scale(1.06);
    }

    .gfg-thumb-overlay {
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0) 40%, rgba(0,0,0,0.7) 100%);
      opacity: 0.8;
      transition: opacity 0.2s ease;
      pointer-events: none;
    }

    .gfg-card-processed:hover .gfg-thumb-overlay {
      opacity: 1;
    }

    .gfg-play-btn {
      position: absolute;
      width: 52px;
      height: 52px;
      background: rgba(99, 102, 241, 0.95);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #ffffff;
      box-shadow: 0 6px 20px rgba(0,0,0,0.6);
      opacity: 0.9;
      transform: scale(0.9);
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      cursor: pointer;
      z-index: 5;
    }

    .gfg-card-processed:hover .gfg-play-btn {
      opacity: 1;
      transform: scale(1.08);
      background: #4f46e5;
    }

    /* Plávajúce elementy nad náhľadom */
    .gfg-floating-top-left {
      position: absolute;
      top: 10px;
      left: 10px;
      z-index: 10;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .gfg-floating-top-right {
      position: absolute;
      top: 10px;
      right: 10px;
      z-index: 10;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .gfg-card-checkbox {
      width: 20px;
      height: 20px;
      cursor: pointer;
      accent-color: var(--gfg-accent);
      background: rgba(15, 23, 42, 0.85);
      border-radius: 5px;
      border: 1px solid rgba(255, 255, 255, 0.3);
      filter: drop-shadow(0 2px 4px rgba(0,0,0,0.6));
    }

    .gfg-badge-pill {
      background: rgba(15, 23, 42, 0.86);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      padding: 3px 8px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #e2e8f0;
      box-shadow: 0 2px 6px rgba(0,0,0,0.5);
    }

    /* Informácie o súbore */
    .gfg-card-body {
      padding: 14px 16px 14px 16px;
      display: flex;
      flex-direction: column;
      flex-grow: 1;
      justify-content: space-between;
      gap: 8px;
    }

    .gfg-card-title {
      font-size: 13.5px;
      font-weight: 600;
      color: #f1f5f9;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
      word-break: break-word;
      min-height: 36px;
      text-decoration: none;
      cursor: pointer;
      transition: color 0.15s ease;
    }
    .gfg-card-title:hover {
      color: #a5b4fc;
    }

    .gfg-card-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      color: var(--gfg-text-muted);
      margin-top: 2px;
    }

    /* Akčná lišta na spodku karty */
    .gfg-card-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding-top: 10px;
      margin-top: 4px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }

    .gfg-action-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 7px 10px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--gfg-border);
      color: #cbd5e1;
      cursor: pointer;
      text-decoration: none;
      flex: 1;
      transition: all 0.18s ease;
    }

    .gfg-action-btn:hover {
      background: rgba(99, 102, 241, 0.25);
      border-color: rgba(99, 102, 241, 0.6);
      color: #ffffff;
    }

    .gfg-action-btn.btn-download:hover {
      background: rgba(16, 185, 129, 0.25);
      border-color: rgba(16, 185, 129, 0.6);
      color: #6ee7b7;
    }

    .gfg-action-icon-only {
      flex: 0 0 34px;
      width: 34px;
      padding: 7px 0;
    }

    .gfg-item-hidden {
      display: none !important;
    }
  `;

  function injectStyles() {
    if (document.getElementById('gfg-custom-styles')) return;
    const styleEl = document.createElement('style');
    styleEl.id = 'gfg-custom-styles';
    styleEl.textContent = STYLES;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  // ────────────────────────────────────────────────────────────
  // 3. Normalizácia veľkostí a Parsovanie kariet
  // ────────────────────────────────────────────────────────────
  // 3. Extrakcia informácií z DOMu (Názov, Veľkosť, Dátum, atď.)
  // ────────────────────────────────────────────────────────────

  /**
   * Získa textový obsah elementu tak, že medzi jednotlivé textové uzly
   * a elementy vloží medzery. Zabráni zlúčeniu času a veľkosti (napr. '07:25' a '2.2 GB').
   */
  function getElementTextWithSpaces(el) {
    if (!el) return '';
    if (typeof document.createTreeWalker === 'function') {
      let text = '';
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        text += ' ' + node.nodeValue + ' ';
      }
      return text;
    }
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ');
  }

  /**
   * Normalizácia formátu veľkosti na konzistentné zobrazenie.
   */
  function formatNormalizedSize(num, unit) {
    const u = (unit || '').toUpperCase();
    if (u.startsWith('T')) {
      return `${num.toFixed(1)} TB`;
    }
    if (u.startsWith('G')) {
      return `${num.toFixed(1)} GB`;
    }
    if (u.startsWith('M')) {
      if (num >= 1024) {
        return `${(num / 1024).toFixed(2)} GB`;
      }
      return `${num >= 100 ? Math.round(num) : (num % 1 === 0 ? num.toFixed(0) : num.toFixed(1))} MB`;
    }
    if (u.startsWith('K')) {
      return `${Math.round(num)} KB`;
    }
    if (u.startsWith('B')) {
      return `${Math.round(num)} B`;
    }
    return `${num} ${unit}`;
  }

  const STANDALONE_SIZE_REGEX = /^(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB|TB|PB|KiB|MiB|GiB)$/i;
  const SPACED_SIZE_REGEX = /(?:^|[^\w:.])(\d+(?:[.,]\d+)?)\s*(TB|GB|GiB|MB|MiB|KB|KiB|B)\b/gi;

  /**
   * Presné a bezpečné parsovanie veľkosti súboru:
   * 1. Najprv vyhľadá samostatný element (span/div/p), ktorý obsahuje IBA reálnu veľkosť
   *    (takto to robí moderné Gofile: <p class="..."><span ...>čas</span><span>2.2 GB</span></p>).
   * 2. Ako fallback extrahuje text s medzerami medzi uzlami, aby sa čas nezlúčil s veľkosťou.
   * 3. Úplne eliminuje predošlý chybný heuristický hack (> 50 GB => MB).
   */
  function parseAndNormalizeSize(itemEl) {
    if (!itemEl) return '';

    // 1. Primárna metóda: Samostatný element obsahujúci len veľkosť
    const candidateEls = itemEl.querySelectorAll('span, div, p, b, strong');
    for (const el of candidateEls) {
      if (el.children.length > 1) continue;
      const txt = el.textContent.trim();
      const m = txt.match(STANDALONE_SIZE_REGEX);
      if (m) {
        const num = parseFloat(m[1].replace(',', '.'));
        if (!isNaN(num) && num > 0) {
          return formatNormalizedSize(num, m[2]);
        }
      }
    }

    // 2. Sekundárna metóda: Text s medzerami medzi elementmi
    const spacedText = getElementTextWithSpaces(itemEl);
    const matches = Array.from(spacedText.matchAll(SPACED_SIZE_REGEX));

    if (matches.length > 0) {
      // Veľkosť súboru v riadku je spravidla posledný výskyt po dátume a čase
      const bestMatch = matches[matches.length - 1];
      const numStr = bestMatch[1].replace(',', '.');
      const num = parseFloat(numStr);
      const unit = bestMatch[2];

      if (!isNaN(num) && num > 0) {
        return formatNormalizedSize(num, unit);
      }
    }

    return '';
  }

  function parseCardInfo(itemEl) {
    if (!itemEl) return null;

    // Checkbox alebo výberové tlačidlo (moderné Gofile používa button[data-action="toggle-select"])
    const checkbox = itemEl.querySelector('input[type="checkbox"], [role="checkbox"], .form-checkbox');
    const toggleSelectBtn = itemEl.querySelector('button[data-action="toggle-select"]');

    // Názov súboru
    let title = '';
    const titleCandidates = itemEl.querySelectorAll('span.truncate, .truncate, a[href*="/d/"], a[href*="/c/"], .font-medium');
    for (const el of titleCandidates) {
      let t = el.textContent.trim();
      if (t && t.length < 500) {
        title = t;
        break;
      }
    }
    if (!title) title = itemEl.textContent || '';
    
    // Extrahujeme iba po príponu, aby sme odrezali nabalený Gofile text (Preview, Download, Dátumy atď.)
    const cleanExtMatch = title.match(/^([\s\S]*?\.(mp4|mkv|avi|mov|webm|flv|ts|jpg|jpeg|png|gif|zip|rar|7z|pdf|txt))/i);
    if (cleanExtMatch) {
      title = cleanExtMatch[1].trim();
    } else {
      title = title.split(/[\n\t]/)[0].trim(); // Pre priečinky berieme len prvý riadok textu
    }

    // Presná a normalizovaná veľkosť súboru
    const sizeStr = parseAndNormalizeSize(itemEl);

    // Dátum pridania (s medzerami aby sa nezlepil s inými textami)
    const textContent = getElementTextWithSpaces(itemEl);
    const dateMatch = textContent.match(/(\d{1,2}\.\s*\d{1,2}\.\s*\d{4}(?:,\s*\d{1,2}:\d{2})?)/);
    const dateStr = dateMatch ? dateMatch[1] : '';

    // Thumbnail
    const imgEl = itemEl.querySelector('img[src], video');
    const thumbSrc = imgEl ? (imgEl.src || imgEl.getAttribute('src')) : '';

    // Pôvodné tlačidlá Preview a Download
    let previewBtn = null;
    let downloadBtn = null;
    const buttons = itemEl.querySelectorAll('button, a');
    for (const btn of buttons) {
      if (btn.closest('.gfg-card-content')) continue; // ignorovať naše vlastné tlačidlá
      const txt = (btn.textContent || '').toLowerCase();
      const href = (btn.getAttribute('href') || '').toLowerCase();
      const action = (btn.getAttribute('data-action') || '').toLowerCase();

      if (action === 'preview' || txt.includes('preview') || href.includes('preview') || btn.querySelector('svg[data-icon="eye"]')) {
        previewBtn = btn;
      }
      if (action === 'download' || txt.includes('download') || href.includes('download') || btn.querySelector('svg[data-icon="download"]')) {
        downloadBtn = btn;
      }
    }

    // Typ prípony
    let ext = 'SÚBOR';
    const extMatch = title.match(/\.([a-zA-Z0-9]+)$/);
    if (extMatch) {
      ext = extMatch[1].toUpperCase();
    } else if (thumbSrc) {
      ext = 'VIDEO';
    }

    return {
      element: itemEl,
      checkbox,
      toggleSelectBtn,
      title: title || 'Súbor',
      sizeStr,
      dateStr,
      thumbSrc,
      imgEl,
      previewBtn,
      downloadBtn,
      ext
    };
  }

  // ────────────────────────────────────────────────────────────
  // 4. Sidecar Player & Playlist Logic
  // ────────────────────────────────────────────────────────────

  let sidecarObserver = null;
  let currentInterceptedModal = null;
  let sidecarVideoItems = [];
  let sidecarCurrentIndex = 0;

  // Zoom/drag stav
  let gfgZoom = 1;
  let gfgDragX = 0;
  let gfgDragY = 0;
  let gfgDragging = false;
  let gfgDragStartX = 0;
  let gfgDragStartY = 0;
  let gfgClipMode = true; // false = video môže ísť von, true = orezané v rámci kontajnera
  let gfgFitMode = false; // true = object-fit: cover

  function initSidecarUI() {
    if (document.getElementById('gfg-sidecar')) return;

    // Toggle Tlačidlo pre ľavý panel
    const toggleBtn = document.createElement('div');
    toggleBtn.id = 'gfg-menu-toggle';
    toggleBtn.title = 'Zobraziť/Skryť ľavý panel Gofile';
    toggleBtn.innerHTML = `
      <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
      </svg>
    `;
    toggleBtn.onclick = () => {
      document.body.classList.toggle('gfg-sidecar-active');
    };
    document.body.appendChild(toggleBtn);
    document.body.classList.add('gfg-sidecar-active');

    // Sidecar Panel
    const sidecar = document.createElement('div');
    sidecar.id = 'gfg-sidecar';
    sidecar.innerHTML = `
      <div id="gfg-sidecar-header">
        <h3 id="gfg-player-title">Prehrávač</h3>
        <div style="display:flex;align-items:center;gap:6px;">
          <div id="gfg-sidecar-expand" title="Rozbaliť na celú výšku (Vertical Fullscreen)" class="gfg-sidecar-close">
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
            </svg>
          </div>
          <div class="gfg-sidecar-close" title="Zavrieť prehrávač">
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24">
               <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </div>
        </div>
      </div>
      <div id="gfg-sidecar-player-container">
        <div id="gfg-player-placeholder" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#475569;gap:10px;font-size:13px;">
          <svg width="40" height="40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
          <span>Klikni na video pre spustenie</span>
        </div>
      </div>
      <div id="gfg-sidecar-zoom-bar">
        <span class="gfg-zoom-btn" id="gfg-zoom-fit" title="Vyplniť rámec (Cover/Contain)">⛶ Fit</span>
        <div style="width:1px; height:14px; background:var(--gfg-border); margin:0 4px;"></div>
        <span class="gfg-zoom-btn" id="gfg-zoom-out" title="Oddialiť">−</span>
        <span id="gfg-zoom-label">100%</span>
        <span class="gfg-zoom-btn" id="gfg-zoom-in" title="Priblížiť">+</span>
        <span class="gfg-zoom-btn" id="gfg-zoom-reset" title="Resetovať">↺</span>
        <span class="gfg-zoom-btn" id="gfg-zoom-clip" title="Clip Mode – video zostane v rámci priestoru" style="background: rgba(99, 102, 241, 0.3); color: rgb(165, 180, 252); border-color: var(--gfg-accent);">✂ Clip</span>
        <span id="gfg-playlist-header">▼ Playlist (<span id="gfg-playlist-count">0</span>)</span>
      </div>
      <div id="gfg-sidecar-playlist"></div>
    `;
    document.body.appendChild(sidecar);

    // Expand / Fullscreen (vertical)
    document.getElementById('gfg-sidecar-expand').onclick = () => {
      sidecar.classList.toggle('gfg-sidecar-expanded');
      document.body.classList.toggle('gfg-sidecar-fullheight');
    };

    // Zatvoriť
    sidecar.querySelector('.gfg-sidecar-close').onclick = () => closeSidecar();

    // Zoom tlačidlá
    document.getElementById('gfg-zoom-in').onclick = () => applyZoom(gfgZoom + 0.25);
    document.getElementById('gfg-zoom-out').onclick = () => applyZoom(gfgZoom - 0.25);
    document.getElementById('gfg-zoom-reset').onclick = () => { gfgDragX = 0; gfgDragY = 0; applyZoom(1); };

    // Fit Mode prepínač
    document.getElementById('gfg-zoom-fit').onclick = () => {
      gfgFitMode = !gfgFitMode;
      const btn = document.getElementById('gfg-zoom-fit');
      const vid = document.querySelector('#gfg-sidecar-player-container video');
      
      if (gfgFitMode) {
        btn.style.background = 'rgba(16,185,129,0.3)';
        btn.style.color = '#6ee7b7';
        btn.style.borderColor = '#10b981';
        if (vid) vid.style.setProperty('object-fit', 'cover', 'important');
      } else {
        btn.style.background = '';
        btn.style.color = '';
        btn.style.borderColor = '';
        if (vid) vid.style.setProperty('object-fit', 'contain', 'important');
      }
      
      // Pri fitnutí zresetujeme manuálny zoom a posun
      gfgDragX = 0; gfgDragY = 0; applyZoom(1);
    };

    // Clip Mode prepínač
    document.getElementById('gfg-zoom-clip').onclick = () => {
      gfgClipMode = !gfgClipMode;
      const btn = document.getElementById('gfg-zoom-clip');
      const pc = document.getElementById('gfg-sidecar-player-container');
      if (gfgClipMode) {
        btn.textContent = '✂ Clip';
        btn.style.background = 'rgba(99,102,241,0.3)';
        btn.style.color = '#a5b4fc';
        btn.style.borderColor = 'var(--gfg-accent)';
        if (pc) pc.style.setProperty('overflow', 'hidden', 'important');
      } else {
        btn.textContent = '✂ Voľné';
        btn.style.background = '';
        btn.style.color = '';
        btn.style.borderColor = '';
        if (pc) pc.style.setProperty('overflow', 'visible', 'important');
      }
    };

    // Koliesko myši na zoom
    const playerContainer = document.getElementById('gfg-sidecar-player-container');
    playerContainer.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      applyZoom(gfgZoom + delta);
    }, { passive: false });

    // Drag na video
    playerContainer.addEventListener('mousedown', (e) => {
      if (gfgZoom <= 1) return;
      if (e.target.tagName === 'VIDEO' || e.target === playerContainer) {
        gfgDragging = true;
        gfgDragStartX = e.clientX - gfgDragX;
        gfgDragStartY = e.clientY - gfgDragY;
        playerContainer.style.cursor = 'grabbing';
        e.preventDefault();
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (!gfgDragging) return;
      gfgDragX = e.clientX - gfgDragStartX;
      gfgDragY = e.clientY - gfgDragStartY;
      updateVideoTransform();
    });
    document.addEventListener('mouseup', () => {
      gfgDragging = false;
      if (playerContainer) playerContainer.style.cursor = gfgZoom > 1 ? 'grab' : 'default';
    });

    // Dvojklik = native fullscreen
    playerContainer.addEventListener('dblclick', () => {
      const vid = playerContainer.querySelector('video');
      if (vid) {
        if (document.fullscreenElement) document.exitFullscreen();
        else vid.requestFullscreen().catch(() => {});
      }
    });
  }

  function applyZoom(newZoom) {
    gfgZoom = Math.max(0.5, Math.min(5, newZoom));
    const label = document.getElementById('gfg-zoom-label');
    if (label) label.textContent = Math.round(gfgZoom * 100) + '%';
    const playerContainer = document.getElementById('gfg-sidecar-player-container');
    if (playerContainer) {
      playerContainer.style.cursor = gfgZoom > 1 ? 'grab' : 'default';
      // overflow: visible len keď je Free mode, inak vždy hidden
      const overflowVal = (!gfgClipMode && gfgZoom > 1) ? 'visible' : 'hidden';
      playerContainer.style.setProperty('overflow', overflowVal, 'important');
    }
    if (gfgZoom <= 1) { gfgDragX = 0; gfgDragY = 0; }
    updateVideoTransform();
  }

  function updateVideoTransform() {
    const playerContainer = document.getElementById('gfg-sidecar-player-container');
    if (!playerContainer) return;
    const vid = playerContainer.querySelector('video');
    if (vid) {
      vid.style.transform = `scale(${gfgZoom}) translate(${gfgDragX / gfgZoom}px, ${gfgDragY / gfgZoom}px)`;
      vid.style.transformOrigin = 'center center';
    }
  }

  function closeSidecar() {
    document.body.classList.remove('gfg-sidecar-open', 'gfg-sidecar-fullheight');
    const sidecar = document.getElementById('gfg-sidecar');
    if (sidecar) sidecar.classList.remove('gfg-sidecar-expanded');
    const playerContainer = document.getElementById('gfg-sidecar-player-container');
    if (playerContainer) {
      const vid = playerContainer.querySelector('video');
      if (vid) vid.pause();
    }
    if (currentInterceptedModal) {
      try {
        const closeBtn = currentInterceptedModal.querySelector('button[aria-label="Close"], .close, [data-dismiss="modal"]');
        if (closeBtn) closeBtn.click();
        else if (currentInterceptedModal.parentElement) currentInterceptedModal.remove();
      } catch (e) {}
      currentInterceptedModal = null;
    }
    gfgZoom = 1; gfgDragX = 0; gfgDragY = 0;
    const label = document.getElementById('gfg-zoom-label');
    if (label) label.textContent = '100%';
  }

  function buildPlaylist(startIndex) {
    const playlistContainer = document.getElementById('gfg-sidecar-playlist');
    const countEl = document.getElementById('gfg-playlist-count');
    if (!playlistContainer) return;
    playlistContainer.innerHTML = '';

    const videoItems = sidecarVideoItems;
    if (countEl) countEl.textContent = videoItems.length;
    if (videoItems.length === 0) return;

    videoItems.forEach((item, idx) => {
      const info = parseCardInfo(item);
      if (!info) return;
      const el = document.createElement('div');
      el.className = 'gfg-playlist-item' + (idx === startIndex ? ' playing' : '');
      el.innerHTML = `
        <img class="gfg-playlist-thumb" src="${info.thumbSrc || ''}" onerror="this.style.display='none'">
        <div class="gfg-playlist-info">
          <div class="gfg-playlist-title" title="${info.title}">${info.title}</div>
          <div class="gfg-playlist-meta">${info.sizeStr || ''} ${info.dateStr ? '• ' + info.dateStr : ''}</div>
        </div>
      `;
      el.onclick = () => playVideoInSidecar(sidecarVideoItems, idx);
      playlistContainer.appendChild(el);
    });

    const activeEl = playlistContainer.querySelector('.playing');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function playVideoInSidecar(videoItems, index) {
    if (index < 0 || index >= videoItems.length) return;

    sidecarVideoItems = videoItems;
    sidecarCurrentIndex = index;

    const itemEl = videoItems[index];
    const info = parseCardInfo(itemEl);
    if (!info) return;

    document.body.classList.add('gfg-sidecar-open');
    buildPlaylist(index);

    const titleEl = document.getElementById('gfg-player-title');
    if (titleEl) titleEl.textContent = info.title || 'Prehrávač';

    // Zavri predošlý modal
    if (currentInterceptedModal) {
      try {
        const closeBtn = currentInterceptedModal.querySelector('button[aria-label="Close"], .close, [data-dismiss="modal"]');
        if (closeBtn) closeBtn.click();
        else if (currentInterceptedModal.parentElement) currentInterceptedModal.remove();
      } catch (e) {}
      currentInterceptedModal = null;
    }

    const playerContainer = document.getElementById('gfg-sidecar-player-container');
    playerContainer.innerHTML = `<div style="color:#94a3b8;font-size:13px;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);text-align:center">
      <svg width="32" height="32" fill="none" stroke="#6366f1" viewBox="0 0 24 24" style="display:block;margin:0 auto 8px;animation:gfg-spin 1s linear infinite">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 12a8 8 0 018-8v4"/>
      </svg>
      Načítavam stream...
    </div>`;

    // Reset zoom
    gfgZoom = 1; gfgDragX = 0; gfgDragY = 0;
    const zLabel = document.getElementById('gfg-zoom-label');
    if (zLabel) zLabel.textContent = '100%';

    if (sidecarObserver) sidecarObserver.disconnect();

    let interceptAttempts = 0;
    sidecarObserver = new MutationObserver(() => {
      // Hľadáme AKÝKOĽVEK video element kdekoľvek v dokumente okrem nášho
      const allVideos = Array.from(document.querySelectorAll('video'));
      for (const vid of allVideos) {
        if (vid.closest('#gfg-sidecar')) continue;
        const src = vid.src || vid.currentSrc || '';
        const hasSrc = src.length > 5 || vid.readyState > 0 || vid.duration > 0;
        if (hasSrc) {
          sidecarObserver.disconnect();

          // Nájdeme a skryjeme obaľujúci modal
          const modal = vid.closest('[role="dialog"], [class*="modal"], [class*="player-modal"], [class*="viewer"]') || vid.parentElement?.parentElement;
          currentInterceptedModal = modal;
          if (modal && modal !== document.body && modal !== document.documentElement) {
            modal.style.setProperty('opacity', '0', 'important');
            modal.style.setProperty('pointer-events', 'none', 'important');
            modal.style.setProperty('position', 'fixed', 'important');
            modal.style.setProperty('top', '-9999px', 'important');
            modal.style.setProperty('left', '-9999px', 'important');
          }

          // Presun videa do Sidecaru
          playerContainer.innerHTML = '';
          playerContainer.appendChild(vid);
          vid.style.cssText = 'width:100% !important;height:100% !important;object-fit:' + (gfgFitMode ? 'cover' : 'contain') + ' !important;display:block !important;transform-origin:center center !important;position:relative !important;z-index:1 !important;';
          vid.setAttribute('controls', '');
          vid.play().catch(() => {});

          vid.onended = () => {
            setTimeout(() => playVideoInSidecar(sidecarVideoItems, sidecarCurrentIndex + 1), 800);
          };
          return;
        }
      }

      interceptAttempts++;
      if (interceptAttempts > 100) {
        sidecarObserver.disconnect();
        playerContainer.innerHTML = `<div style="color:#f87171;font-size:12px;padding:20px;text-align:center">
          <div style="margin-bottom:8px">Nepodarilo sa zachytiť stream.</div>
          <small style="color:#64748b">Natívny prehrávač Gofile pravdepodobne použil iný mechanizmus.<br>Skúste dvojklik priamo na náhľad videa.</small>
        </div>`;
      }
    });

    sidecarObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'currentSrc'] });

    // Klikneme na preview button s malým oneskorením
    setTimeout(() => {
      let clickTarget = info.previewBtn;
      if (!clickTarget) {
        const buttons = itemEl.querySelectorAll('button, a, [role="button"]');
        for (const b of buttons) {
          if (b.closest('.gfg-card-content')) continue;
          const txt = (b.textContent || '').toLowerCase();
          const action = (b.getAttribute('data-action') || '').toLowerCase();
          const href = (b.getAttribute('href') || '').toLowerCase();
          if (action === 'preview' || txt.includes('preview') || href.includes('preview') || b.querySelector('svg[data-icon="eye"]')) {
            clickTarget = b;
            break;
          }
        }
      }
      if (clickTarget) {
        clickTarget.click();
      } else {
        const origChild = Array.from(itemEl.children).find(c => !c.classList.contains('gfg-card-content'));
        if (origChild) origChild.click();
        else itemEl.click();
      }
    }, 60);
  }

  function triggerNativePreview(itemEl, info) {
    const VIDEO_EXTS = ['MP4','MKV','AVI','WEBM','MOV','TS','FLV'];
    if (info.ext === 'VIDEO' || VIDEO_EXTS.includes(info.ext)) {
      const videoItems = state.activeItems.filter(el => {
        const inf = parseCardInfo(el);
        return inf && (inf.ext === 'VIDEO' || VIDEO_EXTS.includes(inf.ext));
      });
      const currentIndex = videoItems.indexOf(itemEl);
      sidecarVideoItems = videoItems;
      playVideoInSidecar(videoItems, currentIndex !== -1 ? currentIndex : 0);
    } else {
      if (info.previewBtn) info.previewBtn.click();
    }
  }


  // ────────────────────────────────────────────────────────────
  // 5. Transformácia jednotlivého riadku na kartu
  // ────────────────────────────────────────────────────────────


  function enhanceCard(itemEl, index) {
    if (itemEl.classList.contains('gfg-card-processed')) return;

    const info = parseCardInfo(itemEl);
    if (!info) return;

    itemEl.classList.add('gfg-card-processed');
    itemEl.setAttribute('data-gfg-index', index);

    // Vytvorenie štruktúrovaného Card Wrapperu
    const cardWrapper = document.createElement('div');
    cardWrapper.className = 'gfg-card-content';
    cardWrapper.style.cssText = 'display: flex; flex-direction: column; height: 100%; width: 100%; font-size: 14px; color: var(--gfg-text);';

    // 1. Horná thumbnail sekcia
    const thumbBox = document.createElement('div');
    thumbBox.className = 'gfg-thumb-container';

    // Plávajúce prvky hore vľavo
    const floatLeft = document.createElement('div');
    floatLeft.className = 'gfg-floating-top-left';

    if (info.checkbox && info.checkbox.tagName === 'INPUT') {
      info.checkbox.classList.add('gfg-card-checkbox');
      info.checkbox.addEventListener('change', () => {
        itemEl.classList.toggle('gfg-selected', info.checkbox.checked);
        updateBatchCount();
      });
      floatLeft.appendChild(info.checkbox);
    } else {
      const cardCheckbox = document.createElement('input');
      cardCheckbox.type = 'checkbox';
      cardCheckbox.className = 'gfg-card-checkbox';
      const isSelected = itemEl.getAttribute('data-selected') === 'true' || 
                         info.toggleSelectBtn?.getAttribute('aria-pressed') === 'true';
      cardCheckbox.checked = isSelected;
      if (isSelected) itemEl.classList.add('gfg-selected');

      cardCheckbox.addEventListener('change', (e) => {
        e.stopPropagation();
        itemEl.classList.toggle('gfg-selected', cardCheckbox.checked);
        if (info.toggleSelectBtn) {
          info.toggleSelectBtn.click();
        }
        updateBatchCount();
      });
      floatLeft.appendChild(cardCheckbox);
    }

    const extBadge = document.createElement('span');
    extBadge.className = 'gfg-badge-pill';
    extBadge.textContent = info.ext;
    floatLeft.appendChild(extBadge);

    // Plávajúce prvky hore vpravo (Správna a normalizovaná veľkosť)
    const floatRight = document.createElement('div');
    floatRight.className = 'gfg-floating-top-right';
    if (info.sizeStr) {
      const sizeBadge = document.createElement('span');
      sizeBadge.className = 'gfg-badge-pill';
      sizeBadge.style.color = '#38bdf8';
      sizeBadge.textContent = info.sizeStr;
      floatRight.appendChild(sizeBadge);
    }

    thumbBox.appendChild(floatLeft);
    thumbBox.appendChild(floatRight);

    // Obrázok náhľadu
    if (info.thumbSrc) {
      const img = document.createElement('img');
      img.src = info.thumbSrc;
      img.alt = '';
      img.loading = 'lazy';
      img.style.color = 'transparent';
      img.onerror = () => {
        img.style.display = 'none';
      };
      thumbBox.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.style.cssText = 'display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; height: 100%; background: #0f172a; color: #64748b; font-size: 13px; gap: 8px;';
      placeholder.innerHTML = `
        <svg width="38" height="38" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
        </svg>
        <span>Video / Médium</span>
      `;
      thumbBox.appendChild(placeholder);
    }

    // Prekrývací gradient
    const overlay = document.createElement('div');
    overlay.className = 'gfg-thumb-overlay';
    thumbBox.appendChild(overlay);

    // Veľké tlačidlo Prehrať (Play)
    const playBtn = document.createElement('div');
    playBtn.className = 'gfg-play-btn';
    playBtn.title = 'Prehrať video';
    playBtn.innerHTML = `
      <svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24">
        <path d="M8 5v14l11-7z"/>
      </svg>
    `;
    thumbBox.appendChild(playBtn);

    // Kliknutie na thumbnail / Play -> okamžite spustí video prehrávač
    thumbBox.addEventListener('click', (e) => {
      if (e.target === info.checkbox || e.target.closest('.gfg-card-checkbox')) return;
      e.preventDefault();
      e.stopPropagation();
      triggerNativePreview(itemEl, info);
    });

    cardWrapper.appendChild(thumbBox);

    // 2. Telo karty (Názov a informácie)
    const body = document.createElement('div');
    body.className = 'gfg-card-body';

    const titleEl = document.createElement('div');
    titleEl.className = 'gfg-card-title';
    titleEl.textContent = info.title;
    titleEl.title = `${info.title} (Kliknite pre prehratie)`;
    titleEl.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerNativePreview(itemEl, info);
    };
    body.appendChild(titleEl);

    const meta = document.createElement('div');
    meta.className = 'gfg-card-meta';
    meta.innerHTML = `
      <span>📅 ${info.dateStr || 'Nedávno'}</span>
      <span>${info.sizeStr ? '💾 ' + info.sizeStr : ''}</span>
    `;
    body.appendChild(meta);

    // 3. Akčné tlačidlá na spodku karty
    const actions = document.createElement('div');
    actions.className = 'gfg-card-actions';

    // Tlačidlo Náhľad / Prehrať
    const pBtn = document.createElement('button');
    pBtn.className = 'gfg-action-btn';
    pBtn.innerHTML = `
      <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
      <span>Prehrať</span>
    `;
    pBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerNativePreview(itemEl, info);
    });
    actions.appendChild(pBtn);

    // Tlačidlo Download
    const dBtn = document.createElement('button');
    dBtn.className = 'gfg-action-btn btn-download';
    dBtn.innerHTML = `
      <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
      </svg>
      <span>Stiahnuť</span>
    `;
    dBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (info.downloadBtn) {
        info.downloadBtn.click();
      } else {
        const link = itemEl.querySelector('a[href*="download"], a[download]');
        if (link) link.click();
      }
    });
    actions.appendChild(dBtn);

    // Tlačidlo Kopírovať odkaz
    const copyBtn = document.createElement('button');
    copyBtn.className = 'gfg-action-btn gfg-action-icon-only';
    copyBtn.title = 'Kopírovať odkaz na súbor';
    copyBtn.innerHTML = `
      <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>
      </svg>
    `;
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const directLink = info.downloadBtn?.href || info.previewBtn?.href || window.location.href;
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(directLink);
      } else {
        navigator.clipboard.writeText(directLink);
      }
      showToast('Odkaz skopírovaný do schránky!');
    });
    actions.appendChild(copyBtn);

    body.appendChild(actions);
    cardWrapper.appendChild(body);

    // Pôvodné deti ponecháme v DOMe skryté, aby nestratili originálne listenery Gofile
    const originalChildren = Array.from(itemEl.children);
    for (const child of originalChildren) {
      if (child !== cardWrapper) {
        child.style.display = 'none';
      }
    }
    itemEl.appendChild(cardWrapper);
  }

  // ────────────────────────────────────────────────────────────
  // 6. Vyhľadanie kontajnera zoznamu (LCA Heuristika)
  // ────────────────────────────────────────────────────────────

  function findFolderContainer() {
    // 0. Moderné Gofile rozhranie: priamy rodič riadkov .fm-row
    // Dôležité: Vyhneme sa `.fm-row` v bočnom paneli (aside, nav)
    const rows = document.querySelectorAll('.fm-row');
    for (const row of rows) {
      if (!row.closest('aside, nav, #sidebar, .sidebar, [data-layout-menu]')) {
        if (row.parentElement) {
          return row.parentElement;
        }
      }
    }

    // 1. Zozbierame všetky tlačidlá/odkazy pre Download alebo Preview
    const allButtons = Array.from(document.querySelectorAll('button, a'));
    const downloadBtns = allButtons.filter(b => {
      const txt = (b.textContent || '').toLowerCase();
      const href = (b.getAttribute('href') || '').toLowerCase();
      return (txt.includes('download') || href.includes('download') || b.querySelector('svg[data-icon="download"]')) &&
             !b.closest('#gfg-toolbar');
    });

    if (downloadBtns.length >= 2) {
      let candidate = downloadBtns[0].parentElement;
      while (candidate && candidate !== document.body) {
        const containedCount = downloadBtns.filter(btn => candidate.contains(btn)).length;
        if (containedCount >= Math.min(downloadBtns.length, 3)) {
          const childRows = Array.from(candidate.children).filter(child => 
            downloadBtns.some(btn => child.contains(btn))
          );
          if (childRows.length >= 2) {
            return candidate;
          }
        }
        candidate = candidate.parentElement;
      }
    }

    // 2. Kontajner podľa potomkov s náhľadmi
    // Na stránke s JEDNÝM súborom (napr. /d/<id> pre samostatné video) má
    // stránka len 2-3 top-level regióny (sidebar, header, hlavný obsah) —
    // sidebar má gofile logo <img> a hlavný obsah má Preview/Download, čo
    // ľahko splní "matching >= 2 z 3" aj keď to nie je zoznam súborov vôbec.
    // Výsledok: skript vzal celý stránkový wrapper (min-h-dvh flex) ako
    // "kontajner súborov" a spravil z jeho 3 nesúvisiacich regiónov 3 falošné
    // karty. Skutočný zoznam súborov má VIACERO štruktúrne rovnakých riadkov
    // (rovnaký tag + trieda) — vyžaduj aspoň 3 zhodné potomky, aby si mal
    // istotu, že ide o opakovanú šablónu riadku, nie náhodné sekcie stránky.
    const candidates = Array.from(document.querySelectorAll('div, section, main'));
    for (const el of candidates) {
      if (el.id?.startsWith('gfg-') || el.closest('#gfg-toolbar')) continue;
      const children = Array.from(el.children);
      if (children.length >= 3) {
        const matching = children.filter(c => {
          const txt = c.textContent || '';
          return (txt.includes('Preview') && txt.includes('Download')) ||
                 c.querySelector('img[src], video');
        });
        // Real file rows repeat the same tag+class template; a page's
        // top-level layout regions (sidebar/header/content) never do.
        const sameShape = matching.length >= 2 && matching.every(c =>
          c.tagName === matching[0].tagName && c.className === matching[0].className
        );
        if (matching.length >= 3 && matching.length >= children.length * 0.4 && sameShape) {
          return el;
        }
      }
    }

    return document.querySelector('#files-container, .files-container, #file-list, [data-files-container]');
  }

  function applyGridLayout() {
    const container = findFolderContainer();
    if (!container) return;

    state.folderContainer = container;

    if (state.viewMode === 'grid') {
      container.classList.add('gfg-grid-container');
      container.classList.remove('gfg-cols-2', 'gfg-cols-3', 'gfg-cols-4', 'gfg-cols-auto');
      container.classList.add(`gfg-cols-${state.columns}`);
    } else {
      container.classList.remove('gfg-grid-container', 'gfg-cols-2', 'gfg-cols-3', 'gfg-cols-4', 'gfg-cols-auto');
    }

    const items = Array.from(container.children).filter(el => !el.id.startsWith('gfg-'));
    state.activeItems = items;

    items.forEach((itemEl, idx) => {
      enhanceCard(itemEl, idx);

      const cardWrapper = itemEl.querySelector('.gfg-card-content');
      if (cardWrapper) {
        if (state.viewMode === 'grid') {
          cardWrapper.style.display = 'flex';
          Array.from(itemEl.children).forEach(c => {
            if (c !== cardWrapper) c.style.display = 'none';
          });
        } else {
          cardWrapper.style.display = 'none';
          Array.from(itemEl.children).forEach(c => {
            if (c !== cardWrapper) c.style.display = '';
          });
        }
      }
    });

    renderToolbar(container);

    if (state.filterText) {
      filterItems(state.filterText);
    }
  }

  // ────────────────────────────────────────────────────────────
  // 7. Ovládací Toolbar (UI)
  // ────────────────────────────────────────────────────────────

  function renderToolbar(container) {
    let toolbar = document.getElementById('gfg-toolbar');
    if (!toolbar) {
      toolbar = document.createElement('div');
      toolbar.id = 'gfg-toolbar';
      container.parentNode.insertBefore(toolbar, container);
    }

    const totalCount = state.activeItems.length;
    const extractorGroup = toolbar.querySelector('[data-gfg-extractor]');

    toolbar.innerHTML = `
      <div class="gfg-toolbar-group">
        <!-- Režim zobrazenia -->
        <button id="gfg-btn-grid" class="gfg-btn ${state.viewMode === 'grid' ? 'active' : ''}" title="Prepnúť na Grid rozloženie">
          <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/>
          </svg>
          <span>Mriežka</span>
        </button>

        <button id="gfg-btn-list" class="gfg-btn ${state.viewMode === 'list' ? 'active' : ''}" title="Prepnúť na pôvodný zoznam">
          <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
          </svg>
          <span>Zoznam</span>
        </button>

        <!-- Prepínač počtu stĺpcov -->
        <div id="gfg-cols-group" class="gfg-toolbar-group" style="margin-left: 6px; ${state.viewMode === 'list' ? 'display: none;' : ''}">
          <span style="font-size: 12px; color: var(--gfg-text-muted);">Stĺpce:</span>
          <button class="gfg-btn ${state.columns === 2 ? 'active' : ''}" data-cols="2" style="padding: 5px 9px;">2</button>
          <button class="gfg-btn ${state.columns === 3 ? 'active' : ''}" data-cols="3" style="padding: 5px 9px;">3 (3x2)</button>
          <button class="gfg-btn ${state.columns === 4 ? 'active' : ''}" data-cols="4" style="padding: 5px 9px;">4</button>
          <button class="gfg-btn ${state.columns === 'auto' ? 'active' : ''}" data-cols="auto" style="padding: 5px 9px;">Auto</button>
        </div>
      </div>

      <div class="gfg-toolbar-group">
        <!-- Okamžité vyhľadávanie -->
        <div class="gfg-search-box">
          <svg class="gfg-search-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
          </svg>
          <input type="text" id="gfg-search-input" class="gfg-input" placeholder="Hľadať súbor..." value="${state.filterText}">
        </div>

        <!-- Zoradenie -->
        <select id="gfg-sort-select" class="gfg-select" title="Zoradiť súbory">
          <option value="original" ${state.sortMode === 'original' ? 'selected' : ''}>Pôvodné poradie</option>
          <option value="name-asc" ${state.sortMode === 'name-asc' ? 'selected' : ''}>Názov (A → Z)</option>
          <option value="name-desc" ${state.sortMode === 'name-desc' ? 'selected' : ''}>Názov (Z → A)</option>
          <option value="size-desc" ${state.sortMode === 'size-desc' ? 'selected' : ''}>Veľkosť (Najväčšie)</option>
          <option value="size-asc" ${state.sortMode === 'size-asc' ? 'selected' : ''}>Veľkosť (Najmenšie)</option>
          <option value="date-desc" ${state.sortMode === 'date-desc' ? 'selected' : ''}>Dátum (Najnovšie)</option>
          <option value="date-asc" ${state.sortMode === 'date-asc' ? 'selected' : ''}>Dátum (Najstaršie)</option>
          <option value="duration-desc" ${state.sortMode === 'duration-desc' ? 'selected' : ''}>Trvanie (Najdlhšie)</option>
          <option value="duration-asc" ${state.sortMode === 'duration-asc' ? 'selected' : ''}>Trvanie (Najkratšie)</option>
        </select>

        <!-- Hromadné akcie -->
        <button id="gfg-btn-play-all" class="gfg-btn gfg-btn-secondary" title="Prehrať všetky videá v Sidecar (Playlist)" style="background: rgba(16, 185, 129, 0.15); border-color: rgba(16, 185, 129, 0.35); color: #6ee7b7;">
          ▶ Prehrať
        </button>

        <button id="gfg-btn-select-all" class="gfg-btn gfg-btn-secondary" title="Označiť / Odznačiť všetky">
          <span id="gfg-select-all-text">✓ Všetko</span>
        </button>

        <div class="gfg-import-settings" title="Batch sa zobrazí v Dashboarde. Source Board uloží tento GoFile priečinok so zhodným batchom.">
          <span class="gfg-import-settings-label">Batch</span>
          <input id="gfg-batch-name" class="gfg-input" type="text" maxlength="140" value="${escapeHtml(getPref('dashboardBatchName', '') || defaultDashboardBatchName())}" aria-label="Názov batchu pre Nexus Dashboard">
          <label class="gfg-source-board-toggle">
            <input id="gfg-source-board-toggle" type="checkbox" ${getPref('includeSourceBoard', false) ? 'checked' : ''}>
            <span>+ Source Board</span>
          </label>
        </div>

        <button id="gfg-btn-import-dashboard" class="gfg-btn gfg-btn-import" title="Importovať označené súbory do Nexus Dashboardu" disabled>
          <span>⇩</span> <span id="gfg-import-count">Importovať (0)</span>
        </button>

        <button id="gfg-btn-copy-links" class="gfg-btn gfg-btn-secondary" title="Kopírovať priame odkazy označených súborov">
          📋 <span id="gfg-copy-count">Linky</span>
        </button>

        <span class="gfg-badge gfg-badge-accent" id="gfg-item-count-badge">${totalCount} položiek</span>
      </div>
    `;

    document.getElementById('gfg-btn-grid').onclick = () => {
      state.viewMode = 'grid';
      setPref('viewMode', 'grid');
      applyGridLayout();
    };

    document.getElementById('gfg-btn-list').onclick = () => {
      state.viewMode = 'list';
      setPref('viewMode', 'list');
      applyGridLayout();
    };

    const colBtns = toolbar.querySelectorAll('[data-cols]');
    colBtns.forEach(b => {
      b.onclick = () => {
        const val = b.getAttribute('data-cols');
        state.columns = val === 'auto' ? 'auto' : parseInt(val, 10);
        setPref('columns', state.columns);
        applyGridLayout();
      };
    });

    const searchInput = document.getElementById('gfg-search-input');
    searchInput.oninput = (e) => {
      state.filterText = e.target.value.trim().toLowerCase();
      filterItems(state.filterText);
    };

    const sortSelect = document.getElementById('gfg-sort-select');
    sortSelect.onchange = (e) => {
      state.sortMode = e.target.value;
      sortItems(state.sortMode);
    };

    const batchNameInput = document.getElementById('gfg-batch-name');
    if (batchNameInput) {
      batchNameInput.onchange = (event) => {
        setPref('dashboardBatchName', event.target.value.trim());
      };
    }
    const sourceBoardToggle = document.getElementById('gfg-source-board-toggle');
    if (sourceBoardToggle) {
      sourceBoardToggle.onchange = (event) => {
        setPref('includeSourceBoard', event.target.checked);
      };
    }

    document.getElementById('gfg-btn-select-all').onclick = () => {
      toggleSelectAll();
    };

    const playAllBtn = document.getElementById('gfg-btn-play-all');
    if (playAllBtn) {
      playAllBtn.onclick = () => {
        const videoItems = state.activeItems.filter(el => {
          const inf = parseCardInfo(el);
          return inf && (inf.ext === 'VIDEO' || ['MP4','MKV','AVI','WEBM','MOV','TS'].includes(inf.ext));
        });
        if (videoItems.length > 0) {
          playVideoInSidecar(videoItems, 0);
        } else {
          showToast(_t('Nenašli sa žiadne videá na prehratie.', 'No videos found to play.'));
        }
      };
    }

    document.getElementById('gfg-btn-copy-links').onclick = () => {
      copySelectedLinks();
    };

    document.getElementById('gfg-btn-import-dashboard').onclick = () => {
      importSelectedToDashboard();
    };

    updateBatchCount();
    if (extractorGroup) toolbar.appendChild(extractorGroup);
    else installDirectUrlExtractor(toolbar);
  }

  function installDirectUrlExtractor(toolbar) {
    if (toolbar.querySelector('#gfg-extract-selected')) return;
    const group = document.createElement('div');
    group.dataset.gfgExtractor = 'true';
    group.className = 'gfg-toolbar-group';
    group.innerHTML = '<strong>EXTRACT DIRECT URLS</strong> <button id="gfg-extract-selected" class="gfg-btn">Selected</button> <button id="gfg-extract-all" class="gfg-btn">All</button> <span id="gfg-extract-status" role="status"></span>';
    toolbar.appendChild(group);
    let running = false;
    let cancelled = false;
    const status = group.querySelector('[role="status"]');
    const direct = value => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && /(^|\.)gofile\.io$/.test(url.hostname)
          && url.pathname.startsWith('/download/') && !/\/thumb[^/]*$/i.test(url.pathname) ? url.href : '';
      } catch { return ''; }
    };
    const selected = row => row.classList.contains('gfg-selected') || row.dataset.selected === 'true'
      || !!row.querySelector('.gfg-card-checkbox:checked, input[type="checkbox"]:checked, .nvs-checkbox[aria-checked="true"]');
    async function extract(all) {
      if (running) return;
      const rows = Array.from(document.querySelectorAll('.gfg-card-processed[data-id]'))
        .filter(row => row.dataset.type !== 'folder' && (all || selected(row)));
      if (!rows.length) { status.textContent = 'Najprv označ súbory.'; return; }
      running = true;
      cancelled = false;
      const pageUrl = location.href;
      group.querySelectorAll('button').forEach(btn => { btn.disabled = true; });
      const panel = document.createElement('dialog');
      panel.id = 'gfg-direct-results';
      panel.style.cssText = 'background:#131c31;color:#e2e8f0;border:1px solid #6366f1;border-radius:14px;padding:20px;width:min(850px,90vw);max-height:85vh;overflow:auto';
      panel.innerHTML = '<h3>EXTRACT DIRECT URLS</h3><p role="status"></p><textarea aria-label="Extracted direct URLs" readonly style="width:100%;height:220px;background:#0f172a;color:#e2e8f0"></textarea><p><button class="gfg-btn" data-copy disabled>Copy URLs</button> <button class="gfg-btn" data-export disabled>Export TXT</button> <button class="gfg-btn" data-close>Zastaviť / Zavrieť</button></p><pre style="white-space:pre-wrap" data-failures></pre>';
      document.body.appendChild(panel);
      // Non-modal: native GoFile previews remain able to open during extraction.
      panel.show();
      panel.style.cssText += ';position:fixed;top:15vh;z-index:2147483647';
      panel.querySelector('[data-close]').onclick = () => { cancelled = true; panel.remove(); };
      panel.addEventListener('cancel', () => { cancelled = true; });
      const urls = new Set();
      const failures = [];
      const text = panel.querySelector('textarea');
      panel.querySelector('[data-copy]').onclick = async () => {
        try {
          if (typeof GM_setClipboard === 'function') GM_setClipboard(text.value, 'text');
          else {
            try { await navigator.clipboard.writeText(text.value); }
            catch {
              text.focus();
              text.select();
              if (!document.execCommand('copy')) throw new Error('Clipboard blocked');
            }
          }
          panel.querySelector('[role="status"]').textContent = `Skopírovaných ${urls.size} direct URL.`;
        } catch { panel.querySelector('[role="status"]').textContent = 'Schránka je blokovaná. Použi Export TXT alebo označ text.'; }
      };
      panel.querySelector('[data-export]').onclick = () => {
        const blobUrl = URL.createObjectURL(new Blob([text.value + '\n'], { type: 'text/plain;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = 'gofile-direct-urls.txt';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      };
      try {
        for (const [index, row] of rows.entries()) {
          if (cancelled || location.href !== pageUrl) break;
          const name = row.querySelector('.gfg-card-title, p.truncate')?.textContent.trim() || row.dataset.id;
          const progress = `${index + 1}/${rows.length} · ${name}`;
          status.textContent = progress;
          panel.querySelector('[role="status"]').textContent = progress;
          let url = Array.from(row.querySelectorAll('a[href], video[src], source[src]'))
            .map(el => direct(el.href || el.src)).find(Boolean);
          let preview = null;
          if (!url) {
            const before = new Map(Array.from(document.querySelectorAll('video, source, img')).map(el => [el, el.currentSrc || el.src]));
            const trigger = row.querySelector('button[data-action="preview"]');
            if (trigger) {
              trigger.click();
              const deadline = Date.now() + 12000;
              while (!cancelled && location.href === pageUrl && Date.now() < deadline) {
                for (const media of document.querySelectorAll('video, source, [role="dialog"] img')) {
                  const src = media.currentSrc || media.src;
                  const candidate = direct(src);
                  if (candidate && before.get(media) !== src) {
                    // Correlate with this row; never capture another file's player.
                    const path = new URL(candidate).pathname;
                    if (!path.split('/').includes(row.dataset.id)) continue;
                    url = candidate;
                    preview = media.closest('[role="dialog"]');
                    if (media.tagName === 'VIDEO') media.pause();
                    break;
                  }
                }
                if (url) break;
                await new Promise(resolve => setTimeout(resolve, 150));
              }
              preview ||= Array.from(document.querySelectorAll('[role="dialog"]')).find(el => el !== panel && el.textContent.includes(name));
              preview?.querySelector('button[aria-label="Close"], button[aria-label="Close dialog"], button[aria-label="Close preview"], button[data-action="close"]')?.click();
            }
          }
          if (url) urls.add(url);
          else failures.push(name);
          text.value = Array.from(urls).join('\n');
          panel.querySelectorAll('[data-copy], [data-export]').forEach(btn => { btn.disabled = !urls.size; });
          panel.querySelector('[data-failures]').textContent = failures.length ? `Nezískané (${failures.length}):\n${failures.join('\n')}` : '';
        }
        status.textContent = `${cancelled ? 'Zastavené' : 'Hotovo'}: ${urls.size} URL, ${failures.length} nezískaných.`;
        if (panel.isConnected) panel.querySelector('[role="status"]').textContent = status.textContent + ' All = všetky načítané súbory aktuálneho priečinka.';
      } catch (error) {
        status.textContent = `Extrakcia prerušená: ${error.message}`;
      } finally {
        running = false;
        group.querySelectorAll('button').forEach(btn => { btn.disabled = false; });
      }
    }
    group.querySelector('#gfg-extract-selected').onclick = () => extract(false);
    group.querySelector('#gfg-extract-all').onclick = () => extract(true);
  }

  function updateBatchCount() {
    const selected = state.activeItems.filter(el => el.classList.contains('gfg-selected'));
    const badge = document.getElementById('gfg-copy-count');
    if (badge) {
      badge.textContent = selected.length > 0 ? `Linky (${selected.length})` : 'Linky';
    }
    const importButton = document.getElementById('gfg-btn-import-dashboard');
    const importLabel = document.getElementById('gfg-import-count');
    if (importButton) importButton.disabled = selected.length === 0;
    if (importLabel) importLabel.textContent = `Importovať (${selected.length})`;
  }

  function toggleSelectAll() {
    const allCheckboxes = state.activeItems.map(el => el.querySelector('input[type="checkbox"], .gfg-card-checkbox')).filter(Boolean);
    const someUnchecked = allCheckboxes.some(cb => !cb.checked);

    allCheckboxes.forEach(cb => {
      cb.checked = someUnchecked;
      const card = cb.closest('.gfg-card-processed');
      if (card) card.classList.toggle('gfg-selected', someUnchecked);
    });

    updateBatchCount();
    showToast(someUnchecked ? 'Označené všetky súbory' : 'Všetky súbory odznačené');
  }

  function copySelectedLinks() {
    let targetItems = state.activeItems.filter(el => el.classList.contains('gfg-selected'));
    if (targetItems.length === 0) {
      targetItems = state.activeItems;
    }

    const links = [];
    targetItems.forEach(item => {
      const info = parseCardInfo(item);
      const link = info?.downloadBtn?.href || info?.previewBtn?.href || window.location.href;
      if (link) links.push(link);
    });

    if (links.length > 0) {
      const text = links.join('\n');
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text);
      } else {
        navigator.clipboard.writeText(text);
      }
      showToast(`Skopírovaných ${links.length} odkazov do schránky!`);
    } else {
      showToast(_t('Nenašli sa žiadne odkazy.', 'No links found.'));
    }
  }

  // ────────────────────────────────────────────────────────────
  // 8. Nexus Import Desk
  // ────────────────────────────────────────────────────────────

  const NEXUS_PORTS = [8000, 8001, 8002, 8003];
  const GM_REQUEST = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
    : (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function'
      ? GM.xmlHttpRequest.bind(GM) : null);

  function bridgeFetch(url, options = {}) {
    if (!GM_REQUEST) return fetch(url, options);
    return new Promise((resolve, reject) => {
      GM_REQUEST({
        method: options.method || 'GET',
        url,
        headers: options.headers || {},
        data: options.body,
        timeout: options.timeoutMs || 10000,
        onload: (result) => {
          const text = result.responseText || '';
          resolve({
            ok: result.status >= 200 && result.status < 300,
            status: result.status,
            json: async () => { try { return JSON.parse(text); } catch { return {}; } },
          });
        },
        onerror: () => reject(new Error(_t('Spojenie s Nexus Dashboardom zlyhalo.', 'Connection to Nexus Dashboard failed.'))),
        ontimeout: () => reject(new Error('Nexus Dashboard neodpovedá.')),
      });
    });
  }

  async function findNexusPort() {
    const preferred = Number(getPref('nexusPort', 8000));
    const ports = [preferred, ...NEXUS_PORTS.filter(port => port !== preferred)];
    for (const port of ports) {
      try {
        const response = await bridgeFetch(`http://localhost:${port}/health`, { timeoutMs: 3500 });
        if (response.ok) {
          setPref('nexusPort', port);
          return port;
        }
      } catch {
        // Skúsime ďalší lokálny port.
      }
    }
    throw new Error('Nexus Dashboard nie je dostupný na portoch 8000–8003.');
  }

  function getFolderTitle() {
    const title = document.querySelector('#fm-root h1, .fm-root h1, main h1')?.textContent?.trim();
    return title || document.title.replace(/\s*[·|].*$/, '').trim() || 'GoFile folder';
  }

  function defaultDashboardBatchName() {
    return `GoFile · ${getFolderTitle()}`;
  }

  function getDashboardBatchName() {
    const value = document.getElementById('gfg-batch-name')?.value.trim();
    return value || defaultDashboardBatchName();
  }

  function canonicalBoardUrl(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
    } catch {
      return String(url || '').replace(/[?#].*$/, '').replace(/\/$/, '');
    }
  }

  function boardNameForFolder() {
    const folderId = (location.pathname.match(/\/d\/([^/?#]+)/i) || [])[1] || '';
    const suffix = folderId ? ` · ${folderId.slice(-6)}` : '';
    return `GoFile · ${getFolderTitle()}${suffix}`.slice(0, 120);
  }

  async function ensureSourceBoard(port, batchName) {
    const boardUrl = canonicalBoardUrl(window.location.href);
    const listResponse = await bridgeFetch(`http://localhost:${port}/api/v1/source-boards`, { timeoutMs: 15000 });
    const listData = await listResponse.json().catch(() => ({}));
    if (!listResponse.ok) throw new Error(listData.detail || 'Source Boards sa nedajú načítať.');

    const existing = (listData.boards || []).find(board => canonicalBoardUrl(board.source_url) === boardUrl);
    const description = 'GoFile priečinok pridaný z Gofile Folder Grid.';
    const payload = existing ? {
      name: existing.name,
      source_url: window.location.href,
      source_type: 'gofile',
      batch_name: batchName,
      description: existing.description || description,
      icon: existing.icon || 'folder_special',
      color: existing.color || '#22c55e',
      pinned: existing.pinned !== false,
    } : {
      name: boardNameForFolder(),
      source_url: window.location.href,
      source_type: 'gofile',
      batch_name: batchName,
      description,
      icon: 'folder_special',
      color: '#22c55e',
      pinned: true,
    };
    const endpoint = existing ? `/api/v1/source-boards/${existing.id}` : '/api/v1/source-boards';
    const response = await bridgeFetch(`http://localhost:${port}${endpoint}`, {
      method: existing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 15000,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || 'Source Board sa nepodarilo uložiť.');
    return { board: data.board, created: !existing };
  }

  function gofileItemUrl(item) {
    const id = item.getAttribute('data-id') || '';
    // GoFile API akceptuje file ID rovnako ako folder ID. Nexus ho rozbalí na
    // presný stream jednej položky, takže výber nezoberie celý priečinok.
    return id ? `https://gofile.io/d/${encodeURIComponent(id)}` : '';
  }

  async function importSelectedToDashboard() {
    const selected = state.activeItems.filter(item => item.classList.contains('gfg-selected'));
    if (!selected.length) {
      showToast('Najprv označ súbory, ktoré chceš importovať.');
      return;
    }

    const candidates = selected.map(item => {
      const info = parseCardInfo(item);
      const url = gofileItemUrl(item);
      const sizeBytes = parseSizeToBytes(info?.sizeStr || '');
      return {
        url,
        source_url: window.location.href,
        title: info?.title || 'GoFile file',
        thumbnail: info?.thumbSrc || '',
        file_size_mb: sizeBytes ? Number((sizeBytes / (1024 ** 2)).toFixed(2)) : 0,
        upload_date: info?.dateStr || null,
        source: 'gofile',
        tags: ['gofile', 'gofile-folder-grid'],
        confidence: 0.98,
      };
    }).filter(candidate => candidate.url);

    if (!candidates.length) {
      showToast('GoFile neposkytol identifikátor vybraných súborov.');
      return;
    }

    const batchName = getDashboardBatchName();
    const includeSourceBoard = !!document.getElementById('gfg-source-board-toggle')?.checked;
    const button = document.getElementById('gfg-btn-import-dashboard');
    const label = document.getElementById('gfg-import-count');
    if (button) button.disabled = true;
    if (label) label.textContent = 'Zaraďujem…';

    try {
      const port = await findNexusPort();
      let sourceBoardResult = null;
      if (includeSourceBoard) {
        if (label) label.textContent = 'Ukladám board…';
        sourceBoardResult = await ensureSourceBoard(port, batchName);
      }
      if (label) label.textContent = 'Zaraďujem…';
      const response = await bridgeFetch(`http://localhost:${port}/api/v1/intake/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batch_name: batchName,
          candidates,
          source_mode: 'gofile',
          auto_metadata: true,
          playwright_fallback: true,
        }),
        timeoutMs: 30000,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || `Nexus odpovedal chybou ${response.status}.`);
      const boardNote = sourceBoardResult
        ? ` · Source Board ${sourceBoardResult.created ? 'vytvorený' : 'aktualizovaný'}.`
        : '';
      showToast(`Zaradené: ${data.job?.total_items ?? candidates.length} súborov · Import job #${data.job?.id ?? '?'}.${boardNote}`);
    } catch (error) {
      showToast(_t(`Import zlyhal: ${error.message || error}`, `Import failed: ${error.message || error}`));
    } finally {
      updateBatchCount();
    }
  }

  // ────────────────────────────────────────────────────────────
  // 9. Filtrovanie a Zoradenie
  // ────────────────────────────────────────────────────────────

  function filterItems(query) {
    let visibleCount = 0;
    state.activeItems.forEach(item => {
      const title = (item.querySelector('.gfg-card-title')?.textContent || item.textContent || '').toLowerCase();
      const match = !query || title.includes(query);
      item.classList.toggle('gfg-item-hidden', !match);
      if (match) visibleCount++;
    });

    const badge = document.getElementById('gfg-item-count-badge');
    if (badge) {
      badge.textContent = query ? `${visibleCount} / ${state.activeItems.length}` : `${state.activeItems.length} položiek`;
    }
  }

  function parseSizeToBytes(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB|B)/i);
    if (!match) return 0;
    const num = parseFloat(match[1].replace(',', '.'));
    const unit = match[2].toUpperCase();
    if (unit === 'TB') return num * 1024 * 1024 * 1024 * 1024;
    if (unit === 'GB') return num * 1024 * 1024 * 1024;
    if (unit === 'MB') return num * 1024 * 1024;
    if (unit === 'KB') return num * 1024;
    return num;
  }

  function parseDateToTimestamp(dateStr) {
    if (!dateStr) return 0;
    const m = dateStr.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})(?:,\s*(\d{1,2}):(\d{2}))?/);
    if (!m) return 0;
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const year = parseInt(m[3], 10);
    const hour = m[4] !== undefined ? parseInt(m[4], 10) : 0;
    const minute = m[5] !== undefined ? parseInt(m[5], 10) : 0;
    return new Date(year, month, day, hour, minute).getTime();
  }

  function parseDurationToSeconds(text) {
    if (!text) return 0;
    const timeMatch = text.match(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/);
    if (timeMatch) {
      const h = timeMatch[1] ? parseInt(timeMatch[1], 10) : 0;
      const m = parseInt(timeMatch[2], 10);
      const s = parseInt(timeMatch[3], 10);
      return h * 3600 + m * 60 + s;
    }
    const hmMatch = text.match(/(?:(\d+)\s*h(?:od|ours?)?)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s(?:ec)?)?/i);
    if (hmMatch && (hmMatch[1] || hmMatch[2] || hmMatch[3])) {
      const h = parseInt(hmMatch[1] || 0, 10);
      const m = parseInt(hmMatch[2] || 0, 10);
      const s = parseInt(hmMatch[3] || 0, 10);
      return h * 3600 + m * 60 + s;
    }
    return 0;
  }

  function sortItems(mode) {
    if (!state.folderContainer) return;

    const items = Array.from(state.activeItems);
    items.sort((a, b) => {
      const infoA = parseCardInfo(a);
      const infoB = parseCardInfo(b);

      if (mode === 'name-asc') {
        return (infoA?.title || '').localeCompare(infoB?.title || '');
      }
      if (mode === 'name-desc') {
        return (infoB?.title || '').localeCompare(infoA?.title || '');
      }
      if (mode === 'size-desc') {
        return parseSizeToBytes(infoB?.sizeStr) - parseSizeToBytes(infoA?.sizeStr);
      }
      if (mode === 'size-asc') {
        return parseSizeToBytes(infoA?.sizeStr) - parseSizeToBytes(infoB?.sizeStr);
      }
      if (mode === 'date-desc') {
        return parseDateToTimestamp(infoB?.dateStr) - parseDateToTimestamp(infoA?.dateStr);
      }
      if (mode === 'date-asc') {
        return parseDateToTimestamp(infoA?.dateStr) - parseDateToTimestamp(infoB?.dateStr);
      }
      if (mode === 'duration-desc') {
        return parseDurationToSeconds(infoB?.title) - parseDurationToSeconds(infoA?.title);
      }
      if (mode === 'duration-asc') {
        return parseDurationToSeconds(infoA?.title) - parseDurationToSeconds(infoB?.title);
      }
      return parseInt(a.getAttribute('data-gfg-index') || 0, 10) - parseInt(b.getAttribute('data-gfg-index') || 0, 10);
    });

    items.forEach(item => state.folderContainer.appendChild(item));
  }

  // ────────────────────────────────────────────────────────────
  // 9. Toast Notifikácie
  // ────────────────────────────────────────────────────────────

  function showToast(message) {
    let toast = document.getElementById('gfg-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'gfg-toast';
      toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: rgba(15, 23, 42, 0.95);
        color: #ffffff;
        padding: 10px 18px;
        border-radius: 10px;
        border: 1px solid var(--gfg-border-hover);
        box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        font-size: 13.5px;
        font-weight: 500;
        z-index: 999999;
        backdrop-filter: blur(10px);
        transform: translateY(20px);
        opacity: 0;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        pointer-events: none;
      `;
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.style.transform = 'translateY(0)';
    toast.style.opacity = '1';

    clearTimeout(toast.__timer);
    toast.__timer = setTimeout(() => {
      toast.style.transform = 'translateY(20px)';
      toast.style.opacity = '0';
    }, 2800);
  }

  // ────────────────────────────────────────────────────────────
  // 10. Inicializácia a MutationObserver pre SPA
  // ────────────────────────────────────────────────────────────

  let debounceTimer = null;
  function triggerRefresh() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      applyGridLayout();
    }, 150);
  }

  function startObserver() {
    if (state.observer) state.observer.disconnect();

    state.observer = new MutationObserver((mutations) => {
      let shouldRefresh = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0) {
          shouldRefresh = true;
          break;
        }
      }
      if (shouldRefresh) triggerRefresh();
    });

    state.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function hookHistory() {
    const origPush = history.pushState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      setTimeout(triggerRefresh, 300);
    };

    const origReplace = history.replaceState;
    history.replaceState = function () {
      origReplace.apply(this, arguments);
      setTimeout(triggerRefresh, 300);
    };

    window.addEventListener('popstate', () => {
      setTimeout(triggerRefresh, 300);
    });
  }

  function init() {
    injectStyles();
    initSidecarUI();
    hookHistory();
    startObserver();

    setTimeout(applyGridLayout, 400);
    setTimeout(applyGridLayout, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
