import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '../services/api';
import { Eye, EyeOff } from 'lucide-react';
import { AuthShell, AuthHeading, AuthNotice, AuthTrustLine } from '../components/auth/AuthShell';
import { useToast } from '../components/Toast';

const perks = [
  'Real-time SAM.gov opportunity ingestion',
  'AI win probability scoring per client',
  'Monte Carlo revenue forecasting',
  'Compliance matrix and document intelligence',
  'Full client portal included',
];

// The side panel speaks to whichever account type is chosen in the form.
const contractorPerks = [
  'Real-time SAM.gov opportunity ingestion',
  'AI win probability scoring for your company',
  'Bid or no-bid decisions with the reasons shown',
  'Compliance matrix and document intelligence',
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

  const aside = (
    <>
      <div>
        <h2 className="v3-h1" style={{ color: '#f0f1fa' }}>
          {isContractor ? 'Bid on the right work and win more of it.' : 'Your clients deserve better intel.'}
        </h2>
        <p className="mt-5 text-[17px] leading-[26px] max-w-md" style={{ color: 'rgba(240, 241, 250, 0.72)' }}>
          {isContractor
            ? 'Everything you need to find, qualify and win government contracts for your company. Fourteen days free, every module unlocked.'
            : 'Everything you need to run a data-driven GovCon advisory practice. Fourteen days free, every module unlocked.'}
        </p>
      </div>
      <div>
        <ul className="pt-2" style={{ borderTop: '1px solid rgba(240, 241, 250, 0.12)' }}>
          {(isContractor ? contractorPerks : perks).map((perk) => (
            <li key={perk} className="py-3 text-[15px]" style={{ color: '#f0f1fa', borderBottom: '1px solid rgba(240, 241, 250, 0.08)' }}>
              {perk}
            </li>
          ))}
        </ul>
        <p className="mt-5 text-[13px]" style={{ color: 'rgba(240, 241, 250, 0.6)' }}>No credit card to start. Cancel any time.</p>
      </div>
    </>
  );

  return (
    <AuthShell
      wide
      aside={aside}
      headerRight={<Link to="/login" className="v3-pill v3-pill-light v3-pill-sm">Sign in</Link>}
      footer={<AuthTrustLine />}
    >
          {pendingEmail ? (
            <div role="status">
              <AuthHeading title="Check your email">
                We sent a verification link to{' '}
                <span className="font-semibold [overflow-wrap:anywhere]" style={{ color: 'var(--text)' }}>{pendingEmail}</span>.
                Click it to activate your account. The link expires in 24 hours.
              </AuthHeading>
              <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
                Didn't get the email? Check your spam folder, or resend it below.
              </p>
              {isLifetimeIntent && (
                <div className="mb-6">
                  <AuthNotice tone="info">
                    Your $2,500 Founders Lifetime slot is held: Core and every add-on module, for life. Verify your email and sign in, and we'll take you straight to claim it.
                  </AuthNotice>
                </div>
              )}
              <div className="flex flex-wrap gap-3">
                <button type="button" onClick={handleResend} className="btn-secondary flex-1">Resend email</button>
                <Link to="/login" className="btn-primary flex-1 text-center">Back to sign in</Link>
              </div>
            </div>
          ) : (
          <>
          <AuthHeading title="Create your account">
            14-day all-access free trial with every module unlocked. No credit card required.
          </AuthHeading>

          <form onSubmit={handleSubmit} className="space-y-5">
            <fieldset>
              <legend className="label">Account type</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {([
                  { value: 'CONSULTING', title: 'Consulting firm', hint: 'I help client companies win contracts' },
                  { value: 'CONTRACTOR', title: 'Contractor', hint: 'I bid on contracts for my own company' },
                ] as const).map((opt) => {
                  const on = accountType === opt.value;
                  return (
                    <label
                      key={opt.value}
                      className="cursor-pointer rounded-2xl px-4 py-3 text-sm transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2"
                      style={on
                        ? { background: 'var(--surface-2)', boxShadow: 'inset 0 0 0 1.5px var(--text)', outlineColor: 'var(--accent)' }
                        : { background: 'var(--surface)', boxShadow: 'inset 0 0 0 1px var(--line-strong)', outlineColor: 'var(--accent)' }}
                    >
                      <input
                        type="radio" name="accountType" value={opt.value} className="sr-only"
                        checked={on}
                        onChange={() => setAccountType(opt.value)}
                      />
                      <span className="block font-semibold" style={{ color: 'var(--text)' }}>{opt.title}</span>
                      <span className="block text-[13px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{opt.hint}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div>
              <label className="label" htmlFor="firmName">{isContractor ? 'Company name' : 'Consulting firm name'}</label>
              <input id="firmName" className="input" value={form.firmName}
                onChange={(e) => setForm({ ...form, firmName: e.target.value })}
                required placeholder={isContractor ? 'e.g. ARK Telecommunications & Construction' : 'e.g. Apex Federal Advisory LLC'} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="reg-first">First name</label>
                <input id="reg-first" className="input" value={form.firstName}
                  onChange={(e) => setForm({ ...form, firstName: e.target.value })} required />
              </div>
              <div>
                <label className="label" htmlFor="reg-last">Last name</label>
                <input id="reg-last" className="input" value={form.lastName}
                  onChange={(e) => setForm({ ...form, lastName: e.target.value })} required />
              </div>
            </div>

            <div>
              <label className="label" htmlFor="reg-email">Email address</label>
              <input id="reg-email" type="email" className="input" value={form.contactEmail}
                onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} required
                placeholder="you@yourfirm.com" />
            </div>

            <div>
              <label className="label" htmlFor="reg-password">Password</label>
              <div className="relative">
                <input id="reg-password" type={showPassword ? 'text' : 'password'} className="input pr-10" value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })} required
                  placeholder="At least 12 characters" aria-describedby="reg-password-hint" />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p id="reg-password-hint" className="text-[13px] mt-1.5" style={{ color: 'var(--text-muted)' }}>
                At least 12 characters, with uppercase, lowercase, a number and a symbol.
              </p>
            </div>

            {/* Legal acceptance — Terms of Service */}
            <fieldset className="pt-5" style={{ borderTop: '1px solid var(--line)' }}>
              <legend className="sr-only">Required agreements</legend>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={acceptedTos}
                  onChange={(e) => setAcceptedTos(e.target.checked)}
                  className="mt-0.5"
                  aria-describedby="tos-desc"
                />
                <span id="tos-desc" className="text-[13px] leading-[19px]" style={{ color: 'var(--text-2)' }}>
                  I have read and accept the{' '}
                  <button type="button" onClick={() => setTosExpanded((v) => !v)} className="font-semibold underline underline-offset-2" style={{ color: 'var(--text)' }}>
                    Terms of Service{tos ? ` (v${tos.version})` : ''}
                  </button>
                  , including the IP-protection restrictions on copying, redistribution, recreation, and reverse engineering.
                </span>
              </label>
              {tosExpanded && tos && (
                <div className="mt-3 max-h-56 overflow-y-auto p-4 rounded-2xl text-[12px] whitespace-pre-wrap leading-relaxed" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
                  {tos.body}
                </div>
              )}
            </fieldset>

            {error && <AuthNotice>{error}</AuthNotice>}

            <button type="submit" disabled={loading || !acceptedTos} className="btn-primary w-full">
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Creating account...
                </span>
              ) : isContractor ? 'Create company account' : 'Create consulting firm account'}
            </button>
          </form>

          <p className="mt-7 pt-6 text-sm" style={{ borderTop: '1px solid var(--line)', color: 'var(--text-muted)' }}>
            Already have an account?{' '}
            <Link to="/login" className="font-semibold underline underline-offset-2" style={{ color: 'var(--text)' }}>Sign in</Link>
          </p>
          </>
          )}
    </AuthShell>
  );
}
