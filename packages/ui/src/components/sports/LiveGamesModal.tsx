import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { SportsEvent } from '@ynotv/core';
import type { StoredChannel } from '../../db';
import { useSportsPolling } from '../../hooks/useSportsPolling';
import { useSportsSettingsStore } from '../../stores/sportsSettingsStore';
import { useTeamChannelLinks } from '../../stores/teamChannelLinksStore';
import { isEventLiveOrPastStart } from '../../services/sports';
import { applyTvFocus } from '../../services/spatialNavigation';
import { GameDetail } from './GameDetail';
import { MiniGameCard } from './SportsLiveGameSidebar';
import './SportsLiveGameSidebar.css';
import './LiveGamesModal.css';

interface LiveGamesModalProps {
  open: boolean;
  onClose: () => void;
  onChannelClick: (channel: StoredChannel) => void;
  currentChannel?: StoredChannel | null;
}

/**
 * Controller/remote-friendly Live Games picker. A large centered modal with
 * big, vertically-navigable game cards — the D-pad entry point for live
 * sports. The mouse hover drawer (SportsLiveGameSidebar) stays as-is; this
 * modal is what the 'Open Live Games' controller action toggles.
 */
export function LiveGamesModal({
  open,
  onClose,
  onChannelClick,
  currentChannel,
}: LiveGamesModalProps) {
  const { t } = useTranslation('sports');
  const [selectedLeague, setSelectedLeague] = useState<string>('all');
  const [selectedEventForDetail, setSelectedEventForDetail] = useState<SportsEvent | null>(null);

  // Live DOM node of each rendered card (event id → .lgm-card) plus the card
  // that most recently opened the Game Detail modal, so closing details can
  // return D-pad focus to that card.
  const cardNodesRef = useRef(new Map<string, HTMLElement>());
  const lastOpenedCardRef = useRef<HTMLElement | null>(null);

  const handleOpenDetails = useCallback((event: SportsEvent) => {
    lastOpenedCardRef.current = cardNodesRef.current.get(event.id) ?? null;
    setSelectedEventForDetail(event);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedEventForDetail(null);
    // Return the D-pad highlight to the card the user opened, so back from
    // details lands back on that game instead of losing the position.
    const card = lastOpenedCardRef.current;
    if (card && card.isConnected) {
      applyTvFocus(card);
    }
  }, []);

  const { liveLeagues, loaded, loadSettings } = useSportsSettingsStore();
  const { ensureLoaded: ensureTeamLinksLoaded } = useTeamChannelLinks();

  useEffect(() => {
    if (!loaded) {
      loadSettings();
    }
  }, [loaded, loadSettings]);

  useEffect(() => {
    ensureTeamLinksLoaded();
  }, [ensureTeamLinksLoaded]);

  // Shared polling hook — guarantees no duplicate requests with the sidebar
  const { events, loading } = useSportsPolling({
    pollingInterval: 30000,
    enabled: loaded && open,
    leagues: loaded ? liveLeagues : undefined,
  });

  // Filter to active live events only
  const liveEvents = useMemo(() => {
    return events.filter(isEventLiveOrPastStart);
  }, [events]);

  // Unique leagues with live games
  const leaguesWithGames = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const e of liveEvents) {
      const existing = map.get(e.league.id);
      if (existing) {
        existing.count++;
      } else {
        map.set(e.league.id, { id: e.league.id, name: e.league.name, count: 1 });
      }
    }
    return Array.from(map.values());
  }, [liveEvents]);

  // Filtered by selected league
  const filteredEvents = useMemo(() => {
    if (selectedLeague === 'all') return liveEvents;
    return liveEvents.filter((e) => e.league.id === selectedLeague);
  }, [liveEvents, selectedLeague]);

  // Reset transient state each time the modal opens
  useEffect(() => {
    if (open) {
      setSelectedLeague('all');
      setSelectedEventForDetail(null);
    }
  }, [open]);

  // Drop the D-pad highlight on the first game card as soon as the modal
  // opens (retrying briefly while live-game data loads), so controller/remote
  // users don't start with no highlight and can press OK / Down immediately.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let attempts = 0;
    const focusFirstCard = () => {
      if (cancelled) return;
      const modal = document.querySelector<HTMLElement>('.lgm-modal');
      const firstCard = modal?.querySelector<HTMLElement>('.lgm-card');
      if (firstCard) {
        applyTvFocus(firstCard);
        return;
      }
      attempts += 1;
      if (attempts < 20) {
        setTimeout(focusFirstCard, 100);
      }
    };
    focusFirstCard();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Close with escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="lgm-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="lgm-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('liveGames', 'Live Games')}
      >
        {/* Header */}
        <div className="lgm-header">
          <div className="lgm-title-row">
            <span className={`slg-live-dot active-red ${liveEvents.length > 0 ? 'pulsing' : 'idle'}`} />
            <span className="lgm-title">{t('liveGames', 'Live Games')}</span>
            {liveEvents.length > 0 && <span className="lgm-count">{liveEvents.length}</span>}
          </div>
          <button
            className="game-detail-close"
            onClick={onClose}
            title={t('close', 'Close')}
            aria-label={t('close', 'Close')}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* League filter bar */}
        {leaguesWithGames.length > 1 && (
          <div className="lgm-leagues-bar">
            <button
              className={`lgm-league-pill ${selectedLeague === 'all' ? 'active' : ''}`}
              onClick={() => setSelectedLeague('all')}
            >
              <span>{t('all', 'All')}</span>
              <span className="lgm-league-pill-count">({liveEvents.length})</span>
            </button>
            {leaguesWithGames.map((l) => (
              <button
                key={l.id}
                className={`lgm-league-pill ${selectedLeague === l.id ? 'active' : ''}`}
                onClick={() => setSelectedLeague(l.id)}
              >
                <span>{l.name}</span>
                <span className="lgm-league-pill-count">({l.count})</span>
              </button>
            ))}
          </div>
        )}

        {/* Game list */}
        <div className="lgm-body">
          {filteredEvents.length > 0 ? (
            filteredEvents.map((event) => (
              <MiniGameCard
                key={event.id}
                event={event}
                className="lgm-card"
                rootRef={(el) => {
                  if (el) {
                    cardNodesRef.current.set(event.id, el);
                  } else {
                    cardNodesRef.current.delete(event.id);
                  }
                }}
                onPlayChannel={onChannelClick}
                onOpenDetails={handleOpenDetails}
                currentStreamId={currentChannel?.stream_id}
              />
            ))
          ) : (
            <div className="slg-empty">
              <span className="slg-empty-icon">🏆</span>
              <span className="slg-empty-title">{t('noLiveGamesTitle', 'No Live Games Right Now')}</span>
              <span className="slg-empty-subtitle">
                {loading
                  ? t('loadingLiveScores', 'Loading live scores...')
                  : t('noLiveGamesSubtitle', 'Check back later for active matchups and live scores.')}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Game Details Modal */}
      {selectedEventForDetail && (
        <GameDetail
          event={selectedEventForDetail}
          onClose={handleCloseDetail}
          variant="glass"
          onPlayChannel={onChannelClick}
        />
      )}
    </div>,
    document.body
  );
}
