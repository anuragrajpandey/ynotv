import { useMemo, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsStore } from '../../stores/settingsStore';
import { matchesSearch } from '../../utils/searchNormalization';
import type { SourceWithCategories } from '../../hooks/useChannels';
import type { CustomGroup } from '../../db';
import i18n from '../../i18n';
import './DefaultCategoryModal.css';

/** Setting value meaning "restore the last opened category" (current behavior). */
export const DEFAULT_CATEGORY_LAST = '__last__';
/** Setting value meaning "All Channels" (categoryId = null). */
export const DEFAULT_CATEGORY_ALL = '__all__';

export const DEFAULT_CATEGORY_FAVORITES = '__favorites__';
export const DEFAULT_CATEGORY_WATCHLIST = '__watchlist__';
export const DEFAULT_CATEGORY_RECENT = '__recent__';

interface DefaultCategoryContext {
  grouped: SourceWithCategories[];
  customGroups: CustomGroup[];
  sourceNames: Record<string, string>;
}

/** Untyped t() — the app's i18n.t is key-union typed, but these keys are
 *  composed dynamically (same pattern as KeyboardShortcutsModal/ControllersTab). */
const t = (key: string) => (i18n.t as (k: string) => string)(key);

/** Resolve a stored default-category value to its display label. */
export function defaultCategoryDisplayLabel(
  mode: string,
  ctx: DefaultCategoryContext
): string {
  if (!mode || mode === DEFAULT_CATEGORY_LAST) return t('settings:livetv.channels.lastOpenedCategory');
  if (mode === DEFAULT_CATEGORY_ALL) return t('settings:livetv.channels.allChannels');
  if (mode === DEFAULT_CATEGORY_FAVORITES) return t('settings:livetv.channels.favorites');
  if (mode === DEFAULT_CATEGORY_WATCHLIST) return t('settings:livetv.channels.watchlist');
  if (mode === DEFAULT_CATEGORY_RECENT) return t('settings:livetv.channels.recentlyViewed');
  const customId = mode.startsWith('custom:') ? mode.replace('custom:', '') : mode;
  const group = ctx.customGroups.find((g) => g.group_id === mode || g.group_id === customId);
  if (group) return group.name;
  for (const src of ctx.grouped) {
    const cat = src.categories.find((c) => c.category_id === mode);
    if (cat) return cat.alias || cat.category_name;
  }
  return mode;
}

interface DefaultCategoryModalProps {
  isOpen: boolean;
  current: string;
  grouped: SourceWithCategories[];
  customGroups: CustomGroup[];
  sourceNames: Record<string, string>;
  onClose: () => void;
  onSelect: (mode: string) => void;
}

export function DefaultCategoryModal({
  isOpen,
  current,
  grouped,
  customGroups,
  sourceNames,
  onClose,
  onSelect,
}: DefaultCategoryModalProps) {
  const [query, setQuery] = useState('');
  const [expandedSources, setExpandedSources] = useState<Set<string>>(() => new Set());

  // Reset search query and collapse all sources upon opening the modal
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setExpandedSources(new Set());
    }
  }, [isOpen]);

  const toggleSource = (sourceId: string) => {
    setExpandedSources((prev) => {
      const next = new Set(prev);
      if (next.has(sourceId)) {
        next.delete(sourceId);
      } else {
        next.add(sourceId);
      }
      return next;
    });
  };

  // Sidebar visibility flags — the picker mirrors the LiveTV sidebar, so it
  // respects the same toggles (hidden sidebar entries are not offered).
  const showAllChannels = useSettingsStore((s) => s.showAllChannels);
  const showFavorites = useSettingsStore((s) => s.showFavorites);
  const showWatchlist = useSettingsStore((s) => s.showWatchlist);
  const showRecentlyViewed = useSettingsStore((s) => s.showRecentlyViewed);
  const favoritesMode = useSettingsStore((s) => s.favoritesMode);

  const q = query.trim();

  const specials = useMemo(() => {
    const list: { id: string; label: string; sub?: string }[] = [
      {
        id: DEFAULT_CATEGORY_LAST,
        label: t('settings:livetv.channels.lastOpenedCategory'),
        sub: t('settings:livetv.channels.lastOpenedCategorySub'),
      },
    ];
    if (showAllChannels) list.push({ id: DEFAULT_CATEGORY_ALL, label: t('settings:livetv.channels.allChannels') });
    if (showFavorites && favoritesMode !== 'perSource') {
      list.push({ id: DEFAULT_CATEGORY_FAVORITES, label: t('settings:livetv.channels.favorites') });
    }
    if (showWatchlist) list.push({ id: DEFAULT_CATEGORY_WATCHLIST, label: t('settings:livetv.channels.watchlist') });
    if (showRecentlyViewed) list.push({ id: DEFAULT_CATEGORY_RECENT, label: t('settings:livetv.channels.recentlyViewed') });
    return list;
  }, [showAllChannels, showFavorites, showWatchlist, showRecentlyViewed, favoritesMode]);

  const visibleSpecials = useMemo(
    () => specials.filter((s) => matchesSearch(s.label, q)),
    [specials, q]
  );

  const visibleGroups = useMemo(() => {
    if (!q) return grouped;
    return grouped
      .map((src) => ({
        ...src,
        categories: src.categories.filter((c) => matchesSearch(c.alias || c.category_name, q)),
      }))
      .filter((src) => src.categories.length > 0);
  }, [grouped, q]);

  const visibleCustomGroups = useMemo(
    () => customGroups.filter((g) => matchesSearch(g.name, q)),
    [customGroups, q]
  );

  const hasAny =
    visibleSpecials.length > 0 ||
    visibleCustomGroups.length > 0 ||
    visibleGroups.length > 0;

  if (!isOpen) return null;

  const row = (id: string, name: string, count?: number) => {
    const selected = current === id;
    return (
      <button
        key={id}
        type="button"
        className={`default-cat-row ${selected ? 'selected' : ''}`}
        onClick={() => {
          onSelect(id);
          onClose();
        }}
      >
        <span className="default-cat-name">{name}</span>
        {count !== undefined && <span className="default-cat-count">{count}</span>}
        {selected && <span className="default-cat-check">✓</span>}
      </button>
    );
  };

  const modal = (
    <div className="default-cat-overlay" onClick={onClose}>
      <div className="default-cat-modal" onClick={(e) => e.stopPropagation()}>
        <div className="default-cat-header">
          <h3>{t('settings:livetv.channels.defaultCategory')}</h3>
          <button className="default-cat-close" onClick={onClose} aria-label={t('common:close')}>
            ×
          </button>
        </div>

        <div className="default-cat-search">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('settings:livetv.channels.searchCategories')}
            autoFocus
          />
        </div>

        <div className="default-cat-list">
          {visibleSpecials.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`default-cat-row ${current === s.id ? 'selected' : ''}`}
              onClick={() => {
                onSelect(s.id);
                onClose();
              }}
            >
              <span className="default-cat-name">
                {s.label}
                {s.sub && <span className="default-cat-sub">{s.sub}</span>}
              </span>
              {current === s.id && <span className="default-cat-check">✓</span>}
            </button>
          ))}

          {visibleCustomGroups.length > 0 && (
            <>
              <div className="default-cat-section-title">{t('settings:livetv.channels.customGroups')}</div>
              {visibleCustomGroups.map((g) =>
                row(g.group_id, g.name)
              )}
            </>
          )}

          {visibleGroups.map((src) => {
            const sourceName = sourceNames[src.sourceId] || src.sourceId;
            if (!q && src.categories.length === 0) return null;
            const isExpanded = q ? true : expandedSources.has(src.sourceId);
            return (
              <div key={src.sourceId} className="default-cat-source-group">
                <button
                  type="button"
                  className={`default-cat-source-header ${isExpanded ? 'expanded' : ''}`}
                  onClick={() => toggleSource(src.sourceId)}
                >
                  <span className="default-cat-source-chevron">{isExpanded ? '▾' : '▸'}</span>
                  <span className="default-cat-source-title">{sourceName}</span>
                  <span className="default-cat-source-count">{src.categories.length}</span>
                </button>
                {isExpanded && (
                  <div className="default-cat-source-categories">
                    {src.categories.map((cat) =>
                      row(cat.category_id, cat.alias || cat.category_name, cat.channelCount)
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {!hasAny && (
            <div className="default-cat-empty">{t('settings:livetv.channels.noCategoriesFound')}</div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
