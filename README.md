# KV Thüringen Greasemonkey Crawler

Ein Greasemonkey/Tampermonkey-Userscript für die **KV Thüringen Arztsuche**, das Detaildaten sammelt und eine komfortable Ansicht mit Filter, Export und Statuspflege bereitstellt.

> **Hinweis:** Das Script speichert Daten lokal im Browser (LocalStorage). Es gibt **keine** Server-Komponente.

## Features

- Automatisches Sammeln von Detaildaten aus **Arztsuche-Detailseiten**.
- Speicherung in LocalStorage inkl. Telefon, Adresse, Fachgebiet, Leistungsangebote und Sprechzeiten.
- Viewer mit:
  - Volltextsuche
  - Filter „Jetzt Sprechzeit“
  - Status-Filter und Statuspflege
  - Export als **JSON** und **CSV**
- Auto-Runner für Übersichtsseiten: öffnet alle Detailseiten nacheinander in einem Popup und klickt anschließend auf die nächste Seite.

## Installation

1. Installiere eine Userscript-Erweiterung, z. B.:
   - [Tampermonkey](https://www.tampermonkey.net/)
   - [Greasemonkey](https://www.greasespot.net/)
2. Erstelle ein neues Userscript.
3. Kopiere den Inhalt aus [`main.user.js`](main.user.js) hinein.
4. Speichern – das Script läuft automatisch auf `https://www.kv-thueringen.de/*`.

## Nutzung

### Sammeln von Daten

- Öffne eine Detailseite (`/arztsuche/arztsuche-details`).
- Das Script sammelt die Daten automatisch.
- Alternativ über das Userscript-Menü: **„Diese Detailseite einsammeln (jetzt)”**.

### Viewer öffnen

- Menüpunkt: **„Arztsuche-Sammlung anzeigen”**.
- Dort kannst du suchen, filtern, exportieren und Einträge löschen.

### Auto-Runner (Übersichtsseiten)

- Öffne die Übersichtsseite `/arztsuche`.
- Menüpunkt **„Liste: Auto-Open & Next (Start)”** startet das automatische Öffnen aller Detailseiten in einem Popup.
- Mit **„Stop”** kannst du den Lauf beenden.

## Datenhaltung

Die Sammlung wird im LocalStorage unter dem Schlüssel:

- `kvt_arztsuche_sammlung_v1`

gespeichert. Die Daten bleiben erhalten, bis sie im Viewer gelöscht werden.

## Export

Im Viewer stehen zwei Exportformate zur Verfügung:

- **JSON**: vollständige Struktur inkl. Sprechzeiten-Arrays
- **CSV**: flache Tabelle, optimiert für Tabellenkalkulationen

## Lizenz

Kein offizielles Projekt der KV Thüringen. Verwendung auf eigene Verantwortung.
