import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '../services/api';
import { CheckCircle, Eye, EyeOff, MailCheck } from 'lucide-react';
import { useToast } from '../components/Toast';

function BrandMark({ size = 48, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="regCanopy" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#7b8fff" />
          <stop offset="100%" stopColor="#5b74ff" />
        </linearGradient>
      </defs>
      <path d="M12 6 L30 6 L48 32 L30 58 L12 58 L27 32 Z" fill="url(#regCanopy)" />
      <path d="M37 12 L45 12 L59 32 L45 52 L37 52 L51 32 Z" fill="#7b8fff" opacity="0.5" />
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

// The side panel speaks to whichever account type is chosen in the form.
const contractorPerks = [
  'Real-time SAM.gov opportunity ingestion',
  'AI win probability scoring for your company',
  'Bid / no-bid decisions with the reasons shown',
  'Compliance matrix & document intelligence',
  'Proposal drafting and pricing tools',
];

export function RegisterPage() {
  const { toast } = useToast();
  const [params] = useSearchParams();
  const isLifetimeIntent = params.get('offer') === 'lifetime';
  const [form, setForm] = useState({
    firmName: '', contactEmail: '', firstName: '', lastName: '', password: '',
  });
  // CONSULTING serves clients; CONTRACTOR bids for its own company.
  const [accountType, setAccountType] = useState<'CONSULTING' | 'CONTRACTOR'>('CONSULTING');
  const isContractor = accountType === 'CONTRACTOR';
  const [acceptedTos, setAcceptedTos] = useState(false);
  const [tosExpanded, setTosExpanded] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
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
        accountType,
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
    <div className="min-h-screen flex" style={{ background: 'var(--bg)' }}>

      {/* ---- Brand panel (desktop) ---- */}
      <div
        className="hidden lg:flex flex-col justify-between w-2/5 p-12 relative overflow-hidden"
        style={{ background: 'var(--bg)', borderRight: '1px solid var(--line)' }}
      >
        <img
          src="/landing/cta.jpg"
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          style={{ opacity: 0.55, objectPosition: '70% 50%' }}
        />
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: 'linear-gradient(180deg, rgba(var(--bg-rgb),0.55) 0%, rgba(var(--bg-rgb),0.3) 40%, rgba(var(--bg-rgb),0.95) 100%)' }}
        />

        <Link to="/" className="relative z-10 flex items-center gap-3 w-fit">
          <BrandMark size={32} />
          <span className="font-display text-xl" style={{ color: 'var(--text)' }}>Bytescon</span>
        </Link>

        <div className="relative z-10">
          <h2 className="font-display text-4xl leading-[1.08]" style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}>
            {isContractor ? 'Bid on the right work,' : 'Your clients deserve'}<br />
            <em className="font-light" style={{ color: 'var(--gold-2)' }}>{isContractor ? 'win more of it.' : 'better intel.'}</em>
          </h2>
          <p className="mt-4 text-sm leading-relaxed max-w-sm" style={{ color: 'var(--text-2)' }}>
            {isContractor
              ? 'Everything you need to find, qualify and win government contracts for your company. Fourteen days free, every module unlocked.'
              : 'Everything you need to run a data-driven GovCon advisory practice. Fourteen days free, every module unlocked.'}
          </p>
          <ul className="mt-7 space-y-2.5">
            {(isContractor ? contractorPerks : perks).map((perk) => (
              <li key={perk} className="flex items-start gap-2.5">
                <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-2)' }} />
                <span className="text-sm" style={{ color: 'var(--text-2)' }}>{perk}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative z-10 text-xs" style={{ color: 'var(--text-muted)' }}>
          No credit card to start. Cancel any time.
        </p>
      </div>

      {/* ---- Right form panel ---- */}
      <div className="flex flex-1 flex-col justify-center items-center p-8" style={{ background: 'var(--bg)' }}>

        {/* Mobile logo */}
        <div className="flex lg:hidden flex-col items-center mb-6">
          <BrandMark size={40} />
          <p className="text-xs font-bold tracking-widest uppercase text-cyan-400 mt-2">Bytescon</p>
        </div>

        <div className="w-full max-w-md animate-fade-up">
          {pendingEmail ? (
            <div role="status" className="rounded-xl p-6" style={{ background: 'var(--surface)', border: '1px solid var(--accent-line)', boxShadow: '0 12px 32px rgba(0,0,0,0.08)' }}>
              <div className="flex items-center gap-3 mb-4">
                <span className="inline-grid place-items-center w-10 h-10 rounded-full" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                  <MailCheck className="w-5 h-5" aria-hidden="true" />
                </span>
                <h2 className="text-xl font-bold" style={{ color: 'var(--text)' }}>Check your email</h2>
              </div>
              <p className="text-sm mb-3" style={{ color: 'var(--text-2)' }}>
                We sent a verification link to
                <span className="block font-semibold my-1 [overflow-wrap:anywhere]" style={{ color: 'var(--accent)' }}>{pendingEmail}</span>
                Click it to activate your account — the link expires in 24 hours.
              </p>
              <p className="text-xs mb-5" style={{ color: 'var(--text-muted)' }}>
                Didn't get the email? Check your spam folder, or resend below.
              </p>
              {isLifetimeIntent && (
                <p className="text-xs mb-5 px-3 py-2 rounded-lg" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', color: 'var(--accent)' }}>
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
            <fieldset>
              <legend className="label">Account type</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {([
                  { value: 'CONSULTING', title: 'Consulting firm', hint: 'I help client companies win contracts' },
                  { value: 'CONTRACTOR', title: 'Contractor', hint: 'I bid on contracts for my own company' },
                ] as const).map((opt) => (
                  <label
                    key={opt.value}
                    className={`cursor-pointer rounded-lg border px-3 py-2 text-sm ${accountType === opt.value ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700'}`}
                  >
                    <input
                      type="radio" name="accountType" value={opt.value} className="sr-only"
                      checked={accountType === opt.value}
                      onChange={() => setAccountType(opt.value)}
                    />
                    <span className="block font-medium text-slate-100">{opt.title}</span>
                    <span className="block text-xs text-slate-500">{opt.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              <label className="label" htmlFor="firmName">{isContractor ? 'Company Name' : 'Consulting Firm Name'}</label>
              <input id="firmName" className="input" value={form.firmName}
                onChange={(e) => setForm({ ...form, firmName: e.target.value })}
                required placeholder={isContractor ? 'e.g. ARK Telecommunications & Construction' : 'e.g. Apex Federal Advisory LLC'} />
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
              <div className="relative">
                <input id="reg-password" type={showPassword ? 'text' : 'password'} className="input pr-10" value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })} required
                  placeholder="Min 12 chars — upper, lower, number, symbol" />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-cyan-400 transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[11px] text-slate-600 mt-1 ml-0.5">
                Must include uppercase, lowercase, a number, and a symbol
              </p>
            </div>

            {/* Legal acceptance — Terms of Service */}
            <fieldset className="space-y-3 rounded-lg p-4" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}>
              <legend className="px-2 text-xs font-semibold tracking-wider uppercase" style={{ color: 'var(--accent)' }}>Required Agreements</legend>

              <div>
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={acceptedTos}
                    onChange={(e) => setAcceptedTos(e.target.checked)}
                    className="mt-1"
                    aria-describedby="tos-desc"
                  />
                  <span id="tos-desc" className="text-xs leading-snug" style={{ color: 'var(--text-2)' }}>
                    I have read and accept the{' '}
                    <button type="button" onClick={() => setTosExpanded((v) => !v)} className="font-semibold underline" style={{ color: 'var(--accent)' }}>
                      Terms of Service{tos ? ` (v${tos.version})` : ''}
                    </button>
                    , including the IP-protection restrictions on copying, redistribution, recreation, and reverse engineering.
                  </span>
                </label>
                {tosExpanded && tos && (
                  <div className="mt-2 max-h-56 overflow-y-auto p-3 rounded text-[11px] whitespace-pre-wrap leading-relaxed" style={{ background: 'var(--surface)', border: '1px solid var(--line-strong)', color: 'var(--text-muted)' }}>
                    {tos.body}
                  </div>
                )}
              </div>
            </fieldset>

            {error && (
              <div role="alert" className="text-sm rounded-lg px-4 py-3"
                style={{ background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--danger-text)' }}>
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
              ) : isContractor ? 'Create Company Account →' : 'Create Consulting Firm Account →'}
            </button>
          </form>

          <div className="mt-5 pt-5 text-center" style={{ borderTop: '1px solid var(--line-strong)' }}>
            <p className="text-sm text-slate-500">
              Already have an account?{' '}
              <Link to="/login" className="font-semibold" style={{ color: '#5b74ff' }}>
                Sign in →
              </Link>
            </p>
          </div>

          <div className="mt-6 flex items-center justify-center">
            <div className="flex items-center gap-1.5 text-[10px] px-3 py-1 rounded-full"
              style={{ background: 'rgba(91,116,255,0.08)', border: '1px solid rgba(91,116,255,0.2)', color: 'rgba(91,116,255,0.7)' }}>
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
