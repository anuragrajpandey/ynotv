import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  subscribeGamepadButtonPress,
  subscribeGamepadStickTelemetry,
  type GamepadDeviceInfo,
} from '../../hooks/useGamepad';
import './ControllerVisualizer.css';

interface ControllerVisualizerProps {
  connectedDevices?: GamepadDeviceInfo[];
  activeLayout?: 'auto' | 'xbox' | 'playstation';
  onLayoutChange?: (layout: 'xbox' | 'playstation') => void;
  highlightButton?: string; // Optional single button highlighted for calibration wizard
}

export function ControllerVisualizer({
  connectedDevices = [],
  activeLayout = 'xbox',
  onLayoutChange,
  highlightButton,
}: ControllerVisualizerProps) {
  const { i18n } = useTranslation();

  // Active buttons held or recently pressed
  const [activeButtons, setActiveButtons] = useState<Set<string>>(new Set());
  const [leftStick, setLeftStick] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [rightStick, setRightStick] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const buttonTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Determine effective layout (Xbox vs PlayStation)
  let layout: 'xbox' | 'playstation' = activeLayout === 'auto' ? 'xbox' : activeLayout;
  if (activeLayout === 'auto' && connectedDevices.length > 0) {
    const first = connectedDevices[0].name.toLowerCase();
    if (
      first.includes('dualsense') ||
      first.includes('dualshock') ||
      first.includes('playstation') ||
      first.includes('sony') ||
      first.includes('054c') ||
      first.includes('ps4') ||
      first.includes('ps5')
    ) {
      layout = 'playstation';
    }
  }

  // Subscribe to live button events
  useEffect(() => {
    const unsubButtons = subscribeGamepadButtonPress((event) => {
      const action = event.action;
      if (!action) return;

      setActiveButtons((prev) => {
        const next = new Set(prev);
        next.add(action);
        return next;
      });

      // Clear after 300ms if not held
      const existing = buttonTimersRef.current.get(action);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        setActiveButtons((prev) => {
          const next = new Set(prev);
          next.delete(action);
          return next;
        });
        buttonTimersRef.current.delete(action);
      }, 300);

      buttonTimersRef.current.set(action, timer);
    });

    const unsubSticks = subscribeGamepadStickTelemetry((event) => {
      // Clamp between -1 and 1
      const x = Math.max(-1, Math.min(1, event.x));
      const y = Math.max(-1, Math.min(1, event.y));

      if (event.stick === 'left') {
        setLeftStick({ x, y });
      } else if (event.stick === 'right') {
        setRightStick({ x, y });
      }
    });

    return () => {
      unsubButtons();
      unsubSticks();
      buttonTimersRef.current.forEach((t) => clearTimeout(t));
      buttonTimersRef.current.clear();
    };
  }, []);

  const isBtnActive = (btnId: string) => {
    return activeButtons.has(btnId) || highlightButton === btnId;
  };

  const isXbox = layout === 'xbox';

  return (
    <div className="controller-visualizer-card">
      {/* Top Header with title and Xbox / PlayStation switcher */}
      <div className="visualizer-header">
        <span className="visualizer-title">
          {i18n.t('settings:controllers.livePreview', { defaultValue: 'LIVE PREVIEW' })}
        </span>

        <div className="layout-pill-selector">
          <button
            type="button"
            className={`layout-pill-btn ${isXbox ? 'active' : ''}`}
            onClick={() => onLayoutChange?.('xbox')}
          >
            Xbox
          </button>
          <button
            type="button"
            className={`layout-pill-btn ${!isXbox ? 'active' : ''}`}
            onClick={() => onLayoutChange?.('playstation')}
          >
            PlayStation
          </button>
        </div>
      </div>

      {/* Controller Canvas SVG */}
      <div className="visualizer-canvas-wrap">
        <svg
          viewBox="0 0 600 360"
          className="controller-svg"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            {/* Ambient drop shadows and button glows */}
            <filter id="btn-glow-blue" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#38bdf8" floodOpacity="0.85" />
            </filter>
            <filter id="btn-glow-green" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#22c55e" floodOpacity="0.85" />
            </filter>
            <filter id="btn-glow-red" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#ef4444" floodOpacity="0.85" />
            </filter>
            <filter id="btn-glow-yellow" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#eab308" floodOpacity="0.85" />
            </filter>
            <filter id="btn-glow-purple" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#ec4899" floodOpacity="0.85" />
            </filter>
            <filter id="chassis-shadow" x="-10%" y="-10%" width="120%" height="120%">
              <feDropShadow dx="0" dy="8" stdDeviation="16" floodColor="#000000" floodOpacity="0.6" />
            </filter>
            <linearGradient id="chassis-grad" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#1e222b" />
              <stop offset="50%" stopColor="#14171d" />
              <stop offset="100%" stopColor="#0d0f13" />
            </linearGradient>
            <linearGradient id="chassis-inner" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#252a35" />
              <stop offset="100%" stopColor="#111318" />
            </linearGradient>
            <linearGradient id="btn-dark" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#2b313d" />
              <stop offset="100%" stopColor="#181c24" />
            </linearGradient>
            <linearGradient id="stick-head" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#2f3644" />
              <stop offset="100%" stopColor="#1a1e27" />
            </linearGradient>
          </defs>

          {/* ========================================================
              SHOULDERS & TRIGGERS (Positioned Above Controller Body)
              ======================================================== */}
          {/* Left Trigger (LT / L2) */}
          <g className={`ctrl-btn trigger-btn ${isBtnActive('left_trigger') ? 'active active-blue' : ''}`}>
            <rect
              x="175"
              y="22"
              width="54"
              height="26"
              rx="8"
              className="shoulder-rect"
            />
            <text x="202" y="39" className="shoulder-text">
              {isXbox ? 'LT' : 'L2'}
            </text>
          </g>

          {/* Left Bumper (LB / L1) */}
          <g className={`ctrl-btn bumper-btn ${isBtnActive('left_bumper') ? 'active active-blue' : ''}`}>
            <rect
              x="165"
              y="56"
              width="68"
              height="24"
              rx="7"
              className="shoulder-rect"
            />
            <text x="199" y="72" className="shoulder-text">
              {isXbox ? 'LB' : 'L1'}
            </text>
          </g>

          {/* Right Trigger (RT / R2) */}
          <g className={`ctrl-btn trigger-btn ${isBtnActive('right_trigger') ? 'active active-blue' : ''}`}>
            <rect
              x="371"
              y="22"
              width="54"
              height="26"
              rx="8"
              className="shoulder-rect"
            />
            <text x="398" y="39" className="shoulder-text">
              {isXbox ? 'RT' : 'R2'}
            </text>
          </g>

          {/* Right Bumper (RB / R1) */}
          <g className={`ctrl-btn bumper-btn ${isBtnActive('right_bumper') ? 'active active-blue' : ''}`}>
            <rect
              x="367"
              y="56"
              width="68"
              height="24"
              rx="7"
              className="shoulder-rect"
            />
            <text x="401" y="72" className="shoulder-text">
              {isXbox ? 'RB' : 'R1'}
            </text>
          </g>

          {/* ========================================================
              CONTROLLER CHASSIS (Smooth Modern Silhouette)
              ======================================================== */}
          <g filter="url(#chassis-shadow)">
            {/* Outer Silhouette */}
            <path
              d={
                isXbox
                  ? 'M 210,78 C 240,74 360,74 390,78 C 440,84 485,115 500,165 C 516,220 480,300 425,300 C 390,300 365,255 335,255 C 315,255 308,262 300,262 C 292,262 285,255 265,255 C 235,255 210,300 175,300 C 120,300 84,220 100,165 C 115,115 160,84 210,78 Z'
                  : 'M 220,80 C 255,78 345,78 380,80 C 430,84 478,114 492,162 C 510,220 486,302 430,302 C 394,302 376,260 348,260 C 330,260 320,268 300,268 C 280,268 270,260 252,260 C 224,260 206,302 170,302 C 114,302 90,220 108,162 C 122,114 170,84 220,80 Z'
              }
              fill="url(#chassis-grad)"
              stroke="#2c323f"
              strokeWidth="2"
            />
            {/* Inner Body Inset Contour */}
            <path
              d={
                isXbox
                  ? 'M 220,92 C 250,88 350,88 380,92 C 420,98 460,125 474,168 C 488,212 458,280 415,280 C 385,280 360,240 330,240 C 312,240 306,246 300,246 C 294,246 288,240 270,240 C 240,240 215,280 185,280 C 142,280 112,212 126,168 C 140,125 180,98 220,92 Z'
                  : 'M 228,94 C 260,92 340,92 372,94 C 412,98 456,124 468,165 C 482,212 462,282 418,282 C 388,282 370,245 344,245 C 326,245 316,252 300,252 C 284,252 274,245 256,245 C 230,245 212,282 182,282 C 138,282 118,212 132,165 C 144,124 188,98 228,94 Z'
              }
              fill="url(#chassis-inner)"
              stroke="#20242e"
              strokeWidth="1.2"
              opacity="0.85"
            />
          </g>

          {/* ========================================================
              CENTER MENU BUTTONS (Back/View, Guide/Home, Start/Menu)
              ======================================================== */}
          {/* Guide / Logo Button */}
          <g className={`ctrl-btn guide-btn ${isBtnActive('guide') ? 'active active-blue' : ''}`}>
            <circle
              cx="300"
              cy={isXbox ? '118' : '222'}
              r="14"
              className="menu-btn-circle guide-circle"
            />
            {isXbox ? (
              <text x="300" y="122" className="guide-glyph-xbox">
                ✕
              </text>
            ) : (
              <text x="300" y="226" className="guide-glyph-ps">
                P
              </text>
            )}
          </g>

          {/* Select / Back / View Button */}
          <g className={`ctrl-btn ${isBtnActive('select') ? 'active active-blue' : ''}`}>
            <circle
              cx="262"
              cy="144"
              r="6.5"
              className="menu-btn-circle"
            />
          </g>

          {/* Start / Menu / Options Button */}
          <g className={`ctrl-btn ${isBtnActive('start') ? 'active active-blue' : ''}`}>
            <circle
              cx="338"
              cy="144"
              r="6.5"
              className="menu-btn-circle"
            />
          </g>

          {/* PlayStation Touchpad (PS layout only) */}
          {!isXbox && (
            <rect
              x="250"
              y="102"
              width="100"
              height="38"
              rx="6"
              fill="#181c24"
              stroke="#2d3340"
              strokeWidth="1.2"
              className={isBtnActive('touchpad') ? 'touchpad-active' : ''}
            />
          )}

          {/* ========================================================
              D-PAD (Directions: Up, Down, Left, Right)
              ======================================================== */}
          {/* Xbox D-pad is bottom-left (cx=240, cy=210), PS D-pad is top-left (cx=198, cy=155) */}
          <g transform={`translate(${isXbox ? '240, 210' : '198, 155'})`}>
            {/* D-Pad Base Cross Background */}
            <path
              d="M -9,-26 L 9,-26 L 9,-9 L 26,-9 L 26,9 L 9,9 L 9,26 L -9,26 L -9,9 L -26,9 L -26,-9 L -9,-9 Z"
              fill="#161920"
              stroke="#2a303d"
              strokeWidth="1.5"
            />
            {/* D-Pad Up */}
            <path
              d="M -8,-25 L 8,-25 L 8,-8 L -8,-8 Z"
              className={`ctrl-btn dpad-wing ${isBtnActive('dpad_up') ? 'active active-blue' : ''}`}
            />
            <path d="M -3,-18 L 0,-21 L 3,-18" stroke="#64748b" strokeWidth="1.5" fill="none" />

            {/* D-Pad Down */}
            <path
              d="M -8,8 L 8,8 L 8,25 L -8,25 Z"
              className={`ctrl-btn dpad-wing ${isBtnActive('dpad_down') ? 'active active-blue' : ''}`}
            />
            <path d="M -3,18 L 0,21 L 3,18" stroke="#64748b" strokeWidth="1.5" fill="none" />

            {/* D-Pad Left */}
            <path
              d="M -25,-8 L -8,-8 L -8,8 L -25,8 Z"
              className={`ctrl-btn dpad-wing ${isBtnActive('dpad_left') ? 'active active-blue' : ''}`}
            />
            <path d="M -18,-3 L -21,0 L -18,3" stroke="#64748b" strokeWidth="1.5" fill="none" />

            {/* D-Pad Right */}
            <path
              d="M 8,-8 L 25,-8 L 25,8 L 8,8 Z"
              className={`ctrl-btn dpad-wing ${isBtnActive('dpad_right') ? 'active active-blue' : ''}`}
            />
            <path d="M 18,-3 L 21,0 L 18,3" stroke="#64748b" strokeWidth="1.5" fill="none" />

            {/* D-Pad Center Cap */}
            <circle cx="0" cy="0" r="6" fill="#1e222b" />
          </g>

          {/* ========================================================
              FACE BUTTONS (North, East, South, West)
              ======================================================== */}
          {/* Face buttons cluster center: cx=402, cy=155 */}
          <g transform="translate(402, 155)">
            {/* North Button (Y on Xbox / Triangle on PS) */}
            <g
              transform="translate(0, -26)"
              className={`ctrl-btn face-btn north-btn ${isBtnActive('north') ? 'active' : ''}`}
            >
              <circle cx="0" cy="0" r="14" className="face-btn-bg" />
              {isXbox ? (
                <text x="0" y="5" className="face-glyph xbox-y">
                  Y
                </text>
              ) : (
                <text x="0" y="5" className="face-glyph ps-triangle">
                  ▲
                </text>
              )}
            </g>

            {/* East Button (B on Xbox / Circle on PS) */}
            <g
              transform="translate(26, 0)"
              className={`ctrl-btn face-btn east-btn ${isBtnActive('east') ? 'active' : ''}`}
            >
              <circle cx="0" cy="0" r="14" className="face-btn-bg" />
              {isXbox ? (
                <text x="0" y="5" className="face-glyph xbox-b">
                  B
                </text>
              ) : (
                <text x="0" y="5" className="face-glyph ps-circle">
                  ●
                </text>
              )}
            </g>

            {/* South Button (A on Xbox / Cross on PS) */}
            <g
              transform="translate(0, 26)"
              className={`ctrl-btn face-btn south-btn ${isBtnActive('south') ? 'active' : ''}`}
            >
              <circle cx="0" cy="0" r="14" className="face-btn-bg" />
              {isXbox ? (
                <text x="0" y="5" className="face-glyph xbox-a">
                  A
                </text>
              ) : (
                <text x="0" y="5" className="face-glyph ps-cross">
                  ✕
                </text>
              )}
            </g>

            {/* West Button (X on Xbox / Square on PS) */}
            <g
              transform="translate(-26, 0)"
              className={`ctrl-btn face-btn west-btn ${isBtnActive('west') ? 'active' : ''}`}
            >
              <circle cx="0" cy="0" r="14" className="face-btn-bg" />
              {isXbox ? (
                <text x="0" y="5" className="face-glyph xbox-x">
                  X
                </text>
              ) : (
                <text x="0" y="5" className="face-glyph ps-square">
                  ■
                </text>
              )}
            </g>
          </g>

          {/* ========================================================
              ANALOG THUMBSTICKS (Left Stick & Right Stick with Deflection)
              ======================================================== */}
          {/* Left Thumbstick: Xbox is top-left (198, 155), PS is bottom-left (238, 212) */}
          <g transform={`translate(${isXbox ? '198, 155' : '238, 212'})`}>
            {/* Outer Well Ring */}
            <circle cx="0" cy="0" r="28" className="stick-well" />
            <circle cx="0" cy="0" r="24" className="stick-well-inner" />

            {/* Deflecting Stick Head */}
            <g
              className={`ctrl-stick-head ${isBtnActive('left_stick_click') ? 'active-click' : ''} ${
                Math.abs(leftStick.x) > 0.12 || Math.abs(leftStick.y) > 0.12 ? 'stick-active' : ''
              }`}
              style={{
                transform: `translate(${leftStick.x * 12}px, ${leftStick.y * 12}px)`,
                transition: 'transform 0.05s ease-out',
              }}
            >
              <circle cx="0" cy="0" r="20" fill="url(#stick-head)" stroke="#3b4252" strokeWidth="1.5" />
              <circle cx="0" cy="0" r="14" fill="#181c24" stroke="#252a35" strokeWidth="1" />
              <circle cx="0" cy="0" r="6" fill="#2d3342" />
            </g>
          </g>

          {/* Right Thumbstick: Xbox is bottom-right (360, 212), PS is bottom-right (362, 212) */}
          <g transform={`translate(${isXbox ? '360, 212' : '362, 212'})`}>
            {/* Outer Well Ring */}
            <circle cx="0" cy="0" r="28" className="stick-well" />
            <circle cx="0" cy="0" r="24" className="stick-well-inner" />

            {/* Deflecting Stick Head */}
            <g
              className={`ctrl-stick-head ${isBtnActive('right_stick_click') ? 'active-click' : ''} ${
                Math.abs(rightStick.x) > 0.12 || Math.abs(rightStick.y) > 0.12 ? 'stick-active' : ''
              }`}
              style={{
                transform: `translate(${rightStick.x * 12}px, ${rightStick.y * 12}px)`,
                transition: 'transform 0.05s ease-out',
              }}
            >
              <circle cx="0" cy="0" r="20" fill="url(#stick-head)" stroke="#3b4252" strokeWidth="1.5" />
              <circle cx="0" cy="0" r="14" fill="#181c24" stroke="#252a35" strokeWidth="1" />
              <circle cx="0" cy="0" r="6" fill="#2d3342" />
            </g>
          </g>
        </svg>
      </div>

      {/* Visualizer Footer Note */}
      <div className="visualizer-footer">
        <span className="visualizer-hint">
          {i18n.t('settings:controllers.liveHint', {
            defaultValue: 'Connect a controller: every press and stick move shows up here, live.',
          })}
        </span>
      </div>
    </div>
  );
}
