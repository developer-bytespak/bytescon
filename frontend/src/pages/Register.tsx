import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '../services/api';
import { CheckCircle, Zap, ShieldCheck, MailCheck } from 'lucide-react';
import { useToast } from '../components/Toast';

function BrandMark({ size = 48, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="regCanopy" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
      <path d="M12 6 L30 6 L48 32 L30 58 L12 58 L27 32 Z" fill="url(#regCanopy)" />
      <path d="M37 12 L45 12 L59 32 L45 52 L37 52 L51 32 Z" fill="#22d3ee" opacity="0.5" />
    </svg>
  );
}

const perks = [
  'Real-time SAM.gov opportunity ingestion',
  'AI win probability scoring per client',
  'Monte Carlo revenue forecasting',
  'Compliance matrix & document intelligence',
  'Full client portal included',
];

export function RegisterPage() {
  const { toast } = useToast();
  const [params] = useSearchParams();
  const isLifetimeIntent = params.get('offer') === 'lifetime';
  const [form, setForm] = useState({
    firmName: '', contactEmail: '', firstName: '', lastName: '', password: '',
  });
  const [acceptedTos, setAcceptedTos] = useState(false);
  const [tosExpanded, setTosExpanded] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  const { data: legalData } = useQuery({
    queryKey: ['legal-current'],
    queryFn: () => authApi.legalCurrent(),
    staleTime: 5 * 60_000,
  });
  const tos = legalData?.data?.tos;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!tos) {
      setError('Legal documents are still loading. Please retry in a moment.');
      return;
    }
    if (!acceptedTos) {
      setError('You must accept the Terms of Service to continue.');
      return;
    }
    setLoading(true);
    try {
      const res = await authApi.registerFirm({
        ...form,
        acceptedTosVersion: tos.version,
      });
      // Backend now returns { requiresEmailVerification: true, email, verificationUrl } —
      // no JWT until the user verifies their email.
      setPendingEmail(res.data?.email ?? form.contactEmail);
      toast('Account created. Check your email to verify.', 'success');
    } catch (err: any) {
      const code = err.response?.data?.code;
      if (code === 'TOS_VERSION_MISMATCH' || code === 'NDA_VERSION_MISMATCH') {
        setError('Our terms have just been updated. Please reload the page and re-accept the latest versions.');
      } else {
        setError(err.response?.data?.error || 'Registration failed');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!pendingEmail) return;
    try {
      await authApi.resendVerification(pendingEmail);
      toast('Verification email re-sent. Check your inbox.', 'success');
    } catch {
      toast('Could not resend right now. Try again in a few minutes.', 'error');
    }
  };

  return (
    <div className="min-h-screen flex" style={{ background: '#061019' }}>

      {/* ---- Left brand strip ---- */}
      <div
        className="hidden lg:flex flex-col justify-between w-2/5 p-12 relative overflow-hidden"
        style={{
          background: 'linear-gradient(145deg, #071120 0%, #0a1a26 100%)',
          borderRight: '1px solid rgba(6,182,212,0.15)',
        }}
      >
        <div
          className="absolute top-0 right-0 w-96 h-96 pointer-events-none"
          style={{ background: 'radial-gradient(ellipse at top right, rgba(6,182,212,0.1) 0%, transparent 65%)' }}
        />

        {/* Brand identity */}
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-3">
            <BrandMark size={44} />
            <div>
              <p className="text-xs font-bold tracking-[0.15em] uppercase text-cyan-400/80">Bytescon</p>
              <p className="text-[10px] text-slate-500 tracking-widest">GovCon Advisory Intelligence</p>
            </div>
          </div>
          <span className="veteran-badge">★ Veteran Owned & Operated</span>
        </div>

        {/* Value props */}
        <div className="relative z-10">
          <div className="w-10 h-0.5 rounded mb-6" style={{ background: 'linear-gradient(90deg, #06b6d4, transparent)' }} />
          <h2 className="text-3xl font-black text-slate-100 leading-snug mb-3">
            Your clients deserve<br />
            <span style={{ background: 'linear-gradient(90deg,#06b6d4,#22d3ee)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              better intel.
            </span>
          </h2>
          <p className="text-sm text-slate-500 mb-8 leading-relaxed">
            Everything you need to run a data-driven GovCon advisory practice — starting free.
          </p>
          <ul className="space-y-3">
            {perks.map((perk) => (
              <li key={perk} className="flex items-start gap-2.5">
                <CheckCircle className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" />
                <span className="text-sm text-slate-400">{perk}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative z-10 text-xs italic text-cyan-400/60">
          "Built on the FAR. Scored on capability. Won on discipline."
        </p>
      </div>

      {/* ---- Right form panel ---- */}
      <div className="flex flex-1 flex-col justify-center items-center p-8" style={{ background: '#061019' }}>

        {/* Mobile logo */}
        <div className="flex lg:hidden flex-col items-center mb-6">
          <BrandMark size={40} />
          <p className="text-xs font-bold tracking-widest uppercase text-cyan-400 mt-2">Bytescon</p>
        </div>

        <div className="w-full max-w-md">
          {pendingEmail ? (
            <div className="rounded-xl p-6" style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(6,182,212,0.25)' }}>
              <div className="flex items-center gap-3 mb-4">
                <MailCheck className="w-7 h-7 text-cyan-400" aria-hidden="true" />
                <h2 className="text-xl font-bold text-slate-100">Check your email</h2>
              </div>
              <p className="text-sm text-slate-300 mb-3">
                We sent a verification link to <span className="font-semibold text-cyan-300">{pendingEmail}</span>. Click it to activate your account — the link expires in 24 hours.
              </p>
              <p className="text-xs text-slate-500 mb-5">
                Didn't get the email? Check your spam folder, or resend below.
              </p>
              {isLifetimeIntent && (
                <p className="text-xs mb-5 px-3 py-2 rounded-lg" style={{ background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.25)', color: '#22d3ee' }}>
                  ★ Your $2,500 Founders Lifetime slot is held — Core + every add-on module, for life. Verify your email and sign in; we'll take you straight to claim it.
                </p>
              )}
              <div className="flex gap-3">
                <button type="button" onClick={handleResend} className="btn-secondary flex-1 py-2.5 text-sm">Resend email</button>
                <Link to="/login" className="btn-primary flex-1 py-2.5 text-sm text-center">Back to sign in</Link>
              </div>
            </div>
          ) : (
          <>
          <div className="mb-5">
            <h2 className="text-2xl font-bold text-slate-100 mb-1">Create your account</h2>
            <p className="text-sm text-slate-500">14-day all-access free trial — every module unlocked. No credit card required.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">Consulting Firm Name</label>
              <input className="input" value={form.firmName}
                onChange={(e) => setForm({ ...form, firmName: e.target.value })}
                required placeholder="e.g. Apex Federal Advisory LLC" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">First Name</label>
                <input className="input" value={form.firstName}
                  onChange={(e) => setForm({ ...form, firstName: e.target.value })} required />
              </div>
              <div>
                <label className="label">Last Name</label>
                <input className="input" value={form.lastName}
                  onChange={(e) => setForm({ ...form, lastName: e.target.value })} required />
              </div>
            </div>

            <div>
              <label className="label">Email Address</label>
              <input type="email" className="input" value={form.contactEmail}
                onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} required
                placeholder="you@yourfirm.com" />
            </div>

            <div>
              <label className="label" htmlFor="reg-password">Password</label>
              <input id="reg-password" type="password" className="input" value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })} required
                placeholder="Min 12 chars — upper, lower, number, symbol" />
              <p className="text-[11px] text-slate-600 mt-1 ml-0.5">
                Must include uppercase, lowercase, a number, and a symbol
              </p>
            </div>

            {/* Legal acceptance — Terms of Service */}
            <fieldset className="space-y-3 rounded-lg p-4" style={{ background: 'rgba(15,23,42,0.5)', border: '1px solid rgba(6,182,212,0.18)' }}>
              <legend className="px-2 text-xs font-semibold tracking-wider text-cyan-400/90 uppercase">Required Agreements</legend>

              <div>
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={acceptedTos}
                    onChange={(e) => setAcceptedTos(e.target.checked)}
                    className="mt-1"
                    aria-describedby="tos-desc"
                  />
                  <span id="tos-desc" className="text-xs text-slate-300 leading-snug">
                    I have read and accept the{' '}
                    <button type="button" onClick={() => setTosExpanded((v) => !v)} className="font-semibold underline" style={{ color: '#22d3ee' }}>
                      Terms of Service{tos ? ` (v${tos.version})` : ''}
                    </button>
                    , including the IP-protection restrictions on copying, redistribution, recreation, and reverse engineering.
                  </span>
                </label>
                {tosExpanded && tos && (
                  <div className="mt-2 max-h-56 overflow-y-auto p-3 rounded text-[11px] whitespace-pre-wrap leading-relaxed text-slate-400" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(148,163,184,0.15)' }}>
                    {tos.body}
                  </div>
                )}
              </div>
            </fieldset>

            {error && (
              <div role="alert" className="text-sm rounded-lg px-4 py-3"
                style={{ background: 'rgba(127,29,29,0.4)', border: '1px solid rgba(185,28,28,0.5)', color: '#fca5a5' }}>
                {error}
              </div>
            )}

            <button type="submit" disabled={loading || !acceptedTos} className="btn-primary w-full py-3 text-sm">
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Creating account...
                </span>
              ) : 'Create Firm Account →'}
            </button>
          </form>

          <div className="mt-5 pt-5 text-center" style={{ borderTop: '1px solid #173447' }}>
            <p className="text-sm text-slate-500">
              Already have an account?{' '}
              <Link to="/login" className="font-semibold" style={{ color: '#06b6d4' }}>
                Sign in →
              </Link>
            </p>
          </div>

          <div className="mt-6 flex items-center justify-center">
            <div className="flex items-center gap-1.5 text-[10px] px-3 py-1 rounded-full"
              style={{ background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.2)', color: 'rgba(6,182,212,0.7)' }}>
              <span>★</span>
              <span>Veteran Owned & Operated · Secured Platform</span>
            </div>
          </div>
          </>
          )}
        </div>
      </div>
    </div>
  );
}
