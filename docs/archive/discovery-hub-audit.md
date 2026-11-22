# Discovery Hub — audit a návrh

Dátum merania: 2026-11-11. Rozsah: len čítanie. Import ani enrich som nespúšťal. Živé meranie išlo na bežiaci Nexus `http://127.0.0.1:8000` (`/health` vrátil healthy).

Discovery Hub nie je rozbitý index. Najnovšie albumy z Balbums vie server vrátiť za zlomok sekundy. Rozhranie ich nenačíta. Tab Najnovšie a Trending zmažú mriežku a Hľadať je bez textu vypnuté, takže stránka ostane na vete „Discovery Hub je pripravený“.

Hub nie je samostatná stránka. `/discovery-hub` vykreslí celý dashboard (`index.html`) a hub je overlay v tom istom súbore. Logika je v `app/static/main.js` (`discoveryHubSearch` a ďalej). Zdroj je `GET /api/v1/discovery-hub/bunkr`.

## Čo som nameral

Prázdny dotaz, `mode=latest`, `limit=8` (server ho zdvihne na minimum 10):

- HTTP 200 za 0,39 s
- 10 albumov, všetky s náhľadom aj s počtom súborov
- provider `balbums_html`, `has_more: true`, žiadna chyba zdroja

Ten istý latest s `limit=100`, ako to posiela samotné UI:

- HTTP 200 za 0,30 s, 97 albumov, 76 KB
- počty súborov doplnené pri všetkých
- dátum prvého alebo posledného uploadu chýba pri 95
- `sample_files` je prázdne pri všetkých

Hľadanie `mode=search&query=test` (10 kariet): 0,50 s, 10 výsledkov, žiadne ukážky videí, `video_count` nula. Režim súborov `mode=files&query=test&content=video`: 0,68 s, 10 súborov, `video_count` doplnený, ukážky opäť žiadne.

Index teda stíha. Pomalé je to, čo UI spraví potom, a to, že Najnovšie vôbec nezavolá.

## Prečo taby nič nepridajú

`discoveryHubSearch` hneď na začiatku skončí, keď je pole prázdne:

```js
if (!(this.discoveryHubQuery || '').trim()) return;
```

Tlačidlo Hľadať má `:disabled="!discoveryHubQuery.trim()"`. Prázdny Enter na Najnovšie sa k API nedostane.

`discoveryHubSetMode` (Trending, Najnovšie, Albumy, Súbory aj prepínače zdrojov) zvýši sekvenciu, zruší bežiaci request, **vymaže výsledky** a nič nenačíta. Klik na Najnovšie po úspešnom hľadaní teda spraví prázdny hub.

Keď text v poli je, a režim nie je Súbory, search si režim sám prepne na `search`. Vetva `mode=latest` na serveri, ktorá vie ísť na `balbums.st/?sort=latest` aj na Findr `api/albums?sort=latest`, z tohto UI nebeží.

Server tú vetvu má a v meraní funguje. UI ju odreže skôr, než vznikne request.

## Ďalšie diery v stroji

1. **Každé hľadanie pýta 100 kariet.** `params.set('limit', 100)`. Server má strop 100 a podlahu 10. Jedna stránka je zámerne veľká, aj keď na obrazovku stačí prvá tridsiatka.
2. **Po vykreslení ide automatický enrich.** `discoveryHubEnrichVisible` berie albumy bez počtu alebo veľkosti a prvé neobohatené súbory bez náhľadu, po 8, každý chunk je ďalší POST `/discovery-hub/enrich`. Enrich má semafor 4 a timeout 20 s na položku. Keď Balbums počty už dal, albumy sa preskočia. Keď ich nedal (Findr, výpadok, challenge), stovka albumov ide na Bunkr sama od seba.
3. **Po základnom enriche sa albumom `_enriched` znova nastaví na false.** Hlavičkové tlačidlo „Načítať meta“ preto ostane aktívne. `discoveryHubIsMissingMeta` chce naraz dátumy, náhľad aj veľkosť. V meranom latest feede chýba dátum 95 kartám z 97, takže tlačidlo po otvorení ukazuje desiatky chýbajúcich, hoci index je už použiteľný.
4. **Obsahový filter sa zamkne pri štarte hľadania** (`_dhubSearchContent`). Zmena selectu Obsah potom len skrýva riadky. Nápoveda pri selecte hovorí, že v Súboroch treba hľadať znova. Pri albumoch to tak nie je a používateľ nevidí prečo mriežka redne.
5. **Vylučujúce slová sú neviditeľné.** `excludeKeyword` je natvrdo `candid, trans, dildo, joi, solo, lesbian`. Filter beží pri prijatí aj v `discoveryHubVisibleResults`. V šablóne na to nie je pole. Reset tú istú vetu zapíše naspäť. `filters.keyword` tiež nemá input. Karty miznú bez ovládača.
6. **403 a challenge Balbums sú ošetrené len na serveri.** Keď HTML obsahuje `cf-chl-` / „just a moment“, provider sa na 60 s označí ako nedostupný a feed padne na Findr. UI to vie zobraziť ako žltý warning, ale tab Najnovšie sa k tomu dnes nedostane. Findr `provider=bunkr` server sám označuje ako nespoľahlivý počet (`filtered_provider_totals` vynuluje total), lebo listing parameter ignoruje.
7. **Deadline je tesný a dvojitý.** Endpoint má `@hub_deadline(30)`. Prehliadač abortuje o 35 s a hlási „Načítanie trvalo príliš dlho“. `HubRuntime` pustí naraz najviac 128 requestov, inak „Discovery Hub je vyťažený“. Konektor je 16 spojení, 4 na hostiteľa. Explorer je v UI označený ako pomalý a v latest/search sa aj tak vypne (`include_bunkrr` a `include_explorer` idú na 0).
8. **Import všetkého je v hlavičke.** Jedno tlačidlo zaradí každý viditeľný, ešte neimportovaný album. Pri 100 kartách je to hromadný import bez medzikroku. Priebeh sa polluje po jednom jobe každé 3 s, to je v poriadku. Štart nie.
9. **„Načítať všetky výsledky“** je checkbox aj tlačidlo v päte. Checkbox po hľadaní točí `discoveryHubLoadAll`, kým `has_more`. Pri Balbums viacstránkovom liste je to dlhý seriál stoviek kariet a potom enrich.
10. **Prehrávanie súboru v hube je slepá ulička.** `dhubPlayFile` otvorí modal, raz zavolá `/discovery-hub/stream`, a nemá ďalšie ani predchádzajúce. Album sa neprehrá z karty. Jediná cesta k videám v albume je 34px tlačidlo, ktoré otvorí druhý fullscreen (Album Viewer, `z-index` 10100 nad hubom 9998). Až tam je NDJSON stream, ďalšie/predchádzajúce a HD storyboard. Tretí overlay je prehrávač albumu. Tri vrstvy na jedno video.
11. **Klik na náhľad v hube nerobí nič.** Výber je checkbox. Play je len pri `type === 'video' || type === 'file'`, takže aj archív a obrázok dostanú play. V Album Vieweri klik na kartu prepína výber a play je hover tlačidlo s `opacity: 0`.

## Čo zmeniť v stroji, v tomto poradí

### Aby Najnovšie naozaj načítalo

Prázdny Enter a klik na tab nech zavolá `mode=latest` alebo `mode=trending` bez query. `discoveryHubSetMode` nech namiesto vymazania bez fetchu rovno spustí načítanie. Prepínač zdroja nech refetchne, nie `setMode`. Text v poli nech prepne na Albumy až keď používateľ hľadá, nie keď je len predtým otvorený tab Najnovšie.

Po odpovedi ukázať provider (`balbums_html` / `findr_api`), čas a `has_more`. Keď Balbums spadne na challenge, banner nech povie „náhradný index Findr, poradie sa líši“, nie len tichú nulu.

### Aby prvá obrazovka bola ľahká

Prvá dávka 24 alebo 30 kariet, nie 100. Ďalších 100 nechať ako vedomý krok, ktorý už v päte je. Checkbox „načítať všetky“ dať preč z defaultu. Automatický enrich nespúšťať na celú stránku. Doplniť dátum a ukážky až pre karty vo viewporte, po 4, pod existujúcim semaforom. Keď Balbums už dal `file_count` a náhľad, kartu neposielať na `/enrich`.

`_enriched` nech znamená „základ stačí na rozhodnutie“ (náhľad + počet alebo veľkosť). Chýbajúci dátum nie je dôvod držať v hlavičke tlačidlo na 95 requestov. Hlboký refetch ostane na karte a na výbere.

### Filter, ktorý ide vidieť

Vylučujúce slová dať do filtra ako editovateľné chips, default nech je prázdny alebo posledná voľba z `localStorage`, nie skrytý reťazec v JS. Zmena Obsah v režime Súbory nech zopakuje hľadanie, lebo `ext` ide na Findr. Pri albumoch nech sa len filtruje a počítadlo povie „skryté filtrom: N“.

### Import a stream

Import všetkého nech chce potvrdenie s počtom albumov a odhadom súborov (`import_plan.estimated_items`). Jeden album nech ostane jeden job, ako dnes, sieťové rozbalenie pred DB transakciou je správne. Súborový player a albumový player nech používajú jednu funkciu s frontou viditeľných videí. `/discovery-hub/stream` nechať, HLS proxy nechať. Ďalšie video nech ide bez zatvorenia vrstvy.

### Rýchlosť, ktorá už v kóde je a netreba ju búrať

`HubRuntime` cache Balbums stránok na 10 minút a pri výpadku vráti starú kópiu. Album Viewer ide NDJSON (`album-files-stream`): listing hneď, meta po súboroch, veľký album po dávkach, hotové súbory sú v disk cache. To je správny model. Ten istý model chce aj mriežka hubu: 30 kariet hneď, meta len tomu, na čo sa pozeráš. Explorer nechať vypnutý. Miešanie bunkrr do latest feedu je na serveri už vypnuté, aby jedna stránka nebola z polovice cudzí index. To držať.

## UI

Súčasný hub je pult na metadáta. Na pozeranie je slabý. Hlavička má logo, hľadanie, Hľadať, Import všetko, dlhé tlačidlo meta, Históriu a zatvorenie. Pod tým štyri taby, pri Trending ešte tri zdroje. Pod tým veta o Balbums vs Findr. Potom lišta výberu s ôsmimi akciami, potom osem filtrov, checkbox na všetky stránky, tri stavové riadky a mriežka natvrdo na 5 stĺpcov.

Karta má 16:9 náhľad, ktorý sa nedá kliknúť. Pod ním názov, podnázov, dva dátumy, až 8 pillov (počet, videá, obrázky, veľkosť, kvalita, album, views, rank, oba dátumy ešte raz), až 6 malých ukážok a rad Import / Play alebo 34px album / refetch / externý odkaz. Tie isté čísla sú na náhľade aj v pille. Album Viewer je druhá celá obrazovka s vlastným toolbarom (typy, triedenie, sedem hustôt, HD 2×2 / 1× / vypnúť, Fetch HD dvakrát) a prehrávač je tretia vrstva. HD scrub pri hoveri je jediná vec, ktorá pri pozeraní naozaj šetrí klik.

Druhý prechod cez šablónu došiel k tomu istému. Spoločný návrh je jedna plocha, pracovne **Watch Desk**. Hub, obsah albumu a prehrávač sú jeden viewport. Žiadna nová knižnica a žiadna štvrtá vrstva.

### Rozloženie

```
┌──────────────────────────────────────────────────────────────┬─────────────┐
│ ←  Najnovšie          [ hľadať……………… ]   T  Nové  Alb  Súb  │  prehrávač  │
│ balbums  bunkrr  explorer     história   import (3)  Filtre │             │
├──────────────────────────────────────────────────────────────┤  16:9       │
│ 97 albumov · Balbums · 0,3 s          meta 12/30   +30  Auto │  názov      │
├───────────────────────────────┬──────────────────────────────┤  ‹  4 / 30 ›│
│ [náhľad]     [náhľad]         │ [náhľad]                     │  Import     │
│ názov        názov            │ názov                        │             │
│ 86 súb. · 4,2 GB · 11. 11.    │ 12:04 · 1,2 GB               │             │
└───────────────────────────────┴──────────────────────────────┴─────────────┘
```

Horný rad je jeden. Späť a názov kontextu (Najnovšie, alebo `hľadanie › album`). Pole ostane zapnuté aj prázdne. Prázdny Enter na Nové a Trending fetchne. Prepnutie tabu fetchne a **nemaže naslepo**. Tri zdroje refetchnú. História je popover. Import je ikona s počtom, nie „import všetko“ na celý feed. Filtre sú jeden chip: videá ako default, triedenie, dátum, min MB a vylučujúce slová, ktoré vidíš a vieš zmazať. Typ, náhľad, min/max súborov, max MB a checkbox „všetky stránky“ sú v chipe zbytočné, ostanú schované.

Karta je náhľad. Jeden riadok názvu, jeden riadok meta: dĺžka alebo počet, veľkosť, jeden dátum, zdroj. Checkbox v rohu, stav importu (fronta / beží / hotovo / chyba) v druhom rohu. Žiadne pille, žiadny druhý dátum, žiadny pás ukážok v toku. Ukážky nech sú hover filmstrip na náhľade, HD scrub z Album Viewera nech ostane tam.

Klik na video nahrá pravý dok, asi 40 % šírky, mriežka ostane. Ďalšie a predchádzajúce idú po viditeľnom zozname. Súborový modal hubu aj overlay albumu sú tento istý dok. Šípky posúvajú, Import je pod názvom. Pod 1100 px je dok spodný sheet, nie tretia clona.

Klik na album vymení mriežku na mieste a breadcrumb povie, kde si. Ten istý NDJSON fill, ktorý Album Viewer už má, kreslí túto mriežku. Jeden stavový riadok: počty, `meta hotové/celkom`, HD, `+100`, Auto. Spoločný album je tá istá mriežka plus chip zdroja, nie nová obrazovka. HD 2×2 / 1× / vypnúť je jeden prepínač na tom riadku. Celý storyboard sa otvorí v doku. Shift-klik alebo checkbox vyberá. Lišta výberu (Import N, spoločný album, split, zrušiť) sa ukáže, až keď je výber.

Mriežka nech je `auto-fill, minmax(220px, 1fr)`, nie natvrdo 5 stĺpcov a nie sedem hustôt v toolbare.

### Čo nechať

NDJSON a fetch-job albumov: listing hneď, meta sa dopisuje, veľké albumy po dávkach. HD storyboard a scrub. Spoločný album. Stavy importu vrátane uložených jobov v `localStorage`. Cache Balbums stránky a návrat starej kópie pri výpadku. Oddelenie latest poradia od rankingu podľa zhliadnutí, ktoré je na serveri už spravené (`feed_rank`).

### Čo nedať

Novú knižnicu. Štvrtý overlay. Pulzujúce logo a zdvih karty. Tlačidlo, ktoré jedným klikom importuje celú stránku albumov. Skrytý exclude reťazec. Dva prehrávače.

Kým sa UI nespraví, najmenšia zmena, ktorá prestane vyzerať ako prázdny hub: tab Najnovšie a Trending nech pri otvorení zavolajú API bez textu v poli a nech výsledky nemažú, kým nová odpoveď nepríde. Vylučujúce slová nech sú aspoň viditeľný riadok. Hlavičkové „Načítať meta (95)“ nech nespúšťa enrich na karty, ktoré už majú náhľad a počet.
