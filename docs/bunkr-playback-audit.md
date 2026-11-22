# Bunkr Suite: audit prehrávania voči Nexus Universal Split-Screen

Dátum: 2026-10-23. Výsledná verzia Bunkr Suite: **1.8.40**.

Audit porovnáva aktuálne pracovné súbory, nie iba ich verzie v Gite.
Pred úpravou už boli v pracovnom adresári vlastné zmeny; kópia vstupného Bunkr
skriptu a rozdiel tejto relácie sú v `artifacts/bunkr-playback-audit/`.
Referenčný Universal skript sa v tejto úlohe neupravoval.

## Zistenia a opravy

| Oblasť | Pôvodný Bunkr | Universal / záver | Oprava Bunkr |
|---|---|---|---|
| Získanie CDN URL | Album volal `resolveBunkrStreamUrl`, ale funkcia existovala iba v inom IIFE, v archívnej vetve. Kontrola `typeof` preto preskočila `/api/vs`. | Problém je v oddelení modulov Bunkr. | Album má vlastný resolver `/api/vs` s dekódovaním šifrovanej URL; zachované alternatívne sign/HTML cesty. |
| Začiatok prehrávania | Po priradení zdroja čakal na metadata/canplay alebo timeout 1200 ms pred explicitným `play()`. | Universal priradí zdroj a volá `play()` priamo. | Error handler je pripravený pred zdrojom a `play()` sa volá bez tejto čakacej bariéry. |
| Paralelné videá | Každá bunka čakala navyše `index * 250 ms`. | Počet pripojení treba obmedziť bez rastúceho odkladu podľa indexu. | Najviac tri súbežné úlohy na získanie URL. Čakajúci `play()` neblokuje ďalšie úlohy. Samotné prehrávanie tým nie je obmedzené na tri videá. |
| Rýchlosť | Automatické zásahy do `playbackRate` 0,96/1,04 každé dve sekundy, aj pri nezávislých klipoch. | Universal má tiež automatickú korekciu 0,95/1,05; nie je vhodné ju slepo kopírovať. | Odstránená automatická korekcia Bunkr. Zachovaná zvolená rýchlosť a explicitný Sync 0:00. |
| Chyba CDN | GM GET s `responseType: blob` stiahol celý súbor, až potom vytvoril prehrateľnú URL. Chybový handler ostával aktívny aj pre ďalší zdroj. | Universal používa stream/proxy/iframe, nie povinné stiahnutie celého MP4. | Pri chybe sa uvoľní priamy zdroj a raz sa odovzdá prehrávanie natívnej Bunkr stránke `/v/`. Bez automatického plného downloadu do RAM. Platí pre album aj archívny modal. |
| Diagnostika | `progress` handler čítal nedefinované `it`. Rýchlosť odhadoval z času bufferu a predpokladanej veľkosti. | Dĺžka bufferu nie je meranie prenosu v bajtoch. | Odstránený chybný handler aj zavádzajúci výpočet. Nezistiteľná rýchlosť je N/A. |
| Skrytý HUD | Každú sekundu čítal diagnostiku a pre každé video opakovane prechádzal resource timing. | Práca navyše na hlavnom vlákne. | HUD sa aktualizuje iba keď je zapnutý a dokument viditeľný. Timing sa číta raz a páruje ku konkrétnemu zdroju; protokol bez dôkazu je N/A. |
| Zatvorenie / rýchle prepnutie | Staré async výsledky mohli znovu spustiť video; single modal neuvoľňoval zdroj cez `load()`. | Rozhoduje životný cyklus konkrétneho požiadavku. | Single má identitu požiadavku, split overuje pripojenie bunky. Zatvorenie ruší handlery, iframe timer a uvoľňuje media zdroj. Archívny compare odmieta zastaraný výsledok. |
| Platnosť podpisu | Albumová cache nemala kontrolu `ex`; dobiehajúci refresh mohol naplánovať ďalší timer aj po destroy. | Podpísané URL sú dočasné. | Cache sa obnoví pri expirácii alebo počas posledných 60 sekúnd platnosti. Zničený streamer už nenaplánuje refresh. |
| Kompozícia | Fullscreen split používal backdrop blur nad prekrytou galériou. | Efekt môže pridávať GPU prácu bez viditeľného prínosu. | Odstránený blur pozadia fullscreen splitu. |

Pixeldrain MSE engine v Universal rieši jeho kvótu a formát segmentov. Jeho
okno bufferu 10–15 sekúnd sa nepreberá do Bunkr progresívnych MP4.
Natívny browser si riadi Range požiadavky a buffer; skript nevynucuje HTTP/2,
kodek, hardvérové dekódovanie ani dostupnú priepustnosť CDN.

## Overenie

- `node --check bunkr-suite.user.js`: prešlo.
- `node --test tests/bunkr_suite_playback.test.cjs`: 11 regresných testov prešlo.
  Testujú štart bez odkladu, neblokujúci `play()`, zatvorenie počas resolvera,
  jednorazový fallback a uvoľnenie zdroja, autoplay denial vs AbortError,
  refresh po destroy, šifrované `/api/vs`, expiráciu cache a zastarané archívne požiadavky.
- Browser: reálne kliknutie na dvojicu videí, Diag HUD, Pause All, Play All,
  zatvorenie splitu a spustenie single videa. Použité sú skutočné funkcie
  prehrávača a CSS extrahované z upraveného skriptu. Resolver je vo fixture
  nahradený lokálnym syntetickým MP4 640×360/30 fps.
- Screenshoty: `artifacts/bunkr-playback-audit/split-playing.png`
  a `single-playing.png`. Split snapshot: obe videá prehrávajú pri 1×,
  čas 15,98/15,95 s, dropped frames 5/486 a 2/484. HUD zaznamenal jeden
  waiting event v prvom videu a nula v druhom. Toto nie je dôkaz nulového
  stutteru ani benchmark zrýchlenia oproti pôvodnej verzii.
- Existujúci `tests/bunkr_suite_album_helper_ui.test.mjs` zlyhá na požadovanom
  pomere kariet 4:5. Rovnaké zlyhanie bolo reprodukované aj na kópii súboru
  pred týmto auditom; nejde o novú regresiu prehrávania.

## Limity a aktivácia

**Živý Bunkr CDN, jeho podpisovanie, CSP a iframe fallback zostávajú neoverené.**
V dostupných browserových kartách nebol otvorený Bunkr album a používateľ
neuviedol konkrétny album ani problémový súbor. Lokálny test nezahŕňa CDN,
rozšírenie správcu userscriptov ani výkon viacerých 4K videí.

Fallback teraz používa natívny Bunkr player. Pokiaľ daná doména zakáže iframe,
môže byť potrebné otvoriť samostatnú stránku videa cez existujúci odkaz ↗.
Automatické čakanie na stiahnutie celého súboru do RAM sa už nevykonáva.

Aktivácia: aktualizovať existujúci Bunkr Suite vo svojom správcovi userscriptov
obsahom `bunkr-suite.user.js` verzie 1.8.40 a obnoviť albumovú kartu.
