import { invoke } from '@tauri-apps/api/core';
import i18n from '../../i18n';

export type DiscordConfig = {
  enabled: boolean;
  hideTitle: boolean;
  showWhenPaused: boolean;
  showWhenBrowsing: boolean;
  showPoster: boolean;
  showTimestamp: boolean;
};

export type PlaybackPresence = {
  title: string;
  subtitle?: string;
  posterUrl?: string;
  smallImageUrl?: string;
  year?: string | number;
  paused: boolean;
  positionSec: number;
  durationSec: number;
  /** Absolute unix-seconds start/end (live TV EPG window). When both are
   *  present they override positionSec/durationSec, so the Discord progress
   *  bar spans the program itself instead of the small network buffer. */
  startTs?: number;
  endTs?: number;
};

export type BrowsePresence = {
  details?: string;
  state?: string;
  largeImage?: string;
  largeText?: string;
};

let config: DiscordConfig = {
  enabled: false,
  hideTitle: false,
  showWhenPaused: true,
  showWhenBrowsing: true,
  showPoster: true,
  showTimestamp: true,
};

let playback: PlaybackPresence | null = null;
let browse: BrowsePresence | null = null;
let lastEnabledSent: boolean | null = null;
let lastKey = '';
let lastStartTs: number | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function call(cmd: string, args?: Record<string, unknown>): Promise<void> {
  try {
    await invoke(cmd, args);
  } catch {
    /* discord app not running or RPC disabled; harmless */
  }
}

type Computed = { payload: Record<string, unknown> | null; key: string };
type Base = { payload: Record<string, unknown>; key: string } | null;

function computeBase(): Base {
  if (playback && !(playback.paused && !config.showWhenPaused)) {
    if (config.hideTitle) {
      return {
        payload: {
          details: i18n.t('discord:watchingSomething'),
          state: playback.paused ? i18n.t('discord:paused') : undefined,
          paused: playback.paused,
        },
        key: `hide:${playback.paused}`,
      };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    // Live TV with an EPG window: use the program's absolute start/end directly
    // so the progress bar spans the program rather than the mpv network buffer.
    const hasAbsTimeline =
      playback.startTs != null &&
      playback.endTs != null &&
      playback.endTs > playback.startTs &&
      playback.startTs <= nowSec &&
      playback.endTs > nowSec;
    const remaining = playback.durationSec - playback.positionSec;
    const live = !playback.paused && (hasAbsTimeline || (playback.durationSec > 0 && remaining > 0));
    const state = playback.paused
      ? i18n.t('discord:paused')
      : playback.subtitle || (playback.year != null ? String(playback.year) : undefined);
    return {
      payload: {
        details: playback.title,
        state,
        posterUrl: (config.showPoster && playback.posterUrl) || undefined,
        smallImageUrl: (config.showPoster && playback.smallImageUrl) || undefined,
        largeText: playback.year != null ? `${playback.title} (${playback.year})` : playback.title,
        startTs:
          live && config.showTimestamp
            ? hasAbsTimeline
              ? Math.floor(playback.startTs!)
              : nowSec - Math.floor(playback.positionSec)
            : undefined,
        endTs:
          live && config.showTimestamp
            ? hasAbsTimeline
              ? Math.floor(playback.endTs!)
              : nowSec + Math.floor(remaining)
            : undefined,
        paused: playback.paused,
      },
      key: `play:${playback.title}|${state ?? ''}|${playback.paused}|${playback.posterUrl ?? ''}|${live ? 'ts' : 'nots'}`,
    };
  }
  if (browse && config.showWhenBrowsing) {
    if (config.hideTitle) {
      return {
        payload: { details: i18n.t('discord:browsingYnotv') },
        key: 'browse:hide',
      };
    }
    return {
      payload: {
        details: browse.details ?? i18n.t('discord:browsingYnotv'),
        state: browse.state,
        posterUrl: (config.showPoster && browse.largeImage) || undefined,
        largeText: browse.largeText ?? browse.details,
      },
      key: `browse:${browse.details ?? ''}|${browse.state ?? ''}|${browse.largeImage ?? ''}`,
    };
  }
  return null;
}

function compute(): Computed {
  const base = computeBase();
  if (!base) return { payload: null, key: 'clear' };
  return base;
}

function flush(): void {
  if (lastEnabledSent !== config.enabled) {
    lastEnabledSent = config.enabled;
    if (!config.enabled) {
      void call('discord_clear');
      void call('discord_set_enabled', { on: false });
      lastKey = '';
      lastStartTs = null;
      return;
    }
    void call('discord_set_enabled', { on: true });
  }
  if (!config.enabled) {
    void call('discord_clear');
    lastKey = '';
    lastStartTs = null;
    return;
  }
  const { payload, key } = compute();
  const startTs = payload && typeof payload.startTs === 'number' ? payload.startTs : null;
  const seeked = startTs != null && lastStartTs != null && Math.abs(startTs - lastStartTs) > 4;
  if (key === lastKey && !seeked) return;
  lastKey = key;
  lastStartTs = startTs;
  if (payload) void call('discord_set_presence', { p: payload });
  else void call('discord_clear');
}

function schedule(): void {
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 800);
}

export function configureDiscord(next: DiscordConfig): void {
  config = next;
  lastKey = '';
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flush();
}

export function setPlaybackPresence(p: PlaybackPresence | null): void {
  playback = p;
  schedule();
}

export function setBrowsePresence(b: BrowsePresence | null): void {
  browse = b;
  schedule();
}
