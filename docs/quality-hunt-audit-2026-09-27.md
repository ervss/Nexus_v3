# Quality Hunt: technický audit a návrh náhrady

Dátum: 27. 9. 2026. Rozsah: aktuálny zdrojový kód, existujúca dokumentácia a klikacia kontrola lokálneho náhľadu v Chrome. Produkčný kód nebol zmenený. Živé vyhľadávanie na externých zdrojoch nebolo spustené; aktuálny počet dostupných kópií ani prehrateľnosť externých výsledkov nie sú overené.

## Záver

Slabé výsledky nemajú jednu preukázanú príčinu. Kód obsahuje úzke miesta v overovaní kandidátov, neúplnú diagnostiku a cache, ktorá môže uchovávať výsledok degradovaného behu ako dokončený. UI potom mieša stav vyhľadávania, potvrdenie identity, dostupnosť a kvalitu do malých kariet. Presný podiel každej príčiny na používateľovom konkrétnom hľadaní vyžaduje záznam daného behu.

## Konkrétne nálezy

| Priorita | Miesto | Zistenie a dôsledok |
|---|---|---|
| P1 | `app/quality_hunt.py:1179–1187`, `:758` | Finálna vetva uloží `done` a hodinovú cache bez ohľadu na chyby či timeouty jednotlivých zdrojov. Ochrana pred cache pri celkovom timeoute nerieši čiastkové zlyhania. Rovnaký kľúč môže vracať slabý výsledok bez nového pokusu. Kľúč zahŕňa aj snímky, preto sa to netýka každého opakovania. |
| P1 | `app/quality_hunt.py:1142–1170` | Metadáta sa dopĺňajú až po predchádzajúcich fázach. Vyberie sa najviac 8/16 kandidátov a len s textovým alebo obrazovým signálom identity. Chýbajúce metadáta tak môžu brániť potvrdeniu kandidátov, ktoré sa do obmedzeného overenia nedostanú. |
| P1 | `app/quality_hunt.py:1323–1349`, `:1353` | Obrazové overovanie spracúva len prvých 24 kandidátov. Výnimky a prekročenie rozpočtu sa potichu ignorujú; extrakcia metadát tiež skrýva chyby. Chýbajúci dôkaz nemožno v UI odlíšiť od neúspešného overenia. |
| P1 | `app/quality_hunt.py:968–1024`, `app/search_engine.py:419–468` | Vonkajší limit hľadania je 18 s, niektoré vnútorné limity sú 18 alebo 20 s. Vonkajší limit preto môže ukončiť zdroj ešte pred jeho vlastným časovým rozpočtom. Partial sink pomáha už dokončeným zdrojom, nie rozpracovaným. |
| P2 | `app/quality_hunt.py:520`, `:633` | Potvrdenie má pevné pravidlá a aj kategória možných zhôd vyžaduje silnú textovú alebo obrazovú evidenciu. Kandidáti bez tejto evidencie úplne zmiznú z používateľského pohľadu. Toto je kompromis presnosti a úplnosti, nie automaticky chyba; chýba však meranie strát a vysvetlenie dôvodov. |
| P2 | `app/quality_hunt.py:570`, `:1000` | Výsledok s kvalitou len z názvu sa správne nepovažuje za merané zlepšenie. Vyhľadávacia vetva však preberá výšku z názvu/štítku; finálny dôkaz závisí na neskoršom extraktore. Počet výsledkov nie je počet overených zlepšení. |
| P2 | `extensions/Nexus_Gallery/universal_importer.js:1502`, `:1849` | Panel a modal majú rozdielnu normalizáciu: panel rozbaľuje zrkadlá, deduplikuje URL a pretrieďuje kategórie; modal vykresľuje pôvodné skupiny. Hrozia rozdielne počty a reprezentácia toho istého výsledku. |
| P2 | `extensions/Nexus_Gallery/universal_importer.css:520–674` | Predvolený panel má stĺpcové rozloženie, menu 280–360 px, náhľady 72 × 54 px a prevažne 11–12 px text. Menu aj panel majú vlastný zvislý overflow. Zväčšenie mení rozmery, nie základnú informačnú architektúru. |

Existujúci `docs/quality-hunt-regression-review.md` opisuje predchádzajúci živý beh s jednou potvrdenou doménou, obmedzením poskytovateľa a bez preukázaného zlepšenia. Je to historický dôkaz z projektu, nie nové meranie tohto auditu.

## Čo potvrdil Chrome

Spustený existujúci `tests/quality_hunt_ui_preview.py`. Cesta: Nájsť iné verzie → dokončené testovacie výsledky → Okno. Zachytený screenshot úzkeho panelu.

Náhľad používa produkčné funkcie/CSS, ale simuluje komunikáciu a nastavuje šírku menu na 340 px. Preto dokazuje problém tejto prezentácie, nie celú geometriu rozšírenia na skutočnom webe. Fixture používa rovnakú URL v troch kategóriách: panel ukázal jednu kartu, modal tri. Tým sa reprodukovala rozdielna normalizácia; nemožno z toho tvrdiť, že každé produkčné hľadanie má duplicitné výsledky. Externé prehratie ani import neboli overené.

## Návrh nového systému pre médiá s oprávneným prístupom

### Jednoznačný dátový model

Každý kandidát má nezávislé stavy: identita (`unverified`, `possible`, `confirmed`, `rejected`), dostupnosť (`unknown`, `playable`, `login_required`, `unavailable`) a kvalita (`unknown`, `estimated`, `measured`). Každý dôkaz nesie pôvod, čas overenia a dôvod. Potvrdená identita neznamená prehrateľnosť; vyššie rozlíšenie neznamená lepší obraz.

Server vracia jeden normalizovaný zoznam s trvalými ID kandidátov. Panel, porovnanie aj export používajú rovnaké selektory a rovnaké počítadlá. Oddeliť počet kandidátov, potvrdených verzií, prehrateľných verzií a nezávislých zdrojov.

### Riadenie úloh a diagnostika

Získavanie kandidátov, overovanie metadát a publikovanie čiastkových výsledkov tvoria samostatné kroky. Každý krok má stav, limit a dôvod ukončenia. Celkový deadline musí nechávať rezervu na uloženie a publikovanie výsledkov. Priebežné výsledky sa nesmú stratiť pri zrušení.

Zdroj vracia explicitne `ok`, `empty`, `timeout`, `rate_limited`, `auth_required`, `parse_error` alebo `unavailable`. Stav úlohy rozlišuje dokončené overenie a čiastočný/degradovaný výsledok. Cache má odlišnú platnosť pre úspech a pre dočasnú chybu; opakovať možno len zlyhané kroky. Používateľ vidí vek cache a má akciu na nové overenie.

Pre každý beh zaznamenať počty pred a po filtroch, dôvody vyradenia, počty neoverených kandidátov, latencie krokov a príčinu ukončenia. Bez tejto bilancie nemožno poctivo určiť, prečo je výsledkov málo.

### Nové rozhranie

Predvolene široké pracovné okno približne 1100–1400 px podľa obrazovky. Horný pás obsahuje pôvodné video, merané parametre a hlavný stav. Stred tvorí responzívna mriežka 2–4 kariet s náhľadom 16:9 a textom minimálne 14 px. Na malom displeji jeden stĺpec.

Karta má názov, zdroj a tri zrozumiteľné údaje: zhoda, dostupnosť, rozlíšenie. Hlavné akcie sú Porovnať a Otvoriť zdroj. Podrobnosti dôkazov sa rozbalia až na požiadanie. Filtre: potvrdené, na overenie, dostupné, merané zlepšenie. Technická diagnostika je samostatná záložka Zdroje.

Porovnanie otvorí pôvodnú a vybranú verziu vedľa seba. Stav prehrávania neovplyvňuje existenciu výsledkov; koniec videa nezatvára okno. Jeden hlavný scroll, stabilné karty pri aktualizáciách, zachovaný výber a klávesnicové ovládanie. Pevný cieľ piatich domén možno ponechať ako voliteľný cieľ pokrytia; úspech pre používateľa sa má vyhodnocovať samostatne podľa overenej použiteľnej verzie.

### Prístup a bezpečnosť

Používať verejné rozhrania a používateľom povolené relácie v rozsahu jeho prístupu. Pri vyčerpaní limitu rešpektovať interval opakovania; pri potrebe prihlásenia zobraziť tento stav. Technická robustnosť nemá závisieť na obchádzaní prihlásenia, DRM alebo ochranných výziev.

Pri serverových URL overiť schému, cieľovú adresu a presmerovania; nastaviť limity veľkosti a času. Existenciu kompletnej ochrany vo všetkých extraktoroch tento audit neoveroval. Tokeny ani podpísané adresy nevypisovať do diagnostiky. Externé odoslanie snímok ponechať oddelené od lokálneho porovnania a jasne označené.

## Postup realizácie a akceptácia

1. Najprv diagnostika, korektné stavy dokončenia a cache. Overiť simuláciou prázdneho zdroja, chyby, pomalého zdroja a zrušenia.
2. Zjednotiť model kandidátov a vykresľovanie panelu/modalu. Rovnaké dáta musia dávať rovnaké počty a stavy.
3. Zaviesť nové pracovné okno a porovnanie. Overiť skutočnou klikacou cestou a screenshotmi na desktope aj úzkej obrazovke.
4. Vyhodnotiť na označenej sade oprávnene dostupných neutrálnych médií: pravá kópia, iný zostrih, rovnaký názov iného videa, neznáme metadáta, nefunkčný zdroj.

Merať presnosť potvrdených zhôd, podiel nájdených známych kópií, počet overených prehrateľných zlepšení, čas prvého použiteľného výsledku a P50/P95. Cieľové hodnoty určiť po baseline; päť domén ani technickú dokonalosť nemožno garantovať bez ohľadu na dostupnosť obsahu.
