import { useEffect, useId, useRef, useState } from 'react';
import { OnScreenKeyboardModal } from './OnScreenKeyboardModal';
import {
  broadcastToRemote,
  isRemoteNavSource,
  registerTextField,
} from '../services/controllerTextInput';

interface KeyboardSearchInputProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Mimic Enter on the host search box, called with the committed value. */
  onSubmit?: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Short label for the phone remote prompt / OSK title. */
  label?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  /** Extra props forwarded to the underlying <input> (e.g. onKeyDown). */
  [key: string]: any;
}

/**
 * Search input that is controller/remote friendly:
 *  - selecting it with a physical controller opens the on-screen keyboard,
 *  - selecting it with the phone remote pops a query box on the phone page,
 *  - mouse users keep normal typing.
 */
export function KeyboardSearchInput({
  value,
  onValueChange,
  onSubmit,
  placeholder,
  className,
  label,
  inputRef,
  ...rest
}: KeyboardSearchInputProps) {
  const id = useId();
  const [showKeyboard, setShowKeyboard] = useState(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  // Keep the latest callbacks in refs so the registry entry stays stable.
  const handlersRef = useRef({ onValueChange, onSubmit, label, placeholder });
  handlersRef.current = { onValueChange, onSubmit, label, placeholder };

  // Register this field so phone-remote text input can route to it.
  useEffect(() => {
    return registerTextField({
      id,
      label: handlersRef.current.label || handlersRef.current.placeholder || 'Search',
      getValue: () => valueRef.current,
      setValue: (v) => handlersRef.current.onValueChange(v),
      commit: (v) => handlersRef.current.onSubmit?.(v ?? valueRef.current),
    });
  }, [id]);

  const handleActivate = (e: React.MouseEvent<HTMLInputElement>) => {
    // Controller/remote "select" on the input opens a typing surface instead of
    // the native desktop input. Mouse clicks (tv-nav mode is cleared on
    // mousedown) keep normal typing.
    if (!document.body.classList.contains('tv-nav-active')) return;
    e.preventDefault();
    if (isRemoteNavSource()) {
      broadcastToRemote({
        type: 'requestText',
        fieldId: id,
        value: valueRef.current,
        label: label || placeholder || 'Search',
      });
    } else {
      setShowKeyboard(true);
    }
  };

  return (
    <>
      <input
        {...rest}
        ref={inputRef}
        type="text"
        className={className}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onClick={handleActivate}
      />
      {showKeyboard && (
        <OnScreenKeyboardModal
          initialValue={value}
          title={label || placeholder || 'Enter search'}
          onValueChange={onValueChange}
          onCommit={(v) => {
            setShowKeyboard(false);
            onValueChange(v);
            onSubmit?.(v);
          }}
          onCancel={() => setShowKeyboard(false)}
        />
      )}
    </>
  );
}
