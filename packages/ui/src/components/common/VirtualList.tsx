import { useEffect, useRef, useImperativeHandle, forwardRef, type ReactNode, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface VirtualListHandle {
  scrollToIndex: (options: { index: number; align?: 'start' | 'center' | 'end' | 'auto'; behavior?: 'auto' | 'smooth' }) => void;
  getVirtualItems: () => Array<{ index: number; start: number; size: number }>;
}

export interface VirtualListItemMeasurement {
  index: number;
  start: number;
  size: number;
}

export interface VirtualListProps<T> {
  items: T[];
  scrollRef?: RefObject<HTMLElement | null>;
  estimateItemHeight?: number | ((index: number) => number);
  overscan?: number;
  renderItem: (item: T, index: number) => ReactNode;
  getKey?: (item: T, index: number) => string | number;
  className?: string;
  style?: React.CSSProperties;
  onRangeChange?: (range: { startIndex: number; endIndex: number }) => void;
  /** Live positions/sizes for mounted (including overscanned) rows. */
  onVirtualItemsChange?: (items: VirtualListItemMeasurement[]) => void;
}

function VirtualListComponent<T>(
  {
    items,
    scrollRef,
    estimateItemHeight = 52,
    overscan = 5,
    renderItem,
    getKey,
    className = '',
    style,
    onRangeChange,
    onVirtualItemsChange,
  }: VirtualListProps<T>,
  ref: React.ForwardedRef<VirtualListHandle>
) {
  const containerRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
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
    estimateSize: typeof estimateItemHeight === 'function' ? estimateItemHeight : () => estimateItemHeight,
    overscan,
  });

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: ({ index, align = 'center', behavior = 'auto' }) => {
        rowVirtualizer.scrollToIndex(index, { align, behavior });
      },
      getVirtualItems: () => rowVirtualizer.getVirtualItems(),
    }),
    [rowVirtualizer]
  );

  const virtualItems = rowVirtualizer.getVirtualItems();
  useEffect(() => {
    if (!onRangeChange || virtualItems.length === 0) return;
    const first = virtualItems[0];
    const last = virtualItems[virtualItems.length - 1];
    onRangeChange({
      startIndex: first ? first.index : 0,
      endIndex: last ? last.index : 0,
    });
  }, [virtualItems, onRangeChange]);

  useEffect(() => {
    if (!onVirtualItemsChange) return;
    onVirtualItemsChange(virtualItems.map(({ index, start, size }) => ({ index, start, size })));
  }, [virtualItems, onVirtualItemsChange]);

  if (items.length === 0) return null;

  return (
    <div ref={containerRef} className={`virtual-list ${className}`} style={{ width: '100%', ...style }}>
      <div
        className="virtual-list__inner relative w-full"
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          position: 'relative',
          width: '100%',
        }}
      >
        {virtualItems.map((virtualRow) => {
          const item = items[virtualRow.index];
          if (!item) return null;
          const key = getKey ? getKey(item, virtualRow.index) : virtualRow.key;
          return (
            <div
              key={key}
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              className="virtual-list__row absolute start-0 w-full"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
                willChange: 'transform',
                contain: 'layout paint',
              }}
            >
              {renderItem(item, virtualRow.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const VirtualList = forwardRef(VirtualListComponent) as <T>(
  props: VirtualListProps<T> & { ref?: React.ForwardedRef<VirtualListHandle> }
) => React.ReactElement;
