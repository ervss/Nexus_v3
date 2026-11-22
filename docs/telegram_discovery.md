# Telegram Discovery

V galérii otvorte **Telegram Discovery**, zadajte tému alebo verejné kanály,
vyberte dátum, limit nových pripojení a odstup v sekundách a stlačte **Hľadať a joinúť**.
Kanály sa pripájajú k už autorizovanému Telegram účtu; existujúce členstvo sa
nepočíta ako nový join. Podporované sú iba verejné @username a odkazy t.me.
Dátum je vrátane zvoleného dňa od 00:00 UTC. Ukladajú sa iba metadáta videí,
nie samotné súbory, a sú vyhľadateľné v Telegram katalógu Quantum Search.
Vyhľadávanie kanálov podľa témy nie je vyhľadávanie jednotlivých príspevkov.

TGStat môže webové požiadavky zablokovať alebo vyžadovať prihlásenie; chyba je
zobrazená v paneli. Voliteľne nastavte `TGSTAT_TOKEN` pre oficiálne TGStat API
(platený prístup podľa tarify TGStat) a `TGSTAT_COUNTRY` (predvolene `ru`,
čo obmedzuje výsledky na danú geografiu). Bez tokenu sa aplikácia pokúsi
prečítať verejnú webovú stránku; jej dostupnosť a formát nie sú zaručené.
Manuálne kanály možno použiť aj bez TGStat. Discovery neobchádza ochranu služby.

Jedna úloha beží naraz. Stav, zoznam a kurzor sa ukladajú do databázy; pri
reštarte servera aktívna úloha pokračuje. Po chybe možno použiť **Pokračovať**.
Stránka videí a kurzor sa ukladajú v jednej transakcii. Čakanie na FloodWait
sa zaznamená a prežije reštart. Limit je konzervatívny: počíta aj neúspešné
pokusy o nový join, aby sa neprekročil po prerušení. TGStat vyhľadáva podľa
názvov/tém kanálov; žiadny katalóg nezaručuje pokrytie všetkých kanálov.

API vyžaduje prihlásenú Nexus session:
`POST /api/telegram/discover` prijíma `keywords`, `date_from` (YYYY-MM-DD),
`max_joins`, `delay`, `manual_channels` a voliteľne `resume`; stav vracia
`GET /api/telegram/discover/status`. Rovnaké cesty sú dostupné aj pod `/api/v1`.
