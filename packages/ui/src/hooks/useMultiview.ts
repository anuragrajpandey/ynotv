import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type LayoutMode = 'main' | 'pip' | '2x2' | 'bigbottom' | 'sbs';
export type MultiviewEngineMode = 'mpv_canvas' | 'hls';

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

/** Scale factor applied to mpv_set_geometry coordinates to account for DPR */
function dpr() {
    return window.devicePixelRatio || 1;
}

/** Compute the target rect (in physical pixels) for the primary MPV slot on the Hero page */
export function primaryRect(mode: LayoutMode, _engineMode?: MultiviewEngineMode): { x: number; y: number; w: number; h: number } {
    const d = dpr();
    const W = Math.round(window.innerWidth * d);
    const H = Math.round(window.innerHeight * d);
    const gap = Math.round(2 * d);

    switch (mode) {
        case '2x2': {
            const cw = Math.floor((W - gap) / 2);
            const ch = Math.floor((H - gap) / 2);
            return { x: 0, y: 0, w: cw, h: ch };
        }
        case 'bigbottom': {
            const cellW = Math.floor((W - 2 * gap) / 3);
            const cellH = Math.floor(cellW * 9 / 16);
            return { x: 0, y: 0, w: W, h: H - cellH };
        }
        case 'sbs': {
            const maxW = Math.floor((W - gap) / 2);
            const maxH = H;
            let cellW = maxW;
            let cellH = Math.floor(cellW * 9 / 16);
            if (cellH > maxH) {
                cellH = maxH;
                cellW = Math.floor(cellH * 16 / 9);
            }
            const totalW = cellW * 2 + gap;
            const offsetX = Math.floor((W - totalW) / 2);
            const offsetY = Math.floor((H - cellH) / 2);
            return { x: offsetX, y: offsetY, w: cellW, h: cellH };
        }
        default:
            // main / pip — fill window
            return { x: 0, y: 0, w: 0, h: 0 };
    }
}

export function useMultiview() {
    const [layout, setLayout] = useState<LayoutMode>('main');
    const [slots, setSlots] = useState<ViewerSlot[]>(EMPTY_SLOTS.map(s => ({ ...s })));
    const mainSlotRef = useRef<MainSlot>({ channelName: null, channelUrl: null, sourceName: null });
    const layoutRef = useRef<LayoutMode>('main');
    const slotsRef = useRef<ViewerSlot[]>(slots);

    // Engine mode: 'mpv_canvas' uses in-DOM <canvas> via libmpv; 'hls' uses in-DOM <video> via hls.js
    const [engineMode, setEngineModeState] = useState<MultiviewEngineMode>(() => {
        const saved = localStorage.getItem('multiviewEngineMode');
        return saved === 'hls' ? 'hls' : 'mpv_canvas';
    });
    const engineModeRef = useRef<MultiviewEngineMode>(engineMode);
    useEffect(() => { engineModeRef.current = engineMode; }, [engineMode]);

    const setEngineMode = useCallback(async (mode: MultiviewEngineMode) => {
        const prev = engineModeRef.current;
        engineModeRef.current = mode;
        setEngineModeState(mode);
        localStorage.setItem('multiviewEngineMode', mode);

        // When switching away from canvas mode, stop canvas streaming slots
        if (prev === 'mpv_canvas' && mode !== 'mpv_canvas') {
            await invoke('multiview_canvas_stop_all').catch(() => { });
        }
    }, []);

    useEffect(() => { layoutRef.current = layout; }, [layout]);
    useEffect(() => { slotsRef.current = slots; }, [slots]);

    /** Resize primary MPV HWND to match the current layout mode on Hero page */
    const syncMpvGeometry = useCallback(async (mode?: LayoutMode) => {
        const m = mode ?? layoutRef.current;
        const placeholder = m !== 'main' ? document.querySelector('.layout-mpv-placeholder') : null;
        
        let r = { x: 0, y: 0, w: 0, h: 0 };
        let hasPlaceholder = false;

        if (placeholder) {
            try {
                const rect = placeholder.getBoundingClientRect();
                const d = dpr();
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
            // Only use primaryRect math if we are on the hero page and not in a tab view
            const pr = primaryRect(m, engineModeRef.current);
            r = { x: pr.x, y: pr.y, w: pr.w, h: pr.h };
        }

        try {
            const { Bridge } = await import('../services/tauri-bridge');

            if (m !== 'main') {
                try {
                    await Bridge.setProperty('video-zoom', 0);
                    await Bridge.setProperty('video-align-x', 0);
                    await Bridge.setProperty('video-align-y', 0);
                    await Bridge.setProperty('keepaspect', m !== '2x2');
                } catch (e) {}
            } else {
                try {
                    await Bridge.setProperty('keepaspect', true);
                    await Bridge.setProperty('video-zoom', 0);
                    await Bridge.setProperty('video-align-x', 0);
                    await Bridge.setProperty('video-align-y', 0);
                } catch (e) {}
            }

            if (r.w > 0 && r.h > 0) {
                await invoke('mpv_set_geometry', { x: r.x, y: r.y, width: r.w, height: r.h });
            } else {
                await invoke('mpv_set_geometry', { x: 0, y: 0, width: 0, height: 0 });
            }
        } catch (e) {}
    }, []);

    const notifyMainLoaded = useCallback((channelName: string, channelUrl: string, sourceName?: string | null) => {
        mainSlotRef.current = { channelName, channelUrl, sourceName: sourceName || null };
    }, []);

    const switchLayout = useCallback(async (newLayout: LayoutMode) => {
        if (newLayout === 'main') {
            await invoke('multiview_canvas_stop_all').catch(() => { });
            setSlots(EMPTY_SLOTS.map(s => ({ ...s })));
        } else if (newLayout === 'pip' || newLayout === 'sbs') {
            // Stop and clear slots 3 and 4
            for (const id of [3, 4]) {
                if (slotsRef.current.find(s => s.id === id)?.active) {
                    invoke('multiview_canvas_stop', { slotId: id }).catch(() => { });
                }
            }
            setSlots(prev => prev.map(s => (s.id === 3 || s.id === 4) ? { ...s, channelName: null, channelUrl: null, sourceName: null, active: false } : s));
        }

        setLayout(newLayout);
        await syncMpvGeometry(newLayout);
    }, [syncMpvGeometry]);

    /** Load a stream URL into a secondary slot */
    const sendToSlot = useCallback(async (slotId: 2 | 3 | 4, channelName: string, channelUrl: string, sourceName: string | null = null) => {
        setSlots(prev => prev.map(s =>
            s.id === slotId ? { ...s, channelName, channelUrl, sourceName, active: true } : s
        ));
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
        } catch (e) {}
        mainSlotRef.current = { channelName: newMainName, channelUrl: newMainUrl, sourceName: newMainSourceName };

        // Put the old main stream into the secondary slot
        if (prevMain.channelUrl) {
            setSlots(prev => prev.map(s =>
                s.id === slotId
                    ? { ...s, channelName: prevMain.channelName, channelUrl: prevMain.channelUrl, sourceName: prevMain.sourceName, active: true }
                    : s
            ));
        } else {
            invoke('multiview_canvas_stop', { slotId }).catch(() => { });
            setSlots(prev => prev.map(s =>
                s.id === slotId ? { ...s, channelName: null, channelUrl: null, sourceName: null, active: false } : s
            ));
        }
    }, []);

    const stopSlot = useCallback(async (slotId: 2 | 3 | 4) => {
        invoke('multiview_canvas_stop', { slotId }).catch(() => { });
        setSlots(prev => prev.map(s =>
            s.id === slotId ? { ...s, channelName: null, channelUrl: null, sourceName: null, active: false } : s
        ));
    }, []);

    const setSlotProperty = useCallback(async (slotId: 2 | 3 | 4, property: string, value: any) => {
        try {
            await invoke('multiview_canvas_set_property', { slotId, property, value });
        } catch (e) {}
    }, []);

    /** Reload a slot's stream by re-loading the same URL */
    const reloadSlot = useCallback(async (slotId: 2 | 3 | 4) => {
        const slot = slotsRef.current.find(s => s.id === slotId);
        if (!slot?.channelUrl || !slot?.channelName) return;

        // Briefly clear URL then restore to trigger re-initialization
        setSlots(prev => prev.map(s =>
            s.id === slotId ? { ...s, channelUrl: null, active: false } : s
        ));
        setTimeout(() => {
            setSlots(prev => prev.map(s =>
                s.id === slotId ? { ...s, channelUrl: slot.channelUrl, channelName: slot.channelName, sourceName: slot.sourceName, active: true } : s
            ));
        }, 150);
    }, []);

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
        notifyMainLoaded,
        syncMpvGeometry,
    };
}
