import React from 'react';
import './OnScreenKeyboard.css';

interface OnScreenKeyboardProps {
  /** Current text being typed (shown in the display bar). */
  value: string;
  /** Called for letter/digit/space keys. */
  onKeyPress: (char: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  /** Commit the text and close the keyboard. */
  onDone: () => void;
  /** Close the keyboard without committing. */
  onCancel: () => void;
}

const LETTER_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
];

export const OnScreenKeyboard: React.FC<OnScreenKeyboardProps> = ({
  value,
  onKeyPress,
  onBackspace,
  onClear,
  onDone,
  onCancel,
}) => {
  return (
    <div className="osk">
      <div className="osk-display" title={value}>{value || '\u00A0'}</div>
      {LETTER_ROWS.map((row, rowIndex) => (
        <div className="osk-row" key={rowIndex}>
          {row.map((char) => (
            <button
              key={char}
              type="button"
              className="osk-key"
              onClick={() => onKeyPress(char.toLowerCase())}
            >
              {char}
            </button>
          ))}
        </div>
      ))}
      <div className="osk-row">
        <button type="button" className="osk-key osk-key-wide" onClick={onClear}>
          Clear
        </button>
        <button type="button" className="osk-key osk-key-space" onClick={() => onKeyPress(' ')}>
          Space
        </button>
        <button type="button" className="osk-key osk-key-wide" onClick={onBackspace} title="Backspace">
          ⌫
        </button>
      </div>
      <div className="osk-row osk-row-actions">
        <button type="button" className="osk-key osk-key-action osk-key-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="osk-key osk-key-action osk-key-done" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
};
