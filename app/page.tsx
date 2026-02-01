"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// Video manifest: Curated military/warcore footage
const VIDEO_MANIFEST = [
    "oMBgBMWyHVk",
    "OToBXEuYvmo",
    "uHpDotOdJbw",
    "BDbI9fK7OG4",
    "FszR_WlWdQI",
    "8b5rIFci5vs",
    "BC_ddF8IQGA",
    "XdfB9qnPFcI",
    "rwuF_N1gmlw",
];

// Skip first/last N seconds to avoid intro/outro cards
const SKIP_SECONDS = 3;

// Type for YouTube player from iframe API
interface YouTubePlayer {
    loadVideoById: (config: { videoId: string; startSeconds?: number }) => void;
    playVideo: () => void;
    pauseVideo: () => void;
    mute: () => void;
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

// 4-Deck identifier
type DeckId = "A" | "B" | "C" | "D";

export default function DesertHaze() {
    // State
    const [initialized, setInitialized] = useState(false);
    const [splashHidden, setSplashHidden] = useState(false);
    const [currentVideoId, setCurrentVideoId] = useState("");
    const [systemTime, setSystemTime] = useState("");
    const [visualizerLevels, setVisualizerLevels] = useState<number[]>(
        Array(12).fill(3)
    );
    const [overlayCollapsed, setOverlayCollapsed] = useState(false);
    const [paused, setPaused] = useState(false);

    // Deck Management State: A -> B -> C -> D rotation
    const [activeDeck, setActiveDeck] = useState<DeckId>("A");

    // Decks are:
    // ACTIVE: Visible, playing
    // READY (B/C): Hidden, loaded, paused, ready to cut to
    // LOADING (D): Hidden, actively loading next video, warming up

    const deckOrderRef = useRef<DeckId[]>(["A", "B", "C", "D"]);

    // Helper: calculate rotation position
    const getNextDeck = (current: DeckId) => deckOrderRef.current[(deckOrderRef.current.indexOf(current) + 1) % 4];
    const getLoadingDeck = (current: DeckId) => deckOrderRef.current[(deckOrderRef.current.indexOf(current) + 3) % 4];

    // Refs
    const audioRef = useRef<HTMLAudioElement>(null);
    const beatMapRef = useRef<number[]>([]);
    const currentBeatIndexRef = useRef(0);
    const playersRef = useRef<Record<DeckId, YouTubePlayer | null>>({
        A: null, B: null, C: null, D: null
    });
    const ytApiReadyRef = useRef(false);
    const overlayRef = useRef<HTMLDivElement>(null);
    const dragStateRef = useRef({ isDragging: false, startX: 0, startY: 0 });

    // State tracking for "Warmup" logic
    // We need to track which player is currently "warming up" so onStateChange knows what to do
    const warmingUpRef = useRef<Record<string, boolean>>({});

    // Load beat map
    useEffect(() => {
        fetch("/beat_map.json")
            .then((res) => res.json())
            .then((data: number[]) => {
                beatMapRef.current = data;
                console.log(`[BEAT_MAP] Loaded ${data.length} markers`);
            })
            .catch((err) => console.error("[BEAT_MAP] Error:", err));
    }, []);

    // System time updater
    useEffect(() => {
        const updateTime = () => {
            const now = new Date();
            setSystemTime(
                now.toLocaleTimeString("en-US", {
                    hour12: false,
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                })
            );
        };
        updateTime();
        const interval = setInterval(updateTime, 1000);
        return () => clearInterval(interval);
    }, []);

    // Load YouTube API
    useEffect(() => {
        if (window.YT) {
            ytApiReadyRef.current = true;
            return;
        }

        const tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        const firstScriptTag = document.getElementsByTagName("script")[0];
        firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);

        window.onYouTubeIframeAPIReady = () => {
            ytApiReadyRef.current = true;
            console.log("[YT] API Ready");
        };
    }, []);

    // Get random video ID
    const getRandomVideoId = useCallback((exclude?: string): string => {
        const available = VIDEO_MANIFEST.filter((id) => id !== exclude);
        return available[Math.floor(Math.random() * available.length)];
    }, []);

    // Initialize YouTube player
    const initPlayer = useCallback(
        (
            elementId: string,
            deckId: DeckId,
            videoId: string,
            onReady: (player: YouTubePlayer) => void
        ) => {
            const checkAndCreate = () => {
                if (!ytApiReadyRef.current || !window.YT?.Player) {
                    setTimeout(checkAndCreate, 100);
                    return;
                }

                const player = new window.YT.Player(elementId, {
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
                        onStateChange: (event: YouTubeEvent) => {
                            handlePlayerStateChange(deckId, event);
                        }
                    },
                });
            };

            checkAndCreate();
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        []
    );

    // Dynamic Player State Handler
    // This is the core of the "Pre-Buffer / Warmup" strategy
    const handlePlayerStateChange = (deckId: DeckId, event: YouTubeEvent) => {
        const player = event.target;
        const state = event.data;

        // CHECK IF THIS DECK IS IN WARMUP MODE
        // We use a custom property or ref to track if this deck is trying to buffer
        if (warmingUpRef.current[deckId]) {
            if (state === window.YT.PlayerState.PLAYING) {
                // It has successfully started playing! 
                // That means pixels are ready.
                // Immediately PAUSE it and mark ready.
                player.pauseVideo();
                warmingUpRef.current[deckId] = false; // Warmup complete
                console.log(`[DECK-${deckId}] WARMUP COMPLETE (Buffered)`);
            }
        }
    };

    // Cue a specific video with "Warmup" logic
    const loadVideoOnDeck = useCallback(
        (deckId: DeckId, videoId: string) => {
            const player = playersRef.current[deckId];
            if (!player) return;

            try {
                // 1. Mark as warming up
                warmingUpRef.current[deckId] = true;

                // 2. Load video at 0 (temporarily) just to get metadata
                // actually, sticking to startSeconds=0 is safest if we don't know duration.
                // WE WILL LOAD, PLAY, WAIT FOR DURATION, THEN SEEK.

                // Strategy: Load at 0.
                // Player will start PLAYING (muted).
                // We catch that state change.
                // We check duration.
                // We seek to random.
                // We wait for it to PLAY again.
                // Then we PAUSE.

                // Simplified Strategy:
                // Just load at a safe guess (e.g. 10s). If video is shorter than 10s... tough luck (most are longer).
                // Or better: Load without startSeconds.

                player.loadVideoById({ videoId });
                player.mute();
                // We trust onStateChange to handle the "Pause when playing" logic

                // BUT we also need to Seek to random time.
                // We can't do that until we know duration.
                // So... let's hook into the State Change more deeply.

                // New Logic for handlePlayerStateChange needs to be smarter.
                // Let's implement a 'phase' system for warmup?
                // Too complex for React state... reusing the ref.

                // Let's rely on a simpler trick:
                // Check duration immediately? Usually 0.
                // Let's wait 500ms then check duration?

                setTimeout(() => {
                    const duration = player.getDuration();
                    if (duration > 0) {
                        const safeStart = SKIP_SECONDS;
                        const safeEnd = Math.max(safeStart + 1, duration - SKIP_SECONDS);
                        const randomStart = safeStart + Math.random() * (safeEnd - safeStart - 5);

                        // Seek now
                        player.seekTo(randomStart, true);
                        // Ensure it plays to fill buffer
                        player.playVideo();
                    } else {
                        // Fallback: just play from 0
                        player.playVideo();
                    }
                }, 800); // 800ms delay to allow metadata load

            } catch (err) {
                console.error(`[DECK-${deckId}] Error loading video:`, err);
            }
        },
        []
    );

    // Beat sync handler
    useEffect(() => {
        if (!initialized || !audioRef.current || paused) return;

        const audio = audioRef.current;
        let animationId: number;

        const checkBeat = () => {
            if (paused) return;

            const currentTime = audio.currentTime;
            const beats = beatMapRef.current;
            const currentIndex = currentBeatIndexRef.current;

            // Check if we've hit the next beat
            if (currentIndex < beats.length && currentTime >= beats[currentIndex]) {
                // Rotation: A -> B -> C -> D -> A

                const nextActive = getNextDeck(activeDeck);
                const deckToReload = activeDeck; // The one we just stopped using

                // 1. ACTIVATE NEXT DECK
                setActiveDeck(nextActive);

                // If the next deck was properly warmed up, it's sitting PAUSED.
                // We command it to PLAY.
                const nextPlayer = playersRef.current[nextActive];
                if (nextPlayer) {
                    nextPlayer.playVideo();
                }

                // 2. STOP OLD DECK
                // It was playing. Now we hide it.
                // We should also Pause it to save resources? 
                // Or just let it be reloaded. Loading overrides it anyway.

                // 3. START LOADING THE "D" DECK (Future buffer)
                // In a 4-deck system (A,B,C,D), if we just moved to B (active),
                // C is Ready, D is Ready... wait.
                // A is now "Old". It becomes the new "Loading" for slot D's position?

                // Let's trace:
                // cycle 0: Active=A. B=Ready. C=Ready. D=Ready.
                // cycle 1: Active=B. A becomes "Recycling". C=Ready. D=Ready.
                // We need to reload A to be ready for when D finishes.

                // Ideally, we keep 2 decks "Ready" if possible.
                // With 4 decks: 1 Active, 2 Ready, 1 Loading.

                const newVideoId = getRandomVideoId();
                setCurrentVideoId(newVideoId); // Update UI

                // Start the heavy lifting on the old deck
                loadVideoOnDeck(deckToReload, newVideoId);

                // Move to next beat
                currentBeatIndexRef.current = currentIndex + 1;

                // Pulse visualizer
                setVisualizerLevels(Array(12).fill(0).map(() => Math.random() * 10 + 4));
            }

            // Reset visualizer gradually
            setVisualizerLevels((prev) =>
                prev.map((v) => Math.max(3, v - 0.3))
            );

            animationId = requestAnimationFrame(checkBeat);
        };

        animationId = requestAnimationFrame(checkBeat);

        // Handle audio loop reset
        const handleLoop = () => {
            currentBeatIndexRef.current = 0;
        };

        audio.addEventListener("ended", handleLoop);
        audio.loop = true;

        return () => {
            cancelAnimationFrame(animationId);
            audio.removeEventListener("ended", handleLoop);
        };
    }, [initialized, activeDeck, paused, getRandomVideoId, loadVideoOnDeck]);

    // Handle Pause/Stop Toggle
    const togglePause = useCallback(() => {
        if (!audioRef.current) return;

        if (paused) {
            // RESUME
            audioRef.current.play();
            // Resume only the active player
            playersRef.current[activeDeck]?.playVideo();
            setPaused(false);
        } else {
            // STOP/PAUSE
            audioRef.current.pause();
            Object.values(playersRef.current).forEach(p => p?.pauseVideo());
            setPaused(true);
        }
    }, [paused, activeDeck]);

    // Initialize system on click
    const handleInitialize = () => {
        if (initialized) return;

        setSplashHidden(true);
        setInitialized(true);

        // Start audio
        if (audioRef.current) {
            audioRef.current.volume = 1;
            audioRef.current.play().catch((err) => {
                console.error("[AUDIO] Playback error:", err);
            });
        }

        // Initialize 4 Decks
        const initDeck = (id: DeckId) => {
            const vid = getRandomVideoId();
            // Initial load
            initPlayer(`deck-${id}`, id, vid, (player) => {
                // Initial Warmup
                // Same logic as loadVideoOnDeck essentially
                warmingUpRef.current[id] = true;

                setTimeout(() => {
                    const duration = player.getDuration();
                    const safeStart = SKIP_SECONDS;
                    const safeEnd = duration > 0 ? Math.max(safeStart + 1, duration - SKIP_SECONDS) : 60;
                    const randomStart = safeStart + Math.random() * (safeEnd - safeStart - 5);

                    player.seekTo(randomStart, true);
                    player.playVideo();

                    // If it's Deck A, don't pause it (handled by state change listener logic? 
                    // actually our state listener pauses EVERYTHING that warms up.
                    // We need to override for Deck A initial launch.

                    if (id === "A") {
                        // Hack: clear warmup flag so it doesn't auto-pause
                        warmingUpRef.current["A"] = false;
                        setCurrentVideoId(vid);
                    }

                }, 1000);
            });
        };

        (["A", "B", "C", "D"] as DeckId[]).forEach(id => initDeck(id));
    };

    // Draggable overlay
    const handleMouseDown = (e: React.MouseEvent) => {
        if (!overlayRef.current) return;
        const rect = overlayRef.current.getBoundingClientRect();
        dragStateRef.current = {
            isDragging: true,
            startX: e.clientX - rect.left,
            startY: e.clientY - rect.top,
        };
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!dragStateRef.current.isDragging || !overlayRef.current) return;
            const x = e.clientX - dragStateRef.current.startX;
            const y = e.clientY - dragStateRef.current.startY;
            overlayRef.current.style.left = `${x}px`;
            overlayRef.current.style.top = `${y}px`;
            overlayRef.current.style.right = "auto";
            overlayRef.current.style.bottom = "auto";
        };

        const handleMouseUp = () => {
            dragStateRef.current.isDragging = false;
        };

        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);

        return () => {
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
        };
    }, []);

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

            {/* Video container */}
            <div className="video-container">
                {(["A", "B", "C", "D"] as DeckId[]).map((deckId) => (
                    <div
                        key={deckId}
                        className={`video-deck ${activeDeck === deckId ? "visible" : "hidden"}`}
                        style={{
                            zIndex: activeDeck === deckId ? 1 : 0,
                            transform: "scale(1.2)"
                        }}
                    >
                        <div id={`deck-${deckId}`} />
                    </div>
                ))}
            </div>

            {/* Status overlay */}
            {initialized && (
                <div
                    ref={overlayRef}
                    className={`status-overlay ${overlayCollapsed ? "collapsed" : ""}`}
                    onMouseDown={handleMouseDown}
                >
                    <div className="status-header">
                        <span className="status-label">SYS STATUS</span>
                        <div className="status-header-right">
                            <div className="rec-indicator" onClick={(e) => { e.stopPropagation(); togglePause(); }} style={{ cursor: 'pointer' }}>
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
                                {overlayCollapsed ? "+" : "−"}
                            </button>
                        </div>
                    </div>

                    {!overlayCollapsed && (
                        <>
                            <div className="status-row">
                                <span className="status-key">VIDEO</span>
                                <span className="status-value">
                                    {paused ? "PAUSED" : currentVideoId.substring(0, 8)}
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

                            <div className="visualizer-bar">
                                {visualizerLevels.map((level, i) => (
                                    <div
                                        key={i}
                                        className="visualizer-segment"
                                        style={{ height: `${paused ? 2 : level}px` }}
                                    />
                                ))}
                            </div>
                        </>
                    )}
                </div>
            )}
        </main>
    );
}
