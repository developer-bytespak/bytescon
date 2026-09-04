import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { authApi } from '../services/api';
import { Eye, EyeOff, Shield, TrendingUp, Award } from 'lucide-react';
import { useToast } from '../components/Toast';

/* ------------------------------------------------------------------ */
/*  Inline brand-mark SVG — Bytes Platform brand mark                       */
/* ------------------------------------------------------------------ */
function BrandMark({ size = 64, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="canopyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#7b8fff" />
          <stop offset="100%" stopColor="#5b74ff" />
        </linearGradient>
      </defs>
      <path d="M12 6 L30 6 L48 32 L30 58 L12 58 L27 32 Z" fill="url(#canopyGrad)" />
      <path d="M37 12 L45 12 L59 32 L45 52 L37 52 L51 32 Z" fill="#7b8fff" opacity="0.5" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Trust pillars shown on brand panel                                 */
/* ------------------------------------------------------------------ */
const pillars = [
  { icon: Shield,     label: 'Secure by Design', sub: 'Tenant-Isolated & Audited' },
  { icon: TrendingUp, label: 'AI-Powered',    sub: '8-Factor Win Scoring' },
  { icon: Award,      label: 'Proven Results',sub: 'Federal Pipeline Intel' },
];

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
  const [error, setError] = useState('');
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
    <div className="min-h-screen flex" style={{ background: '#0b0b0f' }}>

      {/* ---- Brand panel (desktop) ---- */}
      <div
        className="hidden lg:flex flex-col justify-between w-1/2 p-14 relative overflow-hidden"
        style={{ background: '#0b0b0f', borderRight: '1px solid var(--line)' }}
      >
        <img
          src="/landing/hero.jpg"
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          style={{ opacity: 0.6, objectPosition: '62% 50%' }}
        />
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: 'linear-gradient(180deg, rgba(11,11,15,0.6) 0%, rgba(11,11,15,0.2) 40%, rgba(11,11,15,0.94) 100%)' }}
        />

        <Link to="/" className="relative z-10 flex items-center gap-3 w-fit">
          <BrandMark size={34} />
          <span className="font-display text-xl" style={{ color: 'var(--text)' }}>Bytescon</span>
        </Link>

        <div className="relative z-10">
          <h1 className="font-display text-5xl leading-[1.05]" style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}>
            Know your odds<br />
            <em className="font-light" style={{ color: 'var(--gold-2)' }}>before you bid.</em>
          </h1>
          <p className="mt-5 text-base leading-relaxed max-w-sm" style={{ color: 'var(--text-2)' }}>
            Calibrated win probability, compliance matrices and proposal drafts for every client you serve.
          </p>
          <div className="mt-8 flex flex-wrap gap-2">
            {pillars.map(({ icon: Icon, label }) => (
              <span
                key={label}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs"
                style={{ background: 'rgba(11,11,15,0.65)', border: '1px solid var(--line-strong)', color: 'var(--text-2)' }}
              >
                <Icon className="w-3.5 h-3.5" style={{ color: 'var(--accent-2)' }} />
                {label}
              </span>
            ))}
          </div>
        </div>

        <p className="relative z-10 text-xs" style={{ color: 'var(--text-muted)' }}>
          Tenant-isolated, encrypted at rest, audited. <Link to="/trust" className="underline hover:text-slate-200">Trust &amp; Security</Link>
        </p>
      </div>

      {/* ============================================================ */}
      {/* RIGHT PANEL — Login Form                                     */}
      {/* ============================================================ */}
      <div className="flex flex-1 flex-col justify-center items-center p-8"
        style={{ background: '#0b0b0f' }}>

        {/* Mobile-only logo */}
        <div className="flex lg:hidden flex-col items-center mb-8">
          <BrandMark size={48} />
          <p className="text-sm font-bold tracking-widest uppercase text-cyan-400 mt-3">Bytescon</p>
          <p className="text-xs text-slate-500 mt-0.5">GovCon Advisory Intelligence</p>
        </div>

        <div className="w-full max-w-sm">
          {/* Form heading */}
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-slate-100 mb-1">Welcome back</h2>
            <p className="text-sm text-slate-500">Sign in to your advisory platform</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="label">Email Address</label>
              <input
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
              <label className="label">Password</label>
              <div className="relative">
                <input
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
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-cyan-400 transition-colors"
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="text-sm rounded-lg px-4 py-3"
                style={{ background: 'rgba(127,29,29,0.4)', border: '1px solid rgba(185,28,28,0.5)', color: '#fca5a5' }}
              >
                <div className="flex items-start gap-2">
                  <span className="text-red-400">✕</span>
                  <span>{error}</span>
                </div>
                {errorCode === 'EMAIL_NOT_VERIFIED' && (
                  <button
                    type="button"
                    onClick={handleResendVerification}
                    className="mt-2 text-xs font-semibold underline"
                    style={{ color: '#7b8fff' }}
                  >
                    Resend verification email
                  </button>
                )}
              </div>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full py-3 text-sm">
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Authenticating...
                </span>
              ) : 'Sign In →'}
            </button>
          </form>

          {sso && (
            <button
              type="button"
              onClick={() => void startSso()}
              className="mt-3 w-full py-3 text-sm rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
            >
              {sso.displayName}
            </button>
          )}

          <div className="mt-4 text-center">
            <Link
              to="/forgot-password"
              className="text-xs text-slate-500 hover:text-cyan-400 transition-colors"
            >
              Forgot your password?
            </Link>
          </div>

          <div
            className="mt-4 pt-5 text-center"
            style={{ borderTop: '1px solid #2b2933' }}
          >
            <p className="text-sm text-slate-500">
              New consulting firm?{' '}
              <Link
                to="/register"
                className="font-semibold transition-colors"
                style={{ color: '#5b74ff' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = '#7b8fff')}
                onMouseLeave={(e) => (e.currentTarget.style.color = '#5b74ff')}
              >
                Register your firm →
              </Link>
            </p>
          </div>

          {/* Bottom badge */}
          <div className="mt-8 flex items-center justify-center gap-2">
            <div
              className="flex items-center gap-1.5 text-[10px] px-3 py-1 rounded-full"
              style={{ background: 'rgba(91,116,255,0.08)', border: '1px solid rgba(91,116,255,0.2)', color: 'rgba(91,116,255,0.7)' }}
            >
              <span>★</span>
              <span>Veteran Owned & Operated · Secured Platform</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
