import React, { useEffect, useState, useCallback } from 'react';
import { useToast } from './Toast';

interface OpportunityDocument {
  id: string;
  fileName: string;
  fileSize: number;
  uploadedAt: string;
  extractionStatus: 'PENDING' | 'EXTRACTING' | 'EXTRACTED' | 'FAILED';
  extractedRequirementCount: number;
  extractionConfidence?: number;
  extractionError?: string;
}

interface Requirement {
  id: string;
  requirementText: string;
  isMandatory: boolean;
  sourceDocumentId: string;
  sourcePageNumber?: number;
  extractionMethod: string;
  extractionConfidence: number;
  isManuallyVerified: boolean;
  manualOverrideReason?: string;
  coverageStatus: string;
}

interface Props {
  opportunityId: string;
  onExtractionComplete?: (count: number) => void;
}

export function RequirementExtractionStatus({ opportunityId, onExtractionComplete }: Props) {
  const { toast } = useToast();
  const [documents, setDocuments] = useState<OpportunityDocument[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [pollingActive, setPollingActive] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);

  // Fetch documents and their extraction status
  const fetchDocuments = useCallback(async () => {
    try {
      const res = await fetch(`/api/opportunities/${opportunityId}/documents`, {
        credentials: 'include',
      });

      if (!res.ok) throw new Error(`Failed to fetch documents: ${res.status}`);
      const data = await res.json();
      setDocuments(data);

      // Check if any document is still extracting
      const anyExtracting = data.some(
        (d: OpportunityDocument) => d.extractionStatus === 'EXTRACTING'
      );
      setPollingActive(anyExtracting);

      // If extraction is complete, fetch requirements
      if (!anyExtracting && data.length > 0) {
        const anyExtracted = data.some(
          (d: OpportunityDocument) => d.extractionStatus === 'EXTRACTED'
        );
        if (anyExtracted) {
          await fetchRequirements();
        }
      }
    } catch (err) {
      console.error('Error fetching documents:', err);
    } finally {
      setLoading(false);
    }
  }, [opportunityId]);

  // Fetch extracted requirements
  const fetchRequirements = useCallback(async () => {
    try {
      const res = await fetch(`/api/compliance-matrix/${opportunityId}/requirements`, {
        credentials: 'include',
      });

      if (!res.ok) {
        // 404 means no compliance matrix yet (OK)
        if (res.status === 404) {
          setRequirements([]);
          return;
        }
        throw new Error(`Failed to fetch requirements: ${res.status}`);
      }

      const data = await res.json();
      setRequirements(data);

      if (onExtractionComplete && data.length > 0) {
        onExtractionComplete(data.length);
      }
    } catch (err) {
      console.error('Error fetching requirements:', err);
    }
  }, [opportunityId, onExtractionComplete]);

  // Poll for extraction progress
  useEffect(() => {
    fetchDocuments();

    if (pollingActive) {
      const interval = setInterval(fetchDocuments, 2000);  // Poll every 2 seconds
      return () => clearInterval(interval);
    }
  }, [fetchDocuments, pollingActive]);

  // Refresh extraction for all documents
  const handleRefreshExtraction = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/compliance-matrix/${opportunityId}/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
      const data = await res.json();

      toast(`${data.queuedCount} document(s) queued for re-extraction. This may take a moment.`, 'success');

      // Resume polling
      setPollingActive(true);
    } catch (err) {
      console.error('Error refreshing extraction:', err);
      toast(`Failed to refresh: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  // Manual override of a requirement
  const handleOverrideRequirement = async (reqId: string, newText: string, reason: string) => {
    try {
      const res = await fetch(
        `/api/compliance-matrix/${opportunityId}/requirements/${reqId}`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            requirementText: newText,
            overrideReason: reason,
          }),
        }
      );

      if (!res.ok) throw new Error(`Override failed: ${res.status}`);
      const updated = await res.json();

      // Update local state
      setRequirements(prev =>
        prev.map(r => r.id === reqId ? updated.requirement : r)
      );

      toast('Requirement overridden successfully', 'success');
    } catch (err) {
      console.error('Error overriding requirement:', err);
      toast(`Failed to override: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    }
  };

  if (loading) {
    return (
      <div className="p-6 border rounded bg-gray-50">
        <div className="flex items-center gap-2">
          <div className="animate-spin h-5 w-5 border-2 border-blue-600 rounded-full"></div>
          <p className="text-gray-600">Loading extraction status...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Documents Section */}
      <div className="border rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-900">RFP Documents</h3>
          <button
            onClick={handleRefreshExtraction}
            disabled={refreshing || pollingActive}
            className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {refreshing ? 'Refreshing...' : 'Refresh Extraction'}
          </button>
        </div>

        {documents.length === 0 ? (
          <p className="text-gray-500">No documents uploaded yet</p>
        ) : (
          <div className="space-y-3">
            {documents.map(doc => (
              <div
                key={doc.id}
                className="border rounded p-4 hover:bg-gray-50 cursor-pointer transition"
                onClick={() =>
                  setExpandedDocId(expandedDocId === doc.id ? null : doc.id)
                }
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-gray-900">{doc.fileName}</p>
                      <StatusBadge status={doc.extractionStatus} />
                    </div>
                    <p className="text-sm text-gray-500 mt-1">
                      {(doc.fileSize / 1024).toFixed(1)} KB · Uploaded{' '}
                      {new Date(doc.uploadedAt).toLocaleDateString()}
                    </p>

                    {doc.extractionStatus === 'EXTRACTED' && doc.extractedRequirementCount > 0 && (
                      <p className="text-sm text-green-600 font-medium mt-2">
                        ✓ {doc.extractedRequirementCount} requirements extracted
                      </p>
                    )}

                    {doc.extractionConfidence !== undefined && doc.extractionStatus === 'EXTRACTED' && (
                      <p className="text-xs text-gray-500 mt-1">
                        Confidence: {(doc.extractionConfidence * 100).toFixed(0)}%
                      </p>
                    )}

                    {doc.extractionError && (
                      <p className="text-xs text-red-600 mt-2 font-medium">
                        Error: {doc.extractionError}
                      </p>
                    )}
                  </div>

                  <div className="ml-4">
                    {doc.extractionStatus === 'EXTRACTING' && (
                      <div className="animate-spin h-5 w-5 border-2 border-blue-600 rounded-full"></div>
                    )}
                    {doc.extractionStatus === 'EXTRACTED' && (
                      <span className="text-green-600 text-2xl">✓</span>
                    )}
                    {doc.extractionStatus === 'FAILED' && (
                      <span className="text-red-600 text-2xl">✕</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Requirements Section */}
      {requirements.length > 0 && (
        <div className="border rounded-lg p-6">
          <h3 className="text-lg font-bold text-gray-900 mb-4">
            Extracted Requirements ({requirements.length})
          </h3>

          <div className="space-y-3">
            {requirements.map(req => (
              <RequirementCard
                key={req.id}
                requirement={req}
                onOverride={(newText, reason) =>
                  handleOverrideRequirement(req.id, newText, reason)
                }
              />
            ))}
          </div>

          <div className="mt-6 p-4 bg-blue-50 rounded border border-blue-200">
            <p className="text-sm text-blue-900">
              💡 <strong>Tip:</strong> Click on any requirement to view or edit it. Use the override
              feature to correct any inaccurate extractions.
            </p>
          </div>
        </div>
      )}

      {/* Empty State */}
      {documents.length > 0 && requirements.length === 0 && !pollingActive && (
        <div className="border rounded-lg p-6 bg-yellow-50 border-yellow-200">
          <p className="text-sm text-yellow-900">
            ⏳ No requirements extracted yet. Documents may still be processing, or extraction
            failed. Check document status above.
          </p>
        </div>
      )}
    </div>
  );
}

// Status Badge Component
function StatusBadge({ status }: { status: string }) {
  const styles = {
    PENDING: 'bg-gray-200 text-gray-800',
    EXTRACTING: 'bg-blue-200 text-blue-800 animate-pulse',
    EXTRACTED: 'bg-green-200 text-green-800',
    FAILED: 'bg-red-200 text-red-800',
  };

  const labels = {
    PENDING: 'Pending',
    EXTRACTING: 'Extracting...',
    EXTRACTED: 'Extracted',
    FAILED: 'Failed',
  };

  return (
    <span
      className={`px-2 py-1 rounded-full text-xs font-medium ${
        styles[status as keyof typeof styles] || 'bg-gray-200 text-gray-800'
      }`}
    >
      {labels[status as keyof typeof labels] || status}
    </span>
  );
}

// Requirement Card Component
function RequirementCard({
  requirement,
  onOverride,
}: {
  requirement: Requirement;
  onOverride: (text: string, reason: string) => void;
}) {
  const { toast } = useToast();
  const [showOverride, setShowOverride] = useState(false);
  const [overrideText, setOverrideText] = useState(requirement.requirementText);
  const [overrideReason, setOverrideReason] = useState('');

  const handleSaveOverride = () => {
    if (!overrideReason.trim()) {
      toast('Please provide a reason for the override', 'warning');
      return;
    }
    onOverride(overrideText, overrideReason);
    setShowOverride(false);
  };

  return (
    <div className="border rounded p-4 bg-white hover:shadow-sm transition">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <p className="font-medium text-gray-900 mb-2">{requirement.requirementText}</p>

          <div className="flex flex-wrap gap-2 text-xs">
            {requirement.isMandatory && (
              <span className="px-2 py-1 bg-red-100 text-red-700 rounded">
                Mandatory
              </span>
            )}
            <span className="px-2 py-1 bg-gray-100 text-gray-700 rounded">
              {requirement.extractionMethod}
            </span>
            <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded">
              Confidence: {(requirement.extractionConfidence * 100).toFixed(0)}%
            </span>
            {requirement.sourcePageNumber && (
              <span className="px-2 py-1 bg-gray-100 text-gray-700 rounded">
                Page {requirement.sourcePageNumber}
              </span>
            )}
            {requirement.isManuallyVerified && (
              <span className="px-2 py-1 bg-yellow-100 text-yellow-700 rounded">
                Manually Verified
              </span>
            )}
          </div>

          {requirement.manualOverrideReason && (
            <p className="text-xs text-gray-600 mt-2 italic">
              Override reason: {requirement.manualOverrideReason}
            </p>
          )}
        </div>

        <button
          onClick={() => setShowOverride(!showOverride)}
          className="px-3 py-1 text-sm border rounded hover:bg-gray-50"
        >
          {showOverride ? 'Cancel' : 'Edit'}
        </button>
      </div>

      {showOverride && (
        <div className="mt-4 p-4 bg-gray-50 rounded border-l-4 border-blue-600">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Corrected Requirement Text
          </label>
          <textarea
            value={overrideText}
            onChange={e => setOverrideText(e.target.value)}
            className="w-full px-3 py-2 border rounded text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-600"
            rows={3}
          />

          <label className="block text-sm font-medium text-gray-700 mb-2">
            Reason for Override
          </label>
          <input
            type="text"
            value={overrideReason}
            onChange={e => setOverrideReason(e.target.value)}
            placeholder="e.g., PDF OCR error, clarification needed"
            className="w-full px-3 py-2 border rounded text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />

          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setShowOverride(false)}
              className="px-3 py-1 text-sm border rounded hover:bg-gray-100"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveOverride}
              className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Save Override
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default RequirementExtractionStatus;
