# Nexus Extreme Searcher

Manifest V3 extension pre Chrome a Edge. Popup zobrazuje vyhľadanie z lokálneho Nexusu, torrentových indexerov a Redditu. Inštalácia: otvoriť `chrome://extensions` alebo `edge://extensions`, zapnúť režim vývojára a načítať tento priečinok ako rozbalené rozšírenie. V nastaveniach vyplniť URL Nexusu a prípadné kľúče.

## Architektúra

- `popup.js`: UI, karty, výber, otvorenie výsledku a import.
- `background.js`: paralelné adaptéry (max. 4), izolácia chýb, lokálna cache 10 až 20 minút, diagnostika.
- `engine.js`: validácia, varianty dotazu, normalizácia, skórovanie a deduplikácia.
- `options.js`: nastavenia v `chrome.storage.local`.

## Zapojené zdroje

| Kategória | Zdroj | Spôsob |
|---|---|---|
| Torrents | Prowlarr, Jackett | Priamo cez ich API, ak sú nastavené kľúče; kategória 6000 |
| Torrents | Nexus torrent pipeline | `/api/torrent/search`; používa nakonfigurovaný Prowlarr alebo Jackett a má fallback pre indexery bez kategórie 6000 |
| Tubes | Eporner | Priamo cez oficiálne API v2, zoradenie latest |
| Tubes | XVideos, Pornhub, SpankBang, xHamster, CamWhores, WhoresHub, PornTrex, Beeg, NoodleMagazine, HQPorner | Nexus `/api/v1/search/external` s explicitným zoznamom zdrojov |
| File Hosts a albumy | Bunkr, Gofile, Pixeldrain, Erome | Nexus `/api/v1/search/external` |
| Reddit | Reddit | Verejné Pullpush API a oficiálne Reddit search API (s fallbackom na Nexus katalóg) |
| Metadata | Diagnostika adaptérov | Počet výsledkov a chyby každého zdroja |

Zoznam nezahŕňa priame scrapery ostatných indexerov, RSS feedy, Fileditch, Filester, VK, Mega, Cyberdrop, Tnaflix, archive služby ani ThePornDB/StashDB/IAFD. Tieto integrácie nie sú v tomto builde implementované. Lokálny Nexus môže mať ďalšie zdroje, ale extension ich neoznačuje za implementované. Fórum/leak karta vysvetľuje obmedzenie namiesto predstierania výsledkov.

`Add selected to Nexus` pošle bežné URL do `/api/v1/bridge/import`; torrent pošle magnet/ref do `/api/torrent/add`, ktorý vyžaduje prihlásenú Nexus session a nakonfigurovaný qBittorrent. `Download` spustí priame stiahnutie iba ak výsledok skutočne má `downloadUrl`; inak otvorí detailnú stránku. Priamy qBittorrent Web API nie je implementovaný.

Popup zobrazuje chyby po zdrojoch v karte Metadata. Zdroje môžu odmietnuť automatické požiadavky alebo vyžadovať prihlásenie; nulový výsledok nie je dôkaz, že záznam neexistuje. Rozšírenie neobchádza CAPTCHA, prihlásenie, platby ani geografické obmedzenia.

## Overenie

`node --check` pre všetky JS súbory a `node tests/ui-smoke.cjs` pre reálny Chrome popup. Smoke test ukladá screenshot a JSON počty do `artifacts/extreme-searcher` v koreňovom priečinku repozitára. Test používa keyword zo zadania.
