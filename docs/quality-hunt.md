# Iné verzie klipu – Quality Hunt

Nexus Gallery 2.41.6 hľadá alternatívne zdroje aktuálneho videa. Neupravuje obraz. Vyššie rozlíšenie samo nepreukazuje lepšiu kompresiu ani lepší obraz.

## Výsledok a dôkazy

Backend uchováva jeden zoznam `candidates` so stabilným ID odvodeným od identity stránky. Panel, pracovné okno, filtre, počty a export používajú rovnaký zoznam. Staršie skupiny zostávajú v API kvôli kompatibilite.

Každý kandidát má tri nezávislé stavy:

- **Identita:** neoverená, možná rovnaká scéna, vizuálne podporený kratší/dlhší zostrih, potvrdená zhoda dĺžky, iba rovnaký účinkujúci alebo zamietnutá zhoda.
- **Dostupnosť:** neznáma, dostupné médium, vyžaduje prístup alebo nedostupná.
- **Kvalita:** neznáma, odhad z názvu/štítku alebo údaj overený extraktorom, knižnicou či prehrávačom.

Dôkazy obsahujú pôvod, čas a dôvod. Metadáta, obrazové porovnanie a dostupnosť majú samostatné výsledky overenia. Chýbajúci dôkaz sa nezamieňa so zlyhaním. Kandidáti bez dôkazu o zhode zostávajú iba v diagnostike; zamietnutí sú s dôvodom v karte Zdroje.

Predvolené výsledky ukazujú potvrdené zhody, obrazom podporené zostrihy, silné možné zhody scény a najviac päť podobných scén toho istého účinkujúceho. Tie posledné sú výslovne označené ako iné video, bez skóre verzie a nezvyšujú počet zdrojov klipu. Ostatné videá účinkujúceho sú oddelený filter. Rôzne domény sa zobrazia pred ďalšími zrkadlami jedného webu. Surový počet nájdených odkazov nie je počet alternatívnych verzií. Textové hľadanie skúša plný aj skrátený, stále scénicky konkrétny názov. Samotné meno účinkujúceho sa používa len v obmedzenom kroku s obrazovou referenciou, pred širokým hľadaním.

Ak máme referenčné snímky a stále chýba päť zdrojov, nasleduje najviac 24 nálezov z obmedzeného vyhľadania podľa účinkujúceho. Tento krok slúži na zachytenie premenovaných kópií obrazovým porovnaním; iné videá účinkujúceho zostávajú iba vo vedľajšom filtri.

Potvrdenie vyžaduje silnú zhodu konkrétnej scény s dĺžkou alebo obrazom, prípadne skutočnú obrazovú podobnosť s dĺžkou. Výrazne odlišná dĺžka bráni potvrdeniu rovnakej stopáže: silný názov s obrazovou zhodou sa označí ako iná verzia, iba silný názov ako možná zhoda na prehratie. Samotná podobná dĺžka, účinkujúci, štúdio alebo dátum nestačia. Číslo scény musí sedieť. Počet zdrojov scény zahŕňa potvrdené zhody a obrazom podporené zostrihy, nie možné ani iba herecké nálezy.

Pôvodná stránka sa vylúči pred aj po overení. Eporner sa porovnáva podľa ID medzi `video-`, `hd-porn` a `embed`, bez ohľadu na www, slug alebo sledovacie parametre. CamWhores doménové zrkadlá tvoria jeden nezávislý zdroj.

Počet **overených zlepšení** vyžaduje potvrdenú identitu, dostupné médium, známu výšku originálu a vyššiu výšku kandidáta overenú metadátami. Pred prehratím dostupnosť znamená kontrolu hlavičky a bajtov rozpoznaného mediálneho súboru, nie záruku dekódovania celého videa. HLS playlist sám prehrateľnosť nepotvrdzuje. Skutočné prehrávanie odošle backendu úspech alebo chybu, aktuálne rozlíšenie a dĺžku a prepočíta výsledok aj cache. Údaj extraktora môže opisovať ponúkaný variant; aktuálny prehrávač ho nahradí skutočne prehrávanou výškou.

Cieľ piatich nezávislých domén tej istej scény je voliteľný a predvolene zapnutý. Pokrytie a použiteľné zlepšenie sa zobrazujú oddelene. Cieľ nesmie byť doplnený možnými zhodami bez obrazu ani nesúvisiacimi videami.

## Priebeh a opakovanie

- Rýchle hľadanie: knižnica, hlavné aj širšie zdroje; celkový limit 75 s.
- Dôkladné: navyše Google/SerpAPI a Telegram; celkový limit 150 s.
- Metadáta sa overujú priebežne, nezávisle od predbežnej identity, so súbežnosťou 4. Limity 8/16 kandidátov boli odstránené. Obrazové overovanie nemá pôvodný limit 24 kandidátov; zostáva časový rozpočet a súbežnosť 6. Hotové varianty odovzdávajú kandidátov priebežne, aj keď iný variant ešte čaká. Quality Hunt nerozširuje svoje tri identitné dopyty druhýkrát v adaptéri.
- Každý vyhľadávací zdroj má kratší vnútorný limit než vonkajší krok, s rezervou 4 s. Celkový deadline má rezervu na publikovanie a ukončenie verifikácií. Nedokončené overenia sa označia.
- Stav `done` znamená ukončené kroky bez zaznamenaných zlyhaní. `degraded` znamená chybu, limit poskytovateľa alebo zlyhané overenie. Celkový deadline dá `partial`; zastavenie dá `cancelled`. Výsledky zostávajú.
- Úspešná cache trvá 1 hodinu; degradovaná 20 s a zachováva svoj stav. UI ukazuje vek cache. Partial/cancelled sa neukladajú ako úspech.
- **Nové overenie** obíde cache. **Zopakovať zlyhané kroky** zachová kandidátov a úspešnú diagnostiku, zopakuje zlyhané zdroje a neúspešné overenia; neposiela všetky úspešné zdroje znova. Retry používa presné pôvodné vstupné video.
- Najviac tri behy súbežne; rovnaké aktívne požiadavky sa zdieľajú. Zatvorenie okna nezastaví hľadanie. Synchronné sieťové volania vo vláknach môžu pri zastavení dobehnúť do vlastného limitu.
- Yandex je predvolene vypnutý. Jeho povolenie umožňuje odoslať snímku/náhľad do Yandex. Lokálne porovnanie tento súhlas nevyžaduje.

## Pracovné okno

Široké okno do 1360 px obsahuje referenciu originálu, stav, spoločné počty, filtre, nové overenie, retry a export aktuálne filtrovaných kandidátov. Karty majú náhľady 16:9, čitateľný text, tri samostatné stavy a akcie Porovnať/Otvoriť zdroj/Import. Podrobnosti obsahujú dôkazy a výsledky overenia.

Porovnanie zobrazí originál a vybranú verziu vedľa seba. Oba streamy sa načítajú pri výbere kandidáta. Prehrávač najprv skúsi priamy stream; pri chybe obnoví expirovaný odkaz, potom ďalšie kvality toho istého videa a až nakoniec lokálny proxy. Uložený lokálny proxy odkaz sa pred prvou skúškou rozbalí na pôvodný stream. Skener stránky ignoruje oba prehrávače modálu, takže nemení referenčné video pri prepínaní kandidátov. Ukončenie prehratia nezatvorí okno ani výsledky. Pri priebežných zmenách sa zachová výber, fokus a otvorené dôkazy. Obsah má jednu hlavnú zvislú rolovaciu plochu; mobil má jeden stĺpec. Escape zatvorí okno, Tab ostáva v okne.

**FAST FETCH · údaje kariet** dopĺňa po menších dávkach veľkosť súboru, rozlíšenie a dĺžku. Veľkosť sa zisťuje iba z hlavičiek alebo jednobajtovej range požiadavky; samotné video sa kvôli tomu nesťahuje. Pri HLS alebo pri odpovedi bez spoľahlivej dĺžky zostane veľkosť neznáma. Rozlíšenie z názvu je označené ako odhad, dekódované rozlíšenie v prehrávači ho nahradí.

Na kartách zaberá náhľad viac miesta než text pod ním. Jeho rohy ukazujú kvalitu, skóre výberu, dĺžku a veľkosť; neznáme údaje sú výslovne označené otáznikom. Štyri farebné pruhy pod názvom ukazujú príspevok zhody (45 bodov), prehrateľnosti (25), rozlíšenia (20) a úplnosti údajov (10). Nepotvrdená identita znižuje príspevky ostatných faktorov: vyššie rozlíšenie nesmie samo vytvoriť presvedčivé skóre nesúvisiaceho videa. Veľkosť súboru tvorí nanajvýš 3 body úplnosti údajov, nikdy skóre rozlíšenia. Zelené hodnotenie sa zobrazí až po skutočnom prehratí v prehliadači.

Záložka Zdroje uvádza výsledky poskytovateľov, dopyty, časy, chyby, kroky a časy prvého kandidáta, potvrdenia, dostupného zlepšenia a celého behu. Bilančné počty: získané odkazy, originál, duplicity, vylúčené zdroje, zamietnuté zhody, neoverené metadáta/obraz a zlyhané overenia. Export neobsahuje priame stream URL.

## Overenie implementácie

Rýchly reálny beh 29. 9. 2026 pre referenciu „Wettmelons Gives Head And Receives A Facial“ (5:58, 1080p) s náhľadom originálu, plným, skráteným aj významovým dopytom získal 163 kandidátov. Z nich bolo 0 potvrdených zhôd, 0 obrazom podporených zostrihov, 0 možných zhôd scény a 16 podobných scén účinkujúcej. Počet zdrojov toho istého klipu zostal 0/5; stav bol `degraded` pre timeouty a obmedzenia externých zdrojov. Podobné scény sa zobrazujú len ako iné videá a neplnia cieľ zdrojov. Tento beh nedokazuje schopnosť nájsť kópiu každého klipu a päť nezávislých zdrojov zatiaľ nebolo dosiahnutých.

Kontrola priamo v Chrome na tej istej stránke potvrdila, že pôvodné video a jeden výsledok PornOne sa v porovnávacom okne prehrajú. Ďalší výsledok Eporner síce spustil prehrávač, no išlo o propagačný klip (skutočne 1:01 a 360p namiesto inzerovaných 14:02 a 720p). Verzia 2.41.6 odmieta titulky propagujúce inú stránku, pri zásadnom nesúlade skutočnej dĺžky odstráni neplatný údaj o veľkosti a podobné scény označuje v prehrávači ako iné video. Tieto opravy neznamenajú, že sa na tejto referencii podarilo nájsť päť zdrojov.

Priebežný stav sa nesmie čítať ako konečný výsledok: počas behu môže byť potvrdených zhôd dočasne 0, kým ďalšie zdroje ešte čakajú na odpoveď. Panel preto zobrazuje „Vyhľadávanie pokračuje“ a počet už prijatých kandidátov. Každé ručné „Nájsť iné verzie“ zároveň obchádza krátku cache zhoršeného behu, aby druhý alebo tretí pokus neprehrával ten istý neúplný snapshot.

`python -m unittest discover -s tests -p 'test_quality_hunt*.py'` pokrýva model, identitu, filtre, stream/proxy, veľkosť, cache, retry a pipeline. `node --test tests/quality_hunt_native_playback.test.mjs tests/quality_hunt_playback.test.mjs tests/quality_hunt_selectors.test.mjs` pokrýva priame prehrávanie, obnovu, ochranu originálu a spoločné selektory.

`python tests/quality_hunt_ui_preview.py` spustí náhľad na porte 8769 (premenná `QUALITY_HUNT_PREVIEW_PORT` zmení port). Odpovede poskytovateľov a import sú explicitne simulované. Pre prehrávanie vlož lokálny `sample.webm` do `.codex-test-tmp/quality-hunt-ui/`. `node tests/quality_hunt_workbench_ui.cjs` overí skutočné kliky produkčných UI funkcií, filtre, dva prehrávače, ukončenie prehratia, výber, mobil a Escape. Predvolený testovací URL je port 8771; zmení ho `QUALITY_HUNT_PREVIEW_URL`.

Tieto testy nepreukazujú počet kópií na externých weboch ani prehrateľnosť súkromných zdrojov. Presnosť pravidiel identity sa naďalej musí merať na označenom súbore klipov. Hľadanie nie je obsahový fingerprint celého videa. Historické meranie jedného potvrdeného zdroja je v `quality-hunt-regression-review.md` a nie je dôkazom piatich zdrojov po tejto zmene.

## Živá kontrola 27. 9. 2026

Načítané rozšírenie 2.41.0 bolo overené proti bežiacemu backendu cez pôvodnú stránku používateľa. Panel aj pracovné okno zobrazili rovnakých 31 kandidátov; karty zostali široké približne 280 px. Zastavenie zachovalo čiastočné výsledky. Finálny rýchly beh trval 68,28 s, prvý kandidát prišiel za 0,344 s. Výsledok: degraded, 0 potvrdených domén a 0 overených zlepšení. Požiadavka piatich zdrojov nie je týmto meraním splnená. Pôvodný prehrávač v testovacej relácii vracal HTTP 404 a neposkytol dĺžku ani výšku. Kandidáti sa preto nesmú prezentovať ako potvrdené alternatívy.

Dôkazy sú v `.codex-test-tmp/gallery-workbench-final-api.json`, `gallery-workbench-real-ui.json`, `gallery-real-after.png` a `gallery-workbench-real-sources.png`. Lokálne kontrolované prehrávanie dvoch testovacích videí a zachovanie okna po skončení boli overené klikacím testom; prehrávanie a import externých kandidátov sa týmto živým behom nepreukázali.
