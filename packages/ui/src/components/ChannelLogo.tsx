import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { classifyLogo, getCachedLogoVerdict } from '../utils/logoLuminance';
import { getLogoContentBox, getCachedLogoContentBox, getCachedLogoDims, LogoContentBox } from '../utils/logoContentBox';
import { getCachedLogoUrl } from '../services/logoCache';
import { useSettingsStore } from '../stores/settingsStore';

interface ChannelLogoProps {
  src?: string | null;
  name?: string;
  className?: string;
  placeholderClass?: string;
  lazy?: boolean;
  /** Manual tile background override from the EPG editor. 'auto' (or undefined) uses luminance detection. */
  background?: 'auto' | 'light' | 'dark';
  /**
   * Per-channel default background (e.g. from a per-source override). Beats
   * the global default setting; 'auto' forces luminance detection even when
   * the global default is Light/Dark. A per-logo `background` prop always wins.
   */
  defaultBackground?: 'auto' | 'light' | 'dark';
  /** Manual logo padding override. 'default' (or undefined) uses normal tile padding, 'none' removes padding. */
  padding?: 'default' | 'none';
  /** Display shape override: 'square' or 'rectangle' */
  shape?: 'square' | 'rectangle';
}

/**
 * Channel logo with automatic luminance-based background and configurable padding.
 *
 * Renders the logo image inside a tile. On load, samples the logo's average
 * luminance once (cached) and adds the `logo-on-light` modifier class when the
 * logo is dark, so it gets a light tile background and stays visible on the
 * dark UI. Falls back to a letter placeholder when no image exists.
 *
 * Pass `background="light"` to always force a light tile (for dark logos the
 * auto-detection gets wrong) or `background="dark"` to always keep the default
 * dark tile. Pass `padding="none"` to remove padding around the image.
 */
export const ChannelLogo = memo(function ChannelLogo({
  src,
  name = '',
  className = 'guide-channel-logo',
  placeholderClass = 'logo-placeholder',
  lazy = true,
  background = 'auto',
  defaultBackground,
  padding = 'default',
  shape,
}: ChannelLogoProps) {
  const logoCacheEnabled = useSettingsStore((s) => s.logoCacheEnabled);
  const logoLightBackgroundDetection = useSettingsStore((s) => s.logoLightBackgroundDetection) ?? true;
  const logoSmartTrim = useSettingsStore((s) => s.logoSmartTrim) ?? false;
  const logoDefaultBackground = useSettingsStore((s) => s.logoDefaultBackground) ?? 'auto';
  // Per-logo background override (prop, set in the EPG editor) wins; then a
  // per-channel default (per-source override); then the global default setting.
  // 'auto' at any level falls back to luminance detection.
  const effectiveBackground: 'auto' | 'light' | 'dark' =
    background === 'light' || background === 'dark'
      ? background
      : defaultBackground !== undefined
        ? defaultBackground
        : logoDefaultBackground;
  // Seed the light tile from cache synchronously so already-classified logos
  // render correctly on first paint instead of flashing dark then flipping
  // light as the async luminance analysis resolves.
  const [autoLight, setAutoLight] = useState<boolean>(() =>
    effectiveBackground === 'auto' && logoLightBackgroundDetection && src
      ? getCachedLogoVerdict(src) === 'dark'
      : false
  );
  const [failed, setFailed] = useState(false);
  const [effectiveSrc, setEffectiveSrc] = useState<string | undefined>(src || undefined);
  const [contentBox, setContentBox] = useState<LogoContentBox | null>(
    () => (logoSmartTrim && src ? (getCachedLogoContentBox(src) ?? null) : null)
  );
  const [trimVars, setTrimVars] = useState<Record<string, string> | null>(null);
  const [loadedTick, setLoadedTick] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastVarsRef = useRef<string>('');

  // Reset state and resolve cached logo URL whenever the logo URL or setting changes
  useEffect(() => {
    setAutoLight(effectiveBackground === 'auto' && logoLightBackgroundDetection && src ? (getCachedLogoVerdict(src) === 'dark') : false);
    setFailed(false);
    // Seed synchronously from cache so already-corrected logos don't flash
    // untrimmed before the async analysis resolves.
    setContentBox(logoSmartTrim && src ? (getCachedLogoContentBox(src) ?? null) : null);

    if (!src) {
      setEffectiveSrc(undefined);
      return;
    }

    let isMounted = true;
    getCachedLogoUrl(src, logoCacheEnabled).then((resolved) => {
      if (isMounted) {
        setEffectiveSrc(resolved);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [src, logoCacheEnabled, logoSmartTrim, background, defaultBackground, logoLightBackgroundDetection, logoDefaultBackground]);

  // When the user resets the logo luminance verdict cache (settings → logos),
  // re-seed from the now-empty cache and re-classify the current logo so the
  // fix is visible immediately without a reload.
  useEffect(() => {
    const handleVerdictReset = () => {
      if (effectiveBackground !== 'auto' || !logoLightBackgroundDetection || !src) return;
      setAutoLight(getCachedLogoVerdict(src) === 'dark');
      const img = imgRef.current;
      if (img) {
        classifyLogo(src, img)
          .then((verdict) => {
            if (verdict === 'dark') setAutoLight(true);
          })
          .catch(() => {});
      }
    };
    window.addEventListener('ynotv:logo-verdict-cache-reset', handleVerdictReset);
    return () => window.removeEventListener('ynotv:logo-verdict-cache-reset', handleVerdictReset);
  }, [src, background, defaultBackground, logoLightBackgroundDetection, logoDefaultBackground]);

  // Resolve the content box and bump a load tick so trim is recomputed from the
  // loaded image. The tick matters because the cached box is a stable object
  // reference — a bare setContentBox(cached) would be a no-op and skip render.
  const analyzeAndReapply = useCallback((img: HTMLImageElement, url: string) => {
    if (!logoSmartTrim || !url) return;
    getLogoContentBox(url, img)
      .then((box) => {
        if (box) setContentBox(box);
        setLoadedTick((t) => t + 1);
      })
      .catch(() => {});
  }, [logoSmartTrim]);

  const handleLoad = useCallback(() => {
    if (!src || !effectiveSrc) return;
    const img = imgRef.current;
    if (effectiveBackground === 'auto' && logoLightBackgroundDetection && img) {
      classifyLogo(src, img)
        .then((verdict) => {
          if (verdict === 'dark') setAutoLight(true);
        })
        .catch(() => {});
    }
    if (img) analyzeAndReapply(img, src);
  }, [src, effectiveSrc, background, defaultBackground, logoLightBackgroundDetection, logoDefaultBackground, analyzeAndReapply]);

  useEffect(() => {
    if (!logoSmartTrim || contentBox !== null || failed) return;
    const img = imgRef.current;
    if (!img || !img.complete || !img.naturalWidth || !src) return;
    analyzeAndReapply(img, src);
  }, [logoSmartTrim, src, contentBox, failed, analyzeAndReapply]);

  // Compute the zoomed size/position so the opaque content fills the tile
  // edge-to-edge without cropping, and keep it in sync with tile resizes.
  // Clears any stale trim when the image isn't ready yet so we never render a
  // wrongly-zoomed logo.
  const applyTrim = useCallback(() => {
    const img = imgRef.current;
    const box = contentBox;
    const container = containerRef.current;
    // Use the decoded image when available, otherwise fall back to cached
    // dimensions so cached logos render trimmed on first paint instead of
    // snapping from untrimmed once the image decodes.
    let nW = 0;
    let nH = 0;
    if (img && img.naturalWidth && img.naturalHeight) {
      nW = img.naturalWidth;
      nH = img.naturalHeight;
    } else {
      const dims = getCachedLogoDims(src);
      if (dims && dims.w && dims.h) {
        nW = dims.w;
        nH = dims.h;
      }
    }
    if (!box || !container || !nW || !nH) {
      lastVarsRef.current = '';
      setTrimVars(null);
      return;
    }
    const cw = (box.r - box.l) * nW;
    const ch = (box.b - box.t) * nH;
    if (!cw || !ch) return;
    const tw = container.clientWidth;
    const th = container.clientHeight;
    if (!tw || !th) return;
    const s = Math.min(tw / cw, th / ch);
    const dw = nW * s;
    const dh = nH * s;
    const x = (tw - cw * s) / 2 - box.l * nW * s;
    const y = (th - ch * s) / 2 - box.t * nH * s;
    const next: Record<string, string> = {
      '--smart-trim-x': `${x}px`,
      '--smart-trim-y': `${y}px`,
      '--smart-trim-w': `${dw}px`,
      '--smart-trim-h': `${dh}px`,
    };
    const key = JSON.stringify(next);
    if (key !== lastVarsRef.current) {
      lastVarsRef.current = key;
      setTrimVars(next);
    }
  }, [contentBox, src]);

  useLayoutEffect(() => {
    if (!logoSmartTrim || !effectiveSrc || !contentBox) {
      lastVarsRef.current = '';
      setTrimVars(null);
      return;
    }
    applyTrim();
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(applyTrim);
    ro.observe(container);
    return () => ro.disconnect();
  }, [logoSmartTrim, effectiveSrc, contentBox, loadedTick, applyTrim]);

  const needsLight = effectiveBackground === 'light' ? true : effectiveBackground === 'dark' ? false : (logoLightBackgroundDetection ? autoLight : false);

  const smartTrimActive = logoSmartTrim && trimVars !== null;

  const containerClass = [
    needsLight ? `${className} logo-on-light` : className,
    padding === 'none' && !smartTrimActive ? 'no-padding' : '',
    shape === 'rectangle' ? 'logo-shape-rectangle' : '',
    shape === 'square' ? 'logo-shape-square' : '',
    smartTrimActive ? 'logo-smart-trim' : '',
  ].filter(Boolean).join(' ');

  const containerStyle = smartTrimActive && trimVars ? (trimVars as CSSProperties) : undefined;

  if (!src || !effectiveSrc || failed) {
    return (
      <div className={containerClass}>
        <span className={placeholderClass}>{(name || '?').charAt(0)}</span>
      </div>
    );
  }

  return (
    <div className={containerClass} ref={containerRef} style={containerStyle}>
      <img
        ref={imgRef}
        key={effectiveSrc}
        src={effectiveSrc}
        alt=""
        loading={lazy ? 'lazy' : undefined}
        decoding="async"
        onLoad={handleLoad}
        onError={() => setFailed(true)}
      />
    </div>
  );
});
