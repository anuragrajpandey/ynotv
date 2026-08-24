import { useState } from 'react';
import { OnScreenKeyboard } from './OnScreenKeyboard';
import './OnScreenKeyboardModal.css';

interface OnScreenKeyboardModalProps {
  initialValue: string;
  title?: string;
  /** Live value updates as keys are pressed (lets the host filter live). */
  onValueChange?: (value: string) => void;
  /** Done pressed — commit the edited text. */
  onCommit: (value: string) => void;
  /** Cancel / Back — discard and close. */
  onCancel: () => void;
}

/**
 * Full-screen on-screen keyboard overlay used when a search box is activated
 * with a controller. Class ends in `-modal` so the spatial-nav engine traps
 * focus inside it; the ✕ close comes after the keys in DOM order so
 * auto-focus lands on a letter key.
 */
export function OnScreenKeyboardModal({
  initialValue,
  title = 'Enter text',
  onValueChange,
  onCommit,
  onCancel,
}: OnScreenKeyboardModalProps) {
  const [value, setValue] = useState(initialValue);

  const setValueAndNotify = (next: string) => {
    setValue(next);
    onValueChange?.(next);
  };

  return (
    <div className="osk-input-overlay" onClick={onCancel}>
      <div className="osk-input-modal" onClick={(e) => e.stopPropagation()}>
        <div className="osk-input-title">{title}</div>
        <OnScreenKeyboard
          value={value}
          onKeyPress={(char) => setValueAndNotify(value + char)}
          onBackspace={() => setValueAndNotify(value.slice(0, -1))}
          onClear={() => setValueAndNotify('')}
          onDone={() => onCommit(value)}
          onCancel={onCancel}
        />
        <button
          className="modal-close osk-input-close"
          onClick={onCancel}
          title="Close"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
