/**
 * Spatial Navigation engine for YNOTV.
 * Handles 2D directional navigation across TV channels, EPG program timeline,
 * movie/series cards, category strips, settings menus, and dialogs.
 */

import './spatialNavigation.css';

export type SpatialDir = 'up' | 'down' | 'left' | 'right';

const INTERACTIVE_SELECTOR = [
  'button:not([disabled]):not(.title-bar-control):not(.close)',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex="0"]',
  '[role="button"]:not([aria-disabled="true"])',
  '.guide-channel-info',
  '.guide-channel-item',
  '.channel-card',
  '.channel-item',
  '.program-block',
  '.epg-program-block',
  '.category-item',
  '.category-list-bar',
  '.segmented-btn',
  '.movie-card',
  '.series-card',
  '.stremio-card',
  '.nuvio-card',
  '.widget-card',
  '.nav-item',
  '.settings-tab-btn',
  '.settings-nav-item',
  '.mapping-select',
  '.deadzone-range-input',
  '.favorite-btn',
  '.action-btn',
  '.media-btn',
].join(', ');

let lastFocusedElement: HTMLElement | null = null;

if (typeof window !== 'undefined') {
  let lastMouseMoveX = -1;
  let lastMouseMoveY = -1;

  const clearTvFocusMode = (e: Event) => {
    // For mousemove, ignore synthetic 0,0 moves
    if (e.type === 'mousemove') {
      const me = e as MouseEvent;
      if (me.clientX === lastMouseMoveX && me.clientY === lastMouseMoveY) {
        return;
      }
      lastMouseMoveX = me.clientX;
      lastMouseMoveY = me.clientY;
    }

    if (document.body.classList.contains('tv-nav-active')) {
      document.body.classList.remove('tv-nav-active');
    }
    if (lastFocusedElement) {
      lastFocusedElement.classList.remove('tv-focused');
      lastFocusedElement = null;
    }
  };

  window.addEventListener('mousemove', clearTvFocusMode, { passive: true });
  window.addEventListener('mousedown', clearTvFocusMode, { passive: true });
  window.addEventListener('pointerdown', clearTvFocusMode, { passive: true });
  window.addEventListener('wheel', clearTvFocusMode, { passive: true });
}

function isElementVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function getActiveModal(): HTMLElement | null {
  const modals = Array.from(
    document.querySelectorAll<HTMLElement>(
      '.modal-content, [role="dialog"], .settings-modal, .advanced-search-modal, .subtitle-modal, .details-modal, .context-menu, .settings-panel'
    )
  );
  return modals.reverse().find(isElementVisible) || null;
}

function getFocusCandidates(): HTMLElement[] {
  // If a modal or popup is open, trap spatial navigation within the modal
  const openModal = getActiveModal();
  const root = openModal ? openModal : document.body;

  const rawElements = Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR));
  return rawElements.filter(isElementVisible);
}

export function applyTvFocus(el: HTMLElement) {
  if (typeof document === 'undefined') return;

  // Activate TV navigation mode on body
  document.body.classList.add('tv-nav-active');

  // Remove previous .tv-focused
  if (lastFocusedElement && lastFocusedElement !== el) {
    lastFocusedElement.classList.remove('tv-focused');
  }

  lastFocusedElement = el;
  el.classList.add('tv-focused');

  // Ensure element has tabindex so it can receive DOM focus
  if (!el.hasAttribute('tabindex') && el.tagName !== 'BUTTON' && el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'A') {
    el.setAttribute('tabindex', '0');
  }

  // Don't let the native focus scroll fight the positioning below.
  el.focus({ preventScroll: true });

  // Position the focused element inside its scroll container, keeping it clear
  // of the edges. A single instant scroll keeps rapid D-pad presses snappy;
  // the previous mix of native focus scrolling + manual scrollTop + smooth
  // scrollIntoView queued up competing animations that jittered in
  // virtualized lists (rows get recycled mid-animation).
  const scroller = el.closest(
    '[data-virtuoso-scroller], [data-testid="virtuoso-scroller"], .channel-panel, .epg-content, .channels-grid, .movies-grid, .series-grid, .sports-hub, .settings-tab-content, .dvr-dashboard'
  ) as HTMLElement | null;

  if (scroller) {
    // Temporarily disable CSS scroll-behavior so the padding-aware jump below
    // is instant instead of animating on top of the focus scroll.
    const prevBehavior = scroller.style.scrollBehavior;
    scroller.style.scrollBehavior = 'auto';
    try {
      const scrollerRect = scroller.getBoundingClientRect();
      const elemRect = el.getBoundingClientRect();

      if (elemRect.bottom > scrollerRect.bottom - 48) {
        scroller.scrollTop += (elemRect.bottom - scrollerRect.bottom + 70);
      } else if (elemRect.top < scrollerRect.top + 48) {
        scroller.scrollTop -= (scrollerRect.top - elemRect.top + 70);
      }
    } finally {
      scroller.style.scrollBehavior = prevBehavior;
    }
  }

  // Horizontal alignment (EPG timeline) and non-scroller containers. Explicit
  // 'auto' overrides CSS scroll-behavior so focus moves stay instant.
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });

  // Remember this item as the view's focus position (per-view focus memory),
  // so returning to the view restores the browsing position.
  const view = viewKeyFor(el);
  if (view) {
    const key = itemKeyFor(el);
    if (key) {
      const scroller = findScrollerFor(el);
      focusMemory.set(view, { key, scrollTop: scroller ? scroller.scrollTop : 0 });
    }
  }
}

// ---------------------------------------------------------------------------
// Per-view focus memory & edge feedback
// ---------------------------------------------------------------------------

const VIEW_CONTAINERS: Array<[string, string]> = [
  ['.channel-panel, .guide-panel, .epg-container', 'guide'],
  ['.movies-grid, .vod-grid, .vod-page', 'movies'],
  ['.series-grid', 'series'],
  ['.sports-hub', 'sports'],
  ['.dvr-dashboard', 'dvr'],
  ['.tvcp-page, .tv-calendar-page, .calendar-view', 'calendar'],
  ['.settings-body, .settings-tab-content', 'settings'],
];

const SCROLLER_SELECTOR =
  '[data-virtuoso-scroller], [data-testid="virtuoso-scroller"], .channel-panel, .epg-content, .channels-grid, .movies-grid, .series-grid, .sports-hub, .settings-tab-content, .dvr-dashboard';

const focusMemory = new Map<string, { key: string; scrollTop: number }>();

function detectActiveView(): string | null {
  for (const [sel, key] of VIEW_CONTAINERS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && isElementVisible(el)) return key;
  }
  return null;
}

function viewKeyFor(el: HTMLElement): string | null {
  for (const [sel, key] of VIEW_CONTAINERS) {
    if (el.closest(sel)) return key;
  }
  return null;
}

function itemKeyFor(el: HTMLElement): string | null {
  const keyed = el.closest<HTMLElement>('[data-stream-id], [data-id], [data-key]');
  if (!keyed) return null;
  return keyed.getAttribute('data-stream-id') || keyed.getAttribute('data-id') || keyed.getAttribute('data-key');
}

function findScrollerFor(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>(SCROLLER_SELECTOR);
}

function findFocusableByKey(key: string): HTMLElement | null {
  const escape = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s);
  const safe = escape(key);
  return document.querySelector<HTMLElement>(
    `[data-stream-id="${safe}"], [data-id="${safe}"], [data-key="${safe}"]`
  );
}

function findActiveViewScroller(): HTMLElement | null {
  const view = detectActiveView();
  if (!view) return null;
  const pair = VIEW_CONTAINERS.find(([, k]) => k === view);
  if (!pair) return null;
  const container = document.querySelector<HTMLElement>(pair[0]);
  if (!container || !isElementVisible(container)) return null;
  return (
    container.querySelector<HTMLElement>('[data-virtuoso-scroller], [data-testid="virtuoso-scroller"]') ||
    container
  );
}

/** Restore the last focused item in the currently active view, if any. */
export function tryRestoreFocus(): boolean {
  // Never restore while a modal/overlay is open — focus belongs inside it,
  // and the underlying view may still be visible behind it.
  if (getActiveModal()) return false;

  const view = detectActiveView();
  if (!view) return false;
  const mem = focusMemory.get(view);
  if (!mem) return false;

  const el = findFocusableByKey(mem.key);
  if (el && isElementVisible(el)) {
    applyTvFocus(el);
    return true;
  }

  // The remembered item isn't mounted yet (virtualized list). Jump the
  // scroller back near the position it had when focus was recorded so the
  // list mounts it; the caller retries and applyTvFocus fine-tunes.
  const scroller = findActiveViewScroller();
  if (scroller && Math.abs(scroller.scrollTop - mem.scrollTop) > 40) {
    scroller.scrollTop = mem.scrollTop;
  }
  return false;
}

/** Whether the active view has a remembered focus position. */
export function hasFocusMemory(): boolean {
  if (getActiveModal()) return false;
  const view = detectActiveView();
  return view ? focusMemory.has(view) : false;
}

/**
 * Retry-aware initial focus for an opened view: restore the remembered
 * browsing position (waiting briefly for virtualized items to mount), then
 * fall back to the regular first-interactive logic.
 */
export function focusViewOnOpen(retries = 8): void {
  const attempt = (n: number) => {
    if (tryRestoreFocus()) return;
    if (hasFocusMemory() && n > 0) {
      setTimeout(() => attempt(n - 1), 70);
      return;
    }
    focusFirstInteractive();
  };
  attempt(retries);
}

let denyTimer: number | undefined;

/** Brief shake on the focused element when a direction has no target. */
function flashNoTarget() {
  const el = (document.activeElement as HTMLElement | null) || lastFocusedElement;
  if (!el) return;
  el.classList.remove('tv-focus-denied');
  void el.offsetWidth; // restart the animation
  el.classList.add('tv-focus-denied');
  if (denyTimer) window.clearTimeout(denyTimer);
  denyTimer = window.setTimeout(() => el.classList.remove('tv-focus-denied'), 300);
}

export function focusFirstInteractive(): boolean {
  // Restore the last focused item for this view (guide/VOD browsing position).
  if (tryRestoreFocus()) return true;

  const candidates = getFocusCandidates();
  if (candidates.length > 0) {
    // 1. If currently playing channel in EPG exists, focus it first
    const playingChan = candidates.find(
      c => c.classList.contains('guide-channel-info') && Boolean(c.closest('.currently-playing, .selected-channel'))
    );
    if (playingChan) {
      applyTvFocus(playingChan);
      return true;
    }

    // 2. Prioritize EPG channels over category sidebar
    const preferred =
      candidates.find(c => c.classList.contains('guide-channel-info')) ||
      candidates.find(c => c.classList.contains('movie-card') || c.classList.contains('series-card')) ||
      candidates.find(c => c.classList.contains('sports-card') || c.classList.contains('calendar-card')) ||
      candidates.find(c => c.classList.contains('settings-tab-btn')) ||
      candidates.find(c => c.classList.contains('category-item')) ||
      candidates[0];

    applyTvFocus(preferred);
    return true;
  }
  return false;
}

export function moveSpatialFocus(dir: SpatialDir): boolean {
  const current = (document.activeElement as HTMLElement | null) || lastFocusedElement;
  const candidates = getFocusCandidates();

  if (!candidates.length) return false;

  // If nothing is focused or focus is outside the candidates, focus the first candidate
  if (!current || current === document.body || !candidates.includes(current)) {
    focusFirstInteractive();
    return true;
  }

  const curRect = current.getBoundingClientRect();
  const curCenter = {
    x: curRect.left + curRect.width / 2,
    y: curRect.top + curRect.height / 2,
  };

  const isChannelInfo = current.classList.contains('guide-channel-info');
  const isFavoriteBtn = current.classList.contains('favorite-btn');
  const isProgramBlock = current.classList.contains('program-block');

  let bestElement: HTMLElement | null = null;
  let minScore = Infinity;

  for (const cand of candidates) {
    if (cand === current) continue;

    const rect = cand.getBoundingClientRect();
    const center = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };

    const dx = center.x - curCenter.x;
    const dy = center.y - curCenter.y;

    let primary = 0;
    let secondary = 0;
    let valid = false;

    switch (dir) {
      case 'right':
        if (dx > 4) {
          primary = dx;
          secondary = Math.abs(dy);
          valid = true;
        }
        break;
      case 'left':
        if (dx < -4) {
          primary = -dx;
          secondary = Math.abs(dy);
          valid = true;
        }
        break;
      case 'down':
        if (dy > 4) {
          primary = dy;
          secondary = Math.abs(dx);
          valid = true;
        }
        break;
      case 'up':
        if (dy < -4) {
          primary = -dy;
          secondary = Math.abs(dx);
          valid = true;
        }
        break;
    }

    if (!valid) continue;

    // Weight primary direction over orthogonal deviation
    let score = primary + secondary * 2.5;

    // 1. If moving Right from Favorite button, strongly favor its own channel info
    if (dir === 'right' && isFavoriteBtn && cand.classList.contains('guide-channel-info')) {
      if (Math.abs(dy) < 30) {
        score -= 200;
      }
    }

    // 2. If moving Right from Channel Info, strongly favor EPG Program Blocks in the same row
    if (dir === 'right' && isChannelInfo && cand.classList.contains('program-block')) {
      if (Math.abs(dy) < 30) {
        score -= 300; // prioritize program block in the same row
      }
    }

    // 3. If moving Down/Up from Channel Info, strongly favor other Channel Info items in the same column
    if ((dir === 'down' || dir === 'up') && isChannelInfo && cand.classList.contains('guide-channel-info')) {
      if (Math.abs(dx) < 60) {
        score -= 150;
      }
    }

    // 4. If moving Down/Up from a Program Block, strongly favor other Program Blocks in adjacent rows
    if ((dir === 'down' || dir === 'up') && isProgramBlock && cand.classList.contains('program-block')) {
      if (Math.abs(dx) < 120) {
        score -= 150;
      }
    }

    if (score < minScore) {
      minScore = score;
      bestElement = cand;
    }
  }

  if (bestElement) {
    applyTvFocus(bestElement);
    return true;
  }

  // No valid target in that direction — shake the focused element so remote
  // users get tactile feedback at list edges.
  flashNoTarget();
  return false;
}

export function dispatchSpatialNav(action: SpatialDir | 'select' | 'back'): boolean {
  if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
    return moveSpatialFocus(action);
  }

  if (action === 'select') {
    const active = (document.activeElement as HTMLElement | null) || lastFocusedElement;
    if (active && active !== document.body) {
      // Find the actionable button, input, or interactive element
      const actionable = (active.tagName === 'BUTTON' || active.tagName === 'INPUT' || active.tagName === 'A')
        ? active
        : active.querySelector<HTMLElement>('button, a, input, [role="button"]') || active;

      actionable.click();
      actionable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));

      // If user selected a category item in the sidebar, transfer spatial focus into the channels list
      const isCategorySelection =
        active.classList.contains('category-item') ||
        active.classList.contains('category-list-bar') ||
        Boolean(active.closest('.category-strip-scrollable, .category-strip-top'));

      if (isCategorySelection && !active.classList.contains('category-source-header')) {
        setTimeout(() => {
          const firstChan = document.querySelector<HTMLElement>('.guide-channel-info, .channel-item, .channel-card');
          if (firstChan && isElementVisible(firstChan)) {
            applyTvFocus(firstChan);
          }
        }, 150);
      }

      return true;
    }
    return focusFirstInteractive();
  }

  if (action === 'back') {
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      active.blur();
      return true;
    }

    // 1. If an open modal is active, close only that modal
    const openModal = getActiveModal();
    if (openModal) {
      const modalClose = openModal.querySelector<HTMLElement>(
        '.modal-close, .modal-close-btn, [data-action="close"], .dialog-close'
      );
      if (modalClose && isElementVisible(modalClose)) {
        modalClose.click();
        return true;
      }
    }

    // 2. Dispatch custom back navigation event for App.tsx router (Safe: Never closes window)
    window.dispatchEvent(new CustomEvent('ynotv:navigate-view', { detail: { view: 'back' } }));
    return true;
  }

  return false;
}
