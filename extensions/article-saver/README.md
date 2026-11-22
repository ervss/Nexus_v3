# Article Saver — Chrome + Python

Uloží **verejne dostupný obsah** webového článku ako `.md` súbor v `C:\Users\<používateľ>\Documents\clanky`.
Neposkytuje prístup k platenému obsahu, ktorý server neposkytuje.

## Inštalácia (Windows)

1. Nainštaluj Python 3 a Python Launcher (`py`) z python.org.
2. Rozbaľ archív napríklad do `C:\Users\Peto\Documents\article-saver\`.
3. Otvor Chrome → `chrome://extensions/` → zapni Developer mode → **Load unpacked** → vyber **extension**.
4. V karte rozšírenia si skopíruj jeho **ID** (32 znakov). ID môže byť odlišné od `hcgcbcnbipgomadfbkigffpkgangbiljh`.
5. Otvor PowerShell v rozbalenom priečinku a zadaj:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

   Následne vlož ID rozšírenia. Inštalátor nainštaluje Trafilaturu, vygeneruje manifest native hostu s aktuálnou cestou a zaregistruje ho v HKCU.
6. Reštartuj Chrome. Otvor článok → ikona **Article Saver** → **Uložiť článok ako Markdown**.
7. Uložený súbor nájdeš v priečinku `Documents\clanky`. Otvor ho cez Prieskumník Windows.

## Dôležité

- Načítanie `file:///` URL priamo cez Chrome rozšírenie býva zakázané; rozšírenie preto zobrazuje cestu k uloženému súboru.
- Google Chrome Native Messaging na Windowse spúšťa `.bat` launcher, nie `.py` priamo.
- ID rozšírenia v priloženom vzorovom manifeste native hostu je z pôvodného zadania. Inštalátor ho prepíše podľa skutočného ID.
- `register_host.reg` je len vzor pre cestu `C:\Users\Peto\Documents\article-saver`; odporúča sa **install.ps1**, ktorý používa skutočnú cestu.
- Rozšírenie odovzdá hostu HTML, ktoré už načítal prehliadač. Vďaka tomu funguje aj na weboch,
  ktoré samostatné automatické HTTP požiadavky blokujú (napríklad odpoveďou 403).
- Ukladá sa iba obsah, ktorý je skutočne načítaný v otvorenej karte; rozšírenie neobchádza paywall.
