import { useState } from 'react';
import './UsernamePasswordForm.css';

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
  if (!value || !value.trim()) return 'Password is required';
  if (value.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  return null;
}

export interface UsernamePasswordFormProps {
  onSubmit: (username: string, password: string) => void;
  onBack?: () => void;
  loading?: boolean;
  error?: string | null;
  containerClassName?: string;
  cardClassName?: string;
  /** Retained for the call sites; the card now follows the document theme. */
  variant?: 'light' | 'dark';
}

export function UsernamePasswordForm({
  onSubmit,
  onBack,
  loading = false,
  error = null,
  containerClassName,
  cardClassName,
}: UsernamePasswordFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setUsernameError(null);
    setPasswordError(null);
    const userErr = validateUsername(username);
    const passErr = validatePassword(password);
    if (userErr) { setUsernameError(userErr); return; }
    if (passErr) { setPasswordError(passErr); return; }
    onSubmit(username.trim(), password);
  };

  const isEmpty = !username.trim() || !password.trim();
  const submitDisabled = loading || isEmpty || !!usernameError || !!passwordError;

  const containerClass = containerClassName ? `username-password-form-container ${containerClassName}` : 'username-password-form-container';
  const cardClass = cardClassName ? `username-password-form-card ${cardClassName}` : 'username-password-form-card';

  return (
    <div className={containerClass}>
      <div className={cardClass}>
        <h2>Sign in</h2>
        <form onSubmit={handleSubmit}>
          <div className="username-password-form-fields">
            <div>
              <label htmlFor="username">
                Username <span className="username-password-form-required">*</span>
              </label>
              <input
                id="username"
                type="text"
                className={usernameError ? 'is-invalid' : undefined}
                value={username}
                onChange={(e) => { setUsername(e.target.value); setUsernameError(null); }}
                onBlur={() => setUsernameError(validateUsername(username))}
                placeholder="Letters, numbers, underscores only"
                disabled={loading}
                autoComplete="username"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              {usernameError && <p className="field-error">{usernameError}</p>}
            </div>
            <div>
              <label htmlFor="password">
                Password <span className="username-password-form-required">*</span>
              </label>
              <input
                id="password"
                type="password"
                className={passwordError ? 'is-invalid' : undefined}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setPasswordError(null); }}
                onBlur={() => setPasswordError(validatePassword(password))}
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                disabled={loading}
                autoComplete="current-password"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              {passwordError && <p className="field-error">{passwordError}</p>}
            </div>
            <div className="username-password-form-actions">
              <div className="username-password-form-buttons">
                {onBack && (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={onBack}
                    disabled={loading}
                  >
                    Back
                  </button>
                )}
                <button type="submit" className="button button-primary" disabled={submitDisabled}>
                  {loading ? 'Signing In...' : 'Sign In'}
                </button>
              </div>
              {error && !usernameError && !passwordError && (
                <p className="username-password-form-error">{error}</p>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
