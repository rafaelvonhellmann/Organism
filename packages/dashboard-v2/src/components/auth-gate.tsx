'use client';

import { useState, useEffect, useCallback } from 'react';

interface AuthState {
  loading: boolean;
  authRequired: boolean;
  authenticated: boolean;
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    loading: true,
    authRequired: false,
    authenticated: false,
  });
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch('/api/auth');
      const data = await res.json();
      setState({
        loading: false,
        authRequired: data.authRequired,
        authenticated: data.authenticated,
      });
    } catch {
      setError('Unable to verify dashboard access.');
      setState({ loading: false, authRequired: true, authenticated: false });
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });

      if (res.ok) {
        setState(prev => ({ ...prev, authenticated: true }));
      } else {
        setError('Invalid token');
      }
    } catch {
      setError('Connection failed');
    } finally {
      setSubmitting(false);
    }
  };

  // Loading state
  if (state.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <div className="text-zinc-500 text-sm">Loading...</div>
      </div>
    );
  }

  // No auth required or already authenticated
  if (!state.authRequired || state.authenticated) {
    return <>{children}</>;
  }

  // Show login
  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 p-4">
      <div className="w-full max-w-sm">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 shadow-xl">
          <h1 className="text-lg font-semibold text-zinc-100 mb-1">Organism Dashboard</h1>
          <p className="text-sm text-zinc-400 mb-6">Enter your access token to continue.</p>

          <form onSubmit={handleLogin}>
            <label htmlFor="auth-token" className="block text-xs font-medium text-zinc-400 mb-1.5">
              Access Token
            </label>
            <input
              id="auth-token"
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="Paste your DASHBOARD_AUTH_TOKEN"
              autoFocus
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-md text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
            />

            {error && (
              <p className="mt-2 text-sm text-red-400">{error}</p>
            )}

            <button
              type="submit"
              disabled={submitting || !token.trim()}
              className="mt-4 w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium rounded-md transition-colors"
            >
              {submitting ? 'Verifying...' : 'Login'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
