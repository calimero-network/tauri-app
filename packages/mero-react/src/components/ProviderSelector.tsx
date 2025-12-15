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
  if (loading) {
    return (
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          textAlign: 'center',
        }}
      >
        <div>Loading providers...</div>
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          maxWidth: 520,
          width: '100%',
          padding: '0 16px',
        }}
      >
        <div
          style={{
            background: 'white',
            borderRadius: '8px',
            padding: '24px',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
            border: '1px solid #e0e0e0',
            textAlign: 'center',
          }}
        >
          <h3 style={{ marginTop: 0 }}>No providers available</h3>
          <p style={{ color: '#666' }}>
            No authentication providers are configured on this node.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        maxWidth: 520,
        width: '100%',
        padding: '0 16px',
      }}
    >
      <div
        style={{
          background: 'white',
          borderRadius: '8px',
          padding: '24px',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
          border: '1px solid #e0e0e0',
        }}
      >
        <h2 style={{ marginTop: 0, marginBottom: '20px', fontSize: '20px', fontWeight: 600 }}>
          Choose an authentication method
        </h2>

        {error && (
          <div
            style={{
              padding: '12px',
              background: '#ffebee',
              color: '#c62828',
              borderRadius: '4px',
              fontSize: '14px',
              marginBottom: '16px',
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {providers.map((provider) => (
            <button
              key={provider.name}
              onClick={() => onProviderSelect(provider)}
              style={{
                padding: '16px',
                background: 'white',
                border: '1px solid #e0e0e0',
                borderRadius: '4px',
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#f5f5f5';
                e.currentTarget.style.borderColor = '#2196f3';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'white';
                e.currentTarget.style.borderColor = '#e0e0e0';
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ fontWeight: 500, fontSize: '14px' }}>
                  {PROVIDER_DISPLAY_NAMES[provider.name] ||
                    provider.description ||
                    provider.name}
                </div>
                {provider.name !== provider.description && (
                  <div style={{ fontSize: '12px', color: '#666' }}>{provider.name}</div>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

