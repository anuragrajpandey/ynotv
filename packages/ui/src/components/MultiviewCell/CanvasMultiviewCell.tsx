/**
 * CanvasMultiviewCell — Secondary slot cell using in-process libmpv Software Rendering into HTML5 <canvas>.
 *
 * Renders decoded video frames directly onto an in-DOM <canvas> element.
 * Because the canvas is part of the React DOM, overlays, context menus, badges,
 * hover cards, and modals render naturally on top using standard CSS z-index stacking.
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke, Channel } from '@tauri-apps/api/core';
import { useSettingsStore } from '../../stores/settingsStore';
import './multiviewCellShared.css';
import './CanvasMultiviewCell.css';

interface CanvasMultiviewCellProps {
    slotId: 2 | 3 | 4;
    channelName: string | null;
    channelUrl: string | null;
    sourceName: string | null;
    active: boolean;
    onSwapWithMain: () => void;
    onStop: () => void;
    onReload: () => void;
    hidden?: boolean;
}

export function CanvasMultiviewCell({
    slotId,
    channelName,
    channelUrl,
    sourceName,
    active,
    onSwapWithMain,
    onStop,
    onReload,
    hidden,
}: CanvasMultiviewCellProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const { t } = useTranslation('player');

    const [volume, setVolume] = useState(100);
    const [muted, setMuted] = useState(true);
    const [playing, setPlaying] = useState(true);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
    const showSourceName = useSettingsStore((s) => s.includeSourceInSearch);

    // Start / Stop canvas stream whenever channelUrl, active, or hidden status changes
    useEffect(() => {
        if (!channelUrl || !active || hidden) {
            invoke('multiview_canvas_stop', { slotId }).catch(() => {});
            return;
        }

        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;

        const rect = container ? container.getBoundingClientRect() : { width: 640, height: 360 };
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const reqW = Math.max(320, Math.round(rect.width * dpr));
        const reqH = Math.max(180, Math.round(rect.height * dpr));

        canvas.width = reqW;
        canvas.height = reqH;

        const channel = new Channel<Uint8Array | number[]>();
        channel.onmessage = (data) => {
            try {
                const uint8 = data instanceof Uint8Array ? data : new Uint8Array(data);
                if (uint8.byteLength < 8) return;

                const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
                const frameW = view.getUint32(0, true);
                const frameH = view.getUint32(4, true);

                if (frameW === 0 || frameH === 0) return;

                const expectedBytes = 8 + frameW * frameH * 4;
                if (uint8.byteLength < expectedBytes) return;

                const canvas = canvasRef.current;
                if (!canvas) return;

                if (canvas.width !== frameW || canvas.height !== frameH) {
                    canvas.width = frameW;
                    canvas.height = frameH;
                }

                const ctx = canvas.getContext('2d');
                if (!ctx) return;

                const pixelSlice = uint8.subarray(8, expectedBytes);
                const pixels = new Uint8ClampedArray(pixelSlice.buffer, pixelSlice.byteOffset, frameW * frameH * 4);
                const imgData = new ImageData(pixels as any, frameW, frameH);
                ctx.putImageData(imgData, 0, 0);
            } catch (e) {
                // Ignore transient frame draw error
            }
        };

        invoke('multiview_canvas_start', {
            slotId,
            url: channelUrl,
            width: reqW,
            height: reqH,
            channel,
        }).catch((err) => {
            console.error(`[CanvasMultiviewCell] Failed to start slot ${slotId}:`, err);
        });

        // Set initial mute & volume
        invoke('multiview_canvas_set_property', { slotId, property: 'mute', value: muted }).catch(() => {});
        invoke('multiview_canvas_set_property', { slotId, property: 'volume', value: volume }).catch(() => {});

        return () => {
            invoke('multiview_canvas_stop', { slotId }).catch(() => {});
        };
    }, [slotId, channelUrl, active, hidden]);

    // Handle container resize (debounced to avoid rapid reallocation during layout transitions)
    useEffect(() => {
        const container = containerRef.current;
        if (!container || !active || hidden) return;

        let resizeTimer: ReturnType<typeof setTimeout> | null = null;

        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                if (width > 0 && height > 0) {
                    if (resizeTimer) clearTimeout(resizeTimer);
                    resizeTimer = setTimeout(() => {
                        const dpr = Math.min(window.devicePixelRatio || 1, 2);
                        const reqW = Math.round(width * dpr);
                        const reqH = Math.round(height * dpr);
                        invoke('multiview_canvas_resize', { slotId, width: reqW, height: reqH }).catch(() => {});
                    }, 50);
                }
            }
        });

        resizeObserver.observe(container);
        return () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeObserver.disconnect();
        };
    }, [slotId, active, hidden]);

    // Volume & Mute helpers
    const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        e.stopPropagation();
        const val = Number(e.target.value);
        setVolume(val);
        if (muted && val > 0) {
            setMuted(false);
            invoke('multiview_canvas_set_property', { slotId, property: 'mute', value: false }).catch(() => {});
        }
        invoke('multiview_canvas_set_property', { slotId, property: 'volume', value: val }).catch(() => {});
    }, [slotId, muted]);

    const handleToggleMute = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        const next = !muted;
        setMuted(next);
        invoke('multiview_canvas_set_property', { slotId, property: 'mute', value: next }).catch(() => {});
    }, [slotId, muted]);

    const handleTogglePlayPause = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        const next = !playing;
        setPlaying(next);
        invoke('multiview_canvas_set_property', { slotId, property: 'pause', value: !next }).catch(() => {});
    }, [slotId, playing]);

    const handleRightClick = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY });
    }, []);

    const displayName = useMemo(() => {
        if (!channelName) return '';
        if (showSourceName && sourceName) {
            return `${channelName} (${sourceName})`;
        }
        return channelName;
    }, [channelName, sourceName, showSourceName]);

    return (
        <div ref={containerRef} className="multiview-cell-container canvas-cell-container">
            {/* The in-DOM canvas surface */}
            <canvas ref={canvasRef} className="canvas-cell-canvas" />

            {/* Transparent click/interaction overlay */}
            <div
                className={`canvas-cell-overlay ${active ? 'multiview-cell-active' : 'multiview-cell-empty'}`}
                onClick={active ? onSwapWithMain : undefined}
                onContextMenu={active ? handleRightClick : undefined}
                title={active ? t('clickToSwapMain') : undefined}
            >
                {active && (
                    <div className="multiview-cell-badge">
                        <span className="multiview-cell-slot-num">{slotId}</span>
                        <span className="canvas-badge">LIBMPV</span>
                        <span className="multiview-cell-channel-name">{displayName}</span>
                    </div>
                )}
            </div>

            {/* Dedicated controls bar at bottom of cell */}
            {active && (
                <div className="multiview-cell-controls" onClick={(e) => e.stopPropagation()} onContextMenu={handleRightClick}>
                    <button
                        className="multiview-control-btn play-pause-btn"
                        onClick={handleTogglePlayPause}
                        title={playing ? t('pause') : t('play')}
                    >
                        {playing ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                            </svg>
                        ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z" />
                            </svg>
                        )}
                    </button>

                    <button
                        className={`multiview-control-btn mute-btn ${muted ? 'muted' : ''}`}
                        onClick={handleToggleMute}
                        title={muted ? t('unmute') : t('mute')}
                    >
                        {muted ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                            </svg>
                        ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                            </svg>
                        )}
                    </button>

                    <input
                        type="range"
                        className="multiview-volume-slider"
                        min="0"
                        max="100"
                        value={muted ? 0 : volume}
                        onChange={handleVolumeChange}
                        title={`${volume}%`}
                    />

                    <button
                        className="multiview-control-btn reload-btn"
                        onClick={(e) => {
                            e.stopPropagation();
                            onReload();
                        }}
                        title={t('reloadStream')}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
                        </svg>
                    </button>

                    <button
                        className="multiview-control-btn stop-btn"
                        onClick={(e) => {
                            e.stopPropagation();
                            onStop();
                        }}
                        title={t('stop')}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6 6h12v12H6z" />
                        </svg>
                    </button>
                </div>
            )}

            {/* Context Menu on right click */}
            {contextMenu && (
                <CanvasCellContextMenu
                    position={contextMenu}
                    channelName={channelName}
                    onPlay={() => {
                        setPlaying(true);
                        invoke('multiview_canvas_set_property', { slotId, property: 'pause', value: false }).catch(() => {});
                        setContextMenu(null);
                    }}
                    onPause={() => {
                        setPlaying(false);
                        invoke('multiview_canvas_set_property', { slotId, property: 'pause', value: true }).catch(() => {});
                        setContextMenu(null);
                    }}
                    onReload={() => {
                        onReload();
                        setContextMenu(null);
                    }}
                    onStop={() => {
                        onStop();
                        setContextMenu(null);
                    }}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </div>
    );
}

function CanvasCellContextMenu({
    position,
    channelName,
    onPlay,
    onPause,
    onReload,
    onStop,
    onClose,
}: {
    position: { x: number; y: number };
    channelName: string | null;
    onPlay: () => void;
    onPause: () => void;
    onReload: () => void;
    onStop: () => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const { t } = useTranslation('player');

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    return (
        <div
            ref={ref}
            className="cell-context-menu"
            style={{ position: 'fixed', left: position.x, top: position.y, zIndex: 9999 }}
        >
            {channelName && <div className="cell-context-header">{channelName}</div>}
            <button className="cell-context-item" onClick={onPlay}>▶ {t('playStream')}</button>
            <button className="cell-context-item" onClick={onPause}>⏸ {t('pauseStream')}</button>
            <button className="cell-context-item" onClick={onReload}>🔄 {t('reloadStream')}</button>
            <button className="cell-context-item cell-context-danger" onClick={onStop}>⏹ {t('stopClearSlot')}</button>
        </div>
    );
}
