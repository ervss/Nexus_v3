# Erome (erome.com) podpora

Funguje na profiloch (`/<user>?t=posts`), vyhľadávaní a explore stránkach so zoznamom albumov (`#albums .album`). Karta = album (post), importuje sa URL `https://www.erome.com/a/<id>`; extraktor v Nexuse si videá z albumu rozbalí sám.

- **Načítanie ďalších strán:** panel → „Načítanie a metadáta“ → počet strán → „+ Načítať ďalšie“. Strany `?page=N` sa pripájajú pod seba, stránkovanie sa synchronizuje.
- **Metadáta albumu** (z `Doplniť chýbajúce` / automaticky): súčet veľkostí videí (HEAD), súčet dĺžok, najvyššia kvalita, dátum z `Last-Modified` súboru. CDN erome vyžaduje Referer, preto sa nastavuje session DNR pravidlom (`declarativeNetRequest`).
- **Filtre:** názov, kvalita, dĺžka, veľkosť, dátum, „Len albumy s videom“ (aktívne aj pri `#onlyvideos=1` v URL, voľba sa pamätá). Radenie: poradie, kvalita, dĺžka, veľkosť, dátum, názov, zhliadnutia, počet videí.
- Testy: `node --test tests/erome_album.test.cjs tests/erome_workbench_filter.test.cjs`.
