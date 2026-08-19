import { useState, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { extractEpisodeNumber } from '../../services/local-library/local-library';
import type { LocalEntry } from '../../services/local-library/types';

interface EditEpisodeMetadataModalProps {
  entry: LocalEntry;
  onClose: () => void;
  onSave: (patch: { season: number | null; episode: number; title: string }) => void;
}

/**
 * Edit the season/episode/title of a single local episode. Used from the
 * right-click context menu on episode cards when the auto-detected season or
 * episode is wrong. Saving is a plain metadata update — the file is never
 * moved or renamed.
 */
export const EditEpisodeMetadataModal = memo(function EditEpisodeMetadataModal({
  entry,
  onClose,
  onSave,
}: EditEpisodeMetadataModalProps) {
  const { t } = useTranslation('vod');
  const detected = extractEpisodeNumber(entry.filename);
  const [season, setSeason] = useState<string>(
    entry.season != null ? String(entry.season) : String(detected?.season ?? 1),
  );
  const [episode, setEpisode] = useState<string>(
    entry.episode != null ? String(entry.episode) : String(detected?.episode ?? 1),
  );
  const [title, setTitle] = useState(entry.title ?? '');

  const seasonNum = parseInt(season, 10);
  const episodeNum = parseInt(episode, 10);
  const validSeason = season.trim() === '' || (!Number.isNaN(seasonNum) && seasonNum >= 0);
  const validEpisode = !Number.isNaN(episodeNum) && episodeNum > 0;
  const valid = validSeason && validEpisode;

  const save = () => {
    if (!valid) return;
    onSave({
      season: season.trim() === '' ? null : seasonNum,
      episode: episodeNum,
      title: title.trim() || entry.title,
    });
  };

  return (
    <div className="local-modal-overlay" onClick={onClose}>
      <div
        className="local-modal-content"
        style={{ maxWidth: '460px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="local-modal-header">
          <div>
            <h3 className="local-modal-title">
              {t('editEpisodeMetadataTitle', 'Edit episode metadata')}
            </h3>
            <p className="local-modal-subtitle" title={entry.filename}>
              {entry.filename}
            </p>
          </div>
          <button type="button" className="local-modal-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="local-modal-body">
          <div className="local-edit-fields">
            <label className="local-edit-field">
              <span>{t('editEpisodeSeason', 'Season')}</span>
              <input
                type="number"
                min={0}
                value={season}
                onChange={(e) => setSeason(e.target.value)}
                placeholder={t('editEpisodeSeasonPlaceholder', 'Auto')}
              />
            </label>
            <label className="local-edit-field">
              <span>{t('editEpisodeNumber', 'Episode')}</span>
              <input
                type="number"
                min={1}
                value={episode}
                onChange={(e) => setEpisode(e.target.value)}
              />
            </label>
            <label className="local-edit-field">
              <span>{t('editEpisodeTitleField', 'Title')}</span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
          </div>
          <p className="local-edit-fields__hint">
            {t('editEpisodeHint', 'Only the metadata changes — the file on disk is never moved or renamed.')}
          </p>
        </div>

        <div className="local-modal-footer">
          <button type="button" className="local-btn local-btn--secondary" onClick={onClose}>
            {t('cancel', 'Cancel')}
          </button>
          <button type="button" className="local-btn local-btn--primary" onClick={save} disabled={!valid}>
            {t('save', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
});
