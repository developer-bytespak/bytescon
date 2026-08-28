// =============================================================
// Document Analysis Service
// SOW scope analysis for probability enrichment
// =============================================================
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { DocumentAnalysisResult } from '../types';
import { generateWithRouter } from './llm/llmRouter';

const ANALYSIS_SYSTEM_PROMPT = `You are a federal contracting intelligence analyst. Analyze this government contract document (SOW, amendment, or solicitation) and return a structured JSON analysis.

Return ONLY valid JSON with this exact structure — no markdown, no preamble:
{
  "scopeKeywords": ["keyword1", "keyword2"],
  "complexityScore": 0.0,
  "alignmentScore": 0.5,
  "incumbentSignals": ["signal1"],
  "certificationRequirements": ["cert1"],
  "recompeteSignals": ["signal1"],
  "competitivenessAssessment": "open",
  "analysisConfidence": 0.8,
  "summary": "brief summary"
}

Scoring guidance:
- complexityScore (0-1): 0=simple commodity, 1=highly specialized technical
- alignmentScore (0-1): how well this SOW aligns with a general small business/SDVOSB
- analysisConfidence (0-1): confidence given document quality
- incumbentSignals: text suggesting an existing contractor (transition language, bridge contract language)
- recompeteSignals: text suggesting recompete (option years, re-solicitation, follow-on language)
- competitivenessAssessment: one of "open", "moderate", "restricted"

Document to analyze:`;

export class DocumentAnalysisService {
  async analyzeDocument(
    filePath: string,
    opportunityContext?: {
      title?: string;
      agency?: string;
      naicsCode?: string;
      clientNaicsCodes?: string[];
      clientCertifications?: string[];
    },
    consultingFirmId?: string | null
  ): Promise<DocumentAnalysisResult> {
    try {
      const ext = path.extname(filePath).toLowerCase();
      let content: string;

      if (ext === '.pdf') {
        content = await this.extractPdfText(filePath);
      } else {
        content = fs.readFileSync(filePath, 'utf-8');
      }

      if (!content || content.trim().length < 100) {
        logger.warn('Document too short for analysis', { filePath });
        return this.defaultResult();
      }

      const truncated = content.substring(0, 50000);

      let contextBlock = '';
      if (opportunityContext) {
        contextBlock = `\n\nOpportunity context:
- Title: ${opportunityContext.title || 'Unknown'}
- Agency: ${opportunityContext.agency || 'Unknown'}
- NAICS: ${opportunityContext.naicsCode || 'Unknown'}
- Client NAICS codes: ${opportunityContext.clientNaicsCodes?.join(', ') || 'Unknown'}
- Client certifications: ${opportunityContext.clientCertifications?.join(', ') || 'Unknown'}\n`;
      }

      const llmResponse = await generateWithRouter(
        {
          systemPrompt: ANALYSIS_SYSTEM_PROMPT,
          userPrompt: `${contextBlock}\n\n${truncated}`,
          maxTokens: 2000,
        },
        consultingFirmId ?? undefined,
        { task: 'DOCUMENT_ANALYSIS', useCache: false }
      );

      const parsed = this.parseResponse(llmResponse.text);
      return this.buildResult(parsed);
    } catch (err) {
      const msg = (err as Error).message;
      // NO_LLM_KEY is an expected configuration state — return the default
      // result silently so the caller can mark the document SKIPPED.
      // Every other error (RATE_LIMITED, 429, 5xx, timeout, parse failures)
      // must propagate so the caller can write a typed FAILED status and
      // BullMQ can schedule a retry. Swallowing these errors is what produces
      // the permanent 0.5 placeholder on transient provider failures.
      if (msg === 'NO_LLM_KEY') {
        logger.warn('No AI provider key configured — skipping document analysis');
        return this.defaultResult();
      }
      logger.error('Document analysis failed — rethrowing for caller retry', { filePath, error: msg });
      throw err;
    }
  }

  computeAlignmentScore(
    analysis: DocumentAnalysisResult,
    clientProfile: {
      naicsCodes: string[];
      certifications: string[];
      capabilities?: string[];
    }
  ): number {
    let score = analysis.alignmentScore ?? 0.5;

    if (clientProfile.capabilities && clientProfile.capabilities.length > 0) {
      const scopeText = analysis.scopeKeywords.join(' ').toLowerCase();
      const matchCount = clientProfile.capabilities.filter((cap: string) =>
        scopeText.includes(cap.toLowerCase())
      ).length;
      const overlapRatio = matchCount / clientProfile.capabilities.length;
      score += overlapRatio * 0.3;
    }

    const certReqs: string[] = (analysis.rawAnalysis?.certificationRequirements as string[]) || [];
    if (certReqs.length > 0 && clientProfile.certifications.length > 0) {
      const certMatch = clientProfile.certifications.some((cert: string) =>
        certReqs.some((req: string) => req.toLowerCase().includes(cert.toLowerCase()))
      );
      if (certMatch) score += 0.1;
    }

    if (analysis.complexityScore > 0.8) score -= 0.1;
    if (analysis.incumbentSignals.length > 0) score -= 0.15;

    return Math.max(0, Math.min(1, score));
  }

  private async extractPdfText(filePath: string): Promise<string> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pdfParse = require('pdf-parse');
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      return data.text || '';
    } catch {
      const buffer = fs.readFileSync(filePath);
      return buffer.toString('utf-8', 0, Math.min(buffer.length, 100000));
    }
  }

  private parseResponse(raw: string): Record<string, unknown> {
    // Strip markdown code fences
    let cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    // If a local model added preamble, extract the first {...} block
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
    }
    try {
      return JSON.parse(cleaned);
    } catch {
      // P1-3: a malformed AI response is a FAILURE, not a 0.5 placeholder. Throw
      // so analyzeDocument's caller writes a typed FAILED status and BullMQ
      // retries, instead of masking the parse error as a fabricated neutral.
      logger.error('Failed to parse AI JSON response (document analysis)');
      throw new Error('Document analysis failed: AI response was not valid JSON');
    }
  }

  private buildResult(parsed: Record<string, unknown>): DocumentAnalysisResult {
    // P1-3: require the model to actually return the scores. A valid-JSON-but-
    // missing-scores response is an incomplete analysis (a failure), not a 0.5
    // default — throw so it surfaces as FAILED rather than a fabricated neutral.
    if (typeof parsed.complexityScore !== 'number' || typeof parsed.alignmentScore !== 'number') {
      throw new Error(
        'Document analysis failed: AI response missing required complexity/alignment scores'
      );
    }
    return {
      scopeKeywords: Array.isArray(parsed.scopeKeywords) ? parsed.scopeKeywords as string[] : [],
      complexityScore: Math.max(0, Math.min(1, parsed.complexityScore)),
      alignmentScore: Math.max(0, Math.min(1, parsed.alignmentScore)),
      incumbentSignals: Array.isArray(parsed.incumbentSignals) ? parsed.incumbentSignals as string[] : [],
      rawAnalysis: parsed,
    };
  }

  private defaultResult(): DocumentAnalysisResult {
    return {
      scopeKeywords: [],
      complexityScore: 0.5,
      alignmentScore: 0.5,
      incumbentSignals: [],
      rawAnalysis: {},
    };
  }
}

export const documentAnalysisService = new DocumentAnalysisService();