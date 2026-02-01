#!/usr/bin/env python3
"""
analyze_audio.py — Beat Detection for Operation Desert Haze

This script analyzes the audio file to extract beat/onset timestamps suitable
for syncing video cuts. The audio contains:
- Slowed + Reverb Macarena (heavy bass/snare)
- Military radio chatter and static (high-frequency noise)

Strategy:
1. Load audio and convert to mono
2. Apply percussive/harmonic separation to isolate drums
3. Use onset detection focused on low frequencies (50-200 Hz) for kick/bass
4. Enforce minimum 2-4 second spacing to avoid strobe effect
5. Export timestamps as JSON

Dependencies:
    pip install librosa numpy soundfile

Usage:
    python3 analyze_audio.py
"""

import json
import numpy as np
import librosa

# Configuration
INPUT_FILE = "macarena_radio_edit.mp3"
OUTPUT_FILE = "beat_map.json"

# Onset detection parameters
MIN_BEAT_INTERVAL = 0.5  # Minimum seconds between beats (adjusted to 0.5s as requested) 0.5s as requested)
HOP_LENGTH = 512         # Samples between frames
SR = 22050               # Sample rate

def analyze_audio():
    """
    Main analysis function.
    
    Noise-Gate Logic:
    -----------------
    The audio has high-frequency radio static that would trigger false onsets.
    We combat this by:
    
    1. Percussive Separation: librosa.effects.hpss() separates harmonic (tonal)
       from percussive (transient) components. Radio chatter is harmonic,
       drums are percussive.
    
    2. Low-Frequency Focus: By computing onset strength with a mel spectrogram
       weighted toward lower frequencies, we detect the heavy bass/kick while
       ignoring high-frequency static.
    
    3. Peak Picking with Distance: librosa.util.peak_pick enforces minimum
       time between detections, preventing rapid strobing from noise.
    """
    
    print(f"[INIT] Loading audio: {INPUT_FILE}")
    
    # Load audio file (mono, 22050 Hz sample rate)
    y, sr = librosa.load(INPUT_FILE, sr=SR, mono=True)
    duration = librosa.get_duration(y=y, sr=sr)
    print(f"[INFO] Duration: {duration:.2f} seconds")
    
    # -----------------------------------------------------------------
    # STEP 1: Percussive/Harmonic Separation
    # Radio chatter is tonal (harmonic), drums are transient (percussive)
    # By isolating the percussive component, we ignore the radio noise
    # -----------------------------------------------------------------
    print("[PROC] Separating percussive component...")
    y_harmonic, y_percussive = librosa.effects.hpss(y)
    
    # -----------------------------------------------------------------
    # STEP 2: Compute Onset Strength Envelope
    # Focus on low frequencies (bass/kick) by using a mel spectrogram
    # with limited frequency range
    # -----------------------------------------------------------------
    print("[PROC] Computing onset strength (low-freq focused)...")
    
    # Compute mel spectrogram of percussive signal
    # Use broader frequency range to capture kick/bass without triggering empty filters
    S = librosa.feature.melspectrogram(
        y=y_percussive,
        sr=sr,
        hop_length=HOP_LENGTH,
        n_mels=32,      # Fewer mel bands to avoid empty filters
        fmin=20,        # Low frequency floor (sub-bass)
        fmax=500        # Include low-mid range for snare body
    )
    
    # Convert to onset strength envelope
    onset_env = librosa.onset.onset_strength(
        S=librosa.power_to_db(S, ref=np.max),
        sr=sr,
        hop_length=HOP_LENGTH,
        aggregate=np.mean  # Mean aggregation for slowed audio
    )
    
    # -----------------------------------------------------------------
    # STEP 3: Peak Picking with Minimum Distance
    # Enforce 2-4 second spacing to get cinematic cuts, not strobe
    # -----------------------------------------------------------------
    print(f"[PROC] Detecting peaks (min interval: {MIN_BEAT_INTERVAL}s)...")
    
    # Convert minimum interval to frames
    min_frames = int(MIN_BEAT_INTERVAL * sr / HOP_LENGTH)
    
    # Peak picking parameters (more sensitive for slowed audio)
    # pre_max/post_max: how many frames before/after must be lower
    # pre_avg/post_avg: how many frames for local average comparison
    # delta: threshold above local average (lowered for sensitivity)
    # wait: minimum frames between peaks
    peaks = librosa.util.peak_pick(
        onset_env,
        pre_max=3,
        post_max=3,
        pre_avg=5,
        post_avg=5,
        delta=0.05,      # Lower threshold for slowed audio
        wait=min_frames  # Enforce minimum beat interval
    )
    
    # Convert frame indices to timestamps
    timestamps = librosa.frames_to_time(peaks, sr=sr, hop_length=HOP_LENGTH)
    
    # Round to 3 decimal places for cleaner JSON
    timestamps = [round(float(t), 3) for t in timestamps]
    
    print(f"[INFO] Detected {len(timestamps)} beat markers")
    
    # -----------------------------------------------------------------
    # STEP 4: Validate spacing
    # Ensure no two beats are closer than minimum interval
    # -----------------------------------------------------------------
    if len(timestamps) > 1:
        intervals = np.diff(timestamps)
        min_interval = np.min(intervals)
        avg_interval = np.mean(intervals)
        print(f"[INFO] Interval range: {min_interval:.2f}s - {np.max(intervals):.2f}s")
        print(f"[INFO] Average interval: {avg_interval:.2f}s")
    
    # -----------------------------------------------------------------
    # STEP 5: Export to JSON
    # -----------------------------------------------------------------
    print(f"[SAVE] Writing {OUTPUT_FILE}")
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(timestamps, f, indent=2)
    
    print(f"[DONE] Generated {len(timestamps)} beat timestamps")
    print(f"[HINT] Copy to public/: cp {OUTPUT_FILE} public/")
    
    return timestamps


if __name__ == "__main__":
    analyze_audio()
