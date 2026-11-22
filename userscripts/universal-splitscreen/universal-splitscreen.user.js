// ==UserScript==
// @name         Nexus Universal Split-Screen
// @namespace    nexus.universal.splitscreen.core
// @version      1.9.1
// @description  Univerzálny high-performance Split-Screen prehrávač pre akúkoľvek webstránku (Bunkr, Turbo, Pixeldrain, xHamster, Eporner, XVideos a ľubovoľné video karty). Resizable 3x2/3x3/4x2 Gallery Grid výber, Full Metadata Fetcher, Pro-Grade Video Ovládanie (Scrubber, Skoky, Rýchlosti, FX panel, Snapshot, Focus), A-B Looper & Precision Clip Trimmer, Multi-Cam Synchro-Scrub, Nexus Vault Intake, HLS.js, DASH.js, Pixeldrain native streaming a rýchly štart prehrávania.
// @author       Nexus Architecture Team
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      *
// @connect      127.0.0.1
// @connect      localhost
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

  // Ochrana pred spustením vo vnútri iframe okien Split-Screenu
  if (window.top !== window.self || document.getElementById('nuss-fab')) return;

  const CONFIG = {
    DEFAULT_NEXUS_PORT: 8000,
    // Extreme Fast-Start for Bunkr with warm-up cache and MediaSource
    BUNKR_AGGRESSIVE_STREAMING: true,
    HLS_CDN: 'https://cdn.jsdelivr.net/npm/hls.js@1.5.8/dist/hls.min.js',
    DASH_CDN: 'https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js',
    MP4BOX_CDN: 'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js',
    MAX_ITEMS: 12,
    DEFAULT_PICKER_LAYOUT: '3x2',
    // Pixeldrain Quota Saver nastavenia
    PIXELDRAIN_MAX_BUFFER_AHEAD: 14, // Max 14 sekúnd dopredu (10–15s rozsah)
    PIXELDRAIN_MIN_BUFFER_AHEAD: 5,  // Znova začať sťahovať keď buffer klesne pod 5s
    PIXELDRAIN_CHUNK_SIZE: 1.5 * 1024 * 1024 // 1.5 MB chunky
  };

  const GM_REQ = typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest
    : (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest.bind(GM) : null;

  // ---------------------------------------------------------------------------
  // 1. ŠTÝLY (UI, FAB, Modál výberu, Split-Screen Overlay, Diag HUD)
  // ---------------------------------------------------------------------------
  const STYLES = `
    #nuss-quick-selection{position:fixed;left:18px;bottom:86px;z-index:2147483645;display:flex;gap:8px;align-items:center;padding:9px;background:#151927f2;border:1px solid #9562c4;border-radius:14px;box-shadow:0 6px 24px #0007;max-width:calc(100vw - 36px);box-sizing:border-box;font:600 13px system-ui;color:#f3e8ff}
    #nuss-quick-selection[hidden]{display:none!important}#nuss-quick-selection button{border:1px solid #a879d2;border-radius:9px;background:#7524a0;color:white;padding:10px 12px;font:inherit;cursor:pointer}#nuss-quick-selection button:disabled{opacity:.5;cursor:default}#nuss-quick-selection [data-quick="picker"]{background:#242b3b}html.nuss-with-nvs #nuss-fab{display:none!important}
    .nuss-page-select{position:absolute;left:8px;top:8px;z-index:40;width:27px;height:27px;accent-color:#9333ea;cursor:pointer}.nuss-page-selected{outline:3px solid #a855f7;outline-offset:2px}
    @media(max-width:480px){#nuss-quick-selection{font-size:12px;gap:5px;padding:6px}#nuss-quick-selection button{padding:9px 7px}}
    /* Plávajúce tlačidlo (FAB) */
    #nuss-fab {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483640;
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: linear-gradient(135deg, #7c3aed 0%, #db2777 100%);
      border: 2px solid rgba(255, 255, 255, 0.35);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.65), 0 0 16px rgba(219, 39, 119, 0.45);
      transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s ease;
      user-select: none;
    }
    #nuss-fab:hover {
      transform: scale(1.12);
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.8), 0 0 24px rgba(219, 39, 119, 0.7);
    }
    #nuss-fab svg {
      width: 26px;
      height: 26px;
      fill: #ffffff;
      filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));
    }
    #nuss-fab .nuss-badge {
      position: absolute;
      top: -4px;
      right: -4px;
      background: #10b981;
      color: #fff;
      font: 800 11px system-ui, sans-serif;
      padding: 2px 6px;
      border-radius: 10px;
      border: 1px solid #fff;
    }

    /* Modál pre výber videí na stránke (Resizable & Gallery Grid) */
    #nuss-picker-modal {
      position: fixed;
      inset: 0;
      z-index: 2147483645;
      background: rgba(4, 7, 15, 0.88);
      backdrop-filter: blur(14px);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 16px;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .nuss-picker-box {
      width: var(--nuss-picker-w, min(1140px, 95vw));
      height: var(--nuss-picker-h, min(840px, 88vh));
      min-width: 440px;
      min-height: 380px;
      max-width: 99vw;
      max-height: 98vh;
      resize: both;
      overflow: hidden;
      position: relative;
      background: #0b1120;
      border: 1px solid rgba(168, 85, 247, 0.45);
      border-radius: 16px;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.9), 0 0 24px rgba(168, 85, 247, 0.15);
      display: flex;
      flex-direction: column;
      color: #e2e8f0;
      box-sizing: border-box;
    }
    .nuss-resize-grip {
      position: absolute;
      bottom: 0;
      right: 0;
      width: 22px;
      height: 22px;
      cursor: nwse-resize;
      z-index: 45;
      background: linear-gradient(135deg, transparent 50%, rgba(168, 85, 247, 0.55) 50%, rgba(236, 72, 153, 0.8) 100%);
      border-bottom-right-radius: 14px;
      transition: background 0.15s ease;
    }
    .nuss-resize-grip:hover {
      background: linear-gradient(135deg, transparent 40%, rgba(168, 85, 247, 0.9) 40%, rgba(236, 72, 153, 1) 100%);
    }
    .nuss-resize-handle {
      position: absolute;
      z-index: 44;
      background: transparent;
      user-select: none;
    }
    .nuss-resize-handle.nuss-resize-se {
      bottom: 0; right: 0; width: 22px; height: 22px; cursor: nwse-resize;
    }
    .nuss-resize-handle.nuss-resize-sw {
      bottom: 0; left: 0; width: 22px; height: 22px; cursor: nesw-resize;
    }
    .nuss-resize-handle.nuss-resize-ne {
      top: 0; right: 0; width: 22px; height: 22px; cursor: nesw-resize;
    }
    .nuss-resize-handle.nuss-resize-nw {
      top: 0; left: 0; width: 22px; height: 22px; cursor: nwse-resize;
    }
    .nuss-resize-handle.nuss-resize-s {
      bottom: 0; left: 22px; right: 22px; height: 8px; cursor: ns-resize;
    }
    .nuss-resize-handle.nuss-resize-e {
      right: 0; top: 22px; bottom: 22px; width: 8px; cursor: ew-resize;
    }
    .nuss-resize-handle.nuss-resize-w {
      left: 0; top: 22px; bottom: 22px; width: 8px; cursor: ew-resize;
    }
    .nuss-resize-handle.nuss-resize-n {
      top: 0; left: 22px; right: 22px; height: 8px; cursor: ns-resize;
    }
    .nuss-picker-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 18px;
      background: #162032;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      font-weight: 700;
      font-size: 13.5px;
      user-select: none;
    }
    .nuss-picker-head-title {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #f3e8ff;
    }
    .nuss-picker-head-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .nuss-picker-icon-btn {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 15px;
      cursor: pointer;
      padding: 3px 8px;
      border-radius: 4px;
      line-height: 1;
      transition: color 0.15s, background 0.15s;
    }
    .nuss-picker-icon-btn:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.1);
    }
    .nuss-picker-icon-btn.is-close:hover {
      color: #ef4444;
      background: rgba(239, 68, 68, 0.18);
    }

    /* Toolbar & Segmented Layout Switcher */
    .nuss-picker-toolbar {
      padding: 8px 16px;
      background: #0f172a;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .nuss-picker-toolbar-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    #nuss-picker-filter {
      flex: 1;
      min-width: 180px;
      background: #090d16;
      border: 1px solid rgba(168, 85, 247, 0.4);
      border-radius: 6px;
      padding: 6px 12px;
      color: #fff;
      font-size: 12px;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    #nuss-picker-filter:focus {
      border-color: #c084fc;
      box-shadow: 0 0 0 2px rgba(168, 85, 247, 0.3);
    }
    .nuss-layout-switcher {
      display: inline-flex;
      background: #080d1a;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 7px;
      padding: 2px;
      gap: 2px;
    }
    .nuss-layout-btn {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 11px;
      font-weight: 700;
      padding: 4px 8px;
      border-radius: 5px;
      cursor: pointer;
      transition: all 0.14s ease;
      white-space: nowrap;
    }
    .nuss-layout-btn:hover {
      color: #f1f5f9;
    }
    .nuss-layout-btn.is-active {
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      color: #fff;
      box-shadow: 0 2px 6px rgba(124, 58, 237, 0.4);
    }
    .nuss-chip-group {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .nuss-chip-btn {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 5px;
      color: #cbd5e1;
      font-size: 11px;
      font-weight: 600;
      padding: 5px 10px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s, border-color 0.15s;
    }
    .nuss-chip-btn:hover {
      background: rgba(168, 85, 247, 0.35);
      border-color: #a855f7;
      color: #fff;
    }
    .nuss-btn-fetch-meta {
      background: linear-gradient(135deg, rgba(16, 185, 129, 0.22), rgba(6, 182, 212, 0.25));
      border: 1px solid rgba(52, 211, 153, 0.55);
      color: #6ee7b7;
      font-weight: 700;
      font-size: 11px;
      padding: 5px 12px;
      border-radius: 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: all 0.16s ease;
      white-space: nowrap;
    }
    .nuss-btn-fetch-meta:hover {
      background: linear-gradient(135deg, rgba(16, 185, 129, 0.38), rgba(6, 182, 212, 0.45));
      border-color: #34d399;
      color: #fff;
      box-shadow: 0 0 12px rgba(52, 211, 153, 0.35);
    }

    /* Mriežka a zoznam videí */
    /* Mriežka a zoznam videí */
    .nuss-picker-list {
      flex: 1 1 0% !important;
      min-height: 0 !important;
      overflow-y: auto !important;
      padding: 14px 16px !important;
      display: grid !important;
      align-content: start !important;
      box-sizing: border-box !important;
    }
    /* Predvolený Gallery Grid Layout 3x2 */
    .nuss-picker-list[data-layout="3x2"] {
      grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
      grid-auto-rows: max-content !important;
      gap: 14px !important;
    }
    /* Grid Layout 3x3 */
    .nuss-picker-list[data-layout="3x3"] {
      grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
      grid-auto-rows: max-content !important;
      gap: 10px !important;
    }
    /* Grid Layout 4x2 */
    .nuss-picker-list[data-layout="4x2"] {
      grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
      grid-auto-rows: max-content !important;
      gap: 12px !important;
    }
    /* Grid Layout 4x3 */
    .nuss-picker-list[data-layout="4x3"] {
      grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
      grid-auto-rows: max-content !important;
      gap: 8px !important;
    }
    /* Klasický riadkový zoznam (List) */
    .nuss-picker-list[data-layout="list"] {
      grid-template-columns: 1fr !important;
      grid-auto-rows: max-content !important;
      gap: 8px !important;
    }

    /* Karta videa (Gallery Card vzhľad podľa screen 2) */
    .nuss-card {
      position: relative !important;
      display: flex !important;
      flex-direction: column !important;
      background: #0d1322 !important;
      border: 1px solid rgba(148, 163, 184, 0.16) !important;
      border-radius: 12px !important;
      overflow: hidden !important;
      cursor: pointer !important;
      transition: transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease !important;
      user-select: none !important;
      min-width: 0 !important;
      box-sizing: border-box !important;
    }
    .nuss-card:hover {
      transform: translateY(-2px) !important;
      border-color: rgba(168, 85, 247, 0.6) !important;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.6), 0 0 14px rgba(168, 85, 247, 0.2) !important;
    }
    .nuss-card.is-selected {
      border-color: #a855f7 !important;
      background: #131a2d !important;
      box-shadow: 0 0 0 2px #a855f7, 0 10px 24px rgba(0, 0, 0, 0.6) !important;
    }
    /* 16:9 stage s garantovaným nerozbitným pomerom strán */
    .nuss-card-stage {
      position: relative !important;
      width: 100% !important;
      height: 0 !important;
      padding-bottom: 56.25% !important; /* Presný 16:9 pomer strán */
      background: #050811 !important;
      overflow: hidden !important;
      display: block !important;
      flex-shrink: 0 !important;
      box-sizing: border-box !important;
    }
    .nuss-card-thumb {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      width: 100% !important;
      height: 100% !important;
      object-fit: cover !important;
      display: block !important;
      transition: transform 0.25s ease !important;
    }
    .nuss-card:hover .nuss-card-thumb {
      transform: scale(1.04) !important;
    }
    .nuss-thumb-placeholder,
    .nuss-card-thumb-placeholder {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      width: 100% !important;
      height: 100% !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      color: #94a3b8 !important;
      font-weight: 700 !important;
      font-size: 11px !important;
      background: linear-gradient(135deg, #090e1a 0%, #151e34 100%) !important;
      user-select: none !important;
    }
    .nuss-card-idx-badge {
      position: absolute;
      top: 7px;
      left: 7px;
      z-index: 5;
      background: rgba(15, 23, 42, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 6px;
      padding: 2px 7px;
      color: #e2e8f0;
      font-size: 11px;
      font-weight: 800;
      backdrop-filter: blur(8px);
    }
    .nuss-card-cb-wrap {
      position: absolute;
      top: 7px;
      right: 7px;
      z-index: 5;
      cursor: pointer;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .nuss-card-cb-wrap input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
      pointer-events: none;
    }
    .nuss-card-cb-custom {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: rgba(15, 23, 42, 0.82);
      border: 2px solid rgba(255, 255, 255, 0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(8px);
      transition: all 0.16s ease;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    }
    .nuss-card-cb-custom::after {
      content: "✓";
      color: #fff;
      font-size: 13px;
      font-weight: 900;
      opacity: 0;
      transform: scale(0.5);
      transition: all 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .nuss-card.is-selected .nuss-card-cb-custom {
      background: linear-gradient(135deg, #7c3aed, #ec4899);
      border-color: #fff;
      box-shadow: 0 0 12px rgba(236, 72, 153, 0.7);
    }
    .nuss-card.is-selected .nuss-card-cb-custom::after {
      opacity: 1;
      transform: scale(1);
    }
    .nuss-card-overlay-chips {
      position: absolute;
      bottom: 6px;
      left: 6px;
      right: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
      pointer-events: none;
      z-index: 4;
    }
    .nuss-card-chip {
      padding: 2px 6px;
      border-radius: 5px;
      font-size: 10.5px;
      font-weight: 700;
      backdrop-filter: blur(8px);
      white-space: nowrap;
    }
    .nuss-chip-duration {
      background: rgba(15, 23, 42, 0.88);
      color: #f8fafc;
      border: 1px solid rgba(255, 255, 255, 0.22);
    }
    .nuss-chip-hd {
      background: linear-gradient(135deg, #6d28d9, #9333ea);
      border: 1px solid rgba(216, 180, 254, 0.8);
      color: #fff;
      box-shadow: 0 2px 8px rgba(147, 51, 234, 0.45);
    }
    .nuss-chip-hd.is-4k {
      background: linear-gradient(115deg, #0284c7, #7c3aed, #ec4899);
      border: 1px solid rgba(244, 114, 182, 0.9);
      box-shadow: 0 2px 10px rgba(236, 72, 153, 0.6);
    }
    .nuss-card-caption {
      padding: 8px 10px 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .nuss-card-title {
      font-size: 12px;
      font-weight: 600;
      color: #f8fafc;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.35;
    }
    .nuss-card-meta-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 10.5px;
      color: #94a3b8;
    }
    .nuss-card-type-tag {
      font-size: 9.5px;
      font-weight: 800;
      padding: 1px 6px;
      border-radius: 4px;
      letter-spacing: 0.02em;
    }
    .nuss-card-size {
      font-family: Consolas, monospace;
      font-size: 10.5px;
      color: #cbd5e1;
    }

    /* List Layout Override */
    .nuss-picker-list[data-layout="list"] .nuss-card {
      flex-direction: row !important;
      align-items: center !important;
      padding: 8px 14px !important;
      gap: 14px !important;
      height: 72px !important;
      min-height: 72px !important;
      max-height: 72px !important;
      flex-shrink: 0 !important;
    }
    .nuss-picker-list[data-layout="list"] .nuss-card-stage {
      width: 100px !important;
      min-width: 100px !important;
      max-width: 100px !important;
      height: 56px !important;
      min-height: 56px !important;
      max-height: 56px !important;
      padding-bottom: 0 !important;
      border-radius: 6px !important;
      flex-shrink: 0 !important;
      display: block !important;
      position: relative !important;
    }
    .nuss-picker-list[data-layout="list"] .nuss-card-cb-wrap {
      position: static !important;
      order: -1 !important;
      margin: 0 !important;
    }
    .nuss-picker-list[data-layout="list"] .nuss-card-idx-badge {
      display: none !important;
    }
    .nuss-picker-list[data-layout="list"] .nuss-card-overlay-chips {
      display: none !important;
    }
    .nuss-picker-list[data-layout="list"] .nuss-card-caption {
      flex: 1 1 auto !important;
      min-width: 0 !important;
      padding: 0 !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 4px !important;
    }
    .nuss-picker-list[data-layout="list"] .nuss-card-title {
      font-size: 13px !important;
      font-weight: 600 !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      line-height: 1.4 !important;
    }
    .nuss-picker-list[data-layout="list"] .nuss-card-meta-row {
      font-size: 11px !important;
      line-height: 1.4 !important;
    }

    .nuss-picker-foot {
      padding: 12px 18px;
      background: #1e293b;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .nuss-btn-primary {
      background: linear-gradient(135deg, #7c3aed 0%, #db2777 100%);
      border: 1px solid rgba(244, 114, 182, 0.7);
      color: #fff;
      font: 700 13px system-ui, sans-serif;
      padding: 8px 18px;
      border-radius: 8px;
      cursor: pointer;
      transition: filter 0.15s, transform 0.15s;
    }
    .nuss-btn-primary:hover {
      filter: brightness(1.15);
      transform: translateY(-1px);
    }

    /* HLAVNÝ SPLIT-SCREEN OVERLAY */
    #nuss-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: #04060a;
      display: none;
      flex-direction: column;
      padding: 8px;
      box-sizing: border-box;
      font-family: system-ui, sans-serif;
    }
    #nuss-overlay:fullscreen { width: 100%; height: 100%; padding: 0; }
    #nuss-overlay.nuss-clean { padding: 0; }
    #nuss-overlay.nuss-clean .nuss-topbar { display: none; }
    #nuss-overlay.nuss-clean .nuss-grid-stage { padding: 0; gap: 2px; border: 0; border-radius: 0; }
    #nuss-overlay.nuss-clean .nuss-cell { border: 0; border-radius: 0; }
    #nuss-overlay.nuss-clean .nuss-cell-head,
    #nuss-overlay.nuss-clean .nuss-pro-controls,
    #nuss-overlay.nuss-clean .nuss-cell-fx-panel { display: none !important; }
    #nuss-overlay.nuss-clean .nuss-cell.nuss-selected .nuss-cell-head { display: flex !important; }
    #nuss-overlay.nuss-clean .nuss-cell.nuss-selected .nuss-pro-controls:not([style*="display: none"]):not([style*="display:none"]) { display: flex !important; opacity: 1; }
    #nuss-overlay.nuss-clean .nuss-cell.nuss-selected .nuss-cell-fx-panel[style*="display: flex"] { display: flex !important; }
    .nuss-reveal-bar { display: none; position: absolute; z-index: 200; top: 0; left: 50%; transform: translateX(-50%); padding: 5px; }
    #nuss-overlay.nuss-clean .nuss-reveal-bar { display: flex; opacity: 0; transition: opacity .2s; }
    #nuss-overlay.nuss-clean .nuss-reveal-bar:hover, #nuss-overlay.nuss-clean .nuss-reveal-bar:focus-within { opacity: 1; }
    #nuss-overlay.nuss-clean .nuss-reveal-bar::before { content: ''; position: absolute; inset: 0 -50px -15px; z-index: -1; }
    .nuss-select-cell { display: none; }
    #nuss-overlay.nuss-clean .nuss-select-cell { display: block; position: absolute; z-index: 30; right: 5px; top: 5px; opacity: 0; }
    #nuss-overlay.nuss-clean .nuss-cell:hover .nuss-select-cell, #nuss-overlay.nuss-clean .nuss-select-cell:focus-visible { opacity: 1; }
    .nuss-topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      padding: 8px 12px;
      background: #0e1526;
      border: 1px solid rgba(168, 85, 247, 0.35);
      border-radius: 10px 10px 0 0;
      color: #f1f5f9;
      font-size: 12px;
      font-weight: 600;
    }
    .nuss-topbar-title {
      font-size: 13px;
      font-weight: 800;
      color: #f3e8ff;
      letter-spacing: 0.03em;
    }
    .nuss-controls-group {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }
    .nuss-ctrl-btn {
      background: #1e293b;
      border: 1px solid rgba(148, 163, 184, 0.25);
      color: #e2e8f0;
      padding: 5px 10px;
      border-radius: 6px;
      font: 600 11.5px system-ui, sans-serif;
      cursor: pointer;
      transition: all 0.14s ease;
    }
    .nuss-ctrl-btn:hover {
      border-color: #a855f7;
      color: #fff;
      background: rgba(168, 85, 247, 0.25);
    }
    .nuss-ctrl-btn.is-active {
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      border-color: #c084fc;
      color: #fff;
    }
    .nuss-ctrl-btn.is-close {
      background: #450a0a;
      border-color: #ef4444;
      color: #fee2e2;
    }
    .nuss-ctrl-btn.is-close:hover {
      background: #dc2626;
      color: #fff;
    }

    /* Mriežka buniek Split-Screenu */
    .nuss-grid-stage {
      position: relative;
      flex: 1;
      min-height: 0;
      display: grid;
      gap: 8px;
      padding: 8px;
      background: #020408;
      border: 1px solid rgba(168, 85, 247, 0.25);
      border-top: none;
      border-radius: 0 0 10px 10px;
      box-sizing: border-box;
    }
    .nuss-cell {
      position: relative;
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      background: #080c16;
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 8px;
      overflow: hidden;
      transition: border-color 0.15s ease;
    }
    .nuss-cell:hover {
      border-color: rgba(168, 85, 247, 0.7);
    }
    .nuss-cell.zoom-pan-active {
      border-color: #22c55e;
      box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.55);
    }
    /* Maximalizovaná bunka (Focus Mode) */
    .nuss-cell.is-focused {
      position: absolute !important;
      inset: 6px !important;
      z-index: 100 !important;
      border-color: #a855f7 !important;
      box-shadow: 0 0 50px rgba(0, 0, 0, 0.98), 0 0 20px rgba(168, 85, 247, 0.4) !important;
    }
    .nuss-cell-head {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
      background: #0f172a;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 11px;
      font-weight: 600;
      color: #cbd5e1;
      user-select: none;
      z-index: 22;
    }
    .nuss-cell-num {
      background: rgba(168, 85, 247, 0.25);
      color: #d8b4fe;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 800;
      font-size: 10px;
    }
    .nuss-cell-title {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #f1f5f9;
    }
    .nuss-cell-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .nuss-cell-act-btn {
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #e2e8f0;
      padding: 3px 6px;
      border-radius: 4px;
      font-size: 10.5px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.14s ease;
      display: inline-flex;
      align-items: center;
      text-decoration: none;
    }
    .nuss-cell-act-btn:hover {
      background: rgba(168, 85, 247, 0.35);
      border-color: #a855f7;
      color: #fff;
    }
    .nuss-cell-act-btn.is-active {
      background: rgba(34, 197, 94, 0.3);
      border-color: #22c55e;
      color: #4ade80;
    }
    .nuss-cell-body {
      position: relative;
      flex: 1;
      min-height: 0;
      background: #000;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .nuss-video-viewport {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      background: #000;
    }
    .nuss-cell-video, .nuss-cell-iframe {
      width: 100%;
      height: 100%;
      border: none;
      background: #000;
      object-fit: contain;
      outline: none;
      transition: filter 0.1s ease, transform 0.1s ease;
    }
    .nuss-cell.zoom-pan-active .nuss-cell-video.can-pan {
      transition: filter 0.1s ease;
      cursor: grab;
      user-select: none;
      -webkit-user-drag: none;
    }
    .nuss-cell.zoom-pan-active .nuss-cell-video.is-panning {
      cursor: grabbing;
    }
    .nuss-grid-stage[data-fit="cover"] .nuss-cell-video {
      object-fit: cover;
    }
    .nuss-cell-loader {
      position: absolute;
      inset: 0;
      background: rgba(10, 14, 23, 0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #e2e8f0;
      font-size: 11.5px;
      font-weight: 600;
      z-index: 2;
    }

    /* Picture Adjustments FX Panel */
    .nuss-cell-fx-panel {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      z-index: 25;
      background: rgba(10, 16, 28, 0.94);
      backdrop-filter: blur(14px);
      border-bottom: 1px solid rgba(168, 85, 247, 0.45);
      padding: 10px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.7);
    }
    .nuss-fx-row {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .nuss-fx-row label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 700;
      color: #cbd5e1;
    }
    .nuss-fx-row input[type="range"] {
      width: 75px;
      height: 4px;
      accent-color: #a855f7;
      cursor: pointer;
    }
    .nuss-fx-val {
      color: #c084fc;
      font-family: Consolas, monospace;
      font-size: 10.5px;
      min-width: 36px;
    }
    .nuss-fx-cb-label {
      cursor: pointer;
      color: #f1f5f9;
    }
    .nuss-fx-cb-label input {
      accent-color: #a855f7;
    }
    .nuss-fx-reset {
      margin-left: auto;
      background: rgba(239, 68, 68, 0.2);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #fca5a5;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 10.5px;
      font-weight: 700;
      cursor: pointer;
    }
    .nuss-fx-reset:hover {
      background: #dc2626;
      color: #fff;
    }

    /* Pro-Grade Individual Video Controller */
    .nuss-pro-controls {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 20;
      background: linear-gradient(180deg, transparent 0%, rgba(6, 10, 18, 0.85) 30%, rgba(3, 5, 10, 0.98) 100%);
      padding: 14px 10px 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: opacity 0.25s ease, transform 0.25s ease;
      pointer-events: auto;
    }
    .nuss-pro-controls.is-idle {
      opacity: 0.18;
    }
    .nuss-cell:hover .nuss-pro-controls.is-idle {
      opacity: 1;
    }

    /* Seekbar & Timeline */
    .nuss-pro-timeline-wrap {
      width: 100%;
      padding: 4px 0;
      cursor: pointer;
    }
    .nuss-pro-timeline {
      position: relative;
      width: 100%;
      height: 6px;
      background: rgba(255, 255, 255, 0.18);
      border-radius: 4px;
      overflow: visible;
      transition: height 0.15s ease;
    }
    .nuss-pro-timeline-wrap:hover .nuss-pro-timeline {
      height: 9px;
    }
    .nuss-pro-buffered {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: 0%;
      background: rgba(56, 189, 248, 0.55);
      border-radius: 4px;
      transition: width 0.15s ease;
    }
    .nuss-pro-played {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: 0%;
      background: linear-gradient(90deg, #7c3aed, #ec4899);
      border-radius: 4px;
      box-shadow: 0 0 8px rgba(236, 72, 153, 0.5);
    }
    .nuss-pro-scrubber-handle {
      position: absolute;
      top: 50%;
      left: 0%;
      transform: translate(-50%, -50%);
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 0 6px rgba(0, 0, 0, 0.8), 0 0 10px rgba(168, 85, 247, 0.8);
      opacity: 0;
      transition: opacity 0.15s ease;
      pointer-events: none;
    }
    .nuss-pro-timeline-wrap:hover .nuss-pro-scrubber-handle {
      opacity: 1;
    }
    .nuss-pro-time-tooltip {
      position: absolute;
      bottom: 14px;
      left: 0%;
      transform: translateX(-50%);
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid rgba(168, 85, 247, 0.5);
      color: #fff;
      font: 700 10.5px Consolas, monospace;
      padding: 2px 6px;
      border-radius: 4px;
      pointer-events: none;
      display: none;
      white-space: nowrap;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
    }
    .nuss-pro-timeline-wrap:hover .nuss-pro-time-tooltip {
      display: block;
    }

    /* Control Bar Buttons */
    .nuss-pro-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      flex-wrap: wrap;
    }
    .nuss-pro-grp {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .nuss-pro-btn {
      background: rgba(30, 41, 59, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #f1f5f9;
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
      transition: all 0.14s ease;
      user-select: none;
    }
    .nuss-pro-btn:hover {
      background: rgba(168, 85, 247, 0.35);
      border-color: #a855f7;
      color: #fff;
    }
    .nuss-pro-btn.is-active {
      background: rgba(34, 197, 94, 0.3);
      border-color: #22c55e;
      color: #4ade80;
    }
    .nuss-pro-play {
      min-width: 32px;
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      border-color: #c084fc;
      color: #fff;
      font-size: 13px;
    }
    .nuss-pro-play:hover {
      filter: brightness(1.2);
    }
    .nuss-pro-time {
      font: 700 11px/1 Consolas, monospace;
      color: #cbd5e1;
      padding: 0 4px;
      white-space: nowrap;
    }
    .nuss-pro-vol-wrap {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .nuss-pro-vol-slider {
      width: 55px;
      height: 4px;
      accent-color: #a855f7;
      cursor: pointer;
    }

    /* A-B Looper & Trimmer vizualizácia */
    .nuss-pro-ab-range {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: 0;
      background: rgba(234, 179, 8, 0.4);
      border-left: 2px solid #eab308;
      border-right: 2px solid #f97316;
      border-radius: 3px;
      z-index: 2;
      pointer-events: none;
    }
    .nuss-pro-marker-a, .nuss-pro-marker-b {
      position: absolute;
      top: -16px;
      transform: translateX(-50%);
      font: 800 9px monospace;
      padding: 1px 4px;
      border-radius: 3px;
      z-index: 5;
      pointer-events: none;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.7);
    }
    .nuss-pro-marker-a {
      background: #eab308;
      color: #0f172a;
    }
    .nuss-pro-marker-b {
      background: #f97316;
      color: #fff;
    }
    .nuss-pro-btn-mark-a.is-active {
      background: rgba(234, 179, 8, 0.25);
      border-color: #eab308;
      color: #fde047;
    }
    .nuss-pro-btn-mark-b.is-active {
      background: rgba(249, 115, 22, 0.25);
      border-color: #f97316;
      color: #fdba74;
    }
    .nuss-pro-btn-ab-loop.is-active {
      background: linear-gradient(135deg, rgba(234, 179, 8, 0.35), rgba(249, 115, 22, 0.35));
      border-color: #f59e0b;
      color: #fef08a;
    }
    .nuss-pro-btn-trim-export {
      background: linear-gradient(135deg, #0284c7, #0369a1);
      border-color: #38bdf8;
      color: #fff;
    }
    .nuss-pro-btn-trim-export:hover {
      filter: brightness(1.2);
    }
    .nuss-pro-btn-trim-export.is-recording {
      background: #dc2626 !important;
      border-color: #f87171 !important;
      color: #fff !important;
      animation: nuss-pulse 1s infinite alternate;
    }
    .nuss-btn-lock-sync.is-active {
      background: rgba(14, 165, 233, 0.3) !important;
      border-color: #38bdf8 !important;
      color: #7dd3fc !important;
    }
    .nuss-btn-vault.is-active {
      background: rgba(234, 179, 8, 0.25) !important;
      border-color: #eab308 !important;
      color: #fde047 !important;
    }
    .nuss-ctrl-btn.nuss-btn-sync-all.is-active {
      background: linear-gradient(135deg, #0284c7, #0ea5e9);
      border-color: #38bdf8;
      color: #fff;
    }
    .nuss-ctrl-btn.nuss-btn-sync-all.is-partial {
      border-color: #38bdf8;
      color: #7dd3fc;
    }
    .nuss-ctrl-btn.nuss-btn-vault-all {
      background: linear-gradient(135deg, #b45309, #d97706);
      border-color: #f59e0b;
      color: #fff;
    }
    .nuss-ctrl-btn.nuss-btn-vault-all:hover {
      filter: brightness(1.15);
    }
    @keyframes nuss-pulse {
      0% { opacity: 0.8; transform: scale(0.98); }
      100% { opacity: 1; transform: scale(1.02); }
    }

    /* Diagnostický HUD */
    .nuss-diag-hud {
      position: absolute;
      bottom: 58px;
      left: 8px;
      right: 8px;
      background: rgba(8, 12, 22, 0.92);
      border: 1px solid rgba(16, 185, 129, 0.5);
      border-radius: 6px;
      padding: 6px 10px;
      font: 700 10.5px/1.35 Consolas, Monaco, monospace;
      color: #e2e8f0;
      z-index: 22;
      pointer-events: none;
      backdrop-filter: blur(8px);
      display: none;
      grid-template-columns: repeat(2, 1fr);
      gap: 2px 8px;
    }
    #nuss-overlay.show-diag .nuss-diag-hud {
      display: grid;
    }
    .nuss-diag-val { color: #34d399; }
    .nuss-diag-val.warn { color: #f59e0b; }
    .nuss-diag-val.bad { color: #ef4444; }

    /* Toast notifikácie */
    #nuss-toast {
      position: fixed;
      bottom: 30px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: rgba(15, 23, 42, 0.94);
      color: #f8fafc;
      border: 1px solid rgba(168, 85, 247, 0.6);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.8), 0 0 20px rgba(168, 85, 247, 0.4);
      padding: 10px 20px;
      border-radius: 10px;
      font: 700 13px system-ui, sans-serif;
      z-index: 2147483647;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease, transform 0.2s ease;
      backdrop-filter: blur(10px);
    }
    #nuss-toast.nuss-toast-show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
      pointer-events: auto;
    }
    .nuss-toast-badge {
      display: inline-block;
      background: linear-gradient(135deg, #a855f7, #7c3aed);
      color: #fff;
      font-size: 10px;
      font-weight: 800;
      padding: 2px 7px;
      border-radius: 4px;
      margin-right: 6px;
      vertical-align: middle;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .nuss-toast-link {
      color: #38bdf8;
      text-decoration: underline;
      font-weight: 700;
      margin-left: 6px;
      cursor: pointer;
    }
    .nuss-toast-link:hover {
      color: #7dd3fc;
    }
  `;

  // ---------------------------------------------------------------------------
  // 2. HELPER FUNKCIE & CDN PRECONNECT
  // ---------------------------------------------------------------------------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function parseSafeHeaders(rawHeaders) {
    const h = new Headers();
    for (const line of String(rawHeaders || '').split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim();
      const val = line.slice(colon + 1).trim();
      if (!name || name.startsWith(':')) continue;
      try { h.append(name, val); } catch {}
    }
    return h;
  }

  function gmFetch(url, options = {}) {
    // Keep the current login session for same-origin watch pages and signed
    // media endpoints. Cross-origin requests still use the userscript bridge.
    if (new URL(url, location.href).origin === location.origin &&
        (!GM_REQ || (!options.method || options.method === 'GET'))) {
      return fetch(url, { ...options, credentials: 'include' });
    }
    if (!GM_REQ) return fetch(url, options);
    return new Promise((resolve, reject) => {
      GM_REQ({
        method: options.method || 'GET',
        url: url,
        headers: options.headers || {},
        data: options.body,
        timeout: options.timeoutMs || 10000,
        onload: (res) => {
          resolve({
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            url: res.finalUrl || url,
            headers: parseSafeHeaders(res.responseHeaders),
            text: () => Promise.resolve(res.responseText),
            json: () => Promise.resolve(JSON.parse(res.responseText || '{}'))
          });
        },
        onerror: (err) => {
          fetch(url, options).then(resolve).catch(reject);
        },
        ontimeout: () => {
          fetch(url, options).then(resolve).catch(reject);
        }
      });
    });
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0 || isNaN(bytes)) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  function formatDuration(sec) {
    if (!sec || isNaN(sec) || !isFinite(sec)) return '0:00';
    const s = Math.floor(sec % 60);
    const m = Math.floor((sec / 60) % 60);
    const h = Math.floor(sec / 3600);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showToast(msg, isHtml = false) {
    let toast = document.getElementById('nuss-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'nuss-toast';
      document.body.appendChild(toast);
    }
    if (isHtml) {
      toast.innerHTML = msg;
    } else {
      toast.textContent = msg;
    }
    toast.className = 'nuss-toast-show';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.className = '';
    }, 3500);
  }

  // ---------------------------------------------------------------------------
  // 2b. NEXUS COLLECTOR VAULT INTAKE & SYNCHRO-SCRUB ENGINE
  // ---------------------------------------------------------------------------
  async function importCellsToNexus(cells) {
    if (!cells.length) { showToast(_t('⚠️ Žiadne aktívne videá na import.', '⚠️ No active videos to import.')); return false; }
    const candidates = cells.map(({ item, video }) => ({
      url: item.watchUrl || item.url,
      source_url: item.watchUrl || item.url,
      title: item.title || 'Video',
      thumbnail: item.poster || item.thumb || '',
      duration: Number.isFinite(video?.duration) ? video.duration : Number(item.duration) || 0,
      source: location.hostname,
      tags: [item.quality, item.type].filter(Boolean)
    }));
    showToast(`⏳ Zaraďujem ${candidates.length} videí na import…`);
    try {
      const response = await gmFetch(`http://localhost:${CONFIG.DEFAULT_NEXUS_PORT}/api/v1/intake/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ batch_name: `Split-Screen · ${location.hostname}`, candidates, source_mode: 'mixed' }), timeoutMs: 30000
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success || !data.job) {
        const detail = typeof data.detail === 'string' ? data.detail : `HTTP ${response.status}`;
        throw new Error(detail);
      }
      cells.forEach(c => { const button = c.element?.querySelector('[data-act="save-to-vault"]'); if (button) { button.classList.add('is-active'); button.textContent = '✓ Zaradené'; } });
      showToast(`✓ Na import zaradených ${data.job.total_items ?? candidates.length} videí · úloha #${data.job.id}.`);
      return true;
    } catch (error) {
      console.warn('[Nexus Split] Import zlyhal:', error);
      showToast(_t(`⚠️ Import zlyhal: ${error.message || 'spojenie s Nexusom zlyhalo'}. Skontroluj spojenie a prihlásenie.`, `⚠️ Import failed: ${error.message || 'connection to Nexus failed'}. Check connection and login.`));
      return false;
    }
  }

  async function saveItemToNexusVault(item, cellObj) {
    return importCellsToNexus([cellObj || { item }]);
  }

  async function saveAllActiveToNexusVault() {
    return importCellsToNexus(activeCells.slice());
  }

  function updateTopBarSyncAllButton() {
    const allLocked = activeCells.length > 0 && activeCells.every(c => c.syncLocked);
    const anyLocked = activeCells.some(c => c.syncLocked);
    const topBtn = overlayEl?.querySelector('[data-act="toggleSyncScrubAll"]');
    if (topBtn) {
      topBtn.classList.toggle('is-active', allLocked);
      topBtn.classList.toggle('is-partial', !allLocked && anyLocked);
      topBtn.textContent = allLocked ? '🔗 Synchro-Scrub [Zamknuté]' : '🔗 Synchro-Scrub [Všetky]';
    }
  }

  function toggleSyncScrubAll() {
    const allLocked = activeCells.length > 0 && activeCells.every(c => c.syncLocked);
    const newState = !allLocked;
    activeCells.forEach(c => {
      c.syncLocked = newState;
      const btn = c.element.querySelector('[data-act="toggle-lock-sync"]');
      if (btn) btn.classList.toggle('is-active', newState);
    });
    updateTopBarSyncAllButton();
    showToast(newState ? '🔗 Multi-Cam Synchro-Scrub: Všetky bunky uzamknuté!' : '🔓 Multi-Cam Synchro-Scrub: Všetky bunky odomknuté');
  }

  function syncScrubToPeers(sourceCell, targetTime) {
    const isSourcePaused = !!(sourceCell.video && sourceCell.video.paused);
    activeCells.forEach(peer => {
      if (peer === sourceCell || !peer.syncLocked || !peer.video) return;
      try {
        peer._inSyncScrub = true;
        if (peer.video.duration && isFinite(peer.video.duration)) {
          peer.video.currentTime = Math.max(0, Math.min(peer.video.duration, targetTime));
        } else {
          peer.video.currentTime = targetTime;
        }
        if (isSourcePaused && !peer.video.paused) {
          peer.video.pause();
        }
        if (typeof peer.updateProgress === 'function') {
          peer.updateProgress();
        }
      } catch (err) {
        console.warn('[Synchro-Scrub Error]', err);
      } finally {
        peer._inSyncScrub = false;
      }
    });
  }

  function injectPreconnect(url) {
    if (!url) return;
    try {
      const origin = new URL(url, location.href).origin;
      if (document.head.querySelector(`link[rel="preconnect"][href="${origin}"]`)) return;
      const pc = document.createElement('link');
      pc.rel = 'preconnect';
      pc.href = origin;
      pc.crossOrigin = 'anonymous';
      const pf = document.createElement('link');
      pf.rel = 'dns-prefetch';
      pf.href = origin;
      document.head.appendChild(pc);
      document.head.appendChild(pf);
    } catch {}
  }

  // Share each in-flight library request and allow a retry after a CDN failure.
  const libraryLoads = new Map();
  function loadExternalLibrary(key, url, getLibrary) {
    const loaded = getLibrary();
    if (loaded) return Promise.resolve(loaded);
    if (libraryLoads.has(key)) return libraryLoads.get(key);

    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    const request = new Promise((resolve, reject) => {
      script.onload = () => {
        const library = getLibrary();
        if (library) resolve(library);
        else reject(new Error(`Knižnica ${key} sa načítala bez očakávaného API.`));
      };
      script.onerror = () => reject(new Error(`Nepodarilo sa načítať knižnicu ${key}.`));
      document.head.appendChild(script);
    });
    const sharedRequest = request.catch(error => {
      if (libraryLoads.get(key) === sharedRequest) libraryLoads.delete(key);
      script.remove();
      throw error;
    });
    libraryLoads.set(key, sharedRequest);
    return sharedRequest;
  }

  function loadHlsLib() {
    return loadExternalLibrary('HLS.js', CONFIG.HLS_CDN, () => window.Hls);
  }

  function loadDashLib() {
    return loadExternalLibrary('DASH.js', CONFIG.DASH_CDN, () => window.dashjs);
  }

  function loadMp4BoxLib() {
    return loadExternalLibrary('MP4Box.js', CONFIG.MP4BOX_CDN, () => window.MP4Box);
  }

  function warmPlaybackEngines(items) {
    const video = document.createElement('video');
    const needsHlsJs = !video.canPlayType('application/vnd.apple.mpegurl') &&
      items.some(item => item.type === 'hls' || /\.m3u8(?:$|[?#])/i.test(item.url || ''));
    const needsDashJs = items.some(item => item.type === 'dash' || /\.mpd(?:$|[?#])/i.test(item.url || ''));

    if (needsHlsJs) {
      injectPreconnect(CONFIG.HLS_CDN);
      loadHlsLib().catch(error => console.warn('[Nexus Split] HLS warm-up:', error));
    }
    if (needsDashJs) {
      injectPreconnect(CONFIG.DASH_CDN);
      loadDashLib().catch(error => console.warn('[Nexus Split] DASH warm-up:', error));
    }
  }

  // ---------------------------------------------------------------------------
  // 3. PIXELDRAIN DETEKCIA & URL REWRITER
  // ---------------------------------------------------------------------------
  const PIXELDRAIN_FILE_REGEX = /(?:https?:\/\/)?(?:www\.)?pixeldrain\.com\/u\/([a-zA-Z0-9_-]+)/i;
  const PIXELDRAIN_API_REGEX = /(?:https?:\/\/)?(?:www\.)?pixeldrain\.com\/api\/file\/([a-zA-Z0-9_-]+)/i;
  const PIXELDRAIN_REL_U_REGEX = /^\/u\/([a-zA-Z0-9_-]+)/i;

  function getPixeldrainId(url) {
    if (!url) return null;
    const m1 = url.match(PIXELDRAIN_FILE_REGEX);
    if (m1) return m1[1];
    const m2 = url.match(PIXELDRAIN_API_REGEX);
    if (m2) return m2[1];
    const m3 = url.match(PIXELDRAIN_REL_U_REGEX);
    if (m3) return m3[1];
    return null;
  }

  function toPixeldrainDirectUrl(url) {
    const id = getPixeldrainId(url);
    return id ? `https://pixeldrain.com/api/file/${id}` : url;
  }

  // ---------------------------------------------------------------------------
  // 4. DETEKCIA PLATFORIEM & SITE ADAPTÉRY
  // ---------------------------------------------------------------------------
  function isBunkrOrTurbo(host) {
    return /(^|\.)(turbo\.cr|bunkr\.[a-z]+|bunkrr\.pics)$/i.test(host || location.hostname);
  }

  function turboVideoInfo(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      if (url.protocol !== 'https:' || url.hostname !== 'turbo.cr' || url.port || url.username || url.password) return null;
      const id = url.pathname.match(/^\/(?:v|d|embed)\/([A-Za-z0-9_-]{1,128})\/?$/)?.[1];
      return id ? { id, watchUrl: `https://turbo.cr/v/${id}` } : null;
    } catch {
      return null;
    }
  }

  function isPixeldrain(host) {
    return /(^|\.)pixeldrain\.com$/i.test(host || location.hostname);
  }

  function isXHamster(host) {
    return /(^|\.)xhamster\.(?:com|desi|one|pet|gold|xxx|th)$/i.test(host || location.hostname) || (host || location.hostname).includes('xhamster');
  }

  function isCamwhores(host) {
    return /(^|\.)camwhores\.tv$/i.test(host || location.hostname);
  }

  // Pixeldrain Cache pre zoznamy / albumy (/l/ID)
  let cachedPixeldrainList = null;
  let fetchingPixeldrainList = false;

  async function fetchPixeldrainListIfNeeded() {
    if (!isPixeldrain()) return null;
    const match = window.location.pathname.match(/\/l\/([a-zA-Z0-9_-]+)/i);
    if (!match) return null;
    const listId = match[1];

    if (cachedPixeldrainList && cachedPixeldrainList.id === listId) {
      return cachedPixeldrainList.files;
    }

    if (fetchingPixeldrainList) {
      while (fetchingPixeldrainList) await sleep(50);
      return cachedPixeldrainList?.files || null;
    }

    fetchingPixeldrainList = true;
    try {
      const res = await fetch(`/api/list/${listId}`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.files)) {
          cachedPixeldrainList = {
            id: listId,
            title: data.title || listId,
            files: data.files
          };
          updateFabCounter();
          return data.files;
        }
      }
    } catch (e) {
      console.warn('[Nexus Split] Chyba pri načítaní Pixeldrain API zoznamu:', e);
    } finally {
      fetchingPixeldrainList = false;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 5. UNIVERZÁLNY VIDEO CARD HARVESTER
  // ---------------------------------------------------------------------------

  // 5a. Bunkr / Turbo Harvester (turbo.cr, bunkr.cr, bunkr.sk, ...)
  function harvestBunkrTurboCards() {
    const results = [];
    const seenIds = new Set();
    const itemsById = new Map();

    // 1. Extrakcia zo zabudovaného FILES poľa v inline skriptoch
    for (const s of document.querySelectorAll('script')) {
      const text = s.textContent || '';
      if (text.includes('FILES =') || text.includes('const FILES') || text.includes('var FILES')) {
        const m = text.match(/(?:const|let|var)\s+FILES\s*=\s*(\[[\s\S]*?\])\s*;/);
        if (m) {
          try {
            const files = new Function('return ' + m[1])();
            if (Array.isArray(files)) {
              files.forEach((f) => {
                if (!f.id || seenIds.has(f.id)) return;
                seenIds.add(f.id);
                const watchUrl = `https://${location.hostname}/v/${f.id}`;
                const item = {
                  id: f.id,
                  title: f.name || `Video ${f.id}`,
                  size: f.size || 0,
                  poster: f.thumb ? f.thumb.replace(/\\\//g, '/') : '',
                  duration: f.dur || 0,
                  watchUrl,
                  url: watchUrl,
                  type: 'bunkr_turbo',
                  isResolved: false
                };
                results.push(item);
                itemsById.set(String(f.id), item);
              });
            }
          } catch (e) {
            console.warn('[Nexus Split] Chyba parsovania Bunkr FILES:', e);
          }
        }
      }
    }

    // 2. DOM skenovanie .tile, .grid-item, .theItem, tr[data-id]
    document.querySelectorAll('.tile[data-id], .grid-item, .theItem, .file-card, tr[data-id], .bah-card, a[href*="/v/"], a[href*="/f/"]').forEach((node) => {
      if (node.closest('#nuss-picker-modal, #nuss-overlay')) return;
      const el = node.closest('.bah-card, .theItem, .grid-item, .file-card') || node;
      const link = el.matches('a[href*="/v/"], a[href*="/f/"], a[href*="/d/"]') ? el : el.querySelector('a[href*="/v/"], a[href*="/f/"], a[href*="/d/"]');
      const id = (link?.href.match(/\/[vfd]\/([a-zA-Z0-9_-]+)/)?.[1]) || el.dataset?.id;
      if (!id) return;
      const existing = itemsById.get(String(id));
      const img = el.querySelector('img.bah-main-thumb') || el.querySelector('.bah-stage img, .grid-images_box-img') || el.querySelector('img:not([src^="data:"]):not([src$=".svg"])');
      const poster = img?.currentSrc || img?.getAttribute('data-src') || img?.getAttribute('data-original') || img?.src || '';
      const isSelectedOnPage = el.classList.contains('bah-selected') || el.classList.contains('nexus-bunkr-item-selected') || !!el.querySelector('.bah-cb:checked, .nexus-bunkr-checkbox:checked');
      if (existing) {
        if (poster && !poster.startsWith('data:')) existing.poster = poster;
        existing.isSelectedOnPage = existing.isSelectedOnPage || isSelectedOnPage;
        return;
      }
      seenIds.add(id);

      const nameEl = el.querySelector('.bah-caption, .theName, .bah-native-title, .text-\\[13px\\], .name, .title, .truncate');
      const title = el.getAttribute('title') || nameEl?.getAttribute('title') || nameEl?.textContent?.trim() || `Video ${id}`;
      const durEl = el.querySelector('.dur, .duration, [class*="dur"]');
      const watchUrl = (link?.href && /\/[vf]\//i.test(link.href)) ? new URL(link.href, location.origin).href : `https://${location.hostname}/f/${id}`;

      const item = {
        id,
        title,
        size: 0,
        poster,
        durationStr: durEl?.innerText.trim() || '',
        watchUrl,
        url: watchUrl,
        type: 'bunkr_turbo',
        isResolved: false,
        isSelectedOnPage
      };
      results.push(item);
      itemsById.set(String(id), item);
    });

    if (window.NexusBunkrFastStart && typeof window.NexusBunkrFastStart.prewarmBatch === 'function') {
      window.NexusBunkrFastStart.prewarmBatch(results.slice(0, 10));
    }

    return results;
  }

  // 5b. Pixeldrain Harvester (albumy & karty)
  function harvestPixeldrainCards() {
    const results = [];
    const seenUrls = new Set();

    if (cachedPixeldrainList && Array.isArray(cachedPixeldrainList.files)) {
      const selectedOnPageNames = new Set();
      document.querySelectorAll('.gallery > .file, .pd-card').forEach((card) => {
        const isSel = card.classList.contains('pd-selected') || card.querySelector('input[type="checkbox"]:checked');
        if (isSel) {
          const name = card.querySelector('.pd-title')?.innerText.trim() || card.querySelector('.name')?.innerText.trim();
          if (name) selectedOnPageNames.add(name);
        }
      });

      cachedPixeldrainList.files.forEach((f) => {
        const isVideo = f.mime_type?.startsWith('video/') || /\.(mp4|m4v|webm|mkv|mov|avi|ts|flv)$/i.test(f.name);
        if (!isVideo && f.mime_type && !f.mime_type.startsWith('video/')) return;

        const isSelected = selectedOnPageNames.has(f.name);
        const directUrl = `https://pixeldrain.com/api/file/${f.id}`;
        const poster = `https://pixeldrain.com/api/file/${f.id}/thumbnail?width=256&height=256`;
        seenUrls.add(directUrl);
        results.push({
          url: directUrl,
          rawUrl: `https://pixeldrain.com/u/${f.id}`,
          title: f.name,
          size: f.size,
          poster,
          type: 'pixeldrain',
          id: f.id,
          isResolved: true,
          isSelectedOnPage: isSelected
        });
      });
    }

    // Samostatné video /u/ID
    const pageId = getPixeldrainId(window.location.href);
    if (pageId && !window.location.pathname.startsWith('/l/')) {
      const directUrl = `https://pixeldrain.com/api/file/${pageId}`;
      if (!seenUrls.has(directUrl)) {
        seenUrls.add(directUrl);
        results.push({
          url: directUrl,
          rawUrl: window.location.href,
          title: document.title.replace(' - Pixeldrain', '').trim() || `Pixeldrain Video #${pageId}`,
          poster: `https://pixeldrain.com/api/file/${pageId}/thumbnail?width=256&height=256`,
          type: 'pixeldrain',
          id: pageId,
          isResolved: true
        });
      }
    }

    // DOM záložný sken
    document.querySelectorAll('.gallery .file, .file[data-id], .gallery > a, a[href*="/u/"]').forEach((el) => {
      const link = el.tagName === 'A' ? el : el.querySelector('a[href*="/u/"]');
      const href = link ? link.href : el.getAttribute('href') || el.getAttribute('data-href') || '';
      const id = getPixeldrainId(href) || el.dataset?.id || el.getAttribute('data-id');
      if (id) {
        const directUrl = `https://pixeldrain.com/api/file/${id}`;
        if (!seenUrls.has(directUrl)) {
          seenUrls.add(directUrl);
          const nameEl = el.querySelector('.pd-title') || el.querySelector('.name') || el.querySelector('.title');
          results.push({
            url: directUrl,
            rawUrl: href,
            title: nameEl?.innerText.trim() || el.getAttribute('title') || `Pixeldrain Video #${id}`,
            poster: `https://pixeldrain.com/api/file/${id}/thumbnail?width=256&height=256`,
            type: 'pixeldrain',
            id,
            isResolved: true
          });
        }
      }
    });

    return results;
  }

  // 5c. Špecializovaný Harvester pre xHamster (využíva window.initials alebo presné DOM selektory)
  function harvestXHamsterCards() {
    const results = [];
    const seen = new Set();

    // A. Extrakcia priamo z xHamster initials JSON dát (najvyššia kvalita a presnosť bez skeletonov)
    try {
      let initialsData = null;
      if (typeof window !== 'undefined' && window.initials) {
        initialsData = window.initials;
      } else if (typeof unsafeWindow !== 'undefined' && unsafeWindow.initials) {
        initialsData = unsafeWindow.initials;
      } else {
        const scriptEl = document.getElementById('initials-script') || document.querySelector('script[id*="initials"]');
        if (scriptEl && scriptEl.textContent) {
          const body = scriptEl.textContent.trim().replace(/^window\.initials\s*=\s*/, '').replace(/;\s*$/, '');
          initialsData = JSON.parse(body);
        }
      }

      if (initialsData) {
        const out = [];
        const collectVideos = (node) => {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) {
            for (const item of node) {
              if (item && typeof item === 'object' && item.pageURL && !item.isPaid && !item.paid && !item.isPremium) {
                const rawUrl = String(item.pageURL || '');
                if (!/faphouse\.com|\/fh\/out\b/i.test(rawUrl) && !/^(?:paid|premium|gold)$/i.test(String(item.accessType || item.icon || item.badge || item.badgeProps?.text || ''))) {
                  if (/\/videos\//i.test(item.pageURL) && (item.thumbURL || item.imageURL)) {
                    out.push(item);
                  }
                }
              } else {
                collectVideos(item);
              }
            }
            return;
          }
          for (const val of Object.values(node)) {
            collectVideos(val);
          }
        };

        collectVideos(initialsData);

        for (const v of out) {
          const page = new URL(v.pageURL, location.origin).href;
          if (seen.has(page)) continue;
          seen.add(page);

          const dur = Number(v.duration) || 0;
          results.push({
            url: page,
            watchUrl: page,
            title: String(v.title || 'xHamster Video').trim(),
            poster: v.thumbURL || v.imageURL || '',
            duration: dur,
            durationStr: dur ? formatDuration(dur) : '',
            views: Number(v.views) || 0,
            quality: 'HD',
            type: 'xhamster',
            isResolved: false
          });
        }
      }
    } catch (e) {
      console.warn('[Nexus Split] xHamster initials parser error:', e);
    }

    // B. DOM Harvester pre xHamster (ak initials chýbajú alebo pre dodatočné karty)
    const cardSelectors = '.thumb-list__item, .video-thumb, [data-role="thumb-list-block"] > div';
    document.querySelectorAll(cardSelectors).forEach((card) => {
      if (card.closest('#nuss-overlay, #nuss-picker-modal, #nvs-workbench-launch, #nvs-sort-panel')) return;

      const link = card.querySelector('a.video-thumb__image-container, a.video-thumb-info__name, a[href*="/videos/"]') || card.querySelector('a[href]');
      if (!link || !link.href || !/\/videos\//i.test(link.href)) return;
      const href = new URL(link.href, location.origin).href;
      if (seen.has(href)) return;

      // Ignoruj platené a sponzorované faphouse karty
      if (card.querySelector('a[href*="faphouse.com"], a[href*="/fh/out"]')) return;
      const cardText = card.textContent || '';
      if (/\b(?:paid|premium)\b/i.test(cardText) && !/\b(?:hd|4k|1080p)\b/i.test(cardText)) {
        const isPaid = Array.from(card.querySelectorAll('span, div, i, b, em, strong')).some(el => {
          return el.childElementCount <= 2 && /^(?:paid|premium)$/i.test(el.textContent.trim());
        });
        if (isPaid) return;
      }

      const img = card.querySelector('img');
      let poster = img?.getAttribute('data-src') ||
                   img?.getAttribute('data-thumb') ||
                   img?.getAttribute('data-webp') ||
                   img?.getAttribute('data-original') ||
                   img?.getAttribute('data-lazy-src') ||
                   img?.getAttribute('srcset')?.split(' ')?.[0] ||
                   (img?.src && !img.src.startsWith('data:') ? img.src : '') ||
                   '';

      if (!poster) {
        const bgEl = card.querySelector('.thumb-image-container__image, [style*="background-image"], .thumb-image');
        if (bgEl) {
          const bgStyle = bgEl.style.backgroundImage || (typeof window !== 'undefined' ? window.getComputedStyle(bgEl).backgroundImage : '');
          const bgMatch = bgStyle.match(/url\(['"]?([^'"()]+)['"]?\)/);
          if (bgMatch && !bgMatch[1].startsWith('data:')) {
            poster = bgMatch[1];
          }
        }
      }

      const titleEl = card.querySelector('.video-thumb-info__name, .video-thumb__name, [data-role="video-title"]') ||
                      card.querySelector('a[title]:not([title*="Nexus"]):not([title*="import"])');
      let title = titleEl?.getAttribute('title') || titleEl?.textContent?.trim() || img?.alt || '';
      if (!title || /Vybrať pre import|Nexus|Import do/i.test(title)) {
        const slug = link.pathname.match(/\/videos\/([^/?#]+)/)?.[1];
        if (slug) {
          title = slug.replace(/-xh[a-zA-Z0-9]+$/i, '').replace(/[-_]+/g, ' ');
          title = title.charAt(0).toUpperCase() + title.slice(1);
        } else {
          title = 'xHamster Video';
        }
      }

      const durText = card.querySelector('.tiny-fda7e, [data-role="video-duration"]')?.textContent?.trim() ||
                      card.innerText.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/)?.[0] || '';

      seen.add(href);
      results.push({
        url: href,
        watchUrl: href,
        title: title.slice(0, 110),
        poster,
        durationStr: durText,
        quality: 'HD',
        type: 'xhamster',
        isResolved: false
      });
    });


    return results;
  }

  // 5d. Všeobecný heuristický Card Harvester (Eporner, XVideos, Pimpbunny a iné stránky)
  function sharedCard(item) {
    const element=item.element;
    if(element?.isConnected)return element.closest('[data-nvs-processed]') || element;
    const key=item.watchUrl || item.url;
    return [...document.querySelectorAll('[data-nvs-processed]')].find(n=>n.dataset.nvsUrl===key || [...n.querySelectorAll('a[href]')].some(a=>a.href===key));
  }
  function sharedDuration(value) {
    if(typeof value==='number')return Number.isFinite(value)?value:0;
    const time=String(value||'').match(/\b\d{1,3}:\d{2}(?::\d{2})?\b/)?.[0];
    if(time)return time.split(':').reduce((sum,n)=>sum*60+Number(n),0);
    return /^\d+(?:\.\d+)?$/.test(String(value||''))?Number(value):0;
  }
  function hydrateSharedMetadata(item) {
    const card=sharedCard(item);if(!card)return false;
    let meta={};try{meta=JSON.parse(card.dataset.nexusVideoMeta||'{}');}catch{}
    const badge=card.querySelector('.nvs-main-badge,.nvs-badge:not(.nvs-badge-quality):not(.nvs-source-badge)')?.textContent || '';
    const sizeText=meta.sizeText || badge;
    const match=sizeText.match(/(~|≈)?\s*(\d+(?:[.,]\d+)?)\s*(GiB|MiB|GB|MB|KB)\b/i);
    const bytes=Number(meta.sizeBytes)>0?Number(meta.sizeBytes):Number(meta.sizeMb)>0?Number(meta.sizeMb)*1024**2:match?Number(match[2].replace(',','.'))*({GB:1024**3,GIB:1024**3,MB:1024**2,MIB:1024**2,KB:1024}[match[3].toUpperCase()]):0;
    if(bytes>0){item.size=bytes;item.sizeEstimated=Boolean(meta.sizeEstimated || match?.[1] || /^\s*[~≈]/.test(sizeText));}
    const quality=meta.quality || card.querySelector('.nvs-badge-quality')?.textContent?.trim();
    if(quality)item.quality=quality;
    const duration=sharedDuration(meta.duration) || sharedDuration(card.querySelector('.nvs-duration-badge,[class*="duration"],.duration,.time')?.textContent) || sharedDuration(item.durationStr);
    if(duration>0){item.duration=duration;item.durationStr=formatDuration(duration);}
    if(meta.width && meta.height)item.resolution=`${meta.width}x${meta.height}`;
    if(meta.date)item.uploadDate=meta.date;
    item.element=card;
    item.isSelectedOnPage=card.classList.contains('nvs-card-selected') || card.classList.contains('nuss-page-selected') || !!card.querySelector('.nvs-checkbox[aria-checked="true"],.nvs-selector-wrap input:checked');
    item.hasFullMeta=Boolean(item.size>0 && item.duration>0 && item.quality);
    return Boolean(bytes || quality || duration);
  }

  function harvestGenericVideoCards() {
    const results = [];
    const seenUrls = new Set();

    // Turbo thread embeds are registered by the Selector on small wrapper
    // cards. Use their canonical watch URL so playback can resolve a direct
    // stream instead of trying to load the forum post or the embed as a file.
    document.querySelectorAll('[data-nvs-processed="1"][data-nvs-url]').forEach((card) => {
      const turbo = turboVideoInfo(card.dataset.nvsUrl);
      if (!turbo || seenUrls.has(turbo.watchUrl)) return;
      seenUrls.add(turbo.watchUrl);
      const item = {
        id: turbo.id,
        url: turbo.watchUrl,
        watchUrl: turbo.watchUrl,
        title: `Turbo video ${turbo.id}`,
        poster: '',
        type: 'bunkr_turbo',
        isResolved: false,
        element: card
      };
      hydrateSharedMetadata(item);
      results.push(item);
    });

    const cardSelectors = [
      '.thumb-block', '.video-thumb', '.video-snippet', '[data-video-id]',
      '.mb', '.mbvid', '.video-item', '.b6m-video',
      '.video-card', '.card', '.tile', '.thumb-list__item',
      'article', '.item', '.grid-item'
    ].join(', ');
    const camwhoresSite = isCamwhores();
    const coomerfansSite = /(^|\.)coomerfans\.com$/i.test(location.hostname);
    const camwhoresWatchPath = /^\/videos\/\d+(?:\/|$)/i;

    // Discover by structure too: many galleries use bare anchors with a CSS
    // background thumbnail (including video posts), without any card class.
    const candidates = new Set([...document.querySelectorAll('[data-nvs-processed]'),...document.querySelectorAll(cardSelectors)]);
    document.querySelectorAll('a[href]').forEach((anchor) => {
      if (anchor.matches('[style*="background"], [data-poster], [data-thumb]') ||
          anchor.querySelector('img, video, [style*="background"], [data-poster], [data-thumb]') ||
          /(?:^|[\s_-])video(?:$|[\s_-])/i.test(anchor.className)) {
        candidates.add(anchor);
      }
    });
    if (coomerfansSite) document.querySelectorAll('a[href*="/p/"]').forEach(a => candidates.add(a.closest('article, .card, .item') || a));
    const watchPath = /\/(?:videos?|watch|clip|media|view|detail|hd-porn)\b/i;
    const mediaPath = /\.(?:mp4|m4v|webm|m3u8|mpd)$/i;
    const validLink = (anchor) => {
      try {
        const url = new URL(anchor.getAttribute('href'), location.href);
        return /^https?:$/.test(url.protocol) && !!anchor.getAttribute('href') &&
          !anchor.getAttribute('href').startsWith('#') && url.href !== location.href;
      } catch { return false; }
    };

    // Ignoruj výsledky vo vnútri Quantum Search overlayu pri všeobecnom skene stránky
    candidates.forEach((card) => {
      if (card.closest('#nuss-overlay, #nuss-picker-modal, #nvs-workbench-launch, #nvs-sort-panel, #quantumSearchOverlay')) return;

      const testerStream = card.matches('.card[data-nexus-split-stream]') && card.dataset.nexusSplitStream;
      const testerIframe = card.matches('.card[data-nexus-split-iframe]') && card.dataset.nexusSplitIframe;
      const testerSource = testerStream || testerIframe;
      if (testerSource) {
        try {
          const directUrl = new URL(testerSource, location.href);
          const watchUrl = new URL(card.dataset.nexusSplitWatch, location.href);
          if (/^https?:$/.test(directUrl.protocol) && /^https?:$/.test(watchUrl.protocol)) {
            if (seenUrls.has(watchUrl.href)) return;
            seenUrls.add(watchUrl.href);
            const requestedFormat = card.dataset.nexusSplitFormat;
            const type = ['hls', 'dash', 'mp4', 'direct', 'iframe'].includes(requestedFormat)
              ? requestedFormat
              : detectFormat(directUrl.href);
            const item = {
              url: watchUrl.href,
              watchUrl: watchUrl.href,
              directUrl: directUrl.href,
              title: card.querySelector('h3')?.textContent?.trim() || 'Tester video',
              poster: card.querySelector('.thumb img')?.src || '',
              type,
              isResolved: true,
              isIframe: Boolean(testerIframe),
              element: card
            };
            hydrateSharedMetadata(item);
            results.push(item);
            return;
          }
        } catch (error) {
          console.warn('[Nexus Split] Invalid Tester playback source:', error);
        }
      }

      const links = (card.tagName === 'A' ? [card] : Array.from(card.querySelectorAll('a[href]'))).filter(validLink);
      // Never collapse an entire gallery into a single card.
      const mediaLinks = links.filter(a => camwhoresSite
        ? camwhoresWatchPath.test(a.pathname)
        : watchPath.test(a.pathname) || mediaPath.test(a.pathname) || /\/posts?\/[^/]+\/?$/i.test(a.pathname) || (coomerfansSite && /\/p\//i.test(a.pathname)));
      if (new Set(mediaLinks.map(a => a.href)).size > 1) return;
      const link = mediaLinks[0] || links.find(a => a.querySelector('img, video, [style*="background"]')) || links[0];
      if (!link || !link.href) return;
      const href = link.href;
      if (seenUrls.has(href)) return;

      const isWatchLink = camwhoresSite
        ? camwhoresWatchPath.test(link.pathname)
        : watchPath.test(link.pathname) || mediaPath.test(link.pathname);
      const img = card.querySelector('img:not([src*="svg"]):not([src*="data:image/svg"])') || card.querySelector('img');
      const text = (card.innerText || card.textContent || '')
        .replace(/\b\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?\b/g, '')
        .replace(/\b\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?\b/g, '');
      // A timestamp such as 14:30 alone is not evidence of a video.
      const durText = text.match(/\b\d{1,3}:\d{2}:\d{2}\b|\b\d{1,3}:\d{2}\b/)?.[0] || '';
      const hasHd = /\b(HD|4K|2160p|1080p|720p|480p)\b|\b\d{3,4}\s*[x×]\s*\d{3,4}\b/i.test(text);
      const hasVideoMarker = !!card.querySelector('video') ||
        /(?:^|[\s_-])video(?:$|[\s_-])/i.test(`${card.className} ${link.className}`);
      const hasVisual = !!img || card.matches('[style*="background"], [data-poster], [data-thumb]') ||
        !!card.querySelector('video, [style*="background"], [data-poster], [data-thumb]');

      const coomerPostVideo = coomerfansSite && /\/p\//i.test(link.pathname) && !!card.querySelector('video, [class*="video" i], [class*="play" i]');
      const looksLikeVideo = isWatchLink || coomerPostVideo ||
        (hasVisual && (hasVideoMarker || hasHd || (durText && (img || /\b\d+(?:[.,]\d+)?\s*(?:MB|GB|MiB|GiB)\b/i.test(text)))));
      if (camwhoresSite ? camwhoresWatchPath.test(link.pathname) : looksLikeVideo) {
        seenUrls.add(href);

        // Inteligentné nájdenie názvu videa (vyhýba sa tlačidlám rozšírení ako 'Vybrať pre import do Nexus')
        const titleCandidates = [
          card.querySelector('.video-thumb-info__name, .video-thumb__name, [data-qa*="title"], .video-title, .title, .name'),
          card.querySelector('h2, h3, h4, h5'),
          card.querySelector('a[title]:not([title*="Nexus"]):not([title*="import"]):not([title*="Import"])'),
          img?.getAttribute('alt')
        ];

        let title = '';
        for (const el of titleCandidates) {
          if (!el) continue;
          const candidate = (typeof el === 'string' ? el : el.getAttribute('title') || el.textContent || '').trim();
          if (candidate && !/Vybrať pre import|Nexus|Import do|nvs-/i.test(candidate) && candidate.length > 2) {
            title = candidate;
            break;
          }
        }

        if (!title) {
          try {
            const m = link.pathname.match(/\/(?:videos?|watch|clip)\/([^/?#]+)/i);
            if (m && m[1]) {
              title = decodeURIComponent(m[1]).replace(/[-_]+/g, ' ').slice(0, 80);
              title = title.charAt(0).toUpperCase() + title.slice(1);
            }
          } catch {}
        }
        if (!title) title = 'Video';

        // Inteligentná extrakcia náhľadu (data-src, data-thumb, background-image)
        let poster = '';
        if (img) {
          poster = img.getAttribute('data-src') ||
                   img.getAttribute('data-thumb') ||
                   img.getAttribute('data-webp') ||
                   img.getAttribute('data-original') ||
                   img.getAttribute('data-lazy-src') ||
                   img.getAttribute('data-poster') ||
                   img.getAttribute('srcset')?.split(' ')?.[0] ||
                   (img.src && !img.src.startsWith('data:image') ? img.src : '') ||
                   '';
        }
        if (!poster) {
          const bgEl = card.matches('[style*="background"], [data-poster], [data-thumb]') ? card :
            card.querySelector('[style*="background"], [data-poster], [data-thumb], .thumb, .preview, .poster');
          if (bgEl) {
            const bgStyle = bgEl.style.backgroundImage || window.getComputedStyle(bgEl).backgroundImage;
            const bgMatch = bgStyle.match(/url\(['"]?([^'"()]+)['"]?\)/);
            if (bgMatch && !bgMatch[1].startsWith('data:image')) {
              poster = bgMatch[1];
            }
            poster = bgEl.getAttribute('data-poster') || bgEl.getAttribute('data-thumb') || poster;
          }
        }
        if (poster) {
          try { poster = new URL(poster, location.href).href; } catch { poster = ''; }
        }

        const item = {
          url: href,
          watchUrl: href,
          title: title.slice(0, 110),
          poster,
          durationStr: durText,
          type: 'generic_watch',
          isResolved: false, element:card
        };
        hydrateSharedMetadata(item);results.push(item);
      }
    });

    return results;
  }

  // ---------------------------------------------------------------------------
  // 6. ON-DEMAND STREAM RESOLVER (Okamžité zistenie priameho streamu z karty)
  // ---------------------------------------------------------------------------
  function extractVideoPageSource(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const usableUrl = value => {
      if (!value) return '';
      try {
        const url = new URL(value.replace(/\\\//g, '/').replace(/\\u0026/g, '&'), baseUrl);
        if (!/^https?:$/.test(url.protocol) || /\.(?:mp3|wav|ogg|m4a|aac)(?:$|[?#])/i.test(url.href)) return '';
        return url.href;
      } catch { return ''; }
    };
    // Scope <source> to <video>: global sources also include chat/notification audio.
    const players = doc.querySelectorAll('video, [data-src][data-id^="video-"], [data-src][data-type="video"], [data-src][data-poster], [data-video-src]');
    for (const player of players) {
      const sources = player.tagName === 'VIDEO' ? [player, ...player.querySelectorAll('source')] : [player];
      for (const source of sources) {
        const mime = source.getAttribute('type') || '';
        if (/^audio\//i.test(mime)) continue;
        const url = usableUrl(source.getAttribute('src') || source.getAttribute('data-video-src') || source.getAttribute('data-src'));
        if (!url) continue;
        return {
          url,
          poster: usableUrl(player.getAttribute('poster') || player.getAttribute('data-poster')),
          duration: Number(player.getAttribute('data-length') || player.getAttribute('data-duration')) || 0,
          type: /mpegurl/i.test(mime) ? 'hls' : /dash\+xml/i.test(mime) ? 'dash' :
            (/^video\/mp4/i.test(mime) ? 'mp4' : detectFormat(url))
        };
      }
    }
    for (const meta of doc.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]')) {
      const url = usableUrl(meta.getAttribute('content'));
      // OG may point at an HTML embed, which must not be fed into <video>.
      if (url && /\.(?:mp4|m4v|webm|m3u8|mpd)(?:$|[?#])/i.test(url)) return { url, type: detectFormat(url) };
    }
    // Preserve structured-data support, scoped to VideoObject rather than
    // arbitrary contentUrl values from images, ads or page audio.
    const findVideo = node => {
      if (!node || typeof node !== 'object') return null;
      const types = [].concat(node['@type'] || []);
      if (types.includes('VideoObject')) {
        const url = usableUrl(node.contentUrl);
        if (url) return { url, type: detectFormat(url) };
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') {
          const found = findVideo(value);
          if (found) return found;
        }
      }
      return null;
    };
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const found = findVideo(JSON.parse(script.textContent));
        if (found) return found;
      } catch {}
    }
    return null;
  }

  function normalizeCamwhoresStreamUrl(rawUrl, baseUrl) {
    if (!rawUrl) return '';
    const value = String(rawUrl)
      .replace(/&amp%3[Bb]/g, '&')
      .replace(/\\\//g, '/')
      .replace(/\\u0026/gi, '&')
      .replace(/&amp;/gi, '&');
    try {
      const url = new URL(value, baseUrl);
      if (!/^https?:$/.test(url.protocol) ||
          (!/\/get_file\//i.test(url.pathname) && !/\.(?:mp4|m4v|webm|m3u8|mpd)(?:$|[?#])/i.test(url.href))) {
        return '';
      }
      if (isCamwhores(url.hostname) && /\/get_file\//i.test(url.pathname)) {
        url.searchParams.delete('rnd');
        url.searchParams.set('rnd', String(Date.now()));
      }
      return url.href;
    } catch {
      return '';
    }
  }

  function extractCamwhoresVideoSource(html, baseUrl) {
    const patterns = [
      /html5player\.setVideoHLS\s*\(\s*['"]([^'"]+)['"]/i,
      /html5player\.setVideoUrlHigh\s*\(\s*['"]([^'"]+)['"]/i,
      /(?:video_url|video_alt_url\d*)\s*[:=]\s*['"]([^'"]+)['"]/i,
      /["']file["']\s*:\s*["']([^"']+)["']/i,
      /https?:\\?\/\\?\/[^"'\\\s<>]*\/get_file\/[^"'\\\s<>]+/i
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      const url = normalizeCamwhoresStreamUrl(match && (match[1] || match[0]), baseUrl);
      if (url) return { url, type: detectFormat(url) };
    }
    return null;
  }

  const bunkrPending = new Map(), bunkrDirectCache = new Map();
  function bunkrKey(url) {
    const u = new URL(url, location.href);
    return u.pathname.match(/\/[vfd]\/([^/]+)/)?.[1]?.replace(/\.(mp4|mkv|mov|webm|m4v|avi|ts)$/i, '') || '';
  }
  async function resolveBunkrDirect(watchUrl, { force = false } = {}) {
    const id = bunkrKey(watchUrl);
    if (!id) return null;
    const cached = bunkrDirectCache.get(id);
    if (force) bunkrDirectCache.delete(id);
    if (!force && cached && cached.until > Date.now()) return cached.url;
    const pendingKey = force ? id + ':fresh' : id;
    if (bunkrPending.has(pendingKey)) return bunkrPending.get(pendingKey);
    const task = (async () => {
      // Share Helper's cache and in-flight requests across userscript sandboxes.
      // A forced refresh bypasses Helper's independent cache as well.
      if (!force && document.documentElement.dataset.nexusBunkrResolver === 'ready') {
        const response = await new Promise(resolve => {
          const requestId = 'nuss-' + Math.random().toString(36).slice(2);
          const finish = value => { clearTimeout(timer); document.removeEventListener('nexus-bunkr-resolved', receive); resolve(value); };
          const receive = e => { try { const data = JSON.parse(e.detail); if (data.requestId === requestId) finish(data.url || null); } catch {} };
          const timer = setTimeout(() => finish(null), 600);
          document.addEventListener('nexus-bunkr-resolved', receive);
          document.dispatchEvent(new CustomEvent('nexus-bunkr-resolve', { detail: JSON.stringify({ requestId, url: watchUrl }) }));
        });
        if (response) return response;
      }
      const origin = new URL(watchUrl, location.href).origin;
      const res = await gmFetch(origin + '/api/vs', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ slug: id }),
        ...(force ? { timeoutMs: 2000, signal: AbortSignal.timeout(2000) } : {})
      });
      if (res && res.ok) {
        try {
          const data = await res.json();
          let raw = data.url || '';
          if (data.encrypted) {
            const bytes = atob(raw), key = 'SECRET_KEY_' + Math.floor(Number(data.timestamp) / 3600);
            raw = Array.from(bytes, (c, i) => String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))).join('');
          }
          if (raw) {
            const url = new URL(raw.replace(/\\\//g, '/').replace(/\\u0026/g, '&'), origin);
            if (/^https?:$/.test(url.protocol) && /\.(mp4|m4v|mkv|mov|webm|m3u8)(?:$|[?#])/i.test(url.href)) return url.href;
          }
        } catch {}
      }
      const candidatePages = Array.from(new Set([
        new URL(watchUrl, location.href).href,
        `${origin}/f/${id}`,
        `${origin}/v/${id}`
      ]));
      for (const pageUrl of candidatePages) {
        try {
          const pageRes = await gmFetch(pageUrl, {
            headers: { Accept: 'text/html,application/xhtml+xml,*/*', Referer: origin + '/' },
            timeoutMs: 6000
          });
          if (!pageRes || !pageRes.ok || typeof pageRes.text !== 'function') continue;
          const html = await pageRes.text();
          if (!html) continue;
          const cdnMatch = html.match(/var\s+jsCDN\s*=\s*["']([^"']+)["']/i)
            || html.match(/jsCDN\s*[:=]\s*["']([^"']+)["']/i);
          const signMatch = html.match(/var\s+signUrl\s*=\s*["']([^"']+)["']/i)
            || html.match(/signUrl\s*[:=]\s*["']([^"']+)["']/i);
          if (cdnMatch && cdnMatch[1]) {
            const rawCdn = cdnMatch[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
            const cdnUrl = new URL(rawCdn, origin);
            const rawSign = (signMatch && signMatch[1])
              ? signMatch[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&')
              : 'https://glb-apisign.cdn.cr/sign';
            if (rawSign) {
              const signEndpoint = new URL(rawSign, origin);
              signEndpoint.searchParams.set('path', decodeURIComponent(cdnUrl.pathname));
              let signData = null;
              if (typeof fetch === 'function') {
                try {
                  const fastSign = await fetch(signEndpoint.href, {
                    credentials: 'omit',
                    headers: { Accept: 'application/json, text/plain, */*' }
                  });
                  if (fastSign && fastSign.ok) signData = await fastSign.json();
                } catch {}
              }
              if (!signData || !signData.token) {
                const signRes = await gmFetch(signEndpoint.href, {
                  headers: { Accept: 'application/json, text/plain, */*', Referer: pageUrl },
                  timeoutMs: 5000
                });
                if (signRes && signRes.ok && typeof signRes.json === 'function') {
                  signData = await signRes.json();
                }
              }
              if (signData && signData.token) {
                cdnUrl.searchParams.set('token', signData.token);
                if (signData.ex) cdnUrl.searchParams.set('ex', String(signData.ex));
                return cdnUrl.href;
              }
            }
            if (/\.(mp4|m4v|mkv|mov|webm|m3u8)(?:$|[?#])/i.test(cdnUrl.href)) return cdnUrl.href;
          }
          const srcMatch = html.match(/<source[^>]+src=["']([^"']+\.(?:mp4|m4v|mkv|mov|webm|m3u8)[^"']*)["']/i)
            || html.match(/<video[^>]+src=["']([^"']+\.(?:mp4|m4v|mkv|mov|webm|m3u8)[^"']*)["']/i);
          if (srcMatch && srcMatch[1]) {
            const direct = new URL(srcMatch[1].replace(/&amp;/g, '&').replace(/\\\//g, '/'), pageUrl);
            if (/^https?:$/.test(direct.protocol)) return direct.href;
          }
        } catch {}
      }
      try {
        const port = (typeof CONFIG !== 'undefined' && CONFIG.DEFAULT_NEXUS_PORT) ? CONFIG.DEFAULT_NEXUS_PORT : 8000;
        const metaUrl = `http://127.0.0.1:${port}/api/v1/meta-preview?url=${encodeURIComponent(new URL(watchUrl, location.href).href)}`;
        const metaRes = await gmFetch(metaUrl, { headers: { Accept: 'application/json' }, timeoutMs: 8000 });
        if (metaRes && metaRes.ok && typeof metaRes.json === 'function') {
          const metaData = await metaRes.json();
          if (metaData && metaData.stream_url && /^https?:\/\//i.test(metaData.stream_url)) {
            return metaData.stream_url;
          }
        }
      } catch {}
      return null;
    })();
    bunkrPending.set(pendingKey, task);
    try {
      const url = await task;
      if (url) {
        const expiry = Number(new URL(url).searchParams.get('ex')) * 1000;
        bunkrDirectCache.set(id, {url, until:Math.min(Date.now()+300000, expiry > 0 ? expiry-60000 : Infinity)});
        try { const link = document.createElement('link');link.rel='preconnect';link.href=new URL(url).origin;if(!document.head.querySelector('link[rel="preconnect"][href="'+link.href+'"]'))document.head.append(link); } catch {}
      }
      return url;
    } finally { bunkrPending.delete(pendingKey); }
  }

  async function resolveThroughSelector(item) {
    if(document.documentElement.dataset.nexusVideoResolver!=='ready')return null;
    return new Promise(resolve=>{
      const requestId='split-'+Math.random().toString(36).slice(2);
      const finish=value=>{clearTimeout(timer);document.removeEventListener('nexus-video-resolved',receive);resolve(value);};
      const receive=event=>{try{const data=JSON.parse(event.detail);if(data.requestId===requestId)finish(data);}catch{}};
      // The Selector allows 12 seconds for its adapter (watch page + HLS).
      // Keep our listener alive until that work can finish and report back.
      const timer=setTimeout(()=>finish(null),15000);
      document.addEventListener('nexus-video-resolved',receive);
      document.dispatchEvent(new CustomEvent('nexus-video-resolve',{detail:JSON.stringify({requestId,url:item.watchUrl || item.url})}));
    });
  }

  function isEpornerUrl(raw) {
    try { return /(^|\.)eporner\.com$/i.test(new URL(raw, location.href).hostname); }
    catch { return false; }
  }

  function normalizeEpornerMediaUrl(raw, baseUrl) {
    try {
      const clean = String(raw || '').replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&');
      const url = new URL(clean, baseUrl);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }

  async function resolveEpornerStream(item, watchUrl) {
    const page = await gmFetch(watchUrl);
    if (!page.ok) {
      console.warn('[Nexus Split] Eporner page request failed:', page.status);
      return null;
    }

    const html = await page.text();
    const id = html.match(/EP\.video\.player\.vid\s*=\s*['"]([a-z0-9]+)/i)?.[1];
    const hash = html.match(/EP\.video\.player\.hash\s*=\s*['"]([a-f0-9]{32})/i)?.[1];
    const sources = [];

    if (id && hash) {
      const requestUrl = new URL(`/xhr/video/${id}`, watchUrl);
      requestUrl.search = new URLSearchParams({
        hash: [0, 8, 16, 24].map(offset => parseInt(hash.slice(offset, offset + 8), 16).toString(36)).join(''),
        domain: requestUrl.hostname,
        pixelRatio: '2',
        playerWidth: '3840',
        playerHeight: '2160',
        fallback: 'false',
        embed: 'false',
        supportedFormats: 'hls,mp4'
      }).toString();

      try {
        const response = await gmFetch(requestUrl.href, { headers: { Accept: 'application/json', Referer: watchUrl } });
        if (response.ok) {
          const data = await response.json();
          const videoId = new URL(watchUrl).pathname.match(/(?:video-|hd-porn\/)([a-z0-9]+)/i)?.[1];
          if (data.available !== false && String(data.vid) === videoId) {
            for (const [format, entries] of Object.entries(data.sources || {})) {
              if (!['mp4', 'hls'].includes(format)) continue;
              for (const [label, value] of Object.entries(entries || {})) {
                const url = normalizeEpornerMediaUrl(typeof value === 'string' ? value : value?.src, watchUrl);
                if (!url) continue;
                const height = Number(label.match(/\d{3,4}/)?.[0]) || Number(value?.height) || 0;
                sources.push({ url, height, format, player: true });
              }
            }
          }
        } else {
          console.warn('[Nexus Split] Eporner source request failed:', response.status);
        }
      } catch (error) {
        console.warn('[Nexus Split] Eporner source request error:', error);
      }
    }

    for (const match of html.matchAll(/href\s*=\s*['"]([^'"]*\/dload\/[^'"]+)['"]/gi)) {
      const url = normalizeEpornerMediaUrl(match[1], watchUrl);
      if (!url || sources.some(source => source.url === url)) continue;
      const height = Number(match[1].match(/\/dload\/[^/]+\/(\d+)/i)?.[1])
        || Number(match[1].match(/(?:[_/-]|=)(\d{3,4})p(?:[._/]|$)/i)?.[1])
        || 0;
      sources.push({ url, height, format: 'mp4', player: false });
    }

    sources.sort((a, b) => b.height - a.height || Number(b.format === 'mp4') - Number(a.format === 'mp4')
      || Number(b.player) - Number(a.player) || Number(/av1/i.test(a.url)) - Number(/av1/i.test(b.url)));
    const best = sources[0];
    if (!best) return null;

    item.directUrl = best.url;
    item.type = best.format;
    item.isResolved = true;
    item.epornerQualityResolved = true;
    if (best.height) item.quality = `${best.height}p`;
    return best.url;
  }

  function parseCustomEventDetail(detail) {
    if (!detail) return null;
    if (typeof detail === 'string') {
      try { return JSON.parse(detail); } catch { return null; }
    }
    return detail;
  }

  function isLeakStyleSource(rawUrl) {
    try {
      const host = new URL(rawUrl, location.href).hostname.toLowerCase();
      return ['leakporner.com', 'hornysimp.com', 'hornysimp.com.lv', 'djav.org',
        'pornerleak.com', 'mypornerleak.com', 'nsfw247.to', 'pornhat.com', 'beeg.com']
        .some(domain => host === domain || host.endsWith('.' + domain));
    } catch { return false; }
  }

  function isReadyImportSource(rawUrl) {
    try {
      const host = new URL(rawUrl, location.href).hostname.toLowerCase();
      return ['porntrex.com', 'whoreshub.com', 'pornhub.com', 'pornhub.org',
        'pornhub.net', 'eporner.com', 'leakporner.com', 'hornysimp.com',
        'hornysimp.com.lv', 'djav.org', 'pornerleak.com', 'mypornerleak.com']
        .some(domain => host === domain || host.endsWith('.' + domain));
    } catch { return false; }
  }

  function isByseEmbedUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl, location.href);
      return ['bysezoxexe.com', '398fitus.com'].some(domain =>
        parsed.hostname === domain || parsed.hostname.endsWith('.' + domain))
        && /^\/(?:e|kpw)\/[a-z0-9_-]+\/?$/i.test(parsed.pathname);
    } catch { return false; }
  }

  function hasEmbedPath(rawUrl) {
    try { return /\/(?:e|embed|kpw)\//i.test(new URL(rawUrl, location.href).pathname); }
    catch { return false; }
  }

  function isDirectMediaUrl(rawUrl, isHls = false) {
    if (isHls) return true;
    try {
      return /\.(?:mp4|m4v|webm|m3u8|mpd)$/i.test(new URL(rawUrl, location.href).pathname);
    } catch {
      return /\.(?:mp4|m4v|webm|m3u8|mpd)(?:[?#]|$)/i.test(String(rawUrl || ''));
    }
  }

  function buildNexusEmbedProxyUrl(upstreamUrl, referer, baseOrigin) {
    const upstream = String(upstreamUrl || '').trim();
    if (!/^https?:\/\//i.test(upstream)) throw new Error('Zdroj nevrátil platnú adresu prehrávača.');
    if (isByseEmbedUrl(upstream)) {
      const parsed = new URL(upstream);
      const code = parsed.pathname.match(/^\/(?:e|kpw)\/([a-z0-9_-]+)/i)?.[1];
      if (code) {
        return new URL(`/e/${encodeURIComponent(code)}?upstream=${encodeURIComponent(upstream)}&referer=${encodeURIComponent(referer || '')}`, baseOrigin).href;
      }
    }
    return new URL(`/embed_proxy?url=${encodeURIComponent(upstream)}&referer=${encodeURIComponent(referer || '')}`, baseOrigin).href;
  }

  function isLocalNexusProxyUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl, location.href);
      return /^\/(?:hls_proxy|hls_proxy\.m3u8|media_proxy\.mp4|embed_proxy|e\/[A-Za-z0-9_-]+|api\/v1\/video_proxy|api\/v1\/tools\/stream-proxy|stream_proxy\/)/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function isFrameBlockedWatchUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl, location.href);
      if (isLocalNexusProxyUrl(parsed.href)) return false;
      const host = parsed.hostname.toLowerCase();
      return ['pornhub.com', 'pornhub.org', 'pornhub.net', 'xvideos.com', 'xvideos.red',
        'leakporner.com', 'hornysimp.com', 'hornysimp.com.lv', 'djav.org', 'pornerleak.com',
        'mypornerleak.com', 'eporner.com', 'spankbang.com', 'spankbang.party', 'xhamster.com']
        .some(domain => host === domain || host.endsWith('.' + domain));
    } catch {
      return false;
    }
  }

  async function resolveViaNexusBackend(item, watchUrl) {
    const qResult = item.quantumResult || null;
    const pageUrl = String(qResult?.url || watchUrl || item.url || '');
    const referer = String(qResult?.source_url || pageUrl);
    const origins = [];
    if (/^https?:$/i.test(location.protocol) && ['localhost', '127.0.0.1'].includes(location.hostname)) {
      origins.push(location.origin);
    }
    for (const port of [CONFIG.DEFAULT_NEXUS_PORT, 8001, 8002, 8003]) {
      const candidate = `http://localhost:${port}`;
      if (!origins.includes(candidate)) origins.push(candidate);
    }

    let resolvedData = (qResult?._resolvedPlayback && Date.now() - (qResult._resolvedAt || 0) < 90000)
      ? qResult._resolvedPlayback
      : null;
    let activeOrigin = origins[0] || `http://localhost:${CONFIG.DEFAULT_NEXUS_PORT}`;

    if (!resolvedData) {
      let lastError = null;
      for (const origin of origins) {
        try {
          const resp = await gmFetch(`${origin}/api/tester/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ urls: [pageUrl] }),
            timeoutMs: 45000
          });
          if (!resp || !resp.ok) {
            lastError = new Error(`Resolver HTTP ${resp ? resp.status : 0}`);
            continue;
          }
          const body = await resp.json();
          const first = (body.results || [])[0] || {};
          const hasPlayable = Boolean(
            first.data?.stream_url ||
            (Array.isArray(first.data?.embed_urls) && first.data.embed_urls.length > 0) ||
            (first.data?.playback && (first.data.playback.playback_url || first.data.playback.fallback_url))
          );
          if (first.status !== 'success' || !hasPlayable) {
            lastError = new Error(first.message || 'Zdroj nevrátil prehrateľný stream');
            break;
          }
          resolvedData = first.data;
          activeOrigin = origin;
          break;
        } catch (err) {
          lastError = err;
        }
      }
      if (!resolvedData) {
        if (lastError) throw lastError;
        return null;
      }
    }

    if (Number(resolvedData.duration) > 0 && !item.duration) {
      item.duration = Number(resolvedData.duration);
      item.durationStr = formatDuration(item.duration);
    }
    if (Number(resolvedData.size_bytes) > 0 && !item.size) {
      item.size = Number(resolvedData.size_bytes);
      item.sizeEstimated = Boolean(resolvedData.size_estimated);
    }
    if (resolvedData.quality && !item.quality) item.quality = String(resolvedData.quality);
    else if (Number(resolvedData.height) > 0 && !item.quality) item.quality = `${Number(resolvedData.height)}p`;
    if (resolvedData.thumbnail && !item.poster) item.poster = String(resolvedData.thumbnail);



    const stream = String(resolvedData.stream_url || '').trim();
    if (!stream) throw new Error('Zdroj nevrátil prehrateľný stream ani embed.');

    if (/\/telegram\/stream\//i.test(stream) || /telesco\.pe\/.+\.mp4/i.test(stream)) {
      item.directUrl = new URL(stream, activeOrigin).href;
      item.type = 'mp4';
      item.isIframe = false;
      item.isResolved = true;
      return item.directUrl;
    }

    const isHls = !!resolvedData.is_hls || /\.m3u8(?:[?#]|$)/i.test(stream)
      || /cdnvids\.top\/stream\/|cdnstream\.top\/stream\/|tnmr\.org\//i.test(stream);

    if (resolvedData.playback && resolvedData.playback.playback_url && resolvedData.playback.status !== 'unsupported') {
      const pbUrl = new URL(resolvedData.playback.playback_url, activeOrigin).href;
      item.directUrl = pbUrl;
      item.type = resolvedData.playback.iframe ? 'iframe' : (resolvedData.playback.format || (isHls ? 'hls' : 'mp4'));
      item.isIframe = Boolean(resolvedData.playback.iframe);
      item.isResolved = true;
      return item.directUrl;
    }

    if (!isDirectMediaUrl(stream, isHls)) {
      const embeds = [
        ...(Array.isArray(resolvedData.embed_urls) ? resolvedData.embed_urls : []),
        ...(Array.isArray(qResult?.embed_urls) ? qResult.embed_urls : []),
        stream
      ].filter((value, index, all) => /^https?:\/\//i.test(String(value || '').trim()) && all.indexOf(value) === index);
      const playerUrl = embeds.find(value => isByseEmbedUrl(value))
        || embeds.find(value => hasEmbedPath(value))
        || embeds[0];
      if (playerUrl && (isReadyImportSource(pageUrl) || isLeakStyleSource(pageUrl) || embeds.length > 1 || hasEmbedPath(playerUrl) || isByseEmbedUrl(playerUrl))) {
        item.directUrl = buildNexusEmbedProxyUrl(playerUrl, resolvedData.playback_referer || referer, activeOrigin);
        item.type = 'iframe';
        item.isIframe = true;
        item.isResolved = true;
        return item.directUrl;
      }
      if (isReadyImportSource(pageUrl) || isLeakStyleSource(pageUrl)) {
        item.directUrl = buildNexusEmbedProxyUrl(stream || pageUrl, resolvedData.playback_referer || referer, activeOrigin);
        item.type = 'iframe';
        item.isIframe = true;
        item.isResolved = true;
        return item.directUrl;
      }
      throw new Error('Zdroj nevrátil priamy stream ani rozpoznateľný embed prehrávač.');
    }

    const host = (() => { try { return new URL(pageUrl).hostname.toLowerCase(); } catch { return ''; } })();
    const isPornhubOrXvideos = /(?:^|\.)(?:pornhub\.(?:com|org|net)|xvideos\.(?:com|red)|noodlemagazine\.com|fpo\.xxx)$/i.test(host);
    const needsProxy = isHls || isReadyImportSource(pageUrl) || isLeakStyleSource(pageUrl)
      || isEpornerUrl(pageUrl) || isEpornerUrl(stream) || isPornhubOrXvideos
      || isCamwhores(host) || /camwhores\.tv/i.test(stream)
      || !!resolvedData.proxy_session || /pixeldrain\.com\/api\/|(?:img|n)\d*\.coomerfans\.com\/|phncdn\.com\/|xvideos-cdn\.com\//i.test(stream);
    const sessionParam = resolvedData.proxy_session ? `&session=${encodeURIComponent(resolvedData.proxy_session)}` : '';
    const playbackUrl = needsProxy
      ? new URL(`/hls_proxy?url=${encodeURIComponent(stream)}&referer=${encodeURIComponent(resolvedData.playback_referer || referer)}${sessionParam}`, activeOrigin).href
      : stream;
    item.directUrl = playbackUrl;
    item.type = isHls ? 'hls' : 'mp4';
    item.isIframe = false;
    item.isResolved = true;
    return item.directUrl;
  }

  async function resolveStreamUrl(item) {
    if (item.type === 'nexus_filester') {
      const data = await new Promise((resolve, reject) => {
        const id = `nuss-filester-${Math.random().toString(36).slice(2)}`;
        const cleanup = () => { clearTimeout(timer); document.removeEventListener('nexus-filester-resolved', receive); };
        const receive = event => {
          let response; try { response = JSON.parse(event.detail); } catch { return; }
          if (response.id !== id) return;
          cleanup(); response.error ? reject(new Error(response.error)) : resolve(response);
        };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Načítanie Filester videa trvá príliš dlho.')); }, 120000);
        document.addEventListener('nexus-filester-resolved', receive);
        document.dispatchEvent(new CustomEvent('nexus-filester-resolve', { detail: JSON.stringify({ id, url: item.watchUrl || item.url }) }));
      });
      if (!/^https?:\/\//i.test(data.url || '')) throw new Error('Filester nevrátil prehrateľný stream.');
      item.directUrl = data.url; item.type = detectFormat(data.url); item.isResolved = true;
      return item.directUrl;
    }
    if (item.type === 'nexus_quantum') {
      let data = null;
      try {
        data = await new Promise((resolve, reject) => {
          const id = `nuss-quantum-${Math.random().toString(36).slice(2)}`;
          const cleanup = () => { clearTimeout(timer); document.removeEventListener('nexus-quantum-resolved', receive); };
          const receive = event => {
            const payload = parseCustomEventDetail(event.detail);
            if (payload?.id !== id) return;
            cleanup();
            if (payload.error) reject(new Error(payload.error)); else resolve(payload);
          };
          const timer = setTimeout(() => { cleanup(); reject(new Error('Quantum bridge timeout')); }, 12000);
          document.addEventListener('nexus-quantum-resolved', receive);
          document.dispatchEvent(new CustomEvent('nexus-quantum-resolve', {
            detail: JSON.stringify({ id, url: item.watchUrl || item.url, result: item.quantumResult || null })
          }));
        });
      } catch (bridgeErr) {
        console.warn('[Nexus Split] Quantum event bridge fallback to direct resolver:', bridgeErr);
      }
      if (data && data.url) {
        item.directUrl = new URL(data.url, location.origin).href;
        item.type = data.iframe ? 'iframe' : (data.format || (/\.m3u8(?:[?#]|$)/i.test(data.url) ? 'hls' : 'mp4'));
        item.isIframe = !!data.iframe;
        item.isResolved = true;
        return item.directUrl;
      }
      return await resolveViaNexusBackend(item, item.watchUrl || item.url);
    }
    if (item.type === 'nexus_album') {
      const watchUrl = item.watchUrl || item.url;
      let stream = item.albumStreamUrl || '';
      if (!stream) {
        const params = new URLSearchParams({ url: watchUrl, refresh: '0', _: String(Date.now()) });
        const response = await fetch(`/api/v1/meta-preview?${params}`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.ok || !data.stream_url) throw new Error(data.message || 'Video sa nepodarilo načítať');
        stream = data.stream_url;
        item.albumStreamUrl = stream;
      }
      const proxy = /\.m3u8(?:\?|$)/i.test(stream) ? '/hls_proxy' : '/api/v1/video_proxy';
      const params = new URLSearchParams({ url: stream, referer: watchUrl });
      item.directUrl = new URL(`${proxy}?${params}`, location.origin).href;
      item.isResolved = true;
      item.type = /\.m3u8(?:\?|$)/i.test(stream) ? 'hls' : 'mp4';
      return item.directUrl;
    }
    const watchUrl = item.watchUrl || item.url;
    let host = '';
    try { host = new URL(watchUrl).hostname; } catch {}
    if (isEpornerUrl(watchUrl)) {
      if (item.epornerQualityResolved && item.directUrl) return item.directUrl;
      return await resolveEpornerStream(item, watchUrl);
    }
    if (item.isResolved && item.directUrl) return item.directUrl;
    if(item.type==='generic_watch' && !isCamwhores(host)) {
      const shared=await resolveThroughSelector(item);
      if(shared?.url && /^https?:/i.test(shared.url)){item.directUrl=shared.url;item.type=shared.format || detectFormat(shared.url);item.isResolved=true;return shared.url;}
      if(shared?.embedUrl && /^https?:/i.test(shared.embedUrl)){item.directUrl=shared.embedUrl;item.isIframe=true;item.isResolved=true;return shared.embedUrl;}
    }

    // 1. Bunkr / Turbo Resolver: volá okamžite /api/sign?v=slug
    if (item.type === 'bunkr_turbo' || isBunkrOrTurbo(host)) {
      try {
        const direct = await resolveBunkrDirect(watchUrl);
        if (direct) { item.isResolved = true; item.directUrl = direct; item.type = detectFormat(direct); return direct; }
      } catch (error) { console.warn('[Nexus Split] Bunkr /api/vs:', error); }
      try {
        const u = new URL(watchUrl, location.href);
        const id = item.id || u.pathname.match(/\/[vfd]\/([a-zA-Z0-9_-]+)/)?.[1];
        if (id) {
          // Skús GET /api/sign?v=slug cez gmFetch
          try {
            const signUrl = `${u.origin}/api/sign?v=${encodeURIComponent(id)}`;
            const res = await gmFetch(signUrl, { headers: { 'Accept': 'application/json', 'Referer': watchUrl } });
            if (res.ok) {
              const data = await res.json();
              if (data?.url) {
                const clean = data.url.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
                item.isResolved = true;
                item.directUrl = clean;
                item.type = 'mp4';
                return clean;
              }
            }
          } catch {}

          // Skús POST /api/sign fallback cez gmFetch
          try {
            const res = await gmFetch(`${u.origin}/api/sign`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Referer': watchUrl },
              body: JSON.stringify({ v: id, slug: id })
            });
            if (res.ok) {
              const data = await res.json();
              if (data?.url) {
                const clean = data.url.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
                item.isResolved = true;
                item.directUrl = clean;
                item.type = 'mp4';
                return clean;
              }
            }
          } catch {}
        }
      } catch (e) {
        console.warn('[Nexus Split] Bunkr resolver chyba:', e);
      }
    }

    // 2. Pixeldrain Resolver
    if (item.type === 'pixeldrain' || isPixeldrain(host)) {
      const id = item.id || getPixeldrainId(watchUrl);
      if (id) {
        const clean = `https://pixeldrain.com/api/file/${id}`;
        item.isResolved = true;
        item.directUrl = clean;
        item.type = 'pixeldrain';
        return clean;
      }
    }

    // 3. XVideos Resolver
    if (host.includes('xvideos.com') || host.includes('xvideos.red')) {
      try {
        const res = await gmFetch(watchUrl);
        if (res.ok) {
          const html = await res.text();
          const hlsMatch = html.match(/html5player\.setVideoHLS\s*\(\s*['"]([^'"]+)['"]/i);
          if (hlsMatch) {
            item.isResolved = true;
            item.directUrl = hlsMatch[1];
            item.type = 'hls';
            return hlsMatch[1];
          }
          const highMatch = html.match(/html5player\.setVideoUrlHigh\s*\(\s*['"]([^'"]+)['"]/i);
          if (highMatch) {
            item.isResolved = true;
            item.directUrl = highMatch[1];
            item.type = 'mp4';
            return highMatch[1];
          }
        }
      } catch {}
    }

    // 4b. xHamster Resolver (HLS .m3u8, priamy MP4, alebo xembed iframe fallback)
    if (item.type === 'xhamster' || isXHamster(host)) {
      try {
        const res = await gmFetch(watchUrl, { headers: { 'Referer': location.href } });
        if (res.ok) {
          const html = await res.text();
          // Skús nájsť HLS master playlist
          const m3u8Match = html.match(/https?:\\?\/\\?\/[^"'\\\s<>]+\.m3u8[a-zA-Z0-9_\-\.\/?=&%]*/i);
          if (m3u8Match) {
            const cleanM3u8 = m3u8Match[0].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
            item.isResolved = true;
            item.directUrl = cleanM3u8;
            item.type = 'hls';
            return cleanM3u8;
          }
          // Skús nájsť priamy MP4 odkaz
          const mp4Match = html.match(/https?:\\?\/\\?\/[^"'\\\s<>]+\.mp4[a-zA-Z0-9_\-\.\/?=&%]*/i);
          if (mp4Match) {
            const cleanMp4 = mp4Match[0].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
            item.isResolved = true;
            item.directUrl = cleanMp4;
            item.type = 'mp4';
            return cleanMp4;
          }
        }
      } catch (e) {
        console.warn('[Nexus Split] xHamster resolver chyba:', e);
      }

      // Fallback na xHamster iframe embed
      const vidId = watchUrl.match(/\/videos\/[^\/?#]+-(\d+)/)?.[1] || watchUrl.match(/\/videos\/(\d+)/)?.[1];
      if (vidId) {
        const embedUrl = `https://xhamster.com/xembed.php?video=${vidId}`;
        item.isResolved = true;
        item.directUrl = embedUrl;
        item.isIframe = true;
        item.type = 'iframe';
        return embedUrl;
      }
    }

    // Camwhores uses KVS player variables and rotating get_file URLs rather
    // than a plain <video src> on many watch pages.
    if (isCamwhores(host)) {
      try {
        const res = await gmFetch(watchUrl, { headers: { 'Referer': location.href } });
        if (res.ok) {
          const html = await res.text();
          const baseUrl = res.url || watchUrl;
          const media = extractCamwhoresVideoSource(html, baseUrl) ||
            extractVideoPageSource(html, baseUrl);
          if (media) {
            item.isResolved = true;
            item.directUrl = media.url;
            item.type = media.type;
            if (media.poster) item.poster = media.poster;
            if (media.duration) {
              item.duration = media.duration;
              item.durationStr = formatDuration(media.duration);
            }
            return media.url;
          }
          console.warn('[Nexus Split] Camwhores stránka neobsahuje rozpoznateľný video zdroj:', watchUrl);
        } else {
          console.warn(`[Nexus Split] Camwhores stránka vrátila HTTP ${res.status}:`, watchUrl);
        }
      } catch (error) {
        console.warn('[Nexus Split] Camwhores resolver chyba:', error);
      }

      // Keep the site's own player available when its page blocks stream scraping.
      item.isResolved = true;
      item.isIframe = true;
      item.directUrl = watchUrl;
      item.type = 'iframe';
      return watchUrl;
    }

    // 4c. Pornhub / LeakPorner / HornySimp / DJAV cez lokálny Nexus backend resolver
    if (/(?:^|\.)(?:pornhub\.(?:com|org|net)|leakporner\.com|hornysimp\.com(?:\.lv)?|djav\.org|pornerleak\.com|mypornerleak\.com)$/i.test(host)) {
      try {
        const resolved = await resolveViaNexusBackend(item, watchUrl);
        if (resolved) return resolved;
      } catch (e) {
        console.warn('[Nexus Split] Nexus backend resolver pre', host, 'zlyhal:', e);
      }
    }

    // 5. Univerzálny HTML Scraper (<video src>, <source>, OpenGraph video) cez gmFetch
    try {
      const res = await gmFetch(watchUrl);
      if (res.ok) {
        const html = await res.text();
        const media = extractVideoPageSource(html, res.url || watchUrl);
        if (media) {
          const resolvedUrl = media.url;
          item.watchUrl = watchUrl;
          item.isResolved = true;
          item.directUrl = resolvedUrl;
          item.type = media.type;
          if (media.poster) item.poster = media.poster;
          if (media.duration) {
            item.duration = media.duration;
            item.durationStr = formatDuration(media.duration);
          }
          return resolvedUrl;
        }
      }
    } catch {}

    // A watch page or a healthy proxy is not proof of a resolved video source.
    return null;
  }

  // ---------------------------------------------------------------------------
  // 7. HLAVNÝ SKENER VIDEÍ NA STRÁNKE (Kombinuje karty, linky a elementy)
  // ---------------------------------------------------------------------------
  let megaCatalog = [];

  function mergeSelectedPageCards(results) {
    const selected = new Map();
    const keyFor = raw => {
      try {
        const url = new URL(raw, location.href);
        if (!/^https?:$/.test(url.protocol)) return '';
        const pdId = getPixeldrainId(url.href);
        if (pdId) return `pixeldrain:${pdId}`;
        const turbo = turboVideoInfo(url.href);
        if (turbo) return turbo.watchUrl;
        url.hash = '';
        return url.href.replace(/\/$/, '');
      } catch { return ''; }
    };
    const nodes = document.querySelectorAll('.nvs-card-selected, .nuss-page-selected, [data-nvs-processed] .nvs-checkbox[aria-checked="true"], [data-nvs-processed] .nvs-selector-wrap input:checked');
    nodes.forEach(node => {
      const card = node.closest('[data-nvs-processed], .nvs-card-selected, .nuss-page-selected') || node;
      if (card.closest('#nuss-overlay, #nuss-picker-modal')) return;
      const values = [card.dataset.nvsUrl, card.getAttribute('href'), ...[...card.querySelectorAll('a[href], iframe[src], video[src]')].map(el => el.href || el.src)];
      for (const value of values) {
        const key = value && keyFor(value);
        if (key) selected.set(key, card);
      }
    });
    for (const item of results) {
      const card = [item.watchUrl, item.rawUrl, item.url].map(value => value && selected.get(keyFor(value))).find(Boolean);
      if (!card) continue;
      item.isSelectedOnPage = true;
      if (!item.poster) {
        const img = card.querySelector('img:not([src$=".svg"])');
        const poster = img?.currentSrc || img?.getAttribute('data-src') || img?.src || '';
        if (poster && !poster.startsWith('data:')) item.poster = poster;
      }
    }
    return results;
  }

  function scanPageVideos() {
    if (location.hostname === 'mega.nz' && megaCatalog.length) return megaCatalog.slice();
    const results = [];
    const seenUrls = new Set();

    const addCandidate = (item) => {
      if (!item || !item.url) return;
      if (seenUrls.has(item.url)) return;
      seenUrls.add(item.url);
      results.push(item);
    };

    const host = window.location.hostname;

    // 1. Bunkr / Turbo karty
    if (isBunkrOrTurbo(host)) {
      harvestBunkrTurboCards().forEach(addCandidate);
    }

    // 2. Pixeldrain albumy & karty
    if (isPixeldrain(host)) {
      harvestPixeldrainCards().forEach(addCandidate);
    }

    // 2b. xHamster karty & initials
    if (isXHamster(host)) {
      harvestXHamsterCards().forEach(addCandidate);
    }

    // 3. Všeobecné video karty na akejkoľvek inej stránke (alebo fallback ak špeciálny nenašiel nič)
    if ((!isBunkrOrTurbo(host) && !isPixeldrain(host) && !isXHamster(host)) || results.length === 0) {
      harvestGenericVideoCards().forEach(addCandidate);
    }

    // 4. Priame HTML5 <video> tagy
    document.querySelectorAll('video').forEach((v, idx) => {
      if (v.closest('#nuss-overlay, #nuss-picker-modal')) return;
      // MediaSource often exposes a transient blob URL while <source> retains the playable URL.
      const sources = [v.currentSrc, v.src, ...Array.from(v.querySelectorAll('source[src]'), source => source.src)];
      let src = sources.find(url => /^https?:/i.test(url || '')) || sources.find(Boolean);
      if (src && src.startsWith('blob:')) {
        const source = v.querySelector('source[src]');
        if (source && /^https?:/i.test(source.src)) src = source.src;
      }
      if (src) {
        const pdId = getPixeldrainId(src);
        if (pdId) {
          const directUrl = `https://pixeldrain.com/api/file/${pdId}`;
          const title = v.title || v.getAttribute('aria-label') || `Pixeldrain Video #${idx + 1}`;
          const poster = `https://pixeldrain.com/api/file/${pdId}/thumbnail?width=256&height=256`;
          addCandidate({ url: directUrl, rawUrl: src, title, poster, type: 'pixeldrain', id: pdId, isResolved: true, element: v });
        } else {
          const poster = v.poster || '';
          const title = v.title || v.getAttribute('aria-label') || `Video na stránke #${idx + 1}`;
          addCandidate({ url: src, title, poster, type: detectFormat(src), element: v });
        }
      }
    });

    // 5. Odkazy na video súbory (.mp4, .webm, .m3u8, .mpd) a Pixeldrain linky
    const videoExtRegex = /\.(mp4|m4v|webm|m3u8|mpd)(\?|$)/i;
    document.querySelectorAll('a[href]').forEach((a) => {
      if (a.closest('#nuss-overlay, #nuss-picker-modal')) return;
      const href = a.href;
      const pdId = getPixeldrainId(href);
      if (pdId) {
        const directUrl = `https://pixeldrain.com/api/file/${pdId}`;
        const title = a.innerText.trim() || a.title || href.split('/').pop().split('?')[0];
        const img = a.querySelector('img');
        const poster = img ? img.src : `https://pixeldrain.com/api/file/${pdId}/thumbnail?width=256&height=256`;
        addCandidate({ url: directUrl, rawUrl: href, title, poster, type: 'pixeldrain', id: pdId, isResolved: true, isLink: true });
      } else if (videoExtRegex.test(href)) {
        const title = a.innerText.trim() || a.title || href.split('/').pop().split('?')[0];
        const img = a.querySelector('img');
        const poster = img ? img.src : '';
        addCandidate({ url: href, title, poster, type: detectFormat(href), isResolved: true, isLink: true });
      }
    });

    // 6. Iframe embedy
    document.querySelectorAll('iframe[src*="embed"], iframe[src*="player"], iframe[src*="video"], iframe[src*="pixeldrain"]').forEach((f, idx) => {
      if (f.closest('#nuss-overlay, #nuss-picker-modal')) return;
      const src = f.src;
      const turbo = turboVideoInfo(src);
      if (turbo) {
        addCandidate({
          id: turbo.id,
          url: turbo.watchUrl,
          watchUrl: turbo.watchUrl,
          title: `Turbo video ${turbo.id}`,
          poster: '',
          type: 'bunkr_turbo',
          isResolved: false,
          element: f
        });
        return;
      }
      const pdId = getPixeldrainId(src);
      if (pdId) {
        const directUrl = `https://pixeldrain.com/api/file/${pdId}`;
        const title = f.title || `Pixeldrain Video #${idx + 1}`;
        const poster = `https://pixeldrain.com/api/file/${pdId}/thumbnail?width=256&height=256`;
        addCandidate({ url: directUrl, rawUrl: src, title, poster, type: 'pixeldrain', id: pdId, isResolved: true });
      } else {
        addCandidate({ url: src, title: `Embedované video #${idx + 1}`, poster: '', type: 'iframe', isIframe: true });
      }
    });

    return mergeSelectedPageCards(results);
  }

  function detectFormat(url) {
    if (!url) return 'unknown';
    if (getPixeldrainId(url)) return 'pixeldrain';
    const clean = url.split('?')[0].toLowerCase();
    if (clean.endsWith('.m3u8') || url.includes('.m3u8')) return 'hls';
    if (clean.endsWith('.mpd') || url.includes('.mpd')) return 'dash';
    if (clean.endsWith('.mp4') || clean.endsWith('.m4v') || clean.endsWith('.webm')) return 'mp4';
    return 'direct';
  }

  // ---------------------------------------------------------------------------
  // 5. PIXELDRAIN MSE QUOTA-SAVER ENGINE
  // ---------------------------------------------------------------------------
  // - Range requesty s prísne stráženým bufferom (max 10-15s)
  // - Žiadny prefetch do budúcnosti
  // - Okamžité zrušenie CDN requestov pri pause alebo minimalizácii okna
  // - Šetrí viac ako 95% 6GB download limitu Pixeldrainu
  // ---------------------------------------------------------------------------
  class PixeldrainMseEngine {
    constructor(videoEl, item, options = {}) {
      this.video = videoEl;
      this.item = item;
      this.id = item.id || getPixeldrainId(item.url);
      this.directUrl = `https://pixeldrain.com/api/file/${this.id}`;
      this.maxBufferAhead = CONFIG.PIXELDRAIN_MAX_BUFFER_AHEAD; // 14s
      this.minBufferAhead = CONFIG.PIXELDRAIN_MIN_BUFFER_AHEAD; // 5s
      this.chunkSize = CONFIG.PIXELDRAIN_CHUNK_SIZE; // 1.5 MB

      this.mediaSource = null;
      this.sourceBuffer = null;
      this.mp4boxfile = null;
      this.abortController = null;
      this.isDestroyed = false;
      this.isPumping = false;
      this.currentOffset = 0;
      this.fileSize = null;
      this.totalDownloadedBytes = 0;
      this.onMetrics = options.onMetrics || (() => {});

      this._onPause = this.handlePause.bind(this);
      this._onPlay = this.handlePlay.bind(this);
      this._onSeeking = this.handleSeeking.bind(this);
      this._onVisibility = this.handleVisibility.bind(this);
    }

    async start() {
      this.video.addEventListener('pause', this._onPause);
      this.video.addEventListener('play', this._onPlay);
      this.video.addEventListener('seeking', this._onSeeking);
      document.addEventListener('visibilitychange', this._onVisibility);
      window.addEventListener('blur', this._onVisibility);

      // 1. Zisti celkovú veľkosť súboru cez HEAD alebo Range 0-1
      const headInfo = await this.probeFile();
      this.fileSize = headInfo.size;

      // 2. Načítaj MP4Box.js knižnicu z CDN
      await loadMp4BoxLib();

      // 3. Inicializuj MediaSource pipeline
      return new Promise((resolve, reject) => {
        this.mediaSource = new MediaSource();
        const objectUrl = URL.createObjectURL(this.mediaSource);
        this.video.src = objectUrl;

        const onSourceOpen = async () => {
          this.mediaSource.removeEventListener('sourceopen', onSourceOpen);
          try {
            await this.initMp4BoxPipeline();
            resolve();
          } catch (err) {
            reject(err);
          }
        };

        this.mediaSource.addEventListener('sourceopen', onSourceOpen);
      });
    }

    async probeFile() {
      try {
        const resp = await fetch(this.directUrl, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
        if (resp.ok) {
          const size = Number(resp.headers.get('content-length')) || 0;
          return { ok: true, size, status: resp.status };
        }
      } catch {}

      try {
        const resp = await fetch(this.directUrl, { headers: { Range: 'bytes=0-1' }, signal: AbortSignal.timeout(6000) });
        const cr = resp.headers.get('content-range') || '';
        const total = Number(cr.split('/')[1]) || 0;
        return { ok: resp.ok || resp.status === 206, size: total, status: resp.status };
      } catch {
        return { ok: false, size: 0, status: 0 };
      }
    }

    async initMp4BoxPipeline() {
      const MP4Box = window.MP4Box;
      this.mp4boxfile = MP4Box.createFile();

      let readyResolved = false;
      const readyPromise = new Promise((resolve, reject) => {
        this.mp4boxfile.onError = (err) => {
          console.warn('[Pixeldrain MSE] MP4Box error:', err);
          if (!readyResolved) reject(err);
        };

        this.mp4boxfile.onReady = (info) => {
          readyResolved = true;
          try {
            if (this.mediaSource && this.mediaSource.readyState === 'open') {
              if (info.duration && info.timescale) {
                this.mediaSource.duration = info.duration / info.timescale;
              }
            }

            let mime = info.mime;
            if (!mime || !MediaSource.isTypeSupported(mime)) {
              mime = 'video/mp4; codecs="avc1.640028, mp4a.40.2"';
              if (!MediaSource.isTypeSupported(mime)) {
                mime = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
              }
            }

            this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
            this.sourceBuffer.mode = 'segments';

            for (const track of info.tracks) {
              this.mp4boxfile.setSegmentOptions(track.id, this.sourceBuffer, { nbSamples: 100 });
            }

            const initSegs = this.mp4boxfile.initializeSegmentation();
            if (initSegs && initSegs.length > 0) {
              this.appendBufferSafely(initSegs[0].buffer);
            }

            this.mp4boxfile.onSegment = (id, user, buffer) => {
              this.appendBufferSafely(buffer);
            };

            this.mp4boxfile.start();
            resolve(info);
          } catch (e) {
            reject(e);
          }
        };
      });

      // Stiahneme prvý inicializačný 1MB chunk na analýzu moov boxu
      const initialSize = Math.min(1024 * 1024, this.fileSize || 1024 * 1024);
      await this.fetchChunkAndAppend(0, initialSize);
      this.currentOffset = initialSize;

      await readyPromise;
      this.startPumpLoop();
    }

    async appendBufferSafely(buffer) {
      if (!this.sourceBuffer || this.isDestroyed) return;
      if (this.sourceBuffer.updating) {
        await new Promise((r) => this.sourceBuffer.addEventListener('updateend', r, { once: true }));
      }
      if (this.mediaSource && this.mediaSource.readyState === 'open') {
        try {
          this.sourceBuffer.appendBuffer(buffer);
        } catch (err) {
          console.warn('[Pixeldrain MSE] appendBuffer warning:', err);
        }
      }
    }

    async fetchChunkAndAppend(start, end) {
      if (this.isDestroyed) return null;
      this.abortController = new AbortController();

      const headers = { Range: `bytes=${start}-${end - 1}` };
      const res = await fetch(this.directUrl, {
        headers,
        signal: this.abortController.signal
      });

      if (!res.ok && res.status !== 206) {
        throw new Error(`Pixeldrain Range HTTP chyba: ${res.status}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      this.totalDownloadedBytes += arrayBuffer.byteLength;
      this.updateMetricsUI();

      arrayBuffer.fileStart = start;
      if (this.mp4boxfile) {
        this.mp4boxfile.appendBuffer(arrayBuffer);
      }
      return arrayBuffer;
    }

    startPumpLoop() {
      if (this.isPumping) return;
      this.isPumping = true;

      const pump = async () => {
        while (!this.isDestroyed && this.isPumping) {
          try {
            // 1. Ak je video pauznuté alebo tab v pozadí, NEŤAHÁME NIČ
            if (this.video.paused || document.visibilityState === 'hidden') {
              await sleep(350);
              continue;
            }

            // 2. Zisti koľko sekúnd máme nabuffrované dopredu
            const curTime = this.video.currentTime || 0;
            let ahead = 0;
            if (this.video.buffered && this.video.buffered.length > 0) {
              for (let i = 0; i < this.video.buffered.length; i++) {
                if (this.video.buffered.start(i) <= curTime && this.video.buffered.end(i) >= curTime) {
                  ahead = this.video.buffered.end(i) - curTime;
                  break;
                }
              }
            }

            // 3. Ak je buffer >= 14s (10–15s okno): STOP, šetríme dáta!
            if (ahead >= this.maxBufferAhead) {
              await sleep(400);
              continue;
            }

            // 4. Koniec súboru dosiahnutý
            if (this.fileSize && this.currentOffset >= this.fileSize) {
              if (this.mediaSource && this.mediaSource.readyState === 'open') {
                try { this.mediaSource.endOfStream(); } catch {}
              }
              break;
            }

            // 5. Stiahnutie ďalšieho 1.5MB chunku
            const nextStart = this.currentOffset;
            const nextEnd = Math.min(nextStart + this.chunkSize, this.fileSize || nextStart + this.chunkSize);

            await this.fetchChunkAndAppend(nextStart, nextEnd);
            this.currentOffset = nextEnd;

            await sleep(80);
          } catch (err) {
            if (err.name === 'AbortError') {
              // Zámerne zrušený request pri pause/blur
              await sleep(300);
            } else {
              console.warn('[Pixeldrain MSE] Pump loop varovanie:', err);
              await sleep(1000);
            }
          }
        }
      };

      pump();
    }

    handlePause() {
      // Okamžité zrušenie bežiaceho CDN sťahovania
      if (this.abortController) {
        try { this.abortController.abort(); } catch {}
        this.abortController = null;
      }
    }

    handlePlay() {
      if (!this.isPumping) {
        this.startPumpLoop();
      }
    }

    handleVisibility() {
      if (document.visibilityState === 'hidden') {
        this.handlePause();
      }
    }

    async handleSeeking() {
      const targetTime = this.video.currentTime;
      if (this.abortController) {
        try { this.abortController.abort(); } catch {}
      }

      if (this.mp4boxfile && this.mp4boxfile.seek) {
        try {
          const seekRes = this.mp4boxfile.seek(targetTime, true);
          if (seekRes && typeof seekRes.offset === 'number') {
            this.currentOffset = seekRes.offset;
          }
        } catch (e) {
          console.warn('[Pixeldrain MSE] seek varovanie:', e);
        }
      }
    }

    updateMetricsUI() {
      this.onMetrics({
        downloadedBytes: this.totalDownloadedBytes,
        fileSize: this.fileSize
      });
    }

    destroy() {
      this.isDestroyed = true;
      this.isPumping = false;
      this.video.removeEventListener('pause', this._onPause);
      this.video.removeEventListener('play', this._onPlay);
      this.video.removeEventListener('seeking', this._onSeeking);
      document.removeEventListener('visibilitychange', this._onVisibility);
      window.removeEventListener('blur', this._onVisibility);

      if (this.abortController) {
        try { this.abortController.abort(); } catch {}
        this.abortController = null;
      }
      if (this.mediaSource && this.mediaSource.readyState === 'open') {
        try { this.mediaSource.endOfStream(); } catch {}
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 4. HLAVNÝ ENGINE PREHRÁVAČA (Nexus Universal Engine)
  // ---------------------------------------------------------------------------
  let overlayEl = null;
  let activeCells = [];
  let layoutMode = localStorage.getItem('nuss_layout') || 'auto';
  let fitMode = localStorage.getItem('nuss_fit') || 'contain';
  let diagVisible = false;
  let diagTimer = null;
  let driftSyncTimer = null;
  let currentScannedVideos = [];
  let currentPickerLayout = localStorage.getItem('nuss_picker_layout') || CONFIG.DEFAULT_PICKER_LAYOUT || '3x2';
  let isFetchingMeta = false;
  let selectedVideoUrls = new Set();
  let pickerSelectionInitialized = false;
  let zoomPanCell = null;
  const LIBRARY_KEY = 'nuss_cross_site_library_v1';
  async function readLibrary() {
    try {
      const value = typeof GM_getValue === 'function' ? GM_getValue(LIBRARY_KEY, [])
        : typeof GM !== 'undefined' && GM.getValue ? await GM.getValue(LIBRARY_KEY, []) : [];
      return Array.isArray(value) ? value : [];
    } catch (error) { console.warn('[Nexus Split] Library read failed', error); return []; }
  }
  async function writeLibrary(entries) {
    if (typeof GM_setValue === 'function') return GM_setValue(LIBRARY_KEY, entries);
    if (typeof GM !== 'undefined' && GM.setValue) return GM.setValue(LIBRARY_KEY, entries);
    throw new Error('Úložisko userscriptu nie je dostupné');
  }
  function libraryItem(item) {
    const fields = ['url','watchUrl','directUrl','rawUrl','title','poster','type','id','isResolved','isIframe','duration','durationStr','quality','resolution','size'];
    const result = {};
    for (const key of fields) if (['string','number','boolean'].includes(typeof item[key])) result[key] = item[key];
    // Blob URLs belong to the originating page and cannot survive closing it.
    for (const key of ['url','directUrl','rawUrl','poster']) if (/^(blob|data):/i.test(result[key] || '')) delete result[key];
    if (!result.url && /^https?:/i.test(result.watchUrl || '')) { result.url = result.watchUrl; result.isResolved = false; }
    return /^https?:/i.test(result.url || '') ? result : null;
  }
  async function saveSelectionToLibrary() {
    const selected = currentScannedVideos.filter(item => selectedVideoUrls.has(item.watchUrl || item.url));
    if (!selected.length) { showToast('Najprv označ videá.'); return; }
    try {
      const entries = await readLibrary(); let saved = 0; let skipped = 0;
      for (const original of selected) {
        const item = libraryItem(original);
        if (!item) { skipped++; continue; }
        const key = item.watchUrl || item.url;
        const old = entries.find(entry => entry.key === key && entry.pageUrl === location.href);
        if (old) { old.item = item; old.savedAt = Date.now(); old.selected = true; }
        else entries.unshift({ key, pageUrl: location.href, pageTitle: document.title || location.hostname, item, selected: true, savedAt: Date.now() });
        saved++;
      }
      await writeLibrary(entries);
      showToast(`Uložené: ${saved}${skipped ? `; ${skipped} má iba dočasný zdroj` : ''}.`);
    } catch (error) { showToast('Knižnicu sa nepodarilo uložiť: ' + error.message); }
  }
  async function openLibrary() {
    const picker = document.getElementById('nuss-picker-modal');
    let panel = document.getElementById('nuss-library');
    if (!panel) {
      panel = document.createElement('div'); panel.id = 'nuss-library';
      panel.style.cssText = 'position:absolute;inset:50px 0 0;background:#0b1120;z-index:60;display:flex;flex-direction:column;padding:16px;gap:12px;color:#e2e8f0';
      picker.querySelector('.nuss-picker-box').appendChild(panel);
    }
    const render = async () => {
      const entries = await readLibrary();
      panel.replaceChildren();
      const head = document.createElement('div'); head.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap';
      const title = document.createElement('strong'); title.textContent = `📚 Knižnica videí (${entries.length})`; head.appendChild(title);
      const button = (text, action) => { const b = document.createElement('button'); b.className = 'nuss-chip-btn'; b.textContent = text; b.addEventListener('click', action); head.appendChild(b); };
      button('▶ Spustiť označené', () => {
        const selected = entries.filter(e => e.selected);
        if (!selected.length) return showToast('Označ videá v knižnici.');
        if (selected.length > CONFIG.MAX_ITEMS) return showToast(`Vyber najviac ${CONFIG.MAX_ITEMS} videí.`);
        picker.style.display = 'none'; openSplitScreen(selected.map(e => ({ ...e.item })));
      });
      button('Späť na stránku', () => panel.remove()); panel.appendChild(head);
      const note = document.createElement('div'); note.style.cssText = 'font-size:12px;color:#94a3b8'; note.textContent = _t('Označenie zostáva uložené medzi stránkami. Pri dočasných odkazoch môže byť potrebné video znovu pridať.', 'Selection persists across pages. Temporary links may need to be re-added.'); panel.appendChild(note);
      const list = document.createElement('div'); list.style.cssText = 'overflow:auto;flex:1'; panel.appendChild(list);
      if (!entries.length) { list.textContent = 'Knižnica je prázdna. Označ videá na stránke a ulož ich.'; return; }
      const groups = new Map();
      entries.forEach(entry => { if (!groups.has(entry.pageUrl)) groups.set(entry.pageUrl, []); groups.get(entry.pageUrl).push(entry); });
      for (const [url, group] of groups) {
        const details = document.createElement('details'); details.open = true; details.style.cssText = 'padding:10px;border-bottom:1px solid #334155';
        const summary = document.createElement('summary'); summary.style.cursor = 'pointer'; summary.textContent = `${group[0].pageTitle || url} — ${group.length} videí`; summary.title = url; details.appendChild(summary);
        const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = url; link.style.cssText = 'display:block;color:#c4b5fd;font-size:11px;overflow-wrap:anywhere;margin:6px 0'; details.appendChild(link);
        for (const entry of group) {
          const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px';
          const check = document.createElement('input'); check.type = 'checkbox'; check.checked = !!entry.selected;
          check.addEventListener('change', async () => { entry.selected = check.checked; await writeLibrary(entries); }); row.appendChild(check);
          const label = document.createElement('span'); label.style.cssText = 'flex:1;overflow-wrap:anywhere'; label.textContent = entry.item.title || entry.key; row.appendChild(label);
          const remove = document.createElement('button'); remove.className = 'nuss-chip-btn'; remove.textContent = '✕'; remove.title = 'Odstrániť z knižnice';
          remove.addEventListener('click', async () => { await writeLibrary(entries.filter(e => e !== entry)); await render(); }); row.appendChild(remove); details.appendChild(row);
        }
        list.appendChild(details);
      }
    };
    try { await render(); } catch (error) { showToast('Knižnicu sa nepodarilo načítať: ' + error.message); }
  }

  // ---------------------------------------------------------------------------
  // FULL METADATA FETCH ENGINE (HD kvalita, presná veľkosť súboru, dĺžka & náhľad)
  // ---------------------------------------------------------------------------
  async function fetchAllCardsMetadata() {
    if (isFetchingMeta) return;
    isFetchingMeta = true;
    const btn = document.getElementById('nuss-btn-fetch-meta');
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = '0.7';
      btn.textContent = '⏳ Zisťujem metadáta...';
    }

    currentScannedVideos.forEach(item=>{hydrateSharedMetadata(item);updateCardInDom(item);});
    const itemsToFetch = currentScannedVideos.filter(v => !v.hasFullMeta);
    let done = 0;
    const total = itemsToFetch.length;

    // Súbežné spracovanie maximálne 3 požiadaviek naraz pre optimálnu rýchlosť
    const CONCURRENCY = 3;
    let index = 0;

    async function worker() {
      while (index < itemsToFetch.length) {
        const item = itemsToFetch[index++];
        try {
          await fetchSingleCardMeta(item);
        } catch (err) {
          console.warn('[Nexus Split] Metadata error pre', item.title, err);
        }
        done++;
        if (btn) {
          btn.textContent = `⏳ Načítavam (${done}/${total})...`;
        }
        updateCardInDom(item);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, itemsToFetch.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '1';
      const all=currentScannedVideos.length,ready=currentScannedVideos.filter(v=>v.hasFullMeta).length;
      btn.textContent = `Metadáta: ${ready}/${all} · neúplné: ${all-ready}`;
      showToast(`Metadáta: ${ready}/${all} kompletných · ${all-ready} neúplných alebo nedostupných`);
      setTimeout(() => {
        if (btn) btn.textContent = '⚡ Načítať plné metadáta';
      }, 4000);
    }
    isFetchingMeta = false;
  }

  async function fetchSingleCardMeta(item) {
    if (!item) return;
    item.metadataError = '';
    if (item.type === 'nexus_filester') {
      const meta = await new Promise((resolve, reject) => {
        const id = `nuss-meta-${Math.random().toString(36).slice(2)}`;
        const cleanup = () => { clearTimeout(timer); document.removeEventListener('nexus-filester-meta-result', receive); };
        const receive = event => {
          let response; try { response = JSON.parse(event.detail); } catch { return; }
          if (response.id !== id) return;
          cleanup(); response.error ? reject(new Error(response.error)) : resolve(response.meta || {});
        };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Filester metadáta sa nepodarilo načítať včas.')); }, 140000);
        document.addEventListener('nexus-filester-meta-result', receive);
        document.dispatchEvent(new CustomEvent('nexus-filester-meta', { detail: JSON.stringify({ id, url: item.watchUrl || item.url }) }));
      });
      if (Number(meta.duration) > 0) item.duration = Number(meta.duration);
      if (Number(meta.sizeBytes) > 0) item.size = Number(meta.sizeBytes);
      if (meta.thumbnail) item.poster = meta.thumbnail;
      if (Number(meta.height) > 0) {
        item.quality = `${Number(meta.height)}p`;
        if (Number(meta.width) > 0) item.resolution = `${Number(meta.width)}x${Number(meta.height)}`;
      } else if (meta.quality) item.quality = meta.quality;
      item.hasFullMeta = Boolean(item.size > 0 && item.duration > 0 && item.quality);
      return;
    }
    if (item.type === 'nexus_album') {
      const params = new URLSearchParams({ url: item.watchUrl || item.url, refresh: '0', _: String(Date.now()) });
      const response = await fetch(`/api/v1/meta-preview?${params}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message || 'Metadáta sa nepodarilo načítať');
      if (data.stream_url) item.albumStreamUrl = data.stream_url;
      if (data.duration) item.duration = Number(data.duration);
      if (data.height) item.quality = `${data.height}p`;
      if (data.width && data.height) item.resolution = `${data.width}x${data.height}`;
      item.hasFullMeta = Boolean(item.duration && item.quality && item.size);
      return;
    }
    if (item.type === 'nexus_quantum') {
      const watchUrl = item.watchUrl || item.url;
      let metadata = null;
      const origins = [];
      if (/^https?:$/i.test(location.protocol) && ['localhost', '127.0.0.1'].includes(location.hostname)) {
        origins.push(location.origin);
      }
      for (const port of [CONFIG.DEFAULT_NEXUS_PORT, 8001, 8002, 8003]) {
        const candidate = `http://localhost:${port}`;
        if (!origins.includes(candidate)) origins.push(candidate);
      }
      for (const origin of origins) {
        try {
          const response = await gmFetch(`${origin}/api/tester/batch-meta`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: [watchUrl], metadata_only: true, full_metadata: true }), timeoutMs: 90000
          });
          if (!response.ok) continue;
          const data = await response.json();
          metadata = (data.results || []).find(entry => entry.url === watchUrl) || data.results?.[0] || null;
          break;
        } catch { /* Skús ďalší lokálny Nexus port. */ }
      }
      if (metadata) {
        if (Number(metadata.duration) > 0) {
          item.duration = Number(metadata.duration);
          item.durationStr = formatDuration(item.duration);
        }
        if (Number(metadata.size_bytes) > 0) {
          item.size = Number(metadata.size_bytes);
          item.sizeEstimated = Boolean(metadata.size_estimated);
        }
        if (Number(metadata.height) > 0) {
          item.quality = metadata.quality || `${Number(metadata.height)}p`;
          if (Number(metadata.width) > 0) item.resolution = `${Number(metadata.width)}x${Number(metadata.height)}`;
        } else if (metadata.quality) item.quality = metadata.quality;
        if (metadata.thumbnail && !item.poster) item.poster = metadata.thumbnail;
        if (metadata.error) item.metadataError = String(metadata.error);
      } else {
        item.metadataError = 'Nexus nie je dostupný na načítanie metadát.';
      }
      item.hasFullMeta = Boolean(item.size > 0 && item.duration > 0 && item.quality);
      return;
    }
    if (item.type === 'bunkr_turbo') {
      const watchUrl = item.watchUrl || item.url;
      let metadata = null;
      for (const port of [CONFIG.DEFAULT_NEXUS_PORT, 8001, 8002, 8003]) {
        try {
          const response = await gmFetch(`http://localhost:${port}/api/tester/batch-meta`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: [watchUrl], metadata_only: true }), timeoutMs: 90000
          });
          if (!response.ok) continue;
          const data = await response.json();
          metadata = (data.results || []).find(entry => entry.url === watchUrl) || data.results?.[0] || null;
          break;
        } catch { /* Try another local Nexus port. */ }
      }
      if (metadata) {
        if (Number(metadata.duration) > 0) item.duration = Number(metadata.duration);
        if (Number(metadata.size_bytes) > 0) item.size = Number(metadata.size_bytes);
        if (Number(metadata.height) > 0) {
          item.quality = metadata.quality || `${Number(metadata.width) > 0 ? Math.min(Number(metadata.width), Number(metadata.height)) : Number(metadata.height)}p`;
          if (Number(metadata.width) > 0) item.resolution = `${Number(metadata.width)}x${Number(metadata.height)}`;
        } else if (metadata.quality) item.quality = metadata.quality;
        if (metadata.thumbnail && !item.poster) item.poster = metadata.thumbnail;
        if (metadata.error) item.metadataError = String(metadata.error);
      } else {
        item.metadataError = 'Nexus nie je dostupný na načítanie Bunkr metadát.';
      }
      item.hasFullMeta = Boolean(item.size > 0 && item.duration > 0 && item.quality);
      return;
    }
    hydrateSharedMetadata(item);
    if(item.hasFullMeta)return;
    // Resolve watch pages before probing. Their HTML Content-Length is not
    // the video size, and notification audio is not video metadata.
    if (item.type === 'generic_watch' && !item.directUrl) {
      const stream = await resolveStreamUrl(item);
      if (!stream) {
        item.hasFullMeta = false;
        item.metadataError = 'Video zdroj sa nepodarilo nájsť. Skontroluj prihlásenie a prístup k príspevku.';
        return;
      }
    }

    // 1. Pixeldrain karta
    const pdId = item.id || getPixeldrainId(item.url) || getPixeldrainId(item.watchUrl);
    if (pdId) {
      try {
        const res = await gmFetch(`https://pixeldrain.com/api/file/${pdId}/info`);
        if (res.ok) {
          const info = await res.json();
          if (info.size) item.size = info.size;
          if (info.width && info.height) {
            item.resolution = `${info.width}x${info.height}`;
            item.quality = info.height >= 2160 ? '4K' : info.height >= 1440 ? '2K' : info.height >= 1080 ? 'FHD' : info.height >= 720 ? 'HD' : 'SD';
          }
          if (!item.poster || item.poster.includes('width=256')) {
            item.poster = `https://pixeldrain.com/api/file/${pdId}/thumbnail?width=640&height=360`;
          }
        }
      } catch {}
    }

    // 2. Bunkr / Turbo karta
    const watchUrl = item.watchUrl || item.url;
    let host = '';
    try { host = new URL(watchUrl).hostname; } catch {}

    if (isBunkrOrTurbo(host) || item.type === 'bunkr_turbo') {
      const u = new URL(watchUrl, location.href);
      const id = item.id || u.pathname.match(/\/[vfd]\/([a-zA-Z0-9_-]+)/)?.[1];

      // Ak nemáme priamy stream, zisti cez /api/sign
      if (!item.directUrl && id) {
        try {
          const signRes = await gmFetch(`${u.origin}/api/sign?v=${encodeURIComponent(id)}`, {
            headers: { 'Accept': 'application/json', 'Referer': watchUrl }
          });
          if (signRes.ok) {
            const data = await signRes.json();
            if (data?.url) {
              item.directUrl = data.url.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
              item.isResolved = true;
            }
          }
        } catch {}
      }

      // Ak nemáme veľkosť alebo náhľad, prečítaj stránku /v/ID
      if ((!item.size || !item.duration || !item.poster) && id) {
        try {
          const pageRes = await gmFetch(watchUrl, { headers: { 'Referer': location.href } });
          if (pageRes.ok) {
            const html = await pageRes.text();
            if (!item.size) {
              const sizeMatch = html.match(/(\d+(?:\.\d+)?)\s*(GB|MB|KB|B)\b/i);
              if (sizeMatch) {
                const val = parseFloat(sizeMatch[1]);
                const unit = sizeMatch[2].toUpperCase();
                let bytes = val;
                if (unit === 'GB') bytes *= 1024 * 1024 * 1024;
                else if (unit === 'MB') bytes *= 1024 * 1024;
                else if (unit === 'KB') bytes *= 1024;
                item.size = Math.round(bytes);
              }
            }
            if (!item.poster) {
              const postMatch = html.match(/poster=["']([^"']+)["']/i) || html.match(/storyboard["']?\s*:\s*["']([^"']+)["']/i);
              if (postMatch) item.poster = postMatch[1].replace(/\\\//g, '/');
            }
            if (!item.directUrl) {
              const dlMatch = html.match(/href=["']([^"']*\/(?:d|download)\/[^"']+)["']/i);
              if (dlMatch) {
                item.directUrl = new URL(dlMatch[1], watchUrl).href;
                item.isResolved = true;
              }
            }
          }
        } catch {}
      }
    }

    // 2b. xHamster karta metadáta
    if (item.type === 'xhamster' || isXHamster(host)) {
      if (!item.directUrl || !item.duration || !item.poster || !item.size) {
        try {
          const pageRes = await gmFetch(watchUrl, { headers: { 'Referer': location.href } });
          if (pageRes.ok) {
            const html = await pageRes.text();
            if (!item.poster) {
              const postMatch = html.match(/"thumbURL"\s*:\s*"([^"]+)"/i) ||
                                html.match(/"imageURL"\s*:\s*"([^"]+)"/i) ||
                                html.match(/meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
              if (postMatch) item.poster = postMatch[1].replace(/\\\//g, '/');
            }
            if (!item.duration) {
              const durMatch = html.match(/"duration"\s*:\s*(\d+)/i);
              if (durMatch) {
                item.duration = parseInt(durMatch[1], 10);
                item.durationStr = formatDuration(item.duration);
              }
            }
            if (!item.directUrl) {
              const m3u8Match = html.match(/https?:\\?\/\\?\/[^"'\\\s<>]+\.m3u8[a-zA-Z0-9_\-\.\/?=&%]*/i);
              if (m3u8Match) {
                item.directUrl = m3u8Match[0].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
                item.isResolved = true;
                item.type = 'hls';
              }
            }
            if (!item.size && item.duration) {
              item.size = Math.round((3500 * 1000 * item.duration) / 8);
              item.quality = 'HD';
            }
          }
        } catch (e) {
          console.warn('[Nexus Split] xHamster meta fetch chyba:', e);
        }
      }
    }

    // 3. Zistenie presnej veľkosti cez HEAD a dĺžky/rozlíšenia cez video probe
    const testUrl = item.directUrl || (item.url && !item.isIframe && /^(?:mp4|hls|dash|direct)$/.test(item.type || '') ? item.url : null);
    if (testUrl && (!item.size || !item.duration || !item.quality)) {
      if (!item.size) {
        try {
          const headRes = await gmFetch(testUrl, { method: 'HEAD' });
          if (headRes.ok) {
            const cl = headRes.headers.get('content-length') || headRes.headers.get('Content-Length');
            if (cl) item.size = parseInt(cl, 10);
          }
        } catch {}
      }

      if (!item.duration || !item.quality) {
        try {
          const probeData = await probeVideoMetadata(testUrl);
          if (probeData.duration && !item.duration) item.duration = probeData.duration;
          if (probeData.width && probeData.height) {
            item.resolution = `${probeData.width}x${probeData.height}`;
            item.quality = probeData.height >= 2160 ? '4K' : probeData.height >= 1440 ? '2K' : probeData.height >= 1080 ? 'FHD' : probeData.height >= 720 ? 'HD' : 'SD';
          }
          if (!item.poster && probeData.snapshot) {
            item.poster = probeData.snapshot;
          }
        } catch {}
      }
    }

    // Odvodenie kvality z rozlíšenia alebo názvu, ak ešte nie je
    if (!item.quality) {
      const titleLower = (item.title || '').toLowerCase();
      if (titleLower.includes('4k') || titleLower.includes('2160p')) item.quality = '4K';
      else if (titleLower.includes('1080p') || titleLower.includes('fhd')) item.quality = 'FHD';
      else if (titleLower.includes('720p') || titleLower.includes('hd')) item.quality = 'HD';
    }

    item.hasFullMeta = Boolean(item.size > 0 && item.duration > 0 && item.quality);
  }

  function probeVideoMetadata(url) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      let resolved = false;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        const metadata = {
          duration: Number.isFinite(v.duration) ? v.duration : 0,
          width: v.videoWidth || 0,
          height: v.videoHeight || 0
        };
        let snapshot = '';
        try {
          if (v.videoWidth > 0 && v.videoHeight > 0) {
            const canvas = document.createElement('canvas');
            canvas.width = Math.min(480, v.videoWidth);
            canvas.height = Math.round(canvas.width * (v.videoHeight / v.videoWidth));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            snapshot = canvas.toDataURL('image/jpeg', 0.75);
          }
        } catch {}
        v.removeAttribute('src');
        v.load();
        resolve({
          ...metadata,
          snapshot
        });
      };

      const timer = setTimeout(finish, 4000);

      v.onloadedmetadata = () => {
        clearTimeout(timer);
        finish();
      };
      v.onerror = () => {
        clearTimeout(timer);
        finish();
      };

      v.src = url;
    });
  }

  function updateCardInDom(item) {
    const listEl = document.getElementById('nuss-picker-list');
    if (!listEl) return;
    const card = listEl.querySelector(`.nuss-card[data-vid-index="${currentScannedVideos.indexOf(item)}"]`);
    if (!card) return;

    // Aktualizácia náhľadu
    if (item.poster) {
      const img = card.querySelector('.nuss-card-thumb');
      if (img && img.tagName === 'IMG' && img.src !== item.poster) {
        img.src = item.poster;
      } else if (!img || img.tagName !== 'IMG') {
        const stage = card.querySelector('.nuss-card-stage');
        const oldThumb = stage.querySelector('.nuss-card-thumb');
        if (oldThumb) oldThumb.remove();
        const newImg = document.createElement('img');
        newImg.src = item.poster;
        newImg.className = 'nuss-card-thumb';
        newImg.loading = 'lazy';
        stage.prepend(newImg);
      }
    }

    // Aktualizácia dĺžky a HD odznaku
    const chipsWrap = card.querySelector('.nuss-card-overlay-chips');
    if (chipsWrap) {
      let durChip = chipsWrap.querySelector('.nuss-chip-duration');
      const durStr = item.duration ? formatDuration(item.duration) : item.durationStr || '';
      if (durStr) {
        if (!durChip) {
          durChip = document.createElement('span');
          durChip.className = 'nuss-card-chip nuss-chip-duration';
          chipsWrap.prepend(durChip);
        }
        durChip.textContent = `⏱ ${durStr}`;
      }

      let hdChip = chipsWrap.querySelector('.nuss-chip-hd');
      if (item.quality) {
        if (!hdChip) {
          hdChip = document.createElement('span');
          chipsWrap.appendChild(hdChip);
        }
        hdChip.className = `nuss-card-chip nuss-chip-hd ${item.quality === '4K' ? 'is-4k' : ''}`;
        hdChip.textContent = item.quality;
      }
    }

    // Aktualizácia veľkosti
    if (item.size) {
      let sizeEl = card.querySelector('.nuss-card-size');
      if (!sizeEl) {
        const metaRow = card.querySelector('.nuss-card-meta-row');
        if (metaRow) {
          sizeEl = document.createElement('span');
          sizeEl.className = 'nuss-card-size';
          metaRow.appendChild(sizeEl);
        }
      }
      if (sizeEl) sizeEl.textContent = `💾 ${item.sizeEstimated ? '~' : ''}${formatBytes(item.size)}`;
    }
  }

  // ---------------------------------------------------------------------------
  // RESIZABLE OKNO VÝBERU (Potiahnutie za rohy a pamätanie rozmerov)
  // ---------------------------------------------------------------------------
  function setupPickerResize(pickerBox) {
    if (!pickerBox) return;
    const grip = pickerBox.querySelector('.nuss-resize-grip');

    // Obnovenie uloženej veľkosti z localStorage
    const savedW = localStorage.getItem('nuss_picker_w');
    const savedH = localStorage.getItem('nuss_picker_h');
    if (savedW) pickerBox.style.width = savedW;
    if (savedH) pickerBox.style.height = savedH;

    // Tlačidlo maximalizácie / obnovenia
    let isMaximized = false;
    let prevW = '', prevH = '';
    const maxBtn = pickerBox.querySelector('[data-act="picker-maximize"]');
    if (maxBtn) {
      maxBtn.addEventListener('click', () => {
        if (!isMaximized) {
          prevW = pickerBox.style.width || getComputedStyle(pickerBox).width;
          prevH = pickerBox.style.height || getComputedStyle(pickerBox).height;
          pickerBox.style.width = '98vw';
          pickerBox.style.height = '96vh';
          maxBtn.textContent = '🗗';
          maxBtn.title = 'Obnoviť pôvodnú veľkosť';
          isMaximized = true;
        } else {
          pickerBox.style.width = prevW || 'min(1140px, 95vw)';
          pickerBox.style.height = prevH || 'min(840px, 88vh)';
          maxBtn.textContent = '🗖';
          maxBtn.title = 'Maximalizovať okno';
          isMaximized = false;
        }
      });
    }

    // Dvojklik na hlavičku okna prepína maximalizáciu
    pickerBox.querySelector('.nuss-picker-head')?.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, input')) return;
      maxBtn?.click();
    });

    if (!grip) return;

    let isResizing = false;
    let startX = 0, startY = 0;
    let startW = 0, startH = 0;

    grip.addEventListener('pointerdown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = pickerBox.getBoundingClientRect();
      startW = rect.width;
      startH = rect.height;
      grip.setPointerCapture(e.pointerId);
      document.body.style.userSelect = 'none';
      e.stopPropagation();
      e.preventDefault();
    });

    grip.addEventListener('pointermove', (e) => {
      if (!isResizing) return;
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      const newW = Math.max(440, Math.min(window.innerWidth * 0.99, startW + deltaX));
      const newH = Math.max(380, Math.min(window.innerHeight * 0.98, startH + deltaY));
      pickerBox.style.width = `${newW}px`;
      pickerBox.style.height = `${newH}px`;
      localStorage.setItem('nuss_picker_w', `${Math.round(newW)}px`);
      localStorage.setItem('nuss_picker_h', `${Math.round(newH)}px`);
    });

    const stopResize = (e) => {
      if (isResizing) {
        isResizing = false;
        document.body.style.userSelect = '';
        try { grip.releasePointerCapture(e.pointerId); } catch {}
      }
    };
    grip.addEventListener('pointerup', stopResize);
    grip.addEventListener('pointercancel', stopResize);
  }

  let quickSelectionTimer;
  function selectedPageItems() {
    // Read selectors directly; no detail requests or picker popup needed.
    if (location.hostname === 'mega.nz') return megaCatalog.filter(item => item.isSelectedOnPage);
    if (isBunkrOrTurbo()) return harvestBunkrTurboCards().filter(item => item.isSelectedOnPage);
    return harvestGenericVideoCards().filter(item=>item.isSelectedOnPage);
  }
  function syncPageSelection() {
    const bar=document.getElementById('nuss-quick-selection');if(!bar)return;
    const hasNvs=!!document.querySelector('[data-nvs-processed],#nvs-workbench-launch,#nvs-import-bar');
    document.documentElement.classList.toggle('nuss-with-nvs',hasNvs);
    // The existing Selector owns selection wherever it is present.
    if(/(^|\.)pimpbunny\.com$/i.test(location.hostname)) {
      document.querySelectorAll('.b6m-video').forEach(inner=>{
        const card=inner.closest('[data-nvs-processed]') || inner;
        const selector=card.querySelector('.nvs-checkbox,.nvs-selector-wrap input');
        if(selector){const legacy=inner.querySelector('.nuss-page-select'),wasSelected=legacy?.checked;legacy?.remove();inner.classList.remove('nuss-page-selected');if(wasSelected && selector.getAttribute('aria-checked')!=='true' && !selector.checked)selector.click();return;}
        if(inner.querySelector('.nuss-page-select'))return;
        if(getComputedStyle(inner).position==='static')inner.style.position='relative';
        const check=document.createElement('input');check.type='checkbox';check.className='nuss-page-select';check.setAttribute('aria-label','Vybrať pre Split-Screen');
        check.addEventListener('click',e=>e.stopPropagation());
        check.addEventListener('change',()=>{card.classList.toggle('nuss-page-selected',check.checked);schedulePageSelection();});inner.appendChild(check);
      });
    }
    const selected=[...document.querySelectorAll('.nvs-card-selected,.nuss-page-selected')].filter(n=>!n.parentElement?.closest('.nvs-card-selected,.nuss-page-selected'));
    const count=location.hostname === 'mega.nz' ? selectedPageItems().length : selected.length;
    bar.hidden=!hasNvs && count===0;
    const play=bar.querySelector('[data-quick="play"]');play.disabled=count===0;play.textContent=`▶ Prehrať vybrané (${count})`;
    const launcher=document.querySelector('#nvs-workbench-launch:not([hidden]),#nvs-import-bar.nvs-bar-visible');
    const rect = launcher?.getBoundingClientRect();
    const bottomOffset = (rect && rect.height > 0) ? Math.max(86, Math.round(innerHeight - rect.top + 14)) : 86;
    bar.style.bottom = `${bottomOffset}px`;
    const hudOpen = document.querySelector('#nvs-scan-hud-panel.nvs-hud-open');
    bar.style.left = hudOpen ? '416px' : '18px';
    bar.style.zIndex = '2147483647';
    // Late Selector results update an already open picker in place.
    currentScannedVideos.forEach(item=>{hydrateSharedMetadata(item);updateCardInDom(item);});
  }
  function schedulePageSelection() {clearTimeout(quickSelectionTimer);quickSelectionTimer=setTimeout(syncPageSelection,80);}
  function setupPageSelection() {
    const bar=document.createElement('div');bar.id='nuss-quick-selection';bar.hidden=true;bar.setAttribute('aria-label','Split-Screen výber zo stránky');
    bar.innerHTML='<button type="button" data-quick="play" disabled>▶ Prehrať vybrané (0)</button><button type="button" data-quick="picker">Všetky videá</button>';
    bar.querySelector('[data-quick="play"]').addEventListener('click',()=>{
      const items=selectedPageItems();if(!items.length){syncPageSelection();return;}
      if(items.length>CONFIG.MAX_ITEMS)showToast(`Spúšťam prvých ${CONFIG.MAX_ITEMS} z ${items.length} označených videí.`);
      document.getElementById('nuss-picker-modal').style.display='none';openSplitScreen(items.slice(0,CONFIG.MAX_ITEMS));
    });
    bar.querySelector('[data-quick="picker"]').addEventListener('click',()=>document.getElementById('nuss-fab').click());document.body.appendChild(bar);
    document.addEventListener('nexus-video-metadata',schedulePageSelection);document.addEventListener('nexus-video-selection',schedulePageSelection);document.addEventListener('change',schedulePageSelection);window.addEventListener('resize',schedulePageSelection);
    new MutationObserver(changes=>{
      if(changes.some(m=>{
        const target=m.target.nodeType===1?m.target:m.target.parentElement;
        if(target?.closest('#nuss-overlay,#nuss-picker-modal,#nuss-quick-selection'))return false;
        if(m.type==='attributes')return target?.matches('[data-nvs-processed],.nvs-checkbox,#nvs-workbench-launch,#nvs-import-bar');
        return target?.closest('[data-nvs-processed],.nvs-selector-wrap') || [...m.addedNodes,...m.removedNodes].some(n=>n.nodeType===1&&(n.matches?.('[data-nvs-processed],.b6m-video,#nvs-workbench-launch')||n.querySelector?.('[data-nvs-processed],.b6m-video,#nvs-workbench-launch')));
      }))schedulePageSelection();
    }).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','aria-checked','data-nexus-video-meta','hidden']});
    syncPageSelection();
  }

  function initUI() {
    const styleTag = document.createElement('style');
    styleTag.textContent = STYLES;
    document.head.appendChild(styleTag);

    // FAB Tlačidlo
    const fab = document.createElement('div');
    fab.id = 'nuss-fab';
    fab.title = 'Nexus Split-Screen: Nájsť a spustiť videá';
    fab.innerHTML = `
      <svg viewBox="0 0 24 24"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z"/></svg>
      <span class="nuss-badge" id="nuss-fab-count" style="display:none">0</span>
    `;
    document.body.appendChild(fab);
    fab.addEventListener('click', openPicker);

    // Modál výberu (Resizable s predvoleným 3x2 Gallery Grid)
    const picker = document.createElement('div');
    picker.id = 'nuss-picker-modal';
    picker.innerHTML = `
      <div class="nuss-picker-box">
        <div class="nuss-picker-head">
          <div class="nuss-picker-head-title">
            <span>⚡ Nexus Split-Screen: Výber videí</span>
          </div>
          <div class="nuss-picker-head-actions">
            <button class="nuss-picker-icon-btn" data-act="picker-maximize" title="Maximalizovať / Obnoviť okno">🗖</button>
            <button class="nuss-picker-icon-btn is-close" data-act="picker-close" title="Zavrieť výber">&times;</button>
          </div>
        </div>
        <div class="nuss-picker-toolbar">
          <div class="nuss-picker-toolbar-row">
            <input type="text" id="nuss-picker-filter" placeholder="🔍 Filtrovať videá podľa názvu alebo odkazu..." autocomplete="off">
            <div class="nuss-layout-switcher" title="Prepínač rozloženia galérie">
              <button class="nuss-layout-btn ${currentPickerLayout === '3x2' ? 'is-active' : ''}" data-picker-layout="3x2">⊞ 3x2</button>
              <button class="nuss-layout-btn ${currentPickerLayout === '3x3' ? 'is-active' : ''}" data-picker-layout="3x3">▦ 3x3</button>
              <button class="nuss-layout-btn ${currentPickerLayout === '4x2' ? 'is-active' : ''}" data-picker-layout="4x2">▥ 4x2</button>
              <button class="nuss-layout-btn ${currentPickerLayout === '4x3' ? 'is-active' : ''}" data-picker-layout="4x3">▩ 4x3</button>
              <button class="nuss-layout-btn ${currentPickerLayout === 'list' ? 'is-active' : ''}" data-picker-layout="list">☰ Zoznam</button>
            </div>
          </div>
          <div class="nuss-picker-toolbar-row">
            <div class="nuss-chip-group">
              <button class="nuss-chip-btn" data-picker-select="first4">Prvé 4</button>
              <button class="nuss-chip-btn" data-picker-select="first6">Prvých 6</button>
              <button class="nuss-chip-btn" data-picker-select="first9">Prvých 9</button>
              <button class="nuss-chip-btn" data-picker-select="all">Všetky (max ${CONFIG.MAX_ITEMS})</button>
              <button class="nuss-chip-btn" data-picker-select="clear">Zrušiť výber</button>
            </div>
            <button class="nuss-btn-fetch-meta" id="nuss-btn-fetch-meta" title="Zistiť presné veľkosti, dĺžky, HD kvalitu a rozlíšenie pre zobrazené videá">
              ⚡ Načítať plné metadáta
            </button>
          </div>
        </div>
        <div class="nuss-picker-list" id="nuss-picker-list" data-layout="${currentPickerLayout}"></div>
        <div class="nuss-picker-foot">
          <span id="nuss-selected-info" style="font-size:12px;color:#94a3b8;">Vyber maximálne ${CONFIG.MAX_ITEMS} videí</span>
          <button class="nuss-chip-btn" data-act="library-save">＋ Uložiť označené</button>
          <button class="nuss-chip-btn" data-act="library-open">📚 Knižnica</button>
          <button class="nuss-btn-primary" data-act="picker-launch">▶ Spustiť Split-Screen</button>
        </div>
        <div class="nuss-resize-grip" title="Potiahni pre zmenu veľkosti okna zo spodného rohu"></div>
      </div>
    `;
    document.body.appendChild(picker);

    setupPickerResize(picker.querySelector('.nuss-picker-box'));

    picker.querySelector('[data-act="picker-close"]').addEventListener('click', () => {
      picker.style.display = 'none';
    });
    picker.querySelector('[data-act="picker-launch"]').addEventListener('click', launchSplitFromPicker);
    picker.querySelector('[data-act="library-save"]').addEventListener('click', saveSelectionToLibrary);
    picker.querySelector('[data-act="library-open"]').addEventListener('click', openLibrary);

    // Filter bar event listenery
    const filterInput = picker.querySelector('#nuss-picker-filter');
    filterInput.addEventListener('input', () => {
      renderPickerList(currentScannedVideos, filterInput.value);
    });

    // Prepínač layoutov galérie (3x2, 3x3, 4x2, 4x3, zoznam)
    picker.querySelector('.nuss-layout-switcher').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-picker-layout]');
      if (!btn) return;
      currentPickerLayout = btn.dataset.pickerLayout;
      localStorage.setItem('nuss_picker_layout', currentPickerLayout);

      picker.querySelectorAll('.nuss-layout-btn').forEach(b => {
        b.classList.toggle('is-active', b === btn);
      });

      const listEl = picker.querySelector('#nuss-picker-list');
      if (listEl) listEl.dataset.layout = currentPickerLayout;
    });

    // Tlačidlo načítania plných metadát
    picker.querySelector('#nuss-btn-fetch-meta').addEventListener('click', fetchAllCardsMetadata);

    // Rýchly výber tlačidlami (Prvé 4, 6, 9, Všetky, Zrušiť)
    picker.querySelector('.nuss-chip-group').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-picker-select]');
      if (!btn) return;
      const act = btn.dataset.pickerSelect;
      const visibleCards = Array.from(picker.querySelectorAll('#nuss-picker-list .nuss-card'));

      if (act === 'clear') {
        selectedVideoUrls.clear();
        visibleCards.forEach(card => {
          card.classList.remove('is-selected');
          const cb = card.querySelector('.nuss-card-cb');
          if (cb) cb.checked = false;
        });
      } else {
        let count = CONFIG.MAX_ITEMS;
        if (act === 'first4') count = 4;
        else if (act === 'first6') count = 6;
        else if (act === 'first9') count = 9;

        visibleCards.forEach((card, i) => {
          const cb = card.querySelector('.nuss-card-cb');
          const shouldCheck = i < count;
          if (cb) cb.checked = shouldCheck;
          card.classList.toggle('is-selected', shouldCheck);
          const idx = parseInt(card.dataset.vidIndex, 10);
          const item = currentScannedVideos[idx];
          if (item) {
            const key = item.watchUrl || item.url;
            if (shouldCheck) selectedVideoUrls.add(key);
            else selectedVideoUrls.delete(key);
          }
        });
      }
      updateSelectedCounter();
    });

    // Overlay Split-Screenu
    overlayEl = document.createElement('div');
    overlayEl.id = 'nuss-overlay';
    overlayEl.innerHTML = `
      <div class="nuss-topbar">
        <span class="nuss-topbar-title">▶▶ Nexus Universal Split-Screen</span>
        <div class="nuss-controls-group">
          <button class="nuss-ctrl-btn" data-act="playAll">▶ Play All</button>
          <button class="nuss-ctrl-btn" data-act="pauseAll">⏸ Pause All</button>
          <button class="nuss-ctrl-btn" data-act="syncStart">⏮ 0:00</button>
          <button class="nuss-ctrl-btn" data-act="stepBack">⏪ -10s</button>
          <button class="nuss-ctrl-btn" data-act="stepFwd">⏩ +10s</button>
          <button class="nuss-ctrl-btn" data-act="muteAll">🔇 Mute All</button>
          <button class="nuss-ctrl-btn nuss-btn-sync-all" data-act="toggleSyncScrubAll" title="Zamknúť alebo odomknúť synchro-scrubbing pre všetky bunky naraz">🔗 Synchro-Scrub [Všetky]</button>
          <button class="nuss-ctrl-btn nuss-btn-vault-all" data-act="saveAllToVault" title="Zaradiť všetky videá do Nexus importu">⬇ Importovať všetky</button>
        </div>
        <div class="nuss-controls-group">
          <button class="nuss-ctrl-btn is-active" data-layout="auto">Auto</button>
          <button class="nuss-ctrl-btn" data-layout="row">1 rad</button>
          <button class="nuss-ctrl-btn" data-layout="grid2">2 stĺpce</button>
          <button class="nuss-ctrl-btn" data-layout="grid3">3 stĺpce (3x2)</button>
          <button class="nuss-ctrl-btn" data-layout="grid3x3">3x3</button>
          <button class="nuss-ctrl-btn" data-layout="grid4x2">4x2</button>
          <button class="nuss-ctrl-btn" data-act="toggleFit">⛶ Fit All</button>
          <button class="nuss-ctrl-btn" data-act="toggleFullscreen" title="Celá mriežka na obrazovku">⛶ Fullscreen</button>
          <button class="nuss-ctrl-btn" data-act="toggleClean" title="Skryť panely; kliknutím vyber video, H obnoví panely">◉ Čistý obraz</button>
          <button class="nuss-ctrl-btn" data-act="saveScene" title="Uložiť pozície všetkých videí">🔖 Uložiť scénu</button>
          <button class="nuss-ctrl-btn" data-act="loadScene" title="'+_t('Obnoviť uložené pozície', 'Restore saved positions')+'">↶ '+_t('Obnoviť scénu', 'Restore scene')+'</button>
          <button class="nuss-ctrl-btn" data-act="help" title="Klávesové skratky">? Skratky</button>
          <button class="nuss-ctrl-btn" data-act="toggleDiag">📊 Diag HUD</button>
          <button class="nuss-ctrl-btn is-close" data-act="closeOverlay">✕ Zavrieť</button>
        </div>
      </div>
      <div class="nuss-reveal-bar"><button class="nuss-ctrl-btn" data-act="toggleClean" title="Zobraziť ovládanie (H)">▼ Zobraziť ovládanie</button></div>
      <div class="nuss-grid-stage" id="nuss-grid-stage" data-fit="contain"></div>
    `;
    document.body.appendChild(overlayEl);

    overlayEl.addEventListener('click', handleOverlayControls);
    overlayEl.addEventListener('click', (e) => {
      if (!overlayEl.classList.contains('nuss-clean') || e.target.closest('button, a, input, select, .nuss-pro-controls, .nuss-cell-head, .nuss-cell-fx-panel')) return;
      const cell = e.target.closest('.nuss-cell');
      if (!cell) return;
      const wasSelected = cell.classList.contains('nuss-selected');
      overlayEl.querySelectorAll('.nuss-selected').forEach(el => el.classList.remove('nuss-selected'));
      const selected = activeCells.find(c => c.element === cell);
      selected?.setZoomPanSelected?.(!wasSelected);
      if (!wasSelected) { cell.classList.add('nuss-selected'); cell.focus({ preventScroll: true }); }
    });
    document.addEventListener('fullscreenchange', () => {
      const button = overlayEl.querySelector('[data-act="toggleFullscreen"]');
      const active = document.fullscreenElement === overlayEl;
      button.textContent = active ? '🗗 Ukončiť fullscreen' : '⛶ Fullscreen';
      button.classList.toggle('is-active', active);
    });
    document.addEventListener('keydown', (e) => {
      if (overlayEl.style.display !== 'flex') return;
      if (e.code === 'KeyH' && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && !e.target.closest('input, textarea, select, [contenteditable="true"]')) {
        e.preventDefault();
        setCleanMode(!overlayEl.classList.contains('nuss-clean'));
      } else if (e.key === 'Escape' && !document.fullscreenElement) {
        if (overlayEl.classList.contains('nuss-clean')) { setCleanMode(false); return; }
        closeSplitScreen();
      }
    });

    // Kontrola počtu videí na stránke
    let countTimer;
    const galleryObserver = new MutationObserver(changes => {
      if (!changes.some(m => [...m.addedNodes, ...m.removedNodes].some(n => n.nodeType === 1 &&
        !n.closest?.('#nuss-overlay, #nuss-picker-modal, #bunkr-album-helper-panel, .bah-floating-split-bar, .nexus-batch-toolbar') &&
        (n.matches?.('.theItem,.grid-item,.file-card,.file,.tile') || n.querySelector?.('.theItem,.grid-item,.file-card,.file,.tile'))))) return;
      clearTimeout(countTimer);countTimer = setTimeout(updateFabCounter, 250);
    });
    galleryObserver.observe(document.body, { childList: true, subtree: true });
    updateFabCounter();
    document.addEventListener('nexus-turbo-split-open', e => {
      try {
        const requested = JSON.parse(e.detail);
        if (!Array.isArray(requested)) return;
        const items = requested.slice(0, CONFIG.MAX_ITEMS).map(entry => {
          const watchUrl = entry.watchUrl || entry.url || `https://${location.hostname}/v/${entry.id}`;
          return {
            url: watchUrl,
            watchUrl: watchUrl,
            title: String(entry.title || `Turbo Video ${entry.id}`),
            poster: String(entry.poster || entry.thumb || entry.thumbnail || ''),
            type: 'bunkr_turbo',
            isResolved: false
          };
        });
        if (items.length) openSplitScreen(items);
      } catch (error) { console.warn('[Nexus Split] Turbo launch:', error); }
    });

    document.addEventListener('nexus-gallery-split-picker', e => {
      const rawItems = parseCustomEventDetail(e.detail);
      const items = Array.isArray(rawItems) ? rawItems : [];
      currentScannedVideos = items.filter(item => item && item.url).map(item => ({
        ...item, watchUrl: item.url, directUrl: item.url,
        type: /\.m3u8(?:\?|$)/i.test(item.url) ? 'hls' : 'mp4', isResolved: true
      }));
      if (!currentScannedVideos.length) return;
      selectedVideoUrls = new Set(currentScannedVideos.slice(0, CONFIG.MAX_ITEMS).map(item => item.url));
      pickerSelectionInitialized = true;
      document.getElementById('nuss-picker-filter').value = '';
      document.getElementById('nuss-picker-modal').style.display = 'flex';
      renderPickerList(currentScannedVideos);
    });
    document.addEventListener('nexus-album-split-picker', e => {
      const rawItems = parseCustomEventDetail(e.detail);
      const items = Array.isArray(rawItems) ? rawItems : [];
      currentScannedVideos = items.filter(item => item && item.url).map(item => ({
        ...item, watchUrl: item.url, type: 'nexus_album', isResolved: false
      }));
      if (!currentScannedVideos.length) return;
      selectedVideoUrls = new Set(currentScannedVideos.slice(0, CONFIG.MAX_ITEMS).map(item => item.url));
      pickerSelectionInitialized = true;
      document.getElementById('nuss-picker-filter').value = '';
      document.getElementById('nuss-picker-modal').style.display = 'flex';
      renderPickerList(currentScannedVideos);
    });
    document.addEventListener('nexus-quantum-split-picker', e => {
      const rawItems = parseCustomEventDetail(e.detail);
      const items = Array.isArray(rawItems) ? rawItems : [];
      currentScannedVideos = items.filter(item => item && item.url).map(item => ({
        ...item, watchUrl: item.url, type: 'nexus_quantum', isResolved: false
      }));
      if (!currentScannedVideos.length) return;
      selectedVideoUrls = new Set(currentScannedVideos.slice(0, CONFIG.MAX_ITEMS).map(item => item.url));
      pickerSelectionInitialized = true;
      document.getElementById('nuss-picker-filter').value = '';
      document.getElementById('nuss-picker-modal').style.display = 'flex';
      renderPickerList(currentScannedVideos);
    });

    document.addEventListener('nexus-split-open', e => {
      try {
        const urls = JSON.parse(e.detail);
        if (!Array.isArray(urls)) return;
        const items = [...new Set(urls)].slice(0, CONFIG.MAX_ITEMS).flatMap(raw => {
          const u = new URL(raw, location.href);
          if (!/^https?:$/.test(u.protocol) || !isBunkrOrTurbo(u.hostname) || !/^\/[fv]\//.test(u.pathname)) return [];
          const card = [...document.querySelectorAll('.bah-card')].find(n => n.querySelector('a[href*="/f/"],a[href*="/v/"]')?.href === u.href);
          return [{ url:u.href, watchUrl:u.href, title:card?.getAttribute('title') || bunkrKey(u.href), poster:card?.querySelector('img.bah-main-thumb')?.src || '', type:'bunkr_turbo', isResolved:false }];
        });
        if (items.length) openSplitScreen(items);
      } catch (error) { console.warn('[Nexus Split] Helper launch:', error); }
    });
    document.addEventListener('nexus-fapfolder-split-open', e => {
      try {
        const requested = JSON.parse(e.detail);
        if (!Array.isArray(requested)) return;
        const items = requested.slice(0, CONFIG.MAX_ITEMS).flatMap(entry => {
          try {
            const watchUrl = entry.watchUrl || entry.url;
            const streamUrl = entry.streamUrl || entry.directUrl || '';
            const isResolved = Boolean(streamUrl && /^https?:/.test(streamUrl));
            return [{
              url: isResolved ? streamUrl : watchUrl,
              directUrl: isResolved ? streamUrl : undefined,
              watchUrl: watchUrl,
              title: String(entry.title || 'FapFolder video'),
              poster: String(entry.poster || entry.thumbnail || ''),
              type: isResolved ? detectFormat(streamUrl) : 'html5',
              isResolved: isResolved,
              isIframe: !isResolved,
            }];
          } catch { return []; }
        });
        if (items.length) openSplitScreen(items);
      } catch (error) { console.warn('[Nexus Split] FapFolder launch:', error); }
    });
    document.addEventListener('nexus-filester-split-picker', e => {
      try {
        const requested = JSON.parse(e.detail);
        if (!Array.isArray(requested)) return;
        currentScannedVideos = requested.flatMap(entry => {
          try {
            const url = new URL(entry.url);
            if (!/^https?:$/.test(url.protocol) || !/(^|\.)filester\.(?:me|gg)$/i.test(url.hostname) || !/^\/d\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname)) return [];
            return [{ url: url.href, watchUrl: url.href, title: String(entry.title || 'Filester video'),
              poster: String(entry.poster || ''), duration: Number(entry.duration) || 0, quality: String(entry.quality || ''),
              size: Number(entry.size) || 0, type: 'nexus_filester', isResolved: false }];
          } catch { return []; }
        });
        if (!currentScannedVideos.length) return;
        selectedVideoUrls = new Set(currentScannedVideos.slice(0, CONFIG.MAX_ITEMS).map(item => item.url));
        pickerSelectionInitialized = true;
        document.getElementById('nuss-picker-filter').value = '';
        document.getElementById('nuss-picker-modal').style.display = 'flex';
        renderPickerList(currentScannedVideos);
      } catch (error) { console.warn('[Nexus Split] Filester picker:', error); }
    });
    document.documentElement.dataset.nexusFilesterPicker = '1';
    document.addEventListener('nexus-filester-split-open', e => {
      try {
        const requested = JSON.parse(e.detail);
        if (!Array.isArray(requested)) return;
        const items = requested.slice(0, CONFIG.MAX_ITEMS).flatMap(entry => {
          try {
            const watchUrl = new URL(entry.watchUrl);
            const directUrl = new URL(entry.directUrl || entry.url);
            if (!/^https?:$/.test(watchUrl.protocol) || !/(^|\.)filester\.(?:me|gg)$/i.test(watchUrl.hostname)
              || !/^\/d\/[A-Za-z0-9_-]+\/?$/i.test(watchUrl.pathname)
              || !/^https?:$/.test(directUrl.protocol)) return [];
            return [{
              url: directUrl.href,
              directUrl: directUrl.href,
              watchUrl: watchUrl.href,
              title: String(entry.title || 'Filester video'),
              poster: String(entry.poster || ''),
              type: detectFormat(directUrl.href),
              isResolved: true,
              isIframe: false,
            }];
          } catch { return []; }
        });
        if (items.length) openSplitScreen(items);
      } catch (error) { console.warn('[Nexus Split] Filester launch:', error); }
    });
    if (location.hostname === 'mega.nz') {
      const readMegaItems = detail => {
        const items = JSON.parse(detail);
        if (!Array.isArray(items)) return [];
        return items.slice(0, 10000).filter(item => {
          try {
            const url = new URL(item.url);
            return ['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:'
              && url.pathname === '/api/v1/mega/stream-ref' && /^mega:[nf]:/.test(url.searchParams.get('ref') || '');
          } catch { return false; }
        }).map(item => ({ ...item, directUrl: item.url, type: 'mp4', isResolved: true, isIframe: false }));
      };
      document.addEventListener('nexus-mega-catalog', e => {
        try { megaCatalog = readMegaItems(e.detail); updateFabCounter(); schedulePageSelection(); } catch {}
      });
      document.addEventListener('nexus-mega-split-open', e => {
        try { const items = readMegaItems(e.detail); if (items.length) openSplitScreen(items.slice(0, CONFIG.MAX_ITEMS)); } catch {}
      });
      document.documentElement.dataset.nexusMegaSplitReady = '1';
    }
    document.documentElement.dataset.nexusSplitReady = '1';
    document.dispatchEvent(new Event('nexus-split-ready'));
    setupPageSelection();

    // Ak je Pixeldrain album, načítaj API na pozadí pre okamžité číslo na odznaku
    if (isPixeldrain()) {
      fetchPixeldrainListIfNeeded().then(() => updateFabCounter());
    }
  }

  function updateFabCounter() {
    try {
      const count = scanPageVideos().length;
      const badge = document.getElementById('nuss-fab-count');
      if (badge) {
        if (count > 0) {
          badge.textContent = count > 99 ? '99+' : count;
          badge.style.display = 'block';
        } else {
          badge.style.display = 'none';
        }
      }
    } catch {}
  }

  async function openPicker() {
    // On the Nexus album viewer the floating launcher must use the album's
    // actual selection, not the generic DOM/video scanner.
    const albumButton = document.querySelector('[data-album-split-screen]');
    if (albumButton && albumButton.getClientRects().length) {
      if (albumButton.disabled) showToast('Najprv označ aspoň jedno video v albume.');
      else albumButton.click();
      return;
    }
    const discovery = document.querySelector('.dhub-overlay');
    if (discovery && discovery.getClientRects().length && getComputedStyle(discovery).display !== 'none') {
      const button = discovery.querySelector('[data-dhub-split-screen]');
      if (button && button.getClientRects().length) button.click();
      else showToast('Najprv označ video súbory v Discovery Hube.');
      return;
    }
    const quantum = document.getElementById('quantumSearchOverlay');
    if (quantum?.classList.contains('active')) {
      const button = document.getElementById('quantumSplitBtn');
      if (button && button.getClientRects().length && !button.disabled) button.click();
      else showToast('Najprv označ výsledky v Quantum Search.');
      return;
    }
    const listEl = document.getElementById('nuss-picker-list');
    const modal = document.getElementById('nuss-picker-modal');
    const filterInput = document.getElementById('nuss-picker-filter');
    if (filterInput) filterInput.value = '';

    listEl.innerHTML = '<div style="grid-column:1/-1;padding:36px;text-align:center;color:#94a3b8;font-size:13px;">Skenujem videá a albumy na stránke…</div>';
    modal.style.display = 'flex';

    if (isPixeldrain()) {
      await fetchPixeldrainListIfNeeded();
    }

    currentScannedVideos = scanPageVideos();
    const pageSelected=currentScannedVideos.filter(v=>v.isSelectedOnPage);
    if (pageSelected.length) currentScannedVideos = pageSelected;
    if(pageSelected.length || !pickerSelectionInitialized){selectedVideoUrls=new Set((pageSelected.length?pageSelected:currentScannedVideos.slice(0,4)).slice(0,CONFIG.MAX_ITEMS).map(v=>v.watchUrl || v.url));pickerSelectionInitialized=true;}
    warmPlaybackEngines(currentScannedVideos.filter(item => selectedVideoUrls.has(item.watchUrl || item.url)));
    renderPickerList(currentScannedVideos);
  }

  function renderPickerList(videos, query = '') {
    const listEl = document.getElementById('nuss-picker-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    listEl.dataset.layout = currentPickerLayout;

    const q = (query || '').trim().toLowerCase();
    const filtered = q
      ? videos.filter(v => (v.title && v.title.toLowerCase().includes(q)) || (v.url && v.url.toLowerCase().includes(q)) || (v.watchUrl && v.watchUrl.toLowerCase().includes(q)))
      : videos;

    if (filtered.length === 0) {
      listEl.innerHTML = `<div style="grid-column:1/-1;padding:36px;text-align:center;color:#94a3b8;font-size:13px;">${q ? _t('Nenašli sa žiadne videá zodpovedajúce filtru.', 'No videos match the current filter.') : _t('Na tejto stránke sa nenašli žiadne videá ani video karty.', 'No videos or cards found on this page.')}</div>`;
      updateSelectedCounter();
      return;
    }


    filtered.forEach((v) => {
      const realIndex = videos.indexOf(v);
      const card = document.createElement('div');
      card.className = 'nuss-card';
      card.dataset.vidIndex = realIndex;

      let badgeColor = '#d8b4fe';
      let badgeBg = 'rgba(168, 85, 247, 0.25)';
      let badgeBorder = 'rgba(168, 85, 247, 0.4)';
      let badgeText = (v.type || 'VIDEO').toUpperCase();

      if (v.type === 'pixeldrain') {
        badgeColor = '#34d399';
        badgeBg = 'rgba(16, 185, 129, 0.25)';
        badgeBorder = 'rgba(16, 185, 129, 0.4)';
        badgeText = '▶ PIXELDRAIN';
      } else if (v.type === 'bunkr_turbo') {
        badgeColor = '#f472b6';
        badgeBg = 'rgba(236, 72, 153, 0.25)';
        badgeBorder = 'rgba(236, 72, 153, 0.4)';
        badgeText = '⚡ TURBO / BUNKR';
      } else if (v.type === 'hls') {
        badgeColor = '#60a5fa';
        badgeBg = 'rgba(59, 130, 246, 0.25)';
        badgeBorder = 'rgba(59, 130, 246, 0.4)';
        badgeText = 'HLS (.m3u8)';
      } else if (v.type === 'xhamster') {
        badgeColor = '#f59e0b';
        badgeBg = 'rgba(245, 158, 11, 0.25)';
        badgeBorder = 'rgba(245, 158, 11, 0.4)';
        badgeText = '⚡ XHAMSTER';
      }

      const itemKey = v.watchUrl || v.url;
      const isChecked = selectedVideoUrls.has(itemKey);

      if (isChecked) {
        card.classList.add('is-selected');
      }

      const durStr = v.duration ? formatDuration(v.duration) : v.durationStr || '';
      const sizeStr = v.size ? (v.sizeEstimated?'~':'')+formatBytes(v.size) : '';
      const qualityStr = v.quality || (v.title.toLowerCase().includes('4k') ? '4K' : v.title.toLowerCase().includes('1080p') ? 'FHD' : '');

      card.innerHTML = `
        <div class="nuss-card-stage">
          <span class="nuss-card-idx-badge">#${realIndex + 1}</span>
          <label class="nuss-card-cb-wrap" title="Vybrať video">
            <input type="checkbox" class="nuss-card-cb" data-vid-index="${realIndex}" ${isChecked ? 'checked' : ''}>
            <span class="nuss-card-cb-custom"></span>
          </label>
          ${v.poster ? `<img src="${v.poster}" class="nuss-card-thumb" loading="lazy" alt="">` : `<div class="nuss-card-thumb nuss-thumb-placeholder">VIDEO #${realIndex + 1}</div>`}
          <div class="nuss-card-overlay-chips">
            ${durStr ? `<span class="nuss-card-chip nuss-chip-duration">⏱ ${durStr}</span>` : '<span></span>'}
            ${qualityStr ? `<span class="nuss-card-chip nuss-chip-hd ${qualityStr === '4K' ? 'is-4k' : ''}">${qualityStr}</span>` : ''}
          </div>
        </div>
        <div class="nuss-card-caption">
          <div class="nuss-card-title" title="${v.title}">${v.title}</div>
          <div class="nuss-card-meta-row">
            <span class="nuss-card-type-tag" style="background:${badgeBg};color:${badgeColor};border:1px solid ${badgeBorder};">${badgeText}</span>
            ${sizeStr ? `<span class="nuss-card-size">💾 ${sizeStr}</span>` : ''}
          </div>
        </div>
      `;

      // Kliknutie na kartu prepína zakliknutie
      card.addEventListener('click', (e) => {
        const cb = card.querySelector('.nuss-card-cb');
        if (!cb) return;

        if (e.target !== cb) {
          const willBeChecked = !cb.checked;
          const currentChecked = listEl.querySelectorAll('input.nuss-card-cb:checked');
          if (willBeChecked && currentChecked.length >= CONFIG.MAX_ITEMS) {
            alert(`Maximálne je možné vybrať ${CONFIG.MAX_ITEMS} videí!`);
            return;
          }
          cb.checked = willBeChecked;
        }

        if (cb.checked) {
          const checkedNow = listEl.querySelectorAll('input.nuss-card-cb:checked');
          if (checkedNow.length > CONFIG.MAX_ITEMS) {
            cb.checked = false;
            alert(`Maximálne je možné vybrať ${CONFIG.MAX_ITEMS} videí!`);
            return;
          }
          selectedVideoUrls.add(itemKey);
          card.classList.add('is-selected');
        } else {
          selectedVideoUrls.delete(itemKey);
          card.classList.remove('is-selected');
        }

        updateSelectedCounter();
      });

      listEl.appendChild(card);
    });

    updateSelectedCounter();
  }

  function updateSelectedCounter() {
    const listEl = document.getElementById('nuss-picker-list');
    if (!listEl) return;
    const checked = listEl.querySelectorAll('input.nuss-card-cb:checked');
    const infoEl = document.getElementById('nuss-selected-info');
    if (infoEl) {
      infoEl.textContent = `Vybraté: ${checked.length} / ${CONFIG.MAX_ITEMS} videí`;
      infoEl.style.color = checked.length > CONFIG.MAX_ITEMS ? '#ef4444' : checked.length > 0 ? '#4ade80' : '#94a3b8';
    }
  }

  function launchSplitFromPicker() {
    const selected = currentScannedVideos.filter(item => selectedVideoUrls.has(item.watchUrl || item.url));
    if (selected.length === 0) {
      alert('Vyber aspoň jedno video!');
      return;
    }

    document.getElementById('nuss-picker-modal').style.display = 'none';
    openSplitScreen(selected.slice(0, CONFIG.MAX_ITEMS));
  }

  // ---------------------------------------------------------------------------
  // 5. FAST START, SPLIT-SCREEN BUNKY & PRO-GRADE VIDEO OVLÁDANIE
  // ---------------------------------------------------------------------------
  function openSplitScreen(videoItems) {
    closeSplitScreen();
    zoomPanCell = null;
    warmPlaybackEngines(videoItems);
    document.querySelectorAll('video').forEach(v => { if (!v.closest('#nuss-overlay')) v.pause(); });
    overlayEl.style.display = 'flex';
    const stage = document.getElementById('nuss-grid-stage');
    stage.innerHTML = '';
    activeCells = [];

    // DNS Preconnect na domény všetkých videí
    videoItems.forEach((it) => injectPreconnect(it.url || it.watchUrl));

    videoItems.forEach((item, idx) => {
      const cell = document.createElement('div');
      cell.className = 'nuss-cell';
      cell.addEventListener('dragstart', e => { e.dataTransfer.setData('text/nuss-cell', String(idx)); });
      cell.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/nuss-cell')) e.preventDefault(); });
      cell.addEventListener('drop', e => {
        const sourceId = e.dataTransfer.getData('text/nuss-cell');
        if (!sourceId) return;
        e.preventDefault();
        const source = activeCells.find(c => String(c.idx) === sourceId)?.element;
        if (source && source !== cell) {
          const marker = document.createComment('cell');
          source.replaceWith(marker); cell.replaceWith(source); marker.replaceWith(cell);
        }
      });
      cell.dataset.url = item.url;
      cell.innerHTML = `
        <button class="nuss-ctrl-btn nuss-select-cell" data-act="select-cell" title="Vybrať alebo odznačiť video">◉ Ovládanie</button>
        <div class="nuss-cell-head" draggable="true" title="Potiahnutím presuň bunku">
          <span class="nuss-cell-num">#${idx + 1}</span>
          <span class="nuss-cell-title"></span>
          <div class="nuss-cell-actions">
            <button class="nuss-cell-act-btn nuss-btn-lock-sync" data-act="toggle-lock-sync" title="Zamknúť/Odomknúť synchronizáciu časovej osi (Multi-Cam Synchro-Scrub)">🔗 Lock Sync</button>
            <button class="nuss-cell-act-btn nuss-btn-vault" data-act="save-to-vault" title="Uložiť video do Nexus Collector Vault">⭐ Uložiť do Nexus Vault</button>
            <button class="nuss-cell-act-btn nuss-btn-fx" data-act="toggle-fx" title="Nastavenie obrazu (Jas, Kontrast, Zoom, Sýtosť, Zrkadlo)">🎨 FX</button>
            <button class="nuss-cell-act-btn nuss-btn-zoom-pan" data-act="toggle-zoom-pan" title="Vybrať video pre zoom kolieskom a posun ťahaním myšou">🎯 Zoom/Pan</button>
            <button class="nuss-cell-act-btn nuss-btn-snap" data-act="cell-snapshot" title="Uložiť snímku v plnom rozlíšení (Screenshot)">📸 Snímka</button>
            <button class="nuss-cell-act-btn" data-act="mute">🔇</button>
            <button class="nuss-cell-act-btn" data-act="solo" title="Sólo zvuk">🎯 Solo</button>
            <button class="nuss-cell-act-btn" data-act="focus-cell" title="Maximalizovať bunku (Focus)">⛶ Focus</button>
            <a class="nuss-cell-act-btn" href="${item.url}" target="_blank" download title="Stiahnuť súbor">⬇</a>
            <button class="nuss-cell-act-btn" data-act="remove" title="Zavrieť bunku">✕</button>
          </div>
        </div>
        <div class="nuss-cell-body">
          <div class="nuss-cell-loader">Pripravujem stream…</div>

          <!-- FX Picture Adjustments Panel (collapsible drawer) -->
          <div class="nuss-cell-fx-panel" style="display:none;">
            <div class="nuss-fx-row">
              <label>Jas <span class="nuss-fx-val f-bright-val">100%</span><input type="range" class="f-bright" min="40" max="220" value="100"></label>
              <label>Kontrast <span class="nuss-fx-val f-contrast-val">100%</span><input type="range" class="f-contrast" min="40" max="220" value="100"></label>
              <label>Sýtosť <span class="nuss-fx-val f-saturate-val">100%</span><input type="range" class="f-saturate" min="0" max="240" value="100"></label>
            </div>
            <div class="nuss-fx-row">
              <label>Zoom <span class="nuss-fx-val t-zoom-val">100%</span><input type="range" class="t-zoom" min="100" max="500" value="100"></label>
              <label>Pan X <span class="nuss-fx-val t-panx-val">0px</span><input type="range" class="t-panx" min="-150" max="150" value="0"></label>
              <label>Pan Y <span class="nuss-fx-val t-pany-val">0px</span><input type="range" class="t-pany" min="-150" max="150" value="0"></label>
              <label class="nuss-fx-cb-label"><input type="checkbox" class="t-mirror"> Zrkadlo</label>
              <button class="nuss-fx-reset" type="button">Reset FX</button>
            </div>
          </div>

          <div class="nuss-video-viewport">
            <video class="nuss-cell-video" autoplay playsinline preload="auto" style="display:none;"></video>
            <iframe class="nuss-cell-iframe" sandbox="allow-scripts allow-forms allow-presentation allow-same-origin" allow="autoplay *; fullscreen *" style="display:none;"></iframe>
          </div>

          <!-- Pro-Grade Floating Custom Video Controller (Big & User-Friendly for Video Enthusiasts) -->
          <div class="nuss-pro-controls" style="display:none;">
            <div class="nuss-pro-timeline-wrap" title="Potiahni alebo klikni pre posun v čase">
              <div class="nuss-pro-timeline">
                <div class="nuss-pro-buffered"></div>
                <div class="nuss-pro-ab-range" style="display:none;"></div>
                <div class="nuss-pro-played"></div>
                <div class="nuss-pro-scrubber-handle"></div>
                <div class="nuss-pro-marker-a" style="display:none;" title="Bod A">A</div>
                <div class="nuss-pro-marker-b" style="display:none;" title="Bod B">B</div>
                <div class="nuss-pro-time-tooltip">0:00</div>
              </div>
            </div>
            <div class="nuss-pro-bar">
              <div class="nuss-pro-grp">
                <button class="nuss-pro-btn nuss-pro-play" data-act="cell-play" title="Prehrať / Pozastaviť (Space)">▶</button>
                <button class="nuss-pro-btn" data-act="cell-frame-back" title="Krok späť o 1 snímku (Frame -1)">⏮</button>
                <button class="nuss-pro-btn" data-act="cell-jump-back" title="Skočiť o 10s späť">⏪ 10s</button>
                <button class="nuss-pro-btn" data-act="cell-jump-fwd" title="Skočiť o 10s dopredu">10s ⏩</button>
                <button class="nuss-pro-btn" data-act="cell-frame-fwd" title="Krok vpred o 1 snímku (Frame +1)">⏭</button>
                <div class="nuss-pro-time">
                  <span class="nuss-pro-current">0:00</span> / <span class="nuss-pro-duration">0:00</span>
                </div>
              </div>
              <div class="nuss-pro-grp nuss-pro-ab-grp">
                <button class="nuss-pro-btn nuss-pro-btn-mark-a" data-act="cell-mark-a" title="Nastaviť začiatok slučky A (aktuálny čas)">[A]</button>
                <button class="nuss-pro-btn nuss-pro-btn-mark-b" data-act="cell-mark-b" title="Nastaviť koniec slučky B (aktuálny čas)">[B]</button>
                <button class="nuss-pro-btn nuss-pro-btn-ab-loop" data-act="cell-ab-loop" title="Zapnúť / Vypnúť A-B opakovanie">🔁 A-B</button>
                <button class="nuss-pro-btn nuss-pro-btn-ab-clear" data-act="cell-ab-clear" title="Zrušiť body A a B">✕ A-B</button>
                <button class="nuss-pro-btn nuss-pro-btn-trim-export" data-act="cell-export-clip" title="✂ Exportovať vybraný výstrižok A-B do videosúboru (.webm/.mp4)">✂ Export Clip</button>
              </div>
              <div class="nuss-pro-grp">
                <button class="nuss-pro-btn nuss-pro-fit-btn" data-act="cell-fit" title="Pomer strán / Fit: Contain, Cover, 16:9, 9:16">⛶ Fit: Contain</button>
                <button class="nuss-pro-btn nuss-pro-speed-btn" data-act="cell-speed" title="Rýchlosť prehrávania (Kliknutím zmeníš)">1.0x</button>
                <button class="nuss-pro-btn nuss-pro-loop-btn" data-act="cell-loop" title="Slučka: VYPNUTÁ">🔁 Loop</button>
              </div>
              <div class="nuss-pro-grp">
                <div class="nuss-pro-vol-wrap">
                  <button class="nuss-pro-btn nuss-pro-mute-btn" data-act="cell-mute" title="Zvuk zapnúť/stlmiť">🔇</button>
                  <input type="range" class="nuss-pro-vol-slider" min="0" max="1" step="0.05" value="1" title="Hlasitosť">
                </div>
                <button class="nuss-pro-btn nuss-pro-snap-btn" data-act="cell-snapshot" title="Uložiť snímku v plnom rozlíšení (Screenshot)">📸</button>
                <button class="nuss-pro-btn nuss-pro-fs-btn" data-act="cell-fs" title="Celá obrazovka bunky">🖥</button>
              </div>
            </div>
          </div>

          <!-- Diagnostický HUD -->
          <div class="nuss-diag-hud">
            <div>Speed: <span class="nuss-diag-val" data-diag="speed">-- Mb/s</span></div>
            <div>Buffer: <span class="nuss-diag-val" data-diag="buf">-- s</span></div>
            <div>Stalls: <span class="nuss-diag-val" data-diag="stalls">0</span></div>
            <div>Dropped: <span class="nuss-diag-val" data-diag="drop">0</span></div>
            <div class="nuss-diag-quota-row" style="grid-column: span 2; color: #38bdf8; display: none;">
              ⚡ Quota Saved: <span class="nuss-diag-val" data-diag="saved">-- %</span> (<span data-diag="quota-bytes">0 MB</span>)
            </div>
          </div>
        </div>
      `;
      const titleElement = cell.querySelector('.nuss-cell-title');
      if (titleElement) {
        titleElement.textContent = String(item.title || 'Video');
        titleElement.title = titleElement.textContent;
      }
      stage.appendChild(cell);

      const cellObj = {
        element: cell,
        video: cell.querySelector('.nuss-cell-video'),
        iframe: cell.querySelector('.nuss-cell-iframe'),
        loader: cell.querySelector('.nuss-cell-loader'),
        diagSpeed: cell.querySelector('[data-diag="speed"]'),
        diagBuf: cell.querySelector('[data-diag="buf"]'),
        diagStalls: cell.querySelector('[data-diag="stalls"]'),
        diagDrop: cell.querySelector('[data-diag="drop"]'),
        diagSaved: cell.querySelector('[data-diag="saved"]'),
        diagQuotaBytes: cell.querySelector('[data-diag="quota-bytes"]'),
        diagQuotaRow: cell.querySelector('.nuss-diag-quota-row'),
        item,
        idx,
        stalls: 0,
        hlsInstance: null,
        dashInstance: null,
        pixeldrainEngine: null,
        markerA: null,
        markerB: null,
        abLoopActive: false,
        isExportingClip: false,
        syncLocked: false,
        updateProgress: null
      };

      cellObj.video.muted = true;
      cellObj.video.loop = false;
      const resumeKey = 'nuss_position:' + (item.watchUrl || item.url);
      cellObj.video.addEventListener('loadedmetadata', () => {
        const saved = Number(localStorage.getItem(resumeKey));
        if (saved > 0 && Number.isFinite(cellObj.video.duration) && saved < cellObj.video.duration - 2) cellObj.video.currentTime = saved;
      }, { once: true });
      let lastPositionSave = 0;
      cellObj.video.addEventListener('timeupdate', () => {
        if (Date.now() - lastPositionSave < 5000) return;
        lastPositionSave = Date.now();
        try { localStorage.setItem(resumeKey, String(cellObj.video.currentTime)); } catch {}
      });
      activeCells.push(cellObj);

      // Inicializácia individuálneho pro-grade ovládania videa pre video nadšencov
      setupCellProControls(cellObj);

      startCellPlayback(cellObj);
    });

    applyGridLayout();
    startDiagnosticPolling();
    startDriftSyncEngine();
  }

  function setupCellProControls(cellObj) {
    const { element: cell, video, item } = cellObj;
    if (!video) return;

    video.controls = false;

    const timelineWrap = cell.querySelector('.nuss-pro-timeline-wrap');
    const timeline = cell.querySelector('.nuss-pro-timeline');
    const playedBar = cell.querySelector('.nuss-pro-played');
    const bufferedBar = cell.querySelector('.nuss-pro-buffered');
    const scrubberHandle = cell.querySelector('.nuss-pro-scrubber-handle');
    const timeTooltip = cell.querySelector('.nuss-pro-time-tooltip');
    const curTimeEl = cell.querySelector('.nuss-pro-current');
    const durTimeEl = cell.querySelector('.nuss-pro-duration');
    const playBtn = cell.querySelector('[data-act="cell-play"]');
    const muteBtn = cell.querySelector('[data-act="cell-mute"]');
    const volSlider = cell.querySelector('.nuss-pro-vol-slider');
    const speedBtn = cell.querySelector('[data-act="cell-speed"]');
    const fitBtn = cell.querySelector('[data-act="cell-fit"]');
    const loopBtn = cell.querySelector('[data-act="cell-loop"]');
    const snapBtn = cell.querySelector('[data-act="cell-snapshot"]');
    const fsBtn = cell.querySelector('[data-act="cell-fs"]');
    const focusBtn = cell.querySelector('[data-act="focus-cell"]');
    const fxBtn = cell.querySelector('[data-act="toggle-fx"]');
    const fxPanel = cell.querySelector('.nuss-cell-fx-panel');
    const proControls = cell.querySelector('.nuss-pro-controls');

    // A-B Looper & Trimmer prvky
    const markABtn = cell.querySelector('[data-act="cell-mark-a"]');
    const markBBtn = cell.querySelector('[data-act="cell-mark-b"]');
    const abLoopBtn = cell.querySelector('[data-act="cell-ab-loop"]');
    const abClearBtn = cell.querySelector('[data-act="cell-ab-clear"]');
    const exportClipBtn = cell.querySelector('[data-act="cell-export-clip"]');
    const abRangeEl = cell.querySelector('.nuss-pro-ab-range');
    const markerAEl = cell.querySelector('.nuss-pro-marker-a');
    const markerBEl = cell.querySelector('.nuss-pro-marker-b');

    // 1. Play / Pause synchronizácia
    const updatePlayState = () => {
      if (video.paused) {
        if (playBtn) {
          playBtn.textContent = '▶';
          playBtn.title = 'Prehrať (Space)';
          playBtn.classList.remove('is-active');
        }
      } else {
        if (playBtn) {
          playBtn.textContent = '⏸';
          playBtn.title = 'Pozastaviť (Space)';
          playBtn.classList.add('is-active');
        }
      }
    };
    video.addEventListener('play', updatePlayState);
    video.addEventListener('pause', updatePlayState);
    video.addEventListener('playing', updatePlayState);

    playBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });

    video.addEventListener('click', () => {
      if (overlayEl.classList.contains('nuss-clean')) return;
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });

    // Vizuálna aktualizácia značiek A-B na časovej osi
    const updateABVisuals = () => {
      // 1. Tlačidlá a textové odznaky aktualizujeme vždy, aj keď dur ešte nie je známe
      if (markABtn) {
        if (cellObj.markerA !== null) {
          markABtn.textContent = `[A] ${formatDuration(cellObj.markerA)}`;
          markABtn.classList.add('is-active');
        } else {
          markABtn.textContent = '[A]';
          markABtn.classList.remove('is-active');
        }
      }

      if (markBBtn) {
        if (cellObj.markerB !== null) {
          markBBtn.textContent = `[B] ${formatDuration(cellObj.markerB)}`;
          markBBtn.classList.add('is-active');
        } else {
          markBBtn.textContent = '[B]';
          markBBtn.classList.remove('is-active');
        }
      }

      if (abLoopBtn) {
        abLoopBtn.classList.toggle('is-active', !!cellObj.abLoopActive);
        abLoopBtn.title = cellObj.abLoopActive ? 'A-B opakovanie: ZAPNUTÉ' : 'A-B opakovanie: VYPNUTÉ';
      }

      // 2. Vizuálne prvky na časovej osi (vyžadujú platnú duration > 0)
      const dur = video.duration || 0;
      if (!dur || isNaN(dur) || !isFinite(dur)) {
        if (markerAEl) markerAEl.style.display = 'none';
        if (markerBEl) markerBEl.style.display = 'none';
        if (abRangeEl) abRangeEl.style.display = 'none';
        return;
      }

      if (cellObj.markerA !== null) {
        const pctA = Math.max(0, Math.min(100, (cellObj.markerA / dur) * 100));
        if (markerAEl) {
          markerAEl.style.left = `${pctA}%`;
          markerAEl.style.display = 'block';
        }
      } else {
        if (markerAEl) markerAEl.style.display = 'none';
      }

      if (cellObj.markerB !== null) {
        const pctB = Math.max(0, Math.min(100, (cellObj.markerB / dur) * 100));
        if (markerBEl) {
          markerBEl.style.left = `${pctB}%`;
          markerBEl.style.display = 'block';
        }
      } else {
        if (markerBEl) markerBEl.style.display = 'none';
      }

      if (cellObj.markerA !== null && cellObj.markerB !== null && cellObj.markerB > cellObj.markerA) {
        const pctA = Math.max(0, Math.min(100, (cellObj.markerA / dur) * 100));
        const pctB = Math.max(0, Math.min(100, (cellObj.markerB / dur) * 100));
        if (abRangeEl) {
          abRangeEl.style.left = `${pctA}%`;
          abRangeEl.style.width = `${pctB - pctA}%`;
          abRangeEl.style.display = 'block';
        }
      } else {
        if (abRangeEl) abRangeEl.style.display = 'none';
      }
    };

    // 2. Timeline & Buffer progres
    const updateProgress = () => {
      const cur = video.currentTime || 0;
      const dur = video.duration || 0;
      if (curTimeEl) curTimeEl.textContent = formatDuration(cur);
      if (dur > 0 && !isNaN(dur) && isFinite(dur)) {
        if (durTimeEl) durTimeEl.textContent = formatDuration(dur);
        const pct = Math.min(100, (cur / dur) * 100);
        if (playedBar) playedBar.style.width = pct + '%';
        if (scrubberHandle) scrubberHandle.style.left = pct + '%';

        let bufEnd = 0;
        for (let i = 0; i < video.buffered.length; i++) {
          if (video.buffered.start(i) <= cur && video.buffered.end(i) >= cur) {
            bufEnd = video.buffered.end(i);
            break;
          }
        }
        const bufPct = Math.min(100, (bufEnd / dur) * 100);
        if (bufferedBar) bufferedBar.style.width = bufPct + '%';

        updateABVisuals();
      }
    };
    cellObj.updateProgress = updateProgress;
    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('progress', updateProgress);
    video.addEventListener('loadedmetadata', updateProgress);
    video.addEventListener('durationchange', updateProgress);

    // 3. Scrubbing na časovej osi so Synchro-Scrub prepojením
    let isSeeking = false;
    const seekWithEvent = (e) => {
      if (!timeline || !video.duration) return;
      const rect = timeline.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const targetTime = ratio * video.duration;
      if (isNaN(targetTime) || !isFinite(targetTime)) return;
      video.currentTime = targetTime;
      updateProgress();

      // Synchro-Scrubbing: Ak je táto bunka zamknutá, synchrónne posunúť ostatné zamknuté videá v reálnom čase!
      if (cellObj.syncLocked && !cellObj._inSyncScrub) {
        syncScrubToPeers(cellObj, targetTime);
      }
    };

    if (timelineWrap) {
      timelineWrap.addEventListener('pointerdown', (e) => {
        isSeeking = true;
        timelineWrap.setPointerCapture(e.pointerId);
        seekWithEvent(e);
        e.stopPropagation();
      });

      timelineWrap.addEventListener('pointermove', (e) => {
        if (timeline && video.duration && timeTooltip) {
          const rect = timeline.getBoundingClientRect();
          if (rect && rect.width > 0) {
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            timeTooltip.textContent = formatDuration(ratio * video.duration);
            timeTooltip.style.left = `${ratio * 100}%`;
          }
        }
        if (isSeeking) {
          seekWithEvent(e);
        }
      });

      const stopSeek = (e) => {
        if (isSeeking) {
          isSeeking = false;
          try { timelineWrap.releasePointerCapture(e.pointerId); } catch {}
        }
      };
      timelineWrap.addEventListener('pointerup', stopSeek);
      timelineWrap.addEventListener('pointercancel', stopSeek);
    }

    // 4. Rýchle skoky a krokovanie po snímkach (Frame Step) s podporou Synchro-Scrub
    cell.querySelector('[data-act="cell-jump-back"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      video.currentTime = Math.max(0, video.currentTime - 10);
      if (cellObj.syncLocked && !cellObj._inSyncScrub) syncScrubToPeers(cellObj, video.currentTime);
    });
    cell.querySelector('[data-act="cell-jump-fwd"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      video.currentTime = Math.min(video.duration || 999999, video.currentTime + 10);
      if (cellObj.syncLocked && !cellObj._inSyncScrub) syncScrubToPeers(cellObj, video.currentTime);
    });
    cell.querySelector('[data-act="cell-frame-back"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      video.pause();
      video.currentTime = Math.max(0, video.currentTime - (1 / 25));
      if (cellObj.syncLocked && !cellObj._inSyncScrub) syncScrubToPeers(cellObj, video.currentTime);
    });
    cell.querySelector('[data-act="cell-frame-fwd"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      video.pause();
      video.currentTime = Math.min(video.duration || 999999, video.currentTime + (1 / 25));
      if (cellObj.syncLocked && !cellObj._inSyncScrub) syncScrubToPeers(cellObj, video.currentTime);
    });

    // 4b. A-B Looper & Precision Clip Trimmer logika
    markABtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      cellObj.markerA = video.currentTime;
      if (cellObj.markerB !== null && cellObj.markerB <= cellObj.markerA) {
        cellObj.markerB = null;
        cellObj.abLoopActive = false; // Deaktivovať slučku, keďže bod B už nie je platný
      }
      if (cellObj.markerA !== null && cellObj.markerB !== null) {
        cellObj.abLoopActive = true;
      }
      updateABVisuals();
      showToast(`📍 Bod [A] nastavený: ${formatDuration(cellObj.markerA)}`);
    });

    markBBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = video.currentTime;
      if (cur <= 0.05 && cellObj.markerA === null) {
        showToast('⚠️ Bod [B] musí byť väčší ako 0:00');
        return;
      }
      if (cellObj.markerA !== null && cur <= cellObj.markerA) {
        showToast('⚠️ Bod [B] musí byť za bodom [A]');
        return;
      }
      cellObj.markerB = cur;
      if (cellObj.markerA === null) {
        cellObj.markerA = 0;
      }
      cellObj.abLoopActive = true;
      updateABVisuals();
      showToast(`📍 Bod [B] nastavený: ${formatDuration(cellObj.markerB)} (A-B slučka aktívna)`);
    });

    abLoopBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (cellObj.markerA === null || cellObj.markerB === null) {
        showToast('ℹ️ Najprv nastavte body [A] a [B]');
        return;
      }
      cellObj.abLoopActive = !cellObj.abLoopActive;
      if (cellObj.abLoopActive) {
        cellObj._prevLoop = video.loop;
        video.loop = false; // Vypnúť natívny HTML5 loop aby nekonfliktoval s A-B hranicami
        if (video.currentTime < cellObj.markerA || video.currentTime >= cellObj.markerB) {
          video.currentTime = cellObj.markerA;
        }
        showToast(`🔁 A-B slučka zapnutá (${formatDuration(cellObj.markerA)} – ${formatDuration(cellObj.markerB)})`);
      } else {
        if (cellObj._prevLoop !== undefined) video.loop = cellObj._prevLoop;
        showToast('⏸ A-B slučka vypnutá');
      }
      updateABVisuals();
    });

    abClearBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      cellObj.markerA = null;
      cellObj.markerB = null;
      cellObj.abLoopActive = false;
      if (cellObj._prevLoop !== undefined) video.loop = cellObj._prevLoop;
      updateABVisuals();
      showToast('✕ Body A-B boli vymazané');
    });

    // Kontrola dosiahnutia koncového bodu B pri aktívnej slučke
    const checkABLoop = () => {
      if (cellObj.abLoopActive && cellObj.markerA !== null && cellObj.markerB !== null) {
        if (video.currentTime >= cellObj.markerB || video.currentTime < cellObj.markerA - 0.5) {
          video.currentTime = cellObj.markerA;
        }
      }
    };
    video.addEventListener('timeupdate', checkABLoop);
    video.addEventListener('ended', () => {
      if (cellObj.abLoopActive && cellObj.markerA !== null) {
        video.currentTime = cellObj.markerA;
        video.play().catch(() => {});
      }
    });

    // Precision Clip Trimmer: Export klipu cez in-browser captureStream + MediaRecorder
    exportClipBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (cellObj.isExportingClip) {
        if (cellObj._activeRecorder && cellObj._activeRecorder.state === 'recording') {
          cellObj._activeRecorder.stop();
          showToast('⏹ Zastavujem export výstrižku…');
        } else {
          // Zrušenie ak ešte nezačalo nahrávanie (napr. čaká na seek)
          cellObj.isExportingClip = false;
          cellObj._activeRecorder = null;
          exportClipBtn.classList.remove('is-recording');
          exportClipBtn.textContent = '✂ Export Clip';
          showToast('⏹ Export výstrižku zrušený.');
        }
        return;
      }

      let start = cellObj.markerA;
      let end = cellObj.markerB;

      if (start === null && end === null) {
        showToast('⚠️ Nastavte body [A] a [B] pre orezanie výstrižku');
        return;
      }

      if (start === null) start = 0;
      if (end === null) end = video.duration || (start + 10);

      if (end <= start) {
        showToast('⚠️ Koncový bod [B] musí byť väčší ako [A]');
        return;
      }

      const clipDuration = end - start;
      if (clipDuration <= 0.2) {
        showToast('⚠️ Výstrižok je príliš krátky (min. 0.3s)');
        return;
      }

      let stream = null;
      try {
        if (typeof video.captureStream === 'function') {
          stream = video.captureStream();
        } else if (typeof video.mozCaptureStream === 'function') {
          stream = video.mozCaptureStream();
        }
      } catch (streamErr) {
        console.warn('[Export Clip] captureStream zlyhal:', streamErr);
      }

      if (!stream) {
        showToast('⚠️ Prehliadač nepodporuje captureStream() pre toto video (alebo je obmedzené CORS).');
        return;
      }

      let mimeType = 'video/webm;codecs=vp9,opus';
      if (typeof MediaRecorder !== 'undefined') {
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm;codecs=vp8,opus';
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/mp4';
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';
      } else {
        showToast('⚠️ MediaRecorder nie je dostupný v tomto prehliadači.');
        return;
      }

      let prevMuted = video.muted;
      try {
        cellObj.isExportingClip = true;
        exportClipBtn.classList.add('is-recording');
        exportClipBtn.textContent = '🔴 Nahrávam clip…';
        showToast(`✂ Spúšťam export výstrižku (${formatDuration(start)} ➜ ${formatDuration(end)})…`);

        // Ak bolo video stlmené, dočasne zapneme zvuk pre zachytenie audio stopy v exporte
        if (video.muted) {
          try { video.muted = false; } catch {}
        }

        const chunks = [];
        const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        cellObj._activeRecorder = recorder;

        recorder.ondataavailable = (evt) => {
          if (evt.data && evt.data.size > 0) {
            chunks.push(evt.data);
          }
        };

        const finishRecording = () => {
          recorder.onstop = null;
          video.removeEventListener('timeupdate', onRecordTimeUpdate);
          video.removeEventListener('ended', finishRecording);
          clearTimeout(safetyTimeout);
          clearTimeout(seekSafetyTimeout);

          try { video.muted = prevMuted; } catch {}

          exportClipBtn.classList.remove('is-recording');
          exportClipBtn.textContent = '✂ Export Clip';
          cellObj.isExportingClip = false;
          cellObj._activeRecorder = null;

          if (chunks.length === 0) {
            showToast(_t('⚠️ Nepodarilo sa nahrať žiadne video dáta.', '⚠️ Failed to load video data.'));
            return;
          }

          const effectiveMime = recorder.mimeType || mimeType || 'video/webm';
          const finalBlob = new Blob(chunks, { type: effectiveMime });
          const ext = effectiveMime.includes('mp4') ? 'mp4' : 'webm';
          const safeTitle = (item.title || 'nexus_clip').replace(/[^a-zA-Z0-9_\u00C0-\u017F-]/g, '_').slice(0, 35);
          const fileName = `${safeTitle}_clip_${Math.floor(start)}s-${Math.floor(end)}s.${ext}`;

          const a = document.createElement('a');
          const blobUrl = URL.createObjectURL(finalBlob);
          a.href = blobUrl;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
          showToast(`✓ Výstrižok ${fileName} stiahnutý (${formatBytes(finalBlob.size)})!`);
        };

        recorder.onstop = finishRecording;

        const onRecordTimeUpdate = () => {
          if (video.currentTime >= end) {
            video.pause();
            if (recorder.state === 'recording') {
              recorder.stop();
            }
          }
        };

        const safetyTimeout = setTimeout(() => {
          if (recorder.state === 'recording') {
            video.pause();
            recorder.stop();
          } else {
            finishRecording();
          }
        }, (clipDuration + 6) * 1000);

        video.pause();
        video.currentTime = start;

        let hasStarted = false;
        const startRecorderNow = () => {
          if (hasStarted) return;
          hasStarted = true;
          video.removeEventListener('seeked', onSeeked);
          clearTimeout(seekSafetyTimeout);
          try {
            recorder.start(100);
            video.addEventListener('timeupdate', onRecordTimeUpdate);
            video.addEventListener('ended', finishRecording);
            video.play().catch(() => {});
          } catch (startErr) {
            console.error('[Export Clip Start Error]', startErr);
            finishRecording();
          }
        };

        const onSeeked = () => {
          startRecorderNow();
        };

        // Ak je video už presne na pozícii start (delta < 0.05s), seeked event sa v prehliadači nespustí!
        if (Math.abs(video.currentTime - start) < 0.05) {
          startRecorderNow();
        } else {
          video.addEventListener('seeked', onSeeked);
        }

        // Poistka ak seeked event zlyhá alebo mešká (max 600ms)
        const seekSafetyTimeout = setTimeout(() => {
          startRecorderNow();
        }, 600);
      } catch (recErr) {
        console.error('[Export Clip Error]', recErr);
        try { video.muted = prevMuted; } catch {}
        exportClipBtn.classList.remove('is-recording');
        exportClipBtn.textContent = '✂ Export Clip';
        cellObj.isExportingClip = false;
        cellObj._activeRecorder = null;
        showToast('⚠️ Chyba pri nahrávaní výstrižku: ' + (recErr.message || recErr));
      }
    });

    // 5. Rýchlosť prehrávania (0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x)
    const speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
    speedBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      let cur = video.playbackRate || 1.0;
      let nextIdx = speeds.findIndex(s => Math.abs(s - cur) < 0.05) + 1;
      if (nextIdx >= speeds.length || nextIdx === -1) nextIdx = 0;
      const newSpeed = speeds[nextIdx];
      video.playbackRate = newSpeed;
      cellObj.userPlaybackRate = newSpeed;
      speedBtn.textContent = newSpeed.toFixed(2).replace(/\.00$/, '') + 'x';
    });

    // 6. Pomer strán / Fit bunky (Contain, Cover, 16:9, 9:16)
    const fits = ['contain', 'cover', '16:9', '9:16'];
    let curFitIdx = 0;
    fitBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      curFitIdx = (curFitIdx + 1) % fits.length;
      const f = fits[curFitIdx];
      if (f === 'contain' || f === 'cover') {
        video.style.objectFit = f;
        video.style.aspectRatio = '';
      } else if (f === '16:9') {
        video.style.objectFit = 'contain';
        video.style.aspectRatio = '16/9';
      } else if (f === '9:16') {
        video.style.objectFit = 'contain';
        video.style.aspectRatio = '9/16';
      }
      fitBtn.textContent = `⛶ Fit: ${f.toUpperCase()}`;
      updateFxFilters();
    });

    // 7. Slučka (Loop)
    loopBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      video.loop = !video.loop;
      loopBtn.classList.toggle('is-active', video.loop);
      loopBtn.title = video.loop ? 'Slučka: ZAPNUTÁ' : 'Slučka: VYPNUTÁ';
    });

    // 8. Hlasitosť a Mute
    const syncVolumeUI = () => {
      if (muteBtn) {
        muteBtn.textContent = video.muted || video.volume === 0 ? '🔇' : video.volume < 0.5 ? '🔉' : '🔊';
        muteBtn.classList.toggle('is-active', !video.muted && video.volume > 0);
      }
      if (volSlider) {
        volSlider.value = video.muted ? 0 : video.volume;
      }
      updateCellMuteIcon(cellObj, video.muted);
    };

    muteBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      video.muted = !video.muted;
      syncVolumeUI();
    });

    volSlider?.addEventListener('input', (e) => {
      e.stopPropagation();
      video.volume = parseFloat(volSlider.value);
      video.muted = video.volume === 0;
      syncVolumeUI();
    });
    volSlider?.addEventListener('click', (e) => e.stopPropagation());

    video.addEventListener('volumechange', syncVolumeUI);

    // 9. Snapshot / Screenshot záberu videa
    const triggerSnapshot = async (e) => {
      if (e) e.stopPropagation();
      try {
        if (!video.videoWidth || !video.videoHeight) {
          showToast('⚠️ Video ešte nemá načítané rozmery pre snímku.');
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        canvas.toBlob((blob) => {
          if (!blob) {
            showToast('⚠️ Nepodarilo sa vygenerovať súbor snímky.');
            return;
          }
          const safeTitle = (item.title || 'nexus_video').replace(/[^a-zA-Z0-9_\u00C0-\u017F-]/g, '_').slice(0, 35);
          const timeSec = Math.floor(video.currentTime);
          const fileName = `${safeTitle}_frame_${timeSec}s.png`;
          const a = document.createElement('a');
          const blobUrl = URL.createObjectURL(blob);
          a.href = blobUrl;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
          showToast(_t(`📸 Snímka ${video.videoWidth}×${video.videoHeight} uložená!`, `📸 Snapshot ${video.videoWidth}×${video.videoHeight} saved!`));
        }, 'image/png');
      } catch (err) {
        console.warn('[Nexus Split] Snapshot zablokovaný CORS:', err);
        showToast('⚠️ Server obmedzil priamy export snímky pre CORS hlavičku.');
      }
    };
    snapBtn?.addEventListener('click', triggerSnapshot);
    cell.querySelector('.nuss-btn-snap')?.addEventListener('click', triggerSnapshot);

    // 10. Focus / Maximalizácia bunky
    const toggleCellFocus = (e) => {
      if (e) e.stopPropagation();
      const isFocused = cell.classList.toggle('is-focused');
      if (focusBtn) {
        focusBtn.textContent = isFocused ? '🗗 Obnoviť' : '⛶ Focus';
        focusBtn.classList.toggle('is-active', isFocused);
      }
    };
    focusBtn?.addEventListener('click', toggleCellFocus);

    // 11. Fullscreen bunky
    fsBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!document.fullscreenElement || document.fullscreenElement === overlayEl) {
        cell.requestFullscreen().catch(() => toggleCellFocus());
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    // 12. FX Picture Adjustments Panel (Jas, Kontrast, Sýtosť, Zoom, Pan, Zrkadlo)
    const viewport = cell.querySelector('.nuss-video-viewport');
    const zoomInput = cell.querySelector('.t-zoom');
    const panXInput = cell.querySelector('.t-panx');
    const panYInput = cell.querySelector('.t-pany');
    const zoomPanBtn = cell.querySelector('[data-act="toggle-zoom-pan"]');
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const getPanBounds = (scale) => {
      if (!viewport) return { x: 150, y: 150 };
      const { width, height } = viewport.getBoundingClientRect();
      const aspect = video.videoWidth > 0 && video.videoHeight > 0
        ? video.videoWidth / video.videoHeight
        : width > 0 && height > 0 ? width / height : 16 / 9;
      const isCover = getComputedStyle(video).objectFit === 'cover';
      const contentWidth = isCover
        ? Math.max(width, height * aspect)
        : Math.min(width, height * aspect);
      const contentHeight = contentWidth / aspect;
      return {
        x: Math.round(Math.max(0, (contentWidth * scale - width) / 2)),
        y: Math.round(Math.max(0, (contentHeight * scale - height) / 2))
      };
    };
    const setZoomPanSelected = (selected) => {
      if (selected) {
        if (zoomPanCell && zoomPanCell !== cellObj) {
          zoomPanCell.element.classList.remove('zoom-pan-active');
          zoomPanCell.element.querySelector('[data-act="toggle-zoom-pan"]')?.classList.remove('is-active');
        }
        zoomPanCell = cellObj;
      } else if (zoomPanCell === cellObj) {
        zoomPanCell = null;
      }
      cell.classList.toggle('zoom-pan-active', selected);
      zoomPanBtn?.classList.toggle('is-active', selected);
    };
    cellObj.setZoomPanSelected = setZoomPanSelected;
    const updateFxFilters = () => {
      const b = cell.querySelector('.f-bright')?.value || 100;
      const c = cell.querySelector('.f-contrast')?.value || 100;
      const s = cell.querySelector('.f-saturate')?.value || 100;
      const z = Number(zoomInput?.value || 100) / 100;
      const bounds = getPanBounds(z);
      let px = Number(panXInput?.value || 0);
      let py = Number(panYInput?.value || 0);
      if (panXInput) {
        panXInput.min = String(-bounds.x);
        panXInput.max = String(bounds.x);
        px = clamp(px, -bounds.x, bounds.x);
        panXInput.value = String(px);
      }
      if (panYInput) {
        panYInput.min = String(-bounds.y);
        panYInput.max = String(bounds.y);
        py = clamp(py, -bounds.y, bounds.y);
        panYInput.value = String(py);
      }
      const m = cell.querySelector('.t-mirror')?.checked || false;
      video.classList.toggle('can-pan', z > 1);

      const fbEl = cell.querySelector('.f-bright-val'); if (fbEl) fbEl.textContent = b + '%';
      const fcEl = cell.querySelector('.f-contrast-val'); if (fcEl) fcEl.textContent = c + '%';
      const fsEl = cell.querySelector('.f-saturate-val'); if (fsEl) fsEl.textContent = s + '%';
      const tzEl = cell.querySelector('.t-zoom-val'); if (tzEl) tzEl.textContent = Math.round(z * 100) + '%';
      const txEl = cell.querySelector('.t-panx-val'); if (txEl) txEl.textContent = Math.round(px) + 'px';
      const tyEl = cell.querySelector('.t-pany-val'); if (tyEl) tyEl.textContent = Math.round(py) + 'px';

      video.style.filter = `brightness(${b}%) contrast(${c}%) saturate(${s}%)`;
      video.style.transform = `translate(${px}px, ${py}px) scale(${z})${m ? ' scaleX(-1)' : ''}`;
    };

    fxPanel?.querySelectorAll('input').forEach(inp => inp.addEventListener('input', updateFxFilters));
    fxPanel?.querySelector('.t-mirror')?.addEventListener('change', updateFxFilters);
    zoomPanBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      setZoomPanSelected(zoomPanCell !== cellObj);
    });

    let pointerDrag = null;
    let suppressNextVideoClick = false;
    const finishPointerDrag = (e) => {
      if (!pointerDrag || (e && e.pointerId !== pointerDrag.pointerId)) return;
      suppressNextVideoClick = e?.type === 'pointerup' && pointerDrag.moved;
      pointerDrag = null;
      video.classList.remove('is-panning');
    };
    viewport?.addEventListener('wheel', (e) => {
      if (zoomPanCell !== cellObj || e.target !== video) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = viewport.getBoundingClientRect();
      const currentScale = Number(zoomInput?.value || 100) / 100;
      const nextScale = clamp(currentScale - e.deltaY * 0.002, 1, 5);
      if (nextScale === currentScale) return;
      const oldX = Number(panXInput?.value || 0);
      const oldY = Number(panYInput?.value || 0);
      const anchorX = e.clientX - rect.left - rect.width / 2;
      const anchorY = e.clientY - rect.top - rect.height / 2;
      const nextX = anchorX - ((anchorX - oldX) / currentScale) * nextScale;
      const nextY = anchorY - ((anchorY - oldY) / currentScale) * nextScale;
      if (zoomInput) zoomInput.value = String(Math.round(nextScale * 100));
      const bounds = getPanBounds(nextScale);
      if (panXInput) { panXInput.min = String(-bounds.x); panXInput.max = String(bounds.x); }
      if (panYInput) { panYInput.min = String(-bounds.y); panYInput.max = String(bounds.y); }
      if (panXInput) panXInput.value = String(Math.round(nextX));
      if (panYInput) panYInput.value = String(Math.round(nextY));
      updateFxFilters();
    }, { passive: false });
    viewport?.addEventListener('pointerdown', (e) => {
      if (zoomPanCell !== cellObj || e.target !== video || e.button !== 0
        || Number(zoomInput?.value || 100) <= 100) return;
      pointerDrag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        panX: Number(panXInput?.value || 0),
        panY: Number(panYInput?.value || 0),
        moved: false
      };
      viewport.setPointerCapture(e.pointerId);
      video.classList.add('is-panning');
      e.preventDefault();
      e.stopPropagation();
    });
    viewport?.addEventListener('pointermove', (e) => {
      if (!pointerDrag || e.pointerId !== pointerDrag.pointerId) return;
      if (Math.abs(e.clientX - pointerDrag.startX) > 2 || Math.abs(e.clientY - pointerDrag.startY) > 2) {
        pointerDrag.moved = true;
      }
      if (panXInput) panXInput.value = String(Math.round(pointerDrag.panX + e.clientX - pointerDrag.startX));
      if (panYInput) panYInput.value = String(Math.round(pointerDrag.panY + e.clientY - pointerDrag.startY));
      updateFxFilters();
      e.preventDefault();
    });
    viewport?.addEventListener('pointerup', finishPointerDrag);
    viewport?.addEventListener('pointercancel', finishPointerDrag);
    viewport?.addEventListener('lostpointercapture', finishPointerDrag);
    viewport?.addEventListener('click', (e) => {
      if (!suppressNextVideoClick) return;
      suppressNextVideoClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
    video.addEventListener('loadedmetadata', updateFxFilters);
    updateFxFilters();

    fxPanel?.querySelector('.nuss-fx-reset')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const fb = cell.querySelector('.f-bright'); if (fb) fb.value = 100;
      const fc = cell.querySelector('.f-contrast'); if (fc) fc.value = 100;
      const fs = cell.querySelector('.f-saturate'); if (fs) fs.value = 100;
      const tz = cell.querySelector('.t-zoom'); if (tz) tz.value = 100;
      const tx = cell.querySelector('.t-panx'); if (tx) tx.value = 0;
      const ty = cell.querySelector('.t-pany'); if (ty) ty.value = 0;
      const tm = cell.querySelector('.t-mirror'); if (tm) tm.checked = false;
      updateFxFilters();
    });

    fxBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isShown = fxPanel.style.display !== 'none';
      fxPanel.style.display = isShown ? 'none' : 'flex';
      fxBtn.classList.toggle('is-active', !isShown);
    });

    // 13. Auto-hide ovládacieho panelu pri prehrávaní
    let idleTimer = null;
    const wakeControls = () => {
      if (!proControls) return;
      proControls.classList.remove('is-idle');
      clearTimeout(idleTimer);
      if (!video.paused) {
        idleTimer = setTimeout(() => {
          if (!video.paused && !cell.matches(':hover .nuss-pro-controls')) {
            proControls.classList.add('is-idle');
          }
        }, 2800);
      }
    };
    cell.addEventListener('mousemove', wakeControls);
    cell.addEventListener('mouseenter', wakeControls);
    video.addEventListener('pause', wakeControls);
    video.addEventListener('play', wakeControls);

    // 14. Klávesové skratky pri nabehnutí myšou na bunku
    cell.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (video.paused) video.play().catch(() => {});
        else video.pause();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 10);
        if (cellObj.syncLocked && !cellObj._inSyncScrub) syncScrubToPeers(cellObj, video.currentTime);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        video.currentTime = Math.min(video.duration || 999999, video.currentTime + 10);
        if (cellObj.syncLocked && !cellObj._inSyncScrub) syncScrubToPeers(cellObj, video.currentTime);
      } else if (e.key === '[' || e.code === 'BracketLeft') {
        e.preventDefault();
        video.pause();
        video.currentTime = Math.max(0, video.currentTime - (1 / 25));
        if (cellObj.syncLocked && !cellObj._inSyncScrub) syncScrubToPeers(cellObj, video.currentTime);
      } else if (e.key === ']' || e.code === 'BracketRight') {
        e.preventDefault();
        video.pause();
        video.currentTime = Math.min(video.duration || 999999, video.currentTime + (1 / 25));
        if (cellObj.syncLocked && !cellObj._inSyncScrub) syncScrubToPeers(cellObj, video.currentTime);
      } else if (e.code === 'KeyM') {
        e.preventDefault();
        video.muted = !video.muted;
        syncVolumeUI();
      } else if (e.code === 'KeyS') {
        e.preventDefault();
        triggerSnapshot();
      } else if (e.code === 'KeyF') {
        e.preventDefault();
        toggleCellFocus();
      } else if (e.code === 'KeyL') {
        e.preventDefault();
        video.loop = !video.loop;
        loopBtn?.classList.toggle('is-active', video.loop);
      }
    });
    cell.tabIndex = 0;
  }

  // Bunkr owns its recovery lifecycle; generic iframe fallback must not race it.
  function isBunkrPlayback(item) {
    try { return item.provider === 'bunkr' || /(^|\.)(bunkr\.[a-z]+|bunkrr\.pics)$/i.test(new URL(item.watchUrl || item.url, location.href).hostname); }
    catch { return false; }
  }

  function bunkrBufferAhead(video) {
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) return video.buffered.end(i) - video.currentTime;
    }
    return 0;
  }

  function bunkrProxyUrl(direct, watch) {
    if (typeof location !== 'undefined' && location.protocol === 'https:' && typeof direct === 'string' && /^https:\/\//i.test(direct)) {
      return direct;
    }
    return `http://127.0.0.1:${CONFIG.DEFAULT_NEXUS_PORT}/api/v1/video_proxy?` + new URLSearchParams({ url: direct, referer: watch, upstream_timeout: '12' });
  }

  class BunkrPlaybackController {
    constructor(cell) {
      this.cell = cell; this.video = cell.video; this.item = cell.item;
      this.watch = this.item.watchUrl || this.item.url;
      this.dead = false; this.wantPlay = true; this.swapping = false;
      this.lastTime = this.video.currentTime; this.lastAdvance = Date.now();
      this.listeners = []; this.requests = new Set(); this.recovery = null;
      this.nativeGeneration = 0;
    }
    alive() { return !this.dead && this.cell.element.isConnected && activeCells.includes(this.cell); }
    listen(event, fn) { this.video.addEventListener(event, fn); this.listeners.push([event, fn]); }
    status(message) { if (this.alive()) { this.cell.loader.textContent = message; this.cell.loader.style.display = 'block'; } }
    async fresh() {
      // Coalesce the eight failing workers for this cell, never across cells.
      if (this.refreshing) return this.refreshing;
      this.refreshing = (async () => {
        const direct = this.item.type === 'nexus_album'
          ? await this.resolveAlbumStream(true)
          : await resolveBunkrDirect(this.watch, { force: true });
        if (!direct) throw new Error('Bunkr nevrátil čerstvý stream.');
        if (!this.alive()) throw new Error('Bunkr cell closed');
        this.direct = direct; this.item.directUrl = direct; this.item.isResolved = true;
        return direct;
      })();
      try { return await this.refreshing; } finally { this.refreshing = null; }
    }
    async resolveAlbumStream(force = false) {
      if (!force && this.item.albumStreamUrl) return this.item.albumStreamUrl;
      const params = new URLSearchParams({ url: this.watch, refresh: force ? '1' : '0', _: String(Date.now()) });
      const response = await fetch(`/api/v1/meta-preview?${params}`, {
        cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(45000)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok || !/^https?:\/\//i.test(data.stream_url || '')) {
        throw new Error(data.message || `HTTP ${response.status}`);
      }
      this.item.albumStreamUrl = data.stream_url;
      return data.stream_url;
    }
    async start() {
      this.video.muted = true; updateCellMuteIcon(this.cell, true);
      this.listen('play', () => { this.wantPlay = true; this.lastAdvance = Date.now(); });
      this.listen('pause', () => { if (!this.swapping && !this.video.error) this.wantPlay = false; });
      this.listen('seeking', () => { this.lastAdvance = Date.now(); this.engine?.seek(); });
      this.listen('waiting', () => {
        this.cell.stalls++; if (this.cell.diagStalls) this.cell.diagStalls.textContent = this.cell.stalls;
      });
      this.tPlayStart = performance.now();
      this.listen('playing', () => {
        this.lastAdvance = Date.now(); this.cell.loader.style.display = 'none';
        this.video.style.display = 'block';
        const controls = this.cell.element.querySelector('.nuss-pro-controls'); if (controls) controls.style.display = 'flex';
        const firstFrame = performance.now() - this.tPlayStart;
        console.log(`[Nexus Split FastStart] Bunkr playing: first frame = ${firstFrame.toFixed(0)} ms`);
        if (this.cell.diagHud) {
          const badge = this.cell.diagHud.querySelector('.bunkr-fast-badge') || document.createElement('div');
          badge.className = 'bunkr-fast-badge';
          badge.style.cssText = 'color:#a855f7;font-weight:700;font-size:11px;';
          badge.textContent = `⚡ 1st frame: ${firstFrame.toFixed(0)}ms`;
          if (!badge.isConnected) this.cell.diagHud.prepend(badge);
        }
      });
      this.listen('error', () => { if (!this.swapping) void this.recover('media'); });
      // Start the watchdog before resolution so failed startup can retry as well.
      this.timer = setInterval(() => this.tick(), 200);
      this.status('Načítavam Bunkr cez Nexus Proxy…');
      this.initializing = true;
      try {
        this.direct = this.item.type === 'nexus_album'
          ? await this.resolveAlbumStream()
          : await resolveBunkrDirect(this.watch);
        if (!this.direct) throw new Error('Bunkr stream unavailable');
        if (!this.alive()) return;
        this.item.directUrl = this.direct; this.item.isResolved = true;
        this.nativeSwap();
      } catch (error) { this.status('Bunkr nedostupný · obnovujem stream…'); }
      finally { this.initializing = false; }
    }
    play() {
      if (!this.alive() || !this.wantPlay) return;
      this.video.play().catch(error => {
        if (!this.alive() || error.name === 'AbortError') return;
        if (error.name === 'NotAllowedError') { this.wantPlay = false; this.status('Klikni na Play pre spustenie videa.'); }
        else void this.recover('play');
      });
    }
    tick() {
      if (!this.alive()) { this.destroy(); return; }
      const v = this.video, now = Date.now();
      if (Math.abs(v.currentTime - this.lastTime) > 0.025) { this.lastTime = v.currentTime; this.lastAdvance = now; }
      if (this.initializing || this.swapping || !this.wantPlay || v.ended || v.seeking) return;
      if ((v.readyState < 3 || bunkrBufferAhead(v) < 2.5) && now - this.lastAdvance >= 1200) void this.recover('stall');
    }
    nativeSwap() {
      if (!this.alive()) return;
      const v = this.video;
      // Keep the original snapshot through failed metadata loads.
      const state = this.pendingState || { time: v.currentTime || 0, volume: v.volume, muted: v.muted, rate: v.playbackRate, paused: !this.wantPlay };
      this.pendingState = state; this.swapping = true; this.lastAdvance = Date.now();
      const generation = ++this.nativeGeneration;
      if (this.metadataHandler) v.removeEventListener('loadedmetadata', this.metadataHandler);
      clearTimeout(this.swapTimer);
      this.metadataHandler = () => {
        if (!this.alive() || generation !== this.nativeGeneration) return;
        clearTimeout(this.swapTimer); this.swapping = false;
        v.volume = state.volume; v.muted = state.muted; v.playbackRate = state.rate;
        v.currentTime = Number.isFinite(v.duration) ? Math.min(state.time, Math.max(0, v.duration - 0.05)) : state.time;
        this.pendingState = null; this.lastAdvance = Date.now();
        if (this.wantPlay && !state.paused) this.play();
      };
      v.addEventListener('loadedmetadata', this.metadataHandler, { once: true });
      this.swapTimer = setTimeout(() => { if (generation === this.nativeGeneration) { this.swapping = false; void this.recover('metadata timeout'); } }, 8000);
      v.preload = 'auto'; v.src = bunkrProxyUrl(this.direct, this.watch); v.load();
    }
    async recover(reason) {
      if (!this.alive() || this.recovery || this.initializing) return this.recovery;
      this.recovery = (async () => {
        try {
          await this.fresh();
          if (!this.alive()) return;
          if (this.engine?.ready) {
            // Preserve SourceBuffers: refreshed URL supplies the same file bytes.
            this.engine.wake();
          } else this.nativeSwap();
        } catch (error) { this.status('Bunkr nedostupný · skúšam čerstvý stream…'); }
        finally { this.lastAdvance = Date.now(); }
      })();
      try { await this.recovery; } finally { this.recovery = null; }
    }
    engineFailed(error) {
      console.warn('[Bunkr] MSE failed; preserving position through native proxy:', error);
      this.engine?.destroy(); this.engine = null;
      this.nativeSwap();
    }
    async range(start, end) {
      const abort = new AbortController(); this.requests.add(abort);
      const timer = setTimeout(() => abort.abort(), 2000);
      try {
        const response = await fetch(bunkrProxyUrl(this.direct, this.watch), { headers: { Range: `bytes=${start}-${end}` }, signal: abort.signal, cache: 'no-store' });
        if (response.status !== 206) { await response.body?.cancel(); throw new Error(`Bunkr Range HTTP ${response.status}`); }
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
        if (!match || Number(match[1]) !== start || Number(match[2]) > end) { await response.body?.cancel(); throw new Error('Invalid Bunkr Content-Range'); }
        const data = await response.arrayBuffer();
        if (data.byteLength !== Number(match[2]) - start + 1) throw new Error('Truncated Bunkr range');
        return { data, total: Number(match[3]) };
      } finally { clearTimeout(timer); this.requests.delete(abort); }
    }
    abortRanges() { for (const request of this.requests) request.abort(); this.requests.clear(); }
    destroy() {
      if (this.dead) return;
      this.dead = true; clearInterval(this.timer); clearTimeout(this.swapTimer);
      this.abortRanges(); this.engine?.destroy();
      for (const [event, fn] of this.listeners) this.video.removeEventListener(event, fn);
      if (this.metadataHandler) this.video.removeEventListener('loadedmetadata', this.metadataHandler);
    }
  }

  class BunkrPrefetchEngine {
    constructor(owner) {
      this.owner = owner; this.video = owner.video; this.dead = false; this.ready = false;
      this.offset = 0; this.total = 0; this.buffers = new Map(); this.epoch = 0;
      this.chunkSize = 1024 * 1024; this.connections = 2; this.targetAhead = 45;
      this.maxBatchBytes = 4 * 1024 * 1024; this.pendingBytes = 0;
    }
    async start() {
      let timeout;
      try { await Promise.race([loadMp4BoxLib(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('MP4Box timeout')), 5000); })]); }
      finally { clearTimeout(timeout); }
      if (this.dead || !this.owner.alive()) throw new Error('Closed');
      this.media = new MediaSource(); this.objectUrl = URL.createObjectURL(this.media);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('MediaSource timeout')); }, 2000);
        const opened = () => { cleanup(); resolve(); };
        const cleanup = () => { clearTimeout(timer); this.media.removeEventListener('sourceopen', opened); };
        this.media.addEventListener('sourceopen', opened);
        this.video.src = this.objectUrl; this.video.load();
      });
      if (this.dead || !this.owner.alive()) throw new Error('Closed');
      this.file = window.MP4Box.createFile();
      this.file.onError = error => { this.failure = new Error(String(error)); };
      this.file.onReady = info => {
        try {
          this.duration = info.duration / info.timescale;
          this.media.duration = this.duration;
          const tracks = info.tracks.filter(track => track.video || track.audio);
          if (!tracks.some(track => track.video)) throw new Error('No video track');
          for (const track of tracks) {
            const mime = `${track.video ? 'video' : 'audio'}/mp4; codecs="${track.codec}"`;
            if (!MediaSource.isTypeSupported(mime)) throw new Error(`Unsupported ${track.codec}`);
            const sb = this.media.addSourceBuffer(mime), entry = { sb, queue: [] };
            this.buffers.set(track.id, entry);
            sb.addEventListener('updateend', () => this.drain(entry));
            sb.addEventListener('error', () => { this.failure = new Error('SourceBuffer decode failure'); });
            this.file.setSegmentOptions(track.id, entry, { nbSamples: track.video ? 30 : 48 });
          }
          this.file.onSegment = (id, entry, data, sample) => {
            this.pendingBytes += data.byteLength;
            entry.queue.push({ data, id, sample }); this.drain(entry);
          };
          for (const init of this.file.initializeSegmentation()) {
            const entry = this.buffers.get(init.id); this.pendingBytes += init.buffer.byteLength;
            entry.queue.push({ data: init.buffer }); this.drain(entry);
          }
          this.ready = true; this.file.start();
        } catch (error) { this.failure = error; }
      };
      // Check for instant play from BunkrFastStart warm cache
      const warmEntry = (window.NexusBunkrFastStart && typeof window.NexusBunkrFastStart.getWarmEntry === 'function')
        ? window.NexusBunkrFastStart.getWarmEntry(this.owner.item) : null;
      if (warmEntry && warmEntry.status === 'ready' && warmEntry.bytes && warmEntry.bytes.byteLength > 0) {
        console.log('[Nexus Split] Instant play from Bunkr warm cache!');
        this.total = warmEntry.total;
        const warmBuf = warmEntry.bytes.slice(0).buffer;
        warmBuf.fileStart = 0;
        const next = this.file.appendBuffer(warmBuf);
        this.offset = Number.isFinite(next) ? next : warmBuf.byteLength;
      }

      // appendBuffer returns the next required box offset, including tail moov.
      for (let probe = 0; !this.ready && probe < 16; probe++) {
        if (this.dead) throw new Error('Closed');
        const fetchSize = (probe === 0 && !this.offset) ? 3.5 * 1024 * 1024 : this.chunkSize;
        const result = await this.owner.range(this.offset, this.offset + fetchSize - 1);
        if (this.dead) throw new Error('Closed');
        this.total = result.total; result.data.fileStart = this.offset;
        const next = this.file.appendBuffer(result.data);
        this.offset = Number.isFinite(next) ? next : this.offset + result.data.byteLength;
        if (this.failure) throw this.failure;
      }
      if (!this.ready) throw new Error('MP4 metadata unavailable');
      // Keep appendBuffer's requested offset. Seeking back over the bootstrap
      // range creates overlapping input buffers in MP4Box 0.5 and can strand
      // extraction after the first few seconds of a tail-moov file.
      this.timer = setInterval(() => { void this.pump(); }, 200); this.wake();
    }
    drain(entry) {
      if (this.dead || entry.sb.updating || this.media.readyState !== 'open') return;
      const trim = this.video.currentTime - 15;
      if (entry.sb.buffered.length && entry.sb.buffered.start(0) < trim - 5) { entry.sb.remove(0, trim); return; }
      const next = entry.queue[0]; if (!next) return;
      try {
        entry.sb.appendBuffer(next.data); entry.queue.shift(); this.pendingBytes -= next.data.byteLength;
        if (next.id != null) this.file.releaseUsedSamples(next.id, next.sample);
      } catch (error) {
        if (error.name === 'QuotaExceededError' && trim > 0) { entry.sb.remove(0, trim); }
        else this.failure = error;
      }
    }
    wake() { if (!this.dead) void this.pump(); }
    seek() {
      if (!this.ready || this.dead || bunkrBufferAhead(this.video) > 0) return;
      this.epoch++; this.owner.abortRanges();
      this.flushed = false;
      this.offset = this.file.seek(this.video.currentTime, true).offset;
      this.wake();
    }
    async pump() {
      if (this.dead || this.busy || !this.owner.alive() || !this.owner.wantPlay) return;
      if (this.failure) { this.owner.engineFailed(this.failure); return; }
      if (this.offset >= this.total) {
        if (!this.flushed) { this.flushed = true; this.file.flush(); }
        if ([...this.buffers.values()].every(entry => !entry.queue.length && !entry.sb.updating) && this.media.readyState === 'open') this.media.endOfStream();
        return;
      }
      const ahead = bunkrBufferAhead(this.video);
      if (ahead >= this.targetAhead || this.pendingBytes > 16 * 1024 * 1024) return;
      this.busy = true; const epoch = this.epoch;
      const bytesPerSecond = this.total / this.duration;
      const wanted = Math.min(this.maxBatchBytes, Math.max(this.chunkSize, (this.targetAhead - ahead) * bytesPerSecond));
      const count = Math.min(this.connections, Math.ceil(wanted / this.chunkSize), Math.ceil((this.total - this.offset) / this.chunkSize));
      const base = this.offset;
      try {
        const results = await Promise.allSettled(Array.from({ length: count }, (_, i) => {
          const start = base + i * this.chunkSize;
          return this.owner.range(start, Math.min(this.total - 1, start + this.chunkSize - 1));
        }));
        if (this.dead || epoch !== this.epoch) return;
        let failed = false;
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result.status === 'rejected') { failed = true; break; }
          if (result.value.total !== this.total) throw new Error('Bunkr file size changed');
          const data = result.value.data; data.fileStart = base + i * this.chunkSize;
          this.file.appendBuffer(data); this.offset = data.fileStart + data.byteLength;
        }
        if (failed) await this.owner.recover('range');
      } catch (error) { this.failure = error; }
      finally { this.busy = false; }
    }
    destroy() {
      if (this.dead) return; this.dead = true; this.epoch++; clearInterval(this.timer);
      this.owner.abortRanges(); this.file?.stop();
      if (this.file) { this.file.onReady = null; this.file.onSegment = null; this.file.onError = null; }
      for (const entry of this.buffers.values()) entry.queue.length = 0;
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    }
  }

  async function startCellPlayback(cellObj) {
    const { video, iframe, loader, item } = cellObj;

    if (CONFIG.BUNKR_AGGRESSIVE_STREAMING && isBunkrPlayback(item)) {
      item.provider = 'bunkr';
      cellObj.bunkrController?.destroy();
      cellObj.bunkrController = new BunkrPlaybackController(cellObj);
      await cellObj.bunkrController.start();
      return;
    }

    const isEpornerPlayback = isEpornerUrl(item.watchUrl || item.url);
    if (isEpornerPlayback && !item.epornerQualityResolved) {
      item.directUrl = '';
      item.isResolved = false;
    }

    // On-Demand Stream Resolver: Ak video ešte nemá zistený priamy odkaz (napr. Bunkr / Turbo karta, Eporner, XVideos)
    if (!isEpornerPlayback && !item.isResolved && !item.isIframe && /^(?:mp4|webm|hls|dash)$/.test(item.type || '')) {
      item.directUrl = item.directUrl || item.url;
      item.isResolved = true;
    }
    if ((!item.isResolved || (isEpornerPlayback && !item.epornerQualityResolved)) && !item.isIframe) {
      loader.textContent = 'Zisťujem priamy stream…';
      try {
        const resolvedUrl = await resolveStreamUrl(item);
        if (resolvedUrl && item.isResolved) {
          item.directUrl = resolvedUrl;

          const dlBtn = cellObj.element.querySelector('a[download]');
          if (dlBtn) dlBtn.href = resolvedUrl;
        }
      } catch (err) {
        console.warn('[Nexus Split] Chyba pri zisťovaní streamu:', err);
      }
      if (!item.isResolved || !item.directUrl) {
        loader.style.display = 'block';
        loader.textContent = 'Video zdroj sa nepodarilo načítať. Otvor príspevok a skontroluj prístup.';
        return;
      }
    }

    if (!cellObj.element.isConnected || !activeCells.includes(cellObj)) return;
    const format = item.type || detectFormat(item.url);
    const url = item.directUrl || item.url;

    // Iframe embed (napr. Byse /embed_proxy z Quantum Search) musí ísť priamo do iframe pred nastavením video eventov
    if (item.isIframe || format === 'iframe') {
      loader.style.display = 'none';
      video.style.display = 'none';
      const pro = cellObj.element.querySelector('.nuss-pro-controls');
      if (pro) pro.style.display = 'none';
      iframe.style.display = 'block';
      iframe.src = url;
      return;
    }

    video.muted = true;
    updateCellMuteIcon(cellObj, video.muted);

    const playStartTime = performance.now();
    const onPlayReady = () => {
      loader.style.display = 'none';
      video.style.display = 'block';
      const pro = cellObj.element.querySelector('.nuss-pro-controls');
      if (pro) pro.style.display = 'flex';
      if (!cellObj.ttffMs) {
        cellObj.ttffMs = Math.round(performance.now() - playStartTime);
        console.log(`[Nexus Split] TTFF for cell: ${cellObj.ttffMs}ms`);
      }
    };

    video.addEventListener('playing', onPlayReady);
    video.addEventListener('canplay', onPlayReady);
    video.addEventListener('waiting', () => {
      cellObj.stalls++;
      if (cellObj.diagStalls) cellObj.diagStalls.textContent = cellObj.stalls;
    });

    let usesHlsJs = false;

    // Pixeldrain: native range playback handles both front- and tail-moov files.
    // The old MSE bootstrap waited forever when moov was outside its first 1 MB.
    if (format === 'pixeldrain') {
      loader.textContent = 'Načítavam Pixeldrain video…';
      if (cellObj.diagQuotaRow) cellObj.diagQuotaRow.style.display = 'none';
      video.preload = 'metadata';
      video.src = toPixeldrainDirectUrl(url);
    }
    // 1. Spracovanie HLS (.m3u8)
    else if (format === 'hls') {
      try {
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
        } else {
          const Hls = await loadHlsLib();
          if (!cellObj.element.isConnected || !activeCells.includes(cellObj)) return;
          if (Hls && Hls.isSupported()) {
            usesHlsJs = true;
            const hls = new Hls({ maxBufferLength: 30, enableWorker: true });
            cellObj.hlsInstance = hls;
            if (Hls.Events) {
              hls.on?.(Hls.Events.MANIFEST_PARSED, () => {
                video.muted = true;
                updateCellMuteIcon(cellObj, true);
                video.play().catch(() => {});
              });
              hls.on?.(Hls.Events.ERROR, (_evt, data) => {
                if (!data?.fatal) return;
                if (Hls.ErrorTypes && data.type === Hls.ErrorTypes.MEDIA_ERROR && typeof hls.recoverMediaError === 'function' && !cellObj._hlsMediaRecovered) {
                  cellObj._hlsMediaRecovered = true;
                  hls.recoverMediaError();
                  return;
                }
                try { hls.destroy(); } catch {}
                cellObj.hlsInstance = null;
                fallbackToProxyOrIframe(cellObj);
              });
            }
            hls.loadSource(url);
            hls.attachMedia(video);
          } else {
            video.src = url;
          }
        }
      } catch (err) {
        console.warn('[Nexus Split] HLS zlyhalo, prepínam na fallback:', err);
        fallbackToProxyOrIframe(cellObj);
        return;
      }
    }
    // 2. Spracovanie DASH (.mpd)
    else if (format === 'dash') {
      try {
        const dashjs = await loadDashLib();
        const player = dashjs.MediaPlayer().create();
        player.initialize(video, url, true);
        cellObj.dashInstance = player;
      } catch (err) {
        console.warn('[Nexus Split] DASH zlyhalo:', err);
        fallbackToProxyOrIframe(cellObj);
        return;
      }
    }
    // 3. Priame MP4 / WebM / Direct stream (Range HTTP/2)
    else {
      video.src = url;
    }

    // Spustenie prehrávania
    if (usesHlsJs) {
      video.play().catch(() => {
        video.muted = true;
        updateCellMuteIcon(cellObj, true);
      });
    } else if (format !== 'pixeldrain' || !cellObj.pixeldrainEngine) {
      video.play().catch(async () => {
        video.muted = true;
        updateCellMuteIcon(cellObj, true);
        video.play().catch(() => {
          fallbackToProxyOrIframe(cellObj);
        });
      });
    } else {
      video.play().catch(async () => {
        video.muted = true;
        updateCellMuteIcon(cellObj, true);
        video.play().catch(() => {});
      });
    }

    video.onerror = () => {
      if (format === 'pixeldrain') {
        loader.style.display = 'flex';
        loader.textContent = video.error?.code === 4
          ? 'Tento formát alebo kodek prehliadač nepodporuje.'
          : 'Pixeldrain video sa nepodarilo načítať. Skontroluj prístup a download limit.';
        console.warn('[Nexus Split] Pixeldrain native playback failed:', video.error);
        return;
      }
      if (usesHlsJs && cellObj.hlsInstance) return;
      console.warn('[Nexus Split] Video tag error, skúšam Nexus Proxy / iframe...');
      fallbackToProxyOrIframe(cellObj);
    };
  }

  // ---------------------------------------------------------------------------
  // 6. LOKÁLNY NEXUS PROXY FALLBACK (PORT 8000)
  // ---------------------------------------------------------------------------
  async function fallbackToProxyOrIframe(cellObj) {
    if (cellObj.item.type === 'pixeldrain') {
      console.warn('[Nexus Split] Pixeldrain: Blokujem iframe fallback pre ochranu 6GB kvóty.');
      return;
    }
    const { video, iframe, loader, item } = cellObj;
    if (cellObj._fallbackStarted) return;
    cellObj._fallbackStarted = true;

    const streamUrl = String(item.directUrl || item.url || '');
    const isLocalProxy = /^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)?\/(?:hls_proxy|hls_proxy\.m3u8|media_proxy\.mp4|embed_proxy|e\/[A-Za-z0-9_-]+|api\/v1\/video_proxy|api\/v1\/tools\/stream-proxy|stream_proxy\/)/i.test(streamUrl);
    if (isLocalProxy) {
      if (item.isIframe || /^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)?\/(?:embed_proxy|e\/)/i.test(streamUrl)) {
        loader.style.display = 'none';
        video.style.display = 'none';
        iframe.style.display = 'block';
        iframe.src = streamUrl;
        return;
      }
      loader.style.display = 'flex';
      loader.textContent = 'Stream sa nepodarilo prehrať. Skús znova načítať alebo otvoriť pôvodný zdroj.';
      return;
    }

    loader.textContent = 'Skúšam Nexus Local Proxy…';
    const proxyPath = item.type === 'hls' ? '/api/v1/tools/stream-proxy' : '/api/v1/video_proxy';
    const proxyUrl = item.fallbackUrl || `http://127.0.0.1:${CONFIG.DEFAULT_NEXUS_PORT}${proxyPath}?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(item.watchUrl || item.url)}`;

    try {
      // Overenie, či lokálny backend beží
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 800);
      const probe = await fetch(`http://127.0.0.1:${CONFIG.DEFAULT_NEXUS_PORT}/api/v1/health`, {
        method: 'GET',
        signal: controller.signal
      }).catch(() => null).finally(() => clearTimeout(timeout));
      if (probe && probe.ok) {
        if (item.type === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
          try {
            const Hls = await loadHlsLib();
            if (Hls && Hls.isSupported()) {
              try { cellObj.hlsInstance?.destroy(); } catch {}
              const hls = new Hls({ maxBufferLength: 30, enableWorker: true });
              cellObj.hlsInstance = hls;
              hls.loadSource(proxyUrl);
              hls.attachMedia(video);
              video.play().catch(() => {});
              return;
            }
          } catch {}
        }
        video.src = proxyUrl;
        video.play().catch(() => switchToIframe(cellObj));
        return;
      }
    } catch {}

    switchToIframe(cellObj);
  }

  function switchToIframe(cellObj) {
    const targetUrl = cellObj.item.watchUrl || cellObj.item.url;
    if (isFrameBlockedWatchUrl(targetUrl)) {
      cellObj.loader.style.display = 'flex';
      cellObj.loader.textContent = 'Prehrávanie zlyhalo (stránka blokuje priame vloženie do iframe).';
      return;
    }
    cellObj.loader.style.display = 'none';
    cellObj.video.style.display = 'none';
    cellObj.iframe.style.display = 'block';
    cellObj.iframe.src = targetUrl;
  }

  // ---------------------------------------------------------------------------
  // 7. MASTER CLOCK & DRIFT SYNC ENGINE
  // ---------------------------------------------------------------------------
  function startDriftSyncEngine() {
    clearInterval(driftSyncTimer);
    driftSyncTimer = setInterval(() => {
      // Only explicitly locked peers synchronize. Independent videos retain
      // their chosen speed instead of being forced to 0.95/1.05/1 every 2 s.
      for (const c of activeCells) {
        if (!c.syncLocked && c._driftAdjusted) {
          c.video.playbackRate = c.userPlaybackRate || 1;c._driftAdjusted = false;
        }
      }
      const peers = activeCells.filter(c => c.syncLocked && c.video && !c.video.paused && c.video.readyState >= 2);
      if (peers.length < 2) return;
      const avgTime = peers.reduce((sum,c)=>sum+c.video.currentTime,0)/peers.length;
      peers.forEach(c => {
        const diff=c.video.currentTime-avgTime, base=c.userPlaybackRate || 1;
        c.video.playbackRate = base * (Math.abs(diff)>0.25 && Math.abs(diff)<2.5 ? (diff>0 ? .95 : 1.05) : 1);
        c._driftAdjusted = true;
      });
    }, 2000);
  }

  // ---------------------------------------------------------------------------
  // 8. DIAGNOSTICKÝ HUD & POLLING
  // ---------------------------------------------------------------------------
  function startDiagnosticPolling() {
    clearInterval(diagTimer);
    diagTimer = setInterval(() => {
      if (!diagVisible || document.visibilityState === 'hidden') return;
      const recentResources = performance.getEntriesByType('resource').slice(-10).reverse();
      activeCells.forEach((c) => {
        const v = c.video;
        if (!v || v.style.display === 'none') return;

        // 1. Buffered Ahead
        let ahead = 0;
        const cur = v.currentTime || 0;
        for (let i = 0; i < v.buffered.length; i++) {
          if (v.buffered.start(i) <= cur && v.buffered.end(i) >= cur) {
            ahead = Math.max(0, v.buffered.end(i) - cur);
            break;
          }
        }
        if (c.diagBuf) {
          c.diagBuf.textContent = ahead.toFixed(1) + ' s';
          c.diagBuf.className = 'nuss-diag-val ' + (ahead < 2 ? 'bad' : ahead < 6 ? 'warn' : '');
        }

        // 2. Dropped frames
        if (c.diagDrop && v.getVideoPlaybackQuality) {
          const q = v.getVideoPlaybackQuality();
          c.diagDrop.textContent = q.droppedVideoFrames || 0;
          if (q.droppedVideoFrames > 30) c.diagDrop.className = 'nuss-diag-val bad';
        }

        // 3. Odhad rýchlosti z Performance API
        if (c.diagSpeed) {
          try {
            const res = recentResources.find((e) => e.name.includes(c.item.url.slice(0, 30)));
            if (res && res.transferSize && res.duration > 0) {
              const mbps = ((res.transferSize * 8) / (res.duration / 1000) / 1000000).toFixed(1);
              c.diagSpeed.textContent = mbps + ' Mb/s';
            }
          } catch {}
        }
      });
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // 9. LAYOUTY & OVLÁDANIE
  // ---------------------------------------------------------------------------
  function applyGridLayout() {
    const stage = document.getElementById('nuss-grid-stage');
    const n = activeCells.length;
    let cols = 2, rows = 2;

    if (layoutMode === 'row') {
      cols = n; rows = 1;
    } else if (layoutMode === 'grid2') {
      cols = 2; rows = Math.ceil(n / 2);
    } else if (layoutMode === 'grid3' || layoutMode === 'grid3x2') {
      cols = 3; rows = Math.ceil(n / 3);
    } else if (layoutMode === 'grid3x3') {
      cols = 3; rows = 3;
    } else if (layoutMode === 'grid4x2') {
      cols = 4; rows = 2;
    } else if (layoutMode === 'grid4x3') {
      cols = 4; rows = 3;
    } else {
      // Auto adaptácia pre 1 až 12 videí
      if (n <= 1) { cols = 1; rows = 1; }
      else if (n === 2) { cols = 2; rows = 1; }
      else if (n === 3) { cols = 3; rows = 1; }
      else if (n === 4) { cols = 2; rows = 2; }
      else if (n <= 6) { cols = 3; rows = 2; }
      else if (n <= 8) { cols = 4; rows = 2; }
      else if (n <= 9) { cols = 3; rows = 3; }
      else { cols = 4; rows = Math.ceil(n / 4); }
    }

    stage.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    stage.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
    stage.dataset.fit = fitMode;

    overlayEl.querySelectorAll('[data-layout]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.layout === layoutMode);
    });
  }

  function handleOverlayControls(e) {
    const btn = e.target.closest('[data-act], [data-layout]');
    if (!btn) return;

    if (btn.dataset.layout) {
      layoutMode = btn.dataset.layout;
      localStorage.setItem('nuss_layout', layoutMode);
      applyGridLayout();
      return;
    }

    const act = btn.dataset.act;
    const vids = activeCells.map((c) => c.video).filter(Boolean);

    if (act === 'help') {
      alert('Skratky vybraného videa: medzerník – prehrávanie, šípky – posun o 10 s, [ / ] – snímka, M – zvuk, S – snímka, F – focus, L – slučka. H – skryť alebo obnoviť ovládanie, Esc – späť.');
    } else if (act === 'saveScene') {
      const scene = activeCells.map(c => ({ url: c.item.watchUrl || c.item.url, time: c.video.currentTime }));
      localStorage.setItem('nuss_scene', JSON.stringify(scene));
      showToast(_t('🔖 Scéna uložená', '🔖 Scene saved'));
    } else if (act === 'loadScene') {
      try {
        const scene = JSON.parse(localStorage.getItem('nuss_scene') || '[]');
        let count = 0;
        activeCells.forEach(c => { const entry = scene.find(s => s.url === (c.item.watchUrl || c.item.url)); if (entry && Number.isFinite(entry.time)) { c.video.currentTime = entry.time; count++; } });
        showToast(count ? _t(`↶ Obnovené videá: ${count}`, `↶ Restored videos: ${count}`) : _t('Žiadne z otvorených videí nie je v uloženej scéne', 'None of the opened videos are in the saved scene'));
      } catch { showToast('⚠️ Scénu sa nepodarilo obnoviť'); }
    } else if (act === 'toggleFullscreen') {
      if (document.fullscreenElement === overlayEl) {
        document.exitFullscreen().catch(() => showToast('⚠️ Fullscreen sa nepodarilo ukončiť.'));
      } else if (!document.fullscreenElement && overlayEl.requestFullscreen) {
        overlayEl.requestFullscreen().catch(() => showToast('⚠️ Prehliadač nepovolil fullscreen.'));
      } else {
        showToast('⚠️ Najprv ukonči aktuálny fullscreen.');
      }
    } else if (act === 'toggleClean') {
      setCleanMode(!overlayEl.classList.contains('nuss-clean'));
    } else if (act === 'playAll') {
      vids.forEach((v) => v.play().catch(() => {}));
    } else if (act === 'pauseAll') {
      vids.forEach((v) => v.pause());
    } else if (act === 'syncStart') {
      vids.forEach((v) => { v.currentTime = 0; v.play().catch(() => {}); });
    } else if (act === 'stepBack') {
      vids.forEach((v) => { v.currentTime = Math.max(0, v.currentTime - 10); });
    } else if (act === 'stepFwd') {
      vids.forEach((v) => { v.currentTime += 10; });
    } else if (act === 'muteAll') {
      vids.forEach((v) => { v.muted = true; });
      activeCells.forEach((c) => updateCellMuteIcon(c, true));
    } else if (act === 'toggleSyncScrubAll') {
      toggleSyncScrubAll();
    } else if (act === 'saveAllToVault') {
      saveAllActiveToNexusVault();
    } else if (act === 'toggleFit') {
      fitMode = fitMode === 'contain' ? 'cover' : 'contain';
      localStorage.setItem('nuss_fit', fitMode);
      applyGridLayout();
    } else if (act === 'toggleDiag') {
      diagVisible = !diagVisible;
      overlayEl.classList.toggle('show-diag', diagVisible);
      btn.classList.toggle('is-active', diagVisible);
    } else if (act === 'closeOverlay') {
      closeSplitScreen();
    }

    // Akcie v bunke (Mute, Solo, Remove, Lock Sync, Save to Vault)
    const cellEl = e.target.closest('.nuss-cell');
    if (cellEl) {
      const cellObj = activeCells.find((c) => c.element === cellEl);
      if (!cellObj) return;

      if (act === 'select-cell') {
        const selected = cellEl.classList.contains('nuss-selected');
        overlayEl.querySelectorAll('.nuss-selected').forEach(el => el.classList.remove('nuss-selected'));
        cellObj.setZoomPanSelected?.(!selected);
        if (!selected) cellEl.classList.add('nuss-selected');
      } else if (act === 'toggle-lock-sync') {
        cellObj.syncLocked = !cellObj.syncLocked;
        btn.classList.toggle('is-active', cellObj.syncLocked);
        updateTopBarSyncAllButton();
        showToast(cellObj.syncLocked ? `🔗 Bunka #${cellObj.idx + 1} uzamknutá do Synchro-Scrub` : `🔓 Bunka #${cellObj.idx + 1} odomknutá zo Synchro-Scrub`);
      } else if (act === 'save-to-vault') {
        saveItemToNexusVault(cellObj.item, cellObj);
      } else if (act === 'mute') {
        cellObj.video.muted = !cellObj.video.muted;
        updateCellMuteIcon(cellObj, cellObj.video.muted);
      } else if (act === 'solo') {
        activeCells.forEach((c) => {
          const isThis = c === cellObj;
          c.video.muted = !isThis;
          updateCellMuteIcon(c, c.video.muted);
        });
      } else if (act === 'remove') {
        destroyCell(cellObj);
        activeCells = activeCells.filter((c) => c !== cellObj);
        cellEl.remove();
        updateTopBarSyncAllButton();
        if (activeCells.length === 0) closeSplitScreen();
        else applyGridLayout();
      }
    }
  }

  function setCleanMode(enabled) {
    overlayEl.classList.toggle('nuss-clean', enabled);
    overlayEl.querySelectorAll('.nuss-selected').forEach(el => el.classList.remove('nuss-selected'));
    zoomPanCell?.setZoomPanSelected?.(false);
  }

  function updateCellMuteIcon(cellObj, isMuted) {
    const btn = cellObj.element.querySelector('[data-act="mute"]');
    if (btn) {
      btn.textContent = isMuted ? '🔇' : '🔊';
      btn.classList.toggle('is-active', !isMuted);
    }
    const cellMuteBtn = cellObj.element.querySelector('[data-act="cell-mute"]');
    if (cellMuteBtn) {
      cellMuteBtn.textContent = isMuted ? '🔇' : (cellObj.video && cellObj.video.volume < 0.5 ? '🔉' : '🔊');
      cellMuteBtn.classList.toggle('is-active', !isMuted);
    }
    const volSlider = cellObj.element.querySelector('.nuss-pro-vol-slider');
    if (volSlider && cellObj.video) {
      volSlider.value = isMuted ? 0 : cellObj.video.volume;
    }
  }

  function destroyCell(c) {
    c.bunkrController?.destroy();
    try { if (c._activeRecorder && c._activeRecorder.state !== 'inactive') c._activeRecorder.stop(); } catch {}
    try { if (c.pixeldrainEngine) c.pixeldrainEngine.destroy(); } catch {}
    try { if (c.hlsInstance) c.hlsInstance.destroy(); } catch {}
    try { if (c.dashInstance) c.dashInstance.reset(); } catch {}
    try { c.video.pause(); c.video.removeAttribute('src'); c.video.load(); } catch {}
    if (c.iframe) c.iframe.src = 'about:blank';
  }

  function closeSplitScreen() {
    clearInterval(diagTimer);
    clearInterval(driftSyncTimer);
    zoomPanCell = null;
    activeCells.forEach(destroyCell);
    activeCells = [];
    if (overlayEl) {
      if (document.fullscreenElement && (document.fullscreenElement === overlayEl || overlayEl.contains(document.fullscreenElement))) {
        document.exitFullscreen().catch(() => {});
      }
      setCleanMode(false);
      overlayEl.style.display = 'none';
      const stage = document.getElementById('nuss-grid-stage');
      if (stage) stage.innerHTML = '';
    }
  }

  // Spustenie po načítaní stránky
  initUI();
})();
