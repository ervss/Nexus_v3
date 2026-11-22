# Prehľad videí Turbo.cr

Na SimpCity threade otvor **Prehľad videí** vľavo hore. Zobrazuje Turbo videá
z aktuálne načítanej stránky vrátane príspevkov, ktoré už pripojil automatický
pager. Nesťahuje ďalšie stránky threadu. Celý thread nie je súčasťou tejto etapy.

## Priamo na threade

Každý Turbo embed má hore štítky Dĺžka, Kvalita a Veľkosť. V paneli pod tlačidlom
prehľadu klikni **Vybrať všetky → Skenovať vybrané**. Sken funguje aj so zatvorenou
galériou, spracúva najviac tri videá naraz a priebežne dopĺňa štítky na všetkých
duplikovaných výskytoch videa. Výber všetkých sa týka aktuálne načítaných Turbo
kariet, vrátane už pripojených príspevkov.

**Automaticky skenovať výber** načíta existujúci výber a ďalej skenuje novovybrané
videá. **Stop skenu** zruší bežiace metadata požiadavky a zastaví čakajúcu frontu.
Pôvodný prehrávač sa pripraví iba pre skenované ID; video sa automaticky neprehrá.

## Výber a import

- Galéria má 3 stĺpce a všetky karty v jednom scrollovacom prehľade bez
  stránkovania; na menších obrazovkách 2 alebo 1 stĺpec.
  Panel a checkboxy pri Turbo embedoch používajú spoločný výber. Rovnaké
  hostingové ID sa zobrazí raz; karta zachová všetky zdrojové príspevky.
- Pri každom otvorení je minimum dĺžky 60 sekúnd. Už vybrané videá kratšie
  než 60 sekúnd a videá s nezistenou dĺžkou sa odznačia; pri neskoršom
  zistení krátkej dĺžky sa odznačia tiež. Po zmene alebo vymazaní minima
  možno tieto videá zobraziť a vybrať ručne. Ostatné filtre výber nemenia.
  Súhrn aj import zahŕňajú položky skryté filtrom.
  „Vybrať zobrazené“ zahŕňa celý výsledok filtra, aj karty nižšie v galérii.
- Názov batchu sa pri otvorení predvyplní názvom threadu, prípadne jeho URL
  názvom, a dá sa upraviť pred importom.
- Rozlíšenie p znamená kratšiu zobrazovanú stranu, napr. 1080 × 1920 je 1080p.
  MP4 matica rotácie 90/270 stupňov je zohľadnená. MiB/GiB sú binárne jednotky.
- Dĺžka, kvalita a veľkosť sú vždy v štítkoch cez horný okraj náhľadu.
  Načítaný prehrávač môže doplniť dĺžku a zobrazované rozmery priamo z videa;
  veľkosť meria cez CDN HEAD a Content-Length bez sťahovania súboru. Správy
  prijíma worker iba z Turbo embedov a posiela ich do hlavného rámca rovnakého
  tabu. Neskorší neúspech API neprepíše už namerané hodnoty.
- Každá karta má originálny Turbo prehrávač. Načíta zastavený záber bez autoplay;
  kliknutie na Play prehrá video priamo v karte. Aktualizácia metadát ani výberu
  existujúci prehrávač neodpojí. Filter odstráni skryté prehrávače; obyčajný scroll
  karty neodstraňuje ani nepridáva. Všetky karty sú vytvorené pri otvorení prehľadu.
  „Otvoriť“ zobrazí hosting v samostatnej karte. Rozšírenie aktívne pripraví náhľad
  iba v embedoch označených `#nvs-gallery`; pôvodné embedy threadu nemení.
- Cieľ sa preberá z uloženého nastavenia `nvsOverviewPort`, inak zo základného
  existujúceho nastavenia `ports['8000']`. Panel podporuje 8000/8001/8002 a
  zapamätá explicitnú zmenu. Offline cieľ sa automaticky nenahradí iným portom.
- Import používa `/api/v1/import/bulk` a stabilnú `/v/<ID>` URL. Existujúci
  backendový import resolver obnoví podpísaný stream. Metadáta nie sú priame URL.
- „Importované“ znamená potvrdenie uloženého videa jeho ID v odpovedi bulk API;
  následné spracovanie/thumbnail môže ešte bežať. Odpoveď s `job_id` znamená len
  **Prijaté do fronty**. Túto úlohu skontroluj v import monitore správneho Nexusu.
  Nepoužívaj opakovaný názov batchu ako identifikátor importnej relácie.
- Retry odošle iba zlyhané položky. Po nejasnom výsledku odoslania najprv skontroluj
  Nexus; panel nepovolí automatický retry, ktorý by mohol vytvoriť ďalšiu dávku.
  Zatvorenie ani Stop nezastaví import už prijatý serverom.
- JSON export má `schemaVersion: 2`, zachová pôvodné `items`/URL polia a pridá
  presné bajty, hostingové ID a zdrojové príspevky. Neobsahuje podpisy ani tokeny.

## Metadáta a backend

Nový endpoint `POST /api/tester/turbo-meta` je dostupný cez existujúci tester router
v klasickom Nexuse aj LITE. Používa rovnakú ochranu `X-Nexus-Token` ako extension
bridge (ak je nakonfigurovaná). Rozšírenie preberá existujúci uložený bridge token.

Povolené vstupy sú HTTPS `turbo.cr/v/`, `/d/`, `/embed/`. CDN resolver akceptuje
len HTTPS `turbocdn.st` a jeho subdomény, kontroluje každý redirect a overuje TLS.
Opätovne používa existujúci Turbo HTML parser a MP4 parsovanie. Číta maximálne
512 KiB stránky, 16 KiB podpisovej odpovede a 128 KiB + 256 KiB + 1 MiB média.
Ak server ignoruje Range, čítanie ukončí po prvom limite a neskúša celý súbor.
HTML/JSON nepovažuje za video; pri 206 používa celkovú veľkosť z Content-Range.
Chýbajúce alebo neoveriteľné údaje ostávajú označené ako nezistené.

Panel aj backend obmedzujú súbeh na tri požiadavky. Operácia resolvera má limit
22 sekúnd; extension požiadavka 25 sekúnd. Stop/zatvorenie zruší extension fetch
a čakajúce úlohy; prípadná serverová operácia zostáva ohraničená časovým limitom.
Pri 429 sa nové požiadavky odložia podľa Retry-After. Nie je nekonečný retry.
Cache v `chrome.storage.local` je podľa cieľového portu a stabilného ID: 6 hodín
kompletný úspech, 1 minúta neúplný výsledok alebo chyba. **Obnoviť údaje** ju obíde.

Ak lokálna API chýba alebo je blokovaná, worker meria metadáta priamo cez Turbo
sign API a obmedzené MP4 Range čítanie (16 KiB + 128 KiB + 256 KiB + 1 MiB).
Kontroluje host, typ odpovede, Content-Range, rotáciu a dátové limity; odmieta
presmerovanie na iný cieľ. Podpísaný stream sa neukladá do cache ani exportu.
Tento fallback nemení cieľ importu ani nepridáva oprávnenia. Pri 429 sa
nepokúša obísť prestávku ďalším resolverom.

Manifest ostáva V3, neboli pridané žiadne oprávnenia ani host permissions.
Existujúce `<all_urls>` oprávnenie pokrýva bežné content scripts aj lokálne API.

## Načítanie zmien

1. V `chrome://extensions` pri **Nexus Video Card Selector Fresh_v2** klikni ↻.
2. Obnov SimpCity thread. Samotný reload stránky nemusí obnoviť cache zdrojov
   rozšírenia; po úprave JS/CSS treba najprv obnoviť rozšírenie.
3. Ak panel hlási chýbajúce metadata API (404), reštartuj konkrétny Nexus backend.
   Pri serveri s aktívnym auto-reloadom samostatný reštart nie je potrebný.

## Overenie

`node --test tests/turbo_overview.test.cjs tests/turbo_overview_ui.test.cjs`
a `python -m pytest tests/test_turbo_overview.py tests/test_turbo_album_routes.py -q`.
Browserový automatický test používa izolovanú stránku a mock importu; nevkladá nič
do používateľovej knižnice. Overenie v používateľovom Chrome a jeho screenshoty
sa evidujú samostatne od mock testu.
