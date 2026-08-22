import { useEffect, useLayoutEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef, type ReactNode, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface VirtualGridHandle {
  scrollToIndex: (options: { index: number; align?: 'start' | 'center' | 'end' | 'auto' }) => void;
  getColumns: () => number;
}

export interface VirtualGridProps<T> {
  items: T[];
  scrollRef?: RefObject<HTMLElement | null>;
  estimateRowHeight?: number;
  minColumnWidth?: number;
  gapX?: number;
  gapY?: number;
  overscan?: number;
  renderItem: (item: T, index: number) => ReactNode;
  getKey?: (item: T, index: number) => string | number;
  className?: string;
  style?: React.CSSProperties;
  onRangeChange?: (range: { startIndex: number; endIndex: number }) => void;
  /** Name this grid listens to on the ynotv:spatial-scroll-to-index window
   *  event (default 'vod-grid'). Spatial navigation dispatches with this
   *  surface when it needs the virtualizer to mount a data index beyond the
   *  rendered window, so each virtualized grid scrolls its own scroller. */
  surface?: string;
}  function VirtualGridComponent<T>(
  {
    items,
    scrollRef,
    estimateRowHeight = 280,
    minColumnWidth = 150,
    gapX = 12,
    gapY = 16,
    overscan = 4,
    renderItem,
    getKey,
    className = '',
    style,
    onRangeChange,
    surface,
  }: VirtualGridProps<T>,
  ref: React.ForwardedRef<VirtualGridHandle>
) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Initialize with a realistic column count based on viewport rather than 1
  const [cols, setCols] = useState(() => {
    if (typeof window !== 'undefined' && minColumnWidth > 0) {
      const approx = Math.max(300, window.innerWidth - 300);
      return Math.max(1, Math.floor((approx + gapX) / (minColumnWidth + gapX)));
    }
    return 1;
  });

  const measureCols = useCallback(() => {
    const el = containerRef.current || (scrollRef?.current as HTMLElement | null);
    if (!el) return;
    const w = el.clientWidth || el.getBoundingClientRect().width;
    if (w <= 0) return;
    const next = Math.max(1, Math.floor((w + gapX) / (minColumnWidth + gapX)));
    setCols((prev) => (prev !== next ? next : prev));
  }, [gapX, minColumnWidth, scrollRef]);

  // Measure on layout and observe element/scroll container resizes
  useLayoutEffect(() => {
    measureCols();
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      measureCols();
    });
    ro.observe(el);
    if (scrollRef?.current && scrollRef.current !== el) {
      ro.observe(scrollRef.current);
    }
    return () => ro.disconnect();
  }, [measureCols, scrollRef]);

  // Re-measure when items transition from empty to populated
  useEffect(() => {
    measureCols();
  }, [items.length, measureCols]);

  const rowCount = Math.max(0, Math.ceil(items.length / cols));

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => {
      if (scrollRef?.current) return scrollRef.current;
      const el = containerRef.current;
      if (!el) return null;
      let parent: HTMLElement | null = el.parentElement;
      while (parent && parent !== document.body) {
        const overflow = window.getComputedStyle(parent).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') return parent;
        parent = parent.parentElement;
      }
      return el.parentElement;
    },
    estimateSize: () => estimateRowHeight + gapY,
    measureElement: (element) => element.getBoundingClientRect().height + gapY,
    overscan,
  });

  // Expose imperative handle (scrollToIndex by item index)
  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: ({ index, align = 'center' }) => {
        if (cols <= 0) return;
        const rowIndex = Math.floor(index / cols);
        rowVirtualizer.scrollToIndex(rowIndex, { align });
      },
      getColumns: () => cols,
    }),
    [cols, rowVirtualizer]
  );

  // Remote/gamepad spatial navigation: when the spatial engine asks this grid
  // to mount a specific data index (surface event), scroll it into the render
  // window. Centralized here so consumers no longer need their own listeners.
  const surfaceName = surface ?? 'vod-grid';
  useEffect(() => {
    const handleSpatialIndexRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ surface?: string; index?: number }>).detail;
      if (detail?.surface !== surfaceName || !Number.isInteger(detail.index) || detail.index! < 0) return;
      if (cols <= 0) return;
      const rowIndex = Math.floor(detail.index! / cols);
      rowVirtualizer.scrollToIndex(rowIndex, { align: 'center' });
    };

    window.addEventListener('ynotv:spatial-scroll-to-index', handleSpatialIndexRequest);
    return () => window.removeEventListener('ynotv:spatial-scroll-to-index', handleSpatialIndexRequest);
  }, [surfaceName, cols, rowVirtualizer]);

  // Notify range changes when virtual items update
  const virtualRows = rowVirtualizer.getVirtualItems();
  useEffect(() => {
    if (!onRangeChange || virtualRows.length === 0) return;
    const firstRow = virtualRows[0];
    const lastRow = virtualRows[virtualRows.length - 1];
    const startIndex = firstRow ? firstRow.index * cols : 0;
    const endIndex = lastRow ? Math.min(items.length - 1, (lastRow.index + 1) * cols - 1) : 0;
    onRangeChange({ startIndex, endIndex });
  }, [virtualRows, cols, items.length, onRangeChange]);

  return (
    <div ref={containerRef} className={`virtual-grid ${className}`} style={{ width: '100%', minHeight: '100%', ...style }}>
      {items.length > 0 && (
        <div
          className="virtual-grid__inner relative w-full"
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            position: 'relative',
            width: '100%',
          }}
        >
          {virtualRows.map((row) => {
            const start = row.index * cols;
            const slice = items.slice(start, start + cols);
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={rowVirtualizer.measureElement}
                className="virtual-grid__row absolute start-0 grid w-full"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${row.start}px)`,
                  willChange: 'transform',
                  contain: 'layout paint',
                  display: 'grid',
                  gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                  columnGap: `${gapX}px`,
                  rowGap: `${gapY}px`,
                }}
              >
                {slice.map((item, i) => {
                  const itemIndex = start + i;
                  const key = getKey ? getKey(item, itemIndex) : itemIndex;
                  return (
                    <div key={key} className="virtual-grid__cell" style={{ minWidth: 0 }}>
                      {renderItem(item, itemIndex)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const VirtualGrid = forwardRef(VirtualGridComponent) as <T>(
  props: VirtualGridProps<T> & { ref?: React.ForwardedRef<VirtualGridHandle> }
) => React.ReactElement;
