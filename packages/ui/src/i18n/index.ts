import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

/** English-only locale registry. */
export const SUPPORTED_LOCALES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
];

function applyDocumentDirection(lng: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('dir', 'ltr');
  document.documentElement.setAttribute('lang', 'en');
}

export function isSupportedLocale(code: string): boolean {
  return code === 'en';
}

function getInitialLanguage(): string {
  return 'en';
}

i18n.use(initReactI18next).init({
  resources: {
    en: en as any,
  },
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: Object.keys(en),
  interpolation: {
    escapeValue: false,
  },
  returnNull: false,
  missingKeyHandler: (lngs, ns, key, fallbackValue) => {
    if (import.meta.env.DEV) {
      console.warn(`[i18n:missing] Key "${ns}:${key}" missing for locale "${lngs.join(',')}". Fallback: "${fallbackValue}"`);
    }
  },
  react: {
    useSuspense: false,
  },
});

i18n.on('languageChanged', applyDocumentDirection);
applyDocumentDirection('en');

export default i18n;

export const changeLanguage = (lang: string): ReturnType<typeof i18n.changeLanguage> => i18n.changeLanguage('en');

/**
 * Translate known backend/native error strings (Rust commands, local-adapter clients)
 * that surface raw via `res.error` / `result.error` / `err.message` at display sites.
 * Unknown strings (dynamic network details, HTTP text, plugin internals) pass through.
 */
export function translateNativeError(msg: string | null | undefined): string {
  if (!msg) return '';
  if (msg.startsWith('Conflict:')) return i18n.t('contextMenu.conflictMessage');
  if (msg.startsWith('Failed to schedule recording:')) return i18n.t('contextMenu.failedScheduleRecording');
  if (msg.startsWith('Failed to start instant recording:')) return i18n.t('dvr:failedToStartRecording');
  if (msg.startsWith('Failed to convert recording:')) return i18n.t('dvr:failedToConvertRecording');
  if (msg.startsWith('Failed to resolve stream URL:')) return i18n.t('contextMenu.failedResolveStreamUrl');
  if (msg.startsWith('Download interrupted by network error:')) return i18n.t('common:epgDownloadInterrupted');
  if (msg.startsWith('Download interrupted:')) return i18n.t('common:epgDownloadInterrupted');
  if (msg.startsWith('Stream parse EPG failed:')) return i18n.t('common:epgParseFailed');
  if (msg.startsWith('Stream parse EPG multi failed:')) return i18n.t('common:epgParseFailed');
  if (msg.startsWith('mpv process (pid=')) return i18n.t('player:mpvDiedStartup');
  if (msg.startsWith('Failed to launch media receiver:')) return i18n.t('cast:failedToLaunchReceiver');
  if (msg.startsWith('Reconnect receiver channel failed:')) return i18n.t('cast:failedToConnect');
  if (msg.startsWith('Reconnect heartbeat failed:')) return i18n.t('cast:failedToConnect');
  if (msg.startsWith('Reconnect to ')) return i18n.t('cast:failedToConnect');
  switch (msg) {
    case 'Authentication failed':
      return i18n.t('common:authenticationFailed');
    case 'Proxy is not enabled or proxy server field is empty':
      return i18n.t('settings:proxy.notEnabled');
    case 'Download not found or already finished':
      return i18n.t('common:downloadNotFoundOrFinished');
    case 'Recording not found':
      return i18n.t('common:recordingNotFound');
    case 'Interrupted by app restart':
      return i18n.t('common:interruptedRestart');
    case 'No media session':
      return i18n.t('player:noMediaSession');
    case 'Max retries exceeded for database operation':
      return i18n.t('common:epgMaxRetriesExceeded');
    case 'Main window not found':
      return i18n.t('player:mainWindowNotFound');
    case 'IPC not connected':
      return i18n.t('player:mpvNotConnected');
    case 'Timeout':
      return i18n.t('player:mpvTimeout');
    case 'Channel closed':
      return i18n.t('player:mpvChannelClosed');
    default:
      return msg;
  }
}
