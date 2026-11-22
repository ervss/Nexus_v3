# Nexus Universal Split-Screen — Návod a Integrácia

Kompletný systém Split-Screen prehrávača, ktorý sme vyvinuli, bol extrahovaný do **3 univerzálnych foriem**, ktoré môžeš použiť kdekoľvek:

1. **Samostatná JS knižnica:** `universal-splitscreen/nexus-splitscreen.lib.js`
2. **Univerzálny Tampermonkey Userscript:** `universal-splitscreen/universal-splitscreen.user.js`
3. **Hotové Chrome Rozšírenie (Extension):** `universal-splitscreen/extension/`

---

## 🚀 1. Možnosť: Univerzálny Tampermonkey skript (Najjednoduchšie)

Tento skript funguje automaticky na **všetkých webstránkach** (`*://*/*`):
- **Súbor:** `universal-splitscreen/universal-splitscreen.user.js`
- **Ako to funguje:**
  1. Nainštaluj si skript do Tampermonkey.
  2. Otvor ľubovoľnú stránku s videami (napr. Bunkr, reddit, twitter/x, tube weby, atď.).
  3. Podrž klávesu **`Alt`** a klikni na 2 alebo viacero videí (alebo kariet/odkazov na videá).
  4. Okolo vybraných videí sa rozsvieti zelený rámik a vpravo dole vyskočí fialová plávajúca lišta: **`▶▶ Spustiť Split-Screen`**.
  5. Klikni na ňu a videá sa okamžite otvoria v Turbo Split-Screene so synchronizáciou, layoutmi a Diag HUDom.

---

## 🧩 2. Možnosť: Vlastné Chrome Rozšírenie (Unpacked Extension)

Hotové rozšírenie pripravené na načítanie do prehliadača Chrome/Brave/Edge bez nutnosti Tampermonkey:
- **Zložka:** `c:\Users\Peto\Desktop\NexusPWC_fresh_v2\universal-splitscreen\extension\`
- **Postup inštalácie:**
  1. V Chrome otvor `chrome://extensions/`.
  2. Vpravo hore zapni prepínač **Vývojársky režim** (Developer mode).
  3. Klikni na **Načítať rozbalené** (Load unpacked).
  4. Vyber priečinok: `c:\Users\Peto\Desktop\NexusPWC_fresh_v2\universal-splitscreen\extension`.
  5. Hotovo! Na každej stránke teraz funguje označovanie cez `Alt + Klik`.

---

## 💻 3. Možnosť: Použitie v tvojich vlastných skriptoch / projektoch (API)

Ak píšeš vlastné userscripty alebo vlastné rozšírenia, stačí do nich pridať súbor `nexus-splitscreen.lib.js` a zavolať API:

### A) Jednoduché volanie s priamymi URL (MP4 / WebM / M3U8):
```javascript
NexusSplitScreen.open([
  { url: 'https://site.com/video1.mp4', title: 'Video 1' },
  { url: 'https://site.com/video2.mp4', title: 'Video 2' },
  { url: 'https://site.com/stream.m3u8', title: 'HLS Live Stream' }
], {
  layout: 'auto',  // 'auto' | 'row' | 'grid2' | 'grid3'
  fit: 'contain',  // 'contain' | 'cover'
  diag: true       // zobrazí diagnostický HUD
});
```

### B) Pokročilé volanie s dynamickým resolverom (pre weby vyžadujúce podpis/tokeny):
Ak stránka nemá priame MP4 URL, ale napr. len odkazy na prehrávače alebo API tokeny:
```javascript
NexusSplitScreen.open([
  {
    url: 'https://bunkr.cr/f/xyz123',
    title: 'Moje Video',
    resolve: async (item) => {
      // Tu spravíš scraping stránky alebo zavoláš podpisovací endpoint:
      const streamUrl = await fetchDirectStream(item.url);
      return streamUrl; // Vráti podpísanú priamu MP4 CDN URL
    }
  }
]);
```

### Dostupné metódy:
- `NexusSplitScreen.open(items, options)` – otvorí a spustí Split-Screen.
- `NexusSplitScreen.close()` – bezpečne zatvorí modál, zruší streamy, uvoľní pamäť a zastaví časovače.

---

## ✨ Čo všetko je v tomto univerzálnom balíku zahrnuté:
- **Automatický grid engine:** Dynamicky vypočíta optimálne stĺpce a riadky pre 2 až 16 videí naraz.
- **HLS.js auto-loading:** Ak je URL `.m3u8`, automaticky z CDN dotiahne HLS engine.
- **Master Drift Sync:** Jemná regulácia rýchlosti prehrávania (0.96x–1.04x) na udržanie synchronizácie viacerých videí.
- **Solo Audio & Mute All:** Prepínanie zvuku medzi videami jedným klikom.
- **Turbo Staggered Start:** Spúšťa videá s 200ms odstupom, aby nezahltil socket pool.
- **Fallback Iframe:** Ak video vyžaduje špeciálnu ochranu, automaticky prepne bunku do čistého iframe prehrávača.
