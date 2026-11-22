# HotContainer Profile Handoff

Malé Chrome rozšírenie pre kratší, bežný tok medzi podporovaným profilom na
XVideos a červenou kartou HotContaineru.

## Čo robí

1. Na profile, kanáli, tvorcovi alebo pornstar profile pridá tlačidlo **HotContainer galéria**.
2. V pozadí otvorí tvoju normálnu červenú kartu, predvyplní URL a spustí jej
   bežné tlačidlo **Zoznam videí**.
3. Na pôvodnej karte ukáže široké plávajúce okno s náhľadmi z HotContaineru.
   Ak má profil viac stránok galérie, rozšírenie ich samo prekliká všetky
   a spojí do jedného zoznamu (ukazovateľ priebehu "Načítavam stránku X/Y…"
   počas toho beží) — netreba nič listovať ručne. Nad mriežkou je textové
   pole na filtrovanie podľa kľúčového slova v názve videa, funguje okamžite
   bez ďalšieho načítavania (filtruje sa už stiahnutý zoznam). Kliknutie na
   náhľad spustí jeho bežné spracovanie a zmení jeho stav na **Pracujem…**.
   Poradie **Najnovšie** sa zbiera z karty HotContaineru **Novo**, vždy od
   prvej stránky. Staršie cache zozbierané z **Visto recentemente** sa
   automaticky načítajú nanovo.
   Popup obsahuje iba **PREMIUM** videá. Rozšírenie zoberie názvy z filtra
   PREMIUM a v galérii HotContaineru páruje názov, ID alebo identitu náhľadu.
   PREMIUM môže mať súčasne atribúty MEMBERSHIP/PPV; rozhoduje dostupnosť
   PREMIUM. Rovnaká prípona obrázka neznamená rovnaké video.
   Pomocná karta sa po kontrole zatvorí. Pri jej chybe sa skúsia aj potvrdené
   karty z otvoreného profilu; čiastočný výsledok sa označí a neuloží ako
   úplná cache. Pri nulovej zhode hlásenie obsahuje počty z oboch zdrojov.
   Karty zobrazujú aj dátum pridania a dĺžku zo spárovaného profilu.
   Relatívne dátumy (napr. „11 months ago“) sa zachovajú; presný dátum sa
   neodhaduje. Chýbajúci údaj je označený pomlčkou.
4. Tlačidlo **Moje videá** v hlavičke panelu načíta aktuálne vytvorené položky
   a pri každej ponúkne **Sidecar**, **Stiahnuť** alebo **Nexus**. Sidecar
   dostane iba dočasný oficiálny odkaz, ktorý HotContainer už pripravil pre
   svoje bežné tlačidlo stiahnutia. **Nexus** (jednotlivo alebo hromadne cez
   "Importovať do Nexusu" v hlavičke) pošle video do Nexus dashboardu A HNEĎ
   spustí stiahnutie na disk — HotContainer odkazy majú token platný len
   približne 1-3 hodiny, takže uloženie samotného odkazu na neskôr by sa
   časom rozbilo; okamžité stiahnutie video prevedie na trvalý lokálny súbor
   skôr, než token vyprší.
5. Okno je možné ťahať za jeho hlavičku, zmeniť jeho veľkosť úchytom v pravom
   dolnom rohu a minimalizovať ho bez straty aktuálneho zoznamu.

Rozšírenie nečíta, neukladá ani neexportuje cookies ani neobchádza CAPTCHA.
HotContainer používa tvoje existujúce prihlásenie len tak, ako keď stránku
otvoríš ručne. Na tlačidlo **Sidecar** musí byť načítané aj rozšírenie
Vertical Video Sidecar; inak panel zrozumiteľne oznámi, že mu chýba spojenie.

## Inštalácia

1. Otvor `chrome://extensions`.
2. Zapni **Režim pre vývojárov**.
3. Klikni **Načítať rozbalené** a vyber tento priečinok.
4. Obnov otvorené karty XVideos a HotContainer.

## Použitie

Na podporovanom profile klikni **HotContainer galéria**. Pri prvom použití
vizuálne over, že sa galéria zobrazuje z tvojho aktívneho HotContainer účtu.

## Sťahovanie HLS (0.2.4)

**Stiahnuť** odošle zvolenú kvalitu do IDM cez lokálny Nexus HLS → MP4 most.
Nekopíruje iba `.m3u8` playlist do schránky. Ak IDM prevzatie nepotvrdí,
rozšírenie spustí sťahovanie MP4 cez Chrome. Nexus musí zostať spustený
počas celého sťahovania a musí mať dostupný FFmpeg. Most spojí segmenty
bez znižovania kvality. Úspešné odovzdanie sťahovania neznamená dokončený súbor.
Pri expirovanom odkaze obnov **Moje videá** a vytvor nový odkaz.

Po aktualizácii obnov rozšírenie v `chrome://extensions` (pribudlo oprávnenie
`downloads`) a obnov karty XVideos/HotContainer.

## Priamy odkaz v Chrome (0.2.5)

Otvorenie HTTPS `.m3u8` odkazu na `*.xvideos-cdn.com` v karte automaticky
otvorí stránku rozšírenia s tlačidlom **Stiahnuť MP4**. Podpísaný odkaz
vrátane parametrov zostane zachovaný. Po kliknutí sa použije rovnaký Nexus
most a IDM/Chrome download ako v Mojich videách. Nexus a FFmpeg sú potrebné
aj pri tomto spôsobe sťahovania.

Presmerovanie sa týka iba otvorenia odkazu v hlavnej karte. HLS požiadavky
prehrávačov a načítavanie segmentov sa nepresmerujú. Oprávnenie
`declarativeNetRequest` umožňuje zachytiť otvorenie playlistu ešte predtým,
než ho Chrome uloží ako textový súbor. Po aktualizácii obnov rozšírenie.

## Kopírovanie priamej URL (0.2.6)

Tlačidlo **Kopírovať URL** pri videu kopíruje priamy odkaz aktuálne zvolenej
kvality vrátane podpisu a parametrov. Dostupné je aj na stránke priameho
HLS odkazu. Kopírovanie nespúšťa sťahovanie a nevyžaduje spustený Nexus.
