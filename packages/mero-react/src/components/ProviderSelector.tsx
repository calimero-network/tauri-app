import React from 'react';
import type { Provider } from '../client/types';

const DARK = {
  bgCard: '#1e293b',
  bgButton: '#0f172a',
  text: '#f1f5f9',
  textMuted: '#94a3b8',
  border: '#334155',
  accent: '#818cf8',
};

export interface ProviderSelectorProps {
  providers: Provider[];
  onProviderSelect: (provider: Provider) => void;
  loading: boolean;
  error?: string | null;
  containerClassName?: string;
  cardClassName?: string;
  variant?: 'light' | 'dark';
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  near_wallet: 'NEAR Wallet',
  user_password: 'Username/Password',
  username_password: 'Username/Password',
};

export function ProviderSelector({
  providers,
  onProviderSelect,
  loading,
  error,
  containerClassName,
  cardClassName,
  variant = 'light',
}: ProviderSelectorProps) {
  const isDark = variant === 'dark';

  const containerStyle: React.CSSProperties = {
    maxWidth: 480,
    width: '100%',
  };

  const cardStyle: React.CSSProperties = isDark
    ? {
        background: DARK.bgCard,
        borderRadius: '16px',
        padding: '32px',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
        border: `1px solid ${DARK.border}`,
      }
    : {
        background: 'var(--bg-secondary)',
        borderRadius: '12px',
        padding: '32px',
        boxShadow: 'var(--shadow-lg)',
        border: '1px solid var(--border-color)',
      };

  const containerClass = containerClassName ? `provider-selector ${containerClassName}` : 'provider-selector';

  if (loading) {
    return (
      <div className={containerClass} style={containerStyle}>
        <div className="provider-selector-loading" style={{ color: isDark ? DARK.textMuted : 'var(--text-secondary)' }}>Loading...</div>
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className={containerClass} style={containerStyle}>
        <div className={cardClassName ? `provider-selector-card ${cardClassName}` : 'provider-selector-card'} style={{ ...cardStyle, textAlign: 'center' }}>
          <h3 style={{ marginTop: 0, color: isDark ? DARK.text : 'var(--text-primary)' }}>No providers available</h3>
          <p style={{ color: isDark ? DARK.textMuted : 'var(--text-secondary)' }}>
            No authentication providers are configured on this node.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={containerClass} style={containerStyle}>
      <div className={cardClassName ? `provider-selector-card ${cardClassName}` : 'provider-selector-card'} style={cardStyle}>
        <h2 style={{
          marginTop: 0,
          marginBottom: '8px',
          fontSize: '18px',
          fontWeight: 600,
          color: isDark ? DARK.text : 'var(--text-primary)',
        }}>
          Sign in
        </h2>
        <p style={{
          margin: '0 0 24px 0',
          fontSize: '13px',
          color: isDark ? DARK.textMuted : 'var(--text-secondary)',
        }}>
          Choose an authentication method
        </p>

        {error && (
          <div
            style={{
              padding: '12px 16px',
              background: 'rgba(248, 113, 113, 0.15)',
              color: isDark ? '#f87171' : 'var(--error)',
              borderRadius: '8px',
              fontSize: '14px',
              marginBottom: '20px',
              border: '1px solid #f87171',
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {providers.map((provider) => (
            <button
              key={provider.name}
              onClick={() => onProviderSelect(provider)}
              style={{
                padding: '14px 18px',
                background: isDark ? DARK.bgButton : 'var(--bg-tertiary)',
                border: `1px solid ${isDark ? DARK.border : 'var(--border-color)'}`,
                borderRadius: '10px',
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'all 0.15s',
                color: isDark ? DARK.text : 'var(--text-primary)',
              }}
              onMouseEnter={(e) => {
                if (isDark) {
                  e.currentTarget.style.background = DARK.bgCard;
                  e.currentTarget.style.borderColor = DARK.accent;
                  e.currentTarget.style.boxShadow = '0 0 0 2px rgba(129, 140, 248, 0.2)';
                } else {
                  e.currentTarget.style.background = 'var(--bg-secondary)';
                  e.currentTarget.style.borderColor = 'var(--accent-primary)';
                  e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-light)';
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = isDark ? DARK.bgButton : 'var(--bg-tertiary)';
                e.currentTarget.style.borderColor = isDark ? DARK.border : 'var(--border-color)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ fontWeight: 600, fontSize: '15px' }}>
                  {PROVIDER_DISPLAY_NAMES[provider.name] ||
                    provider.description ||
                    provider.name}
                </div>
                {provider.name !== provider.description && (
                  <div style={{ fontSize: '12px', color: isDark ? DARK.textMuted : 'var(--text-tertiary)' }}>{provider.name}</div>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

