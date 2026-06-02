import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type KeyMode = "maj" | "min";

type ChordEvent = {
  chord: string | null;
  timestampMs: number;
};

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const KEY_OPTIONS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const NOTE_TO_SEMITONE: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5,
  "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};

const SCALE_INTERVALS = {
  maj: [0, 2, 4, 5, 7, 9, 11],
  min: [0, 2, 3, 5, 7, 8, 10],
};

const DIATONIC_QUALITIES = {
  maj: ["maj", "min", "min", "maj", "maj", "min", "dim"],
  min: ["min", "dim", "maj", "min", "min", "maj", "maj"],
};

const SEVENTH_EXTENSIONS = {
  maj: ["maj7", "m7", "m7", "maj7", "7", "m7", "m7b5"],
  min: ["m7", "m7b5", "maj7", "m7", "m7", "maj7", "7"],
};

const PIANO_OCTAVE_PATTERN = [
  { note: "C", isBlack: false },
  { note: "C#", isBlack: true },
  { note: "D", isBlack: false },
  { note: "D#", isBlack: true },
  { note: "E", isBlack: false },
  { note: "F", isBlack: false },
  { note: "F#", isBlack: true },
  { note: "G", isBlack: false },
  { note: "G#", isBlack: true },
  { note: "A", isBlack: false },
  { note: "A#", isBlack: true },
  { note: "B", isBlack: false },
];

// --- Audio Synthesis Setup Engine ---
// Initialize Web Audio context lazily upon user interaction
let audioCtx: AudioContext | null = null;
// Active oscillators pool tracking to stop them dynamically on chord release
let activeOscillators: { osc: OscillatorNode; gainNode: GainNode }[] = [];

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    void audioCtx.resume();
  }
}

function midiNoteToFrequency(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

function playPianoChord(midiNotes: number[]) {
  initAudio();
  if (!audioCtx) return;

  // Clear any hanging lingering chord notes first
  stopPianoChord();

  const now = audioCtx.currentTime;

  midiNotes.forEach((note) => {
    if (!audioCtx) return;

    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    // A blend of standard Sine and Triangle mimics an organic Fender Rhodes / clean digital key tone
    osc.type = "triangle";
    osc.frequency.setValueAtTime(midiNoteToFrequency(note), now);

    // ADSR Attack and Initial Peak configuration
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.2, now + 0.01); // Quick non-clicking strike attack
    gainNode.gain.exponentialRampToValueAtTime(0.08, now + 0.4); // Subtle natural string decay profile

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    osc.start(now);

    activeOscillators.push({ osc, gainNode });
  });
}

function stopPianoChord() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;

  activeOscillators.forEach(({ osc, gainNode }) => {
    try {
      // Gently ramp down to zero over 0.05 seconds to avoid abrasive audio pops/clicks
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setValueAtTime(gainNode.gain.value, now);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.stop(now + 0.06);
    } catch (e) {
      // Fallback structural safety check if oscillator was dead
    }
  });
  activeOscillators = [];
}
// --- End Audio Synthesis Setup ---

function buildChordLabel(root: string, quality: string): string {
  if (quality === "maj") return root;
  if (quality === "min") return `${root}m`;
  return `${root}${quality}`;
}

function chordToMidiNotes(chord: string): number[] {
  let root = chord.substring(0, 1);
  if (chord.charAt(1) === "#" || chord.charAt(1) === "b") {
    root += chord.charAt(1);
  }
  const extension = chord.replace(root, "");
  const rootSemitone = NOTE_TO_SEMITONE[root] ?? 0;

  const base = 60 + rootSemitone;

  let intervals = [0, 4, 7];

  if (extension === "m" || (extension.startsWith("m7") && extension !== "m7b5")) {
    intervals = [0, 3, 7];
  } else if (extension === "dim") {
    intervals = [0, 3, 6];
  } else if (extension === "sus2") {
    intervals = [0, 2, 7];
  } else if (extension === "sus4") {
    intervals = [0, 5, 7];
  } else if (extension === "maj7") {
    intervals = [0, 4, 7, 11];
  } else if (extension === "7") {
    intervals = [0, 4, 7, 10];
  } else if (extension === "m7b5") {
    intervals = [0, 3, 6, 10];
  }

  return intervals.map(interval => base + interval);
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
    if (!event.chord) return;

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

  const [activeChord, setActiveChord] = useState<string | null>(null);

  const chordGridRows = useMemo(() => {
    const rootIndex = NOTES.indexOf(selectedKey);
    const intervals = SCALE_INTERVALS[keyMode];
    const triadQualities = DIATONIC_QUALITIES[keyMode];
    const seventhExtensions = SEVENTH_EXTENSIONS[keyMode];

    const scaleRoots = intervals.map((interval) => {
      const idx = (rootIndex + interval) % 12;
      return NOTES[idx];
    });

    const sus2Row = scaleRoots.map((root, i) => (triadQualities[i] === "dim" ? "" : `${root}sus2`));
    const triadRow = scaleRoots.map((root, i) => buildChordLabel(root, triadQualities[i]));
    const sus4Row = scaleRoots.map((root, i) => (triadQualities[i] === "dim" ? "" : `${root}sus4`));
    const seventhRow = scaleRoots.map((root, i) => buildChordLabel(root, seventhExtensions[i]));

    return [sus2Row, triadRow, sus4Row, seventhRow];
  }, [selectedKey, keyMode]);

  const fullPianoKeyboard = useMemo(() => {
    const keys = [];
    let globalKeyIndex = 0;
    for (let octave = 0; octave < 4; octave++) {
      for (const keyDef of PIANO_OCTAVE_PATTERN) {
        keys.push({
          ...keyDef,
          id: globalKeyIndex,
          octave: octave,
          midiNote: 48 + (octave * 12) + NOTE_TO_SEMITONE[keyDef.note]
        });
        globalKeyIndex++;
      }
    }
    return keys;
  }, []);

  const activeMidiNotes = useMemo(() => {
    if (!activeChord) return new Set<number>();
    const notes = chordToMidiNotes(activeChord);

    return new Set(
      notes.map((note) => {
        if (note >= 48 && note <= 96) return note;
        return (note % 12) + 60;
      })
    );
  }, [activeChord]);

  async function handleChordDown(chord: string) {
    if (!chord) return;
    setActiveChord(chord);

    // Audio Trigger: Parse string into midi intervals and play through speakers
    const notesToPlay = chordToMidiNotes(chord);
    playPianoChord(notesToPlay);

    await invoke("log_chord_press", { chord, key: selectedKey, keyMode });

    if (!isRecording || recordingStartedAt === null) return;

    setRecordedChords((prev) => [
      ...prev,
      { chord, timestampMs: Date.now() - recordingStartedAt },
    ]);
  }

  function handleChordUp() {
    if (activeChord) {
      // Audio Release: Stop the current active synthesizer nodes smoothly
      stopPianoChord();

      if (isRecording && recordingStartedAt !== null) {
        setRecordedChords((prev) => [
          ...prev,
          { chord: null, timestampMs: Date.now() - recordingStartedAt },
        ]);
      }
    }
    setActiveChord(null);
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

  const totalPlayableEvents = useMemo(() => {
    return recordedChords.filter(e => e.chord !== null).length;
  }, [recordedChords]);

  function onExportMidi() {
    if (recordedChords.length === 0) return;
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
            Export MIDI
          </button>
          <span>{totalPlayableEvents} events</span>
        </div>
      </section>

      <section className="chord-grid">
        {chordGridRows.map((row, rowIndex) => (
          <div key={rowIndex} className="chord-row">
            {row.map((chord, colIndex) => (
              <button
                key={colIndex}
                type="button"
                className={`chord-button ${!chord ? "empty-slot" : ""} ${rowIndex === 1 ? "triad-main" : ""} ${activeChord === chord ? "chord-active" : ""}`}
                disabled={!chord}
                onPointerDown={() => handleChordDown(chord)}
                onPointerUp={handleChordUp}
                onPointerLeave={handleChordUp}
              >
                {chord}
              </button>
            ))}
          </div>
        ))}
      </section>

      <section className="piano-container">
        <div className="piano-keyboard">
          {fullPianoKeyboard.map((key) => {
            const isNoteActive = activeMidiNotes.has(key.midiNote);
            return (
              <div
                key={key.id}
                className={`piano-key ${key.isBlack ? "black-key" : "white-key"} ${isNoteActive ? "key-pressed" : ""}`}
                title={`${key.note} (MIDI: ${key.midiNote})`}
              >
                {isNoteActive && <span className="key-marker" />}
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}

export default App;