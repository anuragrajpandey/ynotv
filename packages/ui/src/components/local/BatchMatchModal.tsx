import { useState, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso } from 'react-virtuoso';
import type { LocalEntry } from '../../services/local-library/types';
import { episodeLabel } from '../../services/local-library/local-library';

interface BatchMatchModalProps {
  items: LocalEntry[];
  onClose: () => void;
  onConfirm: (selected: LocalEntry[]) => void;
}

/**
 * Selection step before batch matching: lists the unmatched files with
 * checkboxes so the user can choose exactly which ones get matched against a
 * single series — instead of dumping the entire needs-review list into the
 * identify step. The list is virtualized (react-virtuoso) so thousands of
 * unmatched files stay instant.
 */
export const BatchMatchModal = memo(function BatchMatchModal({
  items,
  onClose,
  onConfirm,
}: BatchMatchModalProps) {
  const { t } = useTranslation('vod');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(items.map((i) => i.id)),
  );
  const [filter, setFilter] = useState('');

  // Live filter over title + filename so users can narrow the list to one
  // series and select exactly those matches.
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        (i.title || '').toLowerCase().includes(q) ||
        i.filename.toLowerCase().includes(q),
    );
  }, [items, filter]);
  const hasFilter = filter.trim().length > 0;

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirm = () => {
    const selected = items.filter((i) => selectedIds.has(i.id));
    if (selected.length > 0) onConfirm(selected);
  };

  return (
    <div className="local-modal-overlay" onClick={onClose}>
      <div
        className="local-modal-content"
        style={{ maxWidth: '620px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="local-modal-header">
          <div>
            <h3 className="local-modal-title">
              {t('batchMatchTitle', 'Batch match files')}
            </h3>
            <p className="local-modal-subtitle">
              {t('batchMatchSubtitle', 'Choose the files to match against one series — unselected files keep their review status.')}
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
          {/* Filter input: narrow the list to a title, then select all matches */}
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', marginBottom: '12px' }}>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('filterFiles', 'Filter files...')}
              className="local-toolbar__search-input"
              style={{ height: '38px', borderRadius: '10px', paddingLeft: '36px' }}
            />
            <span className="local-toolbar__search-icon" style={{ left: '11px' }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
          </div>

          {/* Selection toolbar */}
          <div className="local-batch-toolbar">
            <span className="local-batch-toolbar__count">
              {selectedIds.size} {t('selected', 'selected')}
              {hasFilter && filtered.length !== items.length && (
                <span className="local-batch-toolbar__matching">
                  · {t('matching', '{{count}} matching', { count: filtered.length })}
                </span>
              )}
            </span>
            <div className="local-batch-toolbar__actions">
              {hasFilter && (
                <button
                  type="button"
                  className="local-btn local-btn--primary"
                  onClick={() => setSelectedIds(new Set(filtered.map((i) => i.id)))}
                  disabled={filtered.length === 0}
                >
                  {t('selectFiltered', 'Select filtered')}
                </button>
              )}
              <button
                type="button"
                className="local-btn local-btn--secondary"
                onClick={() => setSelectedIds(new Set(items.map((i) => i.id)))}
                disabled={selectedIds.size === items.length}
              >
                {t('selectAll', 'Select All')}
              </button>
              <button
                type="button"
                className="local-btn local-btn--secondary"
                onClick={() => setSelectedIds(new Set())}
                disabled={selectedIds.size === 0}
              >
                {t('selectNone', 'Select None')}
              </button>
            </div>
          </div>

          {/* Virtualized file list with checkboxes */}
          <Virtuoso
            className="local-batch-list"
            style={{ height: 'min(45vh, 400px)' }}
            data={filtered}
            computeItemKey={(_, item) => item.id}
            itemContent={(_index, item) => {
              const checked = selectedIds.has(item.id);
              const label = episodeLabel(item);
              return (
                <div
                  className={`local-batch-row${checked ? ' selected' : ''}`}
                  onClick={() => toggle(item.id)}
                >
                  <span className={`local-batch-checkbox${checked ? ' checked' : ''}`}>
                    {checked && (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </span>
                  <div className="local-batch-row__info">
                    <span className="local-batch-row__title" title={item.filename}>
                      {item.filename}
                    </span>
                    <span className="local-batch-row__meta">
                      {label ? `${label} · ` : ''}
                      {(item.title || '').trim()}
                      {item.year ? ` (${item.year})` : ''}
                    </span>
                  </div>
                </div>
              );
            }}
            overscan={120}
          />
        </div>

        {/* Footer actions */}
        <div className="local-modal-footer">
          <button type="button" className="local-btn local-btn--secondary" onClick={onClose}>
            {t('cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className="local-btn local-btn--primary"
            onClick={confirm}
            disabled={selectedIds.size === 0}
          >
            {t('matchFiles', 'Match {{count}} files', { count: selectedIds.size })}
          </button>
        </div>
      </div>
    </div>
  );
});
