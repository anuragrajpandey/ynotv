import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { LayoutMode, type MultiviewEngineMode } from '../../hooks/useMultiview';
import './LayoutPicker.css';

interface LayoutPickerProps {
    currentLayout: LayoutMode;
    onSelect: (layout: LayoutMode) => void;
    engineMode: MultiviewEngineMode;
    onEngineChange: (mode: MultiviewEngineMode) => void;
    isHeroPage?: boolean;
    onOpenChange?: (open: boolean) => void;
}

const LAYOUTS: { mode: LayoutMode; labelKey: string; descKey: string }[] = [
    {
        mode: 'main',
        labelKey: 'layoutMain',
        descKey: 'layoutMainDesc',
    },
    {
        mode: 'pip',
        labelKey: 'layoutPip',
        descKey: 'layoutPipDesc',
    },
    {
        mode: 'sbs',
        labelKey: 'layoutSbs',
        descKey: 'layoutSbsDesc',
    },
    {
        mode: 'bigbottom',
        labelKey: 'layoutBigBottom',
        descKey: 'layoutBigBottomDesc',
    },
    {
        mode: '2x2',
        labelKey: 'layout2x2',
        descKey: 'layout2x2Desc',
    },
];

const LAYOUT_LABEL_KEYS: Record<string, string> = {
    layoutMain: 'layoutMain',
    layoutPip: 'layoutPip',
    layoutSbs: 'layoutSbs',
    layoutBigBottom: 'layoutBigBottom',
    layout2x2: 'layout2x2',
};

const LAYOUT_DESC_KEYS: Record<string, string> = {
    layoutMainDesc: 'layoutMainDesc',
    layoutPipDesc: 'layoutPipDesc',
    layoutSbsDesc: 'layoutSbsDesc',
    layoutBigBottomDesc: 'layoutBigBottomDesc',
    layout2x2Desc: 'layout2x2Desc',
};

export function LayoutPicker({ currentLayout, onSelect, engineMode, onEngineChange, isHeroPage, onOpenChange }: LayoutPickerProps) {
    const { t } = useTranslation('player');
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        onOpenChange?.(open);
    }, [open, onOpenChange]);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const handleSelect = (mode: LayoutMode) => {
        onSelect(mode);
        setOpen(false);
    };

    return (
        <div className="layout-picker" ref={ref}>
            <button
                className={`layout-picker-btn title-bar-settings-btn ${currentLayout !== 'main' ? 'layout-picker-btn-active' : ''}`}
                onClick={() => setOpen(o => !o)}
                title={t('layoutLabel', { layout: t(LAYOUT_LABEL_KEYS[LAYOUTS.find(l => l.mode === currentLayout)?.labelKey || 'layoutMain'] as never) })}
            >
                <LayoutIcon mode={currentLayout} />
            </button>

            {open && (
                <div className="layout-picker-dropdown">
                    <div className="layout-picker-header">{t('viewLayout')}</div>

                    {/* Viewer Engine toggle */}
                    <div className="lp-engine-row">
                        <span className="lp-engine-label">{t('viewerEngine')}</span>
                        <div className="lp-engine-pills">
                            <button
                                className={`lp-engine-pill ${engineMode === 'mpv_canvas' ? 'lp-engine-pill-active lp-engine-pill-canvas-active' : ''}`}
                                onClick={() => onEngineChange('mpv_canvas')}
                                title="libmpv In-DOM Canvas with full Overlay support"
                            >
                                CANVAS
                            </button>
                            <button
                                className={`lp-engine-pill ${engineMode === 'mpv' ? 'lp-engine-pill-active' : ''}`}
                                onClick={() => onEngineChange('mpv')}
                                title={t('mpvNativeWindows')}
                            >
                                MPV
                            </button>
                            <button
                                className={`lp-engine-pill lp-engine-pill-hls ${engineMode === 'hls' ? 'lp-engine-pill-active lp-engine-pill-hls-active' : ''}`}
                                onClick={() => onEngineChange('hls')}
                                title={t('hlsInBrowser')}
                            >
                                HLS
                            </button>
                        </div>
                    </div>

                    <div className="layout-picker-divider" />

                    {LAYOUTS.map(layout => (
                        <button
                            key={layout.mode}
                            className={`layout-picker-option ${layout.mode === currentLayout ? 'layout-picker-option-active' : ''}`}
                            onClick={() => handleSelect(layout.mode)}
                        >
                            <div className="layout-picker-preview-wrap">
                                <LayoutPreview mode={layout.mode} />
                            </div>
                            <div className="layout-picker-option-text">
                                <span className="layout-picker-option-label">{t(LAYOUT_LABEL_KEYS[layout.labelKey] as never)}</span>
                                <span className="layout-picker-option-desc">{t(LAYOUT_DESC_KEYS[layout.descKey] as never)}</span>
                            </div>
                            {layout.mode === currentLayout && (
                                <span className="layout-picker-check">✓</span>
                            )}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

// The button icon changes based on current layout
function LayoutIcon({ mode }: { mode: LayoutMode }) {
    if (mode === 'main') {
        // Single square
        return (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="2" width="12" height="12" rx="1.5" fill="currentColor" opacity="0.85" />
            </svg>
        );
    }
    if (mode === 'pip') {
        // Large square + small pip
        return (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="1" y="1" width="14" height="14" rx="1.5" fill="currentColor" opacity="0.4" />
                <rect x="8.5" y="8.5" width="6" height="5" rx="1" fill="currentColor" opacity="0.9" />
            </svg>
        );
    }
    if (mode === 'sbs') {
        // Side by side
        return (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="1" y="4" width="6.5" height="8" rx="1" fill="currentColor" opacity="0.9" />
                <rect x="8.5" y="4" width="6.5" height="8" rx="1" fill="currentColor" opacity="0.5" />
            </svg>
        );
    }
    if (mode === '2x2') {
        // 4-cell grid
        return (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.9" />
                <rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.5" />
                <rect x="1" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.5" />
                <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.5" />
            </svg>
        );
    }
    // bigbottom
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="1" width="14" height="9" rx="1" fill="currentColor" opacity="0.9" />
            <rect x="1" y="12" width="4" height="3" rx="0.75" fill="currentColor" opacity="0.5" />
            <rect x="6" y="12" width="4" height="3" rx="0.75" fill="currentColor" opacity="0.5" />
            <rect x="11" y="12" width="4" height="3" rx="0.75" fill="currentColor" opacity="0.5" />
        </svg>
    );
}

// Small grid preview in dropdown
function LayoutPreview({ mode }: { mode: LayoutMode }) {
    return (
        <div className="layout-preview">
            {mode === 'main' && (
                <div className="lp-main">
                    <div className="lp-cell lp-cell-main" />
                </div>
            )}
            {mode === 'pip' && (
                <div className="lp-pip">
                    <div className="lp-cell lp-cell-main" />
                    <div className="lp-cell lp-cell-pip" />
                </div>
            )}
            {mode === 'sbs' && (
                <div className="lp-sbs">
                    <div className="lp-cell lp-cell-main" />
                    <div className="lp-cell lp-cell-secondary" />
                </div>
            )}
            {mode === '2x2' && (
                <div className="lp-grid-2x2">
                    <div className="lp-cell lp-cell-main" />
                    <div className="lp-cell lp-cell-secondary" />
                    <div className="lp-cell lp-cell-secondary" />
                    <div className="lp-cell lp-cell-secondary" />
                </div>
            )}
            {mode === 'bigbottom' && (
                <div className="lp-bigbottom">
                    <div className="lp-cell lp-cell-main" />
                    <div className="lp-bottom-row">
                        <div className="lp-cell lp-cell-secondary" />
                        <div className="lp-cell lp-cell-secondary" />
                        <div className="lp-cell lp-cell-secondary" />
                    </div>
                </div>
            )}
        </div>
    );
}
