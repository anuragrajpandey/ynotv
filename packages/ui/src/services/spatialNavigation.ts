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
  '.media-card',
  '.movie-card',
  '.series-card',
  '.playlist-card',
  '.local-card__poster-wrap',
  '.stremio-card',
  '.stremio-row-card',
  '.stremio-meta-card',
  '.stremio-cw-card',
  '.stremio-cal-ep-card',
  '.stremio-rank-card-container',
  '.stremio-detail-video-card',
  '.stremio-service-item',
  '.nuvio-card',
  '.nuvio-row-card',
  '.nuvio-cw-wide-card',
  '.nuvio-cw-poster-card',
  '.nuvio-cw-card',
  '.nuvio-catalog-card',
  '.nuvio-folder-card',
  '.nuvio-folder-detail-item',
  '.nuvio-collection-folder-card',
  '.nuvio-catalog-item',
  '.nuvio-service-item',
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
// Last known position of the focused element (captured before any scroll
// adjustments). Used to resume near the user's spot when the focused item is
// virtualized out of the DOM mid-scroll, instead of snapping to the view start.
let lastFocusedRect: DOMRect | null = null;
let lastFocusedView: string | null = null;
// Kind of content the user was last focused on (media-card, channel, program,
// …). Used so a lost-focus resume lands on the same kind of content instead
// of drifting to unrelated chrome/rails/toolbars.
let lastFocusedKind: string | null = null;
let cancelPendingVirtualFocus: (() => void) | null = null;
let pendingVirtualFocus = false;

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

export function onUserManualScroll() {
  if (lastFocusedElement) {
    const r = lastFocusedElement.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      lastFocusedElement.classList.remove('tv-focused');
      lastFocusedElement = null;
    }
  }
}

function isElementVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;

  // Walk ancestors and reject anything hidden or off-screen.
  // Overlay/fixed panels (e.g. guide panel sliding out or category strip) that
  // are slid completely off-screen are rejected.
  // Normal content containers inside scrollable views (rows/cards below the fold
  // or horizontally overflowing) must NOT be viewport-clipped so spatial navigation
  // can discover them and scroll them into view.
  let node: HTMLElement | null = el;
  while (node && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    if (node !== el && (style.position === 'fixed' || style.position === 'absolute')) {
      const isOverlayPanel =
        node.classList.contains('guide-panel') ||
        node.classList.contains('category-strip') ||
        node.classList.contains('settings-panel') ||
        node.classList.contains('modal-backdrop') ||
        node.classList.contains('video-controls');
      if (isOverlayPanel) {
        const rect = node.getBoundingClientRect();
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth)
        ) {
          return false;
        }
      }
    }
    node = node.parentElement;
  }

  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function getActiveModal(): HTMLElement | null {
  const modals = Array.from(
    document.querySelectorAll<HTMLElement>(
      '.modal-content, [role="dialog"], .settings-modal, .advanced-search-modal, .subtitle-modal, .details-modal, .context-menu, .settings-panel, .movie-detail, .series-detail, .stremio-detail, [class$="-modal"]'
    )
  );
  return modals.reverse().find(isElementVisible) || null;
}

function getFocusCandidates(): HTMLElement[] {
  // If a modal or popup is open, trap spatial navigation within the modal
  const openModal = getActiveModal();
  const root = openModal ? openModal : document.body;

  const rawElements = Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR));
  return rawElements.filter((el) => {
    if (!isElementVisible(el)) return false;

    // A scroll container is a scroll target, never a nav target.
    if (
      el.hasAttribute('data-virtuoso-scroller') ||
      el.classList.contains('vod-grid-scroller') ||
      el.classList.contains('virtual-grid') ||
      el.classList.contains('virtual-list') ||
      el.classList.contains('virtual-grid__inner') ||
      el.classList.contains('virtual-list__inner')
    ) {
      return false;
    }

    const isScrollContainer =
      el.scrollHeight > el.clientHeight + 4 || el.scrollWidth > el.clientWidth + 4;
    if (
      isScrollContainer &&
      el.tagName !== 'BUTTON' &&
      el.tagName !== 'INPUT' &&
      el.tagName !== 'SELECT' &&
      el.tagName !== 'TEXTAREA' &&
      el.tagName !== 'A' &&
      (el.hasAttribute('tabindex') || el.hasAttribute('role'))
    ) {
      return false;
    }

    // Exclude titlebar search bar & integrated search items so spatial nav skips over them
    if (
      el.classList.contains('title-bar-search-input') ||
      el.classList.contains('title-bar-search-clear') ||
      el.classList.contains('title-bar-advanced-search-btn') ||
      Boolean(el.closest('.title-bar-search-integrated, .title-bar-search-history'))
    ) {
      return false;
    }

    // Exclude hero pagination dots so Down moves directly into catalog/continue watching rows
    if (el.classList.contains('stremio-hero-indicator-dot')) {
      return false;
    }

    // Playlist and Local cards own their D-pad navigation as single targets;
    // their inner action/play/resume/remove buttons (including divs with
    // role="button", like the local hover play button) are mouse-only helpers
    // and must not be reachable with directional keys.
    if (
      (el.tagName === 'BUTTON' || (el.tagName === 'DIV' && el.getAttribute('role') === 'button')) &&
      (el.closest('.playlist-card') || el.closest('.local-card'))
    ) {
      return false;
    }

    return true;
  });
}

function scrollIntoViewTv(el: HTMLElement) {
  let node: HTMLElement | null = el.parentElement;
  const isCard =
    el.classList.contains('media-card') ||
    el.classList.contains('movie-card') ||
    el.classList.contains('series-card') ||
    el.classList.contains('nuvio-card') ||
    el.classList.contains('stremio-card') ||
    el.classList.contains('playlist-card') ||
    el.classList.contains('local-card__poster-wrap');
  const edgePaddingY = isCard ? 24 : 12;
  const edgePaddingX = isCard ? 32 : 16;

  while (node && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    const canScrollY =
      (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight + 4;
    const canScrollX =
      (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
      node.scrollWidth > node.clientWidth + 4;

    if (canScrollY || canScrollX) {
      const prevBehavior = node.style.scrollBehavior;
      node.style.scrollBehavior = 'auto';
      try {
        const scrollerRect = node.getBoundingClientRect();
        const elemRect = el.getBoundingClientRect();

        if (canScrollY) {
          if (elemRect.bottom > scrollerRect.bottom - edgePaddingY) {
            node.scrollTop += elemRect.bottom - scrollerRect.bottom + edgePaddingY;
          } else if (elemRect.top < scrollerRect.top + edgePaddingY) {
            node.scrollTop -= scrollerRect.top - elemRect.top + edgePaddingY;
          }
        }

        if (canScrollX) {
          if (elemRect.right > scrollerRect.right - edgePaddingX) {
            node.scrollLeft += elemRect.right - scrollerRect.right + edgePaddingX;
          } else if (elemRect.left < scrollerRect.left + edgePaddingX) {
            node.scrollLeft -= scrollerRect.left - elemRect.left + edgePaddingX;
          }
        }
      } finally {
        node.style.scrollBehavior = prevBehavior;
      }
    }
    node = node.parentElement;
  }
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
  // Capture the on-screen position BEFORE the scroll-into-view below so a
  // later unmount (virtualization) still knows where the user was looking.
  lastFocusedRect = el.getBoundingClientRect();
  lastFocusedView = viewKeyFor(el);
  lastFocusedKind = el.classList.contains('media-card')
    ? 'media-card'
    : el.classList.contains('guide-channel-info')
      ? 'channel'
      : el.classList.contains('program-block') || el.classList.contains('epg-program-block')
        ? 'program'
        : 'generic';
  el.classList.add('tv-focused');

  // Ensure element has tabindex so it can receive DOM focus
  if (!el.hasAttribute('tabindex') && el.tagName !== 'BUTTON' && el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'A') {
    el.setAttribute('tabindex', '0');
  }

  // Don't let the native focus scroll fight the positioning below.
  el.focus({ preventScroll: true });

  // Scroll all scrollable parent containers (both horizontal rails and vertical views)
  // so the newly focused item is comfortably inside the viewport.
  scrollIntoViewTv(el);

  // Remember this item as the view's focus position (per-view focus memory),
  // so returning to the view restores the browsing position.
  if (lastFocusedView) {
    const key = itemKeyFor(el);
    if (key) {
      const scroller = findScrollerFor(el);
      focusMemory.set(lastFocusedView, { key, scrollTop: scroller ? scroller.scrollTop : 0 });
    }
  }
}

// ---------------------------------------------------------------------------
// Per-view focus memory & edge feedback
// ---------------------------------------------------------------------------

const VIEW_CONTAINERS: Array<[string, string]> = [
  ['.channel-panel, .guide-panel, .epg-container', 'guide'],
  ['.movies-grid, .vod-grid, .vod-page, .vod-browse', 'movies'],
  ['.series-grid', 'series'],
  ['.nuvio-page, .nuvio-main', 'nuvio'],
  ['.stremio-page, .stremio-home, .stremio-main', 'stremio'],
  ['.sports-hub', 'sports'],
  ['.dvr-dashboard', 'dvr'],
  ['.tvcp-page, .tv-calendar-page, .calendar-view', 'calendar'],
  ['.settings-body, .settings-tab-content', 'settings'],
];

const SCROLLER_SELECTOR =
  '.nuvio-main, .stremio-main, .stremio-home, .nuvio-scroll-rail, .stremio-scroll-rail, .vod-page__home, .vod-browse__grid-scroll, .local-grid-scroll, .guide-channels, [data-virtuoso-scroller], .vod-grid-scroller, [data-testid="virtuoso-scroller"], .channel-panel, .epg-content, .channels-grid, .movies-grid, .series-grid, .vod-browse__grid, .local-grid, .sports-hub, .settings-tab-content, .dvr-dashboard';

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
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    if (
      node.classList.contains('nuvio-main') ||
      node.classList.contains('stremio-main') ||
      node.classList.contains('stremio-home') ||
      node.classList.contains('nuvio-scroll-rail') ||
      node.classList.contains('stremio-scroll-rail') ||
      node.classList.contains('vod-page__home') ||
      node.classList.contains('vod-browse__grid-scroll') ||
      node.classList.contains('local-grid-scroll') ||
      node.classList.contains('guide-channels') ||
      node.hasAttribute('data-virtuoso-scroller') ||
      node.classList.contains('vod-grid-scroller') ||
      node.classList.contains('vod-browse__grid') ||
      node.classList.contains('local-grid') ||
      node.classList.contains('channel-panel') ||
      node.classList.contains('epg-content') ||
      node.classList.contains('channels-grid') ||
      node.classList.contains('movies-grid') ||
      node.classList.contains('series-grid') ||
      node.classList.contains('sports-hub') ||
      node.classList.contains('settings-tab-content') ||
      node.classList.contains('dvr-dashboard')
    ) {
      return node;
    }
    const style = window.getComputedStyle(node);
    if (
      (style.overflowY === 'scroll' || style.overflowY === 'auto' || style.overflow === 'scroll' || style.overflow === 'auto') &&
      node.scrollHeight > node.clientHeight + 4
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return el.closest<HTMLElement>(SCROLLER_SELECTOR);
}

/**
 * Poll for a virtualized target element after the virtualizer has been asked
 * to scroll/mount it. Scopes the query to the caller-provided root (the grid
 * or list scroller) so an identical data-index in a different mounted list
 * can never match; falls back to document when no root is known. The root is
 * found once from the currently focused element, so there is no cross-call
 * scroller object-identity dependency. pendingVirtualFocus stays true for the
 * entire polling window so the scoring loop and lost-focus recovery cannot
 * steal focus to chrome or the sidebar.
 */
function focusVirtualTargetByPolling(selector: string, root?: HTMLElement | null, maxFrames = 20): void {
  cancelPendingVirtualFocus?.();

  pendingVirtualFocus = true;

  let frames = 0;
  let rafId: number | undefined;

  const cleanup = () => {
    if (rafId !== undefined) cancelAnimationFrame(rafId);
    if (cancelPendingVirtualFocus === cleanup) cancelPendingVirtualFocus = null;
    pendingVirtualFocus = false;
  };

  const tryFocus = () => {
    frames++;
    const target = (root ?? document).querySelector<HTMLElement>(selector);
    if (target && isElementVisible(target)) {
      cleanup();
      applyTvFocus(target);
      return;
    }
    if (frames < maxFrames) {
      rafId = requestAnimationFrame(tryFocus);
    } else {
      // The virtualizer did not mount the target in time. Release the lock so
      // the user is not permanently stuck, but do NOT focus chrome elements.
      cleanup();
    }
  };

  cancelPendingVirtualFocus = cleanup;
  // Start on the next animation frame so the virtualizer's scrollToIndex has
  // a chance to schedule its DOM work before we begin polling.
  rafId = requestAnimationFrame(tryFocus);
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
  const directScroller = container.matches(SCROLLER_SELECTOR)
    ? container
    : container.querySelector<HTMLElement>(SCROLLER_SELECTOR);
  return directScroller || container;
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

    // 2. Prioritize EPG channels / poster cards over category sidebar & toolbar
    const preferred =
      candidates.find(c => c.classList.contains('guide-channel-info')) ||
      candidates.find(
        c => c.classList.contains('media-card') || c.classList.contains('movie-card') || c.classList.contains('series-card')
      ) ||
      candidates.find(c => c.classList.contains('vertical-sidebar__item')) ||
      candidates.find(c => c.classList.contains('sports-card') || c.classList.contains('calendar-card')) ||
      candidates.find(c => c.classList.contains('settings-tab-btn')) ||
      candidates.find(c => c.classList.contains('category-item')) ||
      candidates.find((c) => !isChromeEl(c) && !c.closest('.vod-browse__toolbar')) ||
      candidates[0];

    applyTvFocus(preferred);
    return true;
  }
  return false;
}

/** Rails, toolbars, and app chrome that a deep-scroll resume must never land on. */
function isRailOrChrome(el: HTMLElement): boolean {
  return Boolean(
    el.closest(
      '.vertical-sidebar, .category-strip, .alphabet-rail, .title-bar, .now-playing-bar, .vod-browse__toolbar'
    )
  );
}

/**
 * Scroll the currently active view's scroller one row in the given direction.
 * Used when the focused item was virtualized out of the DOM: instead of
 * jumping to the nearest mounted chrome element, keep the list moving so a
 * later retry can land on real content.
 */
function scrollActiveViewInDirection(dir: SpatialDir): boolean {
  if (dir !== 'up' && dir !== 'down') return false;
  const scroller = findActiveViewScroller();
  if (!scroller) return false;

  const canScroll =
    dir === 'down'
      ? scroller.scrollTop < scroller.scrollHeight - scroller.clientHeight - 10
      : scroller.scrollTop > 10;
  if (!canScroll) return false;

  scroller.style.scrollBehavior = 'auto';
  scroller.scrollTop += dir === 'down' ? 180 : -180;
  return true;
}

/**
 * Re-focus near where the user last was, preferring candidates in the
 * direction the user just pressed. This is the lost-focus recovery path: the
 * focused item was virtualized out of the DOM (react-virtuoso recycled its
 * row), so we must land on the same kind of content — never the category
 * sidebar, search bar, or other chrome — and keep scrolling when that content
 * is not mounted yet.
 */
function resumeInDirection(dir: SpatialDir): boolean {
  const candidates = getFocusCandidates();
  if (candidates.length === 0) return scrollActiveViewInDirection(dir);

  const content = candidates.filter((c) => !isRailOrChrome(c));
  const sameView = lastFocusedView === detectActiveView();

  // Resume to the same kind of content the user was browsing (poster grid →
  // poster, channel list → channel, EPG → program), so an unmount mid-scroll
  // can never drift onto the alphabet rail, toolbar, or search. Only apply
  // the kind restriction when the memory is from the currently active view.
  let pool = content;
  if (sameView) {
    if (lastFocusedKind === 'media-card') {
      const cards = content.filter((c) => c.classList.contains('media-card'));
      if (cards.length > 0) pool = cards;
    } else if (lastFocusedKind === 'channel') {
      const channels = content.filter((c) => c.classList.contains('guide-channel-info'));
      if (channels.length > 0) pool = channels;
    } else if (lastFocusedKind === 'program') {
      const programs = content.filter(
        (c) => c.classList.contains('program-block') || c.classList.contains('epg-program-block')
      );
      if (programs.length > 0) pool = programs;
    }
  }

  if (pool.length === 0) {
    // The user was browsing a specific list, but none of it is mounted right
    // now. Keep scrolling instead of stealing focus to chrome.
    return scrollActiveViewInDirection(dir);
  }

  // Prefer the last known focus spot; fall back to the viewport center when
  // the memory is stale or from another view.
  const origin =
    lastFocusedRect && lastFocusedRect.width > 0 && sameView
      ? {
          x: lastFocusedRect.left + lastFocusedRect.width / 2,
          y: lastFocusedRect.top + lastFocusedRect.height / 2,
        }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  const inDir = pool.filter((c) => {
    const r = c.getBoundingClientRect();
    const dx = r.left + r.width / 2 - origin.x;
    const dy = r.top + r.height / 2 - origin.y;
    switch (dir) {
      case 'down':
        return dy > 4;
      case 'up':
        return dy < -4;
      case 'right':
        return dx > 4;
      case 'left':
        return dx < -4;
      default:
        return false;
    }
  });

  // Prefer candidates in the pressed direction; if none, fall back to the
  // nearest content so focus stays in the view rather than on chrome.
  const selection = inDir.length > 0 ? inDir : pool;

  const vertical = dir === 'down' || dir === 'up';
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const cand of selection) {
    const r = cand.getBoundingClientRect();
    const dx = r.left + r.width / 2 - origin.x;
    const dy = r.top + r.height / 2 - origin.y;
    const primary = vertical ? Math.abs(dy) : Math.abs(dx);
    const secondary = vertical ? Math.abs(dx) : Math.abs(dy);
    const score = primary + secondary * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = cand;
    }
  }

  if (best) {
    applyTvFocus(best);
    return true;
  }
  return scrollActiveViewInDirection(dir);
}

/** App chrome (title bar, now-playing bar) is never a spatial-nav target. */
function isChromeEl(el: HTMLElement): boolean {
  return Boolean(el.closest('.title-bar, .now-playing-bar'));
}

export function moveSpatialFocus(dir: SpatialDir): boolean {
  // While Virtuoso is mounting the requested row, the old focused DOM node
  // can be recycled. Do not run lost-focus restoration against that stale
  // node: it rewinds the scroller back to the old row, causing the down/up
  // bounce seen at the virtualized boundary.
  if (pendingVirtualFocus) return true;
  const current = (document.activeElement as HTMLElement | null) || lastFocusedElement;
  const candidates = getFocusCandidates();

  if (!candidates.length) return false;

  // Check if current focused element is still visible within the viewport & its scroll container
  let isCurrentVisible = false;
  if (current && current !== document.body && candidates.includes(current)) {
    const cr = current.getBoundingClientRect();
    if (
      cr.width > 0 &&
      cr.height > 0 &&
      cr.bottom > 0 &&
      cr.top < window.innerHeight &&
      cr.right > 0 &&
      cr.left < window.innerWidth
    ) {
      const scroller = findScrollerFor(current);
      if (scroller) {
        const sr = scroller.getBoundingClientRect();
        if (cr.bottom > sr.top + 8 && cr.top < sr.bottom - 8) {
          isCurrentVisible = true;
        }
      } else {
        isCurrentVisible = true;
      }
    }
  }

  // If nothing is focused, or the focused element was scrolled out of the visible screen/viewport
  // (e.g. after scrolling with the right thumbstick or mouse wheel):
  // Land immediately on the visible content items in the current viewable section!
  if (!current || !isCurrentVisible) {
    const visibleContent = candidates.filter((c) => {
      if (isRailOrChrome(c)) return false;
      const r = c.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) return false;
      const scroller = findScrollerFor(c);
      if (scroller) {
        const sr = scroller.getBoundingClientRect();
        if (r.bottom <= sr.top + 8 || r.top >= sr.bottom - 8) return false;
      }
      return true;
    });

    if (visibleContent.length > 0) {
      visibleContent.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      // When pressing Down or Right, start at the topmost visible item on screen
      // When pressing Up or Left, start at the bottommost visible item on screen
      const target =
        dir === 'down' || dir === 'right'
          ? visibleContent[0]
          : visibleContent[visibleContent.length - 1];

      if (target) {
        applyTvFocus(target);
        return true;
      }
    }

    const anyVisible = candidates.filter((c) => {
      const r = c.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.top < window.innerHeight &&
        r.right > 0 &&
        r.left < window.innerWidth
      );
    });

    if (anyVisible.length > 0) {
      anyVisible.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const target =
        dir === 'down' || dir === 'right' ? anyVisible[0] : anyVisible[anyVisible.length - 1];
      if (target) {
        applyTvFocus(target);
        return true;
      }
    }

    if (resumeInDirection(dir)) return true;
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
  const isDetailContext = Boolean(current.closest('.movie-detail, .series-detail, .stremio-detail'));
  const isVodSidebarItem = Boolean(current.closest('.vertical-sidebar'));
  const isAlphabetLetter = Boolean(current.closest('.alphabet-rail'));
  const isMediaCard = current.classList.contains('media-card') || Boolean(current.closest('.media-card'));

  // A VOD grid has a stable Virtuoso index for each poster. Prefer that exact
  // next-row target over geometric scoring: at the bottom of the rendered
  // range, the score can only see chrome while the next grid row is mounting.
  if (isMediaCard && (dir === 'down' || dir === 'up')) {
    // Always read data-index from the .media-card element itself, not from a
    // focused child element inside the card (which would return -1).
    const cardEl = current.classList.contains('media-card')
      ? current
      : current.closest<HTMLElement>('.media-card');
    const currentIndex = cardEl ? parseInt(cardEl.getAttribute('data-index') || '-1', 10) : -1;
    if (currentIndex >= 0) {
      // Collect only cards that are in the same visual row as the focused card.
      // Use the cardEl rect (not curRect) in case current is a child element.
      const cardRect = cardEl!.getBoundingClientRect();
      // Scope card lookups to this grid's scroll container so an identical
      // data-index in a different mounted grid can never match. The root is
      // found once from the focused card — no cross-call identity compares.
      const gridRoot = findScrollerFor(cardEl!);
      const allCards = Array.from(
        (gridRoot ?? document).querySelectorAll<HTMLElement>('.media-card')
      );
      const currentRow = allCards.filter(
        (card) => Math.abs(card.getBoundingClientRect().top - cardRect.top) < 10
      );
      const columns = Math.max(currentRow.length, 1);
      const targetIndex = currentIndex + (dir === 'down' ? columns : -columns);
      // Look for the target by data-index among this grid's mounted cards.
      const target = allCards.find(
        (card) => card.getAttribute('data-index') === String(targetIndex)
      );
      if (target) {
        applyTvFocus(target);
        return true;
      }
      if (targetIndex >= 0) {
        window.dispatchEvent(
          new CustomEvent('ynotv:spatial-scroll-to-index', { detail: { surface: 'vod-grid', index: targetIndex } })
        );
        // Poll with rAF until the grid's virtualizer mounts the target row.
        focusVirtualTargetByPolling(`.media-card[data-index="${targetIndex}"]`, gridRoot);
        return true;
      }
    }
  }

  // Channel rows are likewise indexed by their Virtuoso list position. This
  // makes each Up/Down move deterministic and keeps focus in the channel
  // column even while the list recycles rows.
  if (isChannelInfo && (dir === 'down' || dir === 'up')) {
    const currentIndex = parseInt(current.getAttribute('data-index') || '-1', 10);
    if (currentIndex >= 0) {
      const targetIndex = currentIndex + (dir === 'down' ? 1 : -1);
      // Search channel rows scoped to this list's scroller — no object-identity
      // compare (findScrollerFor(row) === scroller can fail through different
      // code paths), and no cross-list collision with a differently-mounted
      // channel list sharing the same data-index.
      const channelRoot = findScrollerFor(current);
      const target = Array.from(
        (channelRoot ?? document).querySelectorAll<HTMLElement>('.guide-channel-info')
      ).find((row) => row.getAttribute('data-index') === String(targetIndex));
      if (target) {
        applyTvFocus(target);
        return true;
      }
      if (targetIndex >= 0) {
        window.dispatchEvent(
          new CustomEvent('ynotv:spatial-scroll-to-index', { detail: { surface: 'channel-list', index: targetIndex } })
        );
        // Poll with rAF until Virtuoso mounts the target row.
        focusVirtualTargetByPolling(`.guide-channel-info[data-index="${targetIndex}"]`, channelRoot);
        return true;
      }
    }
  }

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

    // Vertical navigation from the Live TV channel column must stay in that
    // column.  At a Virtuoso render boundary there is temporarily no next
    // channel in the DOM; allowing the generic scorer to run in that state is
    // what lets a category item or the Search input take focus instead.
    // The channel-list edge handler below scrolls and focuses the next row.
    if ((dir === 'down' || dir === 'up') && isChannelInfo && !cand.classList.contains('guide-channel-info')) {
      continue;
    }

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

    // 5. Detail pages (movie/series/Stremio): keep left/right moves within the
    // same row — the primary action cluster (back, play, favorite) walks
    // horizontally before descending into the content sections. Generic across
    // the whole detail container so rows without dedicated classes (series
    // action row, cast links, episode lists) behave the same way.
    if ((dir === 'left' || dir === 'right') && isDetailContext && cand.closest('.movie-detail, .series-detail, .stremio-detail')) {
      if (Math.abs(dy) < 30) {
        score -= 300;
      }
    }

    // 6. Moving right from the VOD sidebar always enters the content — never
    // the toolbar or search (when the grid is scrolled deep, those have a
    // smaller weighted distance than the below-the-fold cards and would win).
    // The card whose row contains the current item wins outright; otherwise
    // the nearest card wins and the grid scrolls to it. Local poster wraps are
    // cards too (LocalTab renders .local-card, not .media-card), and playlist
    // cards (overview) — plus everything inside an open .playlists-view
    // (detail rows, toolbar) — are valid targets so Left→Right returns into
    // the playlists.
    if (dir === 'right' && isVodSidebarItem) {
      const playlistsViewEl = document.querySelector<HTMLElement>('.playlists-view');
      const playlistsViewOpen = !!playlistsViewEl && isElementVisible(playlistsViewEl);
      if (
        !cand.classList.contains('media-card') &&
        !cand.classList.contains('local-card__poster-wrap') &&
        !cand.classList.contains('playlist-card') &&
        !(playlistsViewOpen && cand.closest('.playlists-view'))
      ) {
        continue;
      }
      if (rect.top <= curCenter.y && rect.bottom >= curCenter.y) {
        score -= 800;
      } else if (Math.abs(dy) < 260) {
        score -= 300;
      }
    }

    // 7. Moving left from the alphabet rail returns to the posters — never the
    // toolbar or the sidebar, which can win the weighted score when the grid
    // is scrolled deep.
    if (dir === 'left' && isAlphabetLetter) {
      if (!cand.classList.contains('media-card')) continue;
      // Score based on vertical proximity to the letter level, preferring the rightmost card in that row
      score = Math.abs(dy) * 3 + (-dx);
      if (Math.abs(dy) < 180) {
        score -= 500;
      }
    }

    // 8. Moving right from a media-card: strongly prioritize other media-cards in the same row
    // so user only crosses into the Alphabet Rail at the rightmost edge of the row
    if (dir === 'right' && isMediaCard) {
      if (cand.classList.contains('media-card') && Math.abs(dy) < 60) {
        score -= 400;
      }
    }

    // 9. Moving up/down inside a poster grid (VOD/local/carousel media cards)
    // stays in the same column so rows walk vertically instead of drifting to
    // the sidebar or a neighboring column.
    if ((dir === 'up' || dir === 'down') && isMediaCard && cand.classList.contains('media-card')) {
      if (Math.abs(dx) < 120) {
        score -= 150;
      }
    }

    // 10. Moving Down from VOD toolbar (sort select, sort dir, slider) enters the topmost visible posters
    if (dir === 'down' && Boolean(current.closest('.vod-browse__toolbar'))) {
      if (cand.classList.contains('media-card')) {
        score -= 600;
      }
    }

    // 11. Moving Up from posters enters the toolbar ONLY when at the top of the scroller (row 1)
    if (dir === 'up' && isMediaCard && Boolean(cand.closest('.vod-browse__toolbar'))) {
      const scroller = findScrollerFor(current);
      if (scroller && scroller.scrollTop > 100) {
        // Grid is scrolled deep — NEVER jump to the toolbar!
        continue;
      }
    }

    // 12. Moving Down from posters: NEVER jump to the toolbar
    if (dir === 'down' && isMediaCard && Boolean(cand.closest('.vod-browse__toolbar'))) {
      continue;
    }

    // 13. Up/down never enters the sidebar/category strip/alphabet rail from posters
    if (
      (dir === 'up' || dir === 'down') &&
      !current.closest('.vertical-sidebar, .category-strip') &&
      cand.closest('.vertical-sidebar, .category-strip, .alphabet-rail')
    ) {
      continue;
    }

    // 14. From inside a poster grid, up/down only moves to other posters (or
    // the toolbar at the very top of the page when on row 1) — never to unrelated app chrome
    if ((dir === 'up' || dir === 'down') && isMediaCard) {
      const isGridTarget =
        cand.classList.contains('media-card') || (dir === 'up' && Boolean(cand.closest('.vod-browse__toolbar')));
      if (!isGridTarget) continue;
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

  // If no mounted target was found in that direction, attempt scrolling the active view
  if (scrollActiveViewInDirection(dir)) {
    return true;
  }

  // No valid target in that direction — shake the focused element so remote
  // users get tactile feedback at list edges.
  flashNoTarget();
  return false;
}

export function dispatchSpatialNav(action: SpatialDir | 'select' | 'back'): boolean {
  // Any remote/controller press — directional moves, select, or back — is user
  // activity: emit the same signal a mouse move sends, so the auto-hiding
  // titlebar and hero overlay appear and the auto-hide timer resets.
  window.dispatchEvent(new CustomEvent('ynotv:spatial-activity'));

  if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
    return moveSpatialFocus(action);
  }

  if (action === 'select') {
    const active = (document.activeElement as HTMLElement | null) || lastFocusedElement;
    if (active && active !== document.body) {
      let actionable: HTMLElement = active;

      // 1. If active is a sortable wrapper div, resolve to the inner button.
      // Playlist and Local cards are excluded: they're DIVs containing buttons
      // (Local's Refresh-metadata/Fix-match buttons sit INSIDE the poster
      // wrap), but the card itself is the nav target — pressing OK opens the
      // playlist / detail page, and the inner buttons are mouse-only.
      if (
        active.classList.contains('sortable-sidebar-item') ||
        (active.tagName === 'DIV' &&
          !active.classList.contains('playlist-card') &&
          !active.classList.contains('local-card__poster-wrap') &&
          active.querySelector('button.category-item, button.category-folder-header, button'))
      ) {
        const innerBtn = active.querySelector<HTMLElement>(
          'button.category-item, button.category-folder-header, button:not(.favorite-btn):not(.fav-btn):not([aria-label*="favorite" i]), a, input'
        );
        if (innerBtn) {
          actionable = innerBtn;
        }
      }
      // 2. Direct interactive elements (buttons, inputs, links, and direct row containers)
      else if (
        active.tagName === 'BUTTON' ||
        active.tagName === 'INPUT' ||
        active.tagName === 'A' ||
        active.classList.contains('guide-channel-info') ||
        active.classList.contains('guide-channel-row') ||
        active.classList.contains('channel-item') ||
        active.classList.contains('movie-card') ||
        active.classList.contains('series-card') ||
        active.classList.contains('sports-card') ||
        active.classList.contains('program-block') ||
        active.classList.contains('playlist-card') ||
        active.classList.contains('local-card__poster-wrap')
      ) {
        actionable = active;
      } else {
        // Fallback for wrapper containers: find primary actionable child (strictly excluding favorite buttons)
        const innerBtn = active.querySelector<HTMLElement>(
          'button:not(.favorite-btn):not(.fav-btn):not([aria-label*="favorite" i]), a, input, [role="button"]:not(.favorite-btn)'
        );
        if (innerBtn) {
          actionable = innerBtn;
        }
      }

      actionable.click();

      // If user selected a category item in the sidebar, transfer spatial focus into the channels list
      const isCategorySelection =
        active.classList.contains('category-item') ||
        actionable.classList.contains('category-item') ||
        active.classList.contains('sortable-sidebar-item') ||
        Boolean(active.closest('.category-strip-scrollable, .category-strip-top'));

      const isFolderOrSourceHeader =
        active.classList.contains('category-source-header') ||
        active.classList.contains('category-folder-header') ||
        actionable.classList.contains('category-source-header') ||
        actionable.classList.contains('category-folder-header');

      if (isCategorySelection && !isFolderOrSourceHeader) {
        setTimeout(() => {
          const firstChan = document.querySelector<HTMLElement>('.guide-channel-info, .channel-item, .channel-card');
          if (firstChan && isElementVisible(firstChan)) {
            applyTvFocus(firstChan);
          }
        }, 150);
      }

      // If user selected an alphabet letter on the rail, transfer spatial focus to the first poster card
      const isAlphabetSelection = Boolean(active.closest('.alphabet-rail'));
      if (isAlphabetSelection) {
        setTimeout(() => {
          const firstCard = document.querySelector<HTMLElement>('.vod-browse__grid .media-card, .local-grid .media-card, .media-card, .local-card__poster-wrap');
          if (firstCard && isElementVisible(firstCard)) {
            applyTvFocus(firstCard);
          }
        }, 120);
      }

      // If this selection opened a modal/detail overlay (movie/series/Stremio
      // detail page), move spatial focus inside it right away. This also clears
      // the .tv-focused highlight left on the card behind the overlay, and
      // keeps d-pad movement from mixing overlay buttons with background cards.
      const retryModalFocus = (attempts = 4) => {
        const modal = getActiveModal();
        if (modal) {
          const first = Array.from(modal.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)).find(isElementVisible);
          if (first) {
            applyTvFocus(first);
            return;
          }
        }
        if (attempts > 0) {
          setTimeout(() => retryModalFocus(attempts - 1), 60);
        }
      };
      setTimeout(() => retryModalFocus(4), 60);

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
        '.modal-close, .modal-close-btn, [data-action="close"], .dialog-close, .movie-detail__back, .series-detail__back'
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
