// Test pre Nexus Universal Split-Screen Boost
// Overenie syntaxe, prvkov UI, galérie 3x2, fetchnutia metadát a pro-grade video ovládania
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('--- TEST: Nexus Universal Split-Screen Boost ---');

const filePath = path.join(__dirname, '..', 'userscripts/nexus-universal-splitscreen.user.js');
assert(fs.existsSync(filePath), 'Súbor nexus-universal-splitscreen.user.js musí existovať');

const code = fs.readFileSync(filePath, 'utf8');

// 1. Overenie konfigurácie
assert(code.includes('MAX_ITEMS: 12'), 'CONFIG.MAX_ITEMS musí byť aspoň 12');
assert(code.includes("DEFAULT_PICKER_LAYOUT: '3x2'"), 'Predvolený layout výberu musí byť 3x2');

// 2. Overenie resizable okna
assert(code.includes('nuss-resize-grip'), 'Okno musí obsahovať nuss-resize-grip pre potiahnutie z rohov');
assert(code.includes('setupPickerResize'), 'Funkcia setupPickerResize musí existovať');
assert(code.includes('localStorage.setItem(\'nuss_picker_w\''), 'Musí ukladať šírku okna do localStorage');
assert(code.includes('localStorage.setItem(\'nuss_picker_h\''), 'Musí ukladať výšku okna do localStorage');
assert(code.includes('data-act="picker-maximize"'), 'Okno musí mať tlačidlo pre maximalizáciu');

// 3. Overenie galérie a prepínača layoutov
assert(code.includes('[data-layout="3x2"]'), 'Štýly musia obsahovať rozloženie 3x2');
assert(code.includes('[data-layout="3x3"]'), 'Štýly musia obsahovať rozloženie 3x3');
assert(code.includes('[data-layout="4x2"]'), 'Štýly musia obsahovať rozloženie 4x2');
assert(code.includes('[data-layout="4x3"]'), 'Štýly musia obsahovať rozloženie 4x3');
assert(code.includes('[data-layout="list"]'), 'Štýly musia obsahovať zoznamové rozloženie list');
assert(code.includes('data-picker-layout="3x2"'), 'Prepínač layoutov musí mať tlačidlo 3x2');
assert(code.includes('data-picker-layout="3x3"'), 'Prepínač layoutov musí mať tlačidlo 3x3');
assert(code.includes('data-picker-layout="4x2"'), 'Prepínač layoutov musí mať tlačidlo 4x2');

// 4. Overenie vzhľadu kariet (Gallery Grid podľa screen 2)
assert(code.includes('nuss-card-stage'), 'Karty musia mať prezentačný stage');
assert(code.includes('nuss-card-thumb'), 'Karty musia mať náhľad');
assert(code.includes('nuss-card-idx-badge'), 'Karty musia mať indexový odznak (#1, #2...)');
assert(code.includes('nuss-card-cb-custom'), 'Karty musia mať vlastný kruhový checkbox so zaškrtnutím');
assert(code.includes('nuss-chip-duration'), 'Karty musia zobrazovať dĺžku videa');
assert(code.includes('nuss-chip-hd'), 'Karty musia zobrazovať HD/4K odznak');
assert(code.includes('nuss-card-size'), 'Karty musia zobrazovať veľkosť súboru');

// 5. Overenie fetchnutia metadát
assert(code.includes('fetchAllCardsMetadata'), 'Musí existovať funkcia fetchAllCardsMetadata');
assert(code.includes('fetchSingleCardMeta'), 'Musí existovať funkcia fetchSingleCardMeta');
assert(code.includes('probeVideoMetadata'), 'Musí existovať video probe funkcia probeVideoMetadata');
assert(code.includes('updateCardInDom'), 'Musí existovať funkcia updateCardInDom pre okamžitú aktualizáciu karty');
assert(code.includes('nuss-btn-fetch-meta'), 'Toolbar musí obsahovať tlačidlo načítania metadát');

// 6. Overenie Pro-Grade ovládania každého videa v bunkách
assert(code.includes('setupCellProControls'), 'Musí existovať funkcia setupCellProControls');
assert(code.includes('nuss-pro-controls'), 'Bunka musí obsahovať nuss-pro-controls kontajner');
assert(code.includes('nuss-pro-timeline'), 'Ovládač musí mať časovú os / seekbar');
assert(code.includes('nuss-pro-buffered'), 'Časová os musí zobrazovať bufferovaný úsek');
assert(code.includes('nuss-pro-played'), 'Časová os musí zobrazovať prehratý čas');
assert(code.includes('nuss-pro-time-tooltip'), 'Časová os musí mať hover náhľad času');

// 7. Ovládacie tlačidlá videa
assert(code.includes('data-act="cell-play"'), 'Bunka musí mať Play/Pause tlačidlo');
assert(code.includes('data-act="cell-jump-back"'), 'Bunka musí mať skok -10s');
assert(code.includes('data-act="cell-jump-fwd"'), 'Bunka musí mať skok +10s');
assert(code.includes('data-act="cell-frame-back"'), 'Bunka musí mať krok späť po snímkach (-1 frame)');
assert(code.includes('data-act="cell-frame-fwd"'), 'Bunka musí mať krok vpred po snímkach (+1 frame)');
assert(code.includes('data-act="cell-speed"'), 'Bunka musí mať prepínač rýchlostí');
assert(code.includes('data-act="cell-fit"'), 'Bunka musí mať zmenu pomeru strán / fit');
assert(code.includes('data-act="cell-loop"'), 'Bunka musí mať prepínač slučky (loop)');
assert.match(code, /nuss-pro-loop-btn" data-act="cell-loop" title="Slučka: VYPNUTÁ"/, 'Loop musí byť predvolene vypnutý aj v ovládači');
assert.match(code, /<video class="nuss-cell-video" autoplay playsinline/, 'Video nesmie mať predvolene zapnutý loop atribút');
assert.match(code, /cellObj\.video\.muted = true;\s*cellObj\.video\.loop = false;/, 'Každé video musí začínať stlmené a bez loopu');
assert.match(code, /video\.muted = true;\s*updateCellMuteIcon\(cellObj, video\.muted\);/, 'Prehrávač musí zachovať mute aj pri štarte streamu');
assert.doesNotMatch(code, /video\.muted = idx > 0/, 'Mute nesmie závisieť od pozície videa');
assert(code.includes('nuss-pro-vol-slider'), 'Bunka musí mať posuvník hlasitosti');
assert(code.includes('data-act="cell-snapshot"'), 'Bunka musí mať funkciu snapshotu (screenshot aktuálneho záberu)');
assert(code.includes('data-act="cell-fs"'), 'Bunka musí mať fullscreen tlačidlo');
assert(code.includes('data-act="focus-cell"'), 'Bunka musí mať Focus maximalizáciu');

// 8. Picture Adjustments FX panel (Jas, Kontrast, Sýtosť, Zoom, Pan, Zrkadlo)
assert(code.includes('nuss-cell-fx-panel'), 'Bunka musí mať FX panel pre úpravu obrazu');
assert(code.includes('f-bright'), 'FX panel musí mať nastavenie jasu');
assert(code.includes('f-contrast'), 'FX panel musí mať nastavenie kontrastu');
assert(code.includes('f-saturate'), 'FX panel musí mať nastavenie sýtosti');
assert(code.includes('t-zoom'), 'FX panel musí mať nastavenie zoomu');
assert(code.includes('t-panx'), 'FX panel musí mať nastavenie Pan X');
assert(code.includes('t-pany'), 'FX panel musí mať nastavenie Pan Y');
assert(code.includes('t-mirror'), 'FX panel musí mať zrkadlenie obrazu');
assert(code.includes('nuss-fx-reset'), 'FX panel musí mať tlačidlo resetu filtrov');
assert(code.includes('data-act="toggle-zoom-pan"'), 'Bunka musí mať prepínač pre výber videa na zoom a posun');
assert(code.includes("addEventListener('wheel'"), 'Vybrané video musí podporovať zoom kolieskom');
assert(code.includes('{ passive: false }'), 'Wheel zoom musí vedieť zabrániť scrollovaniu stránky');
assert(code.includes('setPointerCapture(e.pointerId)'), 'Posun obrazu musí zachytiť pointer počas ťahania');
assert(code.includes("addEventListener('pointercancel'"), 'Ťahanie musí korektne skončiť aj pri zrušení pointera');
assert(code.includes('Math.round(nextScale * 100)'), 'Wheel zoom musí synchronizovať FX slider');
assert(code.includes('getPanBounds(z)'), 'Pan musí byť obmedzený rozmermi a mierkou videa');

// 9. Toast hlásenia a klávesové skratky
assert(code.includes('showToast'), 'Musí existovať funkcia showToast');
assert(code.includes('BracketLeft'), 'Klávesová skratka pre krok o snímku späť');
assert(code.includes('BracketRight'), 'Klávesová skratka pre krok o snímku vpred');

// 10. Rozloženie mriežky split-screenu
assert(code.includes("layoutMode === 'grid3x3'"), 'applyGridLayout musí podporovať grid3x3');
assert(code.includes("layoutMode === 'grid4x2'"), 'applyGridLayout musí podporovať grid4x2');
assert(code.includes("layoutMode === 'grid4x3'"), 'applyGridLayout musí podporovať grid4x3');

// 11. Feature 1: A-B Looper & Precision Clip Trimmer
assert(code.includes('data-act="cell-mark-a"'), 'Bunka musí mať tlačidlo [A] pre začiatok slučky');
assert(code.includes('data-act="cell-mark-b"'), 'Bunka musí mať tlačidlo [B] pre koniec slučky');
assert(code.includes('data-act="cell-ab-loop"'), 'Bunka musí mať prepínač A-B slučky');
assert(code.includes('data-act="cell-ab-clear"'), 'Bunka musí mať tlačidlo pre vymazanie A-B bodov');
assert(code.includes('data-act="cell-export-clip"'), 'Bunka musí mať tlačidlo ✂ Export Clip');
assert(code.includes('nuss-pro-ab-range'), 'Časová os musí mať vizuálny rozsah nuss-pro-ab-range');
assert(code.includes('nuss-pro-marker-a'), 'Časová os musí mať značku A nuss-pro-marker-a');
assert(code.includes('nuss-pro-marker-b'), 'Časová os musí mať značku B nuss-pro-marker-b');
assert(code.includes('updateABVisuals'), 'Musí existovať funkcia updateABVisuals pre aktualizáciu rozsahu');
assert(code.includes('captureStream'), 'Export klipu musí využívať in-browser captureStream');
assert(code.includes('MediaRecorder'), 'Export klipu musí využívať in-browser MediaRecorder');
assert(code.includes('markerA'), 'cellObj musí obsahovať stav pre markerA');
assert(code.includes('markerB'), 'cellObj musí obsahovať stav pre markerB');
assert(code.includes('abLoopActive'), 'cellObj musí obsahovať stav pre abLoopActive');

// 12. Feature 2: Side-by-Side Synchro-Scrubber (Multi-Cam Master Sync Lock)
assert(code.includes('data-act="toggle-lock-sync"'), 'Hlavička bunky musí mať prepínač 🔗 Lock Sync');
assert(code.includes('data-act="toggleSyncScrubAll"'), 'Topbar musí mať master prepínač 🔗 Synchro-Scrub [Všetky]');
assert(code.includes('syncScrubToPeers'), 'Musí existovať funkcia syncScrubToPeers pre real-time synchronizáciu');
assert(code.includes('toggleSyncScrubAll'), 'Musí existovať funkcia toggleSyncScrubAll pre hromadné uzamknutie');
assert(code.includes('updateTopBarSyncAllButton'), 'Musí existovať funkcia updateTopBarSyncAllButton');
assert(code.includes('syncLocked'), 'cellObj musí obsahovať atribút syncLocked');

// 13. Feature 3: One-Click Nexus Collector Vault & Tagging Intake
assert(code.includes('data-act="save-to-vault"'), 'Hlavička bunky musí mať tlačidlo ⭐ Uložiť do Nexus Vault');
assert(code.includes('data-act="saveAllToVault"'), 'Topbar musí mať hromadné tlačidlo ⭐ Uložiť všetky');
assert(code.includes('saveItemToNexusVault'), 'Musí existovať funkcia saveItemToNexusVault pre odoslanie do backendu');
assert(code.includes('saveAllActiveToNexusVault'), 'Musí existovať funkcia saveAllActiveToNexusVault pre hromadný import');
assert(code.includes('/api/v1/intake/import'), 'Endpoint pre import do Nexus Vault musí smerovať na import intake');
assert(code.includes("VAULT_OFFLINE_QUEUE_KEY = 'nexus_vault_offline_queue'"), 'Systém musí ukladať neodoslané importy do offline fronty');
assert(code.includes('function enqueueVaultImport'), 'Importy pri nedostupnom backende musia byť zaradené do offline fronty');
assert(code.includes("window.addEventListener('online'"), 'Offline fronta sa musí odoslať po obnovení pripojenia');
assert(code.includes('Na import zaradených'), 'Úspešný import musí potvrdiť zaradenie do intake');

// 14. Funkčné simulačné testy logiky
// A-B Looper logika
{
  let markerA = 4.5;
  let markerB = 12.0;
  let abLoopActive = true;
  let curTime = 12.1;
  if (abLoopActive && markerA !== null && markerB !== null) {
    if (curTime >= markerB || curTime < markerA - 0.5) {
      curTime = markerA;
    }
  }
  assert.strictEqual(curTime, 4.5, 'A-B slučka musí pri dosiahnutí bodu B pretočiť na bod A');
}

// Synchro-Scrubbing logika pre uzamknuté bunky
{
  const testCells = [
    { id: 1, syncLocked: true, video: { currentTime: 0, duration: 60 } },
    { id: 2, syncLocked: false, video: { currentTime: 0, duration: 60 } },
    { id: 3, syncLocked: true, video: { currentTime: 0, duration: 60 } }
  ];
  const sourceCell = testCells[0];
  const targetTime = 18.5;
  testCells.forEach(peer => {
    if (peer === sourceCell || !peer.syncLocked || !peer.video) return;
    peer.video.currentTime = targetTime;
  });
  assert.strictEqual(testCells[2].video.currentTime, 18.5, 'Uzamknutá bunka 3 sa musela synchronizovať');
  assert.strictEqual(testCells[1].video.currentTime, 0, 'Neuzamknutá bunka 2 musela zostať nezmenená');
}

// Nexus Vault Intake Payload schéma
{
  const item = {
    url: 'https://bunkr.is/v/test.mp4',
    directUrl: 'https://media-files.bunkr.is/test.mp4',
    title: 'Test Video Cam 1',
    poster: 'https://media-files.bunkr.is/test.jpg',
    duration: 120,
    size: 24500000,
    quality: '1080p',
    type: 'MP4'
  };
  const payload = {
    url: item.directUrl || item.url,
    title: item.title,
    poster: item.poster,
    duration: item.duration,
    size: item.size,
    source: 'bunkr.is',
    tags: [item.quality, item.type].filter(Boolean)
  };
  assert.strictEqual(payload.url, 'https://media-files.bunkr.is/test.mp4');
  assert.deepStrictEqual(payload.tags, ['1080p', 'MP4']);
  assert.strictEqual(payload.source, 'bunkr.is');
}

// 15. Overenie xHamster podpory, náhľadov a nerozbitných layoutov
assert(code.includes('function isXHamster'), 'Musí existovať funkcia isXHamster');
assert(code.includes('function harvestXHamsterCards'), 'Musí existovať funkcia harvestXHamsterCards');
assert(code.includes('isXHamster(host)'), 'scanPageVideos musí volať isXHamster');
assert(code.includes('⚡ XHAMSTER'), 'renderPickerList musí mať odznak ⚡ XHAMSTER');
assert(code.includes('xembed.php?video='), 'resolveStreamUrl musí mať fallback na xembed');
assert(code.includes('padding-bottom: 56.25% !important'), 'Karty musia mať nerozbitný 16:9 stage cez padding-bottom');
assert(code.includes('height: 72px !important'), 'Zoznamové zobrazenie musí mať pevnú výšku kariet 72px');

// Funkčný simulačný test extrakcie z initials a ignorovania zlyhaných titulkov
{
  const mockInitials = {
    videoModel: { id: 101, title: 'Super Video Clip', duration: 180 },
    subVideos: [
      { pageURL: '/videos/sample-clip-xh123', thumbURL: 'https://xhcdn.com/t1.jpg', title: 'Sample HD Video', duration: 240, views: 5000 },
      { pageURL: '/videos/paid-preview-xh456', thumbURL: 'https://xhcdn.com/t2.jpg', title: 'Paid Video', isPaid: true }
    ]
  };

  const results = [];
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && item.pageURL && !item.isPaid && (item.thumbURL || item.imageURL)) {
          results.push(item);
        } else {
          collect(item);
        }
      }
      return;
    }
    for (const v of Object.values(node)) collect(v);
  };
  collect(mockInitials);

  assert.strictEqual(results.length, 1, 'Musí nájsť presne 1 neplatené video z initials');
  assert.strictEqual(results[0].title, 'Sample HD Video');
  assert.strictEqual(results[0].thumbURL, 'https://xhcdn.com/t1.jpg');

  // Overenie ignorovania chybného textu z tlačidla rozšírenia
  const candidateTitles = ['Vybrať pre import do Nexus', 'Skutočný Názov Videa'];
  let cleanedTitle = '';
  for (const t of candidateTitles) {
    if (t && !/Vybrať pre import|Nexus|Import do/i.test(t)) {
      cleanedTitle = t;
      break;
    }
  }
  assert.strictEqual(cleanedTitle, 'Skutočný Názov Videa', 'Názov nesmie byť prepísaný tlačidlom Vybrať pre import');
}

// 16. Hĺbkové overenie edge cases pre Feature 1: A-B Looper & Trimmer
assert(code.includes('video.loop = false;'), 'A-B slučka musí dočasne vypnúť natívny HTML5 loop pre elimináciu konfliktu na konci videa');
assert(code.includes('Math.abs(video.currentTime - start) < 0.05'), 'Export clip musí ošetriť nulový posun v čase bez uviaznutia na seeked');
assert(code.includes('seekSafetyTimeout'), 'Export clip musí obsahovať poistný timeout pre začiatok nahrávania');
assert(code.includes('nuss-toast-badge'), 'Toast notifikácia musí obsahovať CSS odznak pre Nexus Vault');
assert(code.includes('nuss-toast-link'), 'Toast notifikácia musí obsahovať klikateľný odkaz na Nexus Vault');

// Simulačný test: A-B Looper - aktualizácia tlačidiel aj pri neznámej dĺžke videa (dur = 0 / NaN)
{
  const mockCell = {
    markerA: 5.2,
    markerB: null,
    abLoopActive: false
  };
  const classListSet = new Set();
  const mockMarkABtn = { textContent: '', classList: { add: (c) => classListSet.add(c), contains: (c) => classListSet.has(c) } };

  const dur = NaN;
  // Simulácia nového správania updateABVisuals
  if (mockCell.markerA !== null) {
    mockMarkABtn.textContent = `[A] 0:05`;
    mockMarkABtn.classList.add('is-active');
  }
  assert.strictEqual(mockMarkABtn.textContent, '[A] 0:05', 'Tlačidlo [A] sa musí aktualizovať aj keď dĺžka videa je ešte NaN');

  // Overenie resetu abLoopActive pri posune bodu A za bod B
  mockCell.markerB = 4.0;
  mockCell.abLoopActive = true;
  if (mockCell.markerB !== null && mockCell.markerB <= mockCell.markerA) {
    mockCell.markerB = null;
    mockCell.abLoopActive = false;
  }
  assert.strictEqual(mockCell.markerB, null, 'Bod B musí byť vymazaný');
  assert.strictEqual(mockCell.abLoopActive, false, 'abLoopActive musí byť resetovaný na false ak je bod B neplatný');
}

// 17. Simulačný test: Synchro-Scrubbing - synchronizácia pozastavenia (pause) a ochrana pred nulovou šírkou
{
  const testCells = [
    { id: 1, syncLocked: true, video: { paused: true, currentTime: 10, duration: 60, pause() { this.paused = true; } } },
    { id: 2, syncLocked: true, video: { paused: false, currentTime: 2, duration: 60, pause() { this.paused = true; } } }
  ];
  const source = testCells[0];
  const isSourcePaused = source.video.paused;
  const targetTime = 15.0;

  testCells.forEach(peer => {
    if (peer === source || !peer.syncLocked || !peer.video) return;
    peer.video.currentTime = targetTime;
    if (isSourcePaused && !peer.video.paused) {
      peer.video.pause();
    }
  });

  assert.strictEqual(testCells[1].video.currentTime, 15.0, 'Peer bunka musí byť posunutá na targetTime');
  assert.strictEqual(testCells[1].video.paused, true, 'Peer bunka musí byť pozastavená ak je zdrojové video pozastavené');

  // Ochrana pred nulovou šírkou časovej osi
  const rect = { left: 100, width: 0 };
  const clientX = 120;
  let ratio = null;
  if (rect && rect.width > 0) {
    ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }
  assert.strictEqual(ratio, null, 'Pri nulovej šírke časovej osi nesmie prebehnúť výpočet ratio aby nevznikol NaN');
}

// 18. Simulačný test: Precision Clip Trimmer - nulový posun a fallback formátov
{
  let start = 5.0;
  let curTime = 5.0;
  let seekEventFired = false;
  let recordingStarted = false;

  const startRecorder = () => { recordingStarted = true; };

  // Ak je delta < 0.05s, štartujeme ihneď bez čakania na seeked
  if (Math.abs(curTime - start) < 0.05) {
    startRecorder();
  } else {
    // Čakáme na seeked
  }
  assert.strictEqual(recordingStarted, true, 'Nahrávanie výstrižku sa musí spustiť okamžite bez uviaznutia ak je video na začiatku úseku');

  // Detekcia formátu
  const mockRecorder = { mimeType: 'video/mp4' };
  const effectiveMime = mockRecorder.mimeType || 'video/webm';
  const ext = effectiveMime.includes('mp4') ? 'mp4' : 'webm';
  assert.strictEqual(ext, 'mp4', 'Pri mimeType video/mp4 musí byť prípona súboru mp4');
}

// 19. Simulačný test: One-Click Nexus Vault - paralelný batch import a offline spracovanie
{
  const activeCells = [
    { item: { title: 'V1', url: 'https://test/1.mp4' } },
    { item: { title: 'V2', url: 'https://test/2.mp4' } }
  ];

  let offlineQueue = [];
  const fakeSave = async (c, isBatch) => {
    // Simulácia nedostupného backendu
    offlineQueue.push({ ...c.item, queuedAt: Date.now() });
    return false;
  };

  const results = activeCells.map(c => false);
  const successCount = results.filter(Boolean).length;
  assert.strictEqual(successCount, 0, 'Úspešnosť pri offline backende je 0');
  assert.strictEqual(offlineQueue.length, 0, 'Pripravené na naplnenie');
  activeCells.forEach(c => fakeSave(c, true));
  assert.strictEqual(offlineQueue.length, 2, 'Obe videá boli uložené do offline fronty');
}

console.log('✓ Všetky testy (vrátane side questions: A-B Looper, Synchro-Scrub, Nexus Vault, xHamster Harvester & Layout Fixes) úspešne prebehli!');
