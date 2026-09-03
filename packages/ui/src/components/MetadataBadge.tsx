import { useEffect, useState } from 'react';
import { getChannelMetadata } from '../services/video-metadata';
import type { ChannelMetadata } from '../db';
import { dbEvents } from '../db/sqlite-adapter';
import { useSettingsStore } from '../stores/settingsStore';
import './MetadataBadge.css';

interface MetadataBadgeProps {
    streamId: string;
    variant?: 'compact' | 'detailed';
    location?: 'epg' | 'overlay' | 'search' | 'failover' | 'sports';
    singleLine?: boolean;
    showResolution?: boolean;
    showFps?: boolean;
    showSound?: boolean;
    showBitrate?: boolean;
    showVideoBitrate?: boolean;
    showAudioBitrate?: boolean;
}

// Normalize stored quality labels to a consistent short display form.
// Handles legacy values (e.g. "FHD", "1080P", "UHD") alongside current ones.
function normalizeQualityLabel(label: string): string {
    const value = (label || '').trim();
    const upper = value.toUpperCase();
    if (upper === '4K' || upper === 'UHD') return '4K';
    if (upper === 'FHD' || upper === '1080P' || upper === '1080' || upper === '1920X1080') return '1080p';
    if (upper === 'HD' || upper === '720P' || upper === '720' || upper === '1280X720') return '720p';
    if (upper === 'SD') return 'SD';
    return value;
}

// Normalize stored audio channel strings (e.g. "5.1(SIDE)CH", "STEREOCH", "5.1")
// to a short human-readable form: "5.1", "Stereo", "Mono".
function normalizeAudioChannels(channels: string): string {
    const value = (channels || '').trim();
    const clean = value
        .toUpperCase()
        .replace(/\(.*?\)/g, '') // strip layout detail: "(SIDE)", "(FRONT)"
        .replace(/CH$/i, '')     // strip trailing "CH"
        .trim();
    if (clean === 'STEREO' || clean === '2.0') return 'Stereo';
    if (clean === 'MONO' || clean === '1.0') return 'Mono';
    const match = clean.match(/^\d(?:\.\d+)?/);
    if (match) return match[0];
    return value;
}

// Format average bitrate compactly: >= 1000 kbps to "M" (e.g. "4.6M", "10.9M"), < 1000 to "K" ("128K")
function formatBitrate(kbps: number | null | undefined): string | null {
    if (!kbps || kbps <= 0) return null;
    if (kbps >= 1000) {
        const mbps = (kbps / 1000).toFixed(1).replace(/\.0$/, '');
        return `${mbps}M`;
    }
    return `${Math.round(kbps)}K`;
}

/**
 * MetadataBadge - Displays video quality, FPS, audio channel, and avg bitrate info
 * Automatically refreshes when metadata is updated in the database
 */
export function MetadataBadge({
    streamId,
    variant = 'compact',
    location = 'epg',
    singleLine,
    showResolution,
    showFps,
    showSound,
    showBitrate,
    showVideoBitrate,
    showAudioBitrate,
}: MetadataBadgeProps) {
    const [metadata, setMetadata] = useState<ChannelMetadata | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);
    const epgMetadataBadgeResolution = useSettingsStore((s) => s.epgMetadataBadgeResolution) ?? true;
    const epgMetadataBadgeFps = useSettingsStore((s) => s.epgMetadataBadgeFps) ?? true;
    const epgMetadataBadgeFpsSuffix = useSettingsStore((s) => s.epgMetadataBadgeFpsSuffix) ?? true;
    const epgMetadataBadgeFhdLabels = useSettingsStore((s) => s.epgMetadataBadgeFhdLabels) ?? false;
    const epgMetadataBadgeSound = useSettingsStore((s) => s.epgMetadataBadgeSound) ?? true;
    // Average bitrate badges are configurable per location (EPG, channel info
    // overlay, search results, failover, sports channel linking) so users can
    // enable them only where needed.
    const locationVideoBitrate = useSettingsStore((s) =>
        location === 'overlay' ? (s.epgMetadataBadgeBitrateOverlay ?? false)
        : location === 'search' ? (s.epgMetadataBadgeBitrateSearch ?? false)
        : location === 'failover' ? (s.epgMetadataBadgeBitrateFailover ?? false)
        : location === 'sports' ? (s.epgMetadataBadgeBitrateSports ?? false)
        : (s.epgMetadataBadgeBitrate ?? false)
    );
    const locationAudioBitrate = useSettingsStore((s) =>
        location === 'overlay' ? (s.epgMetadataBadgeAudioBitrateOverlay ?? false)
        : location === 'search' ? (s.epgMetadataBadgeAudioBitrateSearch ?? false)
        : location === 'failover' ? (s.epgMetadataBadgeAudioBitrateFailover ?? false)
        : location === 'sports' ? (s.epgMetadataBadgeAudioBitrateSports ?? false)
        : (s.epgMetadataBadgeAudioBitrate ?? false)
    );

    const effectiveShowResolution = showResolution ?? epgMetadataBadgeResolution;
    const effectiveShowFps = showFps ?? epgMetadataBadgeFps;
    const effectiveShowSound = showSound ?? epgMetadataBadgeSound;
    const effectiveShowVideoBitrate = showVideoBitrate ?? showBitrate ?? locationVideoBitrate;
    const effectiveShowAudioBitrate = showAudioBitrate ?? locationAudioBitrate;

    // Narrow channel lists (sports team linking, failover groups, watch
    // dropdown) render the badge as a single inline row so it fits on one line
    // under the channel name — no need for the two-line split the EPG grid
    // uses. Surfaces opt in via the singleLine prop; sports keeps it as the
    // default so existing call sites don't need touching.
    const useSingleLine = singleLine ?? location === 'sports';

    // Load metadata on mount and when streamId or refreshKey changes (bypassing in-memory cache when refreshed)
    useEffect(() => {
        getChannelMetadata(streamId, refreshKey > 0).then(setMetadata);
    }, [streamId, refreshKey]);

    // Listen to database updates for channelMetadata table only
    // Scoped subscription prevents re-renders on unrelated DB writes (e.g. EPG sync, favorites)
    useEffect(() => {
        const unsubscribe = dbEvents.subscribe('channelMetadata', () => {
            setRefreshKey(prev => prev + 1);
        });
        return unsubscribe;
    }, []);

    // Return null immediately - badge will pop in when data loads
    if (!metadata) return null;

    const { quality_label, fps, audio_channels } = metadata;
    const quality = normalizeQualityLabel(quality_label);
    // Optional consumer-friendly labels: 1080p -> FHD, 720p -> HD (4K/SD unchanged).
    const displayQuality = epgMetadataBadgeFhdLabels
      ? (quality === '1080p' ? 'FHD' : quality === '720p' ? 'HD' : quality)
      : quality;
    const audio = normalizeAudioChannels(audio_channels);
    const videoBitrateVal = metadata.video_bitrate_kbps || metadata.bitrate_kbps;
    const videoBitrate = formatBitrate(videoBitrateVal);
    const audioBitrate = formatBitrate(metadata.audio_bitrate_kbps);

    const hasRes = Boolean(effectiveShowResolution && quality);
    const hasFps = Boolean(effectiveShowFps && fps > 0);
    const hasSound = Boolean(effectiveShowSound && audio);
    const hasPrimary = hasRes || hasFps || hasSound;
    const hasVideoBitrate = Boolean(effectiveShowVideoBitrate && videoBitrate);
    const hasAudioBitrate = Boolean(effectiveShowAudioBitrate && audioBitrate);
    const hasBitrate = hasVideoBitrate || hasAudioBitrate;

    if (!hasPrimary && !hasBitrate) return null;

    if (variant === 'compact') {
        return (
            <div className="metadata-badge compact">
                {hasRes && <span className="quality">{displayQuality}</span>}
            </div>
        );
    }

    if (useSingleLine) {
        return (
            <div className="metadata-badge detailed">
                <div className="metadata-badge-row">
                    {hasRes && <span className="quality">{displayQuality}</span>}
                    {hasFps && <span className="fps">{Math.round(fps)}{epgMetadataBadgeFpsSuffix ? 'fps' : ''}</span>}
                    {hasSound && <span className="audio">{audio}</span>}
                    {hasPrimary && hasBitrate && <span className="bitrate-sep">·</span>}
                    {hasVideoBitrate && (
                        <span className="bitrate video-bitrate" title={`${Math.round(videoBitrateVal ?? 0)} kbps`}>
                            V: {videoBitrate}
                        </span>
                    )}
                    {hasVideoBitrate && hasAudioBitrate && (
                        <span className="bitrate-sep">·</span>
                    )}
                    {hasAudioBitrate && (
                        <span className="bitrate audio-bitrate" title={`${Math.round(metadata.audio_bitrate_kbps ?? 0)} kbps`}>
                            A: {audioBitrate}
                        </span>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className={`metadata-badge detailed ${hasPrimary && hasBitrate ? 'two-line' : ''}`}>
            {hasPrimary && (
                <div className="metadata-badge-row primary">
                    {hasRes && <span className="quality">{displayQuality}</span>}
                    {hasFps && <span className="fps">{Math.round(fps)}{epgMetadataBadgeFpsSuffix ? 'fps' : ''}</span>}
                    {hasSound && <span className="audio">{audio}</span>}
                </div>
            )}
            {hasBitrate && (
                <div className="metadata-badge-row secondary">
                    {hasVideoBitrate && (
                        <span className="bitrate video-bitrate" title={`${Math.round(videoBitrateVal ?? 0)} kbps`}>
                            V: {videoBitrate}
                        </span>
                    )}
                    {hasVideoBitrate && hasAudioBitrate && (
                        <span className="bitrate-sep">·</span>
                    )}
                    {hasAudioBitrate && (
                        <span className="bitrate audio-bitrate" title={`${Math.round(metadata.audio_bitrate_kbps ?? 0)} kbps`}>
                            A: {audioBitrate}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}
