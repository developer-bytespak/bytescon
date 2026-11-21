import { useState, useRef, useCallback } from 'react';
import { TutorialOverlay } from '../components/TutorialOverlay';
import { useTutorial } from '../hooks/useTutorial';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { clientsApi, clientPortalUsersApi } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { useProfileStatus } from '../hooks/useProfileStatus'
import { useToast } from '../components/Toast';
import { PageHeader, SkeletonCards, EmptyState, ErrorBanner, formatCurrency } from '../components/ui';
import { Plus, CheckCircle, XCircle, Shield, KeyRound, X, Search, Loader2, Upload, Download, FileSpreadsheet, AlertTriangle } from 'lucide-react';
import { NaicsPicker } from '../components/NaicsPicker';
import { stateOptions, toStateCode } from '../lib/usStates';
import * as rules from '../lib/companyFieldRules';

// ── CSV template definition ───────────────────────────────────────────────────
const CSV_HEADERS = [
  'company_name', 'uei', 'cage', 'ein', 'naics_codes', 'psc_codes',
  'sdvosb', 'wosb', 'hubzone', 'eight_a', 'small_business',
  'phone', 'website', 'street_address', 'city', 'state', 'zip_code',
];

const CSV_EXAMPLE_ROWS = [
  [
    'Acme Defense Solutions LLC', 'QDFNQQ83G946', '9V5E3', '12-3456789', '484121|541614', 'V112|R425',
    'yes', 'no', 'no', 'no', 'yes',
    '(555) 123-4567', 'https://acmedefense.com', '123 Main St', 'Arlington', 'VA', '22201',
  ],
  [
    'Apex Federal Advisory LLC', '', '', '', '541611', '',
    'no', 'yes', 'no', 'no', 'yes',
    '(703) 555-0100', '', '456 Oak Ave', 'Reston', 'VA', '20190',
  ],
];

function downloadTemplate() {
  const rows = [CSV_HEADERS, ...CSV_EXAMPLE_ROWS];
  const csv = rows.map((r) => r.map((v) => (v.includes(',') ? `"${v}"` : v)).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'bytesgov_client_import_template.csv';
  a.click(); URL.revokeObjectURL(url);
}

// ── Import Modal ─────────────────────────────────────────────────────────────
function ImportCsvModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ created: number; skipped: number; errors: string[]; total: number } | null>(null);
  const [importError, setImportError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith('.csv')) setFile(f);
    else setImportError('Please upload a .csv file');
  }, []);

  const handleImport = async () => {
    if (!file) return;
    setLoading(true); setImportError('');
    try {
      const res = await clientsApi.importCsv(file);
      setResult(res.data);
      if (res.data.created > 0) onSuccess();
    } catch (err: any) {
      setImportError(err?.response?.data?.error || 'Import failed — please check your file format');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4">
      <div className="modal-panel w-full max-w-xl relative max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between px-7 pt-6 pb-2">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
            <h3 className="v3-h3" style={{ color: 'var(--text)' }}>Import client roster</h3>
          </div>
          <button onClick={onClose} aria-label="Close" className="btn-ghost btn-sm !px-2">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-7 pt-3 pb-7 space-y-4">

          {/* Download template */}
          <div className="panel px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-100">1. Download the template</p>
              <p className="text-[13px] text-slate-400 mt-0.5">
                Fill in your client data. Use <code className="text-slate-200">|</code> to separate multiple NAICS codes.
                Use <code className="text-slate-200">yes</code> / <code className="text-slate-200">no</code> for certifications.
              </p>
            </div>
            <button onClick={downloadTemplate} className="btn-secondary btn-sm flex-shrink-0 ml-3">
              <Download className="w-3.5 h-3.5" /> Template
            </button>
          </div>

          {/* Column guide */}
          <div className="panel px-4 py-3 text-xs space-y-1">
            <p className="text-[13px] font-semibold text-slate-200 mb-1.5">Column reference</p>
            {[
              ['company_name', 'Required · Legal company name'],
              ['uei', 'Optional · 12-char SAM.gov identifier'],
              ['cage', 'Optional · 5-char CAGE code'],
              ['ein', 'Optional · Tax ID (XX-XXXXXXX)'],
              ['naics_codes', 'Optional · 6-digit codes separated by |'],
              ['psc_codes', 'Optional · 4-char product/service codes separated by |'],
              ['sdvosb / wosb / hubzone / eight_a', 'Optional · yes or no'],
              ['small_business', 'Optional · yes or no (defaults to yes)'],
              ['phone, website, address fields', 'Optional · contact & location info'],
            ].map(([col, desc]) => (
              <div key={col} className="flex gap-2">
                <code className="text-slate-200 w-44 flex-shrink-0">{col}</code>
                <span className="text-slate-400">{desc}</span>
              </div>
            ))}
          </div>

          {/* Upload zone */}
          {!result && (
            <>
              <p className="text-sm font-semibold text-slate-100">2. Upload your completed file</p>
              <div
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                data-active={dragging}
                className="dropzone cursor-pointer flex flex-col items-center justify-center py-10 gap-3 transition-colors"
              >
                <Upload className="w-7 h-7" style={{ color: file ? 'var(--success)' : 'var(--text-muted)' }} />
                {file ? (
                  <>
                    <p className="text-sm font-semibold" style={{ color: 'var(--success-text)' }}>{file.name}</p>
                    <p className="text-xs text-slate-400">{(file.size / 1024).toFixed(1)} KB · Click to replace</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-slate-300">Drag and drop your CSV here, or <span className="underline">browse</span></p>
                    <p className="text-xs text-slate-500">CSV files only · Max 2 MB</p>
                  </>
                )}
                <input ref={inputRef} type="file" accept=".csv" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); }} />
              </div>
            </>
          )}

          {/* Error */}
          {importError && (
            <div className="flex items-start gap-2 text-sm rounded-xl px-3 py-2.5"
              style={{ background: 'var(--danger-bg)', color: 'var(--danger-text)' }}>
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {importError}
            </div>
          )}

          {/* Results */}
          {result && (
            <div className="panel overflow-hidden">
              <div className="px-4 py-3 flex items-center gap-2" style={{ borderBottom: '1px solid var(--line)' }}>
                <CheckCircle className="w-4 h-4" style={{ color: result.created > 0 ? 'var(--success)' : 'var(--text-muted)' }} />
                <p className="font-semibold text-slate-100 text-sm">Import complete</p>
              </div>
              <div className="px-4 py-3 grid grid-cols-3 gap-3 text-center">
                <div>
                  <p className="text-[28px] leading-9 font-semibold tabular-nums text-slate-100">{result.created}</p>
                  <p className="text-xs text-slate-400">Clients added</p>
                </div>
                <div>
                  <p className="text-[28px] leading-9 font-semibold tabular-nums text-slate-100">{result.skipped}</p>
                  <p className="text-xs text-slate-400">Already existed</p>
                </div>
                <div>
                  <p className="text-[28px] leading-9 font-semibold tabular-nums" style={{ color: result.errors.length ? 'var(--danger-text)' : 'var(--text)' }}>{result.errors.length}</p>
                  <p className="text-xs text-slate-400">Errors</p>
                </div>
              </div>
              {result.errors.length > 0 && (
                <div className="px-4 py-3 space-y-1" style={{ borderTop: '1px solid var(--line)' }}>
                  <p className="text-xs font-semibold mb-1" style={{ color: 'var(--danger-text)' }}>Row errors</p>
                  {result.errors.map((e, i) => (
                    <p key={i} className="text-xs text-slate-400">{e}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            {!result ? (
              <>
                <button onClick={handleImport} disabled={!file || loading}
                  className="btn-primary flex items-center gap-2 flex-1 justify-center disabled:opacity-50">
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  {loading ? 'Importing…' : 'Import clients'}
                </button>
                <button onClick={onClose} className="btn-secondary">Cancel</button>
              </>
            ) : (
              <button onClick={onClose} className="btn-primary w-full justify-center flex items-center gap-2">
                <CheckCircle className="w-4 h-4" /> Done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const EMPTY_FORM = {
  name: '', cage: '', uei: '', ein: '', naicsCodes: '', pscCodes: '',
  sdvosb: false, wosb: false, hubzone: false, eightA: false, smallBusiness: true,
  phone: '', website: '', streetAddress: '', city: '', state: '', zipCode: '',
  samRegStatus: '', capabilityKeywords: '',
};

const splitCsv = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * A client added here starts with a complete profile (the server checks the
 * same: backend services/profileCompleteness.ts newProfileProblems). Past
 * performance is optional. Returns each problem, or [] when ready.
 */
function newClientProblems(form: typeof EMPTY_FORM): string[] {
  const problems: string[] = [];
  const nameError = rules.companyName(form.name);
  if (nameError) problems.push(nameError);
  if (!form.state) problems.push('State is required');
  if (!splitCsv(form.naicsCodes).length) problems.push('At least one NAICS code is required');
  if (!form.uei.trim()) problems.push('UEI is required');
  else { const e = rules.uei(form.uei); if (e) problems.push(e); }
  if (!form.samRegStatus) problems.push('SAM.gov registration status is required');
  if (!splitCsv(form.capabilityKeywords).length) problems.push('At least one capability keyword is required');
  return problems;
}

export function ClientsPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const { toast } = useToast();
  const [showArchivedClients, setShowArchivedClients] = useState(false);
  const tutorial = useTutorial();
  const [showTutorial, setShowTutorial] = useState(() => !tutorial.hasSeen('clients'));
  function handleTutorialClose() { tutorial.markSeen('clients'); setShowTutorial(false); }
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');

  // SAM.gov lookup state
  const [lookupQuery, setLookupQuery] = useState('');
  const [lookupType, setLookupType] = useState<'uei' | 'cage' | 'name'>('uei');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [lookupResult, setLookupResult] = useState<any>(null);

  // Portal access state
  const [portalClientId, setPortalClientId] = useState<string | null>(null);
  const [portalClientName, setPortalClientName] = useState('');
  const [portalForm, setPortalForm] = useState({ email: '', password: '', firstName: '', lastName: '' });
  const [portalError, setPortalError] = useState('');
  const [portalSuccess, setPortalSuccess] = useState('');

  const portalMutation = useMutation({
    mutationFn: () => clientPortalUsersApi.register({
      clientCompanyId: portalClientId!,
      ...portalForm,
    }),
    onSuccess: () => {
      setPortalSuccess(`Portal access created for ${portalForm.email}. They can now log in at /client-login.`);
      setPortalForm({ email: '', password: '', firstName: '', lastName: '' });
    },
    onError: (err: any) => setPortalError(err?.response?.data?.error || 'Failed to create portal access'),
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ['clients', showArchivedClients],
    queryFn: () => clientsApi.list({ limit: 100, includeArchived: showArchivedClients || undefined }),
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => clientsApi.archive(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['clients'] }); toast('Client archived', 'success'); },
    onError: (e: any) => toast(e?.response?.data?.error || 'Failed to archive client', 'error'),
  });
  const restoreMutation = useMutation({
    mutationFn: (id: string) => clientsApi.restore(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['clients'] }); toast('Client restored', 'success'); },
    onError: (e: any) => toast(e?.response?.data?.error || 'Failed to restore client', 'error'),
  });

  const createMutation = useMutation({
    mutationFn: (body: any) => clientsApi.create(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      setShowCreate(false);
      setForm(EMPTY_FORM);
      setLookupResult(null);
      setLookupQuery('');
    },
    onError: (err: any) => setFormError(err.response?.data?.error || 'Create failed'),
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    const problems = newClientProblems(form);
    if (problems.length) { setFormError(`Fill in the client's profile: ${problems.join('; ')}.`); return; }
    createMutation.mutate({
      // The form asks the small-business and set-aside questions (profile completeness).
      setAsideStatusConfirmed: true,
      ...form,
      uei: form.uei.trim().toUpperCase(),
      capabilityKeywords: splitCsv(form.capabilityKeywords),
      naicsCodes: form.naicsCodes.split(',').map((s: string) => s.trim()).filter(Boolean),
      pscCodes: form.pscCodes.split(',').map((s: string) => s.trim().toUpperCase()).filter(Boolean),
    });
  };

  const handleSamLookup = async () => {
    if (!lookupQuery.trim()) return;
    setLookupLoading(true);
    setLookupError('');
    setLookupResult(null);
    try {
      const params =
        lookupType === 'uei'  ? { uei: lookupQuery.trim() } :
        lookupType === 'cage' ? { cage: lookupQuery.trim() } :
                                { name: lookupQuery.trim() };
      const res = await clientsApi.samLookup(params);
      const d = res.data;
      setLookupResult(d);
      // Pre-fill the create form
      setForm({
        name: d.name || '',
        cage: d.cage || '',
        uei: d.uei || '',
        ein: '',
        naicsCodes: (d.naicsCodes || []).join(', '),
        pscCodes: '',
        sdvosb: !!d.sdvosb,
        wosb: !!d.wosb,
        hubzone: !!d.hubzone,
        eightA: !!d.eightA,
        smallBusiness: !!d.smallBusiness,
        phone: d.phone || '',
        website: d.website || '',
        streetAddress: d.streetAddress || '',
        city: d.city || '',
        state: toStateCode(d.state) ?? d.state ?? '',
        zipCode: d.zipCode || '',
        samRegStatus: d.samRegStatus === 'Active' ? 'Active' : d.samRegStatus ? 'Inactive' : '',
        capabilityKeywords: '',
      });
      setShowCreate(true);
    } catch (err: any) {
      setLookupError(err?.response?.data?.error || 'Lookup failed — entity not found or SAM.gov unavailable');
    } finally {
      setLookupLoading(false);
    }
  };

  const clients = data?.data || [];

  return (
    <div>
      {showTutorial && <TutorialOverlay sectionKey="clients" onClose={handleTutorialClose} />}
      <PageHeader title="Client companies" subtitle="Government contractor portfolio">
        <label className="flex items-center gap-2 text-[13px] text-gray-400 cursor-pointer mr-1">
          <input type="checkbox" checked={showArchivedClients} onChange={(e) => setShowArchivedClients(e.target.checked)} /> Show archived
        </label>
        <button onClick={() => setShowImport(true)} className="btn-secondary flex items-center gap-2">
          <Upload className="w-4 h-4" />
          Import CSV
        </button>
        <button onClick={() => { setShowCreate(!showCreate); setLookupResult(null); }} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Add client
        </button>
      </PageHeader>

      {showImport && (
        <ImportCsvModal
          onClose={() => setShowImport(false)}
          onSuccess={() => qc.invalidateQueries({ queryKey: ['clients'] })}
        />
      )}

      {/* SAM.gov Quick Lookup */}
      <div className="v3-surface mb-6">
        <h2 className="v3-h3 text-gray-100 mb-1 flex items-center gap-2">
          <Search className="w-4 h-4" /> SAM.gov entity lookup
        </h2>
        <p className="text-[13px] text-gray-400 mb-4">
          Enter a UEI, CAGE code, or company name to auto-populate client details from SAM.gov.
          <span className="text-gray-500"> (EIN/Tax ID lookup is not available via the public SAM API.)</span>
        </p>
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="label">Search by</label>
            <select className="input w-36" value={lookupType} onChange={(e) => { setLookupType(e.target.value as 'uei' | 'cage' | 'name'); setLookupQuery(''); }}>
              <option value="uei">UEI (exact)</option>
              <option value="cage">CAGE code</option>
              <option value="name">Company name</option>
            </select>
          </div>
          <div className="flex-1 min-w-48">
            <label className="label">
              {lookupType === 'uei'  ? 'UEI (12 letters or digits)' :
               lookupType === 'cage' ? 'CAGE code (5 characters)' :
                                       'Legal business name (as registered in SAM.gov)'}
            </label>
            <input
              className="input"
              value={lookupQuery}
              onChange={(e) => setLookupQuery(e.target.value)}
              placeholder={
                lookupType === 'uei'  ? 'QDFNQQ83G946' :
                lookupType === 'cage' ? '9V5E3' :
                                        'Acme Defense Solutions LLC'
              }
              onKeyDown={(e) => e.key === 'Enter' && handleSamLookup()}
            />
          </div>
          <button
            onClick={handleSamLookup}
            disabled={lookupLoading || !lookupQuery.trim()}
            className="btn-primary flex items-center gap-2"
          >
            {lookupLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            {lookupLoading ? 'Looking up…' : 'Look up'}
          </button>
        </div>
        {lookupError && (
          <div className="mt-4 p-4 rounded-2xl" style={{ background: 'var(--danger-bg)' }}>
            <p className="text-sm font-semibold mb-1" style={{ color: 'var(--danger-text)' }}>Lookup failed</p>
            <p className="text-[13px] mb-2" style={{ color: 'var(--danger-text)' }}>{lookupError}</p>
            <p className="text-[13px] text-gray-400 mb-3">
              Tips: UEI must be exactly 12 alphanumeric chars. CAGE codes are 5 chars. For name search, use the exact legal name from SAM.gov.
            </p>
            <button
              onClick={() => { setShowCreate(true); setLookupError(''); }}
              className="btn-secondary btn-sm"
            >
              Enter details manually instead
            </button>
          </div>
        )}
        {lookupResult && (
          <div className="mt-4 p-4 rounded-2xl text-sm" style={{ background: 'var(--success-bg)' }}>
            <p className="font-medium mb-1" style={{ color: 'var(--success-text)' }}>
              Found: <span className="text-gray-50">{lookupResult.name ?? '(no name returned)'}</span>
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[13px] text-gray-400">
              {lookupResult.uei && <span>UEI: <span className="text-gray-200">{lookupResult.uei}</span></span>}
              {lookupResult.cage && <span>CAGE: <span className="text-gray-200">{lookupResult.cage}</span></span>}
              {lookupResult.samRegStatus && (
                <span>SAM: <span style={{ color: lookupResult.samRegStatus === 'Active' ? 'var(--success-text)' : 'var(--warning)' }}>{lookupResult.samRegStatus}</span></span>
              )}
              {lookupResult.city && <span>{lookupResult.city}{lookupResult.state ? `, ${lookupResult.state}` : ''}</span>}
              {lookupResult.naicsCodes?.length > 0 && (
                <span>{lookupResult.naicsCodes.length} NAICS code{lookupResult.naicsCodes.length > 1 ? 's' : ''}</span>
              )}
            </div>
            <p className="text-[13px] text-gray-300 mt-1">
              Form has been pre-filled below. Review certifications and click Create client.
            </p>
          </div>
        )}
      </div>

      {/* Create Form */}
      {showCreate && (
        <div className="v3-surface mb-6">
          <h2 className="v3-h3 text-gray-100 mb-1">New client company</h2>
          <p className="text-[13px] text-gray-400 mb-5">Fields marked * make up the client's profile. With them filled in, scoring, analysis and proposals work for this client straight away. Past performance can be added later.</p>
          <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Core IDs */}
            <div>
              <label className="label" htmlFor="client-name">Company name *</label>
              <input id="client-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div>
              <label className="label">EIN / Tax ID</label>
              <input className="input" value={form.ein} onChange={(e) => setForm({ ...form, ein: e.target.value })} placeholder="12-3456789" />
            </div>
            <div>
              <label className="label" htmlFor="client-uei">UEI *</label>
              <input id="client-uei" className="input" maxLength={12} value={form.uei} onChange={(e) => setForm({ ...form, uei: e.target.value.toUpperCase() })} placeholder="12 letters or digits" required />
            </div>
            <div>
              <label className="label">CAGE code</label>
              <input className="input" value={form.cage} onChange={(e) => setForm({ ...form, cage: e.target.value })} />
            </div>
            <div className="md:col-span-2">
              <NaicsPicker
                label="NAICS codes *"
                selected={form.naicsCodes ? form.naicsCodes.split(',').map(s => s.trim()).filter(Boolean) : []}
                onChange={(codes) => setForm({ ...form, naicsCodes: codes.join(', ') })}
              />
            </div>
            <div className="md:col-span-2">
              <label className="label">PSC codes</label>
              <input className="input" value={form.pscCodes} onChange={(e) => setForm({ ...form, pscCodes: e.target.value })} placeholder="V112, R425" />
              <p className="text-xs text-gray-500 mt-1">Product/Service Codes this client is qualified for, comma-separated. Improves opportunity matching alongside NAICS.</p>
            </div>

            <div>
              <label className="label" htmlFor="client-sam">SAM.gov registration status *</label>
              <select id="client-sam" className="input" value={form.samRegStatus} onChange={(e) => setForm({ ...form, samRegStatus: e.target.value })} required>
                <option value="">Choose…</option>
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="client-keywords">Capability keywords *</label>
              <input id="client-keywords" className="input" value={form.capabilityKeywords} onChange={(e) => setForm({ ...form, capabilityKeywords: e.target.value })} placeholder="e.g. network engineering, HVAC maintenance" required />
              <p className="text-xs text-gray-500 mt-1">Comma-separated. Used in scoring and by the AI.</p>
            </div>

            {/* Contact & Address */}
            <div>
              <label className="label">Phone</label>
              <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="(555) 123-4567" />
            </div>
            <div>
              <label className="label">Website</label>
              <input className="input" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://example.com" />
            </div>
            <div className="md:col-span-2">
              <label className="label">Street address</label>
              <input className="input" value={form.streetAddress} onChange={(e) => setForm({ ...form, streetAddress: e.target.value })} placeholder="123 Main St" />
            </div>
            <div>
              <label className="label">City</label>
              <input className="input" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label" htmlFor="client-state">State *</label>
                <select id="client-state" className="input" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} required>
                  <option value="">Choose…</option>
                  {stateOptions(form.state).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label className="label">ZIP</label>
                <input className="input" value={form.zipCode} onChange={(e) => setForm({ ...form, zipCode: e.target.value })} placeholder="20001" />
              </div>
            </div>

            {/* Certifications */}
            <div className="md:col-span-2">
              <label className="label">Small-business and set-aside status *</label>
              <p className="text-xs text-gray-500 mb-2">Tick each that applies; leaving all unticked means none. Creating the client confirms these answers.</p>
              <div className="flex flex-wrap gap-4">
                {[
                  { key: 'sdvosb', label: 'SDVOSB' },
                  { key: 'wosb', label: 'WOSB' },
                  { key: 'hubzone', label: 'HUBZone' },
                  { key: 'eightA', label: '8(a)' },
                  { key: 'smallBusiness', label: 'Small business' },
                ].map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={(form as any)[key]}
                      onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
                    />
                    <span className="text-sm text-gray-300">{label}</span>
                  </label>
                ))}
              </div>
            </div>

            {formError && <div className="md:col-span-2"><ErrorBanner message={formError} /></div>}

            <div className="md:col-span-2 flex gap-2">
              <button type="submit" disabled={createMutation.isPending} className="btn-primary">
                {createMutation.isPending ? 'Creating…' : 'Create client'}
              </button>
              <button type="button" onClick={() => { setShowCreate(false); setLookupResult(null); }} className="btn-secondary">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Portal Access Modal */}
      {portalClientId && (
        <div className="modal-backdrop fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="modal-panel w-full max-w-md p-7">
            <div className="flex items-start justify-between gap-3 mb-2">
              <h3 className="v3-h3 text-gray-100 flex items-center gap-2">
                <KeyRound className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                Client portal access for {portalClientName}
              </h3>
              <button onClick={() => { setPortalClientId(null); setPortalSuccess(''); setPortalError(''); }}
                aria-label="Close" className="btn-ghost btn-sm !px-2"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-[13px] text-gray-400 mb-5">
              Create login credentials for a contact at this client company. They will log in at <code className="text-gray-200">/client-login</code>.
            </p>
            {portalSuccess ? (
              <div className="rounded-xl p-3 text-sm" style={{ background: 'var(--success-bg)', color: 'var(--success-text)' }}>{portalSuccess}</div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">First name</label>
                    <input className="input" value={portalForm.firstName}
                      onChange={(e) => setPortalForm({ ...portalForm, firstName: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">Last name</label>
                    <input className="input" value={portalForm.lastName}
                      onChange={(e) => setPortalForm({ ...portalForm, lastName: e.target.value })} />
                  </div>
                </div>
                <div>
                  <label className="label">Email</label>
                  <input type="email" className="input" value={portalForm.email}
                    onChange={(e) => setPortalForm({ ...portalForm, email: e.target.value })} />
                </div>
                <div>
                  <label className="label">Temporary password</label>
                  <input type="password" className="input" value={portalForm.password}
                    onChange={(e) => setPortalForm({ ...portalForm, password: e.target.value })} />
                </div>
                {portalError && <ErrorBanner message={portalError} />}
                <button
                  onClick={() => { setPortalError(''); portalMutation.mutate(); }}
                  disabled={!portalForm.email || !portalForm.password || !portalForm.firstName || portalMutation.isPending}
                  className="btn-primary w-full"
                >
                  {portalMutation.isPending ? 'Creating…' : 'Create portal access'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {isLoading && <div className="mt-2"><span className="sr-only">Loading…</span><SkeletonCards count={6} /></div>}
      {error && <ErrorBanner message="Failed to load clients" />}
      {!isLoading && clients.length === 0 && (
        <EmptyState
          message="No clients yet. Add your first client company."
          hint={null}
          action={
            <button onClick={() => { setShowCreate(!showCreate); setLookupResult(null); }} className="btn-primary btn-sm flex items-center gap-2">
              <Plus className="w-4 h-4" />
              Add client
            </button>
          }
        />
      )}

      <div className="stagger grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {clients.map((client: any) => (
          <div key={client.id} className={`card relative min-w-0 ${client.archivedAt ? 'opacity-60' : 'card-interactive'}`}>
          {client.archivedAt ? (
            isAdmin && (
              <button
                onClick={(e) => { e.preventDefault(); restoreMutation.mutate(client.id); }}
                title="Restore client"
                className="btn-ghost btn-sm absolute top-4 right-4"
              >
                Restore
              </button>
            )
          ) : (
            <button
              onClick={(e) => {
                e.preventDefault();
                setPortalClientId(client.id);
                setPortalClientName(client.name);
                setPortalSuccess('');
                setPortalError('');
              }}
              title="Grant client portal access"
              aria-label="Grant client portal access"
              className="absolute top-4 right-4 p-2 rounded-full text-gray-400 hover:text-gray-100 hover:bg-gray-800 transition-colors"
            >
              <KeyRound className="w-4 h-4" />
            </button>
          )}
          <Link to={`/clients/${client.id}`} className="block">
            <div className="flex items-start justify-between gap-3 mb-3 pr-8">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-gray-100 truncate">{client.name}{client.archivedAt && <span className="chip chip-neutral ml-2 align-middle">Archived</span>}</h3>
                {client.uei && <p className="text-[13px] text-gray-400 mt-0.5">UEI {client.uei}</p>}
                <ProfileBadge clientId={client.id} />
              </div>
              {client.sdvosb && (
                <span className="chip chip-neutral flex-shrink-0">
                  <Shield className="w-3 h-3" />
                  SDVOSB
                </span>
              )}
            </div>

            {/* NAICS */}
            {client.naicsCodes?.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-3">
                {client.naicsCodes.slice(0, 3).map((code: string) => (
                  <span key={code} className="chip chip-neutral">
                    {code}
                  </span>
                ))}
                {client.naicsCodes.length > 3 && (
                  <span className="text-xs text-gray-500">+{client.naicsCodes.length - 3}</span>
                )}
              </div>
            )}

            {/* Stats */}
            {client.performanceStats && (
              <div className="border-t pt-4 grid grid-cols-2 gap-2" style={{ borderColor: 'var(--line)' }}>
                <div>
                  <p className="text-[13px] text-gray-400">Completion rate</p>
                  <div className="flex items-center gap-1">
                    {client.performanceStats.completionRate >= 0.8 ? (
                      <CheckCircle className="w-3.5 h-3.5" style={{ color: 'var(--success)' }} />
                    ) : (
                      <XCircle className="w-3.5 h-3.5" style={{ color: 'var(--danger)' }} />
                    )}
                    <span className="text-base font-semibold tabular-nums text-gray-100">
                      {Math.round(client.performanceStats.completionRate * 100)}%
                    </span>
                  </div>
                </div>
                <div>
                  <p className="text-[13px] text-gray-400">Penalties</p>
                  <p className="text-base font-semibold tabular-nums" style={{ color: client.performanceStats.totalPenalties > 0 ? 'var(--danger-text)' : 'var(--text)' }}>
                    {formatCurrency(client.performanceStats.totalPenalties)}
                  </p>
                </div>
              </div>
            )}
          </Link>
        </div>
        ))}
      </div>
    </div>
  );
}


/** Profile completeness on a client card: scoring and proposals are off until it's complete. */
function ProfileBadge({ clientId }: { clientId: string }) {
  const { data } = useProfileStatus()
  const status = data?.clients.find((c) => c.clientCompanyId === clientId)
  if (!status) return null
  return status.complete
    ? <span className="chip chip-success mt-2">Profile complete</span>
    : <span className="chip badge-yellow mt-2" title={`Missing: ${status.missing.map((m) => m.label).join(', ')}`}>Profile {status.percent}% · incomplete</span>
}
