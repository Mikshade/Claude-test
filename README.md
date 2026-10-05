<p align="center">
  <img src="resources/icon.png" alt="Flowy" width="128" height="128">
</p>

<h1 align="center">Flowy</h1>

<p align="center">
  Eine Anime-Desktop-Begleiterin für Windows, die spricht, zuhört, deinen Bildschirm sieht und deinen PC bedient – ein Jarvis mit Gesicht.<br>
  <em>An anime desktop companion for Windows that talks, listens, sees your screen and runs your PC – a Jarvis with a face.</em>
</p>

<p align="center">
  <a href="#deutsch">Deutsch</a> · <a href="#english">English</a> · <a href="ARCHITECTURE.md">Architecture</a> · <a href="THIRD_PARTY_NOTICES.md">Third-party notices</a>
</p>

---

# Deutsch

## Was ist Flowy?

Flowy ist eine 2D-Anime-Figur (Live2D), die über allen Fenstern auf deinem Desktop lebt und dir wie ein persönlicher
Assistent zur Hand geht:

- **Sie spricht** – mit einer Stimme deiner Wahl über Fish Audio (Cloud) oder einen lokalen Fish-Speech-Server.
  Die Antworten werden satzweise synthetisiert und lippensynchron abgespielt, Emotionen steuern Mimik und Betonung.
- **Sie hört zu** – Push-to-Talk per Hotkey, Spracherkennung über Fish Audio ASR oder jeden OpenAI-kompatiblen
  Transkriptions-Endpunkt (OpenAI, Groq, lokale Whisper-Server). Alternativ tippst du im Chat-Feld.
- **Sie sieht deinen Bildschirm** – auf Wunsch bei jeder Frage (verkleinerter Screenshot + Titel des aktiven Fensters),
  nur auf Nachfrage oder nie.
- **Sie hilft wie Jarvis** – das Gehirn ist Claude (Anthropic) mit Tool-Use: PowerShell, Dateien, Programme starten,
  Fenster steuern, Tastatur/Maus, Zwischenablage, Lautstärke, Web-Suche und -Abruf, Erinnerungen, Notizen, Sperren/Herunterfahren.
- **Sie fliegt vor dem Mauszeiger weg** – kommt der Cursor zu nah, weicht sie an eine freie Stelle aus
  (abschaltbar, anheftbar; mit gehaltener Strg-Taste darfst du sie anfassen und anklicken).
- **Persönlichkeit frei konfigurierbar** – Name, Sprache (Deutsch/Englisch), du/Sie, Presets (Jarvis, Genki, Kuudere,
  Onee-san, Tsundere, Custom), Schieberegler für Wärme, Verspieltheit, Frechheit, Förmlichkeit, Redseligkeit und
  Eigeninitiative, plus freier Zusatz-Prompt.
- **Voller Systemzugriff** – standardmäßig darf sie alles ausführen, was du auch darfst. Wer vorsichtiger ist, lässt sich
  destruktive Aktionen bestätigen oder schaltet auf „nur lesen“ (siehe [Berechtigungen & Sicherheit](#berechtigungen--sicherheit)).

### Screenshots

> _Platzhalter – Screenshots folgen, sobald der erste Windows-Build steht._
> `docs/screenshots/overlay.png`, `docs/screenshots/wizard.png`, `docs/screenshots/settings.png`

## Voraussetzungen

| | |
| --- | --- |
| Betriebssystem | Windows 10 / 11 (64-bit). Die Oberfläche läuft nur unter Windows; Typecheck/Tests/Build laufen auch unter Linux/macOS. |
| Grafik | Eine GPU mit Desktop-Compositing (DWM) und WebGL – d. h. jeder normale PC. Hardwarebeschleunigung darf nicht abgeschaltet sein. |
| Node.js | 22.12 oder neuer (zum Bauen; die fertige Installation braucht kein Node) |
| Anthropic | Ein API-Key von https://console.anthropic.com/settings/keys |
| Fish Audio | Ein API-Key von https://fish.audio/app/api-keys (kostenloses TTS-Modell vorhanden) – oder ein lokaler Fish-Speech-Server |
| Mikrofon | Für Push-to-Talk (optional – tippen geht immer) |

## Schnellstart

```powershell
git clone <repo-url> flowy
cd flowy
npm install --legacy-peer-deps      # Abhängigkeiten (pixi.js 7 + Live2D-Plugin brauchen den Schalter)
npm run setup:live2d                # Live2D Cubism Core + Beispielmodell laden (fragt nach Lizenz-Zustimmung)
npm run dev                         # Entwicklung: startet Electron mit Hot-Reload
```

Installer bauen:

```powershell
npm run dist              # NSIS-Installer → release/Flowy Setup 0.1.0.exe
npm run dist:portable     # portable EXE → release/
```

`npm run setup:live2d` ist idempotent (vorhandene Dateien werden übersprungen), kennt `--yes` (oder die
Umgebungsvariable `FLOWY_ACCEPT_LIVE2D=1`) für Skripte, `--model Hiyori|Haru|Mao|Natori`, `--force`, `--lang de|en`
und `--help`. Ohne Cubism Core versucht Flowy den offiziellen CDN; schlägt auch das fehl, zeichnet sie eine einfache
prozedurale Figur – sie läuft also immer.

## Erster Start: der Einrichtungsassistent

Beim ersten Start öffnet sich das Einstellungsfenster mit einem Assistenten, der Schritt für Schritt durch die
Einrichtung führt. Dieselben Seiten gibt es später als Tabs (Tray → „Einstellungen…“):

1. **Charakter** – Name, Sprache, du/Sie, Persönlichkeits-Preset und Feinregler, eigener Zusatz-Prompt.
2. **Stimme** – Fish Audio API-Key, Stimme suchen/anhören/auswählen, TTS-Modell, Format, Lautstärke, Tempo, Ausgabegerät; Test-Button.
3. **Ohren** – Spracherkennung (Fish Audio / OpenAI-kompatibel / aus), Mikrofon, Sprach-Hinweis, Stille-Erkennung; Test-Aufnahme.
4. **Gehirn** – Anthropic API-Key, Modell, Denk-Aufwand; Verbindungstest.
5. **Aussehen** – Live2D-Modell (gebündelt oder eigene `*.model3.json`), Größe, Startecke, Ausweichen vor dem Cursor.
6. **Berechtigungen**, **Hotkeys**, **Verhalten** (Begrüßung beim Start, proaktive Kommentare, Ruhezeiten).

Am Ende wird `setupCompleted` gesetzt; die Konfiguration liegt unter `%APPDATA%\Flowy\config.json`. API-Keys werden
dort mit Windows DPAPI (`safeStorage`) verschlüsselt gespeichert.

## Fish Audio einrichten (Stimme in der Cloud)

1. Konto anlegen und unter https://fish.audio/app/api-keys einen Key erstellen. Der Key wird für **TTS und ASR**
   gemeinsam benutzt (`tts.fishCloud.apiKey`).
2. Stimme aussuchen: auf https://fish.audio stöbern und eine Stimme öffnen – die URL hat die Form
   `https://fish.audio/m/<id>`. Die 32-stellige Hex-ID ist die `reference_id`; der Assistent akzeptiert die ID, den
   Link oder sucht direkt nach Namen. Leer = Standardstimme des Modells (nicht stabil – für eine feste Figur immer eine ID wählen).
3. Modell wählen (`tts.fishCloud.model`):

   | Modell | Hinweise | Preis (Stand Pricing-Seite 2026) |
   | --- | --- | --- |
   | `s2.1-pro-free` (Standard) | aktuelles S2.1, **kostenlos**, keine Latenz-Garantien | 0 $ |
   | `s2.1-pro` | wie oben mit Garantien | 15 $ pro Mio. UTF-8-Bytes Text |
   | `s2-pro` | Vorgänger, 80+ Sprachen | 15 $ pro Mio. UTF-8-Bytes |
   | `s1` | Legacy, 13 Sprachen, Emotionen in `(Klammern)` | 15 $ pro Mio. UTF-8-Bytes |

   Abgerechnet wird pro UTF-8-Byte (Umlaute = 2 Bytes). Unbekannte Modellnamen fallen serverseitig **kostenpflichtig**
   auf `s2.1-pro` zurück – deshalb lässt Flowy nur die obigen Namen zu. Guthaben: https://fish.audio/app/developers/billing/.
   Das Limit ist die Zahl **gleichzeitiger** Anfragen (5 unter 100 $ Guthaben); Flowy bricht alte Anfragen beim
   Unterbrechen ab und synthetisiert mit begrenzter Parallelität.
4. Emotionen: Flowy übersetzt die `[[emotion]]`-Marker der Antwort in Fish-Cues (`[happy] …` für S2, `(happy) …` für S1).
   Abschaltbar über `tts.emotionCues`.
5. Optional **Voice Cloning**: 10–30 s saubere Sprache als wav/mp3 plus exaktes Transkript (`tts.fishCloud.cloneSample`).
6. **Spracherkennung (ASR)**: Provider `fish-cloud` nutzt denselben Key mit dem Modell `transcribe-1`
   (0,36 $ pro Audiostunde, sekundengenau gerundet). Für kurze Push-to-Talk-Aufnahmen praktisch kostenlos.

## Lokaler Fish-Speech-Server (Stimme offline)

Der Open-Source-Server von Fish Speech spricht dieselbe `/v1/tts`-API. Realistisch auf Consumer-GPUs ist **S1-mini**
(0,5 B Parameter, ~3,6 GB Gewichte, Lizenz CC-BY-NC-SA 4.0 = nicht kommerziell). Der aktuelle `main`-Branch ist
Fish Speech 2 (S2-Pro, 24 GB VRAM) und kann S1-mini **nicht** laden – deshalb auf den letzten S1-Commit pinnen:

```powershell
git clone https://github.com/fishaudio/fish-speech.git
cd fish-speech
git checkout d3df50503b36314a964f66cac1af1e19e95bcfa3     # letzter S1-Commit (2026-01-08)
uv sync --python 3.12 --extra cu128                         # cu126 | cu128 | cu129 (RTX 50xx braucht cu128/cu129)

# Gewichte (gated: auf https://huggingface.co/fishaudio/s1-mini die Bedingungen akzeptieren, dann einloggen)
uv tool install "huggingface_hub[cli]"
hf auth login
hf download fishaudio/s1-mini --local-dir checkpoints/openaudio-s1-mini

# Server starten – immer aus dem Repo-Root (references/ und .project-root werden relativ aufgelöst)
uv run tools/api_server.py --listen 127.0.0.1:8080 `
  --llama-checkpoint-path checkpoints/openaudio-s1-mini `
  --decoder-checkpoint-path checkpoints/openaudio-s1-mini/codec.pth `
  --decoder-config-name modded_dac_vq
```

In Flowy dann: Stimme → Provider **Lokaler Fish-Speech-Server**, Basis-URL `http://127.0.0.1:8080`, Format **wav**
(der Server liefert nur wav/mp3; pcm/opus scheitern), `referenceId` = Ordnername unter `references/` des Servers
(optional), API-Key nur, wenn der Server mit `--api-key` gestartet wurde. Flowy pingt `GET /v1/health`.

Hinweise: `--half` für GPUs ohne bf16 (GTX 10xx/16xx, RTX 20xx); `--compile` läuft unter Windows nicht (Triton);
ohne Compile ist S1-mini auf RTX 30/40 etwa echtzeitfähig. Der lokale Server bietet **keine** Spracherkennung – dafür
Fish Audio Cloud oder einen OpenAI-kompatiblen Endpunkt wählen. Emotionen werden automatisch im S1-Stil `(klammer)` übergeben.

## Anthropic API-Key (das Gehirn)

Key unter https://console.anthropic.com/settings/keys erzeugen und im Assistenten (Gehirn) eintragen
(`llm.apiKey`). Standardmodell ist `claude-opus-5-5` (`llm.model`), Denk-Aufwand `llm.effort` = low/medium/high.
Der System-Prompt ist bewusst stabil (Prompt-Caching); Uhrzeit, aktives Fenster und Screenshot wandern in die
Nutzer-Nachricht. `llm.refusalFallback` (an) lässt die API eine abgelehnte Anfrage serverseitig auf ein
Ersatzmodell umleiten. `llm.maxHistoryTurns` (60) und `llm.maxToolIterations` (25) begrenzen Kontext und Tool-Schleifen.

## Spracherkennung: Alternativen zu Fish

Provider `openai-compatible` (`stt.openaiCompatible`) spricht `POST <baseUrl>/audio/transcriptions` (multipart, wav 16 kHz mono):

| Dienst | Basis-URL | Modell | Key |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` | https://platform.openai.com/api-keys |
| Groq | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo`, `whisper-large-v3` | https://console.groq.com/keys |
| speaches / faster-whisper-server | `http://127.0.0.1:8000/v1` | z. B. `Systran/faster-whisper-small` | keiner |
| whisper.cpp server | `http://127.0.0.1:8080/v1` (mit `--inference-path /v1/audio/transcriptions`) | beliebig | keiner |
| LocalAI | `http://127.0.0.1:8080/v1` | `whisper-1` | keiner |

Ein eingefügter voller Endpunkt wird auf `/v1` normalisiert; ohne Key wird kein `Authorization`-Header gesendet.
`stt.language` ist ein Sprach-Hinweis (leer = automatisch), `stt.silenceTimeoutMs` (1400) beendet die Aufnahme nach
Stille, `stt.maxRecordingMs` (30000) ist die Obergrenze. Provider `none` schaltet Push-to-Talk ab (Chat bleibt).

## Hotkeys

| Aktion | Standard | Bedeutung |
| --- | --- | --- |
| Push-to-Talk | `Strg+Umschalt+Leertaste` | einmal drücken: zuhören; nochmal: stoppen (stoppt auch automatisch nach Stille). Während sie spricht/denkt: unterbrechen und zuhören. |
| Ein-/Ausblenden | `Strg+Umschalt+H` | Figur verstecken/zeigen (auch im Tray) |
| Chat öffnen | `Strg+Umschalt+Enter` | Texteingabe in der Sprechblase |
| Unterbrechen | _(leer = aus)_ | Ein globales `Escape` würde jeder App das Escape klauen – deshalb leer. Empfohlen: `Strg+Umschalt+Escape`. Unterbrechen geht immer auch per Push-to-Talk oder Sprechblase. |
| Anfassen | `Strg` halten | Mit gehaltener Taste (`avatar.avoidance.holdKeyToInteract`) fliegt sie nicht weg, lässt sich anklicken (Chat) und per Kontextmenü anheften |

Hotkeys sind Electron-Accelerator-Strings (`hotkeys.*`). Ist eine Kombination schon vergeben, meldet Flowy das beim
Start im Log und in den Einstellungen; dann einfach eine andere wählen.

## Bildschirm-Wahrnehmung & Datenschutz

- `screenAwareness.mode`: **always** (Standard – jeder Frage liegt ein Screenshot bei), **on-demand** (nur wenn die
  Frage nach dem Bildschirm klingt oder sie das Tool `take_screenshot` nutzt) oder **off**.
- Screenshots werden vor dem Senden verkleinert (längste Kante `maxLongEdge` = 1280 px, JPEG-Qualität 70) und zusammen
  mit dem Titel des aktiven Fensters (`includeActiveWindow`) in die Nutzer-Nachricht gelegt. Sie gehen **ausschließlich
  an die Anthropic-API** – nie an Fish Audio.
- Der Gesprächsverlauf liegt lokal in `%APPDATA%\Flowy\history.json` – **ohne** Screenshots: ein Bild wird nur mit der
  Runde gesendet, in der es aufgenommen wurde, und danach (im Speicher wie auf der Platte) durch den Platzhalter
  `[Screenshot was attached]` ersetzt. Per Tray → „Verlauf löschen“ wird der Verlauf geleert. Langzeit-Notizen
  (`remember`/`recall`) liegen in `memory.json`, Logs in `logs\flowy.log`.
- Push-to-Talk-Audio geht nur an den gewählten STT-Dienst und wird nicht gespeichert.
- Proaktive Kommentare (`behavior.proactive`, Standard **aus**) nehmen periodisch einen Screenshot – mit Ruhezeiten.
- Für sensible Arbeit: Modus **off** wählen. Die Figur zu verstecken schaltet die Wahrnehmung **nicht** ab.
- Screenshots und Webseiten sind nicht vertrauenswürdiger Inhalt (Prompt-Injection). Flowy kennzeichnet sie als
  Daten, aber bei vollem Systemzugriff gilt: siehe nächster Abschnitt.

## Berechtigungen & Sicherheit

Flowy ist absichtlich mächtig: **„Voller Zugriff“ bedeutet, sie kann alles ausführen, was dein Benutzerkonto darf** –
PowerShell-Befehle, Dateien schreiben und löschen (in den Papierkorb), Programme starten und schließen, tippen und
klicken, Zwischenablage setzen, Lautstärke/Helligkeit, Sperren, Energiesparen, Herunterfahren.

| `permissions.level` | Verhalten |
| --- | --- |
| `full` (Standard) | alle Tools ohne Rückfrage |
| `confirm-destructive` | destruktive Tools (Shell, Schreiben/Löschen/Verschieben, Fenster schließen, Eingaben, Zwischenablage setzen, Energie) zeigen eine Ja/Nein-Frage in der Sprechblase; keine Antwort in 60 s = Nein. **Empfohlen für vorsichtige Nutzer.** |
| `read-only` | nur lesende Tools (Dateien lesen, Fenster auflisten, Screenshot, Web, Notizen) |

Zusätzlich lassen sich Kategorien einzeln abschalten: `allowShell`, `allowFiles`, `allowScreenshots`, `allowWeb`,
`allowInput` (Tastatur/Maus), `allowPower` (Sperren/Schlafen/Herunterfahren).

- **Als Administrator neu starten** (Tray-Menü): Flowy läuft normal mit Benutzerrechten (`asInvoker`). Der Menüpunkt
  startet sie mit UAC-Abfrage erhöht neu, damit sie auch Dienste, Firewall & Co. anfassen darf. Nur wenn du das
  wirklich willst.
- Die Windows-Integration läuft über einen persistenten PowerShell-Host (`resources/ps/flowy-host.ps1`) – eine
  lesbare Skriptdatei, kein verschlüsselter Blob. Virenscanner, die `Add-Type` blocken, nehmen nur die typisierten
  Tools weg.
- API-Keys werden mit DPAPI verschlüsselt und nur an das Einstellungsfenster im Klartext geliefert, nie an das Overlay.
- Der Renderer ist sandboxed (`contextIsolation`, whitelisted IPC); nur Mikrofon, Lautsprecher-Auswahl und
  Zwischenablage werden freigegeben.

## Live2D-Modelle

- **Gebündeltes Beispielmodell**: `npm run setup:live2d` lädt ein offizielles Live2D-Sample (Standard **Hiyori**;
  `--model Haru|Mao|Natori`) nach `resources/models/default/` – unter der
  [Live2D Free Material License](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) (privat und
  Kleinunternehmen unter 10 Mio. JPY Jahresumsatz; keine Weitergabe der rohen Modelldateien, keine Design-Änderungen;
  Natori nur nicht-kommerziell). Pflicht-Credit, der auch auf der Über-Seite steht:

  > This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with
  > conditions and terms set by Live2D Inc.

- **Eigenes Modell**: Aussehen → „Live2D-Modell“ → eine `*.model3.json` wählen (`avatar.modelPath`). Der Ordner wird
  über das interne `flowy-model://`-Protokoll bereitgestellt (kein Pfad-Traversal). Cubism 3/4/5 (`.moc3`) wird
  unterstützt, Cubism 2.1 (`.model.json`) nicht. Lippen-Synchronisation nutzt die `LipSync`-Gruppe des Modells
  (`ParamMouthOpenY`, bei Mao `ParamA`); Emotionen werden auf vorhandene Expressions/Motion-Gruppen abgebildet,
  fehlende werden ignoriert. Modelle von nizima/Booth haben eigene Lizenzen – bitte lesen; Game-Rips sind tabu.
- **Cubism Core** (`src/renderer/public/vendor/live2dcubismcore.min.js`) ist proprietär („Redistributable Code“ der
  Live2D Proprietary Software License); das Setup-Skript prüft den Lizenz-Header und lässt ihn unangetastet.
- **Lizenz-Vorbehalt „Expandable Application“**: Die kostenlose Nutzung des Live2D-SDK für Privatpersonen/Kleinunternehmen gilt
  laut EULA (§1.5, §2.2) **nicht** für Anwendungen, die „eine unbestimmte Zahl von Modellen durch Hinzufügen von Dateien
  verwenden“ (Avatar-/Streaming-Apps). Weil Flowy ein eigenes Modell laden kann, könnte sie darunter fallen. Für den
  privaten Gebrauch mit dem gebündelten Modell ist das unkritisch; wer Flowy veröffentlicht oder kommerziell nutzt, sollte
  die Frage mit Live2D klären (https://www.live2d.com/en/download/cubism-sdk/release-license/). Details in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Fehlerbehebung

| Problem | Ursache / Lösung |
| --- | --- |
| Schwarzes oder undurchsichtiges Fenster statt transparenter Figur | Transparente Fenster brauchen DWM-Compositing und die GPU. Grafiktreiber aktualisieren, Hardwarebeschleunigung nicht deaktivieren (`--disable-gpu` nie setzen), nicht über Remote-Desktop ohne GPU testen. Das Overlay ist absichtlich nicht maximierbar/resizable. |
| Mikrofon „blockiert“ / keine Aufnahme | Windows-Einstellungen → Datenschutz und Sicherheit → Mikrofon: Zugriff erlauben **und** „Desktop-Apps den Zugriff erlauben“ einschalten. In Flowy das richtige Gerät wählen (`stt.inputDeviceId`). Flowy fragt nur Audio an, nie Video. |
| Hotkey reagiert nicht | Die Kombination ist von einer anderen App belegt (Flowy meldet „failed“ im Log) – in den Einstellungen eine andere wählen. Gleiche Taste für zwei Aktionen: die erste gewinnt. |
| Transparenz kaputt, sobald DevTools offen sind | Bekannte Electron-Einschränkung: DevTools niemals am Overlay andocken. Zum Debuggen das Einstellungsfenster nutzen oder Electron mit `--remote-debugging-port=9222` starten und im Browser `chrome://inspect` öffnen. |
| „Fish Audio API-Key ungültig“ / „Guthaben aufgebraucht“ | Key prüfen (fish.audio/app/api-keys), Guthaben unter fish.audio/app/developers/billing; `s2.1-pro-free` ist kostenlos. |
| „Fish Speech Server nicht erreichbar“ | Server aus dem Repo-Root starten, Port/URL prüfen, bis die Modelle geladen sind ist der Port zu (`/v1/health`). |
| Keine Stimme, aber Untertitel | TTS-Provider `none`? Ausgabegerät prüfen (`tts.outputDeviceId`), Tray → „Stumm“ aus. |
| Keine Live2D-Figur, nur die einfache Ersatzfigur | `npm run setup:live2d` nicht gelaufen oder kein Netz für den CDN-Fallback; Modellpfad falsch (Log: „no Live2D model found“). |
| Sie reagiert mit „das kann ich nicht“ | `llm.refusalFallback` an lassen; Tool-Kategorie unter Berechtigungen freigeben. |
| Alles zurücksetzen | Flowy beenden, `%APPDATA%\Flowy\config.json` (und ggf. `history.json`, `memory.json`) löschen. |

Logs: `%APPDATA%\Flowy\logs\flowy.log` (rotiert bei 5 MB).

## Entwicklung

Entwickelt wird Linux-freundlich – nur die Oberfläche braucht Windows:

```bash
npm install --legacy-peer-deps
npm run typecheck        # tsc für main/preload (Node) und renderer (DOM)
npm test                 # vitest, electron ist auf tests/mocks/electron.ts gealiast
npm run build            # electron-vite build → out/
npm run setup:live2d -- --yes --lang en   # nicht-interaktiv
node scripts/setup-live2d.mjs --help
```

- Projektstruktur, Prozesse, Turn-Pipeline und Modul-Verträge: [ARCHITECTURE.md](ARCHITECTURE.md).
- Reine Logik (Positionierung, Parser, Zustandsautomaten, das Manifest-Walker-Skript) hat Unit-Tests neben der Datei;
  die Skripte in `scripts/` werden mit `npx vitest run scripts` getestet.
- Icons: `resources/icon.svg` ist die Quelle. Neu rastern mit ffmpeg (librsvg) + ImageMagick:
  `ffmpeg -width 512 -height 512 -i resources/icon.svg -pix_fmt rgba resources/icon.png`, dann die ICO-Größen
  (256/128/64/48/32/16 bzw. 32/16 für `tray.ico`) mit `convert … icon.ico` zusammenfügen.
- Konventionen: TypeScript strict, benannte Exporte, Factory-Funktionen, `createLogger(scope)` im Main-Prozess,
  Deutsch als Standardsprache mit Englisch als Alternative.

## Lizenz

Flowy selbst steht unter der MIT-Lizenz. Live2D Cubism Core, die Beispielmodelle, Fish Audio/Fish Speech und
Anthropic unterliegen eigenen Bedingungen – siehe [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

# English

## What is Flowy?

Flowy is a 2D anime character (Live2D) that lives on top of every window on your Windows desktop and helps you like a
personal assistant:

- **She talks** – with a voice of your choice through Fish Audio (cloud) or a local Fish Speech server. Replies are
  synthesized sentence by sentence and played back with lip sync; emotion markers drive her expressions and delivery.
- **She listens** – push-to-talk via hotkey, speech recognition through Fish Audio ASR or any OpenAI-compatible
  transcription endpoint (OpenAI, Groq, local Whisper servers). Or you type into the chat input.
- **She sees your screen** – with every question (downscaled screenshot + active window title), only on demand, or never.
- **She helps like Jarvis** – the brain is Claude (Anthropic) with tool use: PowerShell, files, launching apps, window
  control, keyboard/mouse, clipboard, volume, web search and fetch, reminders, notes, lock/shutdown.
- **She flies away from your cursor** – when the pointer gets too close she darts to a free spot (can be disabled or
  pinned; hold Ctrl to approach and click her).
- **Fully configurable personality** – name, language (German/English), du/Sie, presets (Jarvis, Genki, Kuudere,
  Onee-san, Tsundere, custom), sliders for warmth, playfulness, sass, formality, verbosity and proactivity, plus a
  free-form prompt.
- **Full system access** – by default she may run anything your user account may. Cautious users can require
  confirmation for destructive actions or switch to read-only (see [Permissions & security](#permissions--security)).

### Screenshots

> _Placeholder – screenshots will follow with the first Windows build._
> `docs/screenshots/overlay.png`, `docs/screenshots/wizard.png`, `docs/screenshots/settings.png`

## Requirements

| | |
| --- | --- |
| OS | Windows 10 / 11 (64-bit). The GUI only runs on Windows; typecheck/tests/build also run on Linux/macOS. |
| Graphics | A GPU with desktop compositing (DWM) and WebGL – any normal PC. Hardware acceleration must stay enabled. |
| Node.js | 22.12 or newer (to build; the installed app does not need Node) |
| Anthropic | An API key from https://console.anthropic.com/settings/keys |
| Fish Audio | An API key from https://fish.audio/app/api-keys (a free TTS model exists) – or a local Fish Speech server |
| Microphone | For push-to-talk (optional – typing always works) |

## Quick start

```powershell
git clone <repo-url> flowy
cd flowy
npm install --legacy-peer-deps      # dependencies (pixi.js 7 + the Live2D plugin need the flag)
npm run setup:live2d                # download Live2D Cubism Core + sample model (asks you to accept the licenses)
npm run dev                         # development: starts Electron with hot reload
```

Build installers:

```powershell
npm run dist              # NSIS installer → release/Flowy Setup 0.1.0.exe
npm run dist:portable     # portable EXE → release/
```

`npm run setup:live2d` is idempotent (existing files are skipped), supports `--yes` (or `FLOWY_ACCEPT_LIVE2D=1`) for
scripted installs, `--model Hiyori|Haru|Mao|Natori`, `--force`, `--lang de|en` and `--help`. Without Cubism Core
Flowy tries the official CDN; if that fails too she draws a simple procedural character – she always runs.

## First run: the setup wizard

On first start the settings window opens with a wizard. The same pages exist later as tabs (tray → "Settings…"):

1. **Character** – name, language, du/Sie, personality preset and fine-tuning sliders, custom prompt.
2. **Voice** – Fish Audio API key, search/preview/pick a voice, TTS model, format, volume, speed, output device; test button.
3. **Ears** – speech recognition (Fish Audio / OpenAI-compatible / off), microphone, language hint, silence detection; test recording.
4. **Brain** – Anthropic API key, model, effort; connection test.
5. **Look** – Live2D model (bundled or your own `*.model3.json`), size, start corner, cursor avoidance.
6. **Permissions**, **Hotkeys**, **Behavior** (greeting on start, proactive comments, quiet hours).

Finishing sets `setupCompleted`; the configuration lives in `%APPDATA%\Flowy\config.json` with API keys encrypted via
Windows DPAPI (`safeStorage`).

## Fish Audio setup (cloud voice)

1. Create an account and a key at https://fish.audio/app/api-keys. The key is shared by **TTS and ASR**
   (`tts.fishCloud.apiKey`).
2. Pick a voice: browse https://fish.audio and open a voice – the URL looks like `https://fish.audio/m/<id>`. The
   32-character hex id is the `reference_id`; the wizard accepts the id, the link, or searches by name. Empty = the
   model's default timbre (not stable – always pin an id for a consistent character).
3. Choose a model (`tts.fishCloud.model`):

   | Model | Notes | Price (pricing page, 2026) |
   | --- | --- | --- |
   | `s2.1-pro-free` (default) | current S2.1, **free**, no latency guarantees | $0 |
   | `s2.1-pro` | same with guarantees | $15 per million UTF-8 bytes of text |
   | `s2-pro` | previous generation, 80+ languages | $15 per million UTF-8 bytes |
   | `s1` | legacy, 13 languages, emotions in `(parentheses)` | $15 per million UTF-8 bytes |

   Billing is per UTF-8 byte (umlauts count twice). Unknown model names silently fall back to the **paid** `s2.1-pro`
   on the server – which is why Flowy only allows the names above. Credits: https://fish.audio/app/developers/billing/.
   Rate limits are **concurrent** requests (5 below $100 prepaid); Flowy aborts stale requests on interrupt and
   synthesizes with bounded concurrency.
4. Emotions: Flowy translates the `[[emotion]]` markers in a reply into Fish cues (`[happy] …` for S2, `(happy) …`
   for S1). Toggle with `tts.emotionCues`.
5. Optional **voice cloning**: 10–30 s of clean speech (wav/mp3) plus the exact transcript (`tts.fishCloud.cloneSample`).
6. **Speech recognition (ASR)**: provider `fish-cloud` uses the same key with model `transcribe-1` ($0.36 per audio
   hour, rounded to the second) – practically free for short push-to-talk clips.

## Local Fish Speech server (offline voice)

The open-source Fish Speech server speaks the same `/v1/tts` API. The realistic model for consumer GPUs is **S1-mini**
(0.5 B parameters, ~3.6 GB of weights, licensed CC-BY-NC-SA 4.0 = non-commercial). The current `main` branch is Fish
Speech 2 (S2-Pro, 24 GB VRAM) and **cannot** load S1-mini, so pin the last S1-era commit:

```powershell
git clone https://github.com/fishaudio/fish-speech.git
cd fish-speech
git checkout d3df50503b36314a964f66cac1af1e19e95bcfa3     # last S1-era commit (2026-01-08)
uv sync --python 3.12 --extra cu128                         # cu126 | cu128 | cu129 (RTX 50xx needs cu128/cu129)

# weights (gated: accept the terms at https://huggingface.co/fishaudio/s1-mini, then log in)
uv tool install "huggingface_hub[cli]"
hf auth login
hf download fishaudio/s1-mini --local-dir checkpoints/openaudio-s1-mini

# start the server – always from the repo root (references/ and .project-root are resolved relative to it)
uv run tools/api_server.py --listen 127.0.0.1:8080 `
  --llama-checkpoint-path checkpoints/openaudio-s1-mini `
  --decoder-checkpoint-path checkpoints/openaudio-s1-mini/codec.pth `
  --decoder-config-name modded_dac_vq
```

In Flowy: Voice → provider **Local Fish Speech server**, base URL `http://127.0.0.1:8080`, format **wav** (the
server only produces wav/mp3; pcm/opus fail), `referenceId` = a folder name under the server's `references/`
(optional), API key only if the server was started with `--api-key`. Flowy pings `GET /v1/health`.

Notes: `--half` for GPUs without bf16 (GTX 10xx/16xx, RTX 20xx); `--compile` does not work on Windows (Triton);
without compile S1-mini is roughly real-time on RTX 30/40 cards. The local server has **no** speech recognition – use
Fish Audio cloud or an OpenAI-compatible endpoint for that. Emotion cues are sent in the S1 `(parenthesis)` style automatically.

## Anthropic API key (the brain)

Create a key at https://console.anthropic.com/settings/keys and enter it in the wizard (Brain, `llm.apiKey`). The
default model is `claude-opus-5-5` (`llm.model`), effort `llm.effort` = low/medium/high. The system prompt is kept
stable on purpose (prompt caching); time, active window and screenshot go into the user message.
`llm.refusalFallback` (on) lets the API re-route a declined request to a fallback model server-side.
`llm.maxHistoryTurns` (60) and `llm.maxToolIterations` (25) bound the context and tool loops.

## Speech recognition: alternatives to Fish

Provider `openai-compatible` (`stt.openaiCompatible`) posts to `<baseUrl>/audio/transcriptions` (multipart, 16 kHz mono wav):

| Service | Base URL | Model | Key |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` | https://platform.openai.com/api-keys |
| Groq | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo`, `whisper-large-v3` | https://console.groq.com/keys |
| speaches / faster-whisper-server | `http://127.0.0.1:8000/v1` | e.g. `Systran/faster-whisper-small` | none |
| whisper.cpp server | `http://127.0.0.1:8080/v1` (with `--inference-path /v1/audio/transcriptions`) | any | none |
| LocalAI | `http://127.0.0.1:8080/v1` | `whisper-1` | none |

A pasted full endpoint is normalised to `/v1`; without a key no `Authorization` header is sent. `stt.language` is a
hint (empty = auto), `stt.silenceTimeoutMs` (1400) stops recording after silence, `stt.maxRecordingMs` (30000) is the
hard cap. Provider `none` disables push-to-talk (chat keeps working).

## Hotkeys

| Action | Default | Meaning |
| --- | --- | --- |
| Push-to-talk | `Ctrl+Shift+Space` | press once: listen; again: stop (also auto-stops after silence). While she speaks/thinks: interrupt and listen. |
| Toggle visibility | `Ctrl+Shift+H` | hide/show her (also in the tray) |
| Open chat | `Ctrl+Shift+Enter` | text input in the speech bubble |
| Interrupt | _(empty = off)_ | a global `Escape` would steal Escape from every app, hence empty. Recommended: `Ctrl+Shift+Escape`. Push-to-talk and the bubble always interrupt too. |
| Touch her | hold `Ctrl` | while held (`avatar.avoidance.holdKeyToInteract`) she does not flee, can be clicked (chat) and pinned via the context menu |

Hotkeys are Electron accelerator strings (`hotkeys.*`). If a combination is taken by another app Flowy reports it in
the log and the settings – just pick another one.

## Screen awareness & privacy

- `screenAwareness.mode`: **always** (default – every question carries a screenshot), **on-demand** (only when the
  question sounds like it is about the screen, or when she uses the `take_screenshot` tool) or **off**.
- Screenshots are downscaled before sending (long edge `maxLongEdge` = 1280 px, JPEG quality 70) and put into the user
  message together with the active window title (`includeActiveWindow`). They go **only to the Anthropic API** – never to Fish Audio.
- The conversation history is stored locally in `%APPDATA%\Flowy\history.json` – **without** screenshots: an image is
  only sent with the turn that took it and is then replaced (in memory and on disk) by the placeholder
  `[Screenshot was attached]`. Tray → "Clear history" empties the history. Long-term notes (`remember`/`recall`) live
  in `memory.json`, logs in `logs\flowy.log`.
- Push-to-talk audio only goes to the chosen STT service and is not stored.
- Proactive comments (`behavior.proactive`, default **off**) take a screenshot periodically – with quiet hours.
- For sensitive work choose mode **off**. Hiding her does **not** switch screen awareness off.
- Screenshots and web pages are untrusted content (prompt injection). Flowy marks them as data, but with full system
  access the next section applies.

## Permissions & security

Flowy is powerful on purpose: **"full access" means she can run anything your user account can** – PowerShell
commands, writing and deleting files (to the Recycle Bin), launching and closing apps, typing and clicking, setting the
clipboard, volume/brightness, locking, sleep, shutdown.

| `permissions.level` | Behaviour |
| --- | --- |
| `full` (default) | every tool without asking |
| `confirm-destructive` | destructive tools (shell, write/delete/move, close window, input, set clipboard, power) show a Yes/No prompt in the bubble; no answer within 60 s = No. **Recommended for cautious users.** |
| `read-only` | read-only tools only (read files, list windows, screenshot, web, notes) |

Categories can be switched off individually: `allowShell`, `allowFiles`, `allowScreenshots`, `allowWeb`, `allowInput`
(keyboard/mouse), `allowPower` (lock/sleep/shutdown).

- **Restart as administrator** (tray menu): Flowy normally runs with user rights (`asInvoker`). This entry relaunches
  her elevated with a UAC prompt so she can touch services, firewall, etc. Only if you really want that.
- Windows integration runs through a persistent PowerShell host (`resources/ps/flowy-host.ps1`) – a readable script
  file, not an encoded blob. Anti-virus products that block `Add-Type` only take the typed tools away.
- API keys are encrypted with DPAPI and delivered in clear text only to the settings window, never to the overlay.
- The renderer is sandboxed (`contextIsolation`, whitelisted IPC); only microphone, speaker selection and clipboard are granted.

## Live2D models

- **Bundled sample model**: `npm run setup:live2d` downloads an official Live2D sample (default **Hiyori**;
  `--model Haru|Mao|Natori`) into `resources/models/default/` under the
  [Live2D Free Material License](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)
  (individuals and small businesses below 10 million JPY annual sales; no redistribution of the raw model files, no
  design alterations; Natori non-commercial only). Required credit, also shown on the About page:

  > This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with
  > conditions and terms set by Live2D Inc.

- **Your own model**: Look → "Live2D model" → pick a `*.model3.json` (`avatar.modelPath`). Its folder is served via the
  internal `flowy-model://` protocol (no path traversal). Cubism 3/4/5 (`.moc3`) is supported, Cubism 2.1
  (`.model.json`) is not. Lip sync uses the model's `LipSync` group (`ParamMouthOpenY`, `ParamA` for Mao); emotions are
  mapped to existing expressions/motion groups and missing ones are ignored. Models from nizima/Booth carry their own
  licenses – read them; game rips are off limits.
- **Cubism Core** (`src/renderer/public/vendor/live2dcubismcore.min.js`) is proprietary ("Redistributable Code" under
  the Live2D Proprietary Software License); the setup script verifies the license header and leaves it intact.
- **"Expandable Application" caveat**: the free use of the Live2D SDK for individuals/small businesses does **not**
  apply (EULA §1.5, §2.2) to applications that "use an indefinite number of models by adding files" (avatar/streaming
  apps). Because Flowy can load a custom model it might fall into that category. For private use with the bundled model
  this is a non-issue; if you publish Flowy or use it commercially, clarify with Live2D
  (https://www.live2d.com/en/download/cubism-sdk/release-license/). Details in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Troubleshooting

| Problem | Cause / fix |
| --- | --- |
| Black or opaque window instead of a transparent character | Transparent windows need DWM compositing and the GPU. Update the graphics driver, keep hardware acceleration on (never pass `--disable-gpu`), do not test through Remote Desktop without a GPU. The overlay is intentionally not resizable/maximizable. |
| Microphone "blocked" / nothing recorded | Windows Settings → Privacy & security → Microphone: allow access **and** enable "Let desktop apps access your microphone". Pick the right device in Flowy (`stt.inputDeviceId`). Flowy requests audio only, never video. |
| Hotkey does nothing | The combination is taken by another app (Flowy logs "failed") – choose a different one in the settings. Same key for two actions: the first wins. |
| Transparency breaks as soon as DevTools open | Known Electron limitation: never dock DevTools to the overlay. Debug via the settings window or start Electron with `--remote-debugging-port=9222` and open `chrome://inspect` in a browser. |
| "Fish Audio API key invalid" / "out of credits" | Check the key (fish.audio/app/api-keys) and credits (fish.audio/app/developers/billing); `s2.1-pro-free` is free. |
| "Fish Speech server unreachable" | Start the server from the repo root, check port/URL; the port stays closed until the models are loaded (`/v1/health`). |
| Subtitles but no voice | TTS provider `none`? Check the output device (`tts.outputDeviceId`), un-mute in the tray. |
| Only the simple fallback character, no Live2D | `npm run setup:live2d` was not run and the CDN fallback has no network; wrong model path (log: "no Live2D model found"). |
| She answers "I can't help with that" | Keep `llm.refusalFallback` on; enable the tool category under Permissions. |
| Reset everything | Quit Flowy, delete `%APPDATA%\Flowy\config.json` (and optionally `history.json`, `memory.json`). |

Logs: `%APPDATA%\Flowy\logs\flowy.log` (rotated at 5 MB).

## Development

Development is Linux-friendly – only the GUI needs Windows:

```bash
npm install --legacy-peer-deps
npm run typecheck        # tsc for main/preload (Node) and renderer (DOM)
npm test                 # vitest, electron is aliased to tests/mocks/electron.ts
npm run build            # electron-vite build → out/
npm run setup:live2d -- --yes --lang en   # non-interactive
node scripts/setup-live2d.mjs --help
```

- Project layout, processes, the turn pipeline and module contracts: [ARCHITECTURE.md](ARCHITECTURE.md).
- Pure logic (positioning, parsers, state machines, the manifest walker of the setup script) has unit tests next to the
  file; the scripts in `scripts/` are tested with `npx vitest run scripts`.
- Icons: `resources/icon.svg` is the source. Re-rasterize with ffmpeg (librsvg) + ImageMagick:
  `ffmpeg -width 512 -height 512 -i resources/icon.svg -pix_fmt rgba resources/icon.png`, then combine the ICO sizes
  (256/128/64/48/32/16, or 32/16 for `tray.ico`) with `convert … icon.ico`.
- Conventions: TypeScript strict, named exports, factory functions, `createLogger(scope)` in the main process, German as
  the default UI language with English as the alternative.

## License

Flowy itself is MIT-licensed. Live2D Cubism Core, the sample models, Fish Audio/Fish Speech and Anthropic are subject
to their own terms – see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
