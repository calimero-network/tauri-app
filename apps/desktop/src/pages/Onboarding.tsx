import { useState, useEffect } from "react";
import { checkOnboardingState, getOnboardingMessage, type OnboardingState } from "../utils/onboarding";
import { LoginView } from "@calimero-network/mero-react";
import "./Onboarding.css";

interface OnboardingProps {
  onComplete: () => void;
  onSettings?: () => void;
}

export default function Onboarding({ onComplete, onSettings }: OnboardingProps) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [showLogin, setShowLogin] = useState(false);

  useEffect(() => {
    async function loadState() {
      setLoading(true);
      const onboardingState = await checkOnboardingState();
      setState(onboardingState);
      setLoading(false);
    }
    loadState();
  }, []);

  if (loading || !state) {
    return (
      <div className="onboarding-page">
        <div className="onboarding-content">
          <div className="loading-spinner">Loading...</div>
        </div>
      </div>
    );
  }

  const message = getOnboardingMessage(state);

  // If auth is not available or no providers, show error state
  if (!state.authAvailable || !state.providersAvailable) {
    return (
      <div className="onboarding-page">
        <div className="onboarding-content">
          <div className="onboarding-card error">
            <h1>{message.title}</h1>
            <p>{message.message}</p>
            {state.error && (
              <div className="error-details">
                <strong>Error:</strong> {state.error}
              </div>
            )}
            <div className="onboarding-actions">
              {onSettings && (
                <button onClick={onSettings} className="button button-secondary">
                  Configure Node
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // If first time or no configured providers, show welcome and login
  if (state.isFirstTime || !state.hasConfiguredProviders) {
    if (showLogin) {
      return (
        <div className="onboarding-page">
          <div className="onboarding-content">
            <LoginView
              onSuccess={(accessToken, refreshToken) => {
                console.log("✅ Onboarding login successful");
                onComplete();
              }}
              onError={(error) => {
                console.error("❌ Onboarding login failed:", error);
              }}
            />
          </div>
        </div>
      );
    }

    return (
      <div className="onboarding-page">
        <div className="onboarding-content">
          <div className="onboarding-card">
            <h1>{message.title}</h1>
            <p>{message.message}</p>
            
            {state.providersAvailable && (
              <div className="providers-info">
                <h3>Available Authentication Methods:</h3>
                <ul>
                  <li>Username/Password</li>
                  {/* Providers list could be expanded from state if needed */}
                </ul>
              </div>
            )}

            <div className="onboarding-actions">
              <button
                onClick={() => setShowLogin(true)}
                className="button button-primary"
              >
                {message.action || "Get Started"}
              </button>
              {onSettings && (
                <button onClick={onSettings} className="button button-secondary">
                  Configure Node
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Everything is configured, show login
  return (
    <div className="onboarding-page">
      <div className="onboarding-content">
        <LoginView
          onSuccess={(accessToken, refreshToken) => {
            console.log("✅ Login successful");
            onComplete();
          }}
          onError={(error) => {
            console.error("❌ Login failed:", error);
          }}
        />
      </div>
    </div>
  );
}

