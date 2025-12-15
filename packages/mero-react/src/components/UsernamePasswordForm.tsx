import React, { useState } from 'react';

export interface UsernamePasswordFormProps {
  onSubmit: (username: string, password: string) => void;
  onBack?: () => void;
  loading?: boolean;
  error?: string | null;
}

export function UsernamePasswordForm({
  onSubmit,
  onBack,
  loading = false,
  error = null,
}: UsernamePasswordFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    // Basic validation
    if (!username.trim()) {
      setValidationError('Username is required');
      return;
    }

    if (!password.trim()) {
      setValidationError('Password is required');
      return;
    }

    if (password.length < 1) {
      setValidationError('Password must be at least 1 character long');
      return;
    }

    onSubmit(username.trim(), password);
  };

  const displayError = validationError || error;

  return (
    <div
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        maxWidth: 420,
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
          Sign In
        </h2>

        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {displayError && (
              <div
                style={{
                  padding: '12px',
                  background: '#ffebee',
                  color: '#c62828',
                  borderRadius: '4px',
                  fontSize: '14px',
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
                  fontSize: '14px',
                  fontWeight: 500,
                }}
              >
                Username <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your username"
                disabled={loading}
                autoComplete="username"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1px solid #ccc',
                  borderRadius: '4px',
                  fontSize: '14px',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div>
              <label
                htmlFor="password"
                style={{
                  display: 'block',
                  marginBottom: '8px',
                  fontSize: '14px',
                  fontWeight: 500,
                }}
              >
                Password <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                disabled={loading}
                autoComplete="current-password"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1px solid #ccc',
                  borderRadius: '4px',
                  fontSize: '14px',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '8px',
                marginTop: '8px',
              }}
            >
              {onBack && (
                <button
                  type="button"
                  onClick={onBack}
                  disabled={loading}
                  style={{
                    padding: '10px 20px',
                    background: '#f0f0f0',
                    color: '#333',
                    border: '1px solid #ccc',
                    borderRadius: '4px',
                    fontSize: '14px',
                    cursor: loading ? 'not-allowed' : 'pointer',
                    opacity: loading ? 0.6 : 1,
                  }}
                >
                  Back
                </button>
              )}
              <button
                type="submit"
                disabled={loading || !username.trim() || !password.trim()}
                style={{
                  padding: '10px 20px',
                  background: loading || !username.trim() || !password.trim() ? '#ccc' : '#2196f3',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: loading || !username.trim() || !password.trim() ? 'not-allowed' : 'pointer',
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

