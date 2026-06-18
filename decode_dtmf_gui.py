from __future__ import annotations

import json
import queue
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from decode_dtmf import decode_file, find_audio_files


class DtmfDecoderGui(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("DTMF Audio Decoder")
        self.geometry("980x680")
        self.minsize(820, 560)

        self.result_queue: queue.Queue[tuple[str, object]] = queue.Queue()
        self.results: list[dict] = []
        self.selected_path = tk.StringVar(value=str(Path("audio").resolve()))
        self.status_text = tk.StringVar(value="Choose an audio file or folder, then decode.")

        self.sample_rate = tk.IntVar(value=8000)
        self.window_ms = tk.DoubleVar(value=20.0)
        self.hop_ms = tk.DoubleVar(value=5.0)
        self.min_tone_ms = tk.DoubleVar(value=25.0)

        self.create_widgets()
        self.after(100, self.poll_queue)

    def create_widgets(self) -> None:
        self.columnconfigure(0, weight=1)
        self.rowconfigure(2, weight=1)

        top = ttk.Frame(self, padding=12)
        top.grid(row=0, column=0, sticky="ew")
        top.columnconfigure(1, weight=1)

        ttk.Label(top, text="Audio source").grid(row=0, column=0, sticky="w")
        ttk.Entry(top, textvariable=self.selected_path).grid(row=0, column=1, sticky="ew", padx=8)
        ttk.Button(top, text="File", command=self.choose_file).grid(row=0, column=2, padx=(0, 6))
        ttk.Button(top, text="Folder", command=self.choose_folder).grid(row=0, column=3)

        controls = ttk.Frame(self, padding=(12, 0, 12, 8))
        controls.grid(row=1, column=0, sticky="ew")
        for column in range(10):
            controls.columnconfigure(column, weight=0)
        controls.columnconfigure(9, weight=1)

        ttk.Label(controls, text="Sample rate").grid(row=0, column=0, sticky="w")
        ttk.Spinbox(controls, from_=4000, to=48000, increment=1000, textvariable=self.sample_rate, width=8).grid(row=0, column=1, padx=(6, 14))
        ttk.Label(controls, text="Window ms").grid(row=0, column=2, sticky="w")
        ttk.Spinbox(controls, from_=20, to=120, increment=5, textvariable=self.window_ms, width=6).grid(row=0, column=3, padx=(6, 14))
        ttk.Label(controls, text="Hop ms").grid(row=0, column=4, sticky="w")
        ttk.Spinbox(controls, from_=2, to=40, increment=1, textvariable=self.hop_ms, width=6).grid(row=0, column=5, padx=(6, 14))
        ttk.Label(controls, text="Min tone ms").grid(row=0, column=6, sticky="w")
        ttk.Spinbox(controls, from_=10, to=100, increment=5, textvariable=self.min_tone_ms, width=6).grid(row=0, column=7, padx=(6, 14))
        ttk.Button(controls, text="Decode", command=self.start_decode).grid(row=0, column=8, padx=(0, 6))
        ttk.Button(controls, text="Save JSON", command=self.save_json).grid(row=0, column=9, sticky="w")

        main = ttk.PanedWindow(self, orient=tk.HORIZONTAL)
        main.grid(row=2, column=0, sticky="nsew", padx=12, pady=(0, 8))

        list_frame = ttk.Frame(main)
        list_frame.columnconfigure(0, weight=1)
        list_frame.rowconfigure(0, weight=1)
        self.result_tree = ttk.Treeview(
            list_frame,
            columns=("subject", "name", "timestamp", "framed", "duration"),
            show="headings",
            selectmode="browse",
        )
        self.result_tree.heading("subject", text="Subject ID")
        self.result_tree.heading("name", text="Name")
        self.result_tree.heading("timestamp", text="Timestamp")
        self.result_tree.heading("framed", text="Framed Payload")
        self.result_tree.heading("duration", text="Duration")
        self.result_tree.column("subject", width=90, anchor="center")
        self.result_tree.column("name", width=110, anchor="center")
        self.result_tree.column("timestamp", width=170, anchor="center")
        self.result_tree.column("framed", width=180, anchor="center")
        self.result_tree.column("duration", width=80, anchor="center")
        self.result_tree.grid(row=0, column=0, sticky="nsew")
        self.result_tree.bind("<<TreeviewSelect>>", self.show_selected_result)

        list_scroll = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.result_tree.yview)
        self.result_tree.configure(yscrollcommand=list_scroll.set)
        list_scroll.grid(row=0, column=1, sticky="ns")
        main.add(list_frame, weight=1)

        detail_frame = ttk.Frame(main)
        detail_frame.columnconfigure(0, weight=1)
        detail_frame.rowconfigure(0, weight=1)
        self.detail_text = tk.Text(detail_frame, wrap="word", height=20, font=("Consolas", 10))
        self.detail_text.grid(row=0, column=0, sticky="nsew")
        detail_scroll = ttk.Scrollbar(detail_frame, orient=tk.VERTICAL, command=self.detail_text.yview)
        self.detail_text.configure(yscrollcommand=detail_scroll.set)
        detail_scroll.grid(row=0, column=1, sticky="ns")
        main.add(detail_frame, weight=2)

        status = ttk.Frame(self, padding=(12, 0, 12, 12))
        status.grid(row=3, column=0, sticky="ew")
        status.columnconfigure(0, weight=1)
        ttk.Label(status, textvariable=self.status_text).grid(row=0, column=0, sticky="w")

    def choose_file(self) -> None:
        path = filedialog.askopenfilename(
            title="Choose audio file",
            filetypes=[
                ("Audio files", "*.wav *.mp3 *.m4a *.mp4 *.aac *.flac *.ogg"),
                ("All files", "*.*"),
            ],
        )
        if path:
            self.selected_path.set(path)

    def choose_folder(self) -> None:
        path = filedialog.askdirectory(title="Choose audio folder")
        if path:
            self.selected_path.set(path)

    def start_decode(self) -> None:
        source = Path(self.selected_path.get())
        audio_files = find_audio_files(source)
        if not audio_files:
            messagebox.showwarning("No audio files", "No supported audio files were found.")
            return

        self.results = []
        for item in self.result_tree.get_children():
            self.result_tree.delete(item)
        self.detail_text.delete("1.0", tk.END)
        self.status_text.set(f"Decoding {len(audio_files)} audio file(s)...")

        worker = threading.Thread(target=self.decode_worker, args=(audio_files,), daemon=True)
        worker.start()

    def decode_worker(self, audio_files: list[Path]) -> None:
        processed = 0
        skipped = []
        for path in audio_files:
            try:
                result = decode_file(
                    path,
                    self.sample_rate.get(),
                    self.window_ms.get(),
                    self.hop_ms.get(),
                    self.min_tone_ms.get(),
                )
                self.result_queue.put(("result", result))
                processed += 1
            except Exception as error:
                skipped.append({"file": str(path), "reason": str(error)})
                self.result_queue.put(("skip", skipped[-1]))

        self.result_queue.put(("done", {"processed": processed, "skipped": skipped}))

    def poll_queue(self) -> None:
        try:
            while True:
                kind, payload = self.result_queue.get_nowait()
                if kind == "result":
                    self.add_result(payload)  # type: ignore[arg-type]
                elif kind == "skip":
                    skipped = payload  # type: ignore[assignment]
                    self.detail_text.insert(tk.END, f"Skipped {skipped['file']}\nReason: {skipped['reason']}\n\n")
                elif kind == "done":
                    summary = payload  # type: ignore[assignment]
                    skipped_count = len(summary["skipped"])
                    self.status_text.set(
                        f"Processed {summary['processed']} audio file(s); skipped {skipped_count}."
                    )
        except queue.Empty:
            pass
        self.after(100, self.poll_queue)

    def add_result(self, result: dict) -> None:
        self.results.append(result)
        item_id = str(len(self.results) - 1)
        self.result_tree.insert(
            "",
            tk.END,
            iid=item_id,
            values=(
                result.get("subjectId") or "",
                result.get("subjectName") or "",
                result.get("subjectTimestamp") or "",
                result.get("framedPayload") or "",
                f"{result.get('durationSeconds', 0)}s",
            ),
        )
        self.result_tree.selection_set(item_id)
        self.result_tree.focus(item_id)
        self.show_result(result)

    def show_selected_result(self, _event: object = None) -> None:
        selection = self.result_tree.selection()
        if not selection:
            return
        self.show_result(self.results[int(selection[0])])

    def show_result(self, result: dict) -> None:
        lines = [
            f"File: {result['file']}",
            f"Duration: {result['durationSeconds']}s",
            f"Raw payload: {result.get('payload') or '(none)'}",
            f"Framed payload: {result.get('framedPayload') or '(none)'}",
            f"Subject ID: {result.get('subjectId') or '(none)'}",
            f"Subject name: {result.get('subjectName') or '(none)'}",
            f"Subject timestamp: {result.get('subjectTimestamp') or '(none)'}",
            "",
            "Tones:",
        ]
        for tone in result["tones"]:
            lines.append(
                "{index}. {symbol} {startSeconds:.3f}-{endSeconds:.3f}s "
                "({rowHz}+{colHz} Hz, confidence {confidence:.3f})".format(**tone)
            )

        self.detail_text.delete("1.0", tk.END)
        self.detail_text.insert(tk.END, "\n".join(lines))

    def save_json(self) -> None:
        if not self.results:
            messagebox.showinfo("No results", "Decode at least one file before saving JSON.")
            return

        path = filedialog.asksaveasfilename(
            title="Save decode results",
            defaultextension=".json",
            filetypes=[("JSON", "*.json")],
        )
        if not path:
            return

        Path(path).write_text(json.dumps({"results": self.results}, indent=2), encoding="utf-8")
        self.status_text.set(f"Saved JSON: {path}")


def main() -> None:
    app = DtmfDecoderGui()
    app.mainloop()


if __name__ == "__main__":
    main()
