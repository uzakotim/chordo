import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type KeyMode = "maj" | "min";

type ChordEvent = {
  chord: string;
  timestampMs: number;
};

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const KEY_OPTIONS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const NOTE_TO_SEMITONE: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5,
  "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};

// Interval patterns for scales (semitones from root)
const SCALE_INTERVALS = {
  maj: [0, 2, 4, 5, 7, 9, 11],
  min: [0, 2, 3, 5, 7, 8, 10],
};

// Diatonic triad qualities for each step
const DIATONIC_QUALITIES = {
  maj: ["maj", "min", "min", "maj", "maj", "min", "dim"],
  min: ["min", "dim", "maj", "min", "min", "maj", "maj"],
};

// Seventh chord extensions for each step
const SEVENTH_EXTENSIONS = {
  maj: ["maj7", "m7", "m7", "maj7", "7", "m7", "m7b5"],
  min: ["m7", "m7b5", "maj7", "m7", "m7", "maj7", "7"],
};

function buildChordLabel(root: string, quality: string): string {
  // Cleans up labels so they look like "C", "Em", "Bdim", "Cmaj7", etc.
  if (quality === "maj") return root;
  if (quality === "min") return `${root}m`;
  return `${root}${quality}`;
}

function chordToMidiNotes(chord: string): number[] {
  // Basic parsing for midi playback
  let root = chord.substring(0, 1);
  if (chord.charAt(1) === "#" || chord.charAt(1) === "b") {
    root += chord.charAt(1);
  }
  const extension = chord.replace(root, "");

  const rootSemitone = NOTE_TO_SEMITONE[root] ?? 0;
  const base = 60 + rootSemitone;

  // Basic handling for standard triads, variations can be expanded if needed
  let third = 4;
  let fifth = 7;

  if (extension.startsWith("m") || extension.startsWith("dim")) {
    third = 3;
  }
  if (extension.includes("dim") || extension.includes("m7b5")) {
    fifth = 6;
  }

  return [base, base + third, base + fifth];
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function encodeVariableLength(value: number): number[] {
  let buffer = value & 0x7f;
  const result: number[] = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  while (true) {
    result.push(buffer & 0xff);
    if (buffer & 0x80) {
      buffer >>= 8;
    } else {
      break;
    }
  }
  return result;
}

function toBigEndian32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function buildMidiBytes(events: ChordEvent[]): Uint8Array {
  const ticksPerQuarter = 480;
  const ticksPerMillisecond = ticksPerQuarter / 500;
  const noteEvents: Array<{ tick: number; bytes: number[] }> = [];

  noteEvents.push({ tick: 0, bytes: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] });

  events.forEach((event, index) => {
    const startTick = Math.max(0, Math.round(event.timestampMs * ticksPerMillisecond));
    const next = events[index + 1];
    const endMs = next ? next.timestampMs : event.timestampMs + 500;
    const durationTicks = Math.max(120, Math.round((endMs - event.timestampMs) * ticksPerMillisecond));
    const endTick = startTick + durationTicks;

    chordToMidiNotes(event.chord).forEach((note) => {
      noteEvents.push({ tick: startTick, bytes: [0x90, note, 96] });
      noteEvents.push({ tick: endTick, bytes: [0x80, note, 0] });
    });
  });

  noteEvents.sort((a, b) => a.tick - b.tick);

  const trackData: number[] = [];
  let previousTick = 0;

  noteEvents.forEach((event) => {
    const delta = Math.max(0, event.tick - previousTick);
    trackData.push(...encodeVariableLength(delta), ...event.bytes);
    previousTick = event.tick;
  });

  trackData.push(0x00, 0xff, 0x2f, 0x00);

  const headerChunk = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01,
    (ticksPerQuarter >> 8) & 0xff, ticksPerQuarter & 0xff,
  ];

  const trackChunk = [0x4d, 0x54, 0x72, 0x6b, ...toBigEndian32(trackData.length), ...trackData];

  return new Uint8Array([...headerChunk, ...trackChunk]);
}

function App() {
  const [selectedKey, setSelectedKey] = useState("C");
  const [keyMode, setKeyMode] = useState<KeyMode>("maj");
  const [isRecording, setIsRecording] = useState(false);
  const [recordedChords, setRecordedChords] = useState<ChordEvent[]>([]);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);

  // Dynamically calculate scale roots and corresponding chords grid based on the key
  const chordGridRows = useMemo(() => {
    const rootIndex = NOTES.indexOf(selectedKey);
    const intervals = SCALE_INTERVALS[keyMode];
    const triadQualities = DIATONIC_QUALITIES[keyMode];
    const seventhExtensions = SEVENTH_EXTENSIONS[keyMode];

    // Get the 7 scale roots for the selected key
    const scaleRoots = intervals.map((interval) => {
      const idx = (rootIndex + interval) % 12;
      return NOTES[idx];
    });

    // Build functional rows mirroring the Reference Image layout
    const sus2Row = scaleRoots.map((root, i) => (triadQualities[i] === "dim" ? "" : `${root}sus2`));
    const triadRow = scaleRoots.map((root, i) => buildChordLabel(root, triadQualities[i]));
    const sus4Row = scaleRoots.map((root, i) => (triadQualities[i] === "dim" ? "" : `${root}sus4`));
    const seventhRow = scaleRoots.map((root, i) => buildChordLabel(root, seventhExtensions[i]));

    return [sus2Row, triadRow, sus4Row, seventhRow];
  }, [selectedKey, keyMode]);

  async function onChordPress(chord: string) {
    if (!chord) return; // Skip empty layout positions
    await invoke("log_chord_press", { chord, key: selectedKey, keyMode });

    if (!isRecording || recordingStartedAt === null) {
      return;
    }

    setRecordedChords((prev) => [
      ...prev,
      { chord, timestampMs: Date.now() - recordingStartedAt },
    ]);
  }

  function onRecordToggle() {
    if (!isRecording) {
      setRecordedChords([]);
      setRecordingStartedAt(Date.now());
      setIsRecording(true);
      return;
    }

    setIsRecording(false);
    setRecordingStartedAt(null);
  }

  function onExportMidi() {
    if (recordedChords.length === 0) {
      return;
    }

    const bytes = buildMidiBytes(recordedChords);
    const blob = new Blob([bytes], { type: "audio/midi" });
    downloadBlob(`chordo-${selectedKey}-${keyMode}.mid`, blob);
  }

  return (
    <main className="app">
      <section className="controls">
        <div className="key-config">
          <label htmlFor="key-select">Key</label>
          <select
            id="key-select"
            value={selectedKey}
            onChange={(event) => setSelectedKey(event.currentTarget.value)}
          >
            {KEY_OPTIONS.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
          <button
            className={keyMode === "maj" ? "is-active" : ""}
            onClick={() => setKeyMode("maj")}
            type="button"
          >
            Maj
          </button>
          <button
            className={keyMode === "min" ? "is-active" : ""}
            onClick={() => setKeyMode("min")}
            type="button"
          >
            Min
          </button>
          <span className="selected-key">
            {selectedKey} {keyMode === "maj" ? "Major" : "Minor"}
          </span>
        </div>

        <div className="record-config">
          <button className={isRecording ? "is-recording" : ""} onClick={onRecordToggle} type="button">
            {isRecording ? "Stop Record" : "Record"}
          </button>
          <button onClick={onExportMidi} type="button" disabled={recordedChords.length === 0}>
            {isRecording ? "Stop Record" : "Record"}
          </button>
          <button onClick={onExportMidi} type="button" disabled={recordedChords.length === 0}>
            Export MIDI
          </button>
          <span>{recordedChords.length} events</span>
        </div>
      </section>

      {/* Styled Grid resembling the OneMotion Interface */}
      <section className="chord-grid">
        {chordGridRows.map((row, rowIndex) => (
          <div key={rowIndex} className="chord-row">
            {row.map((chord, colIndex) => (
              <button
                key={colIndex}
                type="button"
                className={`chord-button ${!chord ? "empty-slot" : ""} ${rowIndex === 1 ? "triad-main" : ""}`}
                disabled={!chord}
                onClick={() => void onChordPress(chord)}
              >
                {chord}
              </button>
            ))}
          </div>
        ))}
      </section>
    </main>
  );
}

export default App;