# Nexus Lens Bridge

Lokálna Manifest V3 extension pre tlačidlá **Browser Assist** a **Na pozadí**
v Related Search. Extension neprenáša API kľúče a pracuje iba s krátkodobým
jednorazovým job tokenom vytvoreným Nexusom.

## Inštalácia

1. Otvor `chrome://extensions`.
2. Zapni **Developer mode**.
3. Klikni **Load unpacked**.
4. Vyber priečinok `extensions/nexus-lens-bridge`.
5. Pri aktualizácii extension klikni na jej tlačidlo **Obnoviť/Reload** a potom
   obnov otvorený Nexus dashboard.

V Related Search sa následne zobrazí zelený stav **Lens Bridge pripojený**.

## Režimy

- **Browser Assist** otvorí normálny Lens tab. Ak Google zmení upload UI,
  dokonči upload ručne; extension sa ešte pokúsi zozbierať viditeľné výsledky.
- **Na pozadí** vytvorí neaktívny tab. Pri 403 alebo captcha ho extension
  aktivuje a čaká na používateľa. Captcha ani ochrany Google neobchádza.

Verzia 1.1 podporuje aj nový Google upload tok na `www.google.com/?olud`.

Google často mení DOM Lens stránky. Generic parser preto zbiera iba externé
HTTP(S) odkazy a Nexus ich následne normalizuje a deduplikuje na serveri.
