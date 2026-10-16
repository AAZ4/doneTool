# done

Digitaler Abholruf für Imbisse, Cafés und Foodtrucks – der Ersatz für Funk-Pager.
Der Gast scannt einen QR-Code, die Kasse drückt „Fertig“, das Handy des Gastes klingelt. Ohne App, ohne Registrierung, ohne Hardware.

## Starten

```bash
npm install
npm run dev
```

Dann <http://localhost:3000> öffnen, einen Laden anlegen und die Links aus der Einrichtung nutzen.

## Ansichten

| Pfad | Für wen | Zweck |
|---|---|---|
| `/` | Ladenbesitzer | Laden anlegen |
| `/start/:slug#t=…` | Ladenbesitzer | Kassen-Link, Theken-QR (druckbar), TV-Link |
| `/r/:slug?k=…` | Gast | Nummer, Status, „Benachrichtigung aktivieren“, Klingeln |
| `/k/:slug#t=…` | Kasse | Fertig / Abgeholt / Rückgängig / Nochmal klingeln, Nummer ohne Handy |
| `/tv/:slug#t=…` | Fernseher | Fertige Nummern, Sprachansage, QR-Code im Minutentakt |

Der Mitarbeiter-Token steht im URL-Hash (`#t=`) und landet so nicht in Server-Logs.

## Wie der Gast benachrichtigt wird

1. **Seite offen:** WebSocket-Update → Ton (Web Audio), Vibration (nur Android), Vollbild-Hinweis. Wake Lock hält den Bildschirm an.
2. **Web Push:** Mitteilung auch bei gesperrtem Handy. Android/Chrome direkt; iPhone nur, wenn die Seite zum Home-Bildschirm hinzugefügt wurde.
3. **Nachklingeln:** Reagiert der Gast nicht („Ich komme!“), klingelt der Server alle 45 s erneut (max. 3×).
4. **Kasse sieht** pro Nummer: Alarm aktiv / kein Alarm (→ ausrufen) / kommt.

## Datenschutz

- Keine Namen, Telefonnummern, Preise oder Artikel – nur Nummern. Dadurch ist done **kein Kassensystem** (keine TSE nötig).
- Tickets werden nach 12 Stunden gelöscht, Nummern starten täglich bei 1.
- Keine Cookies, kein Tracking.

## Technik

Node.js, Express, `ws` (WebSockets), `web-push` (VAPID-Schlüssel werden beim ersten Start in `data/` erzeugt), `qrcode`.
Daten liegen für das MVP in `data/db.json`.

## Vor dem Livegang

- HTTPS (Pflicht für Push und Wake Lock), `VAPID_SUBJECT` setzen
- Datenbank statt JSON-Datei (z. B. PostgreSQL), Rate-Limiting für Ticket-Erstellung
- Impressum, Datenschutzerklärung, AGB und AVV für Restaurants
- Nächste Schritte: QR-Code auf dem Kassenbon + API/Webhooks für Kassensysteme, weitere Sprachen
