# Zadanie pre Codex Desktop: prehľad a hromadný import Turbo.cr videí

## Cieľ a autorizovaný rozsah

Implementuj funkciu priamo do existujúceho lokálneho rozšírenia Nexus Video Card Selector. Používateľ chce na stránke threadu nájsť Turbo.cr videá, postupne zobraziť ich metadáta, filtrovať ich, pohodlne označiť a hromadne importovať do Nexusu.

Projekt: `C:\Users\Peto\Desktop\NexusPWC\_fresh\_v2`

Rozšírenie: `C:\Users\Peto\Desktop\NexusPWC\_fresh\_v2\extensions\nexus-video-selector`

Používateľ potvrdil, že v rozšírení existuje `manifest.json`. Úpravy rozšírenia sú autorizované. Prezri aj existujúci backend v projekte; ak je potrebný resolver alebo metadata endpoint, implementuj súvisiacu úpravu v rámci tohto projektu. Zachovaj existujúce importné rozhrania, nastavenia a podporu ostatných hostingov. Nerob rozsiahly nesúvisiaci refaktor ani automatický import počas overovania.

Najprv prečítaj príslušné AGENTS.md a dostupné pokyny pre Chrome rozšírenia. Zisti stav pracovného stromu a zachovaj používateľove rozpracované zmeny. Nevyžaduj nové potvrdenie bežných krokov už pokrytých týmto zadaním.

## Kontext a stav overenia

Referenčná stránka:

`https://simpcity.cr/threads/deniangel-denisagottvaldova.20685/page-2#post-52275227`

Z textového kontextu stránky boli viditeľné ovládacie prvky:

- počet vybraných videí,
- import na porty 8000, 8001 a 8002,
- Batch Import, Kopírovať URL, Export JSON a Zrušiť výber,
- pri jednej položke Size: 50.6 MB,
- Copy Direct URL, Open Direct, Sidecar a live player.

Tieto texty potvrdzujú prítomnosť ovládania, nie funkčnosť jednotlivých akcií. Konkrétne Turbo.cr href, štruktúra embedov, spôsob získavania metadát, kód rozšírenia a API Nexusu neboli v tejto relácii preskúmané. Všetky technické návrhy nižšie treba prispôsobiť skutočnému kódu. Nevymýšľaj existujúce endpointy ani predpokladanú podporu hostingu.

Prístup cez Remote nástroj zlyhával hlásením ENOENT, hoci používateľ v lokálnom PowerShelli potvrdil existenciu manifestu. Neboli vykonané žiadne zmeny zdrojového kódu. Toto je implementačné zadanie, nie dokončená funkcia.

## Požadované používateľské rozhranie

Do existujúceho selectora pridaj jasné tlačidlo **Prehľad videí**. Otvorí široký panel nad stránkou so zoznamom videí a hromadnými akciami. Použi existujúci vizuálny štýl a slovenské popisy. Panel musí byť použiteľný aj pri užšom okne, mať dobre viditeľné zatvorenie a nesmie prekrývať vlastné tlačidlá.

Panel má obsahovať:

1. Hlavičku s počtom nájdených videí, rozsahom skenovania a stavom načítavania.
2. Predvolený rozsah **Aktuálna stránka**. Funkciu **Celý thread** implementuj až po spoľahlivom dokončení základného toku; nesmie sa spustiť automaticky.
3. Vyhľadávanie, filtre a triedenie.
4. Tabuľku alebo prehľadné kompaktné riadky videí.
5. Trvalo viditeľný spodný panel so súčtami a tlačidlom **Importovať vybrané (N)**.

Riadok videa:

| Prvok | Obsah |
|---|---|
| Checkbox | Výber položky |
| Video | Skutočný názov, prípadne neutrálne Video 01; dostupný malý náhľad |
| Zdroj | Odkaz na pôvodný príspevok, napr. #25 |
| Dĺžka | mm:ss alebo h:mm:ss |
| Rozlíšenie | Napr. 1080p a presné 1920 × 1080 |
| Veľkosť | Čitateľné MB/GB; interne presná hodnota v bajtoch |
| Stav | Čaká, Načítava údaje, Pripravené, Nezistené, Nedostupné, Už v Nexuse, Importuje sa, Importované alebo Chyba importu |

Kvalitu označuj ako rozlíšenie, nie subjektívne hodnotenie obrazu. Zohľadni portrétové videá; uvádzaj presné rozmery a jasne definuj spôsob výpočtu triedy 720p/1080p. Ak zdroj poskytuje viac variantov, ukáž ich a používateľovi sprístupni voľbu bez nejasného tvrdenia, že všetky sú rôzne videá.

Kliknutie na zdrojový príspevok má používateľa presunúť na jeho miesto alebo otvoriť permalink. Náhľad/prehratie má byť samostatná akcia; kliknutie na riadok nesmie neúmyselne meniť checkbox. Náhľady načítavaj len podľa potreby a prehrávanie spúšťaj až používateľovou akciou.

## Filtre, triedenie a výber

- Textové hľadanie podľa názvu a dostupného identifikátora.
- Rozlíšenie: všetky, aspoň 720p, aspoň 1080p; neznáme rozlíšenie má samostatnú voľbu.
- Minimálna a maximálna dĺžka a veľkosť; jednotky musia byť zrozumiteľné.
- Stav: pripravené, neznáme údaje, nedostupné, ešte neimportované; Už v Nexuse len pri spoľahlivom overení.
- Triedenie podľa poradia v threade, dĺžky, veľkosti a rozlíšenia, vzostupne aj zostupne. Neznáme hodnoty zoraď konzistentne za známe.
- **Vybrať zobrazené**, **Zrušiť výber zobrazených**, **Zrušiť celý výber**.
- Výber zostáva zachovaný pri filtrovaní, triedení a postupnom dopĺňaní metadát.
- Jasne ukáž počet vybraných položiek skrytých filtrom.
- Importný počet vždy zodpovedá skutočnému výberu vrátane skrytých položiek; používateľ musí tento rozsah vidieť pred kliknutím.
- Rovnaké video identifikované stabilným hostingovým ID zobraz raz a uchovaj všetky zdrojové príspevky. Nezlučuj odlišné videá len preto, že majú rovnaký názov alebo veľkosť.
- Prepojenie s existujúcimi checkboxmi/card selectorom musí byť obojsmerné alebo musí mať jasne definovaný spoločný zdroj výberu.

Spodný panel napríklad: **12 vybraných · 2,8 GB · 1 h 24 min**. Súčet neznámych metadát nesmie vyzerať ako kompletný: zobraz napr. **2,8 GB známych · veľkosť 3 videí nezistená**.

Cieľ importu prevezmi z existujúceho nastavenia. Podporované porty v pozorovanom UI sú 8000 / 8001 / 8002. Predvoľba nesmie používateľa nečakane presmerovať do inej Nexus inštancie.

## Objavovanie odkazov

Prezri reálny DOM a existujúci scanner. Turbo odkazy môžu byť v anchoroch, embedoch alebo dátových atribútoch; implementuj iba overené formáty. Použi parser URL a kontrolu hostname, nie voľné hľadanie slova turbo v URL. Doménové aliasy pridaj iba ak sú potvrdené.

Uchovaj pôvodný hostingový odkaz, stabilné ID, permalink príspevku a dostupné poradie. Do panelu nezahrňuj reklamy, navigáciu alebo vlastné prvky panelu. Existujúce Bunkr/Gofile správanie zachovaj.

Nové položky pri dynamickom načítavaní stránky pridávaj bez straty výberu a bez opakovaného hromadného fetchovania. DOM aktualizácie dávkuj, observer ohranič a pri zatvorení/ukončení funkcie uprac pozorovatele a event listenery. Pri väčšom zozname použi stránkovanie alebo virtualizáciu podľa existujúcej architektúry.

## Zisťovanie metadát

Najprv zisti, či Nexus už má Turbo resolver a metadata probe. Prednostne rozšír existujúcu implementáciu. Navrhovaná architektúra je: content script nájde odkazy; extension messaging sprostredkuje požiadavku; backend vyrieši hostingový odkaz a vráti dostupné metadáta. Ak backend nie je potrebný, zdôvodni zvolený spôsob a rešpektuj CORS, CSP a oprávnenia rozšírenia.

Zásady:

- Načítavaj veľkosť, dĺžku a rozmery postupne; jedna chyba nesmie zastaviť zvyšok zoznamu.
- Najprv použi existujúce metadáta/resolver, prípadne overené údaje stránky hostingu.
- Content-Length nie je vždy veľkosť celého videa. Pri odpovedi 206 správne pracuj s celkovou veľkosťou v Content-Range. HTML chybovú stránku nezobraz ako veľkosť videa.
- HEAD nemusí byť podporovaný; fallback nesmie stiahnuť celé veľké video len kvôli prehľadu.
- Dĺžku a rozmery získaj z overeného média/probe, nie z názvu súboru. Zohľadni rotáciu videa a chýbajúce metadáta.
- Ak sa používa ffprobe, daj časový limit a obmedzenie súbehu; URL odovzdávaj bezpečne ako argumenty, nikdy cez interpolovaný shell.
- Sťahovanie dát kvôli metadátam musí mať limity; ak zdroj vyžaduje celý súbor, ukáž nezistené údaje alebo explicitnú samostatnú akciu.
- Začni približne tromi súbežnými požiadavkami; presnú hodnotu prispôsob existujúcemu riešeniu. Rešpektuj 429 a Retry-After, nepoužívaj nekonečné opakovanie.
- Timeout, zrušenie, obmedzený retry a viditeľný priebeh. Zatvorenie panelu alebo Stop nesmie nechávať neobmedzenú prácu na pozadí.
- Cache kľúčuj stabilným ID hostingu a relevantným variantom; používaj TTL a explicitné Obnoviť údaje. Krátkodobé chyby majú kratšiu platnosť než úspešné metadáta.
- Expirujúce priame URL obnov pri importe podľa existujúceho resolvera. Na deduplikáciu nepoužívaj krátkodobý podpis URL.
- Nenačítavaj heslá ani nepíš autentizačné tokeny do logov. Neobchádzaj prihlasovanie, CAPTCHA ani obmedzenia prístupu. Ak sú potrebné, ukáž zrozumiteľný stav.

Ak vznikne nový backend endpoint, obmedz povolené vstupné hostingy a kontroluj presmerovania resolvera. Nepridávaj všeobecný fetch ľubovoľných URL alebo otvorený proxy endpoint. Použi existujúcu ochranu lokálneho API a validáciu vstupov.

Manifest zachovaj vo verzii V3. Nepridávaj široké nové oprávnenia bez potreby. Nové požiadavky na hostingy a lokálne API presne odôvodni. Pre async messaging ošetri chyby a životnosť service workera; dôležitú pretrvávajúcu cache ulož cez existujúcu storage vrstvu.

## Hromadný import

Použi existujúci Nexus importný tok. Pred odoslaním vytvor stabilný snapshot vybraných položiek, aby dopĺňanie metadát alebo filtre nemenili rozbehnutý import.

- Nespúšťaj import pri otvorení panelu alebo po skenovaní.
- Chráň tlačidlo proti dvojitému kliknutiu a duplicitným dávkam.
- Metadáta odovzdávaj len v poliach podporovaných skutočným API.
- Rozlišuj prijatie úlohy do fronty a dokončený import. Stav Importované zobraz iba na základe potvrdenia, ktoré to skutočne dokazuje.
- Pri čiastočnom úspechu ukáž výsledok pre každú položku a umožni retry iba zlyhaných.
- Pri offline Nexuse zachovaj výber a ponúkni opakovanie; neprepínaj port automaticky.
- Už v Nexuse označ iba podľa skutočnej odpovede správnej cieľovej inštancie. Pri zmene portu výsledok prepočítaj alebo zneplatni.
- Batch/session hranicu over podľa existujúceho API. Samotný batch_name nemusí jednoznačne označovať jednu importnú reláciu.
- Po prijatí serverom musí byť jasné, čo sa dá zastaviť a čo už beží na serveri.

Kopírovanie URL a JSON export prepoj s existujúcimi funkciami. Ak rozšíriš export, zachovaj kompatibilitu alebo uveď verziu schémy. Export nemá obsahovať autentizačné tajomstvá.

## Druhá etapa: celý thread

Po dokončení a overení aktuálnej stránky môžeš doplniť Celý thread v rámci dostupného času. Používateľ ho spúšťa vedome. Zobraz počet spracovaných stránok, nájdených unikátnych videí a Stop. Rozlišuj štandardnú pagináciu a už dynamicky pridané príspevky, aby sa obsah nezapočítal viackrát. Nenaviguj používateľovu otvorenú stránku pri zbere na pozadí. Neobchádzaj prístupové obmedzenia. Neprezentuj celý thread ako hotový, ak je implementovaná iba aktuálna stránka.

## Overenie a akceptačné kritériá

Vykonaj primerané statické kontroly a existujúce relevantné testy. Zmysluplne over deduplikáciu, jednotky, neznáme hodnoty, zachovanie výberu, obmedzenie súbehu a čiastočný úspech importu. Nepíš testy, ktoré iba kopírujú implementáciu.

Funkciu v rozhraní označ ako overenú až po skutočnom použití rozšírenia v Chrome a zachytení screenshotu. Samotný syntax check, HTTP 200 ani odpoveď API nedokazujú správny browser workflow.

Reálny klikací tok:

1. Načítaj upravené lokálne rozšírenie a otvor referenčný thread.
2. Klikni Prehľad videí a over správne objavené Turbo odkazy bez duplicít.
3. Over aspoň jednu dostupnú metadatovú hodnotu proti skutočnému zdroju; chýbajúce údaje majú jasný stav.
4. Použi filter a Vybrať zobrazené, zmeň triedenie a over zachovanie checkboxov.
5. Skry vybranú položku filtrom a over správny počet skrytých vybraných a súčty.
6. Over chybu resolvera a nedostupný backend bez straty výberu.
7. Importný tok over na izolovanom testovacom cieli alebo mocku. Skutočný import do používateľovej knižnice rob len po jeho konkrétnom pokyne pre danú dávku.
8. Zachyť screenshoty panelu, výberu a výsledkov relevantného toku. Netvrď úspech reálneho importu na základe mocku.

Ak reload rozšírenia alebo stránky musí vykonať používateľ, použi krátky výrazný blok **DÔLEŽITÉ – tvoj krok** s presnými krokmi. Ak browser kontrola nie je dostupná, dokonči dostupné úpravy a kontroly, ale explicitne označ UI ako neoverené a uveď blocker.

## Čo odovzdať

Dokončené úpravy v existujúcom projektu, stručný popis zmenených súborov, výsledky kontrol a screenshoty skutočného UI. Uveď prípadné závislosti backendu, nutnosť jeho reštartu a presný reload postup pre Chrome. Nesľubuj metadáta, ktoré Turbo neposkytuje alebo ktoré neboli overené.

Priorita: funkčný prehľad aktuálnej stránky → spoľahlivé metadáta → filtre a spoločný výber → hromadný import a per-item výsledky → celý thread. Pokračuj samostatne až po dokončenie autorizovanej implementácie; nepovažuj samotný návrh za výsledok.
