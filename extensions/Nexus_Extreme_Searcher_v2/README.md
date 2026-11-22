# Nexus Extreme Searcher v2

Manifest V3 rozšírenie pre Chrome a Edge. Tento priečinok je samostatná verzia; pôvodný `Nexus_Extreme_Searcher` sa nemení. Popup vyhľadáva video stránky, torrenty, file hosty, verejné fóra, Reddit a voliteľné metadáta.

## Architektúra

- `popup.js`: výsledkové karty, filtre, import a sťahovanie.
- `background.js`: service worker, najviac tri súbežné úlohy, izolácia chýb, 10 až 20 minútová cache a diagnostika.
- `engine.js`: validácia dotazu, varianty, skórovanie, normalizácia a deduplikácia.
- `sources.js`: voliteľné adaptéry pre SearXNG, Discourse a ThePornDB.
- `options.js`: kľúče a adresy uložené v `chrome.storage.local`.

## Zapojené zdroje

| Kategória | Adaptér | Podmienka |
|---|---|---|
| Tubes | Eporner API, Nexus external search (Eporner, XVideos, Pornhub, SpankBang, xHamster, CamWhores, WhoresHub, PornTrex, Beeg, NoodleMagazine, HQPorner) | Eporner priamo; Nexus pre ostatné |
| Torrenty | Nexus torrent pipeline, Jackett, Prowlarr | Nexus alebo API kľúč |
| Torrenty | Verejne indexované stránky cez SearXNG: Pirate Bay, LimeTorrents, Torrent Downloads, TorrentFunk, BTDig, SolidTorrents | SearXNG s povoleným JSON formátom |
| File hosty | Nexus external search (Bunkr, Gofile, Pixeldrain, Erome) | Nexus |
| File hosty | SearXNG site search: BunkrSearch, Findr, Pixeldrain, Gofile, Filester, Fileditch, Mega, Cyberdrop, VK | SearXNG |
| Fóra | Discourse `/search.json`, F95zone cez SearXNG | Zadaná Discourse URL alebo SearXNG |
| Reddit | Verejné `search.json`, OAuth, Nexus fallback | OAuth token je voliteľný |
| Metadata | ThePornDB `/scenes` | ThePornDB API key |

SearXNG adaptér vracia odkazy z výsledkov metavyhľadávania; nie je to priame API ani scraper uvedených stránok. Niektoré domény sa menia, vyžadujú prihlásenie alebo neumožňujú indexovanie. V Options možno predvolené domény nahradiť vlastným zoznamom. Adaptér zobrazí chybu v karte Metadata, ak služba vráti chybu alebo neponúka JSON.

Pre súkromné úniky a obsah bez súhlasu sa dotaz odmietne. Rozšírenie neobchádza prihlásenie, CAPTCHA ani platený prístup. Priame integrácie so všetkými doménami pôvodného zadania, RSS, IAFD, StashDB a qBittorrent Web API nie sú implementované. Torrent je možné pridať cez Nexus `/api/torrent/add`, ak výsledok poskytuje magnet alebo referenciu.

## Inštalácia

1. V Chrome otvoriť `chrome://extensions` alebo v Edge `edge://extensions`.
2. Zapnúť režim vývojára a kliknúť na **Load unpacked / Načítať rozbalené**.
3. Vybrať tento priečinok `Nexus_Extreme_Searcher_v2`.
4. V Options nastaviť lokálny Nexus, prípadne Jackett, Prowlarr, SearXNG, Discourse a ThePornDB.

`Add selected to Nexus` pošle video URL do `/api/v1/bridge/import`; torrent s magnetom alebo referenciou do `/api/torrent/add`. `Download` sa zobrazí len pri dostupnej priamej URL alebo magnet odkaze.

## Overenie

`node --test tests/engine.test.mjs` preverí normalizáciu a adaptéry. `node tests/ui-smoke.cjs` načíta rozšírenie v Chromium, klikne na Search a uloží screenshot a JSON do `artifacts` v tomto priečinku `_v2`. Živý test závisí od dostupnosti lokálneho Nexusu, kľúčov a vzdialených služieb.
