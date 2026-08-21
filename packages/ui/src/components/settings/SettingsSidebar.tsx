import { useTranslation } from 'react-i18next';
import './SettingsSidebar.css';

export type SettingsTabId =
  | 'sources'
  | 'metadata'
  | 'subtitles'
  | 'strem'
  | 'nuvio'
  | 'discord'
  | 'security'
  | 'proxy'
  | 'debug'
  | 'shortcuts'
  | 'controllers'
  | 'export-import'
  | 'ui'
  | 'optimization'
  | 'navigation'
  | 'theme'
  | 'startup'
  | 'playback'
  | 'scrobbling'
  | 'simkl'
  | 'cache'
  | 'livetv'
  | 'about';

interface SettingsTab {
  id: SettingsTabId;
  label: string;
  icon?: string;
  hidden?: boolean;
}

const SETTINGS_TABS: SettingsTab[] = [
  { id: 'sources', label: 'Sources' },
  { id: 'livetv', label: 'LiveTV' },
  { id: 'playback', label: 'Playback' },
  { id: 'metadata', label: 'Metadata' },
  { id: 'subtitles', label: 'Subtitles & Audio' },
  { id: 'strem', label: 'Strem' },
  { id: 'nuvio', label: 'Nuvio' },
  { id: 'discord', label: 'Discord Rich Presence' },
  { id: 'theme', label: 'Theme' },
  { id: 'ui', label: 'UI' },
  { id: 'optimization', label: 'Optimization' },
  { id: 'navigation', label: 'Navigation' },
  { id: 'startup', label: 'Startup' },
  { id: 'scrobbling', label: 'Trakt' },
  { id: 'simkl', label: 'Simkl' },
  { id: 'cache', label: 'Cache' },
  { id: 'security', label: 'Security' },
  { id: 'proxy', label: 'Proxy' },
  { id: 'debug', label: 'Debug' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'controllers', label: 'Controllers & Remote' },
  { id: 'export-import', label: 'Export / Import' },
  { id: 'about', label: 'About' },
];

// Literal i18n keys (settings namespace). Kept as a flat lookup so every
// translated label is greppable and stays in sync with en.json by hand.
export const SETTINGS_TAB_LABEL_KEYS = {
  sources: 'tabs.sources',
  livetv: 'tabs.livetv',
  playback: 'tabs.playback',
  metadata: 'tabs.metadata',
  subtitles: 'tabs.subtitles',
  strem: 'tabs.strem',
  nuvio: 'tabs.nuvio',
  discord: 'tabs.discord',
  theme: 'tabs.theme',
  ui: 'tabs.ui',
  optimization: 'tabs.optimization',
  navigation: 'tabs.navigation',
  startup: 'tabs.startup',
  scrobbling: 'tabs.scrobbling',
  simkl: 'tabs.simkl',
  cache: 'tabs.cache',
  security: 'tabs.security',
  proxy: 'tabs.proxy',
  debug: 'tabs.debug',
  shortcuts: 'tabs.shortcuts',
  controllers: 'tabs.controllers',
  'export-import': 'tabs.export-import',
  about: 'tabs.about',
} as const satisfies Record<SettingsTabId, `tabs.${SettingsTabId}`>;

interface SettingsSidebarProps {
  activeTab: SettingsTabId;
  onTabChange: (tab: SettingsTabId) => void;
  hasVodSource: boolean;
}

export function SettingsSidebar({
  activeTab,
  onTabChange,
  hasVodSource,
}: SettingsSidebarProps) {
  const { t } = useTranslation('settings');
  return (
    <nav className="settings-sidebar">
      <div className="settings-nav">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            className={`settings-nav-item ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.icon && <span className="icon">{tab.icon}</span>}
            {t(SETTINGS_TAB_LABEL_KEYS[tab.id])}
          </button>
        ))}
      </div>
    </nav>
  );
}
