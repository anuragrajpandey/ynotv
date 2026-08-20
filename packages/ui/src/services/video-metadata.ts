import { Bridge } from './tauri-bridge';
import { db, ChannelMetadata } from '../db';
import { dbEvents } from '../db/sqlite-adapter';

/**
 * Video metadata capture service
 * Captures resolution, fps, and audio information from MPV player
 */

// In-memory cache to prevent reloading when components remount (e.g., scrolling)
const metadataCache = new Map<string, ChannelMetadata>();

// Automatically clear the in-memory cache when channelMetadata table updates (e.g. from probe scans or sync)
dbEvents.subscribe('channelMetadata', () => {
    metadataCache.clear();
});

export function clearMetadataCache(streamId?: string) {
    if (streamId) {
        metadataCache.delete(streamId);
    } else {
        metadataCache.clear();
    }
}

export interface VideoMetadata {
    width: number;
    height: number;
    fps: number;
    audioChannels: number;
}

/**
 * Capture current video metadata from MPV
 */
export async function captureVideoMetadata(): Promise<VideoMetadata | null> {
    try {
        // Get video properties from MPV
        const width = await Bridge.getProperty('width');
        const height = await Bridge.getProperty('height');
        const fps = await Bridge.getProperty('estimated-vf-fps');
        const audioParams = await Bridge.getProperty('audio-params');

        // audio-params might be null if audio isn't loaded yet
        const audioChannels = audioParams?.channels || 2;

        return {
            width: width || 0,
            height: height || 0,
            fps: fps || 0,
            audioChannels
        };
    } catch (error) {
        console.error('[VideoMetadata] Failed to capture:', error);
        return null;
    }
}

/**
 * Convert resolution to quality label
 */
export function getQualityLabel(width: number, height: number): string {
    if (width >= 3840 || height >= 2160) return '4K';
    if (width >= 1920 || height >= 1080) return '1080p';
    if (width >= 1280 || height >= 720) return '720p';
    return 'SD';
}

/**
 * Format audio channels to human-readable string
 */
export function formatAudioChannels(channels: number): string {
    if (channels >= 6) return '5.1';
    if (channels === 2) return 'Stereo';
    if (channels === 1) return 'Mono';
    return `${channels}CH`;
}

/**
 * Save channel metadata to database and cache
 */
export async function saveChannelMetadata(
    streamId: string,
    sourceId: string,
    metadata: VideoMetadata
): Promise<void> {
    const existing = await db.channelMetadata.get(streamId);
    const channelMetadata: ChannelMetadata = {
        stream_id: streamId,
        source_id: sourceId,
        resolution_width: metadata.width,
        resolution_height: metadata.height,
        fps: metadata.fps,
        audio_channels: formatAudioChannels(metadata.audioChannels),
        quality_label: getQualityLabel(metadata.width, metadata.height),
        video_bitrate_kbps: existing?.video_bitrate_kbps ?? null,
        audio_bitrate_kbps: existing?.audio_bitrate_kbps ?? null,
        bitrate_kbps: existing?.bitrate_kbps ?? null,
        last_updated: new Date().toISOString()
    };

    await db.channelMetadata.put(channelMetadata);
    // Update cache so badges show immediately
    metadataCache.set(streamId, channelMetadata);
    console.log(`[VideoMetadata]  Saved for ${streamId}:`, channelMetadata);
}

/**
 * Get channel metadata from cache or database
 * Uses in-memory cache for instant retrieval on remount
 */
export async function getChannelMetadata(streamId: string, forceRefresh = false): Promise<ChannelMetadata | null> {
    try {
        // Check memory cache first unless forceRefresh is true
        if (!forceRefresh) {
            const cached = metadataCache.get(streamId);
            if (cached) return cached;
        }

        // Fall back to SQLite DB
        const metadata = await db.channelMetadata.get(streamId);
        if (metadata) {
            metadataCache.set(streamId, metadata);
        }
        return metadata || null;
    } catch (error) {
        console.error('[VideoMetadata] Failed to get metadata:', error);
        return null;
    }
}

/**
 * Capture and save metadata for currently playing channel
 * Should be called after video starts playing successfully.
 * Retries with exponential backoff if stream hasn't loaded yet.
 */
export async function captureAndSaveMetadata(streamId: string, sourceId: string): Promise<void> {
    const maxRetries = 10;
    const baseDelay = 1000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 1500 : baseDelay * Math.pow(1.5, attempt)));

        const metadata = await captureVideoMetadata();
        if (metadata && metadata.width > 0) {
            await saveChannelMetadata(streamId, sourceId, metadata);
            return;
        }

        console.log(`[VideoMetadata] Retry ${attempt + 1}/${maxRetries} for`, streamId);
    }

    console.warn('[VideoMetadata] No valid metadata captured for', streamId, 'after', maxRetries, 'attempts');
}
