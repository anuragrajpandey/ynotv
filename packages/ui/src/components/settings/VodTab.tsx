import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import './PlaybackTab.css';

interface VodTabProps {
  vodAutoPlayNextEpisode: boolean;
  onVodAutoPlayNextEpisodeChange: (enabled: boolean) => void;
  vodShowSourceBadge: boolean;
  onVodShowSourceBadgeChange: (enabled: boolean) => void;
  useScrollwheelSeek: boolean;
  onUseScrollwheelSeekChange: (enabled: boolean) => void;
  useScrollwheelSeekInvert: boolean;
  onUseScrollwheelSeekInvertChange: (enabled: boolean) => void;
}

export function VodTab({
  vodAutoPlayNextEpisode,
  onVodAutoPlayNextEpisodeChange,
  vodShowSourceBadge,
  onVodShowSourceBadgeChange,
  useScrollwheelSeek,
  onUseScrollwheelSeekChange,
  useScrollwheelSeekInvert,
  onUseScrollwheelSeekInvertChange,
}: VodTabProps) {
  useTranslation();
  return (
    <div className="settings-tab-content">
      <div className="settings-section" style={{ paddingTop: '8px' }}>
        <div className="section-header">
          <h3>{i18n.t('settings:playback.vodTitle')}</h3>
        </div>
        <p className="section-description">
          {i18n.t('settings:playback.vodDesc')}
        </p>

        <div className="timeshift-settings">
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:playback.autoPlayNext')}</span>
              <span className="timeshift-toggle-sub">
                {i18n.t('settings:playback.autoPlayNextSub')}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={vodAutoPlayNextEpisode}
                onChange={(e) => onVodAutoPlayNextEpisodeChange(e.target.checked)}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="timeshift-toggle-row" style={{ marginTop: '12px' }}>
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:playback.showSourceBadge')}</span>
              <span className="timeshift-toggle-sub">
                {i18n.t('settings:playback.showSourceBadgeSub')}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={vodShowSourceBadge}
                onChange={(e) => onVodShowSourceBadgeChange(e.target.checked)}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="timeshift-toggle-row" style={{ marginTop: '12px' }}>
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:playback.scrollwheelSeek')}</span>
              <span className="timeshift-toggle-sub">
                {i18n.t('settings:playback.scrollwheelSeekSub')}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={useScrollwheelSeek}
                onChange={(e) => onUseScrollwheelSeekChange(e.target.checked)}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div
            className="timeshift-toggle-row"
            style={{ marginTop: '12px', opacity: useScrollwheelSeek ? 1 : 0.5, transition: 'opacity 0.2s' }}
          >
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:playback.scrollwheelSeekInvert')}</span>
              <span className="timeshift-toggle-sub">
                {i18n.t('settings:playback.scrollwheelSeekInvertSub')}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={useScrollwheelSeekInvert}
                disabled={!useScrollwheelSeek}
                onChange={(e) => onUseScrollwheelSeekInvertChange(e.target.checked)}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
