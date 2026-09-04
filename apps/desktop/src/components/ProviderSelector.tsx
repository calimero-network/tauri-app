import type { Provider } from '../lib/mero-client';
import './ProviderSelector.css';

export interface ProviderSelectorProps {
  providers: Provider[];
  onProviderSelect: (provider: Provider) => void;
  loading: boolean;
  error?: string | null;
  containerClassName?: string;
  cardClassName?: string;
  /** Retained for the call sites; the card now follows the document theme. */
  variant?: 'light' | 'dark';
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
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
}: ProviderSelectorProps) {
  const containerClass = containerClassName ? `provider-selector ${containerClassName}` : 'provider-selector';
  const cardClass = cardClassName ? `provider-selector-card ${cardClassName}` : 'provider-selector-card';

  if (loading) {
    return (
      <div className={containerClass}>
        <div className="provider-selector-loading">Loading...</div>
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className={containerClass}>
        <div className={`${cardClass} provider-selector-empty`}>
          <h3>No providers available</h3>
          <p>No authentication providers are configured on this node.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={containerClass}>
      <div className={cardClass}>
        <h2>Sign in</h2>
        <p className="provider-selector-subtitle">Choose an authentication method</p>

        {error && <div className="error-message">{error}</div>}

        <div className="provider-selector-list">
          {providers.map((provider) => (
            <button
              key={provider.name}
              className="provider-selector-option"
              onClick={() => onProviderSelect(provider)}
            >
              <div className="provider-selector-option-name">
                {PROVIDER_DISPLAY_NAMES[provider.name] ||
                  provider.description ||
                  provider.name}
              </div>
              {provider.name !== provider.description && (
                <div className="provider-selector-option-id">{provider.name}</div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
