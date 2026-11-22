# Nexus Live Annotator

Samostatné Chrome rozšírenie na anotovanie ľubovoľnej HTTP/HTTPS stránky.

## Inštalácia

1. Otvor `chrome://extensions`.
2. Zapni **Režim pre vývojárov**.
3. Klikni **Načítať rozbalené**.
4. Vyber priečinok `extensions/nexus-live-annotator`.

## Použitie

- Klikni na ikonu rozšírenia alebo stlač `Alt+Shift+A`.
- Vyber nástroj: prvok, pero, zvýrazňovač, šípka, rámik alebo poznámka.
- Do poľa **Čo treba zmeniť?** napíš zadanie.
- Klikni na stránku alebo kresli.
- Stlač **Uložiť + kopírovať pre ChatGPT**.

Rozšírenie:

- uloží anotovaný PNG do `Downloads/Nexus Annotations`,
- uloží vedľa neho JSON s URL, textami, vybranými prvkami a pozíciami,
- skopíruje anotovaný PNG do schránky a overí, že nejde o starý obsah.

Ak Chrome odmietne tiché kopírovanie, otvorí sa malý náhľad. Klikni v ňom
**Skopírovať nový PNG**. Až po zelenom potvrdení klikni do ChatGPT panela,
stlač `Ctrl+V` a `Enter`.

## Obmedzenie

Chrome nedovoľuje jednému rozšíreniu spoľahlivo ovládať textové pole alebo
side panel iného rozšírenia. Preto posledné kliknutie do ChatGPT panela,
`Ctrl+V` a `Enter` zostáva manuálne.

Ani Codex desktop chat sa automaticky neodosiela. PNG v schránke nie je
potvrdenie doručenia do chatu. JSON treba priložiť samostatne, ak má agent dostať
všetky anotácie a selektory; karta na obrázku zobrazuje najviac šesť poznámok.

## Oprávnenie screenshotu

Anotátor otvor ikonou rozšírenia alebo skratkou zaregistrovanou v
`chrome://extensions/shortcuts`. Skratku obsluhuje iba Chrome, aby získala
oprávnenie `activeTab`. Ak uloženie hlási chýbajúce oprávnenie, klikni na ikonu
rozšírenia a skús uloženie znova. Počas zachytávania neprepínaj karty.

Verzia 0.1.2 odstraňuje druhú obsluhu skratky na stránke a kontroluje, že
screenshot patrí karte, ktorá ho vyžiadala.

## Výrez s poznámkami (0.1.3)

1. Otvor anotátor ikonou rozšírenia.
2. Vyber **✂ Výrez** a potiahni obdĺžnik okolo požadovanej oblasti.
3. Napíš zadanie. Voliteľne označ miesto nástrojom **● Poznámka**, šípkou alebo rámikom.
4. Klikni **Kopírovať výrez**, potom vlož obrázok do chatu cez **Ctrl+V**.

PNG obsahuje vybranú oblasť s anotáciami a čitateľný blok zadania, URL a všetkých
textových poznámok pod obrázkom. Malý výrez dostane minimálnu šírku 320 px pre
čitateľný text; samotná oblasť sa nezväčšuje. PNG aj JSON sa tiež uložia.
Výber musí mať aspoň 20 × 20 px. Nové potiahnutie nahradí výrez; Vymazať ho zruší.
