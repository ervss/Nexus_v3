/**
 * Nexus PWC - Universal i18n & Translation Engine
 * Full bilingual support: Slovak (sk) & English (en)
 * Ensures 100% translation consistency across Dashboard, Modals, Toasts, and Scripts.
 */
(function (global) {
    'use strict';

    const STORAGE_KEY = 'nexus_language';
    const VIP_SETTINGS_KEY = 'vipSettings';

    const TRANSLATIONS = {
        sk: {
            // General & Common
            "Settings": "Nastavenia",
            "General": "Všeobecné",
            "Player": "Prehrávač",
            "System": "Systém",
            "System & Optimization": "Systém a optimalizácia",
            "Database": "Databáza",
            "Cancel": "Zrušiť",
            "Save": "Uložiť",
            "Save Settings": "Uložiť nastavenia",
            "Save & Close": "Uložiť a zavrieť",
            "Close": "Zavrieť",
            "Back to App": "Späť do aplikácie",
            "Delete": "Zmazať",
            "Remove": "Odstrániť",
            "Edit": "Upraviť",
            "Refresh": "Obnoviť",
            "Search": "Hľadať",
            "Search...": "Hľadať...",
            "Loading...": "Načítavam...",
            "Import": "Importovať",
            "Export": "Exportovať",
            "Status": "Stav",
            "Error": "Chyba",
            "Success": "Úspech",
            "Warning": "Upozornenie",
            "Info": "Informácia",
            "All": "Všetky",
            "None": "Žiadne",
            "Default": "Predvolené",
            "Selected": "Vybrané",
            "Clear": "Vyčistiť",
            "Clear Selection": "Zrušiť výber",
            "Copy": "Kopírovať",
            "Copy direct": "Kopírovať priame URL",
            "Copy source": "Kopírovať source URL",
            "Copy URLs": "Kopírovať URL",
            "Fav": "Obľúbené",
            "Favorite": "Obľúbené",
            "Favorites": "Obľúbené",
            "Watched": "Sledované",
            "Unwatched": "Nesledované",
            "Verified": "Overené",
            "Unverified": "Neoverené",
            "Play": "Prehrať",
            "More Info": "Viac info",
            "Overview": "Prehľad",
            "Console": "Konzola",
            "Admin Tools": "Nástroje správcu",
            "Admin tools enabled": "Nástroje správcu povolené",
            "Admin tools hidden": "Nástroje správcu skryté",
            "Settings saved": "Nastavenia uložené",

            // Settings Modal Tabs & Headings
            "Vzhľad": "Vzhľad",
            "Prehrávanie": "Prehrávanie",
            "Telegram": "Telegram",
            "Pohľady knižnice": "Pohľady knižnice",
            "Knižnica": "Knižnica",
            "Náhľady": "Náhľady",
            "Tagy a AI": "Tagy a AI",
            "Vzhľad a prostredie": "Vzhľad a prostredie",
            "Prehrávanie videí": "Prehrávanie videí",
            "Pripojenie Telegramu": "Pripojenie Telegramu",
            "Správa knižnice": "Správa knižnice",
            "Náhľady videí": "Náhľady videí",
            "Tagy a AI analýza": "Tagy a AI analýza",
            "Motív, hustota zobrazenia a výkon aplikácie.": "Motív, hustota zobrazenia a výkon aplikácie.",
            "Predvolené správanie prehrávača pre tvoje videá.": "Predvolené správanie prehrávača pre tvoje videá.",
            "Pripoj svoj účet na vyhľadávanie v kanáloch a skupinách.": "Pripoj svoj účet na vyhľadávanie v kanáloch a skupinách.",
            "Optimalizácia, opravy a upratovanie dát na jednom mieste.": "Optimalizácia, opravy a upratovanie dát na jednom mieste.",
            "Kontrola a staršie pohľady knižnice.": "Kontrola a staršie pohľady knižnice.",
            "Vylepšenie náhľadov celej knižnice, batchu alebo výberu.": "Vylepšenie náhľadov celej knižnice, batchu alebo výberu.",
            "Doplnenie tagov zo zdrojových stránok a analýza náhľadov.": "Doplnenie tagov zo zdrojových stránok a analýza náhľadov.",
            "Prispôsobenie prostredia a správa knižnice": "Prispôsobenie prostredia a správa knižnice",
            "Pohľady a kontrola": "Pohľady a kontrola",
            "Stav pripojenia": "Stav pripojenia",
            "Správcovské nástroje": "Správcovské nástroje",
            "ON — zapnuté (predvolené)": "ON — zapnuté (predvolené)",
            "OFF — vypnuté": "OFF — vypnuté",
            "Opakovanie videa": "Opakovanie videa",
            "Predvolená rýchlosť": "Predvolená rýchlosť",
            "Uprednostniť HLS": "Uprednostniť HLS",
            "Pri opätovnom načítaní videa použije kvalitnejší HLS stream, ak je dostupný.": "Pri opätovnom načítaní videa použije kvalitnejší HLS stream, ak je dostupný.",
            "Podsvietenie Ambilight": "Podsvietenie Ambilight",
            "Efekt podsvietenia okolo videa. Predvolene je vypnutý pre plynulejšie prehrávanie.": "Efekt podsvietenia okolo videa. Predvolene je vypnutý pre plynulejšie prehrávanie.",
            "Optimalizácia knižnice": "Optimalizácia knižnice",
            "Automatická optimalizácia": "Automatická optimalizácia",
            "Upraví názvy, nájde duplicity a ponechá verzie v najlepšej kvalite.": "Upraví názvy, nájde duplicity a ponechá verzie v najlepšej kvalite.",
            "Duplicitné videá": "Duplicitné videá",
            "Podľa názvu": "Podľa názvu",
            "Podľa obrazu": "Podľa obrazu",
            "Čistenie databázy": "Čistenie databázy",
            "Odstrániť nefunkčné odkazy": "Odstrániť nefunkčné odkazy",
            "Vymazať celú databázu": "Vymazať celú databázu",
            "Oprava údajov": "Oprava údajov",
            "Opraviť náhľady": "Opraviť náhľady",
            "Zopakovať kontrolu náhľadov": "Zopakovať kontrolu náhľadov",
            "Doplniť dĺžky": "Doplniť dĺžky",
            "Zistiť veľkosti": "Zistiť veľkosti",
            "Obnoviť údaje importu": "Obnoviť údaje importu",
            "Obnoviť odkazy Bunkr": "Obnoviť odkazy Bunkr",
            "Opraví chýbajúce dĺžky, rozlíšenie a náhľady. Opakovaná kontrola skúsi označené videá ešte raz a odstráni tie, ktoré stále zlyhávajú.": "Opraví chýbajúce dĺžky, rozlíšenie a náhľady. Opakovaná kontrola skúsi označené videá ešte raz a odstráni tie, ktoré stále zlyhávajú.",
            "Inteligentné vylepšenie náhľadov": "Inteligentné vylepšenie náhľadov",
            "Skenuje vidéa so slabým náhľadom. Extrahuje 5 framov (15–55% dĺžky videa) a automaticky vyberie ten s najlepším vizuálnym obsahom — preskočí intro, logo a čierne scény.": "Skenuje vidéa so slabým náhľadom. Extrahuje 5 framov (15–55% dĺžky videa) a automaticky vyberie ten s najlepším vizuálnym obsahom — preskočí intro, logo a čierne scény.",
            "Celá knižnica": "Celá knižnica",
            "Zastaviť": "Zastaviť",
            "Skontrolovať stav": "Skontrolovať stav",
            "Podľa Batchu": "Podľa Batchu",
            "Vybrané videá": "Vybrané videá",
            "Spracúvam...": "Spracúvam...",
            "Dokončené": "Dokončené",
            "Zastavené": "Zastavené",
            "Prebieha AI analýza...": "Prebieha AI analýza...",
            "Otagovať chýbajúce (Knižnica)": "Otagovať chýbajúce (Knižnica)",
            "Otagovať aktuálny batch": "Otagovať aktuálny batch",
            "Otagovať načítaný pohľad": "Otagovať načítaný pohľad",
            "Otagovať označené": "Otagovať označené",
            "Dávka: 50 videí": "Dávka: 50 videí",
            "Dávka: 250 videí": "Dávka: 250 videí",
            "Dávka: 1000 videí": "Dávka: 1000 videí",
            "Doplnenie tagov zo zdrojov": "Doplnenie tagov zo zdrojov",
            "Doplniť chýbajúce tagy": "Doplniť chýbajúce tagy",
            "Doplniť tagy aktuálneho batchu": "Doplniť tagy aktuálneho batchu",
            "Načíta tagy zo stránok videí, napríklad Eporner a WhoresHub. Samotné súborové úložiská preskočí.": "Načíta tagy zo stránok videí, napríklad Eporner a WhoresHub. Samotné súborové úložiská preskočí.",
            "Úprava názvov": "Úprava názvov",
            "Vyčistiť názvy videí": "Vyčistiť názvy videí",
            "Nastavenia sa ukladajú v tomto prehliadači.": "Nastavenia sa ukladajú v tomto prehliadači.",

            // Settings Modal
            "Settings are automatically saved in this browser.": "Voľba sa automaticky zapamätá v tomto prehliadači.",
            "Interface": "Rozhranie",
            "Classic": "Klasické",
            "Netflix": "Netflix",
            "Display Density": "Hustota zobrazenia",
            "Compact": "Kompaktné",
            "Comfortable": "Vzdušné",
            "Color Theme": "Farebný motív",
            "Dark": "Tmavý",
            "Light": "Svetlý",
            "UI Language": "Jazyk rozhrania",
            "Language": "Jazyk",
            "Tooltip Language": "Jazyk pomocných popisov",
            "UI / Tooltip Language": "Jazyk rozhrania a popisov",
            "Accent Color": "Farba zvýraznenia",
            "Purple": "Fialová",
            "Blue": "Modrá",
            "Green": "Zelená",
            "Orange": "Oranžová",
            "Lite Mode (Default)": "Ľahký režim (predvolený)",
            "Battery-friendly display without animations and blur.": "Úsporné zobrazenie bez animácií a rozmazania.",
            "The same toggle is in the top bar. Changes are saved and reload the page.": "Rovnaký prepínač nájdeš v hornej lište. Zmena sa zapamätá a obnoví stránku.",
            "Fast Browsing": "Rýchle prehliadanie",
            "Disables heavy visual effects while scrolling for maximum smoothness.": "Vypne náročné efekty pri listovaní pre maximálnu plynulosť.",
            "Autoplay": "Automatické prehrávanie",
            "Start playing video immediately upon opening": "Spustiť video ihneď po otvorení",
            "Playback Loop": "Slučka prehrávania",
            "Loop video automatically when it finishes": "Po skončení videa začať odznova",
            "Playback Speed": "Rýchlosť prehrávania",
            "HLS Player": "Prehrávač HLS",
            "Use adaptive HLS stream when available": "Použiť adaptívny HLS stream ak je dostupný",
            "Ambilight Effect": "Ambilight efekt",
            "Dynamic backlight around video (requires Lite Mode disabled)": "Dynamické farebné podsvietenie okolo videa (vyžaduje vypnutý Ľahký režim)",
            "Thumbnail Generation Speed": "Rýchlosť generovania miniatúr",
            "Fast": "Rýchle (Fast)",
            "Medium": "Vyvážené (Medium)",
            "High Quality": "Vysoká kvalita (High Quality)",
            "Smart Playlists": "Výber filtrovania (Smart Playlists)",
            "Filter by smart playlists": "Filtrovať podľa smart zoznamov",

            // Database & Maintenance in Settings
            "Database Management & Optimization": "Správa databázy a optimalizácia",
            "Full Optimization": "Kompletná optimalizácia",
            "Cleans database, reindexes FTS, removes invalid records and verifies integrity.": "Prečistí databázu, preindexuje FTS, vymaže neplatné záznamy a skontroluje integritu.",
            "Run Optimization": "Spustiť optimalizáciu",
            "Clean Broken Links": "Vyčistiť nefunkčné linky",
            "Removes videos with permanently dead sources.": "Odstráni videá s trvalo nedostupnými zdrojmi.",
            "Clean Links": "Vyčistiť linky",
            "Resolve Duplicates by Name": "Vyriešiť duplikáty podľa názvu",
            "Merges videos with identical normalized titles, keeping the best quality.": "Zlúči videá s rovnakým normalizovaným názvom a ponechá najlepšiu kvalitu.",
            "Merge Duplicates": "Zlúčiť duplikáty",
            "Resolve Visual Duplicates (Hash)": "Vyriešiť vizuálne duplikáty (Hash)",
            "Finds and merges identical videos based on visual perceptual hash (phash).": "Nájde a zlúči rovnaké videá na základe vizuálneho odtlačku (phash).",
            "Merge by Hash": "Zlúčiť podľa hashu",
            "Normalize Video Titles": "Normalizovať názvy videí",
            "Strips clutter, junk prefixes and extensions from all video titles.": "Odstráni balast a predpony/prípony zo všetkých názvov videí.",
            "Normalize": "Normalizovať",
            "Fix Missing Thumbnails": "Opraviť chýbajúce miniatúry",
            "Re-queues thumbnail generation for videos where it previously failed.": "Znovu zaradí do fronty generovanie miniatúr pre videá, kde zlyhali.",
            "Fix Thumbnails": "Opraviť miniatúry",
            "Retry Flagged Previews": "Znovu skúsiť označené náhľady",
            "Retries previews that were flagged as problematic.": "Znova spustí náhľady, ktoré boli označené ako problematické.",
            "Retry Previews": "Znovu skúsiť náhľady",
            "Sync Durations from Source": "Synchronizovať dĺžky videí zo zdroja",
            "Re-fetches precise video durations from the original stream.": "Dohľadá a zosynchronizuje presné trvanie videí priamo zo zdrojov.",
            "Sync Durations": "Synchronizovať dĺžky",
            "Extract File Sizes": "Zistiť veľkosti súborov",
            "Probes stream headers and updates missing video file sizes.": "Preverí streamy a doplní chýbajúce veľkosti súborov v databáze.",
            "Extract Sizes": "Zistiť veľkosti",
            "Refresh Metadata from Sources": "Obnoviť metadáta zo zdrojov",
            "Updates titles, tags and duration info from source pages.": "Obnoví informácie o videách a názvy zo vzdialených serverov.",
            "Refresh Metadata": "Obnoviť metadáta",
            "Enrich Missing Tags": "Obohatiť chýbajúce tagy",
            "Uses semantic analysis to generate tags for videos without any.": "Automaticky doplní tagy a kategórie pre videá, kde zatiaľ chýbajú.",
            "Start Enrichment": "Spustiť obohatenie",
            "Refresh Bunkr in Current Batch": "Obnoviť Bunkr v aktuálnom batchi",
            "Re-checks and repairs stream links for all Bunkr items in batch.": "Preverí a obnoví odkazy pre všetky Bunkr videá vo vybranom batchi.",
            "Refresh Bunkr": "Obnoviť Bunkr",

            // Sidebar & Filters
            "Batches": "Dávky (Batches)",
            "All Imports": "Všetky importy",
            "Sort by": "Zoradiť podľa",
            "Sort by: ": "Zoradiť podľa: ",
            "Newest first": "Najnovšie prvé",
            "Oldest first": "Najstaršie prvé",
            "Largest first": "Najväčšie prvé",
            "Smallest first": "Najmenšie prvé",
            "Longest first": "Najdlhšie prvé",
            "Shortest first": "Najkratšie prvé",
            "Title A-Z": "Podľa názvu A-Z",
            "Title Z-A": "Podľa názvu Z-A",
            "Quality": "Kvalita",
            "Source": "Zdroj",
            "Tags": "Tagy",
            "Duration": "Dĺžka",
            "File Size": "Veľkosť súboru",
            "Import Date": "Dátum importu",
            "No Thumbnail": "Bez náhľadu",
            "Search & Join": "Hľadať a pripojiť",
            "Expand sidebar": "Rozbaliť bočný panel",
            "Collapse sidebar": "Zbaliť bočný panel",

            // Batch actions & selection
            "Select Displayed": "Označiť zobrazené",
            "Select loaded cards for batch rethumb": "Označiť načítané karty na dávkový Rethumb",
            "Displays and selects all videos from the batch of selected card": "Zobrazí a označí všetky videá z batchu vybratej karty",
            "Copies direct URLs of selected videos to clipboard": "Skopíruje priame URL vybraných videí do schránky",
            "Copies source pages of selected videos to clipboard": "Skopíruje source stránky vybraných videí do schránky",
            "Refresh Links": "Obnoviť linky",
            "Refresh Links for selected videos. Use this when only selected items have expired stream URLs.": "Obnoviť odkazy pre vybrané videá.",
            "Select filtered": "Označiť filtrované",
            "Select HD/FHD": "Označiť HD/FHD",
            "Select verified": "Označiť overené",
            "Select without metadata": "Označiť bez metadát",
            "Verify all": "Overiť všetky",

            // Drag overlay & Import
            "Drop .mp4, .mkv, .avi, .mov, .webm, .txt or .json file": "Drop .mp4, .mkv, .avi, .mov, .webm, .txt alebo .json súbor",
            "Import video directly from disk or playlist/text/JSON": "Importuj video priamo z disku alebo playlist/text/JSON",
            "Import Progress:": "Priebeh importu:",
            "Importing...": "Importujem...",
            "Imported": "Importované",
            "Create & Import": "Vytvoriť a importovať",
            "Start Import": "Spustiť import",
            "Add to Batch": "Pridať do dávky",

            // Thumbnails & Rethumb
            "Manually run rethumb: batches of 100 until weak thumbnails are exhausted": "Ručne spustiť rethumb: dávky po 100 až do vyčerpania slabých náhľadov",
            "Status unavailable": "Stav nedostupný",
            "Estimated time remaining:": "Odhad do konca dávky:",
            "Generating Thumbnails": "Generovanie náhľadov",

            // External hubs (CamWhores, Webshare, Telegram, Sxyprn, etc.)
            "All loaded playlists": "Všetky načítané playlisty",
            "All durations": "Všetky dĺžky",
            "All cards": "Všetky karty",
            "Up to 10 min": "Do 10 minút",
            "10 to 30 min": "10 až 30 minút",
            "Over 30 min": "Nad 30 minút",
            "Only verified": "Iba overené",
            "Only unverified": "Iba neoverené",

            // Notifications & Toast Messages
            "To select an entire batch, first select a card from the batch.": "Pre výber celého batchu najprv označ kartu z batchu.",
            "No videos found in batch \"{0}\".": "V batchi „{0}“ sa nenašli žiadne videá.",
            "Copying failed — please check clipboard permissions.": "Kopírovanie zlyhalo — skontroluj povolenie schránky.",
            "Copied {0} direct URLs.": "Skopírovaných {0} priamych URL.",
            "Copied {0} source URLs.": "Skopírovaných {0} source URL.",
            "Video search failed": "Vyhľadávanie videí zlyhalo",
            "Video has been removed.": "Video bolo odstránené.",
            "Video deletion failed.": "Zmazanie videa zlyhalo.",
            "Connection to Nexus failed.": "Spojenie s Nexusom zlyhalo.",
            "No videos to display.": "Žiadne videá na zobrazenie.",
            "No items to send.": "Žiadne položky na odoslanie.",
            "No links found.": "Žiadne odkazy nenájdené.",
            "Nothing selected to import.": "Nič nie je vybrané na import.",
            "Import request failed": "Požiadavka na import zlyhala",
            "Import completed successfully.": "Import bol úspešne dokončený.",
            "No videos with better quality are available for replacement.": "Žiadne videá s lepšou kvalitou nie sú k dispozícii na nahradenie.",
            "Successfully replaced in Nexus!": "Úspešne nahradené v Nexuse!",
            "Replaced {0} videos in Nexus with a new better version!": "Nahradených {0} videí v Nexuse novou lepšou verziou!",
            "Replacement failed: {0}": "Nahradenie zlyhalo: {0}",
            "TURBO — effects and polling disabled": "TURBO — efekty a poll-ovanie vypnuté",
            "Turbo disabled — reloading…": "Turbo vypnuté — obnovujem…",

                        "Duration": "D\u013a\u017eka",
            "Video Duration": "D\u013a\u017eka videa",
            "File Size": "Ve\u013ekos\u0165",
            "Video Size": "Ve\u013ekos\u0165 videa",
            "Date": "D\u00e1tum",
            "Date From": "D\u00e1tum od",
            "Date To": "D\u00e1tum do",
            "No Thumbnail": "Bez n\u00e1h\u013eadu",
            "Any": "Ak\u00e1ko\u013evek",
            "Entire Batch": "Cel\u00fd batch",
            "Overall Confidence": "Celkov\u00e1 d\u00f4vera",
            "Add Tags": "Doplni\u0165 tagy",
            "2 columns": "2 st\u013apce",
            "3 columns": "3 st\u013apce",
            "4 columns": "4 st\u013apce",
            "5 columns": "5 st\u013apcov",
            "6 columns": "6 st\u013apcov",
            "7 columns": "7 st\u013apcov",
            "24 hours": "24 hod\u00edn",
            "7 days": "7 dn\u00ed",
            "30 days": "30 dn\u00ed",
            "Combined View": "Spolo\u010dn\u00fd poh\u013ead",
            "Clear Combined View": "Zru\u0161i\u0165 spolo\u010dn\u00fd poh\u013ead",
            "Batch AI Tags": "AI tagy batchu",
            "Batches AI Tags": "AI tagy batchov",
            "Select Displayed": "Ozna\u010di\u0165 zobrazen\u00e9",
            "Select loaded cards for batch rethumb": "Ozna\u010di\u0165 na\u010d\u00edtan\u00e9 karty na d\u00e1vkov\u00fd Rethumb",
            "Clear Selection": "Zru\u0161i\u0165 v\u00fdber",
            "Delete Selected": "Vymaza\u0165 vybran\u00e9",
            "Show": "Zobrazi\u0165",
            "Hide": "Skry\u0165",
            "Play": "Prehra\u0165",
            "Play Next": "Prehra\u0165 \u010fal\u0161ie",
            "Stop": "Zastavi\u0165",
            "Close": "Zavrie\u0165",
            "Cancel": "Zru\u0161i\u0165",
            "Save": "Ulo\u017ei\u0165",
            "Done": "Hotovo",
            "Import": "Importova\u0165",
            "Export": "Exportova\u0165",
            "Copy": "Kop\u00edrova\u0165",
            "Copy URLs": "Kop\u00edrova\u0165 URL",
            "Copy Direct URLs": "Kop\u00edrova\u0165 priame URL",
            "Copy Source URLs": "Kop\u00edrova\u0165 source URL",
            "Verify": "Overi\u0165",
            "Verify All": "Overi\u0165 v\u0161etky",
            "Start": "Spusti\u0165",
            "Start Import": "Spusti\u0165 import",
            "Search & Join": "H\u013eada\u0165 a join\u00fa\u0165",
            "Search": "H\u013eada\u0165",
            "Delete": "Zmaza\u0165",
            "Remove": "Odstr\u00e1ni\u0165",
            "Refresh": "Obnovi\u0165",
            "Refresh Links": "Obnovi\u0165 linky",
            "Active Tags:": "Akt\u00edvne tagy:",
            "Drop .mp4, .mkv, .avi, .mov, .webm, .txt or .json file": "Drop .mp4, .mkv, .avi, .mov, .webm, .txt alebo .json s\u00fabor",
            "Import video directly from disk or playlist/text/JSON": "Importuj video priamo z disku alebo playlist/text/JSON",
            "Import Progress:": "Priebeh importu:",
            "Importing...": "Importujem...",
            "Imported": "Importovan\u00e9",
            "Status Unavailable": "Stav nedostupn\u00fd",
            "Estimated time remaining:": "Odhad do konca d\u00e1vky:",
            "Generating Thumbnails": "Generovanie n\u00e1h\u013eadov",
            "All Loaded Playlists": "V\u0161etky na\u010d\u00edtan\u00e9 playlisty",
            "All Durations": "V\u0161etky d\u013a\u017eky",
            "All Cards": "V\u0161etky karty",
            "Up to 10 min": "Do 10 min\u00fat",
            "10 to 30 min": "10 a\u017e 30 min\u00fat",
            "Over 30 min": "Nad 30 min\u00fat",
            "Only Verified": "Iba overen\u00e9",
            "Only Unverified": "Iba neoveren\u00e9",
            "Select Filtered": "Ozna\u010di\u0165 filtrovan\u00e9",
            "Select HD/FHD": "Ozna\u010di\u0165 HD/FHD",
            "Select Verified": "Ozna\u010di\u0165 overen\u00e9",
            "Select Without Metadata": "Ozna\u010di\u0165 bez metad\u00e1t",
            "To select an entire batch, first select a card from the batch.": "Pre v\u00fdber cel\u00e9ho batchu najprv ozna\u010d kartu z batchu.",
            "Copying failed \u2014 please check clipboard permissions.": "Kop\u00edrovanie zlyhalo \u2014 skontroluj povolenie schr\u00e1nky.",
            "Video search failed": "Video search failed",
            "Video has been removed.": "Video bolo odstr\u00e1nen\u00e9.",
            "Video deletion failed.": "Zmazanie videa zlyhalo.",
            "Connection to Nexus failed.": "Spojenie s Nexusom zlyhalo.",
            "No videos to display.": "\u017diadne vide\u00e1 na zobrazenie.",
            "No items to send.": "\u017diadne polo\u017eky na odoslanie.",
            "No links found.": "\u017diadne odkazy nen\u00e1jden\u00e9.",
            "Nothing selected to import.": "Ni\u010d nie je vybran\u00e9 na import.",
            "Import request failed": "Import request failed",
            "Import completed successfully.": "Import bol \u00faspe\u0161ne dokon\u010den\u00fd.",
            "Show More": "Zobrazi\u0165 viac",
            "Show Less": "Zobrazi\u0165 menej",
            "Load More": "Na\u010d\u00edta\u0165 \u010fal\u0161ie",
            "Expand": "Rozbali\u0165",
            "Collapse": "Zbali\u0165",
            "Download": "Stiahnu\u0165",
            "Downloaded": "Stiahnut\u00e9",
            "Downloading...": "S\u0165ahujem...",
            "Download Video": "Stiahnu\u0165 video",
            "Download Settings": "Nastavenia s\u0165ahovania",
            "Download Manager": "Spr\u00e1vca s\u0165ahovania",
            "Connecting to aria2\u2026": "Prip\u00e1janie k aria2\u2026",
            "Add direct URLs": "Prida\u0165 priame URL",
            "One URL per line": "Jedna URL na riadok",
            "Add downloads": "Prida\u0165 s\u0165ahovanie",
            "Pause active": "Pozastavi\u0165 akt\u00edvne",
            "Resume paused": "Obnovi\u0165 pozastaven\u00e9",
            "Cancel active": "Zru\u0161i\u0165 akt\u00edvne",
            "Open folder": "Otvori\u0165 prie\u010dinok",
            "Automatically clear completed entries": "Automaticky vymaza\u0165 dokon\u010den\u00e9",
            "Save settings": "Ulo\u017ei\u0165 nastavenia",

            // Splitscreen & Userscripts
            "Splitscreen": "Rozdelenie obrazovky (Splitscreen)",
            "Universal Splitscreen": "Univerzálny Split-Screen",
            "Select items for splitscreen": "Vyberte položky pre split-screen",
            "No active videos to import.": "Žiadne aktívne videá na import.",
            "No videos match the current filter.": "Nenašli sa žiadne videá zodpovedajúce filtru.",
            "No videos or cards found on this page.": "Na tejto stránke sa nenašli žiadne videá ani video karty.",
            "Failed to load video data.": "Nepodarilo sa nahrať žiadne video dáta.",
            "Send to Nexus": "Odoslať do Nexusu",
            "Sent to Nexus successfully!": "Úspešne odoslané do Nexusu!",
            "Hide photo albums": "Skryť fotoalbumy",
            "Only photos": "Iba fotky",
            "Album contains only pictures, no videos": "Album obsahuje iba obrázky, žiadne videá",
            "Successfully loaded {0} new albums": "Úspešne načítaných {0} nových albumov",
            "No albums to scan": "Žiadne albumy na skenovanie",
            "No items found in album": "V albume sa nenašli žiadne položky"
        },
        en: {
            // General & Common
            "Nastavenia": "Settings",
            "Všeobecné": "General",
            "Prehrávač": "Player",
            "Systém": "System",
            "Systém a optimalizácia": "System & Optimization",
            "Databáza": "Database",
            "Zrušiť": "Cancel",
            "Uložiť": "Save",
            "Uložiť nastavenia": "Save Settings",
            "Uložiť a zavrieť": "Save & Close",
            "Zavrieť": "Close",
            "Späť do aplikácie": "Back to App",
            "Zmazať": "Delete",
            "Odstrániť": "Remove",
            "Upraviť": "Edit",
            "Obnoviť": "Refresh",
            "Hľadať": "Search",
            "Hľadať...": "Search...",
            "Načítavam...": "Loading...",
            "Importovať": "Import",
            "Exportovať": "Export",
            "Stav": "Status",
            "Chyba": "Error",
            "Úspech": "Success",
            "Upozornenie": "Warning",
            "Informácia": "Info",
            "Všetky": "All",
            "Žiadne": "None",
            "Predvolené": "Default",
            "Vybrané": "Selected",
            "Vyčistiť": "Clear",
            "Zrušiť výber": "Clear Selection",
            "Kopírovať": "Copy",
            "Kopírovať priame URL": "Copy direct URLs",
            "Kopírovať source URL": "Copy source URLs",
            "Kopírovať URL": "Copy URLs",
            "Obľúbené": "Favorites",
            "Sledované": "Watched",
            "Nesledované": "Unwatched",
            "Overené": "Verified",
            "Neoverené": "Unverified",
            "Prehrať": "Play",
            "Viac info": "More Info",
            "Prehľad": "Overview",
            "Konzola": "Console",
            "Nástroje správcu": "Admin Tools",
            "Nástroje správcu povolené": "Admin tools enabled",
            "Nástroje správcu skryté": "Admin tools hidden",
            "Nastavenia uložené": "Settings saved",

            // Settings Modal Tabs & Headings
            "Vzhľad": "Appearance",
            "Prehrávanie": "Playback",
            "Telegram": "Telegram",
            "Pohľady knižnice": "Library Views",
            "Knižnica": "Library",
            "Náhľady": "Previews",
            "Tagy a AI": "Tags & AI",
            "Vzhľad a prostredie": "Appearance & Interface",
            "Prehrávanie videí": "Video Playback",
            "Pripojenie Telegramu": "Telegram Connection",
            "Správa knižnice": "Library Management",
            "Náhľady videí": "Video Previews",
            "Tagy a AI analýza": "Tags & AI Analysis",
            "Motív, hustota zobrazenia a výkon aplikácie.": "Theme, display density, and application performance.",
            "Predvolené správanie prehrávača pre tvoje videá.": "Default player behavior for your videos.",
            "Pripoj svoj účet na vyhľadávanie v kanáloch a skupinách.": "Connect your account to search channels and groups.",
            "Optimalizácia, opravy a upratovanie dát na jednom mieste.": "Optimization, fixes, and data cleanup in one place.",
            "Kontrola a staršie pohľady knižnice.": "Verification and legacy library views.",
            "Vylepšenie náhľadov celej knižnice, batchu alebo výberu.": "Enhancement of previews for the entire library, batch, or selection.",
            "Doplnenie tagov zo zdrojových stránok a analýza náhľadov.": "Tag enrichment from source sites and preview analysis.",
            "Prispôsobenie prostredia a správa knižnice": "Environment customization and library management",
            "Pohľady a kontrola": "Views & Verification",
            "Stav pripojenia": "Connection Status",
            "Správcovské nástroje": "Admin Tools",
            "ON — zapnuté (predvolené)": "ON — Enabled (Default)",
            "OFF — vypnuté": "OFF — Disabled",
            "Opakovanie videa": "Video Loop",
            "Predvolená rýchlosť": "Default Speed",
            "Uprednostniť HLS": "Prefer HLS",
            "Pri opätovnom načítaní videa použije kvalitnejší HLS stream, ak je dostupný.": "Uses higher quality HLS stream when available on reload.",
            "Podsvietenie Ambilight": "Ambilight Backlight",
            "Efekt podsvietenia okolo videa. Predvolene je vypnutý pre plynulejšie prehrávanie.": "Glow effect around video. Disabled by default for smoother playback.",
            "Optimalizácia knižnice": "Library Optimization",
            "Automatická optimalizácia": "Automatic Optimization",
            "Upraví názvy, nájde duplicity a ponechá verzie v najlepšej kvalite.": "Cleans titles, finds duplicates and keeps best quality versions.",
            "Duplicitné videá": "Duplicate Videos",
            "Podľa názvu": "By Title",
            "Podľa obrazu": "By Visual Hash",
            "Čistenie databázy": "Database Cleanup",
            "Odstrániť nefunkčné odkazy": "Remove Broken Links",
            "Vymazať celú databázu": "Wipe Entire Database",
            "Oprava údajov": "Data Repair",
            "Opraviť náhľady": "Fix Thumbnails",
            "Zopakovať kontrolu náhľadov": "Retry Flagged Previews",
            "Doplniť dĺžky": "Sync Durations",
            "Zistiť veľkosti": "Scan File Sizes",
            "Obnoviť údaje importu": "Refresh Import Metadata",
            "Obnoviť odkazy Bunkr": "Refresh Bunkr Links",
            "Opraví chýbajúce dĺžky, rozlíšenie a náhľady. Opakovaná kontrola skúsi označené videá ešte raz a odstráni tie, ktoré stále zlyhávajú.": "Repairs missing durations, resolutions and thumbnails. Retries flagged videos and removes permanently broken ones.",
            "Inteligentné vylepšenie náhľadov": "Smart Preview Enhancement",
            "Skenuje vidéa so slabým náhľadom. Extrahuje 5 framov (15–55% dĺžky videa) a automaticky vyberie ten s najlepším vizuálnym obsahom — preskočí intro, logo a čierne scény.": "Scans videos with weak thumbnails. Extracts 5 frames (15–55% video duration) and automatically selects the best visual content — skipping intros, logos and black screens.",
            "Celá knižnica": "Entire Library",
            "Zastaviť": "Stop",
            "Skontrolovať stav": "Check Status",
            "Podľa Batchu": "By Batch",
            "Vybrané videá": "Selected Videos",
            "Spracúvam...": "Processing...",
            "Dokončené": "Completed",
            "Zastavené": "Cancelled",
            "Prebieha AI analýza...": "AI Analysis in progress...",
            "Otagovať chýbajúce (Knižnica)": "Tag Missing (Library)",
            "Otagovať aktuálny batch": "Tag Current Batch",
            "Otagovať načítaný pohľad": "Tag Loaded View",
            "Otagovať označené": "Tag Selected",
            "Dávka: 50 videí": "Batch: 50 videos",
            "Dávka: 250 videí": "Batch: 250 videos",
            "Dávka: 1000 videí": "Batch: 1000 videos",
            "Doplnenie tagov zo zdrojov": "Tag Enrichment from Sources",
            "Doplniť chýbajúce tagy": "Enrich Missing Tags",
            "Doplniť tagy aktuálneho batchu": "Enrich Current Batch Tags",
            "Načíta tagy zo stránok videí, napríklad Eporner a WhoresHub. Samotné súborové úložiská preskočí.": "Fetches tags from video pages like Eporner and WhoresHub. Skips raw file hosts.",
            "Úprava názvov": "Title Cleanup",
            "Vyčistiť názvy videí": "Clean Video Titles",
            "Nastavenia sa ukladajú v tomto prehliadači.": "Settings are saved in this browser.",

            // Settings Modal
            "Voľba sa automaticky zapamätá v tomto prehliadači.": "Settings are automatically saved in this browser.",
            "Rozhranie": "Interface",
            "Klasické": "Classic",
            "Hustota zobrazenia": "Display Density",
            "Kompaktné": "Compact",
            "Vzdušné": "Comfortable",
            "Farebný motív": "Color Theme",
            "Farebné palety": "Color palettes",
            "Pôvodný vzhľad": "Original",
            "Tvoj aktuálny motív": "Your current theme",
            "Grafit a horúca červená": "Graphite and hot red",
            "Nočná modrá a ľadový azúr": "Midnight blue and ice cyan",
            "Lesná zelená a mäta": "Forest green and mint",
            "Espresso a žiarivá meď": "Espresso and glowing copper",
            "Tmavá slivka a orchidea": "Dark plum and orchid",
            "Kliknutím zmeníš farby. Výber sa zapamätá v tomto prehliadači.": "Click to change colors. Your choice is saved in this browser.",
            "Tmavý": "Dark",
            "Svetlý": "Light",
            "Jazyk rozhrania": "UI Language",
            "Jazyk": "Language",
            "Jazyk pomocných popisov": "UI / Tooltip Language",
            "Jazyk rozhrania a popisov": "UI & Tooltip Language",
            "Farba zvýraznenia": "Accent Color",
            "Fialová": "Purple",
            "Modrá": "Blue",
            "Zelená": "Green",
            "Oranžová": "Orange",
            "Ľahký režim (predvolený)": "Lite Mode (Default)",
            "Úsporné zobrazenie bez animácií a rozmazania.": "Battery-friendly display without animations and blur.",
            "Rovnaký prepínač nájdeš v hornej lište. Zmena sa zapamätá a obnoví stránku.": "The same toggle is in the top bar. Changes are saved and reload the page.",
            "Rýchle prehliadanie": "Fast Browsing",
            "Vypne náročné efekty pri listovaní pre maximálnu plynulosť.": "Disables heavy visual effects while scrolling for maximum smoothness.",
            "Automatické prehrávanie": "Autoplay",
            "Spustiť video ihneď po otvorení": "Start playing video immediately upon opening",
            "Slučka prehrávania": "Playback Loop",
            "Po skončení videa začať odznova": "Loop video automatically when it finishes",
            "Rýchlosť prehrávania": "Playback Speed",
            "Prehrávač HLS": "HLS Player",
            "Použiť adaptívny HLS stream ak je dostupný": "Use adaptive HLS stream when available",
            "Ambilight efekt": "Ambilight Effect",
            "Dynamické farebné podsvietenie okolo videa (vyžaduje vypnutý Ľahký režim)": "Dynamic backlight around video (requires Lite Mode disabled)",
            "Rýchlosť generovania miniatúr": "Thumbnail Generation Speed",
            "Rýchle (Fast)": "Fast",
            "Vyvážené (Medium)": "Medium",
            "Vysoká kvalita (High Quality)": "High Quality",
            "Výber filtrovania (Smart Playlists)": "Smart Playlists",
            "Filtrovať podľa smart zoznamov": "Filter by smart playlists",

            // Database & Maintenance in Settings
            "Správa databázy a optimalizácia": "Database Management & Optimization",
            "Kompletná optimalizácia": "Full Optimization",
            "Prečistí databázu, preindexuje FTS, vymaže neplatné záznamy a skontroluje integritu.": "Cleans database, reindexes FTS, removes invalid records and verifies integrity.",
            "Spustiť optimalizáciu": "Run Optimization",
            "Vyčistiť nefunkčné linky": "Clean Broken Links",
            "Odstráni videá s trvalo nedostupnými zdrojmi.": "Removes videos with permanently dead sources.",
            "Vyčistiť linky": "Clean Links",
            "Vyriešiť duplikáty podľa názvu": "Resolve Duplicates by Name",
            "Zlúči videá s rovnakým normalizovaným názvom a ponechá najlepšiu kvalitu.": "Merges videos with identical normalized titles, keeping the best quality.",
            "Zlúčiť duplikáty": "Merge Duplicates",
            "Vyriešiť vizuálne duplikáty (Hash)": "Resolve Visual Duplicates (Hash)",
            "Nájde a zlúči rovnaké videá na základe vizuálneho odtlačku (phash).": "Finds and merges identical videos based on visual perceptual hash (phash).",
            "Zlúčiť podľa hashu": "Merge by Hash",
            "Normalizovať názvy videí": "Normalize Video Titles",
            "Odstráni balast a predpony/prípony zo všetkých názvov videí.": "Strips clutter, junk prefixes and extensions from all video titles.",
            "Normalizovať": "Normalize",
            "Opraviť chýbajúce miniatúry": "Fix Missing Thumbnails",
            "Znovu zaradí do fronty generovanie miniatúr pre videá, kde zlyhali.": "Re-queues thumbnail generation for videos where it previously failed.",
            "Opraviť miniatúry": "Fix Thumbnails",
            "Znovu skúsiť označené náhľady": "Retry Flagged Previews",
            "Znova spustí náhľady, ktoré boli označené ako problematické.": "Retries previews that were flagged as problematic.",
            "Znovu skúsiť náhľady": "Retry Previews",
            "Synchronizovať dĺžky videí zo zdroja": "Sync Durations from Source",
            "Dohľadá a zosynchronizuje presné trvanie videí priamo zo zdrojov.": "Re-fetches precise video durations from the original stream.",
            "Synchronizovať dĺžky": "Sync Durations",
            "Zistiť veľkosti súborov": "Extract File Sizes",
            "Preverí streamy a doplní chýbajúce veľkosti súborov v databáze.": "Probes stream headers and updates missing video file sizes.",
            "Zistiť veľkosti": "Extract Sizes",
            "Obnoviť metadáta zo zdrojov": "Refresh Metadata from Sources",
            "Obnoví informácie o videách a názvy zo vzdialených serverov.": "Updates titles, tags and duration info from source pages.",
            "Obnoviť metadáta": "Refresh Metadata",
            "Obohatiť chýbajúce tagy": "Enrich Missing Tags",
            "Automaticky doplní tagy a kategórie pre videá, kde zatiaľ chýbajú.": "Uses semantic analysis to generate tags for videos without any.",
            "Spustiť obohatenie": "Start Enrichment",
            "Obnoviť Bunkr videá v aktuálnom batchi": "Refresh Bunkr in Current Batch",
            "Preverí a obnoví odkazy pre všetky Bunkr videá vo vybranom batchi.": "Re-checks and repairs stream links for all Bunkr items in batch.",
            "Obnoviť Bunkr": "Refresh Bunkr",

            // Sidebar & Filters
            "Dávky": "Batches",
            "Dávky (Batches)": "Batches",
            "Všetky importy": "All Imports",
            "Zoradiť podľa": "Sort by",
            "Zoradiť podľa: ": "Sort by: ",
            "Najnovšie": "Newest first",
            "Najnovšie prvé": "Newest first",
            "Najstaršie": "Oldest first",
            "Najstaršie prvé": "Oldest first",
            "Najväčšie": "Largest first",
            "Najväčšie prvé": "Largest first",
            "Najmenšie": "Smallest first",
            "Najmenšie prvé": "Smallest first",
            "Najdlhšie": "Longest first",
            "Najdlhšie prvé": "Longest first",
            "Najkratšie": "Shortest first",
            "Najkratšie prvé": "Shortest first",
            "Podľa názvu A-Z": "Title A-Z",
            "Podľa názvu Z-A": "Title Z-A",
            "Kvalita": "Quality",
            "Zdroj": "Source",
            "Tagy": "Tags",
            "Dĺžka": "Duration",
            "Veľkosť súboru": "File Size",
            "Veľkosť": "File Size",
            "Dátum importu": "Import Date",
            "Dátum": "Date",
            "Bez náhľadu": "No Thumbnail",
            "Hľadať a joinúť": "Search & Join",
            "Hľadať a pripojiť": "Search & Join",
            "Rozbaliť bočný panel": "Expand sidebar",
            "Zbaliť bočný panel": "Collapse sidebar",

            // Batch actions & selection
            "Označiť zobrazené": "Select Displayed",
            "Označiť načítané karty na dávkový Rethumb": "Select loaded cards for batch rethumb",
            "Zobrazí a označí všetky videá z batchu vybratej karty": "Displays and selects all videos from the batch of selected card",
            "Skopíruje priame URL vybraných videí do schránky": "Copies direct URLs of selected videos to clipboard",
            "Skopíruje source stránky vybraných videí do schránky": "Copies source pages of selected videos to clipboard",
            "Obnoviť linky": "Refresh Links",
            "Obnoviť odkazy pre vybrané videá.": "Refresh Links for selected videos.",
            "Označiť filtrované": "Select filtered",
            "Označiť HD/FHD": "Select HD/FHD",
            "Označiť overené": "Select verified",
            "Označiť bez metadát": "Select without metadata",
            "Overiť všetky": "Verify all",

            // Drag overlay & Import
            "Drop .mp4, .mkv, .avi, .mov, .webm, .txt alebo .json súbor": "Drop .mp4, .mkv, .avi, .mov, .webm, .txt or .json file",
            "Importuj video priamo z disku alebo playlist/text/JSON": "Import video directly from disk or playlist/text/JSON",
            "Priebeh importu:": "Import Progress:",
            "Importujem...": "Importing...",
            "Importované": "Imported",
            "Vytvoriť a importovať": "Create & Import",
            "Spustiť import": "Start Import",
            "Pridať do dávky": "Add to Batch",

            // Thumbnails & Rethumb
            "Ručne spustiť rethumb: dávky po 100 až do vyčerpania slabých náhľadov": "Manually run rethumb: batches of 100 until weak thumbnails are exhausted",
            "Stav nedostupný": "Status unavailable",
            "Odhad do konca dávky:": "Estimated time remaining:",
            "Generovanie náhľadov": "Generating Thumbnails",

            // External hubs
            "Všetky načítané playlisty": "All loaded playlists",
            "Všetky dĺžky": "All durations",
            "Všetky karty": "All cards",
            "Do 10 minút": "Up to 10 min",
            "10 až 30 minút": "10 to 30 min",
            "Nad 30 minút": "Over 30 min",
            "Iba overené": "Only verified",
            "Iba neoverené": "Only unverified",

            // Notifications & Toast Messages
            "Pre výber celého batchu najprv označ kartu z batchu.": "To select an entire batch, first select a card from the batch.",
            "V batchi „{0}“ sa nenašli žiadne videá.": "No videos found in batch \"{0}\".",
            "Kopírovanie zlyhalo — skontroluj povolenie schránky.": "Copying failed — please check clipboard permissions.",
            "Skopírovaných {0} priamych URL.": "Copied {0} direct URLs.",
            "Skopírovaných {0} source URL.": "Copied {0} source URLs.",
            "Vyhľadávanie videí zlyhalo": "Video search failed",
            "Video bolo odstránené.": "Video has been removed.",
            "Zmazanie videa zlyhalo.": "Video deletion failed.",
            "Spojenie s Nexusom zlyhalo.": "Connection to Nexus failed.",
            "Žiadne videá na zobrazenie.": "No videos to display.",
            "Žiadne položky na odoslanie.": "No items to send.",
            "Žiadne odkazy nenájdené.": "No links found.",
            "Nič nie je vybrané na import.": "Nothing selected to import.",
            "Požiadavka na import zlyhala": "Import request failed",
            "Import bol úspešne dokončený.": "Import completed successfully.",
            "Žiadne videá s lepšou kvalitou nie sú k dispozícii na nahradenie.": "No videos with better quality are available for replacement.",
            "Úspešne nahradené v Nexuse!": "Successfully replaced in Nexus!",
            "Nahradených {0} videí v Nexuse novou lepšou verziou!": "Replaced {0} videos in Nexus with a new better version!",
            "Nahradenie zlyhalo: {0}": "Replacement failed: {0}",
            "TURBO — efekty a poll-ovanie vypnuté": "TURBO — effects and polling disabled",
            "Turbo vypnuté — obnovujem…": "Turbo disabled — reloading…",

                        "D\u013a\u017eka": "Duration",
            "D\u013a\u017eka videa": "Video Duration",
            "Ve\u013ekos\u0165": "File Size",
            "Ve\u013ekos\u0165 videa": "Video Size",
            "D\u00e1tum": "Date",
            "D\u00e1tum od": "Date From",
            "D\u00e1tum do": "Date To",
            "Bez n\u00e1h\u013eadu": "No Thumbnail",
            "Ak\u00e1ko\u013evek": "Any",
            "Cel\u00fd batch": "Entire Batch",
            "Celkov\u00e1 d\u00f4vera": "Overall Confidence",
            "Doplni\u0165 tagy": "Add Tags",
            "2 st\u013apce": "2 columns",
            "3 st\u013apce": "3 columns",
            "4 st\u013apce": "4 columns",
            "5 st\u013apcov": "5 columns",
            "6 st\u013apcov": "6 columns",
            "7 st\u013apcov": "7 columns",
            "24 hod\u00edn": "24 hours",
            "7 dn\u00ed": "7 days",
            "30 dn\u00ed": "30 days",
            "Spolo\u010dn\u00fd poh\u013ead": "Combined View",
            "Zru\u0161i\u0165 spolo\u010dn\u00fd poh\u013ead": "Clear Combined View",
            "AI tagy batchu": "Batch AI Tags",
            "AI tagy batchov": "Batches AI Tags",
            "Ozna\u010di\u0165 zobrazen\u00e9": "Select Displayed",
            "Ozna\u010di\u0165 na\u010d\u00edtan\u00e9 karty na d\u00e1vkov\u00fd Rethumb": "Select loaded cards for batch rethumb",
            "Zru\u0161i\u0165 v\u00fdber": "Clear Selection",
            "Vymaza\u0165 vybran\u00e9": "Delete Selected",
            "Zobrazi\u0165": "Show",
            "Skry\u0165": "Hide",
            "Prehra\u0165": "Play",
            "Prehra\u0165 \u010fal\u0161ie": "Play Next",
            "Zastavi\u0165": "Stop",
            "Zavrie\u0165": "Close",
            "Zru\u0161i\u0165": "Cancel",
            "Ulo\u017ei\u0165": "Save",
            "Hotovo": "Done",
            "Importova\u0165": "Import",
            "Exportova\u0165": "Export",
            "Kop\u00edrova\u0165": "Copy",
            "Kop\u00edrova\u0165 URL": "Copy URLs",
            "Kop\u00edrova\u0165 priame URL": "Copy Direct URLs",
            "Kop\u00edrova\u0165 source URL": "Copy Source URLs",
            "Overi\u0165": "Verify",
            "Overi\u0165 v\u0161etky": "Verify All",
            "Spusti\u0165": "Start",
            "Spusti\u0165 import": "Start Import",
            "H\u013eada\u0165 a join\u00fa\u0165": "Search & Join",
            "H\u013eada\u0165": "Search",
            "Zmaza\u0165": "Delete",
            "Odstr\u00e1ni\u0165": "Remove",
            "Obnovi\u0165": "Refresh",
            "Obnovi\u0165 linky": "Refresh Links",
            "Akt\u00edvne tagy:": "Active Tags:",
            "Drop .mp4, .mkv, .avi, .mov, .webm, .txt alebo .json s\u00fabor": "Drop .mp4, .mkv, .avi, .mov, .webm, .txt or .json file",
            "Importuj video priamo z disku alebo playlist/text/JSON": "Import video directly from disk or playlist/text/JSON",
            "Priebeh importu:": "Import Progress:",
            "Importujem...": "Importing...",
            "Importovan\u00e9": "Imported",
            "Stav nedostupn\u00fd": "Status Unavailable",
            "Odhad do konca d\u00e1vky:": "Estimated time remaining:",
            "Generovanie n\u00e1h\u013eadov": "Generating Thumbnails",
            "V\u0161etky na\u010d\u00edtan\u00e9 playlisty": "All Loaded Playlists",
            "V\u0161etky d\u013a\u017eky": "All Durations",
            "V\u0161etky karty": "All Cards",
            "Do 10 min\u00fat": "Up to 10 min",
            "10 a\u017e 30 min\u00fat": "10 to 30 min",
            "Nad 30 min\u00fat": "Over 30 min",
            "Iba overen\u00e9": "Only Verified",
            "Iba neoveren\u00e9": "Only Unverified",
            "Ozna\u010di\u0165 filtrovan\u00e9": "Select Filtered",
            "Ozna\u010di\u0165 HD/FHD": "Select HD/FHD",
            "Ozna\u010di\u0165 overen\u00e9": "Select Verified",
            "Ozna\u010di\u0165 bez metad\u00e1t": "Select Without Metadata",
            "Pre v\u00fdber cel\u00e9ho batchu najprv ozna\u010d kartu z batchu.": "To select an entire batch, first select a card from the batch.",
            "Kop\u00edrovanie zlyhalo \u2014 skontroluj povolenie schr\u00e1nky.": "Copying failed \u2014 please check clipboard permissions.",
            "Video search failed": "Video search failed",
            "Video bolo odstr\u00e1nen\u00e9.": "Video has been removed.",
            "Zmazanie videa zlyhalo.": "Video deletion failed.",
            "Spojenie s Nexusom zlyhalo.": "Connection to Nexus failed.",
            "\u017diadne vide\u00e1 na zobrazenie.": "No videos to display.",
            "\u017diadne polo\u017eky na odoslanie.": "No items to send.",
            "\u017diadne odkazy nen\u00e1jden\u00e9.": "No links found.",
            "Ni\u010d nie je vybran\u00e9 na import.": "Nothing selected to import.",
            "Import request failed": "Import request failed",
            "Import bol \u00faspe\u0161ne dokon\u010den\u00fd.": "Import completed successfully.",
            "Zobrazi\u0165 viac": "Show More",
            "Zobrazi\u0165 menej": "Show Less",
            "Na\u010d\u00edta\u0165 \u010fal\u0161ie": "Load More",
            "Rozbali\u0165": "Expand",
            "Zbali\u0165": "Collapse",
            "Stiahnu\u0165": "Download",
            "Stiahnut\u00e9": "Downloaded",
            "S\u0165ahujem...": "Downloading...",
            "Stiahnu\u0165 video": "Download Video",
            "Nastavenia s\u0165ahovania": "Download Settings",
            "Spr\u00e1vca s\u0165ahovania": "Download Manager",
            "Prip\u00e1janie k aria2\u2026": "Connecting to aria2\u2026",
            "Prida\u0165 priame URL": "Add direct URLs",
            "Jedna URL na riadok": "One URL per line",
            "Prida\u0165 s\u0165ahovanie": "Add downloads",
            "Pozastavi\u0165 akt\u00edvne": "Pause active",
            "Obnovi\u0165 pozastaven\u00e9": "Resume paused",
            "Zru\u0161i\u0165 akt\u00edvne": "Cancel active",
            "Otvori\u0165 prie\u010dinok": "Open folder",
            "Automaticky vymaza\u0165 dokon\u010den\u00e9": "Automatically clear completed entries",
            "Ulo\u017ei\u0165 nastavenia": "Save settings",

            // Splitscreen & Userscripts
            "Rozdelenie obrazovky (Splitscreen)": "Splitscreen",
            "Univerzálny Split-Screen": "Universal Splitscreen",
            "Vyberte položky pre split-screen": "Select items for splitscreen",
            "Žiadne aktívne videá na import.": "No active videos to import.",
            "Nenašli sa žiadne videá zodpovedajúce filtru.": "No videos match the current filter.",
            "Na tejto stránke sa nenašli žiadne videá ani video karty.": "No videos or cards found on this page.",
            "Nepodarilo sa nahrať žiadne video dáta.": "Failed to load video data.",
            "Odoslať do Nexusu": "Send to Nexus",
            "Úspešne odoslané do Nexusu!": "Sent to Nexus successfully!",
            "Skryť fotoalbumy": "Hide photo albums",
            "Iba fotky": "Only photos",
            "Album obsahuje iba obrázky, žiadne videá": "Album contains only pictures, no videos",
            "Úspešne načítaných {0} nových albumov": "Successfully loaded {0} new albums",
            "Žiadne albumy na skenovanie": "No albums to scan",
            "V albume sa nenašli žiadne položky": "No items found in album"
        }
    };

    class NexusI18n {
        constructor() {
            this.currentLang = this.detectLanguage();
            this.translations = TRANSLATIONS;
            this.observer = null;
            this.isTranslating = false;
        }

        detectLanguage() {
            try {
                // 1. Explicit language key in localStorage
                const direct = localStorage.getItem(STORAGE_KEY);
                if (direct === 'sk' || direct === 'en') return direct;

                // 2. Setting inside vipSettings JSON
                const vipStr = localStorage.getItem(VIP_SETTINGS_KEY);
                if (vipStr) {
                    const vip = JSON.parse(vipStr);
                    const lang = vip.language || vip.tooltipLanguage;
                    if (lang === 'sk' || lang === 'en') return lang;
                }

                // 3. Fallback to html lang attribute or browser language
                const htmlLang = document.documentElement.lang;
                if (htmlLang && htmlLang.startsWith('sk')) return 'sk';
                if (navigator.language && navigator.language.startsWith('sk')) return 'sk';
            } catch (e) {
                console.warn('[NexusI18n] Language detection fallback:', e);
            }
            return 'sk'; // Default to sk matching the unified Slovak dashboard UI
        }

        getLanguage() {
            return this.currentLang;
        }

        setLanguage(lang) {
            if (lang !== 'sk' && lang !== 'en') return;
            const previousLang = this.currentLang;
            this.currentLang = lang;

            try {
                localStorage.setItem(STORAGE_KEY, lang);
                // Also synchronize with vipSettings
                const vipStr = localStorage.getItem(VIP_SETTINGS_KEY);
                let vip = {};
                if (vipStr) {
                    try { vip = JSON.parse(vipStr); } catch (_) {}
                }
                vip.language = lang;
                vip.tooltipLanguage = lang;
                localStorage.setItem(VIP_SETTINGS_KEY, JSON.stringify(vip));
            } catch (e) {
                console.error('[NexusI18n] Failed to persist language:', e);
            }

            document.documentElement.lang = lang;
            document.body.dataset.lang = lang;
            document.body.dataset.tooltipLang = lang;

            this.translatePage();

            // Dispatch global event
            window.dispatchEvent(new CustomEvent('nexus:language-changed', {
                detail: { lang, previousLang }
            }));
        }

        t(text, params) {
            if (!text || typeof text !== 'string') return text;
            const trimmed = text.trim();
            const lang = this.currentLang;

            let result = text;
            const dict = this.translations[lang] || {};

            if (dict[trimmed]) {
                // Preserve leading/trailing spaces
                const leading = text.match(/^\s*/)[0];
                const trailing = text.match(/\s*$/)[0];
                result = leading + dict[trimmed] + trailing;
            } else if (lang === 'sk' && this.translations.en) {
                // Check if text is English and we want Slovak: reverse lookup against EN map (SK -> EN)
                for (const [skKey, enVal] of Object.entries(this.translations.en)) {
                    if (enVal === trimmed) {
                        const leading = text.match(/^\s*/)[0];
                        const trailing = text.match(/\s*$/)[0];
                        result = leading + skKey + trailing;
                        break;
                    }
                }
            } else if (lang === 'en' && this.translations.sk) {
                // Check if text is Slovak and we want English: reverse lookup against SK map (EN -> SK)
                for (const [enKey, skVal] of Object.entries(this.translations.sk)) {
                    if (skVal === trimmed) {
                        const leading = text.match(/^\s*/)[0];
                        const trailing = text.match(/\s*$/)[0];
                        result = leading + enKey + trailing;
                        break;
                    }
                }
            }

            // Replace {0}, {1}, etc. params
            if (params !== undefined) {
                if (Array.isArray(params)) {
                    params.forEach((p, idx) => {
                        result = result.replace(new RegExp(`\\{${idx}\\}`, 'g'), p);
                    });
                } else {
                    result = result.replace(/\{0\}/g, params);
                }
            }

            return result;
        }

        translateElement(el) {
            if (!el || el.nodeType !== 1) return;
            if (el.dataset.noI18n === 'true') return;

            // 1. Explicit data-i18n attribute
            if (el.dataset.i18n) {
                el.textContent = this.t(el.dataset.i18n);
            }

            // 2. Explicit data-i18n-title
            if (el.dataset.i18nTitle) {
                el.setAttribute('title', this.t(el.dataset.i18nTitle));
            } else if (el.hasAttribute('title')) {
                const currentTitle = el.getAttribute('title');
                if (currentTitle) {
                    const trans = this.t(currentTitle);
                    if (trans !== currentTitle) el.setAttribute('title', trans);
                }
            }

            // 3. Explicit data-i18n-placeholder
            if (el.dataset.i18nPlaceholder) {
                el.setAttribute('placeholder', this.t(el.dataset.i18nPlaceholder));
            } else if (el.hasAttribute('placeholder')) {
                const currentPh = el.getAttribute('placeholder');
                if (currentPh) {
                    const trans = this.t(currentPh);
                    if (trans !== currentPh) el.setAttribute('placeholder', trans);
                }
            }

            // 4. Translate direct text children if matched in dictionary
            for (let i = 0; i < el.childNodes.length; i++) {
                const child = el.childNodes[i];
                if (child.nodeType === 3) { // Text node
                    const text = child.nodeValue;
                    if (text && text.trim().length > 1) {
                        const trimmed = text.trim();
                        // Ignore pure numbers or symbols
                        if (!/^[0-9\s.,:%/+-]+$/.test(trimmed)) {
                            const translated = this.t(text);
                            if (translated !== text) {
                                child.nodeValue = translated;
                            }
                        }
                    }
                }
            }
        }

        translatePage(root = document.body) {
            if (!root) return;
            if (this.isTranslating) return;
            this.isTranslating = true;

            try {
                // 1. Vždy prelož explicitné data-i18n uzly
                const explicit = root.querySelectorAll('[data-i18n], [data-i18n-title], [data-i18n-placeholder]');
                explicit.forEach(el => this.translateElement(el));

                // 2. Plošný preklad iba mimo ťažkých zoznamov kariet galérie
                const elements = root.querySelectorAll('button, label, select option, h1, h2, h3, h4, h5, p, span, a, input[type="submit"]');
                elements.forEach(el => {
                    if (el.closest('script, style, code, pre, .v-duration, .v-size, .player-time, .virtual-gallery-canvas, .flow-container, #resultsContainer')) return;
                    this.translateElement(el);
                });
            } finally {
                this.isTranslating = false;
            }
        }

        translateExplicit(root = document.body) {
            if (!root || this.isTranslating) return;
            this.isTranslating = true;
            try {
                if (root.matches?.('[data-i18n], [data-i18n-title], [data-i18n-placeholder]')) {
                    this.translateElement(root);
                }
                const explicit = root.querySelectorAll?.('[data-i18n], [data-i18n-title], [data-i18n-placeholder]');
                if (explicit) explicit.forEach(el => this.translateElement(el));
            } finally {
                this.isTranslating = false;
            }
        }

        initObserver() {
            // Celoplošný MutationObserver nad document.body zámerne odstránený:
            // pri scrolle stoviek kariet v galérii zbytočne zaťažoval hlavné vlákno.
            // Preklad beží jednorazovo pri DOMContentLoaded a pri prepnutí jazyka (setLanguage).
            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }
        }

        init() {
            document.documentElement.lang = this.currentLang;
            if (document.body) {
                document.body.dataset.lang = this.currentLang;
                document.body.dataset.tooltipLang = this.currentLang;
            }

            // Prelož stránku jednorazovo po načítaní DOM (bez priebežného DOM observera)
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => {
                    this.translatePage();
                }, { once: true });
            } else {
                this.translatePage();
            }
        }
    }

    const instance = new NexusI18n();
    instance.init();

    // Export globally for window and module systems
    global.nexusI18n = instance;
    global.__nexus_t = (text, params) => instance.t(text, params);

})(typeof window !== 'undefined' ? window : globalThis);
