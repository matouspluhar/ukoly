# Úkoly

PWA nad složkou `MYSLENI/UKOLY` na OneDrivu Onswerku (Microsoft Graph, MSAL.js).
Zadání: `MYSLENI/01_ZADANI_APLIKACE_UKOLY.md`, formát úkolu: `MYSLENI/00_SYSTEM.md`.

- Ostrá verze: https://matouspluhar.github.io/ukoly/
- Demo bez přihlášení: https://matouspluhar.github.io/ukoly/?demo
- Testy: `npm test` (formát, skupiny, fronta a synchronizace)
- Bez build kroku; MSAL Browser 4.30.0 (LTS) ve `vendor/`, písmo IBM Plex Sans (OFL) ve `fonts/`.
- Názvy zakázek nejsou v kódu – čtou se ze soukromého `MYSLENI/ZAKAZKY.md`.

## Vydání nové verze
1. Změň `VERSION` v `sw.js` (jinak telefon dál poběží ze staré mezipaměti).
2. Nový soubor přidej i do `SHELL` v `sw.js`.
3. Spusť `npm test`.

## Jak to drží pohromadě
- Každá změna jde nejdřív do IndexedDB, pak do fronty. Zápis vždy vychází z čerstvé verze souboru (eTag) a mění jen pole aplikace.
- Výpadek sítě nebo přetížený server: fronta čeká, další pokus s rostoucím odstupem (2 s → 60 s, nebo Retry-After).
- Neopravitelná chyba (soubor zmizel apod.) jde stranou, neblokuje frontu; stav to ukáže a klepnutí ji vyčistí.
- Odškrtnutí má 5 s na vrácení a blokuje jen další změny téhož úkolu.
- Jedna synchronizace napříč okny (Web Locks), service worker startuje aplikaci z mezipaměti.
