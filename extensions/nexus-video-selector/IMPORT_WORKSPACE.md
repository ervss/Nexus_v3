# Import workspace pre xHamster

Panel je súčasťou rozšírenia **Nexus Video Card Selector Fresh_v2**. Po aktualizácii súborov obnov rozšírenie v `chrome://extensions` a potom obnov kartu stránky. Nový panel sa otvára aj v prípade, že pôvodný univerzálny panel bol predtým skrytý. Zbalenie ponechá viditeľné tlačidlo na jeho opätovné otvorenie.

## Ovládanie

- Keyword v názve, viacero kvalít súčasne, dĺžka od/do v minútach, veľkosť od/do v MB, dátum publikovania od/do.
- Neznáme hodnoty sú pri aktívnom rozsahu vyradené; voľba „Ponechať aj karty s neznámymi metadátami“ ich môže zahrnúť. Neplatný rozsah má vysvetlenie.
- Radenie podľa pôvodného poradia, kvality, dĺžky, veľkosti, dátumu alebo názvu; neznáme hodnoty sú na konci v oboch smeroch. Samostatné sekcie stránky sa pri radení nezlučujú.
- „Skryť nevyhovujúce“ a „Skryť nevybrané“ fungujú nezávisle. Pri vypnutí prvého prepínača zostanú nevyhovujúce karty stlmené.
- Výber vyhovujúcich, invertovanie vyhovujúcich, zrušenie výberu. Filtre nemenia existujúci výber. Panel upozorní na vybrané karty mimo filtrov.
- Import vybraných zahŕňa aj vybrané karty mimo filtra; import vyhovujúcich sleduje filtre; import všetkých zahŕňa všetky aktuálne načítané karty. Každá akcia uvádza počet unikátnych URL.
- Zvolený port je pevný cieľ. Pri nedostupnosti alebo nepotvrdenom výsledku sa výber zachová. Odznačia sa iba položky potvrdené serverom ako importované, duplicitné alebo pripojené ako mirror.
- Import uchováva adresu detailu videa. Dátum publikovania sa posiela do poľa `upload_date`.
- Doplnenie chýbajúcich metadát sleduje kvalitu, dĺžku, veľkosť aj dátum. Obnovenie vybraných vynúti nové načítanie; známe zamknuté položky sa preskočia. Fetch používa existujúcu frontu so štyrmi súbežnými požiadavkami.
- Na detaile videa sa ďalšie bloky načítajú cez natívne tlačidlo súvisiacich videí. Na zozname sa ďalšia stránka načíta podľa odkazu „next“ a karty sa zostavia z dát stránky, nie zo sivých placeholderov. Zastavenie ukončí ďalšie kroky po aktuálnom požiadavku / bloku; maximum je 50 krokov.

## Overenie a hranice

`node --test tests/import_workbench.test.cjs tests/turbo_overview.test.cjs`

Lokálna neutrálna stránka: `node tests/import_workbench_fixture.cjs`, potom `http://127.0.0.1:8796`. Používa skutočný súbor panelu a CSS, neutrálne karty a simulované metadáta/import. Neposiela import do databázy ani neotvára externé zdroje.

Na tejto stránke boli v prehliadači vykonané kombinované filtre, výber, radenie, prepínače viditeľnosti, zbalenie/otvorenie, doplnenie metadát, načítanie bloku a simulovaný import. Screenshoty sú v `artifacts/import-workbench/`.

**Integrácia na živom xHamsteri, jeho aktuálne selektory stránkovania a skutočný import z tejto stránky zostávajú neoverené.** Nástroj na prehliadač zablokoval prístup k doméne bezpečnostnou politikou. Lokálne testy túto hranicu nenahrádzajú.
