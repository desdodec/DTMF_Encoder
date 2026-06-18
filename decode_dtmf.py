from __future__ import annotations

import argparse
import json
import math
import subprocess
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np


ROOT = Path(__file__).resolve().parent
TEMP_ROOT = Path("C:/tmp")
DTMF_ROWS = [697, 770, 852, 941]
DTMF_COLS = [1209, 1336, 1477, 1633]
DTMF_SYMBOLS = {
    (697, 1209): "1",
    (697, 1336): "2",
    (697, 1477): "3",
    (697, 1633): "A",
    (770, 1209): "4",
    (770, 1336): "5",
    (770, 1477): "6",
    (770, 1633): "B",
    (852, 1209): "7",
    (852, 1336): "8",
    (852, 1477): "9",
    (852, 1633): "C",
    (941, 1209): "*",
    (941, 1336): "0",
    (941, 1477): "#",
    (941, 1633): "D",
}


@dataclass
class ToneFrame:
    index: int
    start_seconds: float
    end_seconds: float
    symbol: str
    row_hz: int
    col_hz: int
    confidence: float


def extract_wav(input_path: Path, wav_path: Path, sample_rate: int) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-sample_fmt",
        "s16",
        str(wav_path),
    ]
    subprocess.run(command, check=True)


def read_wav_mono(path: Path) -> tuple[int, np.ndarray]:
    with wave.open(str(path), "rb") as wav:
        sample_rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())
        channels = wav.getnchannels()
        width = wav.getsampwidth()

    if width != 2:
        raise ValueError(f"Expected 16-bit PCM WAV, got sample width {width}.")

    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float64)
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)

    peak = np.max(np.abs(audio)) if audio.size else 0
    if peak > 0:
        audio = audio / peak

    return sample_rate, audio


def classify_window(
    samples: np.ndarray,
    window_values: np.ndarray,
    goertzel_coefficients: dict[int, tuple[float, float]],
) -> tuple[str | None, int, int, float]:
    windowed = samples * window_values
    row_powers = {freq: goertzel_power(windowed, *goertzel_coefficients[freq]) for freq in DTMF_ROWS}
    col_powers = {freq: goertzel_power(windowed, *goertzel_coefficients[freq]) for freq in DTMF_COLS}

    row_sorted = sorted(row_powers.items(), key=lambda item: item[1], reverse=True)
    col_sorted = sorted(col_powers.items(), key=lambda item: item[1], reverse=True)
    row_freq, row_power = row_sorted[0]
    col_freq, col_power = col_sorted[0]
    row_next = row_sorted[1][1] if len(row_sorted) > 1 else 1e-12
    col_next = col_sorted[1][1] if len(col_sorted) > 1 else 1e-12

    signal_power = max(row_power + col_power, 1e-12)
    total_power = max(sum(row_powers.values()) + sum(col_powers.values()), 1e-12)
    separation = min(row_power / max(row_next, 1e-12), col_power / max(col_next, 1e-12))
    dominance = signal_power / total_power
    confidence = min(separation / 4.0, 1.0) * dominance

    if separation < 2.2 or dominance < 0.45:
        return None, row_freq, col_freq, confidence

    return DTMF_SYMBOLS[(row_freq, col_freq)], row_freq, col_freq, confidence


def make_goertzel_coefficients(sample_rate: int, window_size: int) -> dict[int, tuple[float, float]]:
    coefficients = {}
    for frequency in DTMF_ROWS + DTMF_COLS:
        bin_index = round(window_size * frequency / sample_rate)
        omega = 2.0 * math.pi * bin_index / window_size
        coefficients[frequency] = (2.0 * math.cos(omega), math.cos(omega))
    return coefficients


def goertzel_power(samples: np.ndarray, coefficient: float, cosine: float) -> float:
    previous = 0.0
    previous_previous = 0.0
    for sample in samples:
        current = float(sample) + coefficient * previous - previous_previous
        previous_previous = previous
        previous = current
    return previous_previous * previous_previous + previous * previous - coefficient * previous * previous_previous


def classify_frames_vectorized(
    audio: np.ndarray,
    sample_rate: int,
    window_size: int,
    hop_size: int,
) -> list[tuple[int, str | None, int | None, int | None, float]]:
    if len(audio) < window_size:
        return []

    starts = np.arange(0, len(audio) - window_size + 1, hop_size)
    windows = np.lib.stride_tricks.sliding_window_view(audio, window_size)[::hop_size]
    windowed = windows * np.hanning(window_size)
    rms = np.sqrt(np.mean(windowed * windowed, axis=1))
    spectrum = np.abs(np.fft.rfft(windowed, axis=1)) ** 2
    bins = np.fft.rfftfreq(window_size, 1.0 / sample_rate)
    frequency_bins = [int(np.argmin(np.abs(bins - frequency))) for frequency in DTMF_ROWS + DTMF_COLS]
    powers = spectrum[:, frequency_bins]
    row_powers = powers[:, : len(DTMF_ROWS)]
    col_powers = powers[:, len(DTMF_ROWS) :]
    rows = np.array(DTMF_ROWS)
    cols = np.array(DTMF_COLS)

    row_order = np.argsort(row_powers, axis=1)
    col_order = np.argsort(col_powers, axis=1)
    row_best = row_order[:, -1]
    row_second = row_order[:, -2]
    col_best = col_order[:, -1]
    col_second = col_order[:, -2]

    frame_indexes = np.arange(len(starts))
    row_power = row_powers[frame_indexes, row_best]
    row_next = row_powers[frame_indexes, row_second]
    col_power = col_powers[frame_indexes, col_best]
    col_next = col_powers[frame_indexes, col_second]
    signal_power = np.maximum(row_power + col_power, 1e-12)
    total_power = np.maximum(np.sum(powers, axis=1), 1e-12)
    separation = np.minimum(row_power / np.maximum(row_next, 1e-12), col_power / np.maximum(col_next, 1e-12))
    dominance = signal_power / total_power
    confidence = np.minimum(separation / 4.0, 1.0) * dominance

    classifications: list[tuple[int, str | None, int | None, int | None, float]] = []
    for index, start in enumerate(starts):
        if rms[index] < 0.01 or separation[index] < 2.2 or dominance[index] < 0.45:
            classifications.append((int(start), None, None, None, 0.0))
            continue

        row_freq = int(rows[row_best[index]])
        col_freq = int(cols[col_best[index]])
        classifications.append(
            (
                int(start),
                DTMF_SYMBOLS[(row_freq, col_freq)],
                row_freq,
                col_freq,
                float(confidence[index]),
            )
        )
    return classifications


def decode_audio(
    audio: np.ndarray,
    sample_rate: int,
    window_ms: float,
    hop_ms: float,
    min_tone_ms: float,
) -> list[ToneFrame]:
    window_size = max(1, int(sample_rate * window_ms / 1000.0))
    hop_size = max(1, int(sample_rate * hop_ms / 1000.0))
    min_frames = max(1, int(math.ceil(min_tone_ms / hop_ms)))

    classifications = classify_frames_vectorized(audio, sample_rate, window_size, hop_size)

    tones: list[ToneFrame] = []
    run_symbol = None
    run_start = 0
    run_items = []

    def flush_run() -> None:
        nonlocal run_symbol, run_start, run_items
        if not run_symbol or len(run_items) < min_frames:
            run_symbol = None
            run_items = []
            return

        starts = [item[0] for item in run_items]
        row_votes = [item[2] for item in run_items]
        col_votes = [item[3] for item in run_items]
        confidence = float(np.mean([item[4] for item in run_items]))
        row_freq = max(set(row_votes), key=row_votes.count)
        col_freq = max(set(col_votes), key=col_votes.count)
        start_seconds = starts[0] / sample_rate
        end_seconds = (starts[-1] + window_size) / sample_rate
        tones.append(
          ToneFrame(
              index=len(tones) + 1,
              start_seconds=start_seconds,
              end_seconds=end_seconds,
              symbol=run_symbol,
              row_hz=row_freq,
              col_hz=col_freq,
              confidence=confidence,
          )
        )
        run_symbol = None
        run_items = []

    for item in classifications:
        symbol = item[1]
        if symbol == run_symbol:
            if symbol:
                run_items.append(item)
            continue

        flush_run()
        if symbol:
            run_symbol = symbol
            run_start = item[0]
            run_items = [item]

    flush_run()

    return tones


def merge_adjacent_tones(tones: list[ToneFrame]) -> list[ToneFrame]:
    if not tones:
        return []

    merged = [tones[0]]
    for tone in tones[1:]:
        previous = merged[-1]
        gap = tone.start_seconds - previous.end_seconds
        if tone.symbol == previous.symbol and gap < 0.04:
            previous.end_seconds = tone.end_seconds
            previous.confidence = max(previous.confidence, tone.confidence)
            continue
        tone.index = len(merged) + 1
        merged.append(tone)
    return merged


def decode_record_payload(framed_payload: str) -> dict[str, str]:
    body = framed_payload[1:-1]
    name_marker = body.find("A")
    timestamp_marker = body.find("B", name_marker + 1)
    if name_marker == -1 or timestamp_marker == -1:
        return {"id": normalize_subject_id(body), "name": "Not encoded", "timestamp": "Not encoded"}

    return {
        "id": normalize_subject_id(body[:name_marker]),
        "name": decode_name(body[name_marker + 1 : timestamp_marker]),
        "timestamp": decode_timestamp(body[timestamp_marker + 1 :]),
    }


def normalize_subject_id(value: str) -> str:
    return value.zfill(3) if value.isdigit() and len(value) < 3 else value


def decode_name(encoded: str) -> str:
    if not encoded.isdigit() or len(encoded) % 2 != 0:
        return ""

    letters = []
    for index in range(0, len(encoded), 2):
        code = int(encoded[index : index + 2])
        if code < 1 or code > 26:
            return ""
        letters.append(chr(64 + code))
    return "".join(letters)


def decode_timestamp(encoded: str) -> str:
    if not encoded.isdigit():
        return ""

    timestamp = datetime.fromtimestamp(int(encoded) / 1000, timezone.utc)
    return timestamp.isoformat().replace("+00:00", "Z")


def decode_file(path: Path, sample_rate: int, window_ms: float, hop_ms: float, min_tone_ms: float) -> dict:
    if path.suffix.lower() == ".wav":
        actual_rate, audio = read_wav_mono(path)
    else:
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=TEMP_ROOT) as tmp_dir:
            wav_path = Path(tmp_dir) / "audio.wav"
            extract_wav(path, wav_path, sample_rate)
            actual_rate, audio = read_wav_mono(wav_path)

    tones = decode_audio(audio, actual_rate, window_ms, hop_ms, min_tone_ms)
    payload = "".join(tone.symbol for tone in tones)
    framed_payload = ""
    decoded_record = {"id": "", "name": "", "timestamp": ""}
    if payload.startswith("*") and "#" in payload[1:]:
        end_index = payload.index("#", 1)
        framed_payload = payload[: end_index + 1]
        decoded_record = decode_record_payload(framed_payload)

    return {
        "file": str(path),
        "sampleRate": actual_rate,
        "durationSeconds": round(len(audio) / actual_rate, 3),
        "payload": payload,
        "framedPayload": framed_payload,
        "subjectId": decoded_record["id"],
        "subjectName": decoded_record["name"],
        "subjectTimestamp": decoded_record["timestamp"],
        "tones": [
            {
                "index": tone.index,
                "symbol": tone.symbol,
                "startSeconds": round(tone.start_seconds, 3),
                "endSeconds": round(tone.end_seconds, 3),
                "rowHz": tone.row_hz,
                "colHz": tone.col_hz,
                "confidence": round(tone.confidence, 3),
            }
            for tone in tones
        ],
    }


def find_audio_files(path: Path) -> list[Path]:
    extensions = {".wav", ".mp3", ".m4a", ".mp4", ".aac", ".flac", ".ogg"}
    if path.is_file():
        return [path]
    return sorted(item for item in path.rglob("*") if item.is_file() and item.suffix.lower() in extensions)


def main() -> None:
    parser = argparse.ArgumentParser(description="Decode DTMF subject payloads from audio recordings.")
    parser.add_argument("path", nargs="?", default="audio", help="Audio file or folder to decode.")
    parser.add_argument("--sample-rate", type=int, default=8000, help="Temporary mono WAV sample rate.")
    parser.add_argument("--window-ms", type=float, default=20.0, help="Analysis window in milliseconds.")
    parser.add_argument("--hop-ms", type=float, default=5.0, help="Analysis hop in milliseconds.")
    parser.add_argument("--min-tone-ms", type=float, default=25.0, help="Minimum accepted tone run in milliseconds.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    args = parser.parse_args()

    audio_files = find_audio_files(Path(args.path))
    results = [
        decode_file(path, args.sample_rate, args.window_ms, args.hop_ms, args.min_tone_ms)
        for path in audio_files
    ]

    if args.json:
        print(json.dumps({"processed": len(results), "results": results}, indent=2))
        return

    print(f"Processed audio files: {len(results)}")
    for result in results:
        print()
        print(result["file"])
        print(f"  duration: {result['durationSeconds']}s")
        print(f"  raw_payload: {result['payload'] or '(none)'}")
        print(f"  framed_payload: {result['framedPayload'] or '(none)'}")
        print(f"  subject_id: {result['subjectId'] or '(none)'}")
        print(f"  subject_name: {result['subjectName'] or '(none)'}")
        print(f"  subject_timestamp: {result['subjectTimestamp'] or '(none)'}")
        for tone in result["tones"]:
            print(
                "  {index}. {symbol} {startSeconds:.3f}-{endSeconds:.3f}s "
                "({rowHz}+{colHz} Hz, confidence {confidence:.3f})".format(**tone)
            )


if __name__ == "__main__":
    main()
