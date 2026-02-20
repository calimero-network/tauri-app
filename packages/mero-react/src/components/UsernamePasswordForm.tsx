import React, { useState } from 'react';

// Username validation: alphanumeric + underscore only, no spaces
const USERNAME_REGEX = /^[a-zA-Z0-9_]+$/;
const MIN_PASSWORD_LENGTH = 8;

function validateUsername(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Username is required';
  if (value !== trimmed) return 'Username cannot contain leading or trailing spaces';
  if (/\s/.test(value)) return 'Username cannot contain spaces';
  if (!USERNAME_REGEX.test(trimmed)) return 'Username can only contain letters, numbers, and underscores';
  return null;
}

function validatePassword(value: string): string | null {
  if (!value) return 'Password is required';
  if (value.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  return null;
}

const DARK = {
  bgCard: '#18181b',
  bgInput: '#27272a',
  bgButton: '#27272a',
  bgButtonPrimary: '#a5ff11',
  text: '#f4f4f5',
  textMuted: '#a1a1aa',
  border: '#27272a',
  error: '#ef4444',
};

export interface UsernamePasswordFormProps {
  onSubmit: (username: string, password: string) => void;
  onBack?: () => void;
  loading?: boolean;
  error?: string | null;
  containerClassName?: string;
  cardClassName?: string;
  variant?: 'light' | 'dark';
}

export function UsernamePasswordForm({
  onSubmit,
  onBack,
  loading = false,
  error = null,
  containerClassName,
  cardClassName,
  variant = 'light',
}: UsernamePasswordFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const isDark = variant === 'dark';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setUsernameError(null);
    setPasswordError(null);

    const userErr = validateUsername(username);
    const passErr = validatePassword(password);
    if (userErr) {
      setUsernameError(userErr);
      return;
    }
    if (passErr) {
      setPasswordError(passErr);
      return;
    }

    onSubmit(username.trim(), password);
  };

  const displayError = usernameError || passwordError || error;

  const containerStyle: React.CSSProperties = {
    maxWidth: 420,
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

  const containerClass = containerClassName ? `username-password-form-container ${containerClassName}` : 'username-password-form-container';

  return (
    <div className={containerClass} style={containerStyle}>
      <div className={cardClassName ? `username-password-form-card ${cardClassName}` : 'username-password-form-card'} style={cardStyle}>
        <h2 style={{
          marginTop: 0,
          marginBottom: '24px',
          fontSize: '18px',
          fontWeight: 600,
          color: isDark ? DARK.text : 'var(--text-primary)',
        }}>
          Sign in
        </h2>

        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {displayError && (
              <div
                style={{
                  padding: '12px 16px',
                  background: 'rgba(248, 113, 113, 0.15)',
                  color: isDark ? DARK.error : 'var(--error)',
                  borderRadius: '8px',
                  fontSize: '14px',
                  border: `1px solid ${isDark ? DARK.error : 'var(--error)'}`,
                }}
              >
                {displayError}
              </div>
            )}

            <div>
              <label
                htmlFor="username"
                style={{
                  display: 'block',
                  marginBottom: '8px',
                  fontSize: '13px',
                  fontWeight: 500,
                  color: isDark ? '#e2e8f0' : 'var(--text-primary)',
                }}
              >
                Username <span style={{ color: isDark ? DARK.error : 'var(--error)' }}>*</span>
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setUsernameError(null);
                }}
                onBlur={() => setUsernameError(validateUsername(username))}
                placeholder="Letters, numbers, underscores only"
                disabled={loading}
                autoComplete="username"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                style={{
                  width: '100%',
                  padding: '14px 16px',
                  border: `1px solid ${usernameError ? (isDark ? DARK.error : 'var(--error)') : isDark ? DARK.border : 'var(--border-color)'}`,
                  borderRadius: '10px',
                  fontSize: '15px',
                  boxSizing: 'border-box',
                  background: isDark ? DARK.bgInput : 'var(--bg-tertiary)',
                  color: isDark ? DARK.text : 'var(--text-primary)',
                }}
              />
              {usernameError && (
                <p style={{ margin: '6px 0 0 0', fontSize: '12px', color: isDark ? DARK.error : 'var(--error)' }}>{usernameError}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="password"
                style={{
                  display: 'block',
                  marginBottom: '8px',
                  fontSize: '13px',
                  fontWeight: 500,
                  color: isDark ? '#e2e8f0' : 'var(--text-primary)',
                }}
              >
                Password <span style={{ color: isDark ? DARK.error : 'var(--error)' }}>*</span>
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPasswordError(null);
                }}
                onBlur={() => setPasswordError(validatePassword(password))}
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                disabled={loading}
                autoComplete="current-password"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                style={{
                  width: '100%',
                  padding: '14px 16px',
                  border: `1px solid ${passwordError ? (isDark ? DARK.error : 'var(--error)') : isDark ? DARK.border : 'var(--border-color)'}`,
                  borderRadius: '10px',
                  fontSize: '15px',
                  boxSizing: 'border-box',
                  background: isDark ? DARK.bgInput : 'var(--bg-tertiary)',
                  color: isDark ? DARK.text : 'var(--text-primary)',
                }}
              />
              {passwordError && (
                <p style={{ margin: '6px 0 0 0', fontSize: '12px', color: isDark ? DARK.error : 'var(--error)' }}>{passwordError}</p>
              )}
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '12px',
                marginTop: '8px',
              }}
            >
              {onBack && (
                <button
                  type="button"
                  onClick={onBack}
                  disabled={loading}
                  style={{
                    padding: '12px 24px',
                    background: isDark ? DARK.bgButton : 'var(--bg-tertiary)',
                    color: isDark ? DARK.text : 'var(--text-primary)',
                    border: `1px solid ${isDark ? '#475569' : 'var(--border-color)'}`,
                    borderRadius: '10px',
                    fontSize: '15px',
                    fontWeight: 500,
                    cursor: loading ? 'not-allowed' : 'pointer',
                    opacity: loading ? 0.6 : 1,
                  }}
                >
                  Back
                </button>
              )}
              <button
                type="submit"
                disabled={loading || !!validateUsername(username) || !!validatePassword(password)}
                style={{
                  padding: '12px 24px',
                  background: loading || !!validateUsername(username) || !!validatePassword(password)
                    ? (isDark ? DARK.bgButton : 'var(--bg-tertiary)')
                    : (isDark ? DARK.bgButtonPrimary : 'var(--accent-primary)'),
                  color: loading || !!validateUsername(username) || !!validatePassword(password)
                    ? (isDark ? DARK.textMuted : 'var(--text-tertiary)')
                    : (isDark ? '#09090b' : '#09090b'),
                  border: 'none',
                  borderRadius: '10px',
                  fontSize: '15px',
                  fontWeight: 600,
                  cursor: loading || !!validateUsername(username) || !!validatePassword(password) ? 'not-allowed' : 'pointer',
                  opacity: loading ? 0.6 : 1,
                }}
              >
                {loading ? 'Signing In...' : 'Sign In'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

