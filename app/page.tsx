"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// Expanded video manifest: military/warcore/Desert Storm footage
const VIDEO_MANIFEST = [
    // Original warcore selections
    "oMBgBMWyHVk",
    "OToBXEuYvmo",
    "uHpDotOdJbw",
    "BDbI9fK7OG4",
    "FszR_WlWdQI",
    "8b5rIFci5vs",
    "BC_ddF8IQGA",
    "XdfB9qnPFcI",
    "rwuF_N1gmlw",
    // Desert Storm / Gulf War — Smithsonian confirmed
    "RhpgCaPoBaE", // Desert Storm first Apache strikes, night FLIR gun camera
    "_PrU5XD2Ypo", // Apache helicopter attack over Baghdad
    "7lrfdzU8k4k", // AC-130 gunship firing all cannons, thermal/FLIR
    "Chqe2SiWsZE", // Carriers at War: Strike Force Arabian Gulf, flight deck ops
    "7aEYkZjTBag", // Falklands War aerial battle, Harriers vs Skyhawks
    "n3k60lUzM6c", // WWII USS Bunker Hill kamikaze attack footage
    // Journeyman / Archive confirmed
    "dxEjSr6rYXU", // Shock and Awe, 2003 Baghdad bombardment
    // FUNKER530 — combat footage compilations
    "V1BbHRysLjw", // FPV drone combat footage
    "NX-xfAKWDIo", // Shotguns and bomb drones combat review
];

const SKIP_SECONDS = 3;
const VISUALIZER_BINS = 24;
const VISUALIZER_FFT_SIZE = 256;

type WarmupPhase = "idle" | "loading" | "seeking" | "ready";

interface YouTubePlayer {
    loadVideoById: (config: { videoId: string; startSeconds?: number }) => void;
    playVideo: () => void;
    pauseVideo: () => void;
    mute: () => void;
    unMute: () => void;
    isMuted: () => boolean;
    setVolume: (volume: number) => void;
    seekTo: (seconds: number, allowSeekAhead: boolean) => void;
    getDuration: () => number;
    getPlayerState: () => number;
    destroy: () => void;
}

interface YouTubeEvent {
    target: YouTubePlayer;
    data: number;
}

declare global {
    interface Window {
        YT: {
            Player: new (
                elementId: string,
                config: {
                    videoId: string;
                    playerVars: Record<string, string | number>;
                    events: {
                        onReady: (event: YouTubeEvent) => void;
                        onStateChange: (event: YouTubeEvent) => void;
                        onError?: (event: YouTubeEvent) => void;
                    };
                }
            ) => YouTubePlayer;
            PlayerState: {
                UNSTARTED: number;
                ENDED: number;
                PLAYING: number;
                PAUSED: number;
                BUFFERING: number;
                CUED: number;
            };
        };
        onYouTubeIframeAPIReady: () => void;
    }
}

type DeckId = "A" | "B" | "C" | "D";
const DECK_ORDER: DeckId[] = ["A", "B", "C", "D"];

export default function DesertHaze() {
    // === STATE (only what needs to trigger re-renders) ===
    const [initialized, setInitialized] = useState(false);
    const [loading, setLoading] = useState(false);
    const [splashHidden, setSplashHidden] = useState(false);
    const [activeDeck, setActiveDeck] = useState<DeckId>("A");
    const [overlayCollapsed, setOverlayCollapsed] = useState(false);
    const [paused, setPaused] = useState(false);
    const [volume, setVolume] = useState(100);
    const [muted, setMuted] = useState(false);
    const [systemTime, setSystemTime] = useState("");
    const [beatProgress, setBeatProgress] = useState({ current: 0, total: 0 });

    // === REFS (performance-critical values read in rAF loop) ===
    const activeDeckRef = useRef<DeckId>("A");
    const pausedRef = useRef(false);
    const currentVideoIdRef = useRef("");

    // Audio
    const audioRef = useRef<HTMLAudioElement>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const frequencyDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

    // Beat map
    const beatMapRef = useRef<number[]>([]);
    const currentBeatIndexRef = useRef(0);

    // YouTube
    const playersRef = useRef<Record<DeckId, YouTubePlayer | null>>({
        A: null, B: null, C: null, D: null,
    });
    const ytApiReadyRef = useRef(false);
    const warmupPhaseRef = useRef<Record<DeckId, WarmupPhase>>({
        A: "idle", B: "idle", C: "idle", D: "idle",
    });
    const warmupPollRef = useRef<Record<DeckId, ReturnType<typeof setInterval> | null>>({
        A: null, B: null, C: null, D: null,
    });
    const deckVideoRef = useRef<Record<DeckId, string>>({
        A: "", B: "", C: "", D: "",
    });
    const failedVideosRef = useRef<Set<string>>(new Set());

    // UI
    const overlayRef = useRef<HTMLDivElement>(null);
    const visualizerCanvasRef = useRef<HTMLCanvasElement>(null);
    const beatFlashRef = useRef<HTMLDivElement>(null);
    const dragStateRef = useRef({ isDragging: false, startX: 0, startY: 0 });

    // === SYNC REFS WITH STATE ===
    useEffect(() => { activeDeckRef.current = activeDeck; }, [activeDeck]);
    useEffect(() => { pausedRef.current = paused; }, [paused]);

    // === LOAD BEAT MAP ===
    useEffect(() => {
        fetch("/beat_map.json")
            .then((res) => res.json())
            .then((data: number[]) => {
                beatMapRef.current = data;
                setBeatProgress((p) => ({ ...p, total: data.length }));
            })
            .catch((err) => console.error("[BEAT_MAP] Error:", err));
    }, []);

    // === SYSTEM TIME (1Hz) ===
    useEffect(() => {
        const update = () => {
            setSystemTime(
                new Date().toLocaleTimeString("en-US", {
                    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
                })
            );
        };
        update();
        const id = setInterval(update, 1000);
        return () => clearInterval(id);
    }, []);

    // === LOAD YOUTUBE API ===
    useEffect(() => {
        if (window.YT) {
            ytApiReadyRef.current = true;
            return;
        }
        const tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        const first = document.getElementsByTagName("script")[0];
        first.parentNode?.insertBefore(tag, first);
        window.onYouTubeIframeAPIReady = () => {
            ytApiReadyRef.current = true;
        };
    }, []);

    // === KEYBOARD CONTROLS ===
    useEffect(() => {
        if (!initialized) return;
        const handleKey = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement) return;
            switch (e.code) {
                case "Space":
                    e.preventDefault();
                    togglePause();
                    break;
                case "KeyM":
                    toggleMute();
                    break;
                case "KeyF":
                    toggleFullscreen();
                    break;
                case "ArrowUp":
                    e.preventDefault();
                    adjustVolume(10);
                    break;
                case "ArrowDown":
                    e.preventDefault();
                    adjustVolume(-10);
                    break;
            }
        };
        window.addEventListener("keydown", handleKey);
        return () => window.removeEventListener("keydown", handleKey);
    });

    // === DRAG HANDLERS (mouse + touch) ===
    const handlePointerDown = (e: React.MouseEvent | React.TouchEvent) => {
        if (!overlayRef.current) return;
        const rect = overlayRef.current.getBoundingClientRect();
        const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
        const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
        dragStateRef.current = {
            isDragging: true,
            startX: clientX - rect.left,
            startY: clientY - rect.top,
        };
    };

    useEffect(() => {
        const handleMove = (e: MouseEvent | TouchEvent) => {
            if (!dragStateRef.current.isDragging || !overlayRef.current) return;
            const clientX = "touches" in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
            const clientY = "touches" in e ? e.touches[0].clientY : (e as MouseEvent).clientY;
            overlayRef.current.style.left = `${clientX - dragStateRef.current.startX}px`;
            overlayRef.current.style.top = `${clientY - dragStateRef.current.startY}px`;
            overlayRef.current.style.right = "auto";
            overlayRef.current.style.bottom = "auto";
        };
        const handleUp = () => { dragStateRef.current.isDragging = false; };

        document.addEventListener("mousemove", handleMove);
        document.addEventListener("mouseup", handleUp);
        document.addEventListener("touchmove", handleMove, { passive: true });
        document.addEventListener("touchend", handleUp);
        return () => {
            document.removeEventListener("mousemove", handleMove);
            document.removeEventListener("mouseup", handleUp);
            document.removeEventListener("touchmove", handleMove);
            document.removeEventListener("touchend", handleUp);
        };
    }, []);

    // === CORE FUNCTIONS ===

    const getRandomVideoId = useCallback((exclude?: string): string => {
        const failed = failedVideosRef.current;
        const available = VIDEO_MANIFEST.filter((id) => id !== exclude && !failed.has(id));
        if (available.length === 0) {
            failedVideosRef.current.clear();
            return VIDEO_MANIFEST[Math.floor(Math.random() * VIDEO_MANIFEST.length)];
        }
        return available[Math.floor(Math.random() * available.length)];
    }, []);

    const warmupDeck = useCallback((deckId: DeckId, player: YouTubePlayer, shouldPause: boolean) => {
        // Clear any existing poll for this deck
        if (warmupPollRef.current[deckId]) {
            clearInterval(warmupPollRef.current[deckId]!);
        }

        warmupPhaseRef.current[deckId] = "loading";
        player.playVideo();
        player.mute();

        const pollId = setInterval(() => {
            try {
                const state = player.getPlayerState();
                const phase = warmupPhaseRef.current[deckId];
                const duration = player.getDuration();

                if (phase === "loading" && state === window.YT.PlayerState.PLAYING && duration > 0) {
                    const safeStart = SKIP_SECONDS;
                    const safeEnd = Math.max(safeStart + 1, duration - SKIP_SECONDS);
                    const randomStart = safeStart + Math.random() * (safeEnd - safeStart - 5);
                    player.seekTo(Math.max(safeStart, randomStart), true);
                    warmupPhaseRef.current[deckId] = "seeking";
                } else if (phase === "seeking" && state === window.YT.PlayerState.PLAYING) {
                    if (shouldPause) player.pauseVideo();
                    warmupPhaseRef.current[deckId] = "ready";
                    clearInterval(pollId);
                    warmupPollRef.current[deckId] = null;
                }
            } catch {
                clearInterval(pollId);
                warmupPollRef.current[deckId] = null;
                warmupPhaseRef.current[deckId] = "ready";
            }
        }, 150);

        warmupPollRef.current[deckId] = pollId;

        // Safety timeout
        setTimeout(() => {
            if (warmupPollRef.current[deckId] === pollId) {
                clearInterval(pollId);
                warmupPollRef.current[deckId] = null;
                warmupPhaseRef.current[deckId] = "ready";
            }
        }, 8000);
    }, []);

    const loadVideoOnDeck = useCallback((deckId: DeckId, videoId: string, shouldPause = true) => {
        const player = playersRef.current[deckId];
        if (!player) return;

        deckVideoRef.current[deckId] = videoId;

        try {
            player.loadVideoById({ videoId });
            player.mute();
            warmupDeck(deckId, player, shouldPause);
        } catch (err) {
            console.error(`[DECK-${deckId}] Error loading:`, err);
        }
    }, [warmupDeck]);

    const handlePlayerError = useCallback((deckId: DeckId) => {
        const failedVid = deckVideoRef.current[deckId];
        if (failedVid) {
            failedVideosRef.current.add(failedVid);
        }
        const replacement = getRandomVideoId(failedVid);
        deckVideoRef.current[deckId] = replacement;
        loadVideoOnDeck(deckId, replacement);
    }, [getRandomVideoId, loadVideoOnDeck]);

    const initPlayer = useCallback((
        elementId: string,
        deckId: DeckId,
        videoId: string,
        onReady: (player: YouTubePlayer) => void,
    ) => {
        const checkAndCreate = () => {
            if (!ytApiReadyRef.current || !window.YT?.Player) {
                setTimeout(checkAndCreate, 100);
                return;
            }
            new window.YT.Player(elementId, {
                videoId,
                playerVars: {
                    autoplay: 0,
                    controls: 0,
                    disablekb: 1,
                    fs: 0,
                    modestbranding: 1,
                    rel: 0,
                    showinfo: 0,
                    mute: 1,
                    playsinline: 1,
                    loop: 1,
                    enablejsapi: 1,
                },
                events: {
                    onReady: (event: YouTubeEvent) => {
                        event.target.mute();
                        playersRef.current[deckId] = event.target;
                        onReady(event.target);
                    },
                    onStateChange: () => { /* handled by polling warmup */ },
                    onError: () => {
                        handlePlayerError(deckId);
                    },
                },
            });
        };
        checkAndCreate();
    }, [handlePlayerError]);

    // === BEAT FLASH ===
    const triggerBeatFlash = useCallback(() => {
        const el = beatFlashRef.current;
        if (!el) return;
        el.classList.remove("active");
        void el.offsetWidth; // force reflow
        el.classList.add("active");
    }, []);

    // === VISUALIZER DRAW ===
    const drawVisualizer = useCallback(() => {
        const canvas = visualizerCanvasRef.current;
        const analyser = analyserRef.current;
        const freqData = frequencyDataRef.current;
        if (!canvas || !analyser || !freqData) return;

        analyser.getByteFrequencyData(freqData);

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const { width, height } = canvas;
        ctx.clearRect(0, 0, width, height);

        const barCount = VISUALIZER_BINS;
        const gap = 2;
        const barWidth = (width - (barCount - 1) * gap) / barCount;
        const binSize = Math.floor(freqData.length / barCount);

        for (let i = 0; i < barCount; i++) {
            let sum = 0;
            for (let j = 0; j < binSize; j++) {
                sum += freqData[i * binSize + j];
            }
            const avg = sum / binSize;
            const barHeight = Math.max(1, (avg / 255) * height);

            ctx.fillStyle = pausedRef.current
                ? "rgba(255,255,255,0.15)"
                : "rgba(255,255,255,0.8)";
            ctx.fillRect(
                i * (barWidth + gap),
                height - barHeight,
                barWidth,
                barHeight
            );
        }
    }, []);

    // === BEAT SYNC LOOP (main rAF — runs once when initialized, never tears down) ===
    useEffect(() => {
        if (!initialized) return;

        const audio = audioRef.current;
        if (!audio) return;

        let animationId: number;
        let lastTime = 0;

        const tick = () => {
            animationId = requestAnimationFrame(tick);

            // Always draw visualizer (even when paused, shows flat bars)
            drawVisualizer();

            if (pausedRef.current) return;

            const currentTime = audio.currentTime;

            // Loop detection
            if (lastTime > 10 && currentTime < 5) {
                currentBeatIndexRef.current = 0;
            }
            lastTime = currentTime;

            const beats = beatMapRef.current;
            const idx = currentBeatIndexRef.current;

            if (idx < beats.length && currentTime >= beats[idx]) {
                const currentDeckId = activeDeckRef.current;
                const nextDeckId = DECK_ORDER[(DECK_ORDER.indexOf(currentDeckId) + 1) % 4];

                // Activate next deck
                activeDeckRef.current = nextDeckId;
                setActiveDeck(nextDeckId);

                // Play next deck
                const nextPlayer = playersRef.current[nextDeckId];
                if (nextPlayer) {
                    nextPlayer.playVideo();
                }

                // Reload old deck with new video
                const newVideoId = getRandomVideoId(deckVideoRef.current[currentDeckId]);
                currentVideoIdRef.current = newVideoId;
                loadVideoOnDeck(currentDeckId, newVideoId);

                // Advance beat index
                currentBeatIndexRef.current = idx + 1;
                setBeatProgress({ current: idx + 1, total: beats.length });

                // Beat flash
                triggerBeatFlash();
            }
        };

        audio.loop = true;
        animationId = requestAnimationFrame(tick);

        return () => cancelAnimationFrame(animationId);
    }, [initialized, getRandomVideoId, loadVideoOnDeck, drawVisualizer, triggerBeatFlash]);

    // === CONTROLS ===
    const togglePause = useCallback(() => {
        if (!audioRef.current) return;

        if (pausedRef.current) {
            audioRef.current.play();
            audioContextRef.current?.resume();
            playersRef.current[activeDeckRef.current]?.playVideo();
            pausedRef.current = false;
            setPaused(false);
        } else {
            audioRef.current.pause();
            Object.values(playersRef.current).forEach((p) => p?.pauseVideo());
            pausedRef.current = true;
            setPaused(true);
        }
    }, []);

    const toggleMute = useCallback(() => {
        if (!audioRef.current) return;
        const newMuted = !audioRef.current.muted;
        audioRef.current.muted = newMuted;
        setMuted(newMuted);
    }, []);

    const adjustVolume = useCallback((delta: number) => {
        if (!audioRef.current) return;
        const newVol = Math.min(100, Math.max(0, Math.round(audioRef.current.volume * 100) + delta));
        audioRef.current.volume = newVol / 100;
        setVolume(newVol);
        if (newVol > 0 && audioRef.current.muted) {
            audioRef.current.muted = false;
            setMuted(false);
        }
    }, []);

    const toggleFullscreen = useCallback(() => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            document.documentElement.requestFullscreen();
        }
    }, []);

    // === INITIALIZE ===
    const handleInitialize = () => {
        if (initialized) return;

        setSplashHidden(true);
        setLoading(true);
        setInitialized(true);

        // Setup Web Audio API (must be in user gesture handler for iOS)
        if (audioRef.current) {
            const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = VISUALIZER_FFT_SIZE;
            analyser.smoothingTimeConstant = 0.8;

            const source = audioCtx.createMediaElementSource(audioRef.current);
            source.connect(analyser);
            analyser.connect(audioCtx.destination);

            audioContextRef.current = audioCtx;
            analyserRef.current = analyser;
            frequencyDataRef.current = new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;

            // Start audio
            audioRef.current.volume = volume / 100;
            audioRef.current.play().catch(console.error);
        }

        // Initialize 4 decks
        DECK_ORDER.forEach((id) => {
            const vid = getRandomVideoId();
            deckVideoRef.current[id] = vid;

            initPlayer(`deck-${id}`, id, vid, (player) => {
                if (id === "A") {
                    // Active deck: warm up but keep playing
                    warmupDeck(id, player, false);
                    currentVideoIdRef.current = vid;

                    // Clear loading when deck A is ready
                    const checkReady = setInterval(() => {
                        if (warmupPhaseRef.current["A"] === "ready") {
                            setLoading(false);
                            clearInterval(checkReady);
                        }
                    }, 100);
                    setTimeout(() => {
                        setLoading(false);
                        clearInterval(checkReady);
                    }, 5000);
                } else {
                    warmupDeck(id, player, true);
                }
            });
        });
    };

    return (
        <main>
            {/* Audio element */}
            <audio ref={audioRef} src="/macarena_radio_edit.mp3" preload="auto" />

            {/* Splash screen */}
            <div
                className={`splash-screen ${splashHidden ? "hidden" : ""}`}
                onClick={handleInitialize}
            >
                <div className="splash-title">
                    CLICK TO INITIALIZE [OPERATION DESERT HAZE]
                </div>
                <div className="splash-subtitle">WARCORE VISUALIZER</div>
            </div>

            {/* Loading overlay */}
            {loading && (
                <div className="loading-overlay">
                    <div className="loading-text">INITIALIZING SYSTEM</div>
                    <div className="loading-bar">
                        <div className="loading-bar-fill" />
                    </div>
                    <div className="loading-status">BUFFERING DECKS</div>
                </div>
            )}

            {/* Video container */}
            <div className="video-container">
                {DECK_ORDER.map((deckId) => (
                    <div
                        key={deckId}
                        className={`video-deck ${activeDeck === deckId ? "visible" : "hidden"}`}
                        style={{
                            zIndex: activeDeck === deckId ? 1 : 0,
                            transform: "scale(1.2)",
                        }}
                    >
                        <div id={`deck-${deckId}`} />
                    </div>
                ))}
                <div ref={beatFlashRef} className="beat-flash-overlay" />
            </div>

            {/* CRT post-processing overlay */}
            {initialized && <div className="crt-overlay" />}

            {/* Keyboard hints */}
            {initialized && !loading && (
                <div className="keyboard-hints">
                    <span className="hint-key">SPACE</span> PAUSE
                    <span className="hint-sep">/</span>
                    <span className="hint-key">M</span> MUTE
                    <span className="hint-sep">/</span>
                    <span className="hint-key">F</span> FULLSCREEN
                    <span className="hint-sep">/</span>
                    <span className="hint-key">&uarr;&darr;</span> VOL
                </div>
            )}

            {/* Status overlay */}
            {initialized && !loading && (
                <div
                    ref={overlayRef}
                    className={`status-overlay ${overlayCollapsed ? "collapsed" : ""}`}
                    onMouseDown={handlePointerDown}
                    onTouchStart={handlePointerDown}
                >
                    <div className="status-header">
                        <span className="status-label">SYS STATUS</span>
                        <div className="status-header-right">
                            <div
                                className="rec-indicator"
                                onClick={(e) => { e.stopPropagation(); togglePause(); }}
                                style={{ cursor: "pointer" }}
                            >
                                <div className={`rec-dot ${paused ? "paused" : ""}`} />
                                <span>{paused ? "STOP" : "REC"}</span>
                            </div>
                            <button
                                className="collapse-btn"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setOverlayCollapsed(!overlayCollapsed);
                                }}
                                onMouseDown={(e) => e.stopPropagation()}
                            >
                                {overlayCollapsed ? "+" : "\u2212"}
                            </button>
                        </div>
                    </div>

                    {!overlayCollapsed && (
                        <>
                            <div className="status-row">
                                <span className="status-key">VIDEO</span>
                                <span className="status-value">
                                    {paused ? "PAUSED" : currentVideoIdRef.current.substring(0, 8) || "\u2014"}
                                </span>
                            </div>

                            <div className="status-row">
                                <span className="status-key">TIME</span>
                                <span className="status-value">{systemTime}</span>
                            </div>

                            <div className="status-row">
                                <span className="status-key">DECK</span>
                                <span className="status-value">{activeDeck}</span>
                            </div>

                            <div className="status-row">
                                <span className="status-key">BEAT</span>
                                <span className="status-value">
                                    {beatProgress.current}/{beatProgress.total}
                                </span>
                            </div>

                            <div className="status-row volume-row">
                                <span className="status-key">{muted ? "MUTED" : "VOL"}</span>
                                <input
                                    type="range"
                                    className="volume-slider"
                                    min="0"
                                    max="100"
                                    value={muted ? 0 : volume}
                                    onChange={(e) => {
                                        const v = parseInt(e.target.value);
                                        if (audioRef.current) audioRef.current.volume = v / 100;
                                        setVolume(v);
                                        if (v > 0 && muted) {
                                            if (audioRef.current) audioRef.current.muted = false;
                                            setMuted(false);
                                        }
                                    }}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onTouchStart={(e) => e.stopPropagation()}
                                />
                            </div>

                            <div className="status-row">
                                <button
                                    className="control-btn"
                                    onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
                                    onMouseDown={(e) => e.stopPropagation()}
                                >
                                    FULLSCREEN
                                </button>
                            </div>

                            {/* Real audio visualizer canvas */}
                            <div className="visualizer-container">
                                <canvas
                                    ref={visualizerCanvasRef}
                                    className="visualizer-canvas"
                                    width={200}
                                    height={24}
                                />
                            </div>
                        </>
                    )}
                </div>
            )}
        </main>
    );
}
