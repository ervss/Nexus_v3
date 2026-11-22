# Video Play First 1.2

Rozbalené Chrome rozšírenie. Priečinok ostáva extensions/mp4-play-first pre aktualizáciu pôvodného doplnku.

## Inštalácia alebo aktualizácia

1. Otvor chrome://extensions a zapni Režim pre vývojárov.
2. Klikni Načítať rozbalené a vyber tento priečinok obsahujúci manifest.json.
3. Ak už bolo rozšírenie načítané, klikni Obnoviť. V detailoch povoľ prístup ku všetkým webovým stránkam, ak to Chrome vyžaduje.
4. Znova otvor priamy video odkaz.

Pripni Video Play First v menu skladačky. Popup ponúka Prehrávanie / Sťahovanie. Predvolené je prehrávanie. Režim platí pri nasledujúcom otvorení URL a zachová sa po reštarte Chrome. Prehrávanie začne bez zvuku; zvuk zapni v natívnom prehrávači.

## HLS (.m3u8) v čistom novom tabe

V prehrávacom režime sa otvorenie .m3u8 automaticky presmeruje na samostatný prehrávač rozšírenia. Pri prehrávaní vidíš iba video a jeho ovládače. V popup rozšírenia môžeš vložiť ľubovoľnú HTTP/HTTPS video alebo HLS adresu a kliknúť **Otvoriť v novom tabe**. Podporované sú master playlisty, varianty a segmenty s relatívnymi URL. Query parametre a podpisy odkazu sa zachovajú.

Neplatný playlist zobrazí HTTP chybu. Platnosť odkazu, podpis, IP a prihlásenie určuje server. Konkrétna dodaná URL dash-nf.eporner.com/na.mp4/master.m3u8 bola 11. 10. 2026 overená: server presmeroval na www.eporner.com a odpovedal HTTP 404. Tento odkaz nie je možné opraviť samotným prehrávačom.

Sťahovací režim pri HLS stiahne **playlist .m3u8**, nie zlúčené MP4 video. Stiahnutie všetkých segmentov do jedného súboru táto verzia neposkytuje.

## Rozsah

- Všetky HTTP a HTTPS domény.
- Prípony: mp4, m4v, webm, ogv, ogg, mov, mkv, avi, mpg, mpeg, 3gp, 3g2, ts, m2ts, flv, wmv. Prípona môže byť aj v parametri URL; veľkosť písmen nerozhoduje.
- Bez prípony funguje odkaz so serverovou hlavičkou Content-Type: video/* alebo application/ogg. Bez prípony a bez správnej hlavičky nemožno spoľahlivo odlíšiť video od iného súboru.
- Opravuje hlavičky vyvolávajúce download a používa natívny prehrávač Chrome. Nezapína autoplay na videách vložených do HTML stránok.
- Načítanie videa riadi Chrome; rozšírenie nesťahuje celý súbor do svojej pamäte.

## Limity

Rozpoznanie prípony nezaručuje podporu formátu. Chrome prehrá len podporované kodeky a kontajnery. AVI, FLV, WMV, MPEG/TS, niektoré MKV/MOV môžu vyžadovať konverziu alebo externý prehrávač. Rozšírenie neprekóduje video. HLS (.m3u8) je podporované cez lokálne pribalenú knižnicu hls.js. DASH (.mpd) zatiaľ nie je zahrnuté.

HTML chybové odpovede a JSON sa nemenia na video. Rozšírenie neobchádza prihlásenie, expiráciu tokenu, DRM ani serverové obmedzenia. Odkazy s HTML atribútom download otvor vložením adresy do nového tabu. file:// a blob: nie sú súčasťou HTTP pravidiel.

## Povolenia a súkromie

Prístup ku všetkým HTTP/HTTPS stránkam je potrebný pre ľubovoľný video server. Obsahový skript skončí na bežných stránkach a pracuje iba s natívnym video dokumentom. Žiadna analytika, externé skripty ani odosielanie histórie. Režim je lokálne pravidlo Chrome.

HLS prehrávač načítava playlist a segmenty z poskytnutej adresy. JavaScript hls.js 1.7.3 je pribalený lokálne (Apache-2.0, licencia vo vendor/LICENSE); za behu sa nenačítava zo žiadneho CDN. Podrobnosti pôvodu sú vo vendor/PROVENANCE.md.

## Overenie 11. 10. 2026

Chrome for Testing 154: skutočný autoplay MP4 aj WebM (960 × 540) z dvoch lokálnych hostov s attachment/octet-stream hlavičkami; URL s veľkými písmenami a tokenom; prípona v query parametri; URL bez prípony s video MIME; HTTPS video z interactive-examples.mdn.mozilla.net. Overené prepnutie na sťahovanie aj návrat na prehrávanie. Vložené video na HTML stránke zostalo pozastavené.

Dôkazy v pracovnom priečinku: artifacts/video-play-first-verification.json a screenshoty artifacts/video-play-first-*.png. Test: scratch/verify-video-global.cjs.

Verzia 1.2: v Chrome for Testing 154 overené skutočné HLS prehrávanie (960 × 540) po automatickom presmerovaní .m3u8, aj URL bez prípony so správnym HLS MIME. Overená cesta /na.mp4/master.m3u8, master/variant/relatívne TS segmenty, podpisové query parametre, otvorenie tlačidlom z popupu do nového tabu, zobrazenie HTTP 404 a sťahovací režim playlistu. Bez CSP alebo JavaScript chýb. Po zmene znovu prešiel test MP4 a WebM.

Dôkazy: artifacts/hls-player-verification.json a artifacts/hls-player-*.png. Test: scratch/verify-hls-player.cjs.
