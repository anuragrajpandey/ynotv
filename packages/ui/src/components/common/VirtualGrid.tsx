import { useEffect, useRef, useState, useImperativeHandle, forwardRef, type ReactNode, type RefObject } from 'react';
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
}

function VirtualGridComponent<T>(
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
  }: VirtualGridProps<T>,
  ref: React.ForwardedRef<VirtualGridHandle>
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(1);

  // Measure container width and compute column count
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      const w = el.clientWidth;
      if (w <= 0) return;
      const next = Math.max(1, Math.floor((w + gapX) / (minColumnWidth + gapX)));
      setCols((prev) => (prev !== next ? next : prev));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [gapX, minColumnWidth]);

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

  if (items.length === 0) return null;

  return (
    <div ref={containerRef} className={`virtual-grid ${className}`} style={{ width: '100%', ...style }}>
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
    </div>
  );
}

export const VirtualGrid = forwardRef(VirtualGridComponent) as <T>(
  props: VirtualGridProps<T> & { ref?: React.ForwardedRef<VirtualGridHandle> }
) => React.ReactElement;
