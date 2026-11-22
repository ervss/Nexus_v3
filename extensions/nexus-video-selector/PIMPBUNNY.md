# PimpBunny import panel

Súčasť **Nexus Video Card Selector Fresh_v2**. Obnov rozšírenie v `chrome://extensions` a potom stránku PimpBunny.

## Ovládanie

- Pravý panel spája filtre, výber, metadáta a import. Hlavné tlačidlo importu je v samostatnej dolnej časti; pokročilé ovládanie sa posúva nezávisle.
- Hľadanie podľa názvu, radenie podľa kvality, dĺžky, veľkosti, dátumu a názvu. Rozsahové filtre a viacero kvalít sú v zbalenej sekcii.
- Počty sa vzťahujú na unikátne videá. Opakované karty sú skryté a ich výber sa synchronizuje.
- Klik na náhľad alebo checkbox vyberá video, titulok otvára detail.
- Import vybraných zahŕňa aj vybrané videá mimo filtrov; upozornenie uvádza ich počet. Import vyhovujúcich a všetkých je pod „Ďalšie možnosti importu“.
- Port 8000/8001/8002 je pevný cieľ; pri chybe sa nepoužije iný port. Odznačia sa iba položky potvrdené serverom. Nepotvrdený import zachová výber.
- Importuje sa kanonická stránka videa s dostupnými metadátami. Podpísané streamy a krátke preview URL sa do importu neposielajú.
- „Načítanie a metadáta“ doplní chýbajúce údaje alebo obnoví vybrané. Existujúca fronta metadát obmedzuje počet súbežných požiadaviek.
- **Tagy videí:** „Načítať tagy“ spracuje všetky načítané videá; „Tagy vybraných“ iba aktuálny výber. Číta tagy a kategórie konkrétneho videa z detailu, nie globálne kategórie navigácie. Počet `načítané/celkom` a priebeh zostávajú viditeľné.
- Načítanie tagov používa najviac tri súbežné požiadavky. „Zastaviť tagy“ preruší prebiehajúce požiadavky; dokončené zostanú uložené. Opakované načítanie preskočí úspešné videá a zopakuje iba chýbajúce/chybné. Cache v sessionStorage platí 24 hodín, uchová najviac 500 videí a nemení cache technických metadát.
- Klikateľné tagy uvádzajú počet videí a zapínajú filter. Čiarkou oddelené slová vyžadujú všetky zadané tagy; medzery zodpovedajú pomlčkám v slugu. Pri aktívnom filtri nenačítané tagy nevyhovujú. Po načítaní má každá karta rozbaľovací zoznam „Tagy (N)“.
- Načítané tagy sa prenesú do importu spolu s označeniami `selector,extension`. Import bez predchádzajúceho načítania tagov zostáva možný.
- Ďalšie stránky sa pripájajú podľa natívnej navigácie; zoznam používa `/videos/2/`, vyhľadávanie `?from_videos=2`. Vyhľadávanie má AJAX odkazy `href="#"`, preto panel číta číslo strany z `data-parameters` a načíta plnú HTML stránku. Zachováva sort, filtre aj veľkosť strany. Používa výhradne stránkovanie videí, nie albumov/modelov; aktuálnu stranu číta z navigácie aj po natívnom AJAX prechode. Opakované URL sa nepridávajú.
- Zbalenie panela ponechá tlačidlo na opätovné otvorenie. Na širokej obrazovke je pre panel vyhradené miesto napravo.

## Overenie

`node --test tests/pimpbunny_tags.test.cjs tests/pimpbunny_listing.test.cjs tests/import_workbench.test.cjs tests/xhamster_listing.test.cjs`

Overená je URL politika, stránkovanie, deduplikácia, importné payloady, zachovanie výberu pri chybe a spoločné filtrovanie/radenie. Pred úpravou boli aktuálne selektory kariet a stránkovanie skontrolované v živom PimpBunny DOM.

Stránkovanie vyhľadávania overené 2026-10-09 na otvorenej stránke `/search/big-fake-tits/`: klik na „+ Načítať ďalšie“ zvýšil počet z 29 na 58 videí; ďalší klik s počtom 2 načítal ďalšie dve strany a zvýšil počet na 117. Pôvodných 29 načítaných tagov zostalo zachovaných. Screenshot skutočného panela: `artifacts/pimpbunny-pagination/live-panel.jpg`. Pri tomto overení bol opravený parser načítaný vývojárskym API do existujúceho kontextu rozšírenia; na trvalé načítanie verzie z disku treba obnoviť rozšírenie a stránku. Regresné testy zahŕňajú skutočné AJAX parametre, súbežné stránkovanie albumov, zachovanie filtrov, zmenu viditeľnej strany bez zmeny adresy a poslednú stranu 200.

Tagy: v reálnom prehliadači na lokálnej neutrálnej stránke boli vykonané načítanie tagov, klik na tag, kombinovaný filter, výber, otvorenie tagov pri karte a simulovaný import. Screenshoty: `artifacts/pimpbunny-tags/panel.png` a `filtered-import.png`. Stránka používa skutočný panel, parser a loader s lokálnymi detailmi; simulovaný import neposiela údaje do databázy.

Testovaciu stránku spustí `node tests/pimpbunny_tags_fixture.cjs`; konzola vypíše pridelenú lokálnu URL. Voliteľný argument nastaví port.

Selektor tagov bol potvrdený aj v živom detaile PimpBunny. **Živé načítanie novej funkcie a skutočný import s tagmi zatiaľ zostávajú neoverené:** v Chrome je stále načítaná predchádzajúca verzia rozšírenia. Obnov **Nexus Video Card Selector Fresh_v2** a potom kartu PimpBunny.
