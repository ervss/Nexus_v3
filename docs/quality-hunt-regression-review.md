# Rozbor regresie „iné verzie“ – 27. 9. 2026

Požiadavka používateľa: relevantné alternatívy konkrétneho klipu, minimálne päť rôznych zdrojov. Samotné odporúčania, zhodná dĺžka alebo iný klip rovnakého tvorcu túto podmienku nespĺňajú.

## Zistené medzery a opravy

1. Predchádzajúca oprava samostatného Universal Importera nemierila na panel zo snímky. Ten patrí Nexus Gallery. Terajšie opravy sa týkajú jeho panelu aj spoločného backendu.
2. Podobná dĺžka vytvárala nepotvrdené karty aj bez identity klipu. Takéto karty sú vyradené. Zhodné meno tvorcu sa eviduje oddelene od scény; iný opis scény nie je dôkazom alternatívy.
3. Názov obsahoval značky platforiem. Dotaz bol príliš úzky a nové prahy odmietali relevantné kratšie názvy. Parser odstraňuje značky a identifikuje meno; hľadanie súbežne skúša tri varianty dotazu.
4. Rýchle hľadanie vynechávalo široké hľadanie a CamWhores nebol medzi hlavnými zdrojmi. Širšie zdroje sa teraz skúšajú aj v rýchlom režime pri menej než piatich potvrdených doménach.
5. Pri niektorých weboch nesúvisiace odporúčania zabránili fallback vyhľadávaniu. Voliteľný filter identity odstraňuje tieto odporúčania pred rozhodnutím o fallbacku. Ostatné vyhľadávacie workflow zachovávajú svoje predvolené správanie.
6. CamWhores používal nesprávny vyhľadávací endpoint. Kanonický `/search/sophiadreams/` vrátil 50 titulov vrátane presného klipu, ktorý chybný adaptér zahodil aj pre príznak súkromného videa. Pri hľadaní identity sa súkromné výsledky zachovajú s jasným označením prístupu; bežné vyhľadávanie ostáva verejné. Pomalé dopĺňanie kvality sa presunulo do samostatnej fázy. Eporner fallback obsahoval nedefinovanú premennú `loop`; používa `asyncio.to_thread`.
7. Čiastočná diagnostika nezachovávala prázdne výsledky a chyby. Teraz ich zachová aj pri vonkajšom timeoute.
8. Snímka prehrávača vytlačila pôvodný náhľad z lokálneho porovnávania. Používajú sa oba dostupné referenčné obrazy.
9. Panel čakal na metadáta prehrávača. Pri viditeľnom hlavnom videu sa teraz zobrazí aj počas ich načítavania; chýbajúce merania sa nevymýšľajú.
10. Viaceré domény boli skryté pod zrkadlami. Panel zobrazuje zdroje jednotlivo a počíta nezávislé domény voči cieľu päť. Jazykové či mobilné subdomény nezvyšujú počet. Ukončené hľadanie s menej než piatimi doménami hlási nesplnený cieľ.
11. Google chyba obsahovala URL s API kľúčom. Diagnostika teraz uvádza iba bezpečný HTTP stav.

## Overenie a hranice výsledku

- 46 Python unittest testov a 6 Node testov prehrávania prešli; oba zmenené JavaScript súbory prešli syntax kontrolou.
- Regresné testy používajú názov zo snímky. Vyraďujú tri pôvodné nesúvisiace výsledky aj iné scény rovnakého tvorcu. Kópia s menom oddeleným medzerou a správnou dĺžkou sa potvrdí.
- Skutočný Chromium načítal Nexus Gallery 2.40.2, otvoril pôvodnú stránku a spustil hľadanie kliknutím. Toto nie je simulovaný UI náhľad.
- Opravený CamWhores adaptér našiel presný titul s dĺžkou 4:50: `https://www.camwhores.tv/videos/9557776/sophiadreams-onlyfans-pussy-dildo-fuck/`. Je súkromný, prístup/prehratie nebolo potvrdené. Google vracal HTTP 429. Obrazové hľadanie z pôvodného náhľadu vrátilo 16 nerelevantných odkazov; podľa náhľadu presného CamWhores klipu sa našli aj jeho zrkadlá `.stream`, `.video`, `.guru`. Všetky patria k jednému zdroju, nezvyšujú počet nezávislých zdrojov na päť.
- Kompletný živý beh po oprave našiel jednu potvrdenú doménu (camwhores.tv), bez preukázanej vyššej kvality. Päť relevantných nezávislých zdrojov sa zatiaľ nepodarilo preukázať. Akceptačná požiadavka preto nie je splnená. Opravené filtre a prechádzajúce testy nepreukazujú úspešný výsledok vyhľadávania.

Predchádzajúcich približne desať výsledkov používateľ opisuje ako funkčných. Bez ich konkrétnych URL a pôvodného vstupného obrazu nemožno spätne porovnať, ktoré pravé zhody sa stratili a ktoré boli podobné scény. Nemožno preto tvrdiť, že všetky príčiny straty týchto výsledkov boli odstránené.
