import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  setGamepadCalibrationCallback,
  type GamepadDeviceInfo,
  type RawGamepadInputEvent,
} from '../../hooks/useGamepad';
import { ControllerVisualizer } from './ControllerVisualizer';
import './ControllerRemapModal.css';

interface ControllerRemapModalProps {
  isOpen: boolean;
  onClose: () => void;
  connectedDevices: GamepadDeviceInfo[];
}

interface StepInfo {
  id: string;
  name: string;
  instruction: string;
}

const CALIBRATION_STEPS: StepInfo[] = [
  { id: 'south', name: 'A / Cross (Bottom Button)', instruction: 'Press the bottom face button' },
  { id: 'east', name: 'B / Circle (Right Button)', instruction: 'Press the right face button' },
  { id: 'west', name: 'X / Square (Left Button)', instruction: 'Press the left face button' },
  { id: 'north', name: 'Y / Triangle (Top Button)', instruction: 'Press the top face button' },
  { id: 'dpad_up', name: 'D-Pad Up', instruction: 'Press Directional Pad Up' },
  { id: 'dpad_down', name: 'D-Pad Down', instruction: 'Press Directional Pad Down' },
  { id: 'dpad_left', name: 'D-Pad Left', instruction: 'Press Directional Pad Left' },
  { id: 'dpad_right', name: 'D-Pad Right', instruction: 'Press Directional Pad Right' },
  { id: 'left_bumper', name: 'LB / L1 (Left Bumper)', instruction: 'Press Left Shoulder Bumper' },
  { id: 'right_bumper', name: 'RB / R1 (Right Bumper)', instruction: 'Press Right Shoulder Bumper' },
  { id: 'left_trigger', name: 'LT / L2 (Left Trigger)', instruction: 'Press Left Trigger' },
  { id: 'right_trigger', name: 'RT / R2 (Right Trigger)', instruction: 'Press Right Trigger' },
  { id: 'left_stick_click', name: 'L3 (Left Stick Click)', instruction: 'Press Left Thumbstick Inward' },
  { id: 'right_stick_click', name: 'R3 (Right Stick Click)', instruction: 'Press Right Thumbstick Inward' },
  { id: 'start', name: 'Start / Menu / Options', instruction: 'Press the Start or Menu button' },
  { id: 'select', name: 'Select / Back / Share', instruction: 'Press the Select or Back button' },
];

export function ControllerRemapModal({ isOpen, onClose, connectedDevices }: ControllerRemapModalProps) {
  const { i18n } = useTranslation();
  const saveCustomGamepadProfile = useSettingsStore((s) => s.saveCustomGamepadProfile);
  const deleteCustomGamepadProfile = useSettingsStore((s) => s.deleteCustomGamepadProfile);
  const customGamepadProfiles = useSettingsStore((s) => s.customGamepadProfiles);

  const [selectedDevice, setSelectedDevice] = useState<string>(
    connectedDevices.length > 0 ? connectedDevices[0].name : 'Generic Gamepad'
  );
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(0);
  const [mappedButtons, setMappedButtons] = useState<Record<string, string>>({});
  const [lastRawDetected, setLastRawDetected] = useState<string>('');
  const [isCompleted, setIsCompleted] = useState<boolean>(false);

  // Sync selected device if default was generic and a pad connects
  useEffect(() => {
    if (connectedDevices.length > 0 && selectedDevice === 'Generic Gamepad') {
      setSelectedDevice(connectedDevices[0].name);
    }
  }, [connectedDevices, selectedDevice]);

  // Load existing profile when selected device changes
  useEffect(() => {
    if (customGamepadProfiles[selectedDevice]) {
      setMappedButtons({ ...customGamepadProfiles[selectedDevice] });
    } else {
      setMappedButtons({});
    }
  }, [selectedDevice, customGamepadProfiles]);

  const currentStep = CALIBRATION_STEPS[currentStepIndex];

  // Intercept raw button inputs during calibration mode
  useEffect(() => {
    if (!isOpen || isCompleted) {
      setGamepadCalibrationCallback(null);
      return;
    }

    const onRawInput = (event: RawGamepadInputEvent) => {
      if (!event.isPressed) return;

      const rawKey = event.buttonIndex !== undefined ? String(event.buttonIndex) : event.buttonCode;
      setLastRawDetected(`${event.rawLabel || event.buttonCode} (${rawKey})`);

      if (currentStep) {
        setMappedButtons((prev) => ({
          ...prev,
          [rawKey]: currentStep.id,
        }));

        // Advance to next step after a short delay
        setTimeout(() => {
          if (currentStepIndex < CALIBRATION_STEPS.length - 1) {
            setCurrentStepIndex((idx) => idx + 1);
          } else {
            setIsCompleted(true);
          }
        }, 220);
      }
    };

    setGamepadCalibrationCallback(onRawInput);

    return () => {
      setGamepadCalibrationCallback(null);
    };
  }, [isOpen, currentStepIndex, currentStep, isCompleted]);

  if (!isOpen) return null;

  const handleSave = () => {
    saveCustomGamepadProfile(selectedDevice, mappedButtons);
    onClose();
  };

  const handleResetProfile = () => {
    deleteCustomGamepadProfile(selectedDevice);
    setMappedButtons({});
    setCurrentStepIndex(0);
    setIsCompleted(false);
  };

  const handleSkip = () => {
    if (currentStepIndex < CALIBRATION_STEPS.length - 1) {
      setCurrentStepIndex((idx) => idx + 1);
    } else {
      setIsCompleted(true);
    }
  };

  const handlePrev = () => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex((idx) => idx - 1);
      setIsCompleted(false);
    }
  };

  const progressPercent = Math.round(((currentStepIndex + (isCompleted ? 1 : 0)) / CALIBRATION_STEPS.length) * 100);

  return (
    <div className="remap-modal-overlay" onClick={onClose}>
      <div className="remap-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="remap-modal-header">
          <div className="remap-header-titles">
            <h3 className="remap-title">
              {i18n.t('settings:controllers.remap.title', { defaultValue: 'Configure & Calibrate Gamepad' })}
            </h3>
            <span className="remap-subtitle">
              {i18n.t('settings:controllers.remap.subtitle', {
                defaultValue: 'Map any generic or 3rd-party controller buttons to YNOTV standard controls.',
              })}
            </span>
          </div>
          <button className="remap-close-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Device Selector */}
        <div className="remap-device-row">
          <span className="remap-device-label">
            {i18n.t('settings:controllers.remap.targetDevice', { defaultValue: 'Target Controller:' })}
          </span>
          <select
            className="remap-device-select"
            value={selectedDevice}
            onChange={(e) => {
              setSelectedDevice(e.target.value);
              setCurrentStepIndex(0);
              setIsCompleted(false);
            }}
          >
            {connectedDevices.length > 0 ? (
              connectedDevices.map((d) => (
                <option key={d.uuid || d.name} value={d.name}>
                  {d.name}
                </option>
              ))
            ) : (
              <option value="Generic Gamepad">Generic Gamepad</option>
            )}
          </select>
        </div>

        {/* Progress Bar */}
        <div className="remap-progress-track">
          <div className="remap-progress-fill" style={{ width: `${progressPercent}%` }} />
        </div>

        {/* Visualizer with Step Highlight */}
        <div className="remap-visualizer-wrap">
          <ControllerVisualizer
            activeLayout="xbox"
            highlightButton={!isCompleted && currentStep ? currentStep.id : undefined}
          />
        </div>

        {/* Prompt / Instruction Box */}
        <div className="remap-prompt-box">
          {!isCompleted && currentStep ? (
            <>
              <div className="remap-prompt-main">
                <span className="remap-step-badge">
                  Step {currentStepIndex + 1} of {CALIBRATION_STEPS.length}
                </span>
                <span className="remap-prompt-btn-name">{currentStep.name}</span>
                <span className="remap-prompt-instruction">{currentStep.instruction}</span>
              </div>

              {lastRawDetected && (
                <span className="remap-raw-feedback">
                  Detected: <strong>{lastRawDetected}</strong>
                </span>
              )}
            </>
          ) : (
            <div className="remap-completed-message">
              <span className="remap-completed-icon">🎉</span>
              <strong>All buttons mapped successfully!</strong>
              <span>Save profile to apply these hardware mappings to {selectedDevice}.</span>
            </div>
          )}
        </div>

        {/* Actions Footer */}
        <div className="remap-modal-footer">
          <div className="remap-footer-left">
            <button className="remap-btn-secondary" onClick={handleResetProfile}>
              {i18n.t('settings:controllers.remap.reset', { defaultValue: 'Reset Profile' })}
            </button>
          </div>

          <div className="remap-footer-right">
            {!isCompleted && (
              <>
                <button className="remap-btn-secondary" onClick={handlePrev} disabled={currentStepIndex === 0}>
                  {i18n.t('settings:controllers.remap.prev', { defaultValue: 'Previous' })}
                </button>
                <button className="remap-btn-secondary" onClick={handleSkip}>
                  {i18n.t('settings:controllers.remap.skip', { defaultValue: 'Skip' })}
                </button>
              </>
            )}
            <button className="remap-btn-primary" onClick={handleSave}>
              {i18n.t('settings:controllers.remap.save', { defaultValue: 'Save & Apply' })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
