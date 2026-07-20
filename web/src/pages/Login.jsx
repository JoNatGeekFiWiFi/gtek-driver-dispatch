import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, saveSession } from '../api.js';

export default function Login() {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ orgName: '', name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const { token, user } = await api(path, { method: 'POST', body: form });
      saveSession(token, user);
      navigate(user.role === 'driver' ? '/driver' : '/dispatch');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <img src="/icon.svg" alt="" width="40" height="40" />
          <h1>Dispatch Route Builder</h1>
        </div>
        <p className="muted">
          {mode === 'login'
            ? 'Sign in as a dispatcher or driver.'
            : 'Create your company workspace. You will be its first dispatcher.'}
        </p>

        {mode === 'register' && (
          <>
            <label>Company name
              <input value={form.orgName} onChange={set('orgName')} placeholder="Acme Logistics" required />
            </label>
            <label>Your name
              <input value={form.name} onChange={set('name')} placeholder="Jon Fernandez" required />
            </label>
          </>
        )}
        <label>Email
          <input type="email" value={form.email} onChange={set('email')} placeholder="you@company.com" required />
        </label>
        <label>Password
          <input type="password" value={form.password} onChange={set('password')} minLength={8} required />
        </label>

        {error && <div className="error">{error}</div>}

        <button className="btn primary" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create workspace'}
        </button>
        <button
          type="button"
          className="btn link"
          onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
        >
          {mode === 'login' ? 'New company? Create a workspace' : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}
