import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type LayoutMode = 'main' | 'pip' | '2x2' | 'bigbottom' | 'sbs';
export type MultiviewEngineMode = 'mpv' | 'hls' | 'mpv_canvas';

export interface ViewerSlot {
    id: 2 | 3 | 4;
    channelName: string | null;
    channelUrl: string | null;
    sourceName: string | null;
    active: boolean;
}

export interface MainSlot {
    channelName: string | null;
    channelUrl: string | null;
    sourceName: string | null;
}

const EMPTY_SLOTS: ViewerSlot[] = [
    { id: 2, channelName: null, channelUrl: null, sourceName: null, active: false },
    { id: 3, channelName: null, channelUrl: null, sourceName: null, active: false },
    { id: 4, channelName: null, channelUrl: null, sourceName: null, active: false },
];

// BOTTOM_BAR_HEIGHT is dynamically calculated for 16:9 ratio in useMultiview now
const CONTROL_BAR_HEIGHT = 36;

// UI element heights that multiview must avoid
const TITLE_BAR_HEIGHT = 32; // Title bar height
const MEDIA_BAR_HEIGHT = 124; // Now playing bar height (approximate, includes padding)

/** Scale factor applied to mpv_set_geometry coordinates to account for DPR */
function dpr() {
    return window.devicePixelRatio || 1;
}

/** Compute the target rect (in physical pixels) for the primary MPV slot */
export function primaryRect(mode: LayoutMode, engineMode: MultiviewEngineMode = 'mpv'): { x: number; y: number; w: number; h: number } {
    const d = dpr();
    const zoom = parseFloat(document.documentElement.style.getPropertyValue('--app-zoom')) || 1;
    const W = Math.round(window.innerWidth * d);
    const H = Math.round(window.innerHeight * d);
    const gap = Math.round(2 * d);

    const isDomEngine = engineMode === 'hls' || engineMode === 'mpv_canvas';
    const titleBarH = isDomEngine ? 0 : Math.round(TITLE_BAR_HEIGHT * zoom * d);
    const mediaBarH = (mode === '2x2' || mode === 'bigbottom' || mode === 'sbs') ? 0 : Math.round(MEDIA_BAR_HEIGHT * zoom * d);
    const availableH = H - titleBarH - mediaBarH;

    switch (mode) {
        case '2x2': {
            const cw = Math.floor((W - gap) / 2);
            const ch = Math.floor((availableH - gap) / 2);
            return { x: 0, y: titleBarH, w: cw, h: ch };
        }
        case 'bigbottom': {
            const cellW = Math.floor((W - 2 * gap) / 3);
            const cellH = Math.floor(cellW * 9 / 16);
            return { x: 0, y: titleBarH, w: W, h: availableH - cellH };
        }
        case 'sbs': {
            const maxW = Math.floor((W - gap) / 2);
            const maxH = availableH;
            let cellW = maxW;
            let cellH = Math.floor(cellW * 9 / 16);
            if (cellH > maxH) {
                cellH = maxH;
                cellW = Math.floor(cellH * 16 / 9);
            }
            const totalW = cellW * 2 + gap;
            const offsetX = Math.floor((W - totalW) / 2);
            const offsetY = titleBarH + Math.floor((availableH - cellH) / 2);
            return { x: offsetX, y: offsetY, w: cellW, h: cellH };
        }
        default:
            // main / pip — fill window
            return { x: 0, y: 0, w: 0, h: 0 }; // 0,0 => restore to full size
    }
}

/** Compute the secondary slot rect (physical pixels) */
export function secondaryRect(slotId: 2 | 3 | 4, mode: LayoutMode): { x: number; y: number; w: number; h: number } {
    const el = document.getElementById(`mpv-video-rect-${slotId}`);
    const d = dpr();

    // Prefer reading the exact DOM coordinates of the React layout
    if (el) {
        const rect = el.getBoundingClientRect();
        return {
            x: Math.round(rect.left * d),
            y: Math.round(rect.top * d),
            w: Math.round(rect.width * d),
            h: Math.round(rect.height * d),
        };
    }

    // Fallback math if DOM element is missing 
    const W = Math.round(window.innerWidth * d);
    const H = Math.round(window.innerHeight * d);
    const gap = Math.round(2 * d);
    const titleBarH = Math.round(TITLE_BAR_HEIGHT * d);
    const mediaBarH = (mode === '2x2' || mode === 'bigbottom' || mode === 'sbs') ? 0 : Math.round(MEDIA_BAR_HEIGHT * d);
    const availableH = H - titleBarH - mediaBarH;

    if (mode === 'pip') {
        if (slotId !== 2) {
            return { x: -10000, y: -10000, w: 1, h: 1 };
        }
        const pw = Math.floor(W / 4);
        const ph = Math.floor(availableH / 4);
        const cbh = Math.round(CONTROL_BAR_HEIGHT * d);
        return { x: W - pw - gap, y: H - mediaBarH - ph - gap, w: pw, h: ph - cbh };
    }

    if (mode === '2x2') {
        const cw = Math.floor((W - gap) / 2);
        const ch = Math.floor((availableH - gap) / 2);
        const cbh = Math.round(CONTROL_BAR_HEIGHT * d);
        const positions: Record<2 | 3 | 4, { x: number; y: number }> = {
            2: { x: cw + gap, y: titleBarH },
            3: { x: 0, y: titleBarH + ch + gap },
            4: { x: cw + gap, y: titleBarH + ch + gap },
        };
        const pos = positions[slotId];
        return { x: pos.x, y: pos.y, w: cw, h: ch - cbh };
    }

    if (mode === 'bigbottom') {
        const cellW = Math.floor((W - 2 * gap) / 3);
        const cellH = Math.floor(cellW * 9 / 16);
        const mainH = availableH - cellH;
        const cbh = Math.round(CONTROL_BAR_HEIGHT * d);
        const slotMap: Record<2 | 3 | 4, number> = { 2: 0, 3: 1, 4: 2 };
        const idx = slotMap[slotId];
        return { x: idx * (cellW + gap), y: titleBarH + mainH + gap, w: cellW, h: cellH - cbh };
    }

    if (mode === 'sbs') {
        if (slotId !== 2) {
            return { x: -10000, y: -10000, w: 1, h: 1 };
        }
        const maxW = Math.floor((W - gap) / 2);
        const maxH = availableH;
        let cellW = maxW;
        let cellH = Math.floor(cellW * 9 / 16);
        if (cellH > maxH) {
            cellH = maxH;
            cellW = Math.floor(cellH * 16 / 9);
        }
        const totalW = cellW * 2 + gap;
        const offsetX = Math.floor((W - totalW) / 2);
        const offsetY = titleBarH + Math.floor((availableH - cellH) / 2);
        const cbh = Math.round(CONTROL_BAR_HEIGHT * d);
        return { x: offsetX + cellW + gap, y: offsetY, w: cellW, h: cellH - cbh };
    }

    return { x: 0, y: 0, w: 0, h: 0 };
}

export function useMultiview() {
    const [layout, setLayout] = useState<LayoutMode>('main');
    const [slots, setSlots] = useState<ViewerSlot[]>(EMPTY_SLOTS.map(s => ({ ...s })));
    const mainSlotRef = useRef<MainSlot>({ channelName: null, channelUrl: null, sourceName: null });
    const layoutRef = useRef<LayoutMode>('main');
    const slotsRef = useRef<ViewerSlot[]>(slots);

    // Engine mode: 'mpv' uses native secondary MPV windows; 'hls' uses in-DOM <video>; 'mpv_canvas' uses in-DOM <canvas> via libmpv SW renderer
    const [engineMode, setEngineModeState] = useState<MultiviewEngineMode>(() => {
        const saved = localStorage.getItem('multiviewEngineMode');
        return (saved === 'hls' || saved === 'mpv_canvas') ? saved : 'mpv';
    });
    const engineModeRef = useRef<MultiviewEngineMode>(engineMode);
    useEffect(() => { engineModeRef.current = engineMode; }, [engineMode]);

    const setEngineMode = useCallback(async (mode: MultiviewEngineMode) => {
        const prev = engineModeRef.current;
        engineModeRef.current = mode;
        setEngineModeState(mode);
        localStorage.setItem('multiviewEngineMode', mode);

        // When switching from native MPV → DOM mode, kill any existing native MPV secondary windows
        if (prev === 'mpv' && (mode === 'hls' || mode === 'mpv_canvas')) {
            const activeSlots = slotsRef.current.filter(s => s.active);
            if (activeSlots.length > 0) {
                await invoke('multiview_kill_all').catch(() => { });
            }
        }
        // When switching away from canvas mode, stop canvas streaming slots
        if (prev === 'mpv_canvas' && mode !== 'mpv_canvas') {
            await invoke('multiview_canvas_stop_all').catch(() => { });
        }
    }, []);

    // Tab mode state: save multiview state when a full-screen UI tab opens (Guide, Sports, DVR)
    const savedStateRef = useRef<{ layout: LayoutMode; slots: ViewerSlot[] } | null>(null);
    const isTabModeRef = useRef(false);

    useEffect(() => { layoutRef.current = layout; }, [layout]);
    useEffect(() => { slotsRef.current = slots; }, [slots]);

    /** Resize primary MPV HWND to match the current layout mode */
    const syncMpvGeometry = useCallback(async (mode?: LayoutMode) => {
        // Do not enforce multiview quadrant geometry if we are currently inside a full-screen Tab!
        // The EPG preview pane relies on the Main MPV being strictly unrestricted
        // so its software `video-zoom` scaler can project the video into the preview pane.
        if (isTabModeRef.current) {
            return;
        }

        const m = mode ?? layoutRef.current;
        const placeholder = m !== 'main' ? document.querySelector('.layout-mpv-placeholder') : null;
        
        let r = { x: 0, y: 0, w: 0, h: 0 };
        let hasPlaceholder = false;

        if (placeholder) {
            try {
                const rect = placeholder.getBoundingClientRect();
                const d = window.devicePixelRatio || 1;
                r = {
                    x: Math.round(rect.left * d),
                    y: Math.round(rect.top * d),
                    w: Math.round(rect.width * d),
                    h: Math.round(rect.height * d),
                };
                hasPlaceholder = true;
            } catch (e) {
                // Fallback to primaryRect
            }
        }

        if (!hasPlaceholder) {
            const pr = primaryRect(m, engineModeRef.current);
            r = { x: pr.x, y: pr.y, w: pr.w, h: pr.h };
        }

        try {
            const { Bridge } = await import('../services/tauri-bridge');

            // CRITICAL: Reset video zoom/align when switching to multiview layouts.
            // EPG preview may have set these, causing black screen if not reset.
            if (m !== 'main') {
                try {
                    await Bridge.setProperty('video-zoom', 0);
                    await Bridge.setProperty('video-align-x', 0);
                    await Bridge.setProperty('video-align-y', 0);
                    // Stretch to fill the cell in 2x2 grid; preserve aspect in bigbottom/pip/sbs.
                    await Bridge.setProperty('keepaspect', m !== '2x2');
                } catch (e) {
                    // Ignore reset errors
                }
            } else {
                try {
                    await Bridge.setProperty('keepaspect', true);
                    await Bridge.setProperty('video-zoom', 0);
                    await Bridge.setProperty('video-align-x', 0);
                    await Bridge.setProperty('video-align-y', 0);
                } catch (e) {
                    // Ignore reset errors
                }
            }

            if (r.w > 0 && r.h > 0) {
                await invoke('mpv_set_geometry', { x: r.x, y: r.y, width: r.w, height: r.h });
            } else {
                await invoke('mpv_set_geometry', { x: 0, y: 0, width: 0, height: 0 });
            }
        } catch (e) {
            // Ignore geometry sync errors
        }
    }, []);

    /** Reposition all active secondary MPV slots for the current (or provided) layout */
    const repositionSecondarySlots = useCallback(async (mode?: LayoutMode) => {
        if (engineModeRef.current !== 'mpv') {
            return;
        }
        const m = mode ?? layoutRef.current;
        const activeSlots = slotsRef.current.filter(s => s.active);

        if (activeSlots.length === 0) {
            return;
        }

        const ops = activeSlots.map(async (slot) => {
            const r = secondaryRect(slot.id, m);
            try {
                await invoke('multiview_reposition_slot', {
                    slotId: slot.id,
                    x: r.x,
                    y: r.y,
                    width: r.w,
                    height: r.h,
                });
            } catch (e) {
                // Ignore reposition errors
            }
        });

        await Promise.all(ops);
    }, []);

    /** Re-sync on resize and window move - only when in multiview mode */
    useEffect(() => {
        // Only enable resize/move handlers when in a multiview layout (not 'main')
        if (layoutRef.current === 'main') return;

        let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
        let moveTimeout: ReturnType<typeof setTimeout> | null = null;
        let pendingSync = false;

        const handleSync = () => {
            // When in tab mode, keep secondaries hidden off-screen
            if (isTabModeRef.current) {
                // Keep secondary MPVs hidden off-screen (only if in MPV mode)
                if (engineModeRef.current === 'mpv') {
                    // Do not hide them if EPG multiview grid is active in the DOM (since ChannelPanel positions them)
                    const hasEpgMultiviewGrid = !!document.querySelector('.guide-preview-line-1x4');
                    if (!hasEpgMultiviewGrid) {
                        const hideOps = slotsRef.current.filter(s => s.active).map(s =>
                            invoke('multiview_reposition_slot', { slotId: s.id, x: -10000, y: -10000, width: 1, height: 1 })
                        );
                        Promise.all(hideOps).catch(() => { });
                    }
                }
                return;
            }

            const m = layoutRef.current;
            if (m === 'main') return;

            // Primary MPV (main feed)
            syncMpvGeometry(m);
            // Secondary MPVs (slots 2/3/4)
            if (engineModeRef.current === 'mpv') {
                repositionSecondarySlots(m);
            }
        };

        // Debounced handler - only triggers ONCE after resize finishes
        // Using a long timeout (400ms) to ensure user has stopped resizing
        const scheduleSync = () => {
            pendingSync = true;
            if (resizeTimeout) clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                pendingSync = false;
                handleSync();
            }, 400); // 400ms - only trigger once resize fully settles
        };

        window.addEventListener('resize', scheduleSync);

        // Listen for window move events to keep MPVs positioned correctly after dragging
        let unlistenMove: (() => void) | null = null;
        let disposed = false;
        import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
            const appWindow = getCurrentWindow();
            appWindow.onMoved(() => {
                if (moveTimeout) clearTimeout(moveTimeout);
                moveTimeout = setTimeout(handleSync, 150); // 150ms debounce for move
            }).then(unlisten => {
                if (disposed) unlisten();
                else unlistenMove = unlisten;
            }).catch(() => { /* ignore if not available */ });
        }).catch(() => { /* ignore if Tauri API not available */ });

        return () => {
            disposed = true;
            if (resizeTimeout) clearTimeout(resizeTimeout);
            if (moveTimeout) clearTimeout(moveTimeout);
            window.removeEventListener('resize', scheduleSync);
            if (unlistenMove) unlistenMove();
        };
        // Re-bind when layout changes to/from multiview modes
    }, [layout, syncMpvGeometry, repositionSecondarySlots]);

    const notifyMainLoaded = useCallback((channelName: string, channelUrl: string, sourceName?: string | null) => {
        mainSlotRef.current = { channelName, channelUrl, sourceName: sourceName || null };
    }, []);

    // Tracks the URL currently loaded in each secondary MPV's process
    const activeUrlsRef = useRef<Record<number, string | null>>({ 2: null, 3: null, 4: null });

    const switchLayout = useCallback(async (newLayout: LayoutMode) => {
        if (isTabModeRef.current && savedStateRef.current) {

            // If switching to 'main' while tab is open, we need to clear pending secondary slots
            if (newLayout === 'main') {
                savedStateRef.current.slots = EMPTY_SLOTS.map(s => ({ ...s }));
                setSlots(EMPTY_SLOTS.map(s => ({ ...s })));
            } else if (newLayout === 'pip' || newLayout === 'sbs') {
                // Clear Slots 3 & 4 so they don't leak or stack behind Slot 2
                const ops = [];
                for (const id of [3, 4]) {
                    if (slotsRef.current.find(s => s.id === id)?.active) {
                        ops.push(invoke('multiview_kill_slot', { slotId: id }).catch(() => { }));
                    }
                }
                if (ops.length > 0) await Promise.all(ops);
                savedStateRef.current.slots = savedStateRef.current.slots.map(s =>
                    (s.id === 3 || s.id === 4) ? { ...s, channelName: null, channelUrl: null, sourceName: null, active: false } : s
                );
                setSlots(prev => prev.map(s => (s.id === 3 || s.id === 4) ? { ...s, channelName: null, channelUrl: null, sourceName: null, active: false } : s));
                activeUrlsRef.current[3] = null;
                activeUrlsRef.current[4] = null;
            }
            // Update the pending layout to be restored later
            savedStateRef.current.layout = newLayout;

            // Sync keepaspect property for primary MPV (2x2 grid stretches; SBS/PiP/Main keep aspect)
            try {
                const { Bridge } = await import('../services/tauri-bridge');
                await Bridge.setProperty('keepaspect', newLayout !== '2x2');
            } catch (e) {}

            setLayout(newLayout);
            return;
        }

        const isNativeMpv = engineModeRef.current === 'mpv';
        const isCanvas = engineModeRef.current === 'mpv_canvas';

        if (newLayout === 'main') {
            if (isNativeMpv) {
                // Kill all secondary MPV native windows
                await invoke('multiview_kill_all').catch(() => { });
                // Extra delay for native window destruction before restoring main MPV
                await new Promise(resolve => setTimeout(resolve, 200));
            } else if (isCanvas) {
                await invoke('multiview_canvas_stop_all').catch(() => { });
            }
            setSlots(EMPTY_SLOTS.map(s => ({ ...s })));
            activeUrlsRef.current = { 2: null, 3: null, 4: null };
        } else if (newLayout === 'pip' || newLayout === 'sbs') {
            if (isNativeMpv) {
                // When switching to PiP or SBS, manually kill slots 3 and 4 since they only use slot 2
                const ops = [];
                for (const id of [3, 4]) {
                    if (slotsRef.current.find(s => s.id === id)?.active) {
                        ops.push(invoke('multiview_kill_slot', { slotId: id }).catch(() => { }));
                    }
                }
                if (ops.length > 0) await Promise.all(ops);
            } else if (isCanvas) {
                const ops = [];
                for (const id of [3, 4]) {
                    if (slotsRef.current.find(s => s.id === id)?.active) {
                        ops.push(invoke('multiview_canvas_stop', { slotId: id }).catch(() => { }));
                    }
                }
                if (ops.length > 0) await Promise.all(ops);
            }
            // Wipe them from state
            setSlots(prev => prev.map(s => (s.id === 3 || s.id === 4) ? { ...s, channelName: null, channelUrl: null, sourceName: null, active: false } : s));
            activeUrlsRef.current[3] = null;
            activeUrlsRef.current[4] = null;
        }

        setLayout(newLayout);
        await syncMpvGeometry(newLayout);
        // Only reposition native windows in MPV mode
        if (newLayout !== 'main' && isNativeMpv) {
            setTimeout(() => {
                repositionSecondarySlots(newLayout);
            }, 50);
        }
    }, [syncMpvGeometry, repositionSecondarySlots]);

    /** Load a stream URL into a secondary slot (MPV window or HLS <video> depending on engine mode) */
    const sendToSlot = useCallback(async (slotId: 2 | 3 | 4, channelName: string, channelUrl: string, sourceName: string | null = null, force: boolean = false) => {
        if (isTabModeRef.current && savedStateRef.current && !force && layoutRef.current === 'main') {
            savedStateRef.current.slots = savedStateRef.current.slots.map(s =>
                s.id === slotId ? { ...s, channelName, channelUrl, sourceName, active: true } : s
            );
            setSlots(prev => prev.map(s =>
                s.id === slotId ? { ...s, channelName, channelUrl, sourceName, active: true } : s
            ));
            return;
        }

        if (savedStateRef.current) {
            savedStateRef.current.slots = savedStateRef.current.slots.map(s =>
                s.id === slotId ? { ...s, channelName, channelUrl, sourceName, active: true } : s
            );
        }

        // In DOM modes (HLS or Canvas), secondary slots are in-DOM elements — just update state.
        // The HlsMultiviewCell and CanvasMultiviewCell components self-manage playback from the URL in state.
        if (engineModeRef.current === 'hls' || engineModeRef.current === 'mpv_canvas') {
            activeUrlsRef.current[slotId] = channelUrl;
            setSlots(prev => prev.map(s =>
                s.id === slotId ? { ...s, channelName, channelUrl, sourceName, active: true } : s
            ));
            return;
        }

        const mode = layoutRef.current;
        const r = secondaryRect(slotId, mode);
        // Reserve space for the 36px control bar upfront so the MPV window never
        // covers it while React is rendering the active state.
        const wasInactive = !slotsRef.current.find(s => s.id === slotId)?.active;
        let loadH = r.h;
        if (wasInactive) {
            const cbh = Math.round(CONTROL_BAR_HEIGHT * dpr());
            loadH = Math.max(1, loadH - cbh);
        }
        try {
            await invoke('multiview_load_slot', {
                slotId,
                url: channelUrl,
                x: r.x, y: r.y, width: r.w, height: loadH,
            });
            activeUrlsRef.current[slotId] = channelUrl;
            setSlots(prev => prev.map(s =>
                s.id === slotId ? { ...s, channelName, channelUrl, sourceName, active: true } : s
            ));

            // Stretch video to fill the cell in grid layouts.
            if (mode === '2x2' || mode === 'bigbottom') {
                invoke('multiview_set_property_slot', { slotId, property: 'keepaspect', value: false }).catch(() => { });
            }

            // Wait for the browser to paint the controls bar, then refine position.
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const updatedRect = secondaryRect(slotId, layoutRef.current);
                    invoke('multiview_reposition_slot', {
                        slotId,
                        x: updatedRect.x,
                        y: updatedRect.y,
                        width: updatedRect.w,
                        height: updatedRect.h,
                    }).catch(() => { });
                });
            });
        } catch (err) {
            console.error(`[useMultiview] Failed to load secondary slot ${slotId}:`, err);
        }
    }, []);

    /** Swap: load a secondary slot's stream into the primary MPV and vice versa */
    const swapWithMain = useCallback(async (slotId: 2 | 3 | 4, currentSlots: ViewerSlot[]) => {
        const slot = currentSlots.find(s => s.id === slotId);
        if (!slot?.channelUrl) return;

        const prevMain = { ...mainSlotRef.current };
        const newMainUrl = slot.channelUrl;
        const newMainName = slot.channelName;
        const newMainSourceName = slot.sourceName;

        // Load the secondary stream on Main MPV
        try {
            await invoke('mpv_load', { url: newMainUrl });
        } catch (e) {
            // Ignore mpv_load errors
        }
        mainSlotRef.current = { channelName: newMainName, channelUrl: newMainUrl, sourceName: newMainSourceName };

        // Put the old main stream into the secondary slot
        if (prevMain.channelUrl) {
            if (engineModeRef.current === 'mpv') {
                const r = secondaryRect(slotId, layoutRef.current);
                try {
                    await invoke('multiview_load_slot', {
                        slotId,
                        url: prevMain.channelUrl,
                        x: r.x, y: r.y, width: r.w, height: r.h,
                    });
                } catch (e) {
                    // Ignore multiview_load_slot errors
                }
            }
            activeUrlsRef.current[slotId] = prevMain.channelUrl;
            setSlots(prev => prev.map(s =>
                s.id === slotId
                    ? { ...s, channelName: prevMain.channelName, channelUrl: prevMain.channelUrl, sourceName: prevMain.sourceName, active: true }
                    : s
            ));
        } else {
            if (engineModeRef.current === 'mpv') {
                // Old main was empty — just stop the slot
                await invoke('multiview_stop_slot', { slotId }).catch(() => { });
                // Move the stopped MPV window off-screen to prevent black overlay
                await invoke('multiview_reposition_slot', { slotId, x: -10000, y: -10000, width: 1, height: 1 }).catch(() => { });
            }
            activeUrlsRef.current[slotId] = null;
            setSlots(prev => prev.map(s =>
                s.id === slotId ? { ...s, channelName: null, channelUrl: null, sourceName: null, active: false } : s
            ));
        }
    }, []);

    const stopSlot = useCallback(async (slotId: 2 | 3 | 4) => {
        if (isTabModeRef.current && savedStateRef.current) {
            savedStateRef.current.slots = savedStateRef.current.slots.map(s =>
                s.id === slotId ? { ...s, channelName: null, channelUrl: null, sourceName: null, active: false } : s
            );
            setSlots(prev => prev.map(s =>
                s.id === slotId ? { ...s, channelName: null, channelUrl: null, sourceName: null, active: false } : s
            ));
            return;
        }

        if (engineModeRef.current === 'mpv') {
            await invoke('multiview_stop_slot', { slotId }).catch(() => { });
            // Move the stopped MPV window off-screen to prevent black overlay
            // (MPV with --idle=yes keeps window visible after stop)
            await invoke('multiview_reposition_slot', { slotId, x: -10000, y: -10000, width: 1, height: 1 }).catch(() => { });
        }
        activeUrlsRef.current[slotId] = null;
        setSlots(prev => prev.map(s =>
            s.id === slotId ? { ...s, channelName: null, channelUrl: null, sourceName: null, active: false } : s
        ));
    }, []);

    const setSlotProperty = useCallback(async (slotId: 2 | 3 | 4, property: string, value: any) => {
        try {
            await invoke('multiview_set_property_slot', { slotId, property, value });
        } catch (e) {
            // Ignore setProperty errors
        }
    }, []);

    /** Reload a slot's stream by re-loading the same URL */
    const reloadSlot = useCallback(async (slotId: 2 | 3 | 4) => {
        const slot = slotsRef.current.find(s => s.id === slotId);
        if (!slot?.channelUrl || !slot?.channelName) return;

        if (engineModeRef.current === 'hls' || engineModeRef.current === 'mpv_canvas') {
            // For DOM players, briefly clear the URL then restore to force re-initialization
            activeUrlsRef.current[slotId] = null;
            setSlots(prev => prev.map(s =>
                s.id === slotId ? { ...s, channelUrl: null, active: false } : s
            ));
            setTimeout(() => {
                activeUrlsRef.current[slotId] = slot.channelUrl!;
                setSlots(prev => prev.map(s =>
                    s.id === slotId ? { ...s, channelUrl: slot.channelUrl, channelName: slot.channelName, sourceName: slot.sourceName, active: true } : s
                ));
            }, 150);
        } else {
            await sendToSlot(slotId, slot.channelName, slot.channelUrl, slot.sourceName);
        }
    }, [sendToSlot]);

    /** Enter tab mode: push secondary MPVs off-screen to keep them buffering/playing */
    const enterTabMode = useCallback(async (tabName?: string) => {
        if (isTabModeRef.current) return;
        isTabModeRef.current = true;

        savedStateRef.current = {
            layout: layoutRef.current,
            slots: [...slotsRef.current],
        };

        if (layoutRef.current !== 'main') {
            // Push all active secondary slots off-screen (-10000, -10000) so they don't block the UI
            // but keep playing/buffering audio in the background. (Only needed in native MPV mode)
            if (engineModeRef.current === 'mpv') {
                const ops = slotsRef.current.filter(s => s.active).map(s =>
                    invoke('multiview_reposition_slot', { slotId: s.id, x: -10000, y: -10000, width: 1, height: 1 })
                );
                await Promise.all(ops).catch(() => { });
            }

            try {
                const { Bridge } = await import('../services/tauri-bridge');
                await Bridge.setProperties({
                    'video-zoom': 0,
                    'video-align-x': 0,
                    'video-align-y': 0,
                    'video-aspect-override': -1,
                    'keepaspect': true,
                });
            } catch (e) {
                // Ignore property reset errors
            }

            // Only reset primary MPV geometry to fullscreen for full-page tabs without an embedded video preview
            if (tabName !== 'guide' && tabName !== 'sports') {
                await invoke('mpv_set_geometry', { x: 0, y: 0, width: 0, height: 0 }).catch(() => { });
            }
        }
    }, []);

    /** Exit tab mode: restore saved multiview state, unhiding or loading slots as needed */
    const exitTabMode = useCallback(async () => {
        if (!isTabModeRef.current) return;
        isTabModeRef.current = false;

        const saved = savedStateRef.current;
        savedStateRef.current = null;

        if (!saved) return;

        if (saved.layout === 'main') {
            // The user switched to main layout while tab was open; we need to kill the hidden MPVs
            await invoke('multiview_kill_all').catch(() => { });
            activeUrlsRef.current = { 2: null, 3: null, 4: null };
            await syncMpvGeometry('main');
        } else {
            // Restore primary MPV layout
            await syncMpvGeometry(saved.layout);
            
            // Keep the current active slots that were playing inside EPG
            const currentSlots = slotsRef.current;

            // Stretch secondary slots to fill the cell in grid layouts
            const setStretch = (id: 2 | 3 | 4) => {
                if (engineModeRef.current === 'mpv' && (saved.layout === '2x2' || saved.layout === 'bigbottom')) {
                    invoke('multiview_set_property_slot', { slotId: id, property: 'keepaspect', value: false }).catch(() => { });
                }
            };

            for (const slot of currentSlots) {
                if (slot.active && slot.channelUrl) {
                    const r = secondaryRect(slot.id, saved.layout);
                    // Ensure the slot is loaded and playing the correct URL
                    if (activeUrlsRef.current[slot.id] !== slot.channelUrl) {
                        if (engineModeRef.current === 'mpv') {
                            invoke('multiview_load_slot', {
                                slotId: slot.id, url: slot.channelUrl, x: r.x, y: r.y, width: r.w, height: r.h
                            }).catch(() => { });
                        }
                        activeUrlsRef.current[slot.id] = slot.channelUrl;
                    } else {
                        // Just reposition it back on-screen
                        if (engineModeRef.current === 'mpv') {
                            invoke('multiview_reposition_slot', {
                                slotId: slot.id, x: r.x, y: r.y, width: r.w, height: r.h
                            }).catch(() => { });
                        }
                    }
                    setStretch(slot.id);
                } else {
                    // It is inactive, so make sure it is stopped and positioned off-screen
                    if (activeUrlsRef.current[slot.id]) {
                        if (engineModeRef.current === 'mpv') {
                            invoke('multiview_stop_slot', { slotId: slot.id }).catch(() => { });
                        }
                        activeUrlsRef.current[slot.id] = null;
                    }
                    if (engineModeRef.current === 'mpv') {
                        invoke('multiview_reposition_slot', { slotId: slot.id, x: -10000, y: -10000, width: 1, height: 1 }).catch(() => { });
                    }
                }
            }
        }
    }, [syncMpvGeometry]);

    const visibleSlotIds = ((): Array<2 | 3 | 4> => {
        switch (layout) {
            case 'pip': return [2];
            case 'sbs': return [2];
            case '2x2': return [2, 3, 4];
            case 'bigbottom': return [2, 3, 4];
            default: return [];
        }
    })();

    return {
        layout,
        slots,
        visibleSlots: slots.filter(s => (visibleSlotIds as number[]).includes(s.id)),
        engineMode,
        setEngineMode,
        switchLayout,
        sendToSlot,
        swapWithMain,
        stopSlot,
        reloadSlot,
        setSlotProperty,
        repositionSecondarySlots,
        notifyMainLoaded,
        syncMpvGeometry,
        enterTabMode,
        exitTabMode,
    };
}
