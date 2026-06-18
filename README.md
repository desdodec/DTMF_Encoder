# Cycle Gait Audio Tagger

Single-page browser utility for field registration and DTMF audio tagging.

## Run

Run a local static server from this folder, then open the shown local URL:

```powershell
python -m http.server 8765 --bind 127.0.0.1
```

Open `http://127.0.0.1:8765/` in a browser. The app stores records in `localStorage`, so registration history persists for the same browser profile after refreshing or reopening the page.

## Test Online With GitHub Pages

This project is ready to run as a static GitHub Pages site. After pushing the
project to `desdodec/DTMF_Encoder`:

1. Open the repository on GitHub and select **Settings > Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**.
3. Select the `main` branch and the `/ (root)` folder, then select **Save**.
4. Wait for the Pages deployment to finish, then open:
   `https://desdodec.github.io/DTMF_Encoder/`

Test registration and tone playback from a desktop or mobile browser. Browser
audio policies require the transmission to start from a user action, so use the
**Register & Transmit** or **Replay Tone** button. Records remain local to each
browser and device; GitHub does not receive the participant records.

The decoder is available at:
`https://desdodec.github.io/DTMF_Encoder/decoder.html`

## Behavior

- Registers a validated first name as uppercase text.
- Assigns the next zero-padded subject ID from existing local records.
- Saves `{ id, name, timestamp }` to browser storage.
- Transmits the DTMF frame `*IDANAMEBTIMESTAMP#` through the Web Audio API. `NAME` is encoded as two-digit `A=01` through `Z=26` values, and `TIMESTAMP` is Unix milliseconds.
- Uses 80ms tones, 30ms inter-tone gaps, and maximum gain 0.25.
- Exports local records to `gait_session_export_YYYY-MM-DD.csv`.
- Resets local records only after a browser confirmation dialog.
- Generates a vCard QR code for the most recently registered subject after a contact email is saved.

## vCard QR

Set the QR contact name and email in the Session Data panel. After each registration, the app generates a QR code containing a vCard with:

- contact display name
- contact email
- subject ID in the vCard note

The QR contains no participant name.

## Name Predictor

The predictor loads `names.json`, generated from the files in `names_data`, and shows ranked prefix matches as the first name is typed. Rebuild it after changing the source files:

```powershell
python tools\build_names_json.py
```

## DTMF Decoder

Decode recordings from the command line:

```powershell
python -B decode_dtmf.py audio
```

Open the desktop decoder GUI:

```powershell
python -B decode_dtmf_gui.py
```

The GUI lets you choose an audio file or folder, decode in the background, inspect the raw/framed payload, and save results as JSON.

Or use the browser decoder at `http://127.0.0.1:8765/decoder.html`. It runs locally in the browser, accepts drag/drop audio, and shows the waveform plus detected DTMF timeline.
