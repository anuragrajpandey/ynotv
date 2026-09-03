import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '../../../stores/settingsStore';
import { sanitizeHydratedSettings } from '../../../stores/settingsStoreHydration';
import {
  DEFAULT_PHONE_REMOTE_CONFIG,
  PHONE_REMOTE_SKINS,
  ALL_PHONE_REMOTE_TABS,
  PhoneRemoteConfig,
} from '../../../types/phoneRemote';

describe('Phone Remote Customizer Store & Config', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetPhoneRemoteConfig();
  });

  it('initializes with default phone remote configuration', () => {
    const config = useSettingsStore.getState().phoneRemoteConfig;
    expect(config).toEqual(DEFAULT_PHONE_REMOTE_CONFIG);
    expect(config.skin).toBe('modern');
    expect(config.enabledTabs).toContain('remote');
    expect(config.enabledTabs).toContain('guide');
    expect(config.enabledTabs).toContain('sports');
    expect(config.enabledTabs).toContain('multiview');
    expect(config.cornerButtons.topLeft.action).toBe('open_sections');
    expect(config.cornerButtons.topRight.action).toBe('toggle_fullscreen');
    expect(config.cornerButtons.bottomLeft.action).toBe('seek_backward');
    expect(config.cornerButtons.bottomRight.action).toBe('seek_forward');
    expect(config.centerButtons.top.action).toBe('back');
    expect(config.centerButtons.bottom.action).toBe('play_pause');
    expect(config.centerButtons.size).toBe('normal');
    expect(config.quickActions).toEqual([]);
  });

  it('updates skin in store', () => {
    useSettingsStore.getState().setPhoneRemoteConfig({
      skin: 'cyberpunk',
    });

    const config = useSettingsStore.getState().phoneRemoteConfig;
    expect(config.skin).toBe('cyberpunk');
  });

  it('toggles tabs on and off', () => {
    // Enable destinations
    useSettingsStore.getState().setPhoneRemoteConfig({
      enabledTabs: ['remote', 'guide', 'destinations'],
    });

    let config = useSettingsStore.getState().phoneRemoteConfig;
    expect(config.enabledTabs).toEqual(['remote', 'guide', 'destinations']);

    // Disable guide
    useSettingsStore.getState().setPhoneRemoteConfig({
      enabledTabs: ['remote', 'destinations'],
    });

    config = useSettingsStore.getState().phoneRemoteConfig;
    expect(config.enabledTabs).toEqual(['remote', 'destinations']);
  });

  it('updates corner satellite button mappings', () => {
    useSettingsStore.getState().setPhoneRemoteConfig({
      cornerButtons: {
        ...DEFAULT_PHONE_REMOTE_CONFIG.cornerButtons,
        topLeft: {
          enabled: true,
          action: 'toggle_mute',
          customLabel: 'Mute',
        },
      },
    });

    const config = useSettingsStore.getState().phoneRemoteConfig;
    expect(config.cornerButtons.topLeft.action).toBe('toggle_mute');
    expect(config.cornerButtons.topLeft.customLabel).toBe('Mute');
  });

  it('customizes and resizes middle action buttons (Back and Play/Pause)', () => {
    useSettingsStore.getState().setPhoneRemoteConfig({
      centerButtons: {
        top: {
          enabled: true,
          action: 'toggle_mute',
          customLabel: 'Mute',
        },
        bottom: {
          enabled: true,
          action: 'toggle_fullscreen',
          customLabel: 'Fullscreen',
        },
        size: 'expanded',
      },
    });

    const config = useSettingsStore.getState().phoneRemoteConfig;
    expect(config.centerButtons.top.action).toBe('toggle_mute');
    expect(config.centerButtons.top.customLabel).toBe('Mute');
    expect(config.centerButtons.bottom.action).toBe('toggle_fullscreen');
    expect(config.centerButtons.bottom.customLabel).toBe('Fullscreen');
    expect(config.centerButtons.size).toBe('expanded');
  });

  it('adds and removes quick actions', () => {
    useSettingsStore.getState().setPhoneRemoteConfig({
      quickActions: ['toggle_livetv', 'toggle_stremio', 'open_movies'],
    });

    const config = useSettingsStore.getState().phoneRemoteConfig;
    expect(config.quickActions).toEqual(['toggle_livetv', 'toggle_stremio', 'open_movies']);
  });

  it('updates layout preferences', () => {
    useSettingsStore.getState().setPhoneRemoteConfig({
      layout: {
        ...DEFAULT_PHONE_REMOTE_CONFIG.layout,
        buttonSize: 'large',
        showSearch: false,
      },
    });

    const config = useSettingsStore.getState().phoneRemoteConfig;
    expect(config.layout.buttonSize).toBe('large');
    expect(config.layout.showSearch).toBe(false);
  });

  it('resets to defaults cleanly', () => {
    useSettingsStore.getState().setPhoneRemoteConfig({
      skin: 'oled',
      enabledTabs: ['remote'],
      quickActions: [],
      centerButtons: {
        top: { enabled: false, action: 'none' },
        bottom: { enabled: false, action: 'none' },
        size: 'compact',
      },
    });

    useSettingsStore.getState().resetPhoneRemoteConfig();
    const config = useSettingsStore.getState().phoneRemoteConfig;
    expect(config).toEqual(DEFAULT_PHONE_REMOTE_CONFIG);
  });

  it('sanitizes and migrates partial or corrupted storage payload gracefully', () => {
    const partial: Partial<PhoneRemoteConfig> = {
      skin: 'sunset',
      // missing cornerButtons, centerButtons and layout
    };

    const sanitized = sanitizeHydratedSettings({
      phoneRemoteConfig: partial as any,
    });

    expect(sanitized.phoneRemoteConfig).toBeDefined();
    expect(sanitized.phoneRemoteConfig?.skin).toBe('sunset');
    expect(sanitized.phoneRemoteConfig?.cornerButtons.topLeft.action).toBe('open_sections');
    expect(sanitized.phoneRemoteConfig?.centerButtons.top.action).toBe('back');
    expect(sanitized.phoneRemoteConfig?.centerButtons.bottom.action).toBe('play_pause');
    expect(sanitized.phoneRemoteConfig?.centerButtons.size).toBe('normal');
    expect(sanitized.phoneRemoteConfig?.layout.showNowPlaying).toBe(true);
  });

  it('provides all 8 registered dark skins with valid metadata (light theme removed)', () => {
    expect(PHONE_REMOTE_SKINS.length).toBe(8);
    PHONE_REMOTE_SKINS.forEach((s) => {
      expect(s.id).toBeDefined();
      expect(s.name).toBeDefined();
      expect(s.description).toBeDefined();
      expect(s.previewAccent).toBeDefined();
      expect(s.previewBg).toBeDefined();
    });
  });

  it('provides all 5 registered tabs with valid identifiers (numpad removed)', () => {
    expect(ALL_PHONE_REMOTE_TABS.length).toBe(5);
    expect(ALL_PHONE_REMOTE_TABS.map((t) => t.id)).toEqual([
      'remote',
      'guide',
      'sports',
      'multiview',
      'destinations',
    ]);
  });
});
