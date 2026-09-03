import { useEffect } from 'react';
import i18n from '../i18n';
import { setPlaybackPresence } from '../services/discord/presence';

export interface PlaybackState {
  playing: boolean;
  paused: boolean;
  title: string | null;
  subtitle?: string | null;
  posterUrl?: string | null;
  positionSec?: number;
  durationSec?: number;
  startTs?: number;
  endTs?: number;
}

export function usePlaybackPresence(state: PlaybackState): void {
  const {
    playing,
    paused,
    title,
    subtitle,
    posterUrl,
    positionSec = 0,
    durationSec = 0,
    startTs,
    endTs,
  } = state;

  useEffect(() => {
    if (!playing || !title) {
      setPlaybackPresence(null);
      return;
    }

    setPlaybackPresence({
      title: title || i18n.t('common:watchingYnotv'),
      subtitle: subtitle || undefined,
      posterUrl: posterUrl || undefined,
      paused,
      positionSec,
      durationSec,
      startTs,
      endTs,
    });
  }, [playing, paused, title, subtitle, posterUrl, positionSec, durationSec, startTs, endTs]);

  // Clean up playback presence on unmount
  useEffect(() => {
    return () => {
      setPlaybackPresence(null);
    };
  }, []);
}
