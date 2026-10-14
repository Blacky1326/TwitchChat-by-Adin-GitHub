TWITCH CHAT BY ADIN – KURZANLEITUNG
Version 1.0.10

Dieses Tool zeigt Twitch- und TikTok-LIVE-Chats gemeinsam als Dock in OBS.
Es wird NICHT automatisch im Stream eingeblendet.

------------------------------------------------------------
1. TOOL STARTEN
------------------------------------------------------------

1. Doppelklicke auf: MultiChat-Start.exe
2. Das Tool läuft danach unsichtbar im Hintergrund.
3. Öffne OBS Studio.

Zum Beenden doppelklicke auf: MultiChat-Beenden.exe

------------------------------------------------------------
2. DOCK IN OBS HINZUFÜGEN
------------------------------------------------------------

1. Öffne in OBS oben: Werkzeuge
2. Wähle: Benutzerdefinierte Browser-Docks
3. Klicke auf: Hinzufügen
4. Name: Twitch Chat by Adin
5. URL einfügen:

   http://127.0.0.1:8787/dock

6. Mit Anwenden / OK bestätigen.

Das Chat-Fenster erscheint nun in OBS. Du kannst es per Maus an eine
beliebige Stelle ziehen, wie den normalen Twitch-Chat.

------------------------------------------------------------
3. TWITCH EINRICHTEN
------------------------------------------------------------

1. Aktiviere Twitch und trage deinen Kanalnamen ein.
   Beispiel: adinofficial_
2. Klicke auf „Mit Twitch verbinden“.
3. Öffne den angezeigten Twitch-Link und gib den Code ein.
4. Bestätige die Twitch-Anmeldung.

Der Login wird danach verschlüsselt und nur für dein Windows-Konto gespeichert:

   C:\Users\DEIN-WINDOWS-NAME\AppData\Roaming\TwitchChatByAdin\twitch-login.dat

Diese Datei ist NICHT im Tool-Ordner. Wenn du den Tool-Ordner an andere
weitergibst, werden deine Twitch-Daten nicht mitgegeben.

Nach einem Neustart verbindet sich Twitch automatisch wieder. Neue
Twitch-Nachrichten können dann auch Profilbilder laden.

------------------------------------------------------------
4. TIKTOK EINRICHTEN
------------------------------------------------------------

1. Aktiviere TikTok.
2. Trage deinen Namen mit @ ein, zum Beispiel: @Test123
   Du kannst auch die TikTok-Profil-URL einfügen.
3. Starte eine TikTok-LIVE.

TikTok benötigt keinen Login. Das Tool liest den öffentlichen LIVE-Chat.
Likes, Follows, Shares, Geschenke und neue Zuschauer werden – soweit TikTok
sie an den öffentlichen LIVE-Chat liefert – als Aktivität angezeigt.

------------------------------------------------------------
5. WICHTIGE HINWEISE
------------------------------------------------------------

- Der PC muss online sein.
- MultiChat-Start.exe muss geöffnet worden sein, bevor OBS gestartet wird.
- Falls das Dock leer bleibt: OBS-Dock einmal schließen und erneut öffnen.
- Falls Port 8787 schon belegt ist: MultiChat-Beenden.exe ausführen und danach
  MultiChat-Start.exe erneut starten.
- Über „Login löschen“ kannst du den gespeicherten Twitch-Login entfernen.

------------------------------------------------------------
6. DATENSCHUTZ
------------------------------------------------------------

Das Dock ist nur lokal erreichbar:

   http://127.0.0.1:8787/dock

Andere Personen im Internet können nicht auf dein Dock zugreifen.
Der Twitch-Login wird mit Windows-DPAPI verschlüsselt und ist nur mit deinem
Windows-Benutzerkonto lesbar.
