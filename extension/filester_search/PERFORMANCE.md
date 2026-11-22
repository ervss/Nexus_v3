# Filester 13.1: meranie 2026-09-30

## Zistenia zo skutočnej siete

Malý probe z rovnakého počítača a Python prostredia:

| Cesta | Odozva | Výsledok |
|---|---:|---|
| Filester priečinok, prvý GET | 0,860 s | HTTP 200 |
| Ten istý priečinok, keep-alive | 0,765 s | HTTP 200 |
| urlscan, malý vyhľadávací GET | 0,436 s | HTTP 200, zostávalo 29 z 30 požiadaviek |
| Wayback CDX, limit 1 | 12,381 s | ReadTimeout |

Probe nepreukázal blokovanie IP na Filesteri. Nie je to dôkaz neprítomnosti
dočasných limitov ani test prihlásenej Chrome session alebo prenosu videa.
Pôvodná pipeline navyše zbierala zdroje postupne, dovolila až 35 sekúnd
čakania na každú discovery požiadavku a overovala priečinky sériovo s pauzou
0,3 sekundy. Sieťové chyby považovala za DEAD a následne ich trvalo označovala
ako overené. V dashboardovej ceste sa nepoužíval adaptívny crawler limiter.

## Kontrolované pred/po

benchmark_validation.py, šesť identických úspešných odpovedí po 800 ms,
rovnaká databáza a MockTransport, bez skutočných externých požiadaviek:

| Scenár | Pôvodný kód | Nový kód |
|---|---:|---:|
| Prvé overenie 6 priečinkov | 6,661 s | 4,166 s |
| Opakovanie 6 priečinkov | 6,654 s | 0,029 s z diskovej cache |

Prvé overenie je približne o 37 % kratšie. Výsledok opakovania demonštruje
cache: benchmark úmyselne znovu nastaví kandidátov ako neoverených.
Bežná prevádzka nemusí dosiahnuť tento pomer; závisí od latencie, cache,
limitov vzdialeného servera a objemu kandidátov.

## Reálny test dashboardu

Úloha 1e2e89d40005, tri overenia existujúceho poolu, Wayback + urlscan:

- Prvý priečinok s obsahom: 1,012 s.
- Overenie troch priečinkov: 1,671 s, všetky HTTP 200, bez validation errors.
- Discovery: 20,548 s; celá úloha 20,550 s.
- Wayback znovu zaznamenal dva sieťové timeouty a ochrannú prestávku.
- urlscan odpovedal úspešne, ale zber ako celok dosiahol limit 20 sekúnd.
- Výsledky overenia existujúceho poolu sa uložili pred dokončením discovery.

Po reštarte novej služby sa tri skutočné, predtým overené priečinky načítali
cez rovnaký HTTP guard z diskovej cache za 0,0076 s. Telemetria potvrdila
0 nových externých požiadaviek. Tento čas nezahŕňa vytvorenie HTTP klienta.

Pri tomto teste sa ukázala potreba zachovania čiastočných kandidátov zo zdroja
pri dosiahnutí časového limitu; tá bola následne doplnená a overená
deterministickým testom.

## Overenie

- test_network.py: cache/deduplikácia, 304, auth izolácia, Retry-After,
  cooldown po reštarte, spoločný limit domén, quota reset, timeout != DEAD,
  zachovanie pending kandidátov a čiastočných výsledkov pri source deadline.
- test_bridge.py: ukladanie, trvalá história, samostatná úloha, ochrana pred
  druhým štartom, výsledky úlohy, open-slot a network endpoint.
- test_background.cjs: uložený Chrome front, dávky, obnova po reštarte workeru,
  lokálne povolenie pred každou kartou, skupiny, pozastavenie a zrušenie.
- Dashboard bol reálne preklikaný v zabudovanom prehliadači; Chrome nie je
  pripojený na automatické ovládanie, takže živé skupiny/otváranie Chrome
  zostávajú neoverené mimo simulácie Chrome API.
