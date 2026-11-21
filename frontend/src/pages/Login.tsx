import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { authApi } from '../services/api';
import { Eye, EyeOff } from 'lucide-react';
import { AuthShell, AuthHeading, AuthNotice, AuthTrustLine } from '../components/auth/AuthShell';
import { useToast } from '../components/Toast';
import { clearDemoEnded, isDemoSite, readDemoEnded } from '../demo/demoMode';

/* ================================================================== */

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { toast } = useToast();

  // Post-login destination. Only internal paths are honored (no open redirect).
  const nextParam = params.get('next');
  const safeNext = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//')
    ? nextParam
    : '/dashboard';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // §8.5 — single sign-on, offered only when the address's domain is
  // configured for it. The lookup answers identically for a known and an
  // unknown address, so it cannot be used to enumerate users.
  const [sso, setSso] = useState<{ consultingFirmId: string; displayName: string } | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState(readDemoEnded);
  useEffect(() => clearDemoEnded(), []);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleResendVerification = async () => {
    if (!email) {
      toast('Enter your email above first.', 'warning');
      return;
    }
    try {
      await authApi.resendVerification(email);
      toast('Verification email re-sent. Check your inbox.', 'success');
    } catch {
      toast('Could not resend right now. Try again later.', 'error');
    }
  };

  const discoverSso = async (address: string) => {
    if (!address.includes('@')) { setSso(null); return; }
    try {
      const res = await authApi.discoverSso(address);
      setSso(res?.data?.available ? { consultingFirmId: res.data.consultingFirmId, displayName: res.data.displayName } : null);
    } catch {
      setSso(null);
    }
  };

  const startSso = async () => {
    if (!sso) return;
    try {
      const res = await authApi.startSso(sso.consultingFirmId, safeNext);
      window.location.href = res.data.authorizationUrl;
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Single sign-on could not be started.');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setErrorCode(null);
    setLoading(true);
    try {
      const res = await authApi.login(email, password);
      if (!res?.success || !res?.data?.token) {
        setError('Invalid credentials');
        setLoading(false);
        return;
      }
      const { token, user, firm } = res.data;
      login(token, user, firm);
      navigate(safeNext);
    } catch (err: any) {
      const code = err?.response?.data?.code;
      setErrorCode(code ?? null);
      if (code === 'EMAIL_NOT_VERIFIED') {
        setError('Verify your email before signing in. Use the link we sent, or resend below.');
      } else if (code === 'AGREEMENT_REQUIRED') {
        // Gate-2: forward to the accept-agreements page with the scoped completionToken.
        const data = err?.response?.data;
        navigate('/accept-agreements', {
          state: {
            completionToken: data?.completionToken,
            email,
          },
        });
        return;
      } else if (code === 'MFA_REQUIRED') {
        // Gate-3: forward to the MFA challenge with the scoped mfaChallengeToken.
        const data = err?.response?.data;
        navigate('/mfa-challenge', {
          state: { mfaChallengeToken: data?.mfaChallengeToken, email, next: safeNext },
        });
        return;
      } else if (code === 'SSO_REQUIRED') {
        // §8.5 — the firm requires single sign-on. Point at the button rather
        // than repeating a password failure the user cannot fix.
        setError('Your organization requires single sign-on. Use the button below.');
        void discoverSso(email);
      } else {
        setError(err?.response?.data?.error || 'Login failed');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      aside={<LoginAside />}
      headerRight={!isDemoSite ? (
        <Link to="/register" className="v3-pill v3-pill-light v3-pill-sm">Start free trial</Link>
      ) : undefined}
      footer={<AuthTrustLine />}
    >
      <AuthHeading title="Welcome back">Sign in to your Bytesgov account.</AuthHeading>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="label" htmlFor="login-email">Email address</label>
          <input
            id="login-email"
            type="email"
            className="input"
            placeholder="you@firm.com"
            value={email}
            onBlur={(e) => void discoverSso(e.target.value.trim())}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div>
          <div className="flex items-baseline justify-between gap-3">
            <label className="label" htmlFor="login-password">Password</label>
            {!isDemoSite && (
              <Link to="/forgot-password" className="text-[13px] underline underline-offset-2" style={{ color: 'var(--text-muted)' }}>
                Forgot your password?
              </Link>
            )}
          </div>
          <div className="relative">
            <input
              id="login-password"
              type={showPw ? 'text' : 'password'}
              className="input pr-10"
              placeholder="••••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button
              type="button"
              onClick={() => setShowPw(!showPw)}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
              style={{ color: 'var(--text-muted)' }}
            >
              {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {error && (
          <AuthNotice>
            <span>{error}</span>
            {errorCode === 'EMAIL_NOT_VERIFIED' && (
              <button
                type="button"
                onClick={handleResendVerification}
                className="mt-2 block text-[13px] font-semibold underline"
              >
                Resend verification email
              </button>
            )}
          </AuthNotice>
        )}

        <button type="submit" disabled={loading} className="btn-primary w-full">
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Signing in...
            </span>
          ) : 'Sign in'}
        </button>
      </form>

      {sso && (
        <button type="button" onClick={() => void startSso()} className="btn-secondary w-full mt-3">
          {sso.displayName}
        </button>
      )}

      {!isDemoSite && (
        <p className="mt-7 pt-6 text-sm" style={{ borderTop: '1px solid var(--line)', color: 'var(--text-muted)' }}>
          New to Bytesgov?{' '}
          <Link to="/register" className="font-semibold underline underline-offset-2" style={{ color: 'var(--text)' }}>
            Register your firm
          </Link>
        </p>
      )}
    </AuthShell>
  );
}

/** The one idea beside the sign-in form. */
function LoginAside() {
  return (
    <>
      <div>
        <h2 className="v3-h1" style={{ color: '#f0f1fa' }}>Know your odds before you bid.</h2>
        <p className="mt-5 text-[17px] leading-[26px] max-w-md" style={{ color: 'rgba(240, 241, 250, 0.72)' }}>
          Calibrated win probability, compliance matrices and proposal drafts for every contract you pursue.
        </p>
      </div>
      <ul className="grid grid-cols-3 gap-6 pt-6" style={{ borderTop: '1px solid rgba(240, 241, 250, 0.12)' }}>
        {[
          ['Win probability', 'Scored on eight factors, with the reasoning shown'],
          ['Compliance', 'A compliance matrix built from each solicitation'],
          ['Audit trail', 'Every agent step written to your audit trail'],
        ].map(([t, d]) => (
          <li key={t}>
            <p className="text-sm font-semibold" style={{ color: '#f0f1fa' }}>{t}</p>
            <p className="mt-1 text-[13px] leading-[19px]" style={{ color: 'rgba(240, 241, 250, 0.6)' }}>{d}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
