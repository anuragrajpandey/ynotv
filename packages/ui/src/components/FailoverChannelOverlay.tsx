import { useState, useEffect, useRef, useCallback, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { StoredChannel } from '../db';
import { db } from '../db';
import { getFailoverGroupMembers, reorderFailoverGroupChannels } from '../services/failover-groups';
import { useSourceNameMap } from '../hooks/useChannels';
import { useSettingsStore } from '../stores/settingsStore';
import { MetadataBadge } from './MetadataBadge';
import { useTranslation } from 'react-i18next';
import './FailoverChannelOverlay.css';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface FailoverChannelOverlayProps {
  currentChannel: StoredChannel | null;
  onChannelClick: (channel: StoredChannel) => void;
  isCleanDesign?: boolean;
  showSource?: boolean;
  showLabel?: boolean;
  placement?: 'bottom-right' | 'top-right' | 'default';
  onDropdownOpenChange?: (open: boolean) => void;
}

interface MemberChannel {
  stream_id: string;
  priority: number;
  name: string;
  stream_icon?: string;
  source_id?: string;
}

function LinkSvgIcon() {
  return (
    <svg
      className="fco-svg-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function TvSvgIcon() {
  return (
    <svg
      className="fco-tv-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="20" height="15" x="2" y="7" rx="2" ry="2" />
      <polyline points="17 2 12 7 7 2" />
    </svg>
  );
}

// ── Sortable Failover Channel Item with Full-Surface Card Dragging ────────────

function SortableFailoverItem({
  member,
  isActive,
  sourceName,
  isPrimary,
  onSelect,
}: {
  member: MemberChannel;
  isActive: boolean;
  sourceName?: string;
  isPrimary: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('player');
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: member.stream_id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 99 : 1,
    touchAction: 'none',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`fco-sortable-item${isDragging ? ' dragging' : ''}`}
    >
      <button
        className={`fco-item ${isActive ? 'fco-active' : ''}`}
        onClick={onSelect}
        disabled={isActive}
        title={
          isActive
            ? t('currentlyPlaying')
            : t('switchTo', { name: member.name })
        }
      >
        {member.stream_icon ? (
          <img
            src={member.stream_icon}
            alt=""
            className="fco-item-logo"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <span className="fco-item-logo-placeholder">
            <TvSvgIcon />
          </span>
        )}

        <div className="fco-item-info">
          <span className="fco-item-name" title={member.name}>
            {member.name}
          </span>
          {sourceName && (
            <span className="fco-item-source" title={sourceName}>
              {sourceName}
            </span>
          )}
          <MetadataBadge
            streamId={member.stream_id}
            variant="detailed"
            location="failover"
            singleLine
          />
        </div>

        <div className="fco-item-tags">
          <span className={`fco-priority-pill ${isPrimary ? 'primary' : ''}`}>
            {isPrimary
              ? t('primary', 'Primary')
              : t('backup', {
                  defaultValue: 'Backup {{num}}',
                  num: member.priority,
                })}
          </span>
          {isActive && (
            <span className="fco-pulse-dot" />
          )}
        </div>
      </button>
    </div>
  );
}

export function FailoverChannelOverlay({
  currentChannel,
  onChannelClick,
  isCleanDesign,
  showSource: showSourceProp,
  showLabel = false,
  placement = 'default',
  onDropdownOpenChange,
}: FailoverChannelOverlayProps) {
  const { t } = useTranslation('player');
  const [isOpen, setIsOpen] = useState(false);
  const [groupName, setGroupName] = useState<string>('');
  const [groupId, setGroupId] = useState<string>('');
  const [members, setMembers] = useState<MemberChannel[]>([]);
  const [dropdownPos, setDropdownPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // @dnd-kit sensors: 5px activation distance so row clicks don't start drags
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // @dnd-kit DragEnd handler: persist new primary/backup order to the group
  const handleReorder = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !groupId) return;

    const oldIndex = members.findIndex((m) => m.stream_id === active.id);
    const newIndex = members.findIndex((m) => m.stream_id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(members, oldIndex, newIndex).map((m, idx) => ({
      ...m,
      priority: idx,
    }));
    setMembers(reordered);
    try {
      await reorderFailoverGroupChannels(groupId, reordered.map((m) => m.stream_id));
    } catch (e) {
      console.error('[FailoverChannelOverlay] Failed to reorder failover channels:', e);
    }
  }, [members, groupId]);

  const appSettingShowSource = useSettingsStore((s) => s.failoverGroupShowSource);
  const sourceNameMap = useSourceNameMap();
  const showSource = showSourceProp ?? appSettingShowSource;

  // Notify parent of open state change
  useEffect(() => {
    onDropdownOpenChange?.(isOpen);
  }, [isOpen, onDropdownOpenChange]);

  // Load failover group and active members for current channel
  useEffect(() => {
    if (!currentChannel?.stream_id) {
      setMembers([]);
      setGroupName('');
      setGroupId('');
      setIsOpen(false);
      return;
    }

    const isVod =
      currentChannel.stream_id === 'vod' || currentChannel.stream_id.startsWith('recording_');
    if (isVod) {
      setMembers([]);
      setGroupName('');
      setGroupId('');
      setIsOpen(false);
      return;
    }

    let isMounted = true;

    async function loadGroupData() {
      try {
        const membership = await db.failoverGroupMembers
          .where('stream_id')
          .equals(currentChannel!.stream_id)
          .first();

        if (!membership) {
          if (isMounted) {
            setMembers([]);
            setGroupName('');
            setGroupId('');
            setIsOpen(false);
          }
          return;
        }

        const group = await db.failoverGroups
          .where('group_id')
          .equals(membership.group_id)
          .first();

        const groupMembers = await getFailoverGroupMembers(membership.group_id);

        if (isMounted) {
          setGroupName(group?.name || 'Failover Group');
          setGroupId(membership.group_id);
          setMembers(groupMembers);
        }
      } catch (err) {
        console.error('[FailoverChannelOverlay] Failed to load failover group:', err);
      }
    }

    loadGroupData();

    return () => {
      isMounted = false;
    };
  }, [currentChannel?.stream_id]);

  // Position the portaled dropdown over the trigger's screen rect so it is
  // never clipped by the guide info pane's overflow (the preview pane can be
  // very wide, leaving a narrow info pane that would otherwise cut the list).
  const updateDropdownPos = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const dropdownWidth = 360;
    const margin = 8;
    const approxHeight = 340; // header + max 5-item list + padding
    const openUp = rect.top >= approxHeight;
    const left = Math.max(margin, Math.min(rect.right - dropdownWidth, window.innerWidth - dropdownWidth - margin));
    const next = openUp
      ? { left, top: undefined as number | undefined, bottom: window.innerHeight - rect.top + 10 }
      : { left, top: rect.bottom + 10, bottom: undefined as number | undefined };
    setDropdownPos((prev) =>
      prev && prev.left === next.left && prev.top === next.top && prev.bottom === next.bottom ? prev : next
    );
  }, []);

  // Reposition while open (preview resize / guide scroll / window resize)
  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener('resize', updateDropdownPos);
    document.addEventListener('scroll', updateDropdownPos, true);
    return () => {
      window.removeEventListener('resize', updateDropdownPos);
      document.removeEventListener('scroll', updateDropdownPos, true);
    };
  }, [isOpen, updateDropdownPos]);

  // Close on click outside or escape
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideTrigger = containerRef.current && containerRef.current.contains(target);
      const insideDropdown = dropdownRef.current && dropdownRef.current.contains(target);
      if (!insideTrigger && !insideDropdown) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  // Hide if no group or only 1 member
  if (members.length <= 1) return null;

  const currentStreamId = currentChannel?.stream_id;

  const handleChannelSelect = (member: MemberChannel) => {
    if (member.stream_id === currentStreamId) return;

    db.channels
      .where('stream_id')
      .equals(member.stream_id)
      .first()
      .then((ch) => {
        if (ch) {
          onChannelClick(ch);
          setIsOpen(false);
        } else {
          // Synthetic fallback
          const fallbackChannel: StoredChannel = {
            stream_id: member.stream_id,
            name: member.name,
            source_id: member.source_id || '',
            stream_icon: member.stream_icon || '',
            epg_channel_id: '',
            category_ids: [],
            direct_url: '',
            stream_type: 'live',
          };
          onChannelClick(fallbackChannel);
          setIsOpen(false);
        }
      });
  };

  const buttonTitle = t('failoverStreamsTooltip', {
    defaultValue: 'Failover Group: {{name}} ({{count}} available)',
    name: groupName,
    count: members.length,
  });

  return (
    <div
      className={`fco-container ${placement !== 'default' ? `placement-${placement}` : ''}`}
      ref={containerRef}
    >
      <button
        ref={triggerRef}
        className={`${isCleanDesign ? 'npb-clean-btn' : 'npb-btn'} fco-trigger-btn${isOpen ? ' active' : ''}${showLabel ? ' fco-pill-btn' : ''}`}
        onClick={() => {
          if (isOpen) {
            setIsOpen(false);
          } else {
            updateDropdownPos();
            setIsOpen(true);
          }
        }}
        title={buttonTitle}
      >
        <LinkSvgIcon />
        {showLabel && (
          <span className="fco-label-text">
            {t('backup', { defaultValue: 'Backup' })}
          </span>
        )}
        <span className="fco-badge-count">{members.length}</span>
      </button>

      {isOpen && dropdownPos && createPortal(
        <div
          ref={dropdownRef}
          className={`fco-dropdown fco-portaled ${placement !== 'default' ? `placement-${placement}` : ''}`}
          style={{ left: dropdownPos.left, top: dropdownPos.top, bottom: dropdownPos.bottom }}
          onMouseEnter={(e) => e.stopPropagation()}
          onMouseLeave={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="fco-header">
            <div className="fco-header-left">
              <LinkSvgIcon />
              <span className="fco-header-title" title={groupName}>
                {groupName}
              </span>
            </div>
            <span className="fco-header-count">
              {t('failoverStreamsCount', {
                defaultValue: '{{count}} streams',
                count: members.length,
              })}
            </span>
          </div>

          {/* List (Max 5 items with Nuvio-styled glowing scrollbar) — full-surface drag to reorder */}
          <div className="fco-list">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleReorder}
            >
              <SortableContext
                items={members.map((m) => m.stream_id)}
                strategy={verticalListSortingStrategy}
              >
                {members.map((member) => {
                  const isActive = member.stream_id === currentStreamId;
                  const sourceName =
                    showSource && sourceNameMap && member.source_id
                      ? sourceNameMap.get(member.source_id)
                      : undefined;
                  const isPrimary = member.priority === 0;

                  return (
                    <SortableFailoverItem
                      key={member.stream_id}
                      member={member}
                      isActive={isActive}
                      sourceName={sourceName}
                      isPrimary={isPrimary}
                      onSelect={() => handleChannelSelect(member)}
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
