import { useEffect, useRef, useState } from 'react';
import { OnScreenKeyboardModal } from './OnScreenKeyboardModal';
import { applyTvFocus } from '../services/spatialNavigation';
import './ControllerSearchModal.css';

export type SearchScope = 'channels' | 'epg' | 'both';

interface ControllerSearchModalProps {
  isOpen: boolean;
  initialScope: SearchScope;
  /** Shared search history (same store as the titlebar search). */
  history: string[];
  addToHistory: (query: string) => void;
  removeFromHistory: (query: string) => void;
  clearHistory: () => void;
  onSearch: (query: string, scope: SearchScope) => void;
  onClose: () => void;
}

const SCOPE_LABELS: Record<SearchScope, string> = {
  channels: 'Channels',
  epg: 'EPG',
  both: 'Both',
};

export function ControllerSearchModal({
  isOpen,
  initialScope,
  history,
  addToHistory,
  removeFromHistory,
  clearHistory,
  onSearch,
  onClose,
}: ControllerSearchModalProps) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchScope>(initialScope);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const inputRef = useRef<HTMLButtonElement | null>(null);

  // On open: reset state to the current config and land TV focus on the input
  // box so the very first controller press starts from the search field.
  useEffect(() => {
    if (!isOpen) return;
    setScope(initialScope);
    setShowKeyboard(false);
    const t = setTimeout(() => {
      if (inputRef.current) {
        applyTvFocus(inputRef.current);
      }
    }, 80);
    return () => clearTimeout(t);
  }, [isOpen, initialScope]);

  if (!isOpen) return null;

  const submitSearch = (rawQuery: string) => {
    const trimmed = rawQuery.trim();
    if (!trimmed) return;
    addToHistory(trimmed);
    onSearch(trimmed, scope);
  };

  return (
    <div className="controller-search-overlay" onClick={onClose}>
      <div className="controller-search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="controller-search-header">
          <h3>Search</h3>
          <button
            className="modal-close controller-search-close"
            onClick={onClose}
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Search query box — selecting it opens the on-screen keyboard */}
        <button
          ref={inputRef}
          type="button"
          className={`controller-search-input${query ? ' has-value' : ''}`}
          onClick={() => setShowKeyboard(true)}
        >
          {query || 'Enter search…'}
        </button>

        {/* Search scope */}
        <div className="controller-search-scope">
          <span className="controller-search-scope-label">Search in</span>
          <div className="controller-search-scope-btns">
            {(['channels', 'epg', 'both'] as SearchScope[]).map((s) => (
              <button
                key={s}
                type="button"
                className={`controller-search-scope-btn${scope === s ? ' active' : ''}`}
                onClick={() => setScope(s)}
              >
                {SCOPE_LABELS[s]}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          className="controller-search-submit"
          onClick={() => submitSearch(query)}
        >
          Search
        </button>

        {/* Past searches */}
        {history.length > 0 && (
          <div className="controller-search-history">
            <div className="controller-search-history-header">
              <span>Recent searches</span>
              <button
                type="button"
                className="controller-search-history-clear"
                onClick={clearHistory}
              >
                Clear all
              </button>
            </div>
            <div className="controller-search-history-list">
              {history.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="controller-search-history-item"
                  onClick={() => submitSearch(item)}
                >
                  <svg
                    className="controller-search-history-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  <span className="controller-search-history-text">{item}</span>
                  <span
                    className="controller-search-history-remove"
                    role="button"
                    tabIndex={0}
                    title="Remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFromHistory(item);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        removeFromHistory(item);
                      }
                    }}
                  >
                    ✕
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* On-screen keyboard (stacked above the modal while open) */}
      {showKeyboard && (
        <OnScreenKeyboardModal
          initialValue={query}
          title="Enter search"
          onCommit={(v) => {
            setShowKeyboard(false);
            setQuery(v);
            submitSearch(v);
          }}
          onCancel={() => setShowKeyboard(false)}
        />
      )}
    </div>
  );
}
