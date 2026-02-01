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
                    };
                }
            ) => YouTubePlayer;
            PlayerState: {
                PLAYING: number;
                PAUSED: number;
                ENDED: number;
            };
        };
        onYouTubeIframeAPIReady: () => void;
    }
}

// Deck identifier
type DeckId = "A" | "B" | "C";

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

    // Deck Management State: A -> B -> C rotation
    const [activeDeck, setActiveDeck] = useState<DeckId>("A");

    // Decks are:
    // ACTIVE: Visible, playing
    // BUFFEREd: Hidden, loaded, paused, ready to cut to
    // LOADING: Hidden, actively loading next video

    // Refs
    const audioRef = useRef<HTMLAudioElement>(null);
    const beatMapRef = useRef<number[]>([]);
    const currentBeatIndexRef = useRef(0);
    const playersRef = useRef<Record<DeckId, YouTubePlayer | null>>({
        A: null, B: null, C: null
    });
    const ytApiReadyRef = useRef(false);
    const overlayRef = useRef<HTMLDivElement>(null);
    const dragStateRef = useRef({ isDragging: false, startX: 0, startY: 0 });

    // Track rotation order: A -> B -> C -> A ...
    const deckOrderRef = useRef<DeckId[]>(["A", "B", "C"]);

    // Calculate next deck in rotation
    const getNextDeck = (current: DeckId): DeckId => {
        const idx = deckOrderRef.current.indexOf(current);
        return deckOrderRef.current[(idx + 1) % 3];
    };

    // Calculate deck after next (the one that should start loading)
    const getLoadingDeck = (current: DeckId): DeckId => {
        const idx = deckOrderRef.current.indexOf(current);
        return deckOrderRef.current[(idx + 2) % 3];
    };

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
                        showinfo: 0, // Note: deprecated by YouTube but still good to try
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
                    },
                });
            };

            checkAndCreate();
        },
        []
    );

    // Cue a specific video on a specific player
    // This is the "LOADING" phase
    const loadVideoOnDeck = useCallback(
        (deckId: DeckId, videoId: string) => {
            const player = playersRef.current[deckId];
            if (!player) return;

            try {
                // We guess a random start time (0-180s) immediately for speed
                // Or if we know the video usage, we can be smarter.
                // Since we don't have metadata yet, we assume 3 minutes safe range
                // or just start at 3s and seek later if needed.
                // Ideally, we loadVideoById with a startSeconds param for INSTANT seek.
                const randomStart = Math.floor(Math.random() * 120) + SKIP_SECONDS; // 2 min window safest

                player.loadVideoById({
                    videoId: videoId,
                    startSeconds: randomStart
                });
                player.mute();
                // Pause immediately after loading to buffer? 
                // Actually for seamless playback often better to let it play muted
                // but since it's hidden, playing is fine.
                // We'll let it play (it's muted and hidden).
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
            if (paused) return; // double check

            const currentTime = audio.currentTime;
            const beats = beatMapRef.current;
            const currentIndex = currentBeatIndexRef.current;

            // Check if we've hit the next beat
            if (currentIndex < beats.length && currentTime >= beats[currentIndex]) {
                // 1. Determine rotation:
                // Current Active -> becomes Loading (recycles)
                // Current Buffered -> becomes Active (visible)
                // Current Loading -> becomes Buffered (getting ready)

                // My logic in state is simply "activeDeck".
                // So if Active is A...
                // Next Active should be B (which was buffered).
                // C (which was loading) becomes the new Buffered.
                // A (old active) becomes the new Loading.

                const nextActive = getNextDeck(activeDeck);
                const deckToReload = activeDeck; // The one we just finished using

                // SWITCH VISIBLE DECK
                setActiveDeck(nextActive);

                // Get ID for display
                // Note: We don't easily know the video ID running on the iframe without querying it,
                // but we can track it or just query it (async).
                // Or just pick a new random ID for the deck we are about to reload.
                const newVideoId = getRandomVideoId();
                setCurrentVideoId(newVideoId); // This is technically "next" video ID shown on overlay

                // RELOAD THE OLD DECK (Prepare for 2 turns from now)
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
            Object.values(playersRef.current).forEach(p => p?.playVideo());
            setPaused(false);
        } else {
            // STOP/PAUSE
            audioRef.current.pause();
            Object.values(playersRef.current).forEach(p => p?.pauseVideo());
            setPaused(true);
        }
    }, [paused]);

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

        // Initialize 3 Decks
        // A: Active (starts playing)
        // B: Buffered (loads video, ready to go)
        // C: Loading (loads 3rd video)

        // We'll init players, and in their OnReady, we'll load content
        const initDeck = (id: DeckId) => {
            const vid = getRandomVideoId();
            // Initial load
            initPlayer(`deck-${id}`, id, vid, (player) => {
                // For initial state:
                // A plays immediately
                // B loads and pauses (or plays muted hidden)
                // C loads and pauses

                const randomStart = Math.floor(Math.random() * 60) + 10;
                player.seekTo(randomStart, true);
                player.playVideo();

                if (id === "A") setCurrentVideoId(vid);
            });
        };

        ["A", "B", "C"].forEach(id => initDeck(id as DeckId));
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
                <div className="splash-subtitle">PHONK // WARCORE // VISUALIZER</div>
            </div>

            {/* Video container */}
            <div className="video-container">
                {/* 
                   We render 3 decks. 
                   Only the 'activeDeck' is visible (opacity 1, z-index 1).
                   Others are hidden (opacity 0, z-index 0).
                */}
                {(["A", "B", "C"] as DeckId[]).map((deckId) => (
                    <div
                        key={deckId}
                        className={`video-deck ${activeDeck === deckId ? "visible" : "hidden"}`}
                        style={{
                            zIndex: activeDeck === deckId ? 1 : 0,
                            // Scale up to hide youtube titles/controls at top/bottom
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
