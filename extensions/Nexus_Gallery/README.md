# Nexus Gallery

Aktuálna verzia: `2.3`  
Posledná aktualizácia dokumentu: `2026-10-18`
Umiestnenie: `extensions/Nexus_Gallery`

## Zmysel projektu

Nexus Gallery je hlavná Chrome extension pre ekosystém Nexus. Vznikla ako praktický most medzi webom, kde sa video alebo album práve nachádza, a lokálnym Nexus dashboardom, kde sa obsah ukladá, triedi, kontroluje, importuje a ďalej spracúva.

Hlavná myšlienka je jednoduchá: používateľ nemá ručne loviť URL, kopírovať metadáta, skúšať porty, riešiť duplicitné záznamy alebo hádať, či je stream priamy. Extension má stránku prečítať, nájsť použiteľný stream alebo zoznam médií, ukázať stav a poslať všetko do Nexusu čo najrýchlejšie.

## Na čo slúži

Nexus Gallery pomáha hlavne pri:

- hromadnom importe videí a albumov z podporovaných webov,
- získavaní direct video URL tam, kde je to možné,
- rozpoznávaní kvality, veľkosti, hostingu, dĺžky a základných metadát,
- odosielaní obsahu do lokálneho Nexus dashboardu cez porty `8000` až `8005`,
- rýchlom kopírovaní direct URL,
- kontrole duplicít voči lokálnej knižnici,
- dočasnom uložení batchov, queue/watchlist práci a opakovanom importe,
- rýchlom prehratí zachyteného direct streamu priamo nad stránkou.

Extension nie je len jednoduchý scraper. Je to pracovný nástroj pre rýchle triedenie, overenie a import obsahu z mnohých rozdielnych zdrojov, ktoré majú často rozdielne HTML štruktúry, prehrávače, CDN správanie a ochrany proti priamemu sťahovaniu.

## Ako približne funguje

Extension má viac vrstiev:

- `popup.html` a `popup.js` tvoria hlavný explorer/import panel.
- `background.js` rieši background logiku, komunikáciu s dashboardom, zachytávanie streamov, proxy požiadavky, import a pomocné resolvery.
- `universal_importer.js` a `universal_importer.css` sa injektujú do webových stránok a pridávajú pravý plávajúci "Import to Nexus" panel.
- `drtuber_grid_importer.js` a `drtuber_grid_importer.css` pridávajú výber, triedenie, filtre, načítanie ďalšej strany a bulk import DrTuber videí.
- `hls.min.js` umožňuje prehrávať HLS `.m3u8` streamy.
- špecializované content scripty riešia konkrétne weby alebo prehrávače, napríklad Turbo/Simpcity, PornHoarder/Fullporner alebo Bunkr bridge.

Bežný tok je:

1. Používateľ otvorí zdrojovú stránku alebo album.
2. Extension rozpozná kontext stránky a nájde videá, albumy, thumbnail, metadáta alebo direct stream.
3. Položky sa zobrazia v Nexus Gallery UI alebo v pravom overlay paneli.
4. Používateľ môže kopírovať direct URL, otvoriť direct link, spustiť IDM download, prehrať stream alebo importovať na zvolený port.
5. Nexus dashboard prijme batch cez lokálne API a uloží/importuje dáta.

## Čo extension dokáže

Podporované a rozvíjané schopnosti:

- viacportový import do lokálneho dashboardu (`8000`, `8001`, `8002`, `8003`, `8004`, `8005`),
- bulk import cez `/api/v1/import/bulk`,
- direct URL resolving pre množstvo zdrojov a prehrávačov,
- HLS master playlist parsing a výber kvalít,
- direct badge a stavové označenie pri položkách,
- metadata prefetch pre kvalitu, veľkosť, duration, thumbnail a hosting,
- duplicate check voči Nexus knižnici,
- watchlist/queue pre postupné spracovanie,
- batch cache a obnovenie posledných scanov,
- preview modal v hlavnom popup-e,
- live overlay player v pravom import paneli,
- Picture-in-Picture režim pre plávajúce video mimo stránky,
- fullscreen prehrávač,
- zoom a obrazové filtre: jas, kontrast, saturácia, gamma, zaostrenie,
- kopírovanie direct URL a otvorenie direct URL,
- IDM download hook,
- zachytávanie streamov cez `webRequest`,
- CORS/proxy pomocné požiadavky cez background script,
- declarativeNetRequest pravidlá pre odstránenie problémových headerov,
- špecifická podpora pre viacero webov a hostingov vrátane Bunkr, GoFile, Filester, Pixeldrain, Erome, XVideos, Eporner, Pornhub, NoodleMagazine, CamWhores, Thots.tv, HornySimp, NSFW247, PornHoarder, Archivebate/Recurbate, Fullporner, SxyPrn, Beeg, xHamster, CyberLeaks a ďalších.

## Hlavné UI časti

### Popup explorer

Hlavné rozhranie extensionu. Slúži na scan stránky, filtrovanie, výber položiek, import, kopírovanie URL, prácu s queue/watchlistom, zobrazovanie metadát a preview prehrávanie.

### Universal import overlay

Plávajúci panel priamo na stránke. Je určený na rýchlu prácu bez otvárania dashboardu. Vie:

- nájsť práve prehrávaný alebo zachytený stream,
- ukázať veľkosť alebo HLS kvality,
- zablokovať import streamov so známou veľkosťou pod 10 MB na všetkých weboch,
- kopírovať a otvárať direct URL,
- poslať stream do Nexusu na vybraný port,
- spustiť IDM download,
- prehrať stream v mini live prehrávači,
- poslať video do Picture-in-Picture režimu.
- na Bunkr video stránkach odstrániť znovu vložené obrázkové reklamy smerujúce na `fh-dxy.com` a zabrániť ich presmerovaniu,
- zabrániť tomu, aby kliknutia v paneli spracovali klikacie handlery zdrojovej stránky.

### Video modal v popup-e

Slúži na preview prehrávanie položiek z gridu. Podporuje HLS, kvality, direct copy/open a zoom.

### Eporner Quick Import

Na stránkach s video zoznamami vytvorí Quick Import prehľadnú galériu s voľbou 3, 4, 5 alebo 6 stĺpcov; predvolené je 5. Na užších oknách sa mriežka automaticky zúži. Panel zachováva filtrovanie, triedenie, načítanie ďalších stránok a hromadný import.

## Aktualizačný strom

### 2026-05-07

Dokončené:

- pridaný live player pod výber portov v pravom `Import to Nexus` overlay paneli,
- pridané načítanie `hls.min.js` pred `universal_importer.js`,
- doplnené prehrávanie zachytených direct streamov priamo v overlayi,
- doplnená podpora HLS `.m3u8` v overlay prehrávači,
- doplnené tlačidlá Play, Picture-in-Picture a Fullscreen,
- doplnený resizable player box,
- doplnené obrazové filtre: zoom, jas, kontrast, saturácia, gamma a zaostrenie,
- doplnené Play tlačidlo pri HLS quality variantoch,
- overená syntax `universal_importer.js`,
- overený JSON formát `manifest.json`,
- overený prípad CamWhores detail stránky, kde stránka existovala, ale reálny MP4 endpoint bol nedostupný.

Súbory upravované v tejto vlne:

- `manifest.json`
- `universal_importer.js`
- `universal_importer.css`
- `README.md`

### Predchádzajúce smery vývoja

- Turbo/Simpcity content integrácia,
- Turbo Vault galéria zobrazuje 12 kariet na stránku a podporuje vyhľadávanie, triedenie, výber, prehratie a import označených videí priamo z galérie,
- Bunkr bridge a práca s výberom albumov,
- PornHoarder/Fullporner player interceptory,
- veľký popup explorer s batch, queue, filter a metadata workflow,
- direct stream resolving cez background service worker,
- dashboard import API komunikácia,
- cache posledných scanov a stavov batchov.

## Plán ďalších úprav

Krátkodobý plán:

- pridať "Pin player" režim, aby overlay zostal otvorený aj bez hoveru,
- ukladať pozíciu a veľkosť overlay playera do `chrome.storage.local`,
- pridať auto Picture-in-Picture po úspešnom nájdení streamu,
- pridať lepší stav prehrávača: `resolving`, `playable`, `blocked`, `dead source`, `proxy fallback`,
- pridať rýchly snapshot aktuálneho frame-u z playera,
- zobrazovať pri direct linku aj typ streamu: MP4, HLS, MOV, WebM, unknown,
- zjednotiť texty UI medzi slovenčinou a angličtinou.

Strednodobý plán:

- vytvoriť samostatný diagnostický panel pre mŕtve streamy,
- automaticky testovať `HEAD` a krátky `Range` request pred importom,
- ukladať výsledok dostupnosti streamu k položke,
- pridať retry stratégiu pre expirované `get_file` linky,
- rozšíriť podporu pre viac HLS variantov a fallback proxy,
- zlepšiť rozpoznávanie preview/trailer streamov oproti full videám,
- doplniť interný changelog priamo do popup UI.

Dlhodobejší plán:

- modulárne oddeliť resolvery podľa webov,
- vyrobiť testovaciu sadu pre najdôležitejšie zdroje,
- pridať health dashboard pre podporované weby,
- pripraviť ľahší režim extensionu iba pre overlay/import,
- pripraviť profesionálnejšie nastavenia pre porty, dashboard URL, IDM, proxy a prehrávač,
- zvážiť samostatné plávajúce Chrome popup okno pre player tam, kde Picture-in-Picture nestačí.

## Poznámky k používaniu

Po úprave súborov extensionu treba v Chrome otvoriť `chrome://extensions`, nájsť `Nexus_Gallery` a kliknúť na Reload. Až potom Chrome načíta najnovší `manifest.json`, content scripty a CSS.

Ak sa stream neprehrá, nemusí to automaticky znamenať chybu extensionu. Niektoré weby vracajú detail stránku normálne, ale samotný direct MP4 endpoint je `404`, expirovaný, zamenený za placeholder alebo vyžaduje nový podpis/token.

## Stav projektu

Nexus Gallery je aktívne vyvíjaný pracovný nástroj. Jeho cieľom je byť rýchly, praktický a prispôsobený reálnemu používaniu: nájsť stream, overiť ho, pustiť ho, importovať ho a nebrzdiť používateľa pri ďalšom browsovaní.


### FapFolder: spoločná galéria viacerých zdrojov

Na stránke Communities (vrátane `/meno/groups`) označ **Pridať do spoločného gridu** na kartách komunít. Panel umožňuje pridať aj odkazy `/groups/názov/videos`, `/pages/názov/videos`, `/profil/videos` a jednotlivé video vlákna `/posts/ID`. Pri video príspevkoch sa zobrazuje vlastný checkbox na pridanie vlákna. Výber zdrojov sa ukladá lokálne v prehliadači; ďalšie komunity načítané natívnym See More sa dajú označiť tiež.

**Vytvoriť / obnoviť grid** načíta každý označený kanál od začiatku, vrátane všetkých stránok See More. Rovnaký post sa zobrazí raz so zoznamom zdrojov. Stav každého zdroja rozlišuje kompletné, neúplné a zastavené načítanie. Zlyhanie jedného zdroja nezahodí ostatné videá. Tlačidlo **Zastaviť načítanie** preruší sieťovú požiadavku; opätovné vytvorenie gridu začne nový úplný priechod.

V spoločnom gride zostávajú výber videí, filtre, radenie, Fetch sizes / quality, import a Save as Source Board. **Prehrať** načíta čerstvú adresu videa do prehrávača na karte. **HD náhľady** zmerajú metadáta a vytvoria ostrý náhľad z videa (max. šírka 1920 px); ak server nepovolí CORS, zostane pôvodný náhľad a karta uvedie chybu. HD obrázky slúžia aktuálnemu gridu, import používa pôvodný vzdialený poster. Pri označených videách tieto hromadné operácie spracujú výber; inak všetky viditeľné videá. Späť na stránku obnoví pôvodný zoznam. Samotný grid sa po obnovení stránky zostavuje znovu; vybrané zdroje zostávajú uložené.

Po aktualizácii rozšírenia ho obnov v `chrome://extensions` a obnov FapFolder stránku. Obsahový skript sa teraz spúšťa na celom FapFolderi, aby bol výber dostupný aj na zozname sledovaných komunít.

Overenie logiky: `node --test extensions/Nexus_Gallery/tests/fapfolder_mix.test.cjs extensions/Nexus_Gallery/tests/fapfolder_cards.test.cjs tests/fapfolder_metadata.test.cjs`.
Lokálny klikací test: `node tests/fapfolder_mix_ui_fixture.cjs` a otvor `http://127.0.0.1:8794`. Tri zdroje vracajú 120 položiek / 100 jedinečných postov v dávkach po 12; import smeruje iba do testovacieho záznamu, nie do Nexus databázy.


Na kartách komunít je dostupné aj **Zistiť všetky videá / veľkosť**. Táto akcia prejde celú video galériu cez See More bez otvorenia spoločného gridu alebo zmeny výberu. Najprv ukáže počet unikátnych videí, potom priebežne doplní súčet veľkostí a priemernú dĺžku. Neznáme hodnoty sa nezapočítajú ako nuly; zátvorka napr. `(28/34)` označuje pokrytie údajov. Pri neúplnom načítaní zoznamu má počet predponu `≥`. Dĺžka z metadát príspevku má prednosť pred sondovaním videosúboru. Viac spustených komunít sa spracuje vo fronte, vždy s dvoma súbežnými požiadavkami na metadáta. Výsledok zostáva na karte počas aktuálnej stránky; **Obnoviť údaje o videách** načíta čerstvé údaje. Prebiehajúcu akciu možno zastaviť (aktuálne požiadavky na metadáta musia dobehnúť).
