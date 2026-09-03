/**
 * phoneRemote.ts
 *
 * Type definitions, default presets, action catalog, and metadata
 * for the Virtual Phone Remote customization system.
 */

export type PhoneRemoteSkin =
  | 'modern'
  | 'oled'
  | 'cyberpunk'
  | 'midnight'
  | 'sunset'
  | 'forest'
  | 'crimson'
  | 'retro';

export type PhoneRemoteTabId =
  | 'remote'
  | 'guide'
  | 'sports'
  | 'multiview'
  | 'destinations';

export interface PhoneRemoteCornerButtonConfig {
  enabled: boolean;
  action: string;
  customLabel?: string;
}

export interface PhoneRemoteCornerButtonsConfig {
  topLeft: PhoneRemoteCornerButtonConfig;
  topRight: PhoneRemoteCornerButtonConfig;
  bottomLeft: PhoneRemoteCornerButtonConfig;
  bottomRight: PhoneRemoteCornerButtonConfig;
}

export interface PhoneRemoteCenterButtonConfig {
  enabled: boolean;
  action: string;
  customLabel?: string;
}

export interface PhoneRemoteCenterButtonsConfig {
  top: PhoneRemoteCenterButtonConfig;
  bottom: PhoneRemoteCenterButtonConfig;
  size: 'compact' | 'normal' | 'large' | 'expanded';
}

export interface PhoneRemoteLayoutConfig {
  showNowPlaying: boolean;
  showSearch: boolean;
  showVolumeRocker: boolean;
  showChannelRocker: boolean;
  showCenterStack: boolean;
  showQuickActions: boolean;
  buttonSize: 'compact' | 'normal' | 'large';
  defaultTab: PhoneRemoteTabId;
}

export interface PhoneRemoteConfig {
  skin: PhoneRemoteSkin;
  enabledTabs: PhoneRemoteTabId[];
  cornerButtons: PhoneRemoteCornerButtonsConfig;
  centerButtons: PhoneRemoteCenterButtonsConfig;
  quickActions: string[];
  layout: PhoneRemoteLayoutConfig;
}

export interface PhoneRemoteSkinMeta {
  id: PhoneRemoteSkin;
  name: string;
  description: string;
  previewBg: string;
  previewAccent: string;
  previewSecondary: string;
}

export const PHONE_REMOTE_SKINS: PhoneRemoteSkinMeta[] = [
  {
    id: 'modern',
    name: 'Modern Glass',
    description: 'Sleek dark glassmorphism with cyan and violet gradients',
    previewBg: 'linear-gradient(135deg, #07090e 0%, #0f172a 100%)',
    previewAccent: '#38bdf8',
    previewSecondary: '#818cf8',
  },
  {
    id: 'oled',
    name: 'OLED Pure Black',
    description: 'Pitch-black background with high-contrast crisp borders',
    previewBg: '#000000',
    previewAccent: '#00e5ff',
    previewSecondary: '#ffffff',
  },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk Neon',
    description: 'Electric magenta and cyan neon glow on dark obsidian',
    previewBg: 'linear-gradient(135deg, #0d0614 0%, #1a052e 100%)',
    previewAccent: '#ff007f',
    previewSecondary: '#00f0ff',
  },
  {
    id: 'midnight',
    name: 'Midnight Navy',
    description: 'Deep royal navy and metallic sapphire glow',
    previewBg: 'linear-gradient(135deg, #060e1e 0%, #0a1931 100%)',
    previewAccent: '#38bdf8',
    previewSecondary: '#60a5fa',
  },
  {
    id: 'sunset',
    name: 'Sunset Ember',
    description: 'Warm crimson, amber orange, and dusk purple gradients',
    previewBg: 'linear-gradient(135deg, #180814 0%, #2a0818 100%)',
    previewAccent: '#f97316',
    previewSecondary: '#e11d48',
  },
  {
    id: 'forest',
    name: 'Emerald Matrix',
    description: 'Dark pine glass with vibrant emerald and mint neon',
    previewBg: 'linear-gradient(135deg, #05140d 0%, #0a2418 100%)',
    previewAccent: '#10b981',
    previewSecondary: '#34d399',
  },
  {
    id: 'crimson',
    name: 'Crimson Titanium',
    description: 'Deep titanium black with fiery ruby accents',
    previewBg: 'linear-gradient(135deg, #120407 0%, #1f080c 100%)',
    previewAccent: '#ef4444',
    previewSecondary: '#f43f5e',
  },
  {
    id: 'retro',
    name: 'Retro Arcade',
    description: 'Matte charcoal body with classic colorful arcade buttons',
    previewBg: '#18191f',
    previewAccent: '#f59e0b',
    previewSecondary: '#3b82f6',
  },
];

export interface PhoneRemoteTabMeta {
  id: PhoneRemoteTabId;
  label: string;
  description: string;
  iconName: string;
}

export const ALL_PHONE_REMOTE_TABS: PhoneRemoteTabMeta[] = [
  { id: 'remote', label: 'Remote', description: 'Core D-pad dial and playback control', iconName: 'gamepad' },
  { id: 'guide', label: 'Live Guide', description: 'Interactive channel categories and EPG tree', iconName: 'tv' },
  { id: 'sports', label: 'Sports', description: 'Live scores and upcoming game streams', iconName: 'trophy' },
  { id: 'multiview', label: 'Multiview', description: 'Screen layout switcher and slot picker', iconName: 'grid' },
  { id: 'destinations', label: 'Destinations', description: 'Quick jump to all sections of YNOTV', iconName: 'compass' },
];

export interface PhoneRemoteActionMeta {
  id: string;
  label: string;
  shortLabel: string;
  category: 'playback' | 'navigation' | 'audio' | 'display' | 'destinations';
  icon: string;
}

export const PHONE_REMOTE_AVAILABLE_ACTIONS: PhoneRemoteActionMeta[] = [
  // Navigation & Menus
  { id: 'back', label: 'Back / Return', shortLabel: 'Back', category: 'navigation', icon: 'arrow-left' },
  { id: 'open_sections', label: 'App Destinations Menu', shortLabel: 'Open', category: 'destinations', icon: 'grid' },
  { id: 'toggle_fullscreen', label: 'Toggle Fullscreen', shortLabel: 'Screen', category: 'display', icon: 'maximize' },
  { id: 'toggle_live_game_sidebar', label: 'Live Games Sidebar', shortLabel: 'Games', category: 'navigation', icon: 'trophy' },
  { id: 'search', label: 'Search Modal', shortLabel: 'Search', category: 'navigation', icon: 'search' },
  { id: 'subtitles', label: 'Subtitles Selection', shortLabel: 'Subs', category: 'display', icon: 'message-square' },
  { id: 'toggle_overlay', label: 'Channel Info Overlay', shortLabel: 'Info', category: 'display', icon: 'info' },
  { id: 'toggle_transparent_overlay', label: 'Transparent Quick Guide', shortLabel: 'Guide', category: 'display', icon: 'layers' },

  // Playback & Seeking
  { id: 'play_pause', label: 'Play / Pause', shortLabel: 'Play', category: 'playback', icon: 'play' },
  { id: 'seek_backward', label: 'Rewind 10 Seconds', shortLabel: '-10s', category: 'playback', icon: 'rewind' },
  { id: 'seek_forward', label: 'Forward 10 Seconds', shortLabel: '+10s', category: 'playback', icon: 'fast-forward' },
  { id: 'seek_backward_30', label: 'Rewind 30 Seconds', shortLabel: '-30s', category: 'playback', icon: 'rotate-ccw' },
  { id: 'seek_forward_30', label: 'Forward 30 Seconds', shortLabel: '+30s', category: 'playback', icon: 'rotate-cw' },

  // Audio & Channels
  { id: 'toggle_mute', label: 'Toggle Mute', shortLabel: 'Mute', category: 'audio', icon: 'volume-x' },
  { id: 'volume_up', label: 'Volume Up (+5%)', shortLabel: 'Vol +', category: 'audio', icon: 'volume-2' },
  { id: 'volume_down', label: 'Volume Down (-5%)', shortLabel: 'Vol -', category: 'audio', icon: 'volume-1' },
  { id: 'next_channel', label: 'Next Channel', shortLabel: 'CH +', category: 'navigation', icon: 'chevron-up' },
  { id: 'prev_channel', label: 'Previous Channel', shortLabel: 'CH -', category: 'navigation', icon: 'chevron-down' },
  { id: 'epg_shift_forward', label: 'EPG Shift Forward (+2h)', shortLabel: 'EPG +2h', category: 'navigation', icon: 'arrow-right' },
  { id: 'epg_shift_backward', label: 'EPG Shift Backward (-2h)', shortLabel: 'EPG -2h', category: 'navigation', icon: 'arrow-left' },

  // Destinations Direct Jump
  { id: 'toggle_livetv', label: 'Jump to Live TV', shortLabel: 'Live TV', category: 'destinations', icon: 'tv' },
  { id: 'open_movies', label: 'Jump to Movies', shortLabel: 'Movies', category: 'destinations', icon: 'film' },
  { id: 'open_series', label: 'Jump to TV Series', shortLabel: 'Series', category: 'destinations', icon: 'tv' },
  { id: 'open_sports', label: 'Jump to Sports', shortLabel: 'Sports', category: 'destinations', icon: 'activity' },
  { id: 'toggle_stremio', label: 'Jump to Stremio', shortLabel: 'Stremio', category: 'destinations', icon: 'play-circle' },
  { id: 'toggle_nuvio', label: 'Jump to Nuvio', shortLabel: 'Nuvio', category: 'destinations', icon: 'cloud' },
  { id: 'open_settings', label: 'Jump to Settings', shortLabel: 'Settings', category: 'destinations', icon: 'settings' },
];

export const DEFAULT_PHONE_REMOTE_CONFIG: PhoneRemoteConfig = {
  skin: 'modern',
  enabledTabs: ['remote', 'guide', 'sports', 'multiview'],
  cornerButtons: {
    topLeft: { enabled: true, action: 'open_sections', customLabel: 'Open' },
    topRight: { enabled: true, action: 'toggle_fullscreen', customLabel: 'Screen' },
    bottomLeft: { enabled: true, action: 'seek_backward', customLabel: '10s' },
    bottomRight: { enabled: true, action: 'seek_forward', customLabel: '10s' },
  },
  centerButtons: {
    top: { enabled: true, action: 'back', customLabel: 'Back' },
    bottom: { enabled: true, action: 'play_pause', customLabel: 'Play / Pause' },
    size: 'normal',
  },
  quickActions: [],
  layout: {
    showNowPlaying: true,
    showSearch: true,
    showVolumeRocker: true,
    showChannelRocker: true,
    showCenterStack: true,
    showQuickActions: true,
    buttonSize: 'normal',
    defaultTab: 'remote',
  },
};
