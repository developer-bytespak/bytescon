import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { firmApi, clientDocumentsApi, authApi, mcpApi } from '../services/api';
import { PageHeader, PageSkeleton, SkeletonRows, StatusPill } from '../components/ui';
import { Settings, Users, Key, Eye, EyeOff, CheckCircle, XCircle, BookOpen, Brain, RefreshCw, BarChart2, Shield, Lock, PlayCircle, Plug, Copy, Trash2, UserPlus } from 'lucide-react';
import { useTutorial } from '../hooks/useTutorial';
import { useAuth, useIsContractor } from '../hooks/useAuth';
import { CONNECTOR_URL } from '../components/ConnectClaudeWizard';
import { PublicApiTokens } from '../components/PublicApiTokens';
import { BrandingSettings } from '../components/BrandingSettings';
import { DomainSettings } from '../components/DomainSettings';
import { MfaSettings } from '../components/MfaSettings';
import { roleLabel } from '../lib/roleLabels';

const SYNC_LIMIT_KEY = 'bytesgov_sync_limit';
const SYNC_NAICS_KEY = 'bytesgov_sync_naics';

const PROVIDER_LABELS: Record<string, { label: string }> = {
  claude:         { label: 'Claude (Anthropic)' },
  openai:         { label: 'OpenAI (GPT-4o)' },
  deepseek:       { label: 'DeepSeek V3' },
  insight_engine: { label: 'Insight Engine' },
  localai:        { label: 'Ollama (Local)' },
}

export function SettingsPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isContractor = useIsContractor();
  const isAdmin = user?.role === 'ADMIN';
  const tutorial = useTutorial();
  const [tutorialResetMsg, setTutorialResetMsg] = useState('');

  // ── MCP access tokens ───────────────────────────────────────
  const [newMcpToken, setNewMcpToken] = useState<string | null>(null);
  const [mcpCopied, setMcpCopied] = useState(false);
  const [mcpUrlCopied, setMcpUrlCopied] = useState(false);
  // Single hosted connector URL — the gateway serves ALL 27 tools here, so one
  // connector covers everything. Derived from VITE_API_URL when set, else hosted prod.
  const mcpUrl = CONNECTOR_URL;
  const mcpTokensQ = useQuery({ queryKey: ['mcp-tokens'], queryFn: () => mcpApi.listTokens() });
  const winnersIntelQ = useQuery({ queryKey: ['winners-intel'], queryFn: () => firmApi.getWinnersIntel(), enabled: isAdmin });
  const winnersIntelMutation = useMutation({
    mutationFn: (optIn: boolean) => firmApi.setWinnersIntel(optIn),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['winners-intel'] }),
  });
  // Connector tokens only — Public API credentials have their own panel.
  const mcpTokens: any[] = (mcpTokensQ.data?.data ?? []).filter((t: any) => t.kind !== 'PUBLIC_API');
  const createMcpTokenMut = useMutation({
    mutationFn: () => mcpApi.createToken('MCP Client'),
    onSuccess: (res: any) => {
      setNewMcpToken(res?.data?.rawToken ?? null);
      qc.invalidateQueries({ queryKey: ['mcp-tokens'] });
    },
  });
  const revokeMcpTokenMut = useMutation({
    mutationFn: (id: string) => mcpApi.revokeToken(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp-tokens'] }),
  });
  const copyMcpToken = () => {
    if (!newMcpToken) return;
    navigator.clipboard?.writeText(newMcpToken);
    setMcpCopied(true);
    setTimeout(() => setMcpCopied(false), 2000);
  };
  const copyMcpUrl = () => {
    navigator.clipboard?.writeText(mcpUrl);
    setMcpUrlCopied(true);
    setTimeout(() => setMcpUrlCopied(false), 2000);
  };
  const [penaltyForm, setPenaltyForm] = useState({ flatLateFee: '', penaltyPercent: '' });
  const [saveMsg, setSaveMsg] = useState('');
  const [samKey, setSamKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [samKeyMsg, setSamKeyMsg] = useState('');
  const [samTestStatus, setSamTestStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [showUsage, setShowUsage] = useState(false);
  const [reviewNote, setReviewNote] = useState<Record<string, string>>({});
  const [selectedProvider, setSelectedProvider] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [insightKey, setInsightKey] = useState('');
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);
  const [showOpenaiKey, setShowOpenaiKey] = useState(false);
  const [showInsightKey, setShowInsightKey] = useState(false);
  const [ollamaUrl, setOllamaUrl] = useState('');
  const [ollamaModel, setOllamaModel] = useState('');
  const [aiKeyMsg, setAiKeyMsg] = useState('');
  const [syncLimit, setSyncLimit] = useState(() => localStorage.getItem(SYNC_LIMIT_KEY) || '25');
  const [syncNaics, setSyncNaics] = useState(() => localStorage.getItem(SYNC_NAICS_KEY) || '');
  const [syncSaveMsg, setSyncSaveMsg] = useState('');
  const [pwForm, setPwForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [pwMsg, setPwMsg] = useState('');

  // ── Invite team member (read-only CONSULTANT, email invite) ──────
  const [memberForm, setMemberForm] = useState({ firstName: '', lastName: '', email: '' });
  const [memberMsg, setMemberMsg] = useState('');
  const [memberErr, setMemberErr] = useState('');
  const addMemberMut = useMutation({
    mutationFn: () => authApi.inviteUser(memberForm),
    onSuccess: () => {
      setMemberMsg(`Invite sent to ${memberForm.email}. They'll set their own password from the email link, then have read-only access.`);
      setMemberErr('');
      setMemberForm({ firstName: '', lastName: '', email: '' });
      qc.invalidateQueries({ queryKey: ['firm-users'] });
      setTimeout(() => setMemberMsg(''), 8000);
    },
    onError: (e: any) => {
      setMemberMsg('');
      setMemberErr(e?.response?.data?.error || e?.message || 'Failed to send invite');
    },
  });
  const canAddMember = !!(memberForm.firstName.trim() && memberForm.lastName.trim() && memberForm.email.trim());

  const { data, isLoading } = useQuery({
    queryKey: ['firm'],
    queryFn: () => firmApi.get(),
  });

  const { data: usersData } = useQuery({
    queryKey: ['firm-users'],
    queryFn: () => firmApi.users(),
  });

  const { data: templatesData, refetch: refetchTemplates } = useQuery({
    queryKey: ['templates-admin'],
    queryFn: () => clientDocumentsApi.listTemplatesAdmin(),
  });

  const { data: usageData } = useQuery({
    queryKey: ['ai-usage'],
    queryFn: () => firmApi.aiUsage({ days: 30 }),
    enabled: showUsage,
  });

  useEffect(() => {
    if (data?.data) {
      setPenaltyForm({
        flatLateFee: data.data.flatLateFee?.toString() || '',
        penaltyPercent: data.data.penaltyPercent ? (data.data.penaltyPercent * 100).toString() : '',
      });
      if (data.data.localaiBaseUrl) setOllamaUrl(data.data.localaiBaseUrl);
      if (data.data.localaiModel) setOllamaModel(data.data.localaiModel);
    }
  }, [data]);

  const penaltyMutation = useMutation({
    mutationFn: () => firmApi.updatePenaltyConfig({
      flatLateFee: penaltyForm.flatLateFee ? parseFloat(penaltyForm.flatLateFee) : null,
      penaltyPercent: penaltyForm.penaltyPercent ? parseFloat(penaltyForm.penaltyPercent) / 100 : null,
    }),
    onSuccess: () => {
      setSaveMsg('Penalty configuration saved.');
      qc.invalidateQueries({ queryKey: ['firm'] });
      setTimeout(() => setSaveMsg(''), 3000);
    },
  });

  const samKeyMutation = useMutation({
    mutationFn: () => firmApi.updateSamApiKey(samKey),
    onSuccess: () => {
      setSamKeyMsg('SAM API key saved successfully.');
      setSamKey('');
      qc.invalidateQueries({ queryKey: ['firm'] });
      setTimeout(() => setSamKeyMsg(''), 4000);
    },
    onError: (err: any) => setSamKeyMsg(err?.response?.data?.error || 'Save failed'),
  });

  const samTestMutation = useMutation({
    mutationFn: () => firmApi.testSamKey(samKey),
    onSuccess: (res: any) => {
      setSamTestStatus({ ok: !!res?.ok, message: res?.message || (res?.ok ? 'Key is valid.' : 'Test failed.') });
      setTimeout(() => setSamTestStatus(null), 8000);
    },
    onError: (err: any) => {
      setSamTestStatus({ ok: false, message: err?.response?.data?.error || err?.response?.data?.message || 'Test failed.' });
      setTimeout(() => setSamTestStatus(null), 8000);
    },
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'APPROVED' | 'REJECTED' }) =>
      clientDocumentsApi.reviewTemplate(id, { status, reviewNotes: reviewNote[id] || undefined }),
    onSuccess: () => {
      refetchTemplates();
      qc.invalidateQueries({ queryKey: ['templates-admin'] });
    },
  });

  const providerMutation = useMutation({
    mutationFn: (provider: string) => firmApi.updateLlmProvider(provider),
    onSuccess: (_data, provider) => {
      setAiKeyMsg(`AI provider updated to ${PROVIDER_LABELS[provider]?.label ?? provider}.`);
      qc.invalidateQueries({ queryKey: ['firm'] });
      setTimeout(() => setAiKeyMsg(''), 4000);
    },
    onError: (err: any) => setAiKeyMsg(err?.response?.data?.error || 'Failed to update provider'),
  });

  const anthropicKeyMutation = useMutation({
    mutationFn: (key: string) => firmApi.updateAnthropicApiKey(key),
    onSuccess: () => {
      setAiKeyMsg('Anthropic API key saved.');
      setAnthropicKey('');
      qc.invalidateQueries({ queryKey: ['firm'] });
      setTimeout(() => setAiKeyMsg(''), 4000);
    },
    onError: (err: any) => setAiKeyMsg(err?.response?.data?.error || 'Save failed'),
  });

  const openaiKeyMutation = useMutation({
    mutationFn: (key: string) => firmApi.updateOpenaiApiKey(key),
    onSuccess: () => {
      setAiKeyMsg('OpenAI API key saved.');
      setOpenaiKey('');
      qc.invalidateQueries({ queryKey: ['firm'] });
      setTimeout(() => setAiKeyMsg(''), 4000);
    },
    onError: (err: any) => setAiKeyMsg(err?.response?.data?.error || 'Save failed'),
  });

  const insightKeyMutation = useMutation({
    mutationFn: (key: string) => firmApi.updateInsightEngineApiKey(key),
    onSuccess: () => {
      setAiKeyMsg('Insight Engine API key saved.');
      setInsightKey('');
      qc.invalidateQueries({ queryKey: ['firm'] });
      setTimeout(() => setAiKeyMsg(''), 4000);
    },
    onError: (err: any) => setAiKeyMsg(err?.response?.data?.error || 'Save failed'),
  });

  const ollamaMutation = useMutation({
    mutationFn: () => firmApi.updateLocalaiConfig({ localaiBaseUrl: ollamaUrl.trim() || undefined, localaiModel: ollamaModel.trim() || undefined }),
    onSuccess: () => {
      setAiKeyMsg('Ollama configuration saved.');
      qc.invalidateQueries({ queryKey: ['firm'] });
      setTimeout(() => setAiKeyMsg(''), 4000);
    },
    onError: (err: any) => setAiKeyMsg(err?.response?.data?.error || 'Save failed'),
  });

  const pwMutation = useMutation({
    mutationFn: () => authApi.changePassword(pwForm.currentPassword, pwForm.newPassword),
    onSuccess: () => {
      setPwMsg('Password updated successfully.');
      setPwForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setTimeout(() => setPwMsg(''), 4000);
    },
    onError: (err: any) => {
      setPwMsg(err?.response?.data?.error || 'Failed to change password');
      setTimeout(() => setPwMsg(''), 5000);
    },
  });

  const firm = data?.data;
  const users = usersData?.data || [];
  const templates: any[] = templatesData?.data || [];
  const pendingTemplates = templates.filter((t) => t.status === 'PENDING');

  const activeProvider = firm?.llmProvider || 'claude';
  const providerInfo = PROVIDER_LABELS[activeProvider] ?? { label: activeProvider };

  if (isLoading) return <div><span className="sr-only">Loading…</span><PageSkeleton /></div>;

  return (
    <div>
      <PageHeader title="Settings" subtitle="Firm configuration and administration" />

      {!isAdmin && (
        <div className="card mb-6 text-sm text-gray-300">
          You have <span className="font-semibold text-gray-100">read-only</span> access: you can view the workspace; firm settings are managed by your admins.
        </div>
      )}

      <div className="stagger grid grid-cols-1 lg:grid-cols-2 gap-6">
        <MfaSettings />
        {isAdmin && (<>
        {/* SAM API Key — optional/advanced; the platform provides SAM.gov data
            by default, so this is collapsed and de-emphasized. */}
        <details className="card lg:col-span-2">
          <summary className="flex flex-wrap items-center gap-2.5 cursor-pointer select-none rounded-md">
            <span className="tile tile-sm"><Key className="w-3.5 h-3.5" /></span>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text)' }}>SAM.gov API key</h2>
            <span className="chip chip-neutral">Optional · advanced</span>
            <span className="ml-auto text-xs text-slate-500">No key needed; click to expand</span>
          </summary>
          <p className="text-xs text-gray-500 mt-3 mb-4">
            <span className="text-gray-400">You don't need this.</span> Bytesgov already pulls SAM.gov
            data for you and refreshes it daily. Add your own key only if you want to use your
            own higher rate-limit quota for SAM.gov ingests. Keys expire every 90 days — renew yours at{' '}
            <span className="text-gray-200 font-medium">sam.gov, My Account, API Keys</span>.
          </p>

          {firm?.samApiKeyConfigured && (
            <div className="mb-4 flex items-center gap-3 px-3 py-2.5 rounded-lg bg-[var(--success-bg)] border border-transparent">
              <CheckCircle className="w-4 h-4 text-[color:var(--success-text)] flex-shrink-0" />
              <span className="text-xs text-[color:var(--success-text)] flex-1">SAM.gov API key is configured. Enter a new key below to replace it.</span>
            </div>
          )}

          <div className="flex gap-3 items-end flex-wrap">
            <div className="flex-1 min-w-[240px]">
              <label className="label">{firm?.samApiKeyConfigured ? 'Replace SAM.gov API Key' : 'New SAM.gov API Key'}</label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  className="input pr-10 font-mono text-sm"
                  placeholder="Paste your SAM.gov API key here..."
                  value={samKey}
                  onChange={(e) => setSamKey(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                  aria-label={showKey ? 'Hide key' : 'Show key'}
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <button
              onClick={() => samTestMutation.mutate()}
              disabled={!samKey.trim() || samTestMutation.isPending}
              className="btn-secondary disabled:opacity-50"
            >
              {samTestMutation.isPending ? 'Testing...' : 'Test connection'}
            </button>
            <button
              onClick={() => samKeyMutation.mutate()}
              disabled={!samKey.trim() || samKeyMutation.isPending}
              className="btn-primary disabled:opacity-50"
            >
              {samKeyMutation.isPending ? 'Saving...' : 'Save key'}
            </button>
          </div>
          {samTestStatus && (
            <p className={`text-sm mt-2 flex items-center gap-1.5 ${samTestStatus.ok ? 'text-[color:var(--success-text)]' : 'text-[color:var(--danger-text)]'}`}>
              {samTestStatus.ok ? <CheckCircle className="w-4 h-4 flex-shrink-0" /> : <XCircle className="w-4 h-4 flex-shrink-0" />}
              {samTestStatus.message}
            </p>
          )}
          {samKeyMsg && (
            <p className={`text-sm mt-2 ${samKeyMsg.includes('success') ? 'text-[color:var(--success-text)]' : 'text-[color:var(--danger-text)]'}`}>
              {samKeyMsg}
            </p>
          )}
        </details>
        {winnersIntelQ.data?.available && (
          <div className="card lg:col-span-2" data-testid="winners-intel-setting">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-base font-semibold" style={{ color: 'var(--text)' }}>Winners intel in proposal drafts</h2>
                <p className="text-xs text-gray-500 mt-1">
                  Adds what past federal award winners did in this department and NAICS to the context for AI proposal drafts.
                </p>
              </div>
              <button type="button" className="btn-secondary btn-sm" disabled={winnersIntelMutation.isPending}
                onClick={() => winnersIntelMutation.mutate(!winnersIntelQ.data?.optIn)}>
                {winnersIntelQ.data?.optIn ? 'Turn off' : 'Turn on'}
              </button>
            </div>
          </div>
        )}
        </>)}

        {/* Change password */}
        <div className="card lg:col-span-2">
          <div className="flex items-center gap-2.5 mb-2">
            <span className="tile tile-sm"><Lock className="w-3.5 h-3.5" /></span>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text)' }}>Change password</h2>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            Password must be at least 12 characters with uppercase, lowercase, a number, and a symbol.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="label">Current password</label>
              <div className="relative">
                <input
                  type={showCurrentPw ? 'text' : 'password'}
                  className="input pr-10"
                  placeholder="Enter current password"
                  value={pwForm.currentPassword}
                  onChange={(e) => setPwForm({ ...pwForm, currentPassword: e.target.value })}
                />
                <button type="button" onClick={() => setShowCurrentPw(v => !v)}
                  aria-label={showCurrentPw ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                  {showCurrentPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="label">New password</label>
              <div className="relative">
                <input
                  type={showNewPw ? 'text' : 'password'}
                  className="input pr-10"
                  placeholder="Min 12 chars"
                  value={pwForm.newPassword}
                  onChange={(e) => setPwForm({ ...pwForm, newPassword: e.target.value })}
                />
                <button type="button" onClick={() => setShowNewPw(v => !v)}
                  aria-label={showNewPw ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                  {showNewPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="label">Confirm new password</label>
              <input
                type="password"
                className="input"
                placeholder="Re-enter new password"
                value={pwForm.confirmPassword}
                onChange={(e) => setPwForm({ ...pwForm, confirmPassword: e.target.value })}
              />
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              onClick={() => pwMutation.mutate()}
              disabled={
                !pwForm.currentPassword ||
                !pwForm.newPassword ||
                pwForm.newPassword !== pwForm.confirmPassword ||
                pwForm.newPassword.length < 12 ||
                pwMutation.isPending
              }
              className="btn-primary disabled:opacity-50"
            >
              {pwMutation.isPending ? 'Updating...' : 'Update password'}
            </button>
            {pwForm.newPassword && pwForm.confirmPassword && pwForm.newPassword !== pwForm.confirmPassword && (
              <p className="text-xs text-[color:var(--danger-text)]">Passwords do not match</p>
            )}
            {pwMsg && (
              <p className={`text-sm ${pwMsg.includes('success') ? 'text-[color:var(--success-text)]' : 'text-[color:var(--danger-text)]'}`}>
                {pwMsg}
              </p>
            )}
          </div>
        </div>

        {isAdmin && (<>
        {/* Veteran discount */}
        <div data-demo-hide className="card lg:col-span-2">
          <div className="flex items-start gap-3">
            <span className="tile"><Shield className="w-4 h-4" /></span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold" style={{ color: 'var(--text)' }}>Veteran-owned and operated: 10% discount</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                Veteran-owned firms are eligible for a 10% discount on monthly subscription costs.
                To apply, contact us at <a href="mailto:support@bytescon.com?subject=Veteran Discount Request" className="text-gray-200 underline underline-offset-2">support@bytescon.com</a> with
                proof of veteran status (DD-214, VA letter, or SBA VetCert).
              </p>
            </div>
          </div>
          {firm?.isVeteranOwned ? (
            <div className="mt-4 flex items-center gap-2 text-xs text-[color:var(--success-text)] bg-[var(--success-bg)] rounded-xl px-3 py-2.5">
              <CheckCircle className="w-3.5 h-3.5 shrink-0" />
              Veteran discount active: 10% off your monthly plan. Thank you for your service.
            </div>
          ) : (
            <div className="panel mt-4 flex items-center gap-2 text-xs text-slate-500 px-3 py-2.5">
              <Shield className="w-3.5 h-3.5 shrink-0" />
              Not yet verified. Email us to get your veteran discount applied to your account.
            </div>
          )}
        </div>

        {/* AI Intelligence provider — fully configurable */}
        <div className="card lg:col-span-2">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="tile tile-sm"><Brain className="w-3.5 h-3.5" /></span>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text)' }}>AI Intelligence provider</h2>
            {/* The active provider is a state, so it reads as a success chip whichever provider it is. */}
            <div className="ml-auto chip chip-success">
              <span className="chip-dot" />
              {providerInfo.label} · active
            </div>
          </div>

          {/* Provider selector */}
          <div className="mb-4">
            <label className="label">Active provider</label>
            <div className="flex flex-wrap gap-3 items-center">
              <select
                className="input flex-1 min-w-[12rem]"
                value={selectedProvider || activeProvider}
                onChange={(e) => setSelectedProvider(e.target.value)}
              >
                {Object.entries(PROVIDER_LABELS).map(([val, info]) => (
                  <option key={val} value={val}>{info.label}</option>
                ))}
              </select>
              <button
                onClick={() => providerMutation.mutate(selectedProvider || activeProvider)}
                disabled={providerMutation.isPending || (selectedProvider || activeProvider) === activeProvider}
                className="btn-primary disabled:opacity-50 whitespace-nowrap"
              >
                {providerMutation.isPending ? 'Saving...' : 'Switch provider'}
              </button>
            </div>
            <p className="text-xs text-gray-600 mt-1">
              Claude uses the built-in platform key. OpenAI, Insight Engine, and LocalAI use your own keys below.
            </p>
          </div>

          {/* API Keys */}
          <div className="space-y-3 border-t border-gray-800 pt-4">
            <p className="overline">API Keys</p>

            {/* Anthropic */}
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="label">Anthropic (Claude) Key</label>
                <div className="relative">
                  <input
                    type={showAnthropicKey ? 'text' : 'password'}
                    className="input pr-10 font-mono text-sm"
                    placeholder={firm?.anthropicApiKeyConfigured ? '••••••••••••••••••••' : 'sk-ant-...'}
                    value={anthropicKey}
                    onChange={(e) => setAnthropicKey(e.target.value)}
                  />
                  <button type="button" onClick={() => setShowAnthropicKey(v => !v)}
                    aria-label={showAnthropicKey ? 'Hide key' : 'Show key'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                    {showAnthropicKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <button onClick={() => anthropicKeyMutation.mutate(anthropicKey)}
                disabled={!anthropicKey.trim() || anthropicKeyMutation.isPending}
                className="btn-primary disabled:opacity-50">
                {anthropicKeyMutation.isPending ? 'Saving...' : firm?.anthropicApiKeyConfigured ? 'Replace' : 'Save'}
              </button>
            </div>

            {/* OpenAI */}
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="label">OpenAI Key</label>
                <div className="relative">
                  <input
                    type={showOpenaiKey ? 'text' : 'password'}
                    className="input pr-10 font-mono text-sm"
                    placeholder={firm?.openaiApiKeyConfigured ? '••••••••••••••••••••' : 'sk-proj-...'}
                    value={openaiKey}
                    onChange={(e) => setOpenaiKey(e.target.value)}
                  />
                  <button type="button" onClick={() => setShowOpenaiKey(v => !v)}
                    aria-label={showOpenaiKey ? 'Hide key' : 'Show key'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                    {showOpenaiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <button onClick={() => openaiKeyMutation.mutate(openaiKey)}
                disabled={!openaiKey.trim() || openaiKeyMutation.isPending}
                className="btn-primary disabled:opacity-50">
                {openaiKeyMutation.isPending ? 'Saving...' : firm?.openaiApiKeyConfigured ? 'Replace' : 'Save'}
              </button>
            </div>

            {/* Insight Engine */}
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="label">Insight Engine key</label>
                <div className="relative">
                  <input
                    type={showInsightKey ? 'text' : 'password'}
                    className="input pr-10 font-mono text-sm"
                    placeholder={firm?.insightEngineApiKeyConfigured ? '••••••••••••••••••••' : 'sk-...'}
                    value={insightKey}
                    onChange={(e) => setInsightKey(e.target.value)}
                  />
                  <button type="button" onClick={() => setShowInsightKey(v => !v)}
                    aria-label={showInsightKey ? 'Hide key' : 'Show key'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                    {showInsightKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <button onClick={() => insightKeyMutation.mutate(insightKey)}
                disabled={!insightKey.trim() || insightKeyMutation.isPending}
                className="btn-primary disabled:opacity-50">
                {insightKeyMutation.isPending ? 'Saving...' : firm?.insightEngineApiKeyConfigured ? 'Replace' : 'Save'}
              </button>
            </div>

            {/* Ollama (Local) */}
            <div className="panel p-4 space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-semibold text-gray-100">Ollama: local AI engine</span>
                {(selectedProvider || activeProvider) === 'localai' && (
                  <span className="ml-auto chip chip-success">Active</span>
                )}
              </div>
              <p className="text-xs text-gray-500">
                Runs entirely on your machine, with no API costs. Default URL: <code className="text-gray-400 text-xs">http://localhost:11434/v1</code>
              </p>

              {/* Quick model reference */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {[
                  { model: 'mistral:7b-instruct', note: '4.1 GB · default · fast', recommended: true },
                  { model: 'llama3.1:8b',         note: '4.7 GB · 128k context'  },
                  { model: 'phi4:14b',             note: '9.1 GB · best analysis' },
                  { model: 'qwen2.5:14b',          note: '9.0 GB · best writing'  },
                ].map(({ model, note, recommended }) => (
                  <button
                    key={model}
                    onClick={() => setOllamaModel(model)}
                    className={`text-left px-2.5 py-1.5 rounded-lg transition-all border ${
                      ollamaModel === model
                        ? 'bg-[var(--accent-soft)] border-[color:var(--accent-line)] text-gray-100'
                        : 'bg-[var(--surface)] border-gray-700 text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    <span className="font-mono font-medium">{model}</span>
                    {recommended && <span className="ml-1.5 text-gray-500 font-normal">recommended</span>}
                    <br />
                    <span className="text-gray-600">{note}</span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-600">
                Pull a model: <code className="text-gray-400">docker exec bytescon_ollama ollama pull mistral:7b-instruct</code>
              </p>

              <div className="flex flex-wrap gap-3 items-end">
                <div className="flex-1 min-w-[10rem]">
                  <label className="label">Ollama API URL</label>
                  <input
                    type="text"
                    className="input font-mono text-sm"
                    placeholder="http://localhost:11434/v1"
                    value={ollamaUrl}
                    onChange={(e) => setOllamaUrl(e.target.value)}
                  />
                </div>
                <div className="flex-1 min-w-[10rem]">
                  <label className="label">Model</label>
                  <input
                    type="text"
                    className="input font-mono text-sm"
                    placeholder="mistral:7b-instruct"
                    value={ollamaModel}
                    onChange={(e) => setOllamaModel(e.target.value)}
                  />
                </div>
                <button
                  onClick={() => ollamaMutation.mutate()}
                  disabled={ollamaMutation.isPending}
                  className="btn-primary disabled:opacity-50 whitespace-nowrap"
                >
                  {ollamaMutation.isPending ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>

            {aiKeyMsg && (
              <p className={`text-sm ${aiKeyMsg.includes('failed') || aiKeyMsg.includes('Failed') ? 'text-[color:var(--danger-text)]' : 'text-[color:var(--success-text)]'}`}>
                {aiKeyMsg}
              </p>
            )}
          </div>

          {/* Usage summary */}
          <div className="border-t border-gray-800 pt-4 mt-4">
            <button
              type="button"
              onClick={() => setShowUsage((v) => !v)}
              className="btn-ghost btn-sm -ml-2"
            >
              <BarChart2 className="w-4 h-4" />
              {showUsage ? 'Hide' : 'Show'} AI Usage (last 30 days)
            </button>
            {showUsage && (
              <div className="mt-3">
                {!usageData ? (
                  <SkeletonRows rows={3} cols={3} />
                ) : (
                  <div className="space-y-3">
                    <div className="stagger grid grid-cols-3 gap-3">
                      <div className="panel px-3 py-2.5 text-center min-w-0">
                        <p className="text-lg font-semibold tabular-nums truncate text-gray-100">{usageData.data?.totalCalls ?? 0}</p>
                        <p className="text-xs text-gray-500">Total calls</p>
                      </div>
                      <div className="panel px-3 py-2.5 text-center min-w-0">
                        <p className="text-lg font-semibold tabular-nums truncate text-gray-100">
                          {((usageData.data?.totalInputTokens ?? 0) + (usageData.data?.totalOutputTokens ?? 0)).toLocaleString()}
                        </p>
                        <p className="text-xs text-gray-500">Total tokens</p>
                      </div>
                      <div className="panel px-3 py-2.5 text-center min-w-0">
                        <p className="text-lg font-semibold tabular-nums truncate text-gray-100">
                          ${(usageData.data?.totalCostUsd ?? 0).toFixed(4)}
                        </p>
                        <p className="text-xs text-gray-500">Est. Cost (USD)</p>
                      </div>
                    </div>
                    {(usageData.data?.byTask?.length ?? 0) > 0 && (
                      <div>
                        <p className="overline mb-2">By task</p>
                        <div className="space-y-1">
                          {usageData.data.byTask.map((t: any) => (
                            <div key={t.task} className="flex items-center justify-between text-xs">
                              <span className="text-gray-400">{t.task.replace(/_/g, ' ')}</span>
                              <span className="text-gray-300 tabular-nums">{t.calls} calls · ${Number(t.costUsd).toFixed(4)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {usageData.data?.totalCalls === 0 && (
                      <p className="text-xs text-gray-600 text-center py-2">No AI calls recorded in the last 30 days.</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Contract sync settings */}
        <div className="card lg:col-span-2">
          <div className="flex items-center gap-2.5 mb-2">
            <span className="tile tile-sm"><RefreshCw className="w-3.5 h-3.5" /></span>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text)' }}>Contract sync settings</h2>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            Control how the <strong className="text-gray-400">Sync contracts</strong> button works on the Opportunities page.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Contracts to fetch per sync</label>
              <select
                className="input"
                value={syncLimit}
                onChange={(e) => setSyncLimit(e.target.value)}
              >
                <option value="10">10 — quick refresh</option>
                <option value="25">25 — recommended</option>
                <option value="50">50 — more coverage</option>
                <option value="100">100 — maximum (takes longer)</option>
              </select>
              <p className="text-xs text-gray-600 mt-1">Larger numbers take longer but bring in more opportunities.</p>
            </div>
            <div>
              <label className="label">Industry filter <span className="text-gray-600">(optional)</span></label>
              <input
                className="input font-mono"
                placeholder="e.g. 541611 — leave blank for all industries"
                value={syncNaics}
                onChange={(e) => setSyncNaics(e.target.value)}
              />
              <p className="text-xs text-gray-600 mt-1">6-digit industry code. Leave blank to pull contracts from all industries.</p>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              onClick={() => {
                localStorage.setItem(SYNC_LIMIT_KEY, syncLimit);
                localStorage.setItem(SYNC_NAICS_KEY, syncNaics);
                setSyncSaveMsg('Sync settings saved.');
                setTimeout(() => setSyncSaveMsg(''), 3000);
              }}
              className="btn-primary"
            >
              Save sync settings
            </button>
            {syncSaveMsg && <p className="text-sm text-[color:var(--success-text)]">{syncSaveMsg}</p>}
          </div>
        </div>

        {/* Penalty configuration */}
        <div className="card">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="tile tile-sm"><Settings className="w-3.5 h-3.5" /></span>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text)' }}>Penalty engine configuration</h2>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            Configure how late submission penalties are calculated. Flat fee takes priority over percentage.
          </p>

          <div className="space-y-4">
            <div>
              <label className="label">Flat late fee ($)</label>
              <input
                type="number"
                className="input"
                placeholder="500.00"
                value={penaltyForm.flatLateFee}
                onChange={(e) => setPenaltyForm({ ...penaltyForm, flatLateFee: e.target.value })}
              />
              <p className="text-xs text-gray-600 mt-1">Fixed dollar amount applied to all late submissions.</p>
            </div>
            <div>
              <label className="label">Percentage of Estimated value (%)</label>
              <input
                type="number"
                className="input"
                placeholder="2.0"
                step="0.1"
                value={penaltyForm.penaltyPercent}
                onChange={(e) => setPenaltyForm({ ...penaltyForm, penaltyPercent: e.target.value })}
              />
              <p className="text-xs text-gray-600 mt-1">Used if no flat fee is set. E.g., 2% of $5M = $100K.</p>
            </div>

            {saveMsg && <p className="text-sm text-[color:var(--success-text)]">{saveMsg}</p>}

            <button
              onClick={() => penaltyMutation.mutate()}
              disabled={penaltyMutation.isPending}
              className="btn-primary"
            >
              {penaltyMutation.isPending ? 'Saving...' : 'Save configuration'}
            </button>
          </div>
        </div>

        </>)}

        {/* Platform users */}
        <div className="card">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="tile tile-sm"><Users className="w-3.5 h-3.5" /></span>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text)' }}>Platform users</h2>
          </div>
          <div className="space-y-3">
            {users.map((u: any) => (
              <div key={u.id} className="flex items-center justify-between gap-3 py-2.5 border-b border-gray-800 last:border-0">
                <div className="min-w-0">
                  <p className="text-sm text-gray-200">{u.firstName} {u.lastName}</p>
                  <p className="text-xs text-gray-500 truncate">{u.email}</p>
                </div>
                <div className="text-right">
                  <span className={`chip ${u.role === 'ADMIN' ? 'chip-accent' : 'chip-neutral'}`}>
                    {roleLabel(u.role)}
                  </span>
                  {u.lastLoginAt && (
                    <p className="text-xs text-gray-600 mt-1">Last login: {new Date(u.lastLoginAt).toLocaleDateString()}</p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Invite team member — emails a read-only (CONSULTANT) invite */}
          {isAdmin && (
          <div className="mt-5 pt-5 border-t border-gray-800">
            <div className="flex items-center gap-2 mb-1">
              <UserPlus className="w-4 h-4 text-gray-500" />
              <h3 className="text-base font-semibold text-gray-100">Invite team member</h3>
            </div>
            <p className="text-xs text-gray-500 mb-3">
              Sends an email invite. They set their own password from the link and get a{' '}
              <span className="text-gray-300">read-only</span> account — they can view the workspace
              (including Settings) but only admins can change firm data.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input className="input" placeholder="First name" value={memberForm.firstName}
                onChange={(e) => setMemberForm({ ...memberForm, firstName: e.target.value })} />
              <input className="input" placeholder="Last name" value={memberForm.lastName}
                onChange={(e) => setMemberForm({ ...memberForm, lastName: e.target.value })} />
              <input className="input sm:col-span-2" type="email" placeholder="Email" value={memberForm.email}
                onChange={(e) => setMemberForm({ ...memberForm, email: e.target.value })} />
            </div>
            <button
              type="button"
              onClick={() => addMemberMut.mutate()}
              disabled={!canAddMember || addMemberMut.isPending}
              className="btn-primary btn-sm mt-3 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <UserPlus className="w-3.5 h-3.5" />
              {addMemberMut.isPending ? 'Sending…' : 'Send invite'}
            </button>
            {memberMsg && <p className="mt-2 text-xs text-[color:var(--success-text)]">{memberMsg}</p>}
            {memberErr && <p className="mt-2 text-xs text-[color:var(--danger-text)]">{memberErr}</p>}
          </div>
          )}

          <div className="mt-4 pt-4 border-t border-gray-800">
            <p className="text-xs text-gray-600">
              Firm: <span className="text-gray-400">{firm?.name}</span><br />
              Contact: <span className="text-gray-400">{firm?.contactEmail}</span>
              {!isContractor && (<><br />Total clients: <span className="text-gray-400">{firm?._count?.clientCompanies}</span></>)}
            </p>
          </div>
        </div>

        {isAdmin && (<>
        {/* Template library review */}
        <div className="card lg:col-span-2">
          <div className="flex items-center gap-2.5 mb-2">
            <span className="tile tile-sm"><BookOpen className="w-3.5 h-3.5" /></span>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text)' }}>Template library review</h2>
            {pendingTemplates.length > 0 && (
              <span className="chip chip-neutral tabular-nums">
                {pendingTemplates.length} pending
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mb-4">
            When a client shares a document to the template library it enters <strong className="text-gray-400">Pending review</strong> status.
            Approve to make it available to all firms, or reject with a note.
            Approved templates are anonymized before sharing.
          </p>

          {templates.length === 0 ? (
            <p className="text-sm text-gray-600 py-4 text-center">No templates submitted yet.</p>
          ) : (
            <div className="stagger space-y-3">
              {templates.map((t: any) => (
                <div key={t.id} className="panel p-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-medium text-gray-200 truncate">{t.title}</p>
                        <StatusPill className="flex-shrink-0" status={t.status === 'APPROVED' ? 'approved' : t.status === 'REJECTED' ? 'neutral' : 'pending'}>{t.status}</StatusPill>
                      </div>
                      <p className="text-xs text-gray-500">
                        Type: {t.documentType} · Submitted by: {t.submittedByFirm?.name || 'Unknown'} ·{' '}
                        {new Date(t.createdAt).toLocaleDateString()} · {t.downloadCount} downloads
                      </p>
                      {t.description && <p className="text-xs text-gray-400 mt-1">{t.description}</p>}
                      {t.reviewNotes && (
                        <p className="text-xs text-gray-500 mt-1 italic">Review note: {t.reviewNotes}</p>
                      )}
                    </div>

                    {t.status === 'PENDING' && (
                      <div className="flex flex-col gap-2 flex-shrink-0">
                        <input
                          type="text"
                          placeholder="Optional review note..."
                          className="input text-xs w-52"
                          value={reviewNote[t.id] || ''}
                          onChange={(e) => setReviewNote((n) => ({ ...n, [t.id]: e.target.value }))}
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => reviewMutation.mutate({ id: t.id, status: 'APPROVED' })}
                            disabled={reviewMutation.isPending}
                            className="btn-secondary btn-sm flex-1"
                          >
                            <CheckCircle className="w-3.5 h-3.5" /> Approve
                          </button>
                          <button
                            onClick={() => reviewMutation.mutate({ id: t.id, status: 'REJECTED' })}
                            disabled={reviewMutation.isPending}
                            className="btn-danger btn-sm flex-1"
                          >
                            <XCircle className="w-3.5 h-3.5" /> Reject
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        </>)}

        {/* Tutorials */}
        <div className="card lg:col-span-2">
          <div className="flex items-center gap-2.5 mb-2">
            <span className="tile tile-sm"><PlayCircle className="w-3.5 h-3.5" /></span>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text)' }}>Tutorials</h2>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            Reset the first-visit tutorial overlays so they'll show again the next time you visit each section.
          </p>
          <button
            onClick={() => {
              tutorial.resetAll();
              setTutorialResetMsg('Tutorials reset — they will show again on your next visit to each section.');
              setTimeout(() => setTutorialResetMsg(''), 5000);
            }}
            className="btn-secondary flex items-center gap-2"
          >
            <PlayCircle className="w-4 h-4" />
            Rerun tutorials
          </button>
          {tutorialResetMsg && <p className="text-sm text-[color:var(--success-text)] mt-3">{tutorialResetMsg}</p>}
        </div>

        {isAdmin && (<>
        {/* MCP Access — connect AI agents to your opportunity data */}
        <div data-demo-hide className="card lg:col-span-2">
          <div className="flex items-center gap-2.5 mb-2">
            <span className="tile tile-sm"><Plug className="w-3.5 h-3.5" /></span>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text)' }}>MCP access · AI agent connection</h2>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            Connect Claude directly to your opportunity intelligence. Generate an access token below
            (shown only once), add the single connector URL in Claude, and sign in by pasting your token.
            One connector gives Claude all 27 Bytesgov tools.
          </p>

          <div className="mb-4 flex flex-col gap-1.5">
            <span className="text-sm font-medium text-gray-200">Connection walkthroughs (PDF)</span>
            <a href="/guides/gemini-connection-walkthrough.pdf" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-200 underline underline-offset-2 decoration-[color:var(--line-strong)] hover:decoration-current">
              <BookOpen className="w-3.5 h-3.5" /> Gemini connection walkthrough
            </a>
            <a href="/guides/chatgpt-connection-walkthrough.pdf" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-200 underline underline-offset-2 decoration-[color:var(--line-strong)] hover:decoration-current">
              <BookOpen className="w-3.5 h-3.5" /> ChatGPT connection walkthrough
            </a>
            <a href="/guides/perplexity-connection-walkthrough.pdf" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-200 underline underline-offset-2 decoration-[color:var(--line-strong)] hover:decoration-current">
              <BookOpen className="w-3.5 h-3.5" /> Perplexity connection walkthrough
            </a>
          </div>

          <div className="panel p-3.5 mb-4 text-xs space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-gray-500 shrink-0">Connector URL</span>
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-gray-300 truncate">{mcpUrl}</span>
                <button
                  onClick={copyMcpUrl}
                  className="btn-secondary text-xs flex items-center gap-1 shrink-0 py-0.5"
                >
                  <Copy className="w-3 h-3" /> {mcpUrlCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-gray-500">Auth</span>
              <span className="text-gray-300">OAuth: sign in with your access token</span>
            </div>
          </div>

          {newMcpToken && (
            <div className="bg-[var(--warning-bg)] rounded-2xl p-4 mb-4">
              <p className="text-xs text-[color:var(--warning)] font-medium mb-2">Copy this token now. It will not be shown again.</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs text-gray-100 bg-[var(--surface)] rounded-lg px-2.5 py-1.5 break-all">{newMcpToken}</code>
                <button onClick={copyMcpToken} className="btn-secondary text-xs flex items-center gap-1.5 shrink-0">
                  <Copy className="w-3.5 h-3.5" /> {mcpCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
                <p className="text-xs text-gray-200 font-medium mb-2">Add it in Claude:</p>
                <ol className="space-y-1.5 text-xs text-gray-300 list-decimal list-inside">
                  <li>In Claude, open <span className="text-gray-200">Settings, then Connectors</span>.</li>
                  <li>Click <span className="text-gray-200">"Add custom connector"</span>.</li>
                  <li>Paste the connector URL above and click <span className="text-gray-200">Connect</span>.</li>
                  <li>When prompted to sign in, paste the access token above on the Bytesgov sign-in page.</li>
                </ol>
              </div>
            </div>
          )}

          <button
            onClick={() => createMcpTokenMut.mutate()}
            disabled={createMcpTokenMut.isPending}
            className="btn-primary flex items-center gap-2 disabled:opacity-50"
          >
            <Plug className="w-4 h-4" />
            {createMcpTokenMut.isPending ? 'Generating…' : 'Generate access token'}
          </button>
          {createMcpTokenMut.isError && <p className="text-sm text-[color:var(--danger-text)] mt-2">Failed to generate token. Try again.</p>}

          {mcpTokens.length > 0 && (
            <div className="mt-5">
              <p className="overline mb-2">Active tokens</p>
              <div className="space-y-1.5">
                {mcpTokens.map((t) => (
                  <div key={t.id} className="panel flex flex-wrap items-center gap-2 text-xs px-3 py-2">
                    <span className="font-mono text-gray-400">{t.tokenPrefix}…</span>
                    <span className="text-gray-300">{t.name}</span>
                    {t.revokedAt ? (
                      <span className="chip chip-danger">Revoked</span>
                    ) : (
                      <span className="chip chip-success">Active</span>
                    )}
                    <span className="ml-auto text-gray-600">
                      {t.lastUsedAt ? `used ${new Date(t.lastUsedAt).toLocaleDateString()}` : 'never used'}
                    </span>
                    {!t.revokedAt && (
                      <button
                        onClick={() => { if (confirm('Revoke this token? Clients using it will stop working.')) revokeMcpTokenMut.mutate(t.id); }}
                        disabled={revokeMcpTokenMut.isPending}
                        className="text-[color:var(--danger-text)] hover:opacity-80 disabled:opacity-50"
                        title="Revoke token"
                        aria-label="Revoke token"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <PublicApiTokens />
        {/* White-label branding. The panel existed but was never mounted, so
            the firm-branding routes had no way in from the application. */}
        <div className="card"><BrandingSettings /></div>
        {/* Subdomain + custom-domain configuration for the white-label portal.
            Same story: written in the source codebase, mounted nowhere. */}
        {/* The domain is for the client portal, which contractor accounts don't have. */}
        {!isContractor && <div className="card lg:col-span-2"><DomainSettings /></div>}
        </>)}
      </div>
    </div>
  );
}
