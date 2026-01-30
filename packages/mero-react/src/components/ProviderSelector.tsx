import React from 'react';
import type { Provider } from '../client/types';

export interface ProviderSelectorProps {
  providers: Provider[];
  onProviderSelect: (provider: Provider) => void;
  loading: boolean;
  error?: string | null;
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
}: ProviderSelectorProps) {
  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    maxWidth: 480,
    width: '100%',
    padding: '0 24px',
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--bg-secondary)',
    borderRadius: '12px',
    padding: '32px',
    boxShadow: 'var(--shadow-lg)',
    border: '1px solid var(--border-color)',
  };

  if (loading) {
    return (
      <div style={{ ...containerStyle, textAlign: 'center' }}>
        <div style={{ color: 'var(--text-secondary)' }}>Loading...</div>
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div style={containerStyle}>
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          <h3 style={{ marginTop: 0, color: 'var(--text-primary)' }}>No providers available</h3>
          <p style={{ color: 'var(--text-secondary)' }}>
            No authentication providers are configured on this node.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <h2 style={{
          marginTop: 0,
          marginBottom: '24px',
          fontSize: '22px',
          fontWeight: 600,
          color: 'var(--text-primary)',
        }}>
          Sign In
        </h2>

        {error && (
          <div
            style={{
              padding: '12px 16px',
              background: 'rgba(248, 113, 113, 0.15)',
              color: 'var(--error)',
              borderRadius: '8px',
              fontSize: '14px',
              marginBottom: '20px',
              border: '1px solid var(--error)',
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
                padding: '16px 20px',
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border-color)',
                borderRadius: '12px',
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'all 0.2s',
                color: 'var(--text-primary)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--bg-secondary)';
                e.currentTarget.style.borderColor = 'var(--accent-primary)';
                e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-light)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--bg-tertiary)';
                e.currentTarget.style.borderColor = 'var(--border-color)';
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
                  <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{provider.name}</div>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

