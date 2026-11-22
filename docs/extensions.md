# Rozšírenia v repozitári

Každý priečinok s `manifest.json` je samostatné rozbalené rozšírenie Manifest V3. Načítava sa jeho vlastný priečinok; spoločné vendor súbory sú v jednotlivých balíkoch zámerne pribalené. Verzia nižšie pochádza z manifestu, nie z overenia funkčnosti v prehliadači.

| Priečinok | Názov v manifeste | Verzia |
| --- | --- | --- |
| `Balbums_Search_Launcher` | Balbums Search Launcher | 1.0.0 |
| `camwhores-url-fixer` | CamWhores URL Fixer | 1.1.2 |
| `hotcontainer-profile-handoff` | HotContainer Profile Handoff | 0.2.3 |
| `mp4-play-first` | Video Play First | 1.2.0 |
| `Nexus_Deck` | Nexus Deck | 1.1.1 |
| `Nexus_Extreme_Searcher` | Nexus Extreme Searcher | 0.1.0 |
| `Nexus_Extreme_Searcher_v2` | Nexus Extreme Searcher v2 | 0.2.0 |
| `Nexus_Gallery` | Nexus PWC Fresh 2 | 2.41.20 |
| `nexus_thread_intake` | Nexus Thread Intake | 2.1.0 |
| `nexus_thread_scraper` | Nexus Thread PWC V2 | 1.0.0 |
| `nexus_universal_importer` | Nexus PWC | 1.1.0 |
| `nexus-lens-bridge` | Nexus Lens Bridge | 1.1.0 |
| `nexus-live-annotator` | Nexus Live Annotator | 0.1.3 |
| `nexus-video-selector` | Nexus Video Card Selector Fresh_v2 | 1.5.13 |
| `simpcity-search` | Simpcity Search | 1.0.0 |
| `telegram-media-gallery` | Nexus Telegram Gallery | 1.3.7 |
| `vertical-multi-player` | Multi-Vertical Video Player | 1.1.1 |
| `vertical-video-sidecar` | Vertical Video Sidecar | 1.2.1 |

`Nexus_Extreme_Searcher_v2` má vlastný manifest a README; pôvodná verzia je ponechaná ako samostatné rozšírenie. `article-saver` nemá manifest v koreňovom priečinku; pozri jeho README. Filester Discovery Bridge je v `extension/filester_search/extension/`.

Tento zoznam neurčuje, ktoré rozšírenia má používateľ práve nainštalované. Pred archiváciou staršej verzie treba skontrolovať používaný profil prehliadača a jej väzby na Nexus API.
