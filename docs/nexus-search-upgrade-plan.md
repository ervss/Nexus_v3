# Plán rozvoja vyhľadávania a Discovery Hubu (Nexus Search & Discovery 2.0)

**Cieľ.** Používateľ okamžite nájde video naprieč všetkými plochami, bez preblikávania porovná dostupné verzie (celý záznam vs. zostrih vs. vyššia kvalita), odloží si vybrané položky z ľubovoľného zdroja do spoločného zásobníka/kolekcie a pri ďalšej návšteve vidí čisté prírastky od sledovaných tvorcov, kanálov, albumov a dotazov.

---

## Východiskový stav a zistenia z proti-analýzy kódu

| Plocha | Existujúci základ | Kritická medzera v kóde (Proti-analýza) | Cieľový stav 2.0 |
|---|---|---|---|
| **Related Search & CBIR** | Hybridný SSE stream (SigLIP2 GPU + FTS5 + Fast Web + CBIR), 3 zámery radenia (`similar`, `same_video`, `same_creator`), porovnávacie okno | V `app/related_unified.py` je `intent` súčasťou `cache_key` a pomocné skóre (`_perf_hits`, `_dur_close`, `_rrf`) sa pred odoslaním vymažú. Zmena zámeru zmaže výsledky a spúšťa celý drahý dotaz odznova. | Vyňať `intent` z `cache_key`, posielať `signals` rozpis skóre na frontend a preradiť karty za **0 ms na klientovi**. Doplniť iba chýbajúcu vetvu (`creator_pivot`). Rozlíšiť plný záznam, inú kvalitu a zostrih. |
| **Quantum Search** | Paralelné vyhľadávanie po zdrojoch, diagnostika, Rýchle hľadanie, overenie orientácie a metadát | Po každom zdroji aj po každej dávke obohatenia (`_prefetchTesterMetadata`, `_probeUnknownOrientation`) volá `renderResultsList()` deštruktívne `container.innerHTML = ''`. Obohacovanie beží plošne namiesto viditeľných kariet. | **Keyed DOM Reconciliation** (zachovanie kariet, fokusu, scrollu, výberu a otvoreného náhľadu). **Viewport-First Enrich/Probe** fronta pre viditeľné a označené karty. |
| **Telegram FTS5 & Live** | Lokálny FTS5 katalóg, refresh/backfill, živé novinky (`telegram_live_new.py`), kurzor v režime Nové | `search_telegram_fts` pri `deduplicate=True` ťahá do Pythonu až 6 000 riadkov, pri `sort != 'relevance'` spúšťa plný `LIKE` sken, `new_only` posiela tisíce ID cez `json_each` a `telegram_live_new.py` neukladá nájdené správy do indexu. | Predspracovaný `search_tokens` stĺpec vo FTS5 (eliminácia 95 % `LIKE` dotazov), rýchla evidencia `in_library`, zložené kurzory `(sort_val, date, id)` a write-through indexácia v `telegram_live_new.py`. |
| **Discovery Hub & Album Viewer** | Pripnutie, história, importné joby, uloženie výberu (`kind: collection`), virtualizácia kombinovaných albumov | Hlavná mriežka Discovery Hubu aj samostatné veľké albumy v Album Vieweri vykresľujú všetky DOM karty naraz. Kolekcie sú len v `combined-history` pre Album Viewer. Chýba spoločný feed prírastkov a Delta pohľad v albume. | Univerzálna virtualizácia pre hlavnú mriežku Hubu aj všetky albumy + obnova scrollu pri návrate. Spoločný zásobník/kolekcie pre všetky 4+ plochy. Delta filter (`+N nových`) a Watchlist feed. |

---

## 1. Stabilné a rýchle výsledky (DOM Reconciliation, 0 ms Re-rank & Virtual Grid)

**Používateľský výsledok.** Pozerám kartu, prehrávam preview alebo mám označené videá. Príchod pomalšieho zdroja ani dobehnutie metadát nezruší môj výber, otvorený náhľad ani polohu v zozname. Prepnutie zámeru v Related Search okamžite preradí karty bez prázdnej obrazovky.

- **Quantum Search (`app/static/search.js`).**
  - Zaviesť stabilný deterministický kľúč výsledku (`_resultKey(result)` podľa normalizovanej URL alebo `tg:chat_id:message_id`).
  - Nahradiť `container.innerHTML = ''` v `renderResultsList()` inkrementálnou aktualizáciou DOM uzlov (`_reconcileResultCards`): existujúce `.search-result-card` elementy sa recyklujú a aktualizujú na mieste, čím sa zachová fokus, scroll, stav `<video>`/sprite preview a zaškrtnutie checkboxov.
  - Ak používateľ aktívne interaguje s mriežkou (hover na karte / otvorený detail), zmraziť vkladanie nových kariet nad aktuálny scroll/fokus alebo aktualizovať poradie bez skoku obrazovky.
  - Obohacovanie (`_autoEnrichResults`, `_prefetchTesterMetadata`, `_probeUnknownOrientation`) zoradiť podľa priority: **1. vybrané (označené) karty, 2. karty viditeľné vo viewporte, 3. zvyšok**. Aktualizácia metadát upravuje priamo atribúty/odznaky karty bez celkového prebudovania mriežky.
- **Related Search (`app/related_unified.py`, `app/static/main.js`).**
  - Odstrániť `intent` z `cache_key` v `stream_unified_related`.
  - V `rrf_fuse_and_explain` ponechať na každej položke štruktúrovaný objekt `signals` (`exact_frame`, `visual_score`, `performer_hits`, `tag_hits_count`, `word_hits`, `dur_close`, `duration_ratio`, `rrf_base`, `engines_count`).
  - Pri zmene `galleryRelatedIntent` (`similar`, `same_video`, `same_creator`, `upgrade`) v UI okamžite preradiť už načítané `galleryRelatedUnifiedResults` na klientovi (0 ms) a voliteľne dotiahnuť iba chýbajúcu vyhľadávaciu vetvu bez vymazania existujúcich kariet.
  - Garantovať, že staršie alebo zrušené SSE požiadavky (`_unifiedRelatedSeq`) nikdy neprepíšu novšiu reláciu.
- **Discovery Hub & Album Viewer (`app/static/main.js`).**
  - Rozšíriť virtualizáciu z kombinovaných albumov na **všetky veľké albumy** v Album Vieweri a zaviesť virtualizované vykresľovanie (`discoveryHubVirtualWindow`) pre hlavnú mriežku Discovery Hubu.
  - Pri otvorení albumu z Discovery Hubu uložiť `scrollTop` a kľúč otvorenej karty; po zatvorení Album Viewera presne obnoviť pozíciu scrollu.
- **Náhľady (`PreviewOrchestrator`).**
  - Zjednotiť ovládanie storyboardu a video náhľadu myšou, dotykom a klávesnicou.
  - Garantovať, že pohyblivý náhľad beží vždy najviac na **jednej karte** v celom Nexuse a oneskorené odpovede zo starých kariet sa cez `AbortController` / sekvenčné ID ignorujú.

---

## 2. Spoločné odkladanie (Stash Kolekcie) a zdieľanie naprieč plochami

**Používateľský výsledok.** Odložím výsledok z Quantum Search, Related Search, Telegramu, Discovery Hubu aj Album Viewera do kolekcie **Na večer** (alebo ľubovoľnej vlastnej kolekcie). Z kolekcie sa viem vrátiť na zdroj, prehrať odložené položky, spustiť hromadný import alebo skopírovať a zdieľať čistý zoznam odkazov.

- **Univerzálne úložisko kolekcií (`/api/v1/discovery-hub/combined-history` & `/api/v1/stash`).**
  - Rozšíriť ukladanie a aktualizáciu kolekcií (`kind: 'collection'`) o idempotentný endpoint `/api/v1/stash/items` (pridanie/odobratie položiek do/z kolekcie podľa názvu alebo ID kolekcie), pričom ostáva 100 % zachované čítanie existujúcich kolekcií v `combined-history`.
  - Pre každú položku uchovať stabilnú identitu výskytu (`canonical_key`), pôvodnú plochu (`origin_surface`: `quantum`, `related`, `telegram`, `discovery_hub`, `album_viewer`), zdrojový odkaz (`url` / `source_url`), stream odkaz, pre Telegram identitu správy (`chat_id`, `message_id`, `file_id`) a dostupné metadáta (`title`, `thumbnail`, `duration`, `quality`, `height`, `size_bytes`, `performers`).
  - Opakované uloženie toho istého výskytu do rovnakej kolekcie je **idempotentné** (aktualizuje len chýbajúce metadáta, nevytvorí duplikát).
- **Spoločný zásobník (Stash Tray) a akcie na kartách.**
  - Pridať tlačidlo **Odložiť** (do aktívnej kolekcie, predvolene *Na večer*) na karty v Quantum Search, Related Search, Telegrame, Discovery Hube a Album Vieweri.
  - Vizuálny indikátor uloženia priamo na karte + rýchly prístup k Zásobníku s akciami **Prehrať**, **Odložiť**, **Importovať do knižnice** a **Zdieľať**.
  - Pri zdieľaní generovať stabilné zdrojové odkazy a pri súkromných Telegram odkazoch (`t.me/c/...` alebo `/api/v1/telegram/stream/...`) jasne zobraziť upozornenie, že príjemca potrebuje prístup k danému kanálu/skupine.

---

## 3. Overovanie verzií a presnejší Telegram katalóg (FTS5 v2)

**Používateľský výsledok.** Pod jednou kartou vidím potvrdené verzie (napr. 720p vs. 1080p) s možnosťou rozbalenia alebo zrušenia zoskupenia. Pri neistej zhode vidím v porovnávacom okne storyboardy, parametre a dôvod zhody (*Celý záznam*, *Vyššia kvalita*, *Pravdepodobný zostrih*). V Telegrame listujem hlboko do histórie bez duplikátov, preskočených kariet a zbytočných `LIKE` zdržaní.

- **Overovanie verzií a detekcia duplikátov (`app/duplicate_detector.py`, `app/related_unified.py`).**
  - Zachovať samostatnú identitu každého zdrojového výskytu.
  - Klasifikovať vzťah kandidáta voči referenčnému videu na základe kombinácie **identifikátora zdroja / Telegram `file_id`**, **vizuálnej zhody (pHash / SigLIP2)**, **trvania (`duration`)** a **názvu/performera**:
    - `confirmed_version` (*Potvrdená verzia / Iná kvalita*): rovnaký identifikátor súboru ALEBO vysoká vizuálna + názvová zhoda pri rovnakom trvaní ($\pm 5\,\%$ alebo $\le 5\,\text{s}$).
    - `probable_cut` (*Pravdepodobný zostrih / Klip vs. Plný záznam*): vysoká vizuálna zhoda, ale výrazne odlišné trvanie ($< 65\,\%$ = skrátený klip/ukážka, $> 135\,\%$ = dlhší/plný záznam). **Samotný podobný cover s odlišným trvaním nikdy nespôsobí automatické potvrdené zlúčenie!**
    - `same_series` (*Rovnaká séria / Tvorca*): zhoda tvorcu a prostredia bez zhody konkrétnej scény.
  - V Related Search umožniť rozbaliť zoskupené verzie pod hlavnou kartou, prípadne prepínačom **Zoskupiť verzie** zoskupenie kedykoľvek vypnúť a vidieť všetky jednotlivé odkazy.
  - Rozšíriť porovnávací modal (`openUnifiedCompare`) o porovnanie storyboardov/snímok, rozpis dôvodov zhody, porovnanie dĺžky/rozlíšenia/veľkosti a tlačidlo na priame nahradenie/import lepšej verzie.
- **Telegram FTS5 v2 a bezstratové kurzory (`app/telegram_index.py`, `app/telegram_live_new.py`).**
  - Pri zápise do `telegram_media_index` automaticky dopĺňať normalizované vyhľadávacie tokeny (odstránenie `#` z hashtagov, rozdelenie `snake_case` a `CamelCase` v názvoch súborov a titulkoch), aby ich priamo pokryl index `telegram_media_fts`.
  - Obmedziť doplnkový `LIKE` dotaz výhradne na prípady, keď FTS5 nevráti dostatok výsledkov alebo dotaz obsahuje špecifický podreťazec, ktorý tokenizér nerozdelí.
  - Rozšíriť kurzorové stránkovanie (`before_date`, `before_id`, `before_sort_value`) na chronologické aj filtrované listovanie tak, aby vloženie novšej správy počas listovania nespôsobilo opakovanie starších kariet.
  - V `telegram_live_new.py` ukladať objavené metadáta správ na pozadí do `telegram_media_index` (write-through), aby živé skenovanie obohacovalo aj lokálny FTS5 katalóg.

---

## 4. Sledovanie (Watchlist), prírastky (Delta) a hľadanie lepšej verzie

**Používateľský výsledok.** Discovery Hub ukáže prehľad toho, čo pribudlo od mojej poslednej návštevy u sledovaných tvorcov, kanálov, albumov a dotazov. Pri otvorení albumu vidím priamo filter prírastku (napr. `+8 nových videí`). Pri 720p klipe si zapnem sledovanie **Upozorni ma na celý záznam v 1080p+** a po nájdení kandidáta ho porovnám pred výmenou.

- **Sledovanie a Feed prírastkov (`app/Watchlist` / `Discovery Hub`).**
  - Umožniť sledovať tvorcu, zdroj, Telegram kanál/tému, externý album alebo uložený dotaz s filtrami.
  - Pre každý sledovaný zdroj evidovať `last_visited_at` a `last_seen_items` (snapshot/high-water mark). Jasne oddeliť filter **Od poslednej návštevy** od **Ešte nemám v knižnici**.
  - V Album Vieweri pri opätovnom otvorení albumu automaticky vyhodnotiť prírastok oproti poslednému uloženiu v histórii/sledovaní a ponúknuť filter **Nové prírastky (`+N`)**.
- **Hľadanie lepšej verzie (`app/nexus_intel.py`).**
  - Rozšíriť `find_better_quality` o parametre `source_duration`, `target_min_height` (napr. `1080`), `require_full_length` (napr. pre nájdenie plného záznamu ku krátkemu klipu) a vysvetlenie zhody (`match_reason`, `version_relation`: `upgrade_quality` / `full_recording` / `uncertain_match`).
  - Nikdy neoznačiť kratší trailer ako „lepšiu verziu“ dlhého videa len preto, že má vyššie rozlíšenie.
  - Uloženú verziu v knižnici vymeniť až po potvrdení používateľom v porovnávacom okne.
- **Jednotný vyhľadávací jazyk (Query DSL).**
  - Podporiť rýchle inline operátory vo vyhľadávaní (`@tvorca`, `#tag`, `q:1080p`, `q:4k`, `dur:>15m`, `size:>500mb`, `is:vertical`, `-slovo`) s automatickým prekladom na filtre v Quantum Search, Telegrame aj Discovery Hube.
