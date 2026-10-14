# Twitch Chat by Adin

Ein lokales OBS-Dock, das öffentliche Twitch- und TikTok-LIVE-Chats in einem Chat-Fenster zusammenführt.

## Für Nutzer

1. Die Release-ZIP herunterladen und entpacken.
2. `MultiChat-Start.exe` starten.
3. In OBS öffnen: **Werkzeuge → Benutzerdefinierte Browser-Docks**.
4. Einen Dock-Namen vergeben, z. B. `Twitch Chat by Adin`.
5. Diese Adresse einfügen:

   `http://127.0.0.1:8787/dock`

6. Twitch-/TikTok-Kanal eintragen und verbinden.

Zum Beenden `MultiChat-Beenden.exe` verwenden.

## Datenschutz

Der Server lauscht ausschließlich auf `127.0.0.1`; das Dock ist damit nicht aus dem Internet erreichbar.

Ein Twitch-Login wird getrennt vom Programmordner unter `%APPDATA%\TwitchChatByAdin` abgelegt und mit dem Windows-Benutzerkonto verschlüsselt. Diese Datei darf niemals in ein GitHub-Repository oder eine Release-ZIP gelangen.

## Entwicklung

Nach dem Klonen werden die Abhängigkeiten einmalig installiert:

```powershell
cd app
npm install
npm start
```

Die ausführbaren Start-/Stop-Dateien erwarten den Unterordner `app` neben sich.

## Release erstellen

1. Versionsnummer in `app/package.json` erhöhen.
2. Prüfen, dass keine privaten Dateien im Ordner liegen.
3. Eine ZIP mit Tool, `app` und `node_modules` für Nutzer erstellen.
4. Auf GitHub unter **Releases → Draft a new release** hochladen.
5. Den Release-Tag passend wählen, z. B. `v1.0.15`.
