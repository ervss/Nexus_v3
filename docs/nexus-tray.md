# Nexus ikonka pri hodinách (Windows)

Dvojklik na `START_NEXUS_TRAY.vbs` spustí iba ikonku. Pri prvom spustení sa zostaví malý Windows launcher pomocou systémového .NET Framework kompilátora; nie je potrebná inštalácia balíčkov. Launcher hostuje PowerShell 5.1 + WinForms, bez terminálového okna. Python používa existujúce `.venv` projektu (vrátane `psutil`).

Ikonka sa predvolene pridá do priečinka Po spustení pre aktuálneho používateľa. Server sa po prihlásení automaticky nezapína. Toto správanie možno vypnúť v menu. Windows môže ikonku schovať pod šípku; používateľ ju môže presunúť k hodinám.

- Ľavý klik: stavový panel. Pravý klik: ovládacie menu. Rovnaké menu je aj v paneli.
- Zelená: overená inštancia odpovedá. Pracujúci server ostáva zelený.
- Oranžová: štart, zastavovanie, obnova, tri neúspešné kontroly alebo konflikt identity/portu.
- Červená: vypnutý server alebo vyčerpaná automatická obnova.
- Zavretie panelu skryje panel. **Ukončiť ikonku** nevypína server.
- Diagnostika kopíruje stručný prompt, stav a dve očistené udalosti. Žiadne údaje nikam automaticky neposiela.

Panel rozlišuje poslednú odpoveď od poslednej zaznamenanej aktivity. Ticho v logu nie je dôvod na obnovu. Ak udalosť nemá spoľahlivý čas, zobrazí sa „bez času“, bez domnienky o pokroku. Pri nedostupnom serveri ostáva posledná aktivita označená ako neaktuálna. Vlastné HTTP kontroly a WebSocket pripojenia sa vo výpise logov nezobrazujú. URL a hodnoty pomenovaných prihlasovacích údajov sú pri kopírovaní diagnostiky odstránené; nejde o úplný export logov.

## Zastavenie a reštart

Existujúci dohľad je jediným automatickým mechanizmom obnovy: tri zlyhané kontroly po pripravení servera, najviac päť obnov za desať minút. Štart má pôvodnú toleranciu 120 sekúnd.

Ručné zastavenie cez ikonku alebo `scripts/stop_nexus.ps1` požiada konkrétnu inštanciu workeru o shutdown. Po 15 sekundách neúspechu dohľad ostáva živý v stave `stop_failed`; ikonka ponúkne vynútenie s predvolenou odpoveďou Nie. Zamietnutie nevynucuje ukončenie a ponechá server v stave zastavovania; opätovné Vypnúť alebo Reštartovať znovu ponúkne vynútenie. Pre príkazový riadok je výslovná možnosť `scripts/stop_nexus.ps1 -Force`.

Starší už bežiaci dohľad nemá protokol šetrného zastavenia. Ikonka ho označí „starší dohľad“ a pred jeho prvou výmenou ponúkne vynútenie. Potom sa používajú nové pravidlá.

Identita sa overuje cez absolútnu cestu projektu, príkaz procesu, čas vytvorenia procesu, strom rodičov a identifikátor inštancie v `/_nexus/live`. Cudzí proces na rovnakom porte sa nezastavuje. Príkazy zapnúť/vypnúť/reštartovať sa serializujú lokálnym súborovým zámkom.

## Súbory a testovanie

`logs/server/supervisor-PORT.json` je atómovo publikovaný živý stav. `outcome-PORT.json` zachová výsledok po ukončení dohľadu. Stav ikonky a preferencia automatického spúšťania sú v rovnakom priečinku. Spustenie ikonky cez natívny launcher má jednu inštanciu na projekt a port. WinForms NotifyIcon používa systémovú správu TaskbarCreated na obnovenie ikonky po obnove Prieskumníka.

```powershell
.venv\Scripts\python.exe -m pytest tests/test_nexus_supervisor.py tests/test_nexus_control.py tests/test_nexus_tray_integration.py -q
```

Integračné testy používajú vlastný dočasný projekt, prázdnu FastAPI aplikáciu a oddelený port. Nepoužívajú používateľskú databázu. Overujú reálny štart, opakované zapnutie, pád a automatickú obnovu, šetrné zastavenie a explicitné vynútenie pri zaseknutom event loope.

Pre vývoj možno spustiť `scripts/bin/NexusTray.exe --show-panel --no-startup --port PORT --mode classic`. Premenná prostredia `NEXUS_TRAY_PYTHON` umožňuje zvoliť existujúci Python pre oddelený testovací projekt; bežné spustenie používa `.venv`.
