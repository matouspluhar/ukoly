# Úkoly

Instalovatelná webová aplikace (PWA) nad složkou `MYSLENI/UKOLY` na OneDrivu Onswerku.
Windows i Android, funguje offline, změny se zapisují přímo do souborů .md přes Microsoft Graph.

- Ostrá verze: https://matouspluhar.github.io/ukoly/
- Demo bez přihlášení (ukázková data v prohlížeči): https://matouspluhar.github.io/ukoly/?demo
- Zadání: `MYSLENI/01_ZADANI_APLIKACE_UKOLY.md`, formát úkolu (schema 2): `MYSLENI/00_SYSTEM.md`
- Názvy zakázek nejsou v kódu – čtou se ze soukromého `MYSLENI/ZAKAZKY.md`. Repozitář je veřejný, jména klientů do něj nepatří.

## Soubory

| Soubor | Co dělá |
|---|---|
| `index.html` | kostra: postranní panel, seznam, detail, přihlášení |
| `styles.css` | celý vzhled; světlý a tmavý režim přes proměnné v `:root` |
| `js/app.js` | rozhraní: vykreslení, pohledy, detail, události, start |
| `js/format.js` | čtení a zápis formátu úkolu, skupiny, termíny, odhady – čisté funkce bez DOM |
| `js/sync.js` | fronta změn a synchronizace s OneDrivem |
| `js/store.js` | IndexedDB: úkoly, fronta, metadata |
| `js/graph.js` | přihlášení (MSAL) a Microsoft Graph |
| `js/demo.js` | falešný OneDrive pro `?demo` – stejné rozhraní jako `graph.js` |
| `sw.js` | service worker: start z mezipaměti, offline, aktualizace |
| `config.js` | údaje registrace aplikace v Entra ID (nejsou tajné) |
| `vendor/` | MSAL Browser 4.30.0 (LTS) |
| `fonts/` | IBM Plex Sans (OFL) |

Bez build kroku a bez závislostí za běhu kromě MSAL.

## Vzhled
- Jedno písmo, tři velikosti (`--s1`, `--s2`, `--s3`). Hierarchii nese tloušťka a odstín, ne verzálky a čáry.
- Barva (`--accent`) jen pro úkol po termínu a oheň. Všechny barvy jsou proměnné, tmavý režim je jen přemapuje.
- Rozvržení: do 960 px jeden sloupec se záložkami; od 960 px postranní panel se zakázkami; od 1240 px detail vpravo vedle seznamu.

## Jak to drží pohromadě
- Každá změna jde nejdřív do IndexedDB, pak do fronty. Zápis vždy vychází z čerstvé verze souboru (eTag) a mění jen pole aplikace (`APP_FIELDS`), poznámku a Průběh. Pole a sekce od Clauda zůstanou netknuté.
- Výpadek sítě nebo přetížený server: fronta čeká, další pokus s rostoucím odstupem (2 s → 60 s, nebo Retry-After).
- Neopravitelná chyba (soubor zmizel apod.) jde stranou a neblokuje frontu; zápatí to ukáže, klepnutí ji vyčistí.
- Odškrtnutí má 5 s na vrácení a blokuje jen další změny téhož úkolu.
- Jedna synchronizace napříč okny (Web Locks).
- Přihlášení: MSAL v4 drží přihlášení po zavření okna jen s volbou „Zůstat přihlášeni“. Bez ní aplikace známý účet přihlásí sama, jednou za relaci, bez výběru účtu (`canAutoLogin`).

## Vydání nové verze
1. Zvyš `APP_VERSION` v `js/app.js` a stejně `VERSION` v `sw.js` (`ukoly-<verze>`).
2. Nový soubor přidej do `SHELL` v `sw.js`.
3. Spusť `npm test` – kromě logiky hlídá i shodu verzí, úplnost `SHELL` a odkazy na soubory.
4. Nová ikona = nový název souboru (prohlížeč si ikonu pamatuje podle adresy).
