# Audit siete a prehrávania Nexus — 6. 11. 2026

## Výsledok a hranice overenia

Opravené sú chyby pri obnove prehrávania, neobmedzené bufferovanie cache endpointu,
časť únikov HTTP klientov a duplicita WebSocket spojení v jednom dashboarde.
Záložná proxy cesta bola overená v skutočnom prihlásenom Chrome dashboarde po
kontrolovane vloženej odpovedi HTTP 503. Nejde o dôkaz, že proxy dokáže nahradiť
nefunkčný pôvodný CDN server. Na taký výpadok treba nezávislé zrkadlo alebo
úplnú lokálnu kópiu rovnakého súboru.

Audit sa týka pracovnej verzie projektu, ktorá obsahovala rozsiahle skoršie
rozpracované zmeny. Tie sa nevracali ani necommitovali. Nie je to záťažový test
všetkých poskytovateľov ani dlhodobé meranie celej linky.

## Aktuálne merania

| Kontrola | Pozorovanie | Význam |
|---|---|---|
| `/_nexus/live`, 3 požiadavky | 31,8 / 2,4 / 2,0 ms, HTTP 200 | Server počas vzorky reagoval |
| `/api/v1/videos?limit=24`, 3 požiadavky | 31,7 / 25,6 / 25,8 ms, HTTP 200 | Zoznam videí nie je v tejto vzorke hlavná brzda |
| `/` bez session | HTTP 303 na prihlásenie | Čas redirectu nie je čas vykreslenia dashboardu |
| `/api/health` | HTTP 404 | Beží classic režim; LITE health adresa nie je vhodná kontrola |
| 3 uložené Bunkr CDN URL (#3941, #3940, #3939) | Range 0–1023: HTTP 206, 628 / 511 / 487 ms po hlavičky; prijatých prvých 1024 bajtov | Tieto URL boli v čase skúšky dostupné; nie je to meranie Mbps |
| Log `server-20261106-095605-pid27924.log`, prvá vzorka 3037 riadkov | 8 výskytov 503, 10 výskytov 429, 1 timeout, 496 prijatých WebSocket spojení | Počet výskytov textu nie je počet unikátnych incidentov |
| Následné dohľadanie 503 | Bunkr video #3925, dva neúspešné `/stream_proxy/3925.mp4` prenosy | Vzdialený zdroj vracal 503; nejde iba o chybu lokálneho UI |
| Evidované zdroje | 103 riadkov `video_sources` pre 48 rôznych videí | Neznamená to 48 aktuálne overených funkčných záloh |

Detaily bez podpísaných URL a cookies: `artifacts/network-audit-20261106/baseline.json`
a `cdn-probes.json`. Počty v logu sa menia počas behu systému.

## Pripojenie a nastavenia

- WinHTTP hlási priame pripojenie bez proxy; procesové HTTP_PROXY, HTTPS_PROXY,
  ALL_PROXY a NO_PROXY neboli nastavené.
- Cloudflare WARP je pripojený a CLI hlási zdravú sieť. DNS na sieťových
  rozhraniach smeruje na lokálne WARP adresy 127.0.2.2 a 127.0.2.3.
  Priame HTTP spojenie preto stále môže ísť cez tunel WARP.
- `.env`: NTC_PROXY_LIST a WEBSHARE_PROXY_LIST sú prázdne; TOR_ENABLED a
  TOR_AUTO_START sú false. MAX_WORKERS=16, EPORNER_MAX_CONCURRENCY=3,
  CAMWHORES_FAST_METADATA_CONCURRENCY=10, DB_POOL_TIMEOUT=60.
- Import má v konfigurácii vlastný strop najviac 4 workerov. Bunkr má existujúci
  rodinný plánovač s prioritami, limitmi hostov a cooldownom po 429/503.
  Zvyšovať všetky paralelizmy by mohlo zvýšiť 429 a zhoršiť prehrávanie.
- WARP, systémové DNS a proxy nastavenia sa nemenili. Bez kontrolovaného A/B
  merania nemožno prisúdiť WARP zrýchlenie ani spomalenie.

## Implementované zmeny

1. **Jedna obnova na prehrávač.** Natívna media chyba má jedného vlastníka.
   Odstránené sú pretekajúce generické handlery; špecifické xHamster/Eporner/
   CyberFile handlery ostávajú ako kompatibilná cesta pre stránku bez journalu.
   Súbežné chyby zdieľajú rovnaký rozpracovaný pokus obnovy.
2. **Bunkr záložný prenos.** Pri media chybe hlavný prehrávač raz pre danú
   priamu MP4 URL okamžite priradí lokálnu referer-aware proxy. Jej upstream
   connect/read limit je 6 s. Ide o limity nečinnosti jednotlivých operácií,
   nie o celkový šesťsekundový limit videa.
3. **Ďalšie možnosti.** Nasledujú evidované nevyskúšané zrkadlá rovnakého videa,
   potom obnova URL z pôvodného zdroja. Rovnaká URL/zdrojová stránka sa
   nepovažuje za nezávislé zrkadlo. Počet obnov pôvodného zdroja ostáva najviac 2.
   Pri prepnutí sa uchováva pozícia; zastaraná odpoveď nesmie znovu otvoriť
   zatvorený alebo prepnutý slot.
4. **Časové rozpočty.** Zoznam zrkadiel má 4 s, Bunkr JIT fetch 15 s a generická
   obnova 45 s. Bunkr watchdog reaguje pri približne 12 s bez pokroku a 15 s
   bez prvého obrazu; kontroluje sa každých 5 s. Nie je to tvrdé SLA.
   Pomalé lokálne/Telegram streamy si ponechávajú trpezlivejší režim.
5. **Album Viewer.** MP4 proxy používa 8 s upstream timeout; pred opakovaným
   získavaním podpisu skúsi jeden priamy browser prenos. Meta fetch je ohraničený
   45 s. Táto konkrétna albumová cesta bola kontrolovaná v kóde, nie samostatne
   odklikaná v tomto audite.
6. **Skutočný stream namiesto celého downloadu do RAM.** Cache endpoint posiela
   plné, otvorené, suffix a väčšie než 4 MiB Range požiadavky cez stream proxy.
   Malé uzavreté intervaly kontrolujú 206, Content-Range a skutočný počet bajtov.
   Legitímne skrátenie intervalu na konci súboru je podporované. 503, neúplná
   odpoveď ani server ignorujúci Range sa nesmú zapísať do cache.
7. **Bez miešania cache.** Identita zahŕňa query, aby sa nepomiešali rôzne zdroje
   na rovnakej ceste. Súbežné zápisy majú unikátne dočasné súbory; evikčné úlohy
   sa zlučujú. Cenou je menšia úspešnosť cache pri rotácii podpisov. Cache
   obsahuje iba prijaté úseky, nie garantovanú offline zálohu filmu.
8. **Uvoľnenie HTTP klientov.** Zlyhanie alebo zrušenie pripájania video proxy
   uzatvára klienta; cache uzatvára klienta aj odpoveď vo finally.
9. **WebSocket a HLS.** Dashboard nevytvára druhé živé vlastné status spojenie;
   používa ws/wss podľa stránky a odstup opakovania s jitterom. Nie je tým
   dokázané odstránenie všetkého churnu z iných tabov/rozšírení. Turbo režim
   HLS už neukončuje zvyšok inicializácie iba preto, že vypína polling štatistík.

## Overenie

- 45 Python testov: cache, Range/proxy, Bunkr plánovač a listing/meta fronty,
  CDN rozpočty náhľadov. Zahŕňa timeout s cleanupom, 503, ignorovanie Range,
  neúplné/nadmerné dáta, platný interval, EOF a následný diskový HIT.
- 9 JavaScript testov: prepnutie proxy, ďalší fallback, súbežné chyby,
  zastaraný výsledok po zatvorení, vlastníctvo native chyby, ovládanie,
  import-status a meta kontrakty. Nejde o kompletnú suite projektu.
- `npm run build:main`, kontrola syntaxe JS a Python modulov.
- Reálny Chrome: obnovenie dashboardu, klik na Play bežného videa a Bunkr #1975.
  Obe prehrávania potvrdili postup času. Prvý Bunkr obraz potreboval približne
  9 s po priradení streamu.
- Druhý Bunkr pokus: po skutočnom kliknutí na Play vložil debugger do media
  elementu lokálnu skúšobnú požiadavku a jej odpoveď HTTP 503. Pri chybe sa
  v tej istej sekunde priradila záložná proxy; metadata prišli asi za 6 s a
  potvrdená prvá sekunda asi za 7 s. Neskôr bol čas 1:53. Je to kontrolovaná
  chyba prenosu pri dostupnom skutočnom CDN, nie simulácia zničeného originu.
- Screenshot `artifacts/network-audit-20261106/backup-503-proof.png` zachytáva
  fallback aj pokračovanie času; výrez obsahuje diagnostiku a ovládače.
- Testovacia interceptácia bola odstránená, prehrávač zatvorený a obnovený
  pôvodný filter PRINCESS JAS. Server po záverečnom reštarte hlási zelený stav.

Pozorovanie kvality: aj po úspešnom záložnom prepnutí sa vyskytovalo dopĺňanie
bufferu. Nie je podklad na tvrdenie o odstránení všetkého sekania ani o
konkrétnom percentuálnom zrýchlení.

## Navrhnuté ďalšie úpravy podľa priority

| Priorita | Úprava | Dôvod / podmienka |
|---|---|---|
| P1 | Budovať overené nezávislé zrkadlá alebo úplné lokálne kópie prioritných videí | Jediná skutočná ochrana pred výpadkom originu. Spárovať identitu obsahu, nespoliehať sa iba na podobný názov; diskový rozpočet, kvóty a integrita pred použitím |
| P1 | Vyhradiť kapacitu na prehrávanie proti náhľadom, importu a hromadnému refetchu | V logu je séria 429 z ffmpeg. Zjednotiť cooldown aj medzi ffmpeg a HTTP požiadavkami; neobchádzať existujúce limity hosta |
| P1 | Rozšíriť vysokú prioritu aj na dedikovaný Bunkr JIT a zlučovať rovnaké súbežné resolvery | Meta-preview už vysokú prioritu používa; dedikovaný resolver ju explicitne nenastavuje. Zlúčiť podľa videa a požiadavky, bez zdieľania používateľských cookies |
| P1 | Doriešiť ukončovanie background threadov | Prvý graceful restart dokončil shutdown aplikácie, no Python zostal visieť; po tomto dôkaze sa ukončil vlastný strom a server obnovil. Záverečný samostatný graceful restart už uspel. Automatické násilné ukončovanie nie je náhrada lifecycle opravy |
| P2 | Oddelený znovupoužiteľný pool pre media proxy | Teraz sa klient otvára na každú požiadavku; pool môže šetriť TCP/TLS. Oddeliť cookies a identity poskytovateľov, mať shutdown cleanup a meranie limitov |
| P2 | Spoľahlivý lokálny štart UI bez externých CDN závislostí | Alpine je načítavaný z unpkg; výpadok tejto závislosti môže zastaviť dashboard ešte pred prehrávaním |
| P2 | Zmerať pôvod opakovaných WebSocket pripojení a zjednotiť polling skrytých tabov | Samotný vysoký počet nepreukazuje, že všetky spojenia vytvára hlavný dashboard |
| P2 | Prenosové metriky a A/B porovnanie WARP trás | Zberať čas prvého obrazu, sekundy stallov/minútu a udržateľné Mbps proti bitrate konkrétnej kvality; DNS ani VPN nemeníť naslepo |
| P2 | Postupne overovať TLS proti dôveryhodnému trust store | Viaceré existujúce klienty používajú verify=False. Beztestové globálne prepnutie by mohlo vyradiť poskytovateľov; výnimky evidovať individuálne |

Timeouty sú zámerne konečné. Úplne vypnutý timeout, nekonečné retry alebo
automatické sťahovanie všetkých filmov by zvyšovali spotrebu spojení, RAM,
disku a záťaž poskytovateľa bez záruky plynulosti.

Referencie k interpretácii: [HTTPX timeouty](https://www.python-httpx.org/advanced/timeouts/),
[HTTPX limity poolu](https://www.python-httpx.org/advanced/resource-limits/),
[MDN stalled event](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/stalled_event).
