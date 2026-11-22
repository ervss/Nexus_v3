# Nexus Gallery a Nexus Deck na Windows

Projekt je v tomto priečinku na ploche. Galéria používa existujúci lokálny Nexus LITE server a jeho databázu; Deck je rozšírenie pre Brave/Chrome v `extensions/Nexus_Deck`.

## Orientácia v projekte

- `app/`: Python server, HTML šablóny a zdrojové CSS/JavaScript súbory.
- `app/static/main.js`: zdroj hlavného dashboardu. `npm run build` vytvorí používaný `app/static/main.min.js` a balíky video enhancera. Šablóna `app/templates/index.html` načítava práve `main.min.js`; ostatné dashboard skripty a CSS načítava samostatne.
- `extensions/`: samostatné rozšírenia prehliadača. [Prehľad rozšírení](docs/extensions.md) uvádza ich priečinky a verzie.
- `extension/filester_search/`: samostatný Filester Discovery Bridge s vlastným README.
- `tests/`, `scripts/`, `requirements/`: testy, pomocné nástroje a Python závislosti.
- `data/`, `logs/`, `.venv/`, `node_modules/`: lokálny stav a závislosti; nepatria do Gitu. História načítaných playlistov je v `data/playlist_fetches/` a pri prvom použití sa skopíruje zo starého `app/playlist_fetches/`, ak tam existuje.

Výskumné podklady zostávajú v koreňovom priečinku a `docs/`, aby sa nezneplatnili existujúce odkazy. Verziované knižnice vo vnútri rozšírení sú súčasťou ich samostatne načítateľných balíkov.

## Spustenie galérie

V PowerShelli alebo CMD prejdi do koreňového priečinka projektu a spusti:

```powershell
npm start
```

Príkaz spustí existujúci `run_lite.py` na porte 8000. Ak už Nexus LITE na tomto porte beží, oznámi jeho adresu. Okno servera nechaj otvorené. Galéria je na <http://127.0.0.1:8000/> a stav API na <http://127.0.0.1:8000/api/health>. Dáta ostávajú v existujúcej lokálnej databáze projektu.

## MEGA Hub

Otvor **MEGA Hub** v dashboarde a vlož verejný odkaz na priečinok alebo video. Pod **Odosielanie z prehliadača** nájdeš dva userscripty pre Tampermonkey. **MEGA Link Capture** ponúkne overenie odkazov na stránke. **MEGA Helper** pridá tlačidlo **Poslať do MEGA Hubu** priamo do otvoreného MEGA priečinka. Ak je v Nexuse nastavený `NEXUS_BRIDGE_TOKEN`, zadaj ho cez menu príslušného userscriptu.

Odoslané položky sa ukladajú do Hubu. Videá môžeš prehrať v dashboarde a pridať do hlavnej galérie cez **Uložiť vybrané do galérie**.

Proxy pre prehrávanie a sťahovanie z MEGA sa nastavuje v `.env`. `MEGA_PROXY_MODE=tor` použije lokálny Tor, ktorý Nexus spustí podľa potreby, a oddelí okruhy podľa videa. Pri limite prenosu alebo prerušení Nexus skúsi nový Tor okruh a pokračuje od prvého ešte neodoslaného bajtu. `MEGA_PROXY_URL` môže určiť vlastnú HTTP, HTTPS alebo SOCKS5 proxy a má prednosť. Po zmene reštartuj Nexus. IDM preberá lokálnu adresu Nexusu aj pri zachytení videa zo Split Screenu. Pri vyčerpaní pokusov Nexus oznámi chybu. Pri oboch prázdnych hodnotách používa MEGA bežné pripojenie.

## Správca sťahovania (aria2)

Na Windows nainštaluj aria2 cez `winget install --id aria2.aria2 -e` a reštartuj Nexus, aby `aria2c.exe` bolo dostupné v `PATH`. Ak je aria2 nainštalované inde, nastav pred spustením servera premennú `ARIA2C_PATH` na úplnú cestu k `aria2c.exe`. Správca sa spustí automaticky a jeho chránené JSON-RPC rozhranie počúva iba na localhost. Fronta sa obnovuje z `data/download-manager/aria2.session`; predvolené umiestnenie súborov je `data/downloads`. Cieľový priečinok a paralelizmus možno upraviť v paneli **Download Manager**.

## Brave: načítanie a obnovenie Decku

1. Otvor `brave://extensions`.
2. Zapni **Režim vývojára** a vyber **Načítať rozbalené**.
3. Vyber priečinok `extensions/Nexus_Deck`, v ktorom je `manifest.json`.
4. Po úprave súborov klikni pri rozšírení na **Obnoviť** a znova otvor jeho bočný panel.

V nastaveniach Decku použi adresu dashboardu `http://127.0.0.1:8000` a tlačidlo **Otestovať**. Starú lokálnu adresu s predchádzajúcim portom Deck pri načítaní automaticky prepíše. Ak bola uložená iná adresa, zmeň ju priamo v nastaveniach Decku.

Deck posiela odkazy do `/api/lite/quick-import`, číta videá a stav z lokálneho API a prehráva cez lokálny stream endpoint. Nie je potrebný cloud ani ďalší databázový server.

## Prehrávač Decku

Na karte **Prehrať** otvor video z poradia. Obraz prepína **FIT/FILL**, koliesko nad videom mení zoom, ťahanie posúva výrez a dvojklik ho obnoví. Tlačidlo **Ovládanie** rozbalí rýchlosť, hlasitosť, kvalitu HLS, slučku, úsek A–B, otočenie, zrkadlenie a úpravy obrazu vrátane FX ostrosti (ak zdroj povoľuje CORS). Tlačidlo **⛶** zväčší prehrávač v paneli; Esc ho zavrie. Video ovládajú aj Space, J/L, šípky, Home/End a A/S/D na ľavý/stredný/pravý výrez. Položky v poradí možno potiahnuť, odobrať, vyprázdniť alebo obnoviť tlačidlom **Obnoviť poradie**; história uchová poslednú pozíciu. **Stiahnuť** zaradí priamy súbor do lokálneho aria2 Download Managera. HLS playlist sa cez tlačidlo Decku nesťahuje.

## Stabilny start a automaticka obnova servera

`START_NEXUS.bat` a `START_NEXUS_CLASSIC.bat` spustaju classic server cez projektovy Python bez hot reloadu. `START_NEXUS_LITE.bat` pouziva rovnaky dohled pre lite rezim. Launcher caka na skutocnu HTTP odpoved; obsadeny port nepovazuje za funkcny server.

Samostatny dohled kontroluje `/_nexus/live` kazdych 5 sekund (timeout 2 sekundy). Po troch zlyhaniach alebo pade worker procesu obnovi svoj vlastny strom procesov. Startup ma 120-sekundovu toleranciu. Najviac 5 zlyhani za 10 minut, s odstupom 2 az 30 sekund, zabrani nekonecnej restartovacej slucke. Pri vypadku sa rozpracovana praca v pamati moze prerusit; dohled nie je nahradou perzistentnej fronty.

`STOP_NEXUS.bat` najprv zastavi dohled, aby server po umyselnom zastaveni znovu nenastartoval. Diagnostika: `logs/server/supervisor-launch-8000.log`, `supervisor-8000.log`, `stacks-8000.log` a samostatne serverove logy. Stack dump sa aktivuje pri chybajucom heartbeat; neobsahuje lokalne hodnoty premennych. Playwright browser runtime pre projekt: `.venv\Scripts\python.exe -m playwright install chromium`.
