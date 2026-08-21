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

  el.focus({ preventScroll: false });

  // Intelligent smooth scrolling for lists and virtualized containers
  const scroller = el.closest(
    '[data-virtuoso-scroller], [data-testid="virtuoso-scroller"], .channel-panel, .epg-content, .channels-grid, .movies-grid, .series-grid, .sports-hub, .settings-tab-content, .dvr-dashboard'
  ) as HTMLElement | null;

  if (scroller) {
    const scrollerRect = scroller.getBoundingClientRect();
    const elemRect = el.getBoundingClientRect();

    if (elemRect.bottom > scrollerRect.bottom - 48) {
      scroller.scrollTop += (elemRect.bottom - scrollerRect.bottom + 70);
    } else if (elemRect.top < scrollerRect.top + 48) {
      scroller.scrollTop -= (scrollerRect.top - elemRect.top + 70);
    }
  }

  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

export function focusFirstInteractive(): boolean {
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
