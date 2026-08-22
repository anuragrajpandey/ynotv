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
// Last known position of the focused element (captured before any scroll
// adjustments). Used to resume near the user's spot when the focused item is
// virtualized out of the DOM mid-scroll, instead of snapping to the view start.
let lastFocusedRect: DOMRect | null = null;
let lastFocusedView: string | null = null;
// Kind of content the user was last focused on (media-card, channel, program,
// …). Used so a lost-focus resume lands on the same kind of content instead
// of drifting to unrelated chrome/rails/toolbars.
let lastFocusedKind: string | null = null;

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

  // A parent can hide its whole subtree without the child's own style
  // changing: opacity is not inherited (guide panel fades out), and fixed
  // panels slide fully off-screen with transforms (the LiveTV CategoryStrip
  // slides left with translateX(-100%), the guide panel slides down). Their
  // descendants still report non-zero rects, so a plain per-element check lets
  // spatial focus jump into invisible off-screen containers and "disappear".
  // Walk every ancestor and reject anything hidden or entirely outside the
  // viewport. (Element-level rects are intentionally NOT viewport-clamped —
  // items scrolled below the fold inside a visible scroller must stay
  // reachable so d-pad movement keeps scrolling the list.)
  let node: HTMLElement | null = el;
  while (node && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    if (node !== el) {
      const rect = node.getBoundingClientRect();
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth)
      ) {
        return false;
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

    // react-virtuoso renders its scrollable list as a div with tabIndex=0, so
    // it matches [tabindex="0"] and competes with real content items. Its
    // center sits mid-list, so it wins the scoring whenever no card row aligns
    // with the focused item — pressing right from the VOD sidebar (or left
    // from the alphabet rail) would "highlight the whole list" instead of a
    // poster. A scroll container is a scroll target, never a nav target.
    if (el.hasAttribute('data-virtuoso-scroller')) return false;

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

    return true;
  });
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

    // 2. Prioritize EPG channels over category sidebar; VOD pages land on the
    // sidebar's Home item (first .vertical-sidebar__item in DOM order) so a
    // fresh open starts from the top-left corner instead of an arbitrary card.
    const preferred =
      candidates.find(c => c.classList.contains('guide-channel-info')) ||
      candidates.find(c => c.classList.contains('vertical-sidebar__item')) ||
      candidates.find(
        c => c.classList.contains('media-card') || c.classList.contains('movie-card') || c.classList.contains('series-card')
      ) ||
      candidates.find(c => c.classList.contains('sports-card') || c.classList.contains('calendar-card')) ||
      candidates.find(c => c.classList.contains('settings-tab-btn')) ||
      candidates.find(c => c.classList.contains('category-item')) ||
      candidates.find((c) => !isChromeEl(c)) ||
      candidates[0];

    applyTvFocus(preferred);
    return true;
  }
  return false;
}

/**
 * Refocus the candidate nearest to where the user last had focus in this
 * view. Used when the focused item was virtualized out of the DOM, so a deep
 * scroll keeps its place instead of snapping to the view start (e.g. Home).
 * Sidebar/category-strip items are avoided unless nothing else is available.
 */
function resumeNearLastRect(candidates: HTMLElement[]): boolean {
  // Content excludes sidebars and app chrome (title bar, now-playing bar) — a
  // deep-scroll resume must land on view content, never on those.
  const content = candidates.filter((c) => {
    if (c.closest('.vertical-sidebar, .category-strip')) return false;
    if (c.closest('.title-bar, .now-playing-bar')) return false;
    return true;
  });

  // Resume to the same kind of content the user was browsing (poster grid →
  // poster, channel list → channel, EPG → program), so an unmount mid-scroll
  // can never drift onto the alphabet rail, toolbar, or search. Falls back to
  // the general content pool only when none of that kind is mounted.
  let pool = content;
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
  if (pool.length === 0) pool = candidates;

  // Prefer the last known focus spot; fall back to the viewport center when
  // the memory is stale or from another view, so a mid-scroll resume still
  // lands in content instead of snapping to chrome or the view start.
  const origin =
    lastFocusedRect &&
    lastFocusedRect.width > 0 &&
    lastFocusedView === detectActiveView()
      ? {
          x: lastFocusedRect.left + lastFocusedRect.width / 2,
          y: lastFocusedRect.top + lastFocusedRect.height / 2,
        }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const dist = (cand: HTMLElement) => {
    const r = cand.getBoundingClientRect();
    return Math.abs(r.left + r.width / 2 - origin.x) + Math.abs(r.top + r.height / 2 - origin.y);
  };
  let nearest: HTMLElement | null = null;
  let best = Infinity;
  for (const cand of pool) {
    const d = dist(cand);
    if (d < best) {
      best = d;
      nearest = cand;
    }
  }
  if (nearest) {
    applyTvFocus(nearest);
    return true;
  }
  return false;
}

/** App chrome (title bar, now-playing bar) is never a spatial-nav target. */
function isChromeEl(el: HTMLElement): boolean {
  return Boolean(el.closest('.title-bar, .now-playing-bar'));
}

export function moveSpatialFocus(dir: SpatialDir): boolean {
  const current = (document.activeElement as HTMLElement | null) || lastFocusedElement;
  const candidates = getFocusCandidates();

  if (!candidates.length) return false;

  // If nothing is focused or focus is outside the candidates (e.g. the focused
  // item was virtualized out of the DOM while scrolling the grid), don't snap
  // back to the view start (the VOD Home button) — resume where the user was.
  if (!current || current === document.body || !candidates.includes(current)) {
    // 1. Restore the per-view remembered position when the item is mounted.
    if (tryRestoreFocus()) return true;

    // 2. The remembered item may need a beat to re-mount after the scroller
    // jump (virtualized lists); retry briefly. Only fall back to a positional
    // resume — never to the view start — so focus stays near the user's spot.
    if (hasFocusMemory()) {
      let attempts = 6;
      const retry = () => {
        if (tryRestoreFocus()) return;
        if (--attempts > 0) {
          setTimeout(retry, 60);
        } else {
          resumeNearLastRect(candidates);
        }
      };
      retry();
      return true;
    }

    // 3. No saved memory: resume at the candidate nearest the last focused
    // spot in this view, so deep-scroll navigation keeps its place instead of
    // resetting to the top-left corner.
    if (resumeNearLastRect(candidates)) return true;

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
  const isAlphabetLetter = current.classList.contains('alphabet-rail__letter');
  const isMediaCard = current.classList.contains('media-card');

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

    // 6. Moving right from the VOD sidebar always enters the posters — never
    // the toolbar or search (when the grid is scrolled deep, those have a
    // smaller weighted distance than the below-the-fold cards and would win).
    // The card whose row contains the current item wins outright; otherwise
    // the nearest card wins and the grid scrolls to it.
    if (dir === 'right' && isVodSidebarItem) {
      if (!cand.classList.contains('media-card')) continue;
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
      if (Math.abs(dy) < 160) {
        score -= 400;
      }
    }

    // 8. Moving up/down inside a poster grid (VOD/local/carousel media cards)
    // stays in the same column so rows walk vertically instead of drifting to
    // the sidebar or a neighboring column.
    if ((dir === 'up' || dir === 'down') && isMediaCard && cand.classList.contains('media-card')) {
      if (Math.abs(dx) < 120) {
        score -= 150;
      }
    }

    // 9. Up/down never enters the sidebar/category strip — those lists are
    // taller than the viewport, so their below-the-fold items are valid
    // up/down targets that steal focus at grid edges, stranding the user deep
    // in the sidebar with no posters at that depth. Sidebars are left/right
    // destinations only (unless the user is already navigating inside one).
    if (
      (dir === 'up' || dir === 'down') &&
      !current.closest('.vertical-sidebar, .category-strip') &&
      cand.closest('.vertical-sidebar, .category-strip')
    ) {
      continue;
    }

    // 10. From inside a poster grid, up/down only moves to other posters (or
    // the toolbar at the top of the page) — never to unrelated app chrome
    // like the now-playing bar or overlay buttons that sit behind the view
    // and steal focus at the grid's edges.
    if ((dir === 'up' || dir === 'down') && isMediaCard) {
      const isGridTarget =
        cand.classList.contains('media-card') || Boolean(cand.closest('.vod-browse__toolbar'));
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
      let actionable: HTMLElement = active;

      // 1. If active is a sortable wrapper div, resolve to the inner button
      if (
        active.classList.contains('sortable-sidebar-item') ||
        (active.tagName === 'DIV' && active.querySelector('button.category-item, button.category-folder-header, button'))
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
        active.classList.contains('program-block')
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
