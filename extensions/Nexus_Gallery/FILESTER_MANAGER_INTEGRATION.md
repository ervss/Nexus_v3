# Filester Manager Integration - Implementation Guide

## Overview
Implementované: **10. máj 2026**

Pridaná podpora pre import všetkých videí z Filester.me Manager stránky (`https://filester.me/manager`) do Nexus Gallery extension a následný bulk import do Nexus dashboardu.

## Čo bolo implementované

### 1. Filester Manager Scanner (`filester_manager_scanner.js`)
- **Účel**: Content script, ktorý skenuje Filester Manager stránku a extrahuje všetky video súbory zo všetkých folderov
- **Funkcie**:
  - Automatická detekcia Manager stránky
  - Rekurzívne skenovanie všetkých folderov a podfolderov (až do hĺbky 10)
  - Extrahovanie metadát: názov, veľkosť, thumbnail, duration, quality
  - Filtrovanie len video súborov (mp4, mkv, avi, webm, mov, atď.)
  - Vizuálny indikátor na stránke (pravý horný roh)
  - Komunikácia s popup cez Chrome messages API

### 2. Manifest Updates (`manifest.json`)
- Pridaný content script pre všetky Filester Manager URLs:
  - `https://filester.me/manager*`
  - `https://filester.gg/manager*`
  - `https://filester.net/manager*`
  - `https://filester.co/manager*`
  - `https://filester.org/manager*`
  - `https://filester.io/manager*`

### 3. Popup Integration (`popup.js`)
- **Nové funkcie**:
  - `isFilesterManagerUrl(url)` - detekcia Manager stránky
  - `handleFilesterManagerScraping(tab)` - handler pre import z Manager
- **Flow**:
  1. Detekcia Manager stránky
  2. Komunikácia s content scriptom na získanie dát
  3. Mapovanie súborov na video formát
  4. Zobrazenie v gallery UI
  5. Auto-import do Nexus dashboardu (ak zapnuté)

## Ako to použiť

### Pre používateľa:

1. **Otvor Filester Manager**:
   - Naviguj na `https://filester.me/manager`
   - Prihlás sa do svojho účtu
   - Počkaj, kým sa stránka načíta

2. **Spusti scan**:
   - V pravom hornom rohu sa zobrazí indikátor "⚡ Nexus Gallery Ready - Click to scan"
   - Klikni naň pre spustenie scanu
   - Scan prebehne cez všetky foldery a extrahuje video súbory
   
3. **Import do Nexus**:
   - Otvor Nexus Gallery popup (klikni na extension ikonu)
   - Zobrazí sa zoznam všetkých nájdených videí
   - Použij filtre, select, alebo import buttons
   - Videá sa importujú do Nexus dashboardu

### Auto-import mode:
- Ak máš zapnuté "Send to Dashboard" v popup, import prebehne automaticky po skene

## API Endpoints použité

### Filester Manager API:
```
GET /api/manager/data?files_page=1&folders_page=1&with_hierarchy=1&folder_sort=newest&_t={timestamp}
GET /api/manager/data?folder={identifier}&files_page={page}&...
```

### Nexus Dashboard API:
```
POST /api/v1/import/bulk
{
  "batch_name": "Filester Manager: 10.5.2026",
  "videos": [
    {
      "title": "video.mp4",
      "url": "https://filester.me/d/abc123",
      "source_url": "https://filester.me/f/folder123",
      "thumbnail": "https://...",
      "filesize": 1234567890,
      "size_bytes": 1234567890,
      "file_size_mb": 1177.38,
      "quality": "1080p",
      "duration": 3600,
      "tags": "folder-name"
    }
  ]
}
```

## Technické detaily

### Video file detection:
- Filtrovanie podľa prípony: `.mp4`, `.mkv`, `.avi`, `.webm`, `.mov`, `.m4v`, `.wmv`, `.flv`, `.mpg`, `.mpeg`, `.m2ts`, `.ts`
- Minimálna dĺžka: 60 sekúnd (konfigurovateľné)

### Quality detection:
- Z názvu súboru: `4K`, `2160p`, `1440p`, `1080p`, `720p`, `480p`, `360p`
- Fallback: `HD`

### Rate limiting:
- 300ms pauza medzi API callmi na jednotlivé foldery
- Predchádza throttlingu zo strany Filester API

### Rekurzívne skenovanie:
- Maximálna hĺbka: 10 úrovní
- Zabraňuje nekonečným cyklom a stack overflow

## Súbory ktoré boli zmenené/vytvorené

1. **Nové súbory**:
   - `extensions/Nexus_Gallery/filester_manager_scanner.js` (470 riadkov)
   - `extensions/Nexus_Gallery/filester_manager_handler_snippet.js` (dokumentácia)

2. **Upravené súbory**:
   - `extensions/Nexus_Gallery/manifest.json` (pridaný content script entry)
   - `extensions/Nexus_Gallery/popup.js` (+135 riadkov):
     - Pridaná funkcia `isFilesterManagerUrl()`
     - Pridaná funkcia `handleFilesterManagerScraping()`
     - Pridaný condition v `startScraper()` funkcii

## Backend podpora

### Existujúci FilesterExtractor (`app/extractors/filester.py`):
- Už podporuje `/d/<slug>` file pages
- Už podporuje `/f/<slug>` folder pages  
- Extractuje stream URL, metadata, thumbnails
- Používa cache1.filester.me pre CDN

### Čo funguje automaticky:
- Import z Manager stránky pošle `/d/<slug>` URLs do dashboardu
- Backend FilesterExtractor ich spracuje a extrahuje stream URLs
- Refresh mechanizmus funguje cez file page URLs
- Proxy layer zabezpečí správne headers pre playback

### Nie je potrebné meniť:
- Backend extractor už plne podporuje Filester file pages
- Všetky importované videá budú fungovať s existujúcim kódom

## Možné vylepšenia do budúcnosti

1. **Progress bar** počas scanovania folderov
2. **Folder selection** - možnosť vybrať len špecifické foldery
3. **Incremental scan** - scan len nových súborov od posledného scanu
4. **Cache** - uloženie posledného scanu do storage
5. **Batch management** - lepšia organizácia importovaných batchov podľa folderov
6. **Private/Public filtering** - filter len public alebo private súborov
7. **Date filtering** - filter podľa dátumu uploadu
8. **Size filtering** - min/max veľkosť súborov

## Testovanie

### Manuálne testy:
1. ✅ Otvorenie filester.me/manager
2. ✅ Detekcia Manager stránky (visual indicator)
3. ⏳ Click na scan button
4. ⏳ Verifikácia API calls v Network tab
5. ⏳ Zobrazenie v Nexus Gallery popup
6. ⏳ Import do dashboardu
7. ⏳ Playback z dashboardu

### Edge cases na otestovať:
- Prázdny manager (žiadne súbory)
- Manager s veľmi veľkým počtom folderov (100+)
- Manager s hlbokým nestingom folderov (10+ úrovní)
- Network timeout počas scanu
- Manager s mixom video a non-video súborov
- Veľké súbory (10GB+)

## Známe obmedzenia

1. **API rate limiting**: Filester môže throttlovať pri príliš mnohých requestoch
2. **Memory usage**: Pri veľkom množstve súborov (1000+) môže popup spomaľovať
3. **Session timeout**: Pri dlhom scane môže session expirovat
4. ~~**Thumbnail loading**: Thumbnaily môžu failovať ak nie sú public~~ **✅ FIXED**
   - Backend teraz automaticky extrahuje a stiahne thumbnaily
   - Ukladá ich lokálne do `app/static/thumbnails/`
   - Vyžaduje Filester cookies v `filester.cookies.txt` pre súkromné súbory
   - Pre detaily pozri `FILESTER_COOKIES_GUIDE.md` v root projekte

## Troubleshooting

### Scan nefunguje:
- Skontroluj, že si prihlásený do Filester
- Obnovpreteč stránku (F5) a skús znova
- Skontroluj Console (F12) pre error messages

### Import failuje:
- Uisti sa, že Nexus dashboard beží na localhost:8001
- Skontroluj dashboard logy
- Skús manuálny import cez popup

### Videá sa neprehrávajú:
- Backend musí mať platné Filester cookies
- Stream URLs môžu expirovať - použiť refresh
- Skontroluj proxy/CORS nastavenia

## Support a kontakt

Pre bugs alebo feature requests:
- Otvor issue v GitHub repo
- Alebo kontaktuj developera

---

## Changelog

### 16. máj 2026 - Thumbnail Fix
**Problém**: Filester importy nemali thumbnaily v dashboarde
**Riešenie**:
- Backend teraz automaticky stiahne a uloží thumbnaily lokálne
- Pridaná podpora pre Filester cookies v `FilesterExtractor`
- Thumbnaily sa ukladajú do `app/static/thumbnails/filester_{hash}.jpg`
- Dashboard zobrazuje lokálne thumbnaily (bez CORS/auth problémov)

**Zmeny v kóde**:
1. `app/main.py` (import_bulk endpoint):
   - Pridaný download thumbnailov pre Filester videá
   - Použitie httpx client s proper headers
   - Lokálne ukladanie do static/thumbnails/

2. `app/extractors/filester.py`:
   - Pridaná podpora pre načítanie cookies z `filester.cookies.txt`
   - Cookies sa používajú pri HTTP requestoch
   - Funguje pre súkromné aj verejné Filester súbory

3. `extensions/Nexus_Gallery/filester_manager_scanner.js`:
   - Opravený typo (startswith → startsWith)
   - Pridaný komentár o backend extraction

**Ako používať**:
- Pre súkromné súbory: exportuj Filester cookies do `filester.cookies.txt` (pozri `FILESTER_COOKIES_GUIDE.md`)
- Pre verejné súbory: funguje automaticky bez cookies
- Backend automaticky extrahuje a stiahne thumbnaily pri importe

---

**Autor**: GitHub Copilot + AI Assistant
**Dátum**: 10. Máj 2026
**Verzia**: 1.0.0
