# Vertical Multi Player

Samostatné Chrome rozšírenie pre maximálne tri paralelné video streamy.

- Klikni na ikonu rozšírenia a otvor prehrávač.
- Vlož 1 až 3 priame `http://` alebo `https://` URL do poľa, každú na vlastný riadok. Vloženie URL ich načíta automaticky; `Ctrl+Enter` funguje tiež.
- Alternatívne pretiahni video súbory alebo URL na drop zónu.
- MP4/WebM/MOV idú priamo cez HTML video; HLS `.m3u8` cez pribalený hls.js.
- Streamy sa nikam neimportujú a ani neukladajú. Pre prehrávanie chránenej stránky musí byť URL priamo prehrateľná v Chrome; DRM, expirovaná URL, potrebný cookie/referrer alebo serverové CORS pravidlá môžu prehrávanie zablokovať.

`Export local` je dostupný iba pri lokálnych súboroch, nie pri URL streamoch.
