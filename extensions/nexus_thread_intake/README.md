# Nexus Thread Intake

Nový, samostatný Chrome extension pre rýchly tok:

`thread -> Link Tester -> vybrané funkčné výsledky -> Gallery Grid`

## Inštalácia

1. V Chrome otvor `chrome://extensions`.
2. Zapni **Developer mode**.
3. Klikni **Load unpacked**.
4. Vyber tento priečinok: `extensions/nexus_thread_intake`.
5. Po aktualizácii klikni v `chrome://extensions` na **Reload** pri Nexus Thread Intake a reštartuj Nexus server, ak sa menil backend.

## Použitie

1. Na threade Simpcity klikni plávajúce tlačidlo **T** vpravo hore. Automaticky sa načítajú prvé tri strany (alebo menej, ak ich thread nemá).
2. Odovzdajú sa len priame videá a známe podporované zdroje. Obrázky a neznáme weby (napr. Goonbox) Intake preskočí.
3. Tester spustí overenie a do galérie importuje úspešné, neduplicitné výsledky s dostupnými metadátami.
4. Ak niektorú stranu nebolo možné načítať, automatický prenos sa zastaví a v Intake zostane hlásenie na kontrolu. Pre ručný výber použi ikonu rozšírenia **Thread → Tester**.
5. V ručnom toku môžeš zvoliť stránku, rozsah alebo celý thread, vybrať odkazy a kliknúť **Overiť v Testeri**. Výber možno uložiť cez **Stiahnuť JSON**.

Pôvodný `nexus_thread_scraper` tento extension nepoužíva ani nemení.

## Novinky v sledovaných threadoch

Na `https://simpcity.cr/watched/threads` klikni **Novinky v sledovaných** a potom
**Skontrolovať nové**. Rozšírenie prejde všetky stránky zoznamu, pri prvom skene
z každého threadu načíta iba jeho poslednú stranu a pri ďalších skenoch zbiera
príspevky od posledného úspešne uloženého príspevku. Stav je nezávislý od
označenia „prečítané“ na fóre a zostáva v `chrome.storage.local`.

Galéria zoskupuje odkazy podľa threadu. Filter threadu, zdroja a typu nemení
výber. Karta zobrazuje náhľad z príspevku, ak existuje, a odkazy na všetky
príspevky, kde sa ten istý zdroj našiel. **Stop** preruší požiadavky; dokončené
thready zostanú uložené a ďalší sken pokračuje z ich kurzorov. Neúspešné
thready ostanú na opakovanie. Sken je ručný a import nespúšťa. Zatvorenie
panelu sken neskončí; priebeh zostane viditeľný na jeho tlačidle.

Označ karty a klikni **Načítať údaje vybraných**. Rozšírenie sa cez zvolenú
Nexus inštanciu opýta priamo podporovaných zdrojov na trvanie, veľkosť,
rozlíšenie a dátum uploadu. Neznáme údaje označí ako nezistené; hodnoty
nevypočítava z dátumu príspevku. Metadáta sa ukladajú ku karte, pričom
prehrávací odkaz sa neukladá, pretože môže expirovať. Pri videu klikni
**Play**: otvorí sa prehrávač priamo nad galériou, ktorý si čerstvo načíta
stream. Zatvorenie prehrávača zastaví video. Pre chránené MP4 a HLS používa
lokálny Nexus proxy. Zdroj bez prehrateľného streamu zobrazí chybu a ponúkne
odkaz na pôvodný web.

Označené odkazy odošli cez **Poslať vybrané do Testera**. Vyber port 8000,
8001 alebo 8002; rozšírenie ho automaticky nemení. Otvorí jednu Tester
reláciu s permalinkmi a názvami pôvodných threadov, spustí overenie odkazov
a vyberie funkčné výsledky. Import do knižnice vyžaduje samostatnú akciu
v Testeri. Jedna relácia prijme najviac 500 označených odkazov.

Po zmene rozšírenia klikni **Reload** pri Nexus Thread Intake v
`chrome://extensions` a obnov stránku Watched Threads. Keďže sa mení aj
Nexus backend a Tester, reštartuj konkrétnu Nexus inštanciu, ak nepoužíva
automatické načítanie zmien.

## Vyhľadávanie (Search → Tester)

Na `https://simpcity.cr/search/...`, `https://simpcity.cr/watched/threads`, `https://simpcity.cr/tags/...` aj `https://simpcity.cr/forums/...` sa vpravo dole zobrazí tlačidlo **Nexus Search**. Na sledovaných témach pracuje s ich zoznamom; existujúce **Novinky v sledovaných** ostávajú samostatné.
Každý výsledok (thread) dostane checkbox (selektor) vpravo hore.

Panel:
- **Tagy / slová** – hľadá v názve, snippete, tagoch a štítkoch. Čiarka oddeľuje viac výrazov, `-slovo` vylúči. Režim *všetky / aspoň jeden*. **Iba zhodné** skryje ostatné, inak sa zhody len zvýraznia.
- **Zoradiť** – relevantnosť, dátum, odpovede, názov, zhodné hore, počet liniek. Filtre: min. odpovedí, thready od dátumu, iba vybrané, iba s odkazmi.
- **Načítať ďalšie** – podľa voľby pridá ďalšiu stranu, 5, 10 alebo všetky zostávajúce strany do jedného zoznamu (max 60 strán). Opakované načítanie pokračuje ďalšou stranou.
- **Skenovať vybrané** – prejde všetky strany vybraných threadov a vyzbiera podporované linky na import. Pole *Príspevky od dátumu* skenuje thready od posledných strán späť a zastaví sa pri staršom obsahu. *Max strán / thread* obmedzí hĺbku.
- **Poslať do Testera** – po výbere zdroja a portu otvorí Tester reláciu (po 500 odkazov, max 4 relácie). Import sa nespúšťa automaticky.

Po zmene klikni **Reload** pri rozšírení v `chrome://extensions` a obnov stránku vyhľadávania / tagu.
