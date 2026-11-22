# Nexus v3

Lokálna multimediálna knižnica, vyhľadávač a správa zdrojov postavená na **FastAPI + SQLite (FTS5) + Alpine.js + esbuild** v dizajne **Obsidian Glass**.

---

## Hlavné funkcie

- **Galéria & Split-Screen Prehrávač**
  - Mriežkový (**Grid**) a plynulý vertikálny (**Quantum Flow**) pohľad s 3 výkonovými režimami skla (*Vyvážené / Plné / Bez bluru*) a motívmi *Obsidian Dark* / *Frosted Light*.
  - Prehrávač s rozbaľovacím `#player-drawer`, podporou **HLS (`hls.js`)**, **JIT obnovou expirovaných streamov**, **Split-Screenom** pre dve videá vedľa seba a automatickou voľbou zrkadiel.
- **Local Vault (`/vault`)**
  - Rýchle lokálne FTS5 vyhľadávanie naprieč knižnicou, Telegram indexom, fórami, Filesterom a MEGA priečinkami s pushdown filtrami, deduplikáciou a prehrávaním priamo v trezore.
- **Quantum Search & QS Mega Links**
  - Hĺbkové vyhľadávanie naprieč Telegram kanálmi, fórami a webmi (vrátane lokálneho SearXNG dorkingu).
  - **Pack / Link Harvester** s pravým slide-over **Harvester Inspectorom**: lokálne dekódovanie `link-to.net/.../dynamic?r=...` bez HTTP volaní, viacodkazová extrakcia z `rentry.org`, cache rozbalených odkazov (`ResolvedLinkCache`), podpora **MEGA, Bunkr, Gofile, Pixeldrain, Cyberdrop, Erome, Filester**, rebríček kvality kanálov (**Top kanály** s pripínaním) a prepínateľný rotátor bypass služieb.
- **MEGA Hub**
  - Overovanie a prehliadanie verejných MEGA priečinkov a súborov, výber konkrétnych videí do knižnice, podpora Tor / vlastnej proxy a integrácia s userscriptom `userscripts/mega-hub-capture.user.js`.
- **Zdroje & Huby**
  - **Discovery & Huby:** Camwhores, SxyPrn, Faphouse (`/faphouse`), Fusion Hub, Forum Hub (`/forum`), Creator Radar, Webshare a lokálne priečinky.
  - **Diagnostika:** Link Tester (`/tester`), Test webov (`/sources-test`), Štatistiky (`/stats`) a Príkazová paleta (`Ctrl+Shift+P`).

---

## Rýchle spustenie (Windows)

Najspoľahlivejší spôsob je použiť priložené spúšťacie skripty s automatickým dohľadom (`/_nexus/live`):

```powershell
# Spustenie hlavného servera (classic mód na porte 8000)
.\START_NEXUS_CLASSIC.bat

# Zastavenie servera aj dohľadu
.\STOP_NEXUS.bat
```

Po spustení otvor v prehliadači:
- **Hlavná galéria:** <http://127.0.0.1:8000/>
- **Local Vault:** <http://127.0.0.1:8000/vault>
- **Forum Hub:** <http://127.0.0.1:8000/forum>
- **Link Tester:** <http://127.0.0.1:8000/tester>
- **Stav servera:** <http://127.0.0.1:8000/_nexus/live>

---

## Vývoj, build a testy

### Požiadavky
- Python 3.12+ (`.venv` v koreňovom priečinku)
- Node.js 20+ (`npm install`)
- Voliteľne: `ffmpeg` (náhľady/remux), `aria2c` (Download Manager), lokálny `SearXNG` (`scripts/start_searxng.ps1`)

### Build frontendových balíkov

Po úpravách v `app/static/main.js`, `app/static/dashboard.css` alebo `extensions/shared/` spusti:

```powershell
npm run build
```

Tým sa vygenerujú `app/static/main.min.js`, `app/static/dashboard.min.css`, enhancer balíky a zosynchronizujú sa zdieľané knižnice rozšírení.

### Testy

```powershell
# Python backend & regresné testy
.venv\Scripts\python.exe -m pytest tests/test_smoke_regressions.py tests/test_telegram_mega_links.py tests/test_mega_hub.py tests/test_vault_search.py -v

# Frontend UI kontraktné testy
node --test tests/phase1_phase2_ui_contracts.test.mjs tests/phase3_phase4_ui_contracts.test.mjs tests/unified_glass_vault_ui.test.mjs
```

---

## Štruktúra projektu

| Priečinok / Súbor | Popis |
| :--- | :--- |
| `app/` | FastAPI backend, SQLAlchemy modely, extraktory, routery a Jinja2 šablóny |
| `app/static/` | Frontend JS/CSS moduly (`main.js`, `search.js`, `obsidian_glass.css`, `tokens.css`) |
| `app/templates/` | HTML šablóny (`index.html`, `vault.html`, `partials/nx_rail.html`, lazy modály v `partials/modals/`) |
| `extensions/` | Prehliadačové rozšírenia pre Chrome/Brave (`camwhores-url-fixer`, `Nexus_Gallery`, `nexus-video-selector`, …) |
| `userscripts/` | Tampermonkey userscripty (`mega-hub-capture.user.js`, split-screen a ďalšie) |
| `scripts/` | Spúšťacie, dohľadové a pomocné skripty (`nexus_server.py`, `start_nexus.ps1`, `stop_nexus.ps1`) |
| `tests/` | Pytest a Node.js kontraktné testy |
| `.env.example` | Vzor konfigurácie prostredia (lokálny `.env`, databázy, session a cookies sú v `.gitignore`) |

---

## Konfigurácia (`.env`)

1. Skopíruj `.env.example` ako `.env` a doplň vlastné hodnoty (databáza, prihlasovacie údaje, Telegram API, prípadne `MEGA_PROXY_MODE=tor` alebo `MEGA_PROXY_URL`).
2. Lokálne súbory (`.env`, `*.db`, `*.session`, `*_cookies.txt`, `data/`, `logs/`) nie sú verzované v Gite.
