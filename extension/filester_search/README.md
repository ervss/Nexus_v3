# Filester Discovery Bridge 13.1

## Spustenie

Dvakrát klikni na Filester Search na pracovnej ploche. Python server musí zostať zapnutý.
Dashboard je na http://127.0.0.1:8765/ui/dashboard.html.
Novú verziu rozšírenia načítaj cez chrome://extensions → Obnoviť na karte Filester Discovery.
Pri prvej inštalácii použi Načítať rozbalené a vyber priečinok extension vedľa tohto README.

## Dáta a práca

Index, obľúbené, poznámky, história vyhľadávania a discovery úlohy sú v
Desktop/Filester Search Data/filester_index.db. Pôvodný index sa pri prvom štarte
skopíruje SQLite backupom; pôvodný súbor sa zachová.
FILESTER_DB a FILESTER_DATA_DIR umožnia zmeniť umiestnenie.

Úlohy spracúva Python nezávisle od popupu alebo aktívnej karty.
Chrome alarm obnoví cache každých 30 sekúnd; otvorený dashboard každých 5 sekúnd.
Chrome cache je lokálna a prežije reštart prehliadača. Web dashboard používa vlastnú
localStorage cache. Offline je možné prezerať uložené výsledky a exportovať ich;
zmeny poznámok a obľúbených vyžadujú server.
Vypnutie servera preruší discovery. Po neočakávanom reštarte sa nedokončená úloha
označí interrupted; z histórie môžeš znovu použiť jej parametre.

Otvoriť všetky výsledky zaradí všetky filtrované výsledky, vrátane nezobrazených
stránok, do trvalého Chrome frontu. Otvoriť vybrané zaradí označené odkazy.
Front vytvorí zbalenú skupinu kariet. Pred každou kartou si vyžiada lokálny
časový slot, ktorý zdieľa tempo a prestávky s overovaním v backende.
Po dávke 20 kariet pokračuje nasledujúci Chrome alarm (približne do 30 sekúnd;
Chrome môže alarm oneskoriť). Otváranie sa dá zastaviť v dashboarde.
Pri vypnutom serveri front čaká. Už otvorené karty sa pri zastavení nezatvárajú.
Táto funkcia je dostupná v rozšírení. Web dashboard ponúka jednotlivé odkazy,
export JSON a kopírovanie URL.

História úlohy odkazuje iba na priečinky nové alebo aktualizované počas danej
úlohy. Validácia používa spoločný kandidátny pool; nejde o presnú atribúciu ku
kľúčovému slovu. Staré úlohy pred verziou 13 nemajú uložené väzby na výsledky.

## Kontroly

.venv/Scripts/python.exe test_bridge.py
node test_background.cjs

## Ochrana požiadaviek a meranie

Discovery zdroje bežia súbežne s celkovým limitom 20 sekúnd na zdroj.
Čiastočné už získané kandidáty sa zachovajú aj pri tomto limite.
Existujúci kandidátny pool sa overuje hneď, súčasne s discovery; nové výsledky
aj počítadlá sa ukladajú priebežne. Najviac dvaja pracovníci overujú priečinky,
každý reálny request dostane časový slot (maximálne 1,5 požiadavky/s na Filester,
0,5/s na externý zdroj; tempo sa pri pomalých odpovediach a chybách znižuje).

Disková cache je v Desktop/Filester Search Data/network_cache.db. Verejné
odpovede discovery používajú TTL 30 minút, overenia priečinkov 1 hodinu;
serverové Cache-Control môžu tento čas skrátiť. Staršie odpovede sa podľa
ETag/Last-Modified podmienene obnovujú. Cache má limit 512 položiek/64 MiB
komprimovaných tiel; telemetry si ponechá približne posledných 5000 udalostí.

Pri 429 sa rešpektuje Retry-After vrátane HTTP dátumu, pri vyčerpanej kvóte
X-Rate-Limit-Remaining=0 aj čas jej resetu. Pri 401/403 alebo rozpoznanej
ochrannej stránke sa zdroj pozastaví. Po dvoch sieťových chybách/5xx sa otvorí
ochranná prestávka. Prestávky aj limity sú uložené na disk a prežijú reštart.
Filester domény zdieľajú rovnaký limit; zmena domény neobchádza prestávku.
Timeout/obmedzenie je ERROR, nie DEAD; kandidát zostáva neoverený na neskôr.

HTTP klient má samostatné backendové cookies; cookies z Chrome nečíta.
Cookie hlavičky ani autorizačné tokeny sa nepersistujú do cache/telemetry.
Odpovede autentifikovaných požiadaviek sa cez verejnú cache nezdieľajú.
Ide o zníženie záťaže a reakciu na obmedzenia, nie o anonymizáciu IP alebo
garanciu, že vzdialená služba nebude blokovať požiadavky.

.venv/Scripts/python.exe test_network.py
.venv/Scripts/python.exe benchmark_validation.py
.venv/Scripts/python.exe probe_network.py

Benchmark používa iba MockTransport, bez externej prevádzky. Probe vykoná štyri
externé GET požiadavky a vypíše len status, čas, veľkosť a hlavičky limitov.
Podrobné merania a rozsah overenia sú v PERFORMANCE.md.
