import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { authApi } from '../services/api';
import { Eye, EyeOff, Star, Shield, TrendingUp, Award } from 'lucide-react';
import { useToast } from '../components/Toast';

/* ------------------------------------------------------------------ */
/*  Inline brand-mark SVG — Bytes Platform brand mark                       */
/* ------------------------------------------------------------------ */
function BrandMark({ size = 64, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="canopyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
      <path d="M12 6 L30 6 L48 32 L30 58 L12 58 L27 32 Z" fill="url(#canopyGrad)" />
      <path d="M37 12 L45 12 L59 32 L45 52 L37 52 L51 32 Z" fill="#22d3ee" opacity="0.5" />
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
    : '/';
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
    <div className="min-h-screen flex" style={{ background: '#061019' }}>

      {/* ============================================================ */}
      {/* LEFT PANEL — Brand Showcase                                  */}
      {/* ============================================================ */}
      <div
        className="hidden lg:flex flex-col justify-between w-1/2 p-14 relative overflow-hidden"
        style={{
          background: 'linear-gradient(145deg, #071120 0%, #0a1a26 40%, #091522 100%)',
          borderRight: '1px solid rgba(6,182,212,0.15)',
        }}
      >
        {/* Ambient gold glow — top right */}
        <div
          className="absolute top-0 right-0 w-96 h-96 pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse at top right, rgba(6,182,212,0.12) 0%, transparent 65%)',
          }}
        />
        {/* Ambient glow — bottom left */}
        <div
          className="absolute bottom-0 left-0 w-80 h-80 pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse at bottom left, rgba(6,182,212,0.07) 0%, transparent 65%)',
          }}
        />

        {/* Top: logo + company name */}
        <div className="relative z-10">
          <div className="flex items-center gap-4 mb-2">
            <BrandMark size={52} />
            <div>
              <p className="text-xs font-bold tracking-[0.15em] uppercase text-cyan-400/70">Bytescon</p>
              <p className="text-[11px] text-slate-500 tracking-widest">GovCon Advisory Intelligence</p>
            </div>
          </div>
          <div className="mt-2">
            <span className="veteran-badge">
              ★ Veteran Owned & Operated
            </span>
          </div>
        </div>

        {/* Center: headline + motto */}
        <div className="relative z-10 animate-fade-up">
          {/* Gold rule */}
          <div
            className="w-12 h-1 rounded-full mb-8"
            style={{ background: 'linear-gradient(90deg, #06b6d4, #22d3ee)' }}
          />

          <h1
            className="text-5xl font-black leading-tight mb-6"
            style={{ color: '#f8fafc', letterSpacing: '-0.02em' }}
          >
            Win More.<br />
            <span style={{
              background: 'linear-gradient(90deg, #06b6d4, #22d3ee)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}>
              Bid Smarter.
            </span>
          </h1>

          <p className="text-lg text-slate-400 leading-relaxed mb-4 max-w-sm">
            AI-powered federal contract intelligence that turns SAM.gov noise into
            clear, confident bid decisions — for your entire client portfolio.
          </p>

          {/* Motto */}
          <p
            className="text-sm italic font-medium"
            style={{ color: 'rgba(6,182,212,0.8)' }}
          >
            "Built on the FAR. Scored on capability. Won on discipline."
          </p>

          {/* Trust pillars */}
          <div className="grid grid-cols-3 gap-4 mt-10">
            {pillars.map(({ icon: Icon, label, sub }) => (
              <div
                key={label}
                className="flex flex-col gap-1.5 p-3 rounded-lg"
                style={{
                  background: 'rgba(6,182,212,0.06)',
                  border: '1px solid rgba(6,182,212,0.14)',
                }}
              >
                <Icon className="w-4 h-4 text-cyan-400" />
                <p className="text-xs font-semibold text-slate-200">{label}</p>
                <p className="text-[10px] text-slate-500">{sub}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom: trust line */}
        <div className="relative z-10 flex items-center gap-3">
          {[...Array(5)].map((_, i) => (
            <Star key={i} className="w-3 h-3 text-cyan-400" fill="currentColor" />
          ))}
          <p className="text-xs text-slate-500 ml-1">
            Trusted by GovCon consultants nationwide
          </p>
        </div>
      </div>

      {/* ============================================================ */}
      {/* RIGHT PANEL — Login Form                                     */}
      {/* ============================================================ */}
      <div className="flex flex-1 flex-col justify-center items-center p-8"
        style={{ background: '#061019' }}>

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
                    style={{ color: '#22d3ee' }}
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
            style={{ borderTop: '1px solid #173447' }}
          >
            <p className="text-sm text-slate-500">
              New consulting firm?{' '}
              <Link
                to="/register"
                className="font-semibold transition-colors"
                style={{ color: '#06b6d4' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = '#22d3ee')}
                onMouseLeave={(e) => (e.currentTarget.style.color = '#06b6d4')}
              >
                Register your firm →
              </Link>
            </p>
          </div>

          {/* Bottom badge */}
          <div className="mt-8 flex items-center justify-center gap-2">
            <div
              className="flex items-center gap-1.5 text-[10px] px-3 py-1 rounded-full"
              style={{ background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.2)', color: 'rgba(6,182,212,0.7)' }}
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
