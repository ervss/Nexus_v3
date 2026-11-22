# Prednosť prehrávania a meranie — 6. 11. 2026

## Nasadené správanie

Dashboard posiela lokálnemu serveru stav aktívnych prehrávačov každých 5 sekúnd
a pri prechode medzi načítavaním, dopĺňaním bufferu, prehrávaním a pauzou.
Server obmedzí prijímanie ďalšej práce na pozadí takto:

| Stav | Súbežné pracovné jednotky pozadia | Súbežné riadené prenosy pozadia |
|---|---:|---:|
| Bez aktívneho prehrávača | 8 | 8 |
| Prehrávanie | 2 | 2 |
| Načítavanie, buffering alebo obnova | 1 | 1 |

Existujúce nižšie limity poskytovateľov ostávajú v platnosti. Ide o dva samostatné
rozpočty: import alebo náhľad môže používať sieťový rozpočet v rámci svojho
pracovného miesta. Rozbehnuté operácie sa nerušia; nižší strop sa uplatní na
ďalšie prijatie práce. Nemožno preto zaručiť okamžitý pokles už otvorených spojení.

Zapojené sú IntakeWorker, generovanie náhľadov, NTC HTTP transport, fast-thumb
Range požiadavky a FFmpeg na riadených CDN. Samostatné rozšírenia, externé
download manažéry a poskytovatelia obchádzajúci tieto miesta nemajú týmto
mechanizmom automaticky obmedzené všetky svoje spojenia.

Prehrávanie dostáva vysokú prioritu pri získavaní odkazu. Bunkr rezervuje pri
aktívnom prehrávaní dve rodinné miesta a jedno miesto hosta, pokiaľ to jeho
kapacita umožňuje. Ostatné NTC doménové brány rezervujú jedno miesto. Tieto
rezervy nezvyšujú absolútny limit hosta a neobchádzajú jeho cooldown.

Pri pauze, zatvorení, konci alebo konečnom zlyhaní sa požiadavka na rezervu
uvoľní. Ak zmizne karta alebo spojenie, platnosť signálu vyprší po 20 sekundách.
Heartbeat má poradové číslo: stará odpoveď nesmie znovu aktivovať už zatvorený
prehrávač. Viac otvorených kariet sa vyhodnocuje spoločne v jednom serverovom
procese. Implementácia je určená pre existujúci lokálny jednoprocésový server;
viac nezávislých worker procesov by potrebovalo spoločné úložisko stavu.

## Cooldown a obnova URL

- HTTP 429/503 z NTC, video proxy, fast-thumb a FFmpeg sa zapisujú do spoločného
  odkladu podľa presného hostname. Iné CDN uzly sa tým neblokujú.
- HTTP Retry-After sa rešpektuje v rozsahu 1–3600 sekúnd. Bez hlavičky je
  predvolený odklad NTC/proxy 30 s a FFmpeg 60 s; fast-thumb zachováva vlastný
  rastúci odklad a zverejní ho aj ostatným klientom.
- Náhľad na hoste v cooldowne sa odloží pred ďalším dekódovaním. Video proxy
  počas známeho cooldownu zlyhá rýchlo, aby prehrávač mohol pokračovať ďalšou
  záložnou cestou. Neposiela ďalší skúšobný prenos na nefunkčný host.
- Súbežné získavanie odkazu pre rovnaké video, extraktor a zdrojovú stránku
  zdieľa jednu úlohu. Databázové sessions sa nezdieľajú a výsledné slovníky sú
  samostatné kópie. Zatvorenie jedného odberateľa nezruší úlohu druhému;
  odchod posledného odberateľa rozpracovanú úlohu zruší.
- Krátkodobo sa cachujú iba Bunkr odkazy. Pri známom ex/expires/exp sa necháva
  60-sekundová rezerva do expirácie a výsledok sa drží najviac 60 sekúnd.
  Pri nepriehľadnej URL sa drží iba 15 sekúnd. Zlyhanie sa necachuje.
  Ostatným poskytovateľom sa výsledky medzi samostatnými pokusmi necachujú,
  pretože niektoré používajú jednorazové tokeny.
- Automatická obnova po chybe používa `?force=1`, takže preskočí cache. Odmietnutá
  URL video proxy sa navyše odstráni z cache resolvera.

## Metriky

Pri prehrávači sa zobrazujú:

- **Štart:** od požiadavky na spustenie po pozorovaný postup media času.
  Samotné metadata alebo canplay sa nepočítajú ako obraz. Pri manuálnom Play
  sa do štartu nezapočíta čakanie na používateľa.
- **Zaseknutia:** počet a čas udalostí waiting po spustení; opakované waiting
  sa zlučujú. Úmyselný seek a pauza nie sú nové sieťové zaseknutie.
- **s/min:** čas zaseknutia prepočítaný na minútu pozorovaného prehrávania.
- **Obnova:** od začiatku obnovy po nový postup media času.
- **Pozadie:** posledný serverom potvrdený limit pozadia.

Na lokálnom autentifikovanom API je `GET /api/v1/playback/metrics` s poslednými
128 sessions, aktuálnym rozpočtom a počtom cache hitov/extrakcií. Stav je iba
v pamäti a po reštarte sa vynuluje. Neodosielajú sa názvy, CDN URL, cookies ani
história prehliadania; zaznamenáva sa video ID a číselné merania. Iframe
prehrávače bez prístupu k media času neposkytujú takéto overiteľné meranie.

## Závislosti a prevádzka

Existujúca rýchla cesta náhľadov potrebovala chýbajúci PyAV. Do projektového
virtuálneho prostredia bol doplnený `av==19.0.2` a zapísaný do
`requirements/media.txt`. FFmpeg fallback ostáva zachovaný.

Adaptívne obmedzovanie možno pre porovnanie vypnúť nastavením
`NEXUS_PLAYBACK_PRIORITY=0` pred štartom servera. Zachová sa bezpečný základný
strop 8, cooldown, meranie a zdieľanie obnovy. Predvolené správanie je zapnuté.

## Kontroly

- 72 Python testov: rezervácia kapacity, zrušenie čakajúcej práce, platnosť
  signálov, oneskorené heartbeat správy, cooldown medzi klientmi, súbežný
  resolver, samostatné DB sessions, obnova cache, NTC brány, reálne Range a
  dekódovanie cez PyAV, cache a regressie importov/náhľadov.
- 21 JavaScript testov: meranie prvého obrazu, zaseknutí a obnovy, manuálne
  spustenie, životný cyklus journalu, súbežné zlyhania a ovládanie prehrávača.
- Build dashboardu a kontroly syntaxe Python/JavaScript.
- Pri spojenom behu testov sa opravil starý globálny mock asyncio.sleep, ktorý
  po spustení skutočného curl klienta vedel zablokovať jeho background slučku.

## Skutočné browser overenie

V samostatnej prihlásenej Chrome karte sa reálne odkliklo Bunkr video #1975
a následne Pause a zatvorenie prehrávača. Overené serverové stavy:

| Stav | Aktívni prehrávači | Limit pozadia |
|---|---:|---:|
| Bez prehrávania | 0 | 8 |
| Po Play, počas resolvera | 1 | 1 |
| Prehrávanie s postupom času | 1 | 2 |
| Po Pause | 0 | 8 |

Nameraný štart bol 6242 ms. Pri pauze po 159809 ms pozorovaného prehrávania
boli zaznamenané 3 zaseknutia, spolu 5543 ms, približne 2,1 s/min. Sú to
pozorovania jedného videa v jednej sieťovej situácii, nie záruka pre celý katalóg.
V týchto snímkach koordinátor nemal aktívne background úlohy; rezerváciu pri
čakajúcich úlohách overujú samostatné testy.

Živý Bunkr endpoint vrátil cache hit s HTTP 200 za 18 ms. Šesť skúšobných
`force=1` fetchov bolo v prehliadači spracovaných postupne a vynútilo šesť nových
extrakcií. Ich výsledok sa preto nepoužíva ako dôkaz súbežného zlučovania.
Zlučovanie bolo overené testami 20 súčasných odberateľov a dvoma samostatnými
DB sessions volajúcimi skutočný endpoint handler.

Prvý browser pokus odhalil falošný signál loading zo skrytých prázdnych
prehrávačov. Ten je odstránený a má samostatný regresný test: samotný preload
bez požiadavky na prehrávanie rezervu nevytvorí.

Dôkazy sú v `artifacts/playback-priority-20261106/`: `playing-metrics.png`,
`paused-metrics.png`, `browser-metrics.json` a `python-tests.log`. Testovacia
karta bola po kontrole zatvorená. Iné už otvorené karty načítajú nový skript
pri svojom ďalšom obnovení.

Pri nasadení starý worker prekročil 15-sekundový limit šetrného ukončenia.
Uvicorn zaznamenal zrušenie rozpracovaného `POST /api/v1/telegram/thumbs/repair`
s HTTP 500; jeho dokončenie sa týmto nepotvrdzuje. Po úplnom ukončení starého
procesu bol spustený nový classic server, ktorého dohľad hlási zelený stav.

Testy rezervácie kapacity nepredstavujú meranie percentuálneho zrýchlenia CDN.
Pre dlhodobé porovnanie treba rovnaké video a kvalitu, najprv bez pozadia,
potom s importom a náhľadmi, pri porovnateľnom stave siete a cache.

## Doplnenie: pomalý štart Bunkr #1975

Hodnota 6,2 s sa nepovažuje za dostatočne rýchly štart. Ďalší bounded Range
probe zistil pri súbore veľkosti 582682795 bajtov tieto prvé MP4 atomy:
`ftyp` na offsete 0, veľkosť 32; `moov` na offsete 32, veľkosť 1943845 bajtov.
Moov je teda už na začiatku, ale má približne 1,94 MB. Samotné presunutie
moov dopredu (`faststart`) tento prípad nevyrieši. Hlavičky prvých 64 KiB
prišli za 622 ms a celý tento úsek za 844 ms. Ide o jednu sieťovú vzorku.

Pokus o porovnanie serial vs 4 paralelné Range prenosy skončil pri paralelnej
časti HTTP 503; neexistuje úspešný výsledok porovnania a agresívne paralelné
načítavanie sa nenasadilo.

Upravený hlavný prehrávač teraz okamžite použije už uloženú HTTPS MP4/WebM URL
z CDN pod scdn.st/cdn.cr, ak zdroj patrí Bunkr/Balbums a jej explicitná
ex/expires/exp expirácia má viac než 60 s rezervu. Neznáme, blízko expirované,
neplatné a predtým odmietnuté odkazy naďalej prejdú resolverom. Tým sa odstráni
zbytočné podpisovanie pri každom otvorení; neznamená to dostupnosť originu.

Prešlo 24 JS kontrol. V novej reálnej Chrome karte bolo odkliknuté to isté
video a journal potvrdil priradenie platnej URL bez čakania na resolver.
Opakovaný pokus nameral 5,5 s a zaznamenal aj obnovu 4,9 s. Kvôli meniacemu
sa stavu CDN a zásahu recovery z týchto hodnôt nemožno odvodiť percentuálne
zrýchlenie. Screenshot: `artifacts/playback-priority-20261106/fresh-link-start.png`.

Štart tohto zdroja sa naďalej nepovažuje za vyriešený na úroveň 1–2 sekúnd.
Ďalšia možnosť je ohraničená cache štartovacích dát pripravená pred Play,
prípadne menšia streamová reprezentácia. V tomto doplnení sa takáto cache
ani nový HLS/MSE streamovací engine neimplementovali.
