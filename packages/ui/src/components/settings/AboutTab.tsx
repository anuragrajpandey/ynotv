import { checkForUpdates } from '../../services/updater';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import ReactMarkdown from 'react-markdown';
import './PlaybackTab.css'; // Reuse existing tab styles
import './AboutTab.css';
import changelogContent from '@root/CHANGELOG.md?raw';

interface YtdlpInfo {
  found: boolean;
  path: string | null;
  version: string | null;
}

interface YtdlpUpdateResult {
  status: string;
  path: string | null;
  version: string | null;
  latestVersion: string | null;
  message: string | null;
}

export function AboutTab() {
  useTranslation();
  const [version, setVersion] = useState<string>('');
  const [ytdlp, setYtdlp] = useState<YtdlpInfo | null>(null);
  const [updatingYtdlp, setUpdatingYtdlp] = useState(false);
  const [ytdlpResult, setYtdlpResult] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(''));
    invoke<YtdlpInfo>('ytdlp_info')
      .then(setYtdlp)
      .catch(() => setYtdlp({ found: false, path: null, version: null }));
  }, []);

  const handleCheckForUpdates = () => {
    checkForUpdates();
  };

  const handleUpdateYtdlp = async () => {
    setUpdatingYtdlp(true);
    setYtdlpResult(null);
    try {
      const res = await invoke<YtdlpUpdateResult>('update_ytdlp');
      if (res.status === 'upToDate') {
        setYtdlpResult(i18n.t('settings:about.ytdlpUpToDate', { version: res.version || '' }));
      } else if (res.status === 'updated') {
        setYtdlp({ found: true, path: res.path, version: res.version });
        setYtdlpResult(i18n.t('settings:about.ytdlpUpdated', { version: res.version || '' }));
      } else if (res.status === 'notSupported') {
        setYtdlpResult(i18n.t('settings:about.ytdlpNotSupported'));
      } else {
        setYtdlpResult(i18n.t('settings:about.ytdlpError', { message: res.message || res.status }));
      }
    } catch (e) {
      setYtdlpResult(i18n.t('settings:about.ytdlpError', { message: String(e) }));
    } finally {
      setUpdatingYtdlp(false);
    }
  };

  const openLink = async (url: string) => {
    try {
      await invoke('open_external_url', { url });
    } catch (e) {
      console.error('[About] Failed to open URL:', e);
      // Fallback: open in new tab
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className="settings-tab-content playback-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:about.title')}</h3>
        </div>

        <div className="about-content" style={{ padding: '16px 0' }}>
          <div className="about-row" style={{ marginBottom: '16px' }}>
            <span className="about-label" style={{ fontWeight: 500 }}>{i18n.t('settings:about.version')}</span>
            <span className="about-value">{version || i18n.t('settings:about.loading')}</span>
          </div>

          <div className="about-links" style={{ marginBottom: '24px', display: 'flex', gap: '16px' }}>
            <button
              className="sync-btn"
              onClick={() => openLink('https://github.com/tbeezy/ynotv')}
              style={{ maxWidth: '140px' }}
            >
              GitHub
            </button>
            <button
              className="sync-btn"
              onClick={() => openLink('https://tbeezy.github.io/ynotvdoc/')}
              style={{ maxWidth: '140px' }}
            >
              {i18n.t('settings:about.documentation')}
            </button>
            <button
              className="sync-btn"
              onClick={() => openLink('https://discord.com/invite/e5eGa5QETB')}
              style={{ maxWidth: '140px' }}
            >
              Discord
            </button>
          </div>

          <div className="about-section" style={{ marginTop: '24px', borderTop: '1px solid var(--surface-border)', paddingTop: '24px' }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: '1rem' }}>yt-dlp</h4>
            <p style={{ margin: '0 0 16px 0', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              {i18n.t('settings:about.ytdlpDescription')}
            </p>

            <div className="about-row" style={{ marginBottom: '8px' }}>
              <span className="about-label">{i18n.t('settings:about.ytdlpPath')}</span>
              <span
                className="about-value"
                style={{ wordBreak: 'break-all', fontSize: '0.8125rem' }}
              >
                {ytdlp === null
                  ? i18n.t('settings:about.loading')
                  : (ytdlp.path || i18n.t('settings:about.ytdlpNotInstalled'))}
              </span>
            </div>

            <div className="about-row" style={{ marginBottom: '16px' }}>
              <span className="about-label">{i18n.t('settings:about.version')}</span>
              <span className="about-value">
                {ytdlp === null
                  ? i18n.t('settings:about.loading')
                  : (ytdlp.version || i18n.t('settings:about.ytdlpNotInstalled'))}
              </span>
            </div>

            <button
              className="sync-btn"
              onClick={handleUpdateYtdlp}
              disabled={updatingYtdlp}
              style={{ maxWidth: '200px' }}
            >
              {updatingYtdlp ? i18n.t('settings:about.ytdlpChecking') : i18n.t('settings:about.ytdlpUpdate')}
            </button>

            {ytdlpResult && (
              <p style={{ margin: '12px 0 0 0', color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                {ytdlpResult}
              </p>
            )}
          </div>

          <div className="about-section" style={{ marginTop: '24px', borderTop: '1px solid var(--surface-border)', paddingTop: '24px' }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: '1rem' }}>{i18n.t('settings:about.updatesTitle')}</h4>
            <p style={{ margin: '0 0 16px 0', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              {i18n.t('settings:about.updatesDescription')}
            </p>

            <button
              className="sync-btn"
              onClick={handleCheckForUpdates}
              style={{ maxWidth: '200px' }}
            >
              {i18n.t('settings:about.checkForUpdates')}
            </button>
          </div>

          <div className="about-section" style={{ marginTop: '24px', borderTop: '1px solid var(--surface-border)', paddingTop: '24px' }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: '1rem' }}>{i18n.t('settings:about.changelog')}</h4>
            <div
              className="changelog-content"
              style={{
                margin: '0',
                padding: '12px',
                backgroundColor: 'var(--bg-tertiary)',
                borderRadius: '6px',
                border: '1px solid var(--surface-border)',
                color: 'var(--text-primary)',
                fontSize: '0.8125rem',
                lineHeight: '1.5',
                maxHeight: '300px',
                overflow: 'auto'
              }}
            >
              <ReactMarkdown>{changelogContent}</ReactMarkdown>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
