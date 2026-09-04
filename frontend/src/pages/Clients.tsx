import { useState, useRef, useCallback } from 'react';
import { TutorialOverlay } from '../components/TutorialOverlay';
import { useTutorial } from '../hooks/useTutorial';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { clientsApi, clientPortalUsersApi } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import { PageHeader, Spinner, EmptyState, ErrorBanner, formatCurrency } from '../components/ui';
import { Plus, CheckCircle, XCircle, Shield, KeyRound, X, Search, Loader2, Upload, Download, FileSpreadsheet, AlertTriangle } from 'lucide-react';
import { NaicsPicker } from '../components/NaicsPicker';

// ── CSV template definition ───────────────────────────────────────────────────
const CSV_HEADERS = [
  'company_name', 'uei', 'cage', 'ein', 'naics_codes', 'psc_codes',
  'sdvosb', 'wosb', 'hubzone', 'small_business',
  'phone', 'website', 'street_address', 'city', 'state', 'zip_code',
];

const CSV_EXAMPLE_ROWS = [
  [
    'Acme Defense Solutions LLC', 'QDFNQQ83G946', '9V5E3', '12-3456789', '484121|541614', 'V112|R425',
    'yes', 'no', 'no', 'yes',
    '(555) 123-4567', 'https://acmedefense.com', '123 Main St', 'Arlington', 'VA', '22201',
  ],
  [
    'Apex Federal Advisory LLC', '', '', '', '541611', '',
    'no', 'yes', 'no', 'yes',
    '(703) 555-0100', '', '456 Oak Ave', 'Reston', 'VA', '20190',
  ],
];

function downloadTemplate() {
  const rows = [CSV_HEADERS, ...CSV_EXAMPLE_ROWS];
  const csv = rows.map((r) => r.map((v) => (v.includes(',') ? `"${v}"` : v)).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'bytescon_client_import_template.csv';
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
    <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4">
      <div className="w-full max-w-xl rounded-xl relative"
        style={{ background: '#1a1a20', border: '1px solid #2b2933' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4"
          style={{ borderBottom: '1px solid #2b2933' }}>
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-amber-400" />
            <h3 className="font-bold text-slate-100">Import Client Roster</h3>
          </div>
          <button onClick={onClose} className="text-slate-600 hover:text-slate-300 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">

          {/* Download template */}
          <div className="rounded-lg px-4 py-3 flex items-center justify-between"
            style={{ background: 'rgba(91,116,255,0.07)', border: '1px solid rgba(91,116,255,0.2)' }}>
            <div>
              <p className="text-sm font-semibold text-amber-300">Step 1 — Download the template</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Fill in your client data. Use <span className="font-mono text-slate-400">|</span> to separate multiple NAICS codes.
                Use <span className="font-mono text-slate-400">yes</span> / <span className="font-mono text-slate-400">no</span> for certifications.
              </p>
            </div>
            <button onClick={downloadTemplate}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg flex-shrink-0 ml-3 transition-colors"
              style={{ background: 'rgba(91,116,255,0.15)', color: '#5b74ff', border: '1px solid rgba(91,116,255,0.3)' }}>
              <Download className="w-3.5 h-3.5" /> Template
            </button>
          </div>

          {/* Column guide */}
          <div className="rounded-lg px-4 py-3 text-xs space-y-1"
            style={{ background: '#0b0b0f', border: '1px solid #2b2933' }}>
            <p className="font-semibold text-slate-400 mb-1.5">Column reference</p>
            {[
              ['company_name', 'Required · Legal company name'],
              ['uei', 'Optional · 12-char SAM.gov identifier'],
              ['cage', 'Optional · 5-char CAGE code'],
              ['ein', 'Optional · Tax ID (XX-XXXXXXX)'],
              ['naics_codes', 'Optional · 6-digit codes separated by |'],
              ['psc_codes', 'Optional · 4-char product/service codes separated by |'],
              ['sdvosb / wosb / hubzone', 'Optional · yes or no'],
              ['small_business', 'Optional · yes or no (defaults to yes)'],
              ['phone, website, address fields', 'Optional · contact & location info'],
            ].map(([col, desc]) => (
              <div key={col} className="flex gap-2">
                <span className="font-mono text-amber-400/80 w-44 flex-shrink-0">{col}</span>
                <span className="text-slate-600">{desc}</span>
              </div>
            ))}
          </div>

          {/* Upload zone */}
          {!result && (
            <>
              <p className="text-sm font-semibold text-slate-400">Step 2 — Upload your completed file</p>
              <div
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                className="rounded-xl cursor-pointer flex flex-col items-center justify-center py-10 gap-3 transition-all"
                style={{
                  border: `2px dashed ${dragging ? '#5b74ff' : file ? '#10b981' : '#2b2933'}`,
                  background: dragging ? 'rgba(91,116,255,0.05)' : file ? 'rgba(16,185,129,0.04)' : '#0b0b0f',
                }}
              >
                <Upload className={`w-8 h-8 ${file ? 'text-emerald-400' : 'text-slate-600'}`} />
                {file ? (
                  <>
                    <p className="text-sm font-semibold text-emerald-400">{file.name}</p>
                    <p className="text-xs text-slate-500">{(file.size / 1024).toFixed(1)} KB · Click to replace</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-slate-400">Drag & drop your CSV here, or <span className="text-amber-400 underline">browse</span></p>
                    <p className="text-xs text-slate-600">CSV files only · Max 2 MB</p>
                  </>
                )}
                <input ref={inputRef} type="file" accept=".csv" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); }} />
              </div>
            </>
          )}

          {/* Error */}
          {importError && (
            <div className="flex items-start gap-2 text-sm rounded-lg px-3 py-2.5"
              style={{ background: 'rgba(127,29,29,0.35)', border: '1px solid rgba(185,28,28,0.4)', color: '#fca5a5' }}>
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {importError}
            </div>
          )}

          {/* Results */}
          {result && (
            <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #2b2933' }}>
              <div className="px-4 py-3 flex items-center gap-2"
                style={{ background: result.created > 0 ? 'rgba(16,185,129,0.1)' : 'rgba(91,116,255,0.08)' }}>
                <CheckCircle className={`w-4 h-4 ${result.created > 0 ? 'text-emerald-400' : 'text-amber-400'}`} />
                <p className="font-semibold text-slate-200 text-sm">Import complete</p>
              </div>
              <div className="px-4 py-3 grid grid-cols-3 gap-3 text-center"
                style={{ background: '#0b0b0f' }}>
                <div>
                  <p className="text-2xl font-black text-emerald-400">{result.created}</p>
                  <p className="text-xs text-slate-500">Clients added</p>
                </div>
                <div>
                  <p className="text-2xl font-black text-amber-400">{result.skipped}</p>
                  <p className="text-xs text-slate-500">Already existed</p>
                </div>
                <div>
                  <p className="text-2xl font-black text-red-400">{result.errors.length}</p>
                  <p className="text-xs text-slate-500">Errors</p>
                </div>
              </div>
              {result.errors.length > 0 && (
                <div className="px-4 py-3 space-y-1" style={{ borderTop: '1px solid #2b2933' }}>
                  <p className="text-xs font-semibold text-red-400 mb-1">Row errors:</p>
                  {result.errors.map((e, i) => (
                    <p key={i} className="text-xs text-slate-500 font-mono">{e}</p>
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
                  {loading ? 'Importing...' : 'Import Clients'}
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
  sdvosb: false, wosb: false, hubzone: false, smallBusiness: true,
  phone: '', website: '', streetAddress: '', city: '', state: '', zipCode: '',
};

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
    createMutation.mutate({
      ...form,
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
        smallBusiness: !!d.smallBusiness,
        phone: d.phone || '',
        website: d.website || '',
        streetAddress: d.streetAddress || '',
        city: d.city || '',
        state: d.state || '',
        zipCode: d.zipCode || '',
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
      <PageHeader title="Client Companies" subtitle="Government contractor portfolio">
        <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer mr-1">
          <input type="checkbox" checked={showArchivedClients} onChange={(e) => setShowArchivedClients(e.target.checked)} /> Show archived
        </label>
        <button onClick={() => setShowImport(true)} className="btn-secondary flex items-center gap-2">
          <Upload className="w-4 h-4" />
          Import CSV
        </button>
        <button onClick={() => { setShowCreate(!showCreate); setLookupResult(null); }} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Add Client
        </button>
      </PageHeader>

      {showImport && (
        <ImportCsvModal
          onClose={() => setShowImport(false)}
          onSuccess={() => qc.invalidateQueries({ queryKey: ['clients'] })}
        />
      )}

      {/* SAM.gov Quick Lookup */}
      <div className="card mb-6">
        <h2 className="font-semibold text-gray-200 mb-1 flex items-center gap-2">
          <Search className="w-4 h-4 text-blue-400" /> SAM.gov Entity Lookup
        </h2>
        <p className="text-xs text-gray-500 mb-3">
          Enter a UEI, CAGE code, or company name to auto-populate client details from SAM.gov.
          <span className="text-gray-600"> (EIN/Tax ID lookup is not available via the public SAM API.)</span>
        </p>
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="label">Search By</label>
            <select className="input w-36" value={lookupType} onChange={(e) => { setLookupType(e.target.value as 'uei' | 'cage' | 'name'); setLookupQuery(''); }}>
              <option value="uei">UEI (exact)</option>
              <option value="cage">CAGE Code</option>
              <option value="name">Company Name</option>
            </select>
          </div>
          <div className="flex-1 min-w-48">
            <label className="label">
              {lookupType === 'uei'  ? 'UEI — 12 alphanumeric characters' :
               lookupType === 'cage' ? 'CAGE Code — 5 characters' :
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
            className="btn-primary flex items-center gap-2 h-9"
          >
            {lookupLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            {lookupLoading ? 'Looking up...' : 'Lookup'}
          </button>
        </div>
        {lookupError && (
          <div className="mt-3 p-3 bg-red-950/40 border border-red-800/50 rounded-lg">
            <p className="text-red-300 text-sm font-medium mb-1">Lookup failed</p>
            <p className="text-red-400 text-xs mb-2">{lookupError}</p>
            <p className="text-xs text-gray-500 mb-2">
              Tips: UEI must be exactly 12 alphanumeric chars. CAGE codes are 5 chars. For name search, use the exact legal name from SAM.gov.
            </p>
            <button
              onClick={() => { setShowCreate(true); setLookupError(''); }}
              className="btn-secondary text-xs"
            >
              Enter details manually instead
            </button>
          </div>
        )}
        {lookupResult && (
          <div className="mt-3 p-3 bg-green-950/30 border border-green-800/50 rounded-lg text-sm">
            <p className="text-green-300 font-medium mb-1">
              Found: <span className="text-white">{lookupResult.name ?? '(no name returned)'}</span>
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-400">
              {lookupResult.uei && <span>UEI: <span className="font-mono text-gray-300">{lookupResult.uei}</span></span>}
              {lookupResult.cage && <span>CAGE: <span className="font-mono text-gray-300">{lookupResult.cage}</span></span>}
              {lookupResult.samRegStatus && (
                <span>SAM: <span className={lookupResult.samRegStatus === 'Active' ? 'text-green-400' : 'text-yellow-400'}>{lookupResult.samRegStatus}</span></span>
              )}
              {lookupResult.city && <span>{lookupResult.city}{lookupResult.state ? `, ${lookupResult.state}` : ''}</span>}
              {lookupResult.naicsCodes?.length > 0 && (
                <span>{lookupResult.naicsCodes.length} NAICS code{lookupResult.naicsCodes.length > 1 ? 's' : ''}</span>
              )}
            </div>
            <p className="text-xs text-blue-400 mt-1">
              Form has been pre-filled below. Review certifications and click Create Client.
            </p>
          </div>
        )}
      </div>

      {/* Create Form */}
      {showCreate && (
        <div className="card mb-6">
          <h2 className="font-semibold text-gray-200 mb-4">New Client Company</h2>
          <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Core IDs */}
            <div>
              <label className="label">Company Name *</label>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div>
              <label className="label">EIN / Tax ID</label>
              <input className="input font-mono" value={form.ein} onChange={(e) => setForm({ ...form, ein: e.target.value })} placeholder="12-3456789" />
            </div>
            <div>
              <label className="label">UEI</label>
              <input className="input font-mono" value={form.uei} onChange={(e) => setForm({ ...form, uei: e.target.value })} />
            </div>
            <div>
              <label className="label">CAGE Code</label>
              <input className="input font-mono" value={form.cage} onChange={(e) => setForm({ ...form, cage: e.target.value })} />
            </div>
            <div className="md:col-span-2">
              <NaicsPicker
                label="NAICS Codes"
                selected={form.naicsCodes ? form.naicsCodes.split(',').map(s => s.trim()).filter(Boolean) : []}
                onChange={(codes) => setForm({ ...form, naicsCodes: codes.join(', ') })}
              />
            </div>
            <div className="md:col-span-2">
              <label className="label">PSC Codes</label>
              <input className="input font-mono" value={form.pscCodes} onChange={(e) => setForm({ ...form, pscCodes: e.target.value })} placeholder="V112, R425" />
              <p className="text-xs text-gray-600 mt-1">Product/Service Codes this client is qualified for, comma-separated. Improves opportunity matching alongside NAICS.</p>
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
              <label className="label">Street Address</label>
              <input className="input" value={form.streetAddress} onChange={(e) => setForm({ ...form, streetAddress: e.target.value })} placeholder="123 Main St" />
            </div>
            <div>
              <label className="label">City</label>
              <input className="input" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">State</label>
                <input className="input font-mono" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} placeholder="VA" maxLength={2} />
              </div>
              <div>
                <label className="label">ZIP</label>
                <input className="input font-mono" value={form.zipCode} onChange={(e) => setForm({ ...form, zipCode: e.target.value })} placeholder="20001" />
              </div>
            </div>

            {/* Certifications */}
            <div className="md:col-span-2">
              <label className="label">Certifications</label>
              <div className="flex flex-wrap gap-4">
                {[
                  { key: 'sdvosb', label: 'SDVOSB' },
                  { key: 'wosb', label: 'WOSB' },
                  { key: 'hubzone', label: 'HUBZone' },
                  { key: 'smallBusiness', label: 'Small Business' },
                ].map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={(form as any)[key]}
                      onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
                      className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-blue-500"
                    />
                    <span className="text-sm text-gray-300">{label}</span>
                  </label>
                ))}
              </div>
            </div>

            {formError && <div className="md:col-span-2"><ErrorBanner message={formError} /></div>}

            <div className="md:col-span-2 flex gap-2">
              <button type="submit" disabled={createMutation.isPending} className="btn-primary">
                {createMutation.isPending ? 'Creating...' : 'Create Client'}
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
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-200 flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-blue-400" />
                Client Portal Access — {portalClientName}
              </h3>
              <button onClick={() => { setPortalClientId(null); setPortalSuccess(''); setPortalError(''); }}
                className="text-gray-500 hover:text-gray-300"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Create login credentials for a contact at this client company. They will log in at <span className="text-blue-400">/client-login</span>.
            </p>
            {portalSuccess ? (
              <div className="bg-green-900/30 border border-green-700 text-green-300 rounded-lg p-3 text-sm">{portalSuccess}</div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">First Name</label>
                    <input className="input" value={portalForm.firstName}
                      onChange={(e) => setPortalForm({ ...portalForm, firstName: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">Last Name</label>
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
                  <label className="label">Temporary Password</label>
                  <input type="password" className="input" value={portalForm.password}
                    onChange={(e) => setPortalForm({ ...portalForm, password: e.target.value })} />
                </div>
                {portalError && <ErrorBanner message={portalError} />}
                <button
                  onClick={() => { setPortalError(''); portalMutation.mutate(); }}
                  disabled={!portalForm.email || !portalForm.password || !portalForm.firstName || portalMutation.isPending}
                  className="btn-primary w-full"
                >
                  {portalMutation.isPending ? 'Creating...' : 'Create Portal Access'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {isLoading && <div className="flex justify-center mt-10"><Spinner size="lg" /></div>}
      {error && <ErrorBanner message="Failed to load clients" />}
      {!isLoading && clients.length === 0 && <EmptyState message="No clients yet. Add your first client company." />}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {clients.map((client: any) => (
          <div key={client.id} className={`card transition-colors relative ${client.archivedAt ? 'opacity-60 border-gray-800' : 'hover:border-gray-600'}`}>
          {client.archivedAt ? (
            isAdmin && (
              <button
                onClick={(e) => { e.preventDefault(); restoreMutation.mutate(client.id); }}
                title="Restore client"
                className="absolute top-3 right-3 text-gray-500 hover:text-green-400 transition-colors text-xs"
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
              className="absolute top-3 right-3 text-gray-600 hover:text-blue-400 transition-colors"
            >
              <KeyRound className="w-4 h-4" />
            </button>
          )}
          <Link to={`/clients/${client.id}`} className="block">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="font-semibold text-gray-200">{client.name}{client.archivedAt && <span className="ml-2 text-[9px] uppercase tracking-wide text-gray-500 border border-gray-700 rounded px-1">archived</span>}</h3>
                {client.uei && <p className="text-xs text-gray-500 font-mono">UEI: {client.uei}</p>}
              </div>
              {client.sdvosb && (
                <span className="flex items-center gap-1 text-xs bg-blue-900 text-blue-300 px-2 py-0.5 rounded">
                  <Shield className="w-3 h-3" />
                  SDVOSB
                </span>
              )}
            </div>

            {/* NAICS */}
            {client.naicsCodes?.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-3">
                {client.naicsCodes.slice(0, 3).map((code: string) => (
                  <span key={code} className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded font-mono">
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
              <div className="border-t border-gray-800 pt-3 grid grid-cols-2 gap-2">
                <div>
                  <p className="text-xs text-gray-500">Completion Rate</p>
                  <div className="flex items-center gap-1">
                    {client.performanceStats.completionRate >= 0.8 ? (
                      <CheckCircle className="w-3 h-3 text-green-400" />
                    ) : (
                      <XCircle className="w-3 h-3 text-red-400" />
                    )}
                    <span className="text-sm font-mono text-gray-200">
                      {Math.round(client.performanceStats.completionRate * 100)}%
                    </span>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Penalties</p>
                  <p className={`text-sm font-mono ${client.performanceStats.totalPenalties > 0 ? 'text-red-400' : 'text-gray-400'}`}>
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
