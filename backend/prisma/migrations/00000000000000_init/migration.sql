-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'EXPIRED', 'AWARDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OpportunitySource" AS ENUM ('SAM_GOV', 'USA_SPENDING', 'MANUAL', 'DEMO', 'OTHER', 'GRANTS_GOV', 'STATE_LOCAL', 'SUBCONTRACTING_BOARD', 'AGENCY_FORECAST', 'CONTRACT_AWARDS');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('INCUMBENT', 'COMPETITOR');

-- CreateEnum
CREATE TYPE "EvidenceConfidence" AS ENUM ('CONFIRMED', 'PROBABLE', 'AMBIGUOUS', 'NOT_AVAILABLE');

-- CreateEnum
CREATE TYPE "IncumbentVerification" AS ENUM ('UNVERIFIED', 'VERIFIED', 'CORRECTED');

-- CreateEnum
CREATE TYPE "BidDecisionStatus" AS ENUM ('PENDING', 'GO', 'NO_GO');

-- CreateEnum
CREATE TYPE "ComplianceStatus" AS ENUM ('PENDING', 'APPROVED', 'BLOCKED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PenaltyType" AS ENUM ('LATE_SUBMISSION', 'DOCUMENT_ERROR', 'NON_COMPLIANT_BID', 'WITHDRAWAL', 'OTHER');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'PAUSED');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE');

-- CreateEnum
CREATE TYPE "IngestionJobType" AS ENUM ('INGEST', 'ENRICH', 'ANALYZE_DOCUMENT');

-- CreateEnum
CREATE TYPE "IngestionJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "DocumentAnalysisStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETE', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "DocumentRequirementStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MatrixRequirementStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'PENDING_REVIEW', 'BLOCKED', 'READY_FOR_REVIEW', 'CHANGES_REQUIRED', 'COMPLETE', 'VERIFIED', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "ComplianceLogEntityType" AS ENUM ('SUBMISSION', 'BID_DECISION', 'OPPORTUNITY', 'CLIENT_COMPANY', 'DOCUMENT_REQUIREMENT', 'WINNERS_INTEL_INJECTION', 'WINNERS_INTEL_REFRESH', 'TEAMING_RELATIONSHIP', 'OTHER');

-- CreateEnum
CREATE TYPE "TeamingRelationshipStatus" AS ENUM ('IDENTIFIED', 'CONTACTED', 'CONVERSATION', 'MOU', 'TEAMED', 'DECLINED');

-- CreateEnum
CREATE TYPE "SubmissionOutcome" AS ENUM ('WON', 'LOST', 'NO_AWARD', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PursuitStatus" AS ENUM ('REVIEWING', 'SUBMITTED', 'PASSED');

-- CreateEnum
CREATE TYPE "PursuitSource" AS ENUM ('USER', 'AUTO_EXPIRED');

-- CreateEnum
CREATE TYPE "PipelineStage" AS ENUM ('IDENTIFIED', 'QUALIFICATION', 'CAPTURE', 'PROPOSAL', 'SUBMITTED', 'AWARDED', 'LOST', 'NO_BID', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PursuitPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "QualificationStatus" AS ENUM ('NOT_REVIEWED', 'IN_REVIEW', 'BID', 'NO_BID', 'CONDITIONAL', 'DEFERRED');

-- CreateEnum
CREATE TYPE "ScorecardRecommendation" AS ENUM ('BID', 'NO_BID', 'CONDITIONAL', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "GateReviewStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'APPROVED', 'REJECTED', 'CHANGES_REQUIRED', 'WAIVED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('GATE_REVIEW_ASSIGNED', 'GATE_REVIEW_SUBMITTED', 'GATE_REVIEW_DECIDED', 'QUALIFICATION_DECISION', 'TEAMING_REMINDER', 'PROPOSAL_ASSIGNMENT', 'PROPOSAL_REVIEW', 'PRICING_REVIEW', 'SUBMISSION_REMINDER', 'SUBMISSION_REVIEW', 'OPPORTUNITY_ALERT', 'RECOMPETE_ALERT', 'AMENDMENT_ALERT', 'MILESTONE_REMINDER', 'MILESTONE_ESCALATION', 'REQUIREMENT_ASSIGNMENT', 'DOCUMENT_EXPIRY', 'AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_ESCALATION', 'FINANCE_ALERT', 'CRM_FOLLOW_UP');

-- CreateEnum
CREATE TYPE "ClientDocumentType" AS ENUM ('CAPABILITY_STATEMENT', 'PAST_PERFORMANCE', 'TECHNICAL_PROPOSAL', 'MANAGEMENT_APPROACH', 'PRICE_VOLUME', 'SMALL_BUSINESS_PLAN', 'TEAMING_AGREEMENT', 'COVER_LETTER', 'OTHER');

-- CreateEnum
CREATE TYPE "SharedTemplateStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ContractLevel" AS ENUM ('STATE', 'MUNICIPAL', 'COUNTY', 'FEDERAL');

-- CreateEnum
CREATE TYPE "CommentAuthorType" AS ENUM ('CONSULTANT', 'CLIENT');

-- CreateEnum
CREATE TYPE "MonitoringAlertFrequency" AS ENUM ('INSTANT', 'DAILY', 'WEEKLY', 'DISABLED');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PartnerType" AS ENUM ('PRIME', 'SUB', 'BOTH');

-- CreateEnum
CREATE TYPE "TeamingStatus" AS ENUM ('IDENTIFIED', 'INVITED', 'INTERESTED', 'COMMITTED', 'DECLINED');

-- CreateEnum
CREATE TYPE "AgreementStatus" AS ENUM ('NONE', 'DRAFT', 'SENT', 'SIGNED');

-- CreateEnum
CREATE TYPE "TeamingDraftType" AS ENUM ('TEAMING_AGREEMENT', 'NDA');

-- CreateEnum
CREATE TYPE "ApiTokenTier" AS ENUM ('CORE', 'PRO', 'VAULT');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "NotificationFrequency" AS ENUM ('IMMEDIATE', 'DIGEST');

-- CreateEnum
CREATE TYPE "EmailVerificationStatus" AS ENUM ('verified', 'probable', 'unknown');

-- CreateEnum
CREATE TYPE "SourceCategory" AS ENUM ('SAM_GOV', 'CONTRACT_AWARDS', 'AGENCY_FORECAST', 'GRANTS_GOV', 'STATE_LOCAL', 'SUBCONTRACTING_BOARD', 'MANUAL', 'DEMO', 'OTHER');

-- CreateEnum
CREATE TYPE "SourceDataQuality" AS ENUM ('OK', 'PARTIAL', 'STALE', 'ERROR', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "SyncRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'TIMED_OUT', 'SKIPPED');

-- CreateEnum
CREATE TYPE "SyncMode" AS ENUM ('FULL', 'INCREMENTAL');

-- CreateEnum
CREATE TYPE "AdapterVerification" AS ENUM ('LIVE_VERIFIED', 'CONTRACT_ONLY', 'NOT_CONFIGURED');

-- CreateEnum
CREATE TYPE "ForecastLinkState" AS ENUM ('UNLINKED', 'AUTO_LINKED', 'REVIEW_REQUIRED', 'HUMAN_CONFIRMED', 'HUMAN_REJECTED');

-- CreateEnum
CREATE TYPE "RecompeteVerification" AS ENUM ('UNVERIFIED', 'VERIFIED', 'CORRECTED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "CapabilityVerification" AS ENUM ('UNVERIFIED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EligibilityState" AS ENUM ('ELIGIBLE', 'POSSIBLY_ELIGIBLE', 'NOT_ELIGIBLE', 'EXPIRING_BEFORE_DEADLINE', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "CalibrationState" AS ENUM ('DRAFT', 'EVALUATED', 'ACTIVE', 'REJECTED', 'ROLLED_BACK', 'STALE');

-- CreateEnum
CREATE TYPE "OutcomeVerification" AS ENUM ('UNVERIFIED', 'HUMAN_CONFIRMED', 'SYSTEM_DERIVED');

-- CreateEnum
CREATE TYPE "RateBasis" AS ENUM ('CONFIRMED_WIN_RATE', 'OBSERVED_AWARD_SHARE', 'HISTORICAL_AWARD_FREQUENCY', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "SensitivityValidity" AS ENUM ('CALIBRATED', 'UNVALIDATED_SCENARIO_ANALYSIS', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "ExtractionJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "MappingVerification" AS ENUM ('UNVERIFIED', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FlowDownStatus" AS ENUM ('EXPLICIT_FLOWDOWN', 'CONDITIONAL_FLOWDOWN', 'NO_EXPLICIT_FLOWDOWN_FOUND', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "ClauseApplicability" AS ENUM ('APPLICABLE', 'NOT_APPLICABLE', 'CONDITIONAL', 'UNDETERMINED');

-- CreateEnum
CREATE TYPE "StandingDocumentCategory" AS ENUM ('CAPABILITY_STATEMENT', 'CERTIFICATION', 'REGISTRATION', 'INSURANCE', 'BOND', 'FINANCIAL', 'INDIRECT_RATE', 'RESUME', 'PAST_PERFORMANCE', 'REPRESENTATION', 'SIGNED_FORM', 'PROPOSAL_TEMPLATE', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentVerificationState" AS ENUM ('UNVERIFIED', 'VERIFIED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ValidationOutcome" AS ENUM ('PASSED', 'FAILED', 'NOT_APPLICABLE', 'MANUAL_REQUIRED', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "MilestoneType" AS ENUM ('FORECAST_RELEASE', 'SOURCES_SOUGHT_DEADLINE', 'RFI_DEADLINE', 'QUESTION_DEADLINE', 'SITE_VISIT', 'INDUSTRY_DAY', 'PRE_PROPOSAL_CONFERENCE', 'DRAFT_RFP', 'AMENDMENT_RELEASE', 'PROPOSAL_DEADLINE', 'INTERNAL_KICKOFF', 'BID_DECISION', 'GATE_REVIEW', 'OUTLINE_COMPLETE', 'FIRST_DRAFT', 'RED_TEAM', 'GOLD_TEAM', 'PRICING_FREEZE', 'FINAL_QA', 'READY_TO_SUBMIT', 'SUBMISSION', 'ORAL_PRESENTATION', 'ANTICIPATED_AWARD', 'CUSTOM');

-- CreateEnum
CREATE TYPE "MilestoneStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETE', 'AT_RISK', 'MISSED', 'CANCELLED', 'WAIVED');

-- CreateEnum
CREATE TYPE "MilestoneOrigin" AS ENUM ('SOLICITATION', 'AMENDMENT', 'EXTRACTION', 'SCHEDULE_GENERATOR', 'MANUAL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ReminderLevel" AS ENUM ('INFORMATIONAL', 'UPCOMING', 'DUE_SOON', 'URGENT', 'OVERDUE', 'ESCALATED');

-- CreateEnum
CREATE TYPE "AmendmentImpactArea" AS ENUM ('COMPLIANCE_MATRIX', 'PROPOSAL_SECTION', 'PRICING', 'SUBMISSION_CHECKLIST', 'MILESTONE', 'CLAUSE', 'DOCUMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "AgentKey" AS ENUM ('OPPORTUNITY', 'QUALIFICATION', 'COMPLIANCE', 'PROPOSAL', 'PRICING', 'TEAMING', 'CONTRACT_ADMINISTRATION', 'FINANCE', 'INTELLIGENCE', 'INTERNAL_DIAGNOSTIC');

-- CreateEnum
CREATE TYPE "AgentTriggerType" AS ENUM ('MANUAL', 'SCHEDULE', 'EVENT', 'RETRY');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_FOR_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AgentAutonomyLevel" AS ENUM ('OBSERVE', 'PROPOSE', 'ACT_WITH_GUARDRAILS');

-- CreateEnum
CREATE TYPE "AgentConfidenceState" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "AgentDataSufficiency" AS ENUM ('SUFFICIENT', 'PARTIAL', 'INSUFFICIENT');

-- CreateEnum
CREATE TYPE "AgentArtifactType" AS ENUM ('OPPORTUNITY_BRIEF', 'QUALIFICATION_BRIEF', 'COMPLIANCE_STATUS', 'PROPOSAL_STATUS', 'PRICING_ASSESSMENT', 'TEAMING_PLAN', 'CONTRACT_HEALTH', 'FINANCE_STATUS', 'PORTFOLIO_INTELLIGENCE', 'RUNTIME_DIAGNOSTIC');

-- CreateEnum
CREATE TYPE "AgentEscalationStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "AgentEscalationSeverity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AgentEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "AgentScheduleType" AS ENUM ('CRON', 'INTERVAL', 'MANUAL_ONLY');

-- CreateEnum
CREATE TYPE "PursuitFeedbackStatus" AS ENUM ('INSUFFICIENT_DATA', 'PROPOSED', 'APPLIED', 'REVERTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "BondingCapacityStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "QualificationRecommendationResult" AS ENUM ('RECOMMEND_BID', 'RECOMMEND_NO_BID', 'BORDERLINE_REVIEW', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "QualificationRecommendationStrength" AS ENUM ('STRONG', 'MODERATE', 'WEAK', 'NONE');

-- CreateEnum
CREATE TYPE "QualificationRecommendationStatus" AS ENUM ('ACTIVE', 'ACCEPTED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "TeamingDataSufficiency" AS ENUM ('INSUFFICIENT_DATA', 'PARTIAL', 'SUFFICIENT');

-- CreateEnum
CREATE TYPE "SubcontractingGoalType" AS ENUM ('SMALL_BUSINESS', 'SMALL_DISADVANTAGED_BUSINESS', 'SDVOSB', 'VOSB', 'WOSB', 'HUBZONE', 'ANC_TRIBAL', 'HBCU_MI', 'OTHER');

-- CreateEnum
CREATE TYPE "SubcontractingGoalTargetType" AS ENUM ('PERCENT', 'AMOUNT');

-- CreateEnum
CREATE TYPE "SubcontractingGoalSource" AS ENUM ('SOLICITATION', 'SUBCONTRACTING_PLAN', 'CONTRACT', 'HUMAN_ENTRY');

-- CreateEnum
CREATE TYPE "SubcontractingGoalStatus" AS ENUM ('ACTIVE', 'ACHIEVED', 'MISSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SubcontractingGoalRiskState" AS ENUM ('ON_TRACK', 'WATCH', 'AT_RISK', 'MISSED', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "BenchmarkDataSufficiency" AS ENUM ('INSUFFICIENT_DATA', 'PARTIAL', 'SUFFICIENT');

-- CreateEnum
CREATE TYPE "BenchmarkFilterLevel" AS ENUM ('LEVEL_1_NAICS_AGENCY_SETASIDE_BAND', 'LEVEL_2_NAICS_AGENCY_BAND', 'LEVEL_3_NAICS_BAND', 'LEVEL_4_NAICS', 'NONE');

-- CreateEnum
CREATE TYPE "CompetitiveRangeState" AS ENUM ('BELOW_HISTORICAL_RANGE', 'WITHIN_HISTORICAL_RANGE', 'ABOVE_HISTORICAL_RANGE', 'EXTREME_OUTLIER', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "CapabilityNarrativeCategory" AS ENUM ('TECHNICAL_NARRATIVE', 'DIFFERENTIATOR', 'MANAGEMENT_APPROACH', 'QUALITY_APPROACH', 'BOILERPLATE', 'OTHER');

-- CreateEnum
CREATE TYPE "CapabilityNarrativeStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CapabilityNarrativeVersionStatus" AS ENUM ('DRAFT', 'APPROVED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ActualIndirectRateSource" AS ENUM ('MANUAL_ENTRY', 'IMPORT', 'DERIVED_FROM_LEDGER');

-- CreateEnum
CREATE TYPE "ActualIndirectRateStatus" AS ENUM ('DRAFT', 'FINAL', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "DcaaReadinessVerdict" AS ENUM ('PASS', 'FAIL', 'WARNING', 'MANUAL_REVIEW', 'INSUFFICIENT_DATA', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "DcaaReadinessSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "CashFlowConfidenceState" AS ENUM ('BANDED', 'DETERMINISTIC_ONLY', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "IntelligenceDataSufficiency" AS ENUM ('SUFFICIENT', 'PARTIAL', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "WinLossSegmentType" AS ENUM ('OVERALL', 'AGENCY', 'NAICS', 'CONTRACT_VEHICLE', 'SET_ASIDE', 'VALUE_BAND');

-- CreateEnum
CREATE TYPE "CaptureScoreState" AS ENUM ('SCORED', 'EXPLORATORY', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "CaptureRecommendationStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "GovContactRole" AS ENUM ('CONTRACTING_OFFICER', 'CONTRACT_SPECIALIST', 'COR', 'PROGRAM_MANAGER', 'SMALL_BUSINESS_SPECIALIST', 'TECHNICAL_LEAD', 'OTHER');

-- CreateEnum
CREATE TYPE "CrmContactStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DEPARTED');

-- CreateEnum
CREATE TYPE "CrmActivityType" AS ENUM ('CALL', 'MEETING', 'EMAIL', 'INDUSTRY_DAY', 'SITE_VISIT', 'CAPABILITY_BRIEFING', 'CONFERENCE', 'NOTE', 'OTHER');

-- CreateEnum
CREATE TYPE "CrmFollowUpStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CrmPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ClinLevel" AS ENUM ('TASK_ORDER', 'CLIN', 'SUB_CLIN');

-- CreateEnum
CREATE TYPE "BudgetStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "BudgetCategory" AS ENUM ('LABOR', 'ODC', 'SUBCONTRACT', 'TRAVEL', 'MATERIAL', 'INDIRECT', 'OTHER');

-- CreateEnum
CREATE TYPE "AllocationStatus" AS ENUM ('PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_RECEIVED', 'COMPLETE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SubcontractInvoiceStatus" AS ENUM ('RECEIVED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PAID');

-- CreateEnum
CREATE TYPE "FlowDownState" AS ENUM ('INSUFFICIENT_DATA', 'REVIEW_REQUIRED', 'APPLICABLE_CONFIRMED', 'NOT_APPLICABLE_CONFIRMED', 'INCLUDED', 'NOT_INCLUDED');

-- CreateEnum
CREATE TYPE "CostSourceType" AS ENUM ('MANUAL', 'SUBCONTRACT_INVOICE');

-- CreateEnum
CREATE TYPE "PersonnelEmploymentType" AS ENUM ('EMPLOYEE', 'CONTRACTOR', 'CONSULTANT', 'SUBCONTRACTOR_STAFF', 'PROSPECTIVE');

-- CreateEnum
CREATE TYPE "QualificationVerification" AS ENUM ('UNVERIFIED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ResumeStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PersonnelSource" AS ENUM ('INTERNAL', 'PARTNER_SUBMITTED', 'IMPORTED_FROM_USER');

-- CreateEnum
CREATE TYPE "PartnerEngagementScope" AS ENUM ('OPPORTUNITY', 'TEAMING_ARRANGEMENT', 'CONTRACT', 'PURCHASE_ORDER');

-- CreateEnum
CREATE TYPE "PartnerSubmissionStatus" AS ENUM ('PENDING_REVIEW', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PartnerDeliverableSubmissionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'CHANGES_REQUESTED', 'ACCEPTED_BY_PRIME');

-- CreateEnum
CREATE TYPE "ApiTokenKind" AS ENUM ('MCP', 'PUBLIC_API');

-- CreateEnum
CREATE TYPE "IntegrationCategory" AS ENUM ('ACCOUNTING', 'CALENDAR', 'CHAT', 'ESIGNATURE');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('QUICKBOOKS', 'UNANET', 'DELTEK', 'GOOGLE_CALENDAR', 'MICROSOFT_CALENDAR', 'SLACK', 'MICROSOFT_TEAMS', 'DOCUSIGN');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('NOT_CONFIGURED', 'CREDENTIAL_REQUIRED', 'PENDING', 'CONNECTED', 'ERROR', 'EXPIRED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "SignatureRequestStatus" AS ENUM ('DRAFT', 'READY_TO_SEND', 'SENT', 'VIEWED', 'PARTIALLY_SIGNED', 'COMPLETED', 'DECLINED', 'VOIDED', 'ERROR');

-- CreateEnum
CREATE TYPE "SignatureDocumentType" AS ENUM ('NDA', 'TEAMING_AGREEMENT', 'SUBCONTRACT', 'OTHER');

-- CreateEnum
CREATE TYPE "SsoProviderType" AS ENUM ('OIDC', 'SAML');

-- CreateTable
CREATE TABLE "consulting_firms" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "lastIngestedAt" TIMESTAMP(3),
    "lastMatchNotifiedAt" TIMESTAMP(3),
    "flatLateFee" DECIMAL(14,2),
    "penaltyPercent" DECIMAL(5,2),
    "samApiKey" TEXT,
    "anthropicApiKey" TEXT,
    "llmProvider" TEXT NOT NULL DEFAULT 'claude',
    "openaiApiKey" TEXT,
    "insightEngineApiKey" TEXT,
    "localaiBaseUrl" TEXT,
    "localaiModel" TEXT,
    "deepseekApiKey" TEXT,
    "purchasedAddons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isVeteranOwned" BOOLEAN NOT NULL DEFAULT false,
    "proposalTokens" INTEGER NOT NULL DEFAULT 0,
    "lastTokenRefreshAt" TIMESTAMP(3),
    "brandingLogoUrl" TEXT,
    "brandingPrimaryColor" TEXT DEFAULT '#fbbf24',
    "brandingSecondaryColor" TEXT DEFAULT '#f59e0b',
    "brandingDisplayName" TEXT,
    "brandingTagline" TEXT,
    "brandingFaviconUrl" TEXT,
    "winnersIntelOptIn" BOOLEAN NOT NULL DEFAULT false,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "lifetimeAccessAt" TIMESTAMP(3),
    "isOwnerComp" BOOLEAN NOT NULL DEFAULT false,
    "subdomain" TEXT,
    "customDomain" TEXT,
    "customDomainVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consulting_firms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "extraPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isEmailVerified" BOOLEAN NOT NULL DEFAULT false,
    "emailVerifiedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,
    "mfaRecoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mfaEnrolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bid_decision_history" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "clientCompanyId" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "winProbability" DOUBLE PRECISION,
    "fitScore" DOUBLE PRECISION,
    "marketScore" DOUBLE PRECISION,
    "expectedValue" DOUBLE PRECISION,
    "roiRatio" DOUBLE PRECISION,
    "changedBy" TEXT,
    "changeReason" TEXT,
    "snapshotJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bid_decision_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "naics_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "sector" TEXT,

    CONSTRAINT "naics_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_naics" (
    "id" TEXT NOT NULL,
    "clientCompanyId" TEXT NOT NULL,
    "naicsCodeId" TEXT NOT NULL,

    CONSTRAINT "client_naics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_companies" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cage" TEXT,
    "uei" TEXT,
    "naicsCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pscCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sdvosb" BOOLEAN NOT NULL DEFAULT false,
    "wosb" BOOLEAN NOT NULL DEFAULT false,
    "hubzone" BOOLEAN NOT NULL DEFAULT false,
    "smallBusiness" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "email" TEXT,
    "primaryContactName" TEXT,
    "primaryContactEmail" TEXT,
    "notes" TEXT,
    "ein" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "streetAddress" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zipCode" TEXT,
    "samRegStatus" TEXT,
    "samRegExpiry" TIMESTAMP(3),
    "contractVehicles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bondingCapacity" DECIMAL(14,2),
    "employeeCount" INTEGER,
    "hasFso" BOOLEAN NOT NULL DEFAULT false,
    "securityClearances" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isoCertifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agenciesOfInterest" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capabilityKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sdvosbCertExpiry" TIMESTAMP(3),
    "wosbCertExpiry" TIMESTAMP(3),
    "hubzoneCertExpiry" TIMESTAMP(3),
    "brandingLogoUrl" TEXT,
    "brandingPrimaryColor" TEXT,
    "brandingSecondaryColor" TEXT,
    "brandingDisplayName" TEXT,
    "brandingTagline" TEXT,
    "brandingFooterAddress" TEXT,
    "brandingPreparedByLine" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunities" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "samNoticeId" TEXT,
    "solicitationNumber" TEXT,
    "title" TEXT NOT NULL,
    "agency" TEXT NOT NULL,
    "subagency" TEXT,
    "office" TEXT,
    "naicsCode" TEXT NOT NULL DEFAULT '',
    "naicsCodeId" TEXT,
    "psc" TEXT,
    "pscDescription" TEXT,
    "setAsideType" TEXT NOT NULL DEFAULT 'NONE',
    "marketCategory" TEXT NOT NULL DEFAULT 'SERVICES',
    "estimatedValue" DECIMAL(14,2),
    "estimatedValueMin" DECIMAL(14,2),
    "estimatedValueMax" DECIMAL(14,2),
    "postedDate" TIMESTAMP(3),
    "responseDeadline" TIMESTAMP(3) NOT NULL,
    "archiveDate" TIMESTAMP(3),
    "placeOfPerformance" TEXT,
    "sourceUrl" TEXT,
    "description" TEXT,
    "scoreBreakdown" JSONB,
    "probabilityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expectedValue" DECIMAL(14,2),
    "isScored" BOOLEAN NOT NULL DEFAULT false,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'ACTIVE',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "source" "OpportunitySource" NOT NULL DEFAULT 'SAM_GOV',
    "isEnriched" BOOLEAN NOT NULL DEFAULT false,
    "historicalWinner" TEXT,
    "historicalAvgAward" DECIMAL(14,2),
    "historicalAwardCount" INTEGER,
    "competitionCount" INTEGER,
    "incumbentProbability" DOUBLE PRECISION,
    "agencySmallBizRate" DOUBLE PRECISION,
    "agencySdvosbRate" DOUBLE PRECISION,
    "recompeteFlag" BOOLEAN NOT NULL DEFAULT false,
    "noticeType" TEXT,
    "descriptionHtml" TEXT,
    "descriptionEnrichmentStatus" TEXT,
    "descriptionEnrichmentAttemptedAt" TIMESTAMP(3),
    "descriptionEnrichedAt" TIMESTAMP(3),
    "descriptionEnrichmentError" TEXT,
    "pointOfContact" JSONB,
    "resourceLinks" JSONB,
    "extractedClauses" JSONB,
    "offersReceived" INTEGER,
    "extentCompeted" TEXT,
    "documentIntelScore" DOUBLE PRECISION,
    "scopeAlignmentScore" DOUBLE PRECISION,
    "technicalComplexScore" DOUBLE PRECISION,
    "incumbentSignalDetected" BOOLEAN NOT NULL DEFAULT false,
    "contractVehicle" TEXT,
    "vehicleType" TEXT,
    "vehicleConfidence" DOUBLE PRECISION,
    "deadlineUrgencyScore" DOUBLE PRECISION,
    "densityRatio" DOUBLE PRECISION,
    "agencyHistoryScore" DOUBLE PRECISION,
    "savedProposalOutline" JSONB,
    "savedProposalAnswers" JSONB,
    "savedProposalStep" TEXT,
    "savedProposalDraft" JSONB,
    "savedProposalPdfKey" TEXT,
    "savedProposalDraftAt" TIMESTAMP(3),
    "savedProposalBranding" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sourceConfigId" TEXT,
    "externalId" TEXT,
    "sourceFirstSeenAt" TIMESTAMP(3),
    "sourceLastSeenAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3),
    "sourceLastSyncedAt" TIMESTAMP(3),
    "dataQuality" "SourceDataQuality" NOT NULL DEFAULT 'UNVERIFIED',
    "sourceMetadata" JSONB,
    "presolicitationKind" TEXT,

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amendments" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "amendmentNo" TEXT,
    "amendmentNumber" TEXT,
    "title" TEXT,
    "description" TEXT,
    "issuedDate" TIMESTAMP(3),
    "postedDate" TIMESTAMP(3),
    "plainLanguageSummary" TEXT,
    "interpretedAt" TIMESTAMP(3),

    CONSTRAINT "amendments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "award_history" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "awardingAgency" TEXT NOT NULL DEFAULT '',
    "recipientName" TEXT NOT NULL DEFAULT '',
    "recipientUei" TEXT,
    "awardAmount" DECIMAL(14,2) NOT NULL,
    "awardDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "baseAndAllOptions" DECIMAL(14,2),
    "naics" TEXT,
    "psc" TEXT,
    "awardType" TEXT,
    "contractNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "award_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_documents" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileUrl" TEXT,
    "isAmendment" BOOLEAN NOT NULL DEFAULT false,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "analysisStatus" "DocumentAnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "analysisError" TEXT,
    "scopeKeywords" TEXT[],
    "complexityScore" DOUBLE PRECISION,
    "alignmentScore" DOUBLE PRECISION,
    "incumbentSignals" TEXT[],
    "rawAnalysis" JSONB,
    "analyzedAt" TIMESTAMP(3),
    "extractionStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "extractedRequirementCount" INTEGER NOT NULL DEFAULT 0,
    "extractionConfidence" DOUBLE PRECISION,
    "extractionError" TEXT,
    "extractedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunity_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_jobs" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "type" "IngestionJobType" NOT NULL,
    "status" "IngestionJobStatus" NOT NULL DEFAULT 'PENDING',
    "opportunitiesFound" INTEGER,
    "opportunitiesNew" INTEGER,
    "enrichedCount" INTEGER,
    "scoringJobsQueued" INTEGER,
    "errors" INTEGER,
    "errorDetail" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_records" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "clientCompanyId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "wasOnTime" BOOLEAN NOT NULL DEFAULT true,
    "penaltyAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "status" "ComplianceStatus" NOT NULL DEFAULT 'PENDING',
    "outcome" "SubmissionOutcome",
    "outcomeRecordedAt" TIMESTAMP(3),
    "outcomeNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bid_pursuits" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "status" "PursuitStatus" NOT NULL DEFAULT 'REVIEWING',
    "source" "PursuitSource" NOT NULL DEFAULT 'USER',
    "probabilityAtDecision" DOUBLE PRECISION,
    "submissionRecordId" TEXT,
    "snoozedUntil" TIMESTAMP(3),
    "firstViewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "pipelineStage" "PipelineStage" NOT NULL DEFAULT 'IDENTIFIED',
    "priority" "PursuitPriority" NOT NULL DEFAULT 'MEDIUM',
    "ownerUserId" TEXT,
    "nextAction" TEXT,
    "nextActionDueAt" TIMESTAMP(3),
    "notes" TEXT,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "closeNote" TEXT,

    CONSTRAINT "bid_pursuits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_penalties" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "clientCompanyId" TEXT NOT NULL,
    "submissionRecordId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "penaltyType" "PenaltyType" NOT NULL DEFAULT 'OTHER',
    "reason" TEXT NOT NULL,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "paidAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_penalties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_stats" (
    "id" TEXT NOT NULL,
    "clientCompanyId" TEXT NOT NULL,
    "totalOpportunities" INTEGER NOT NULL DEFAULT 0,
    "totalSubmitted" INTEGER NOT NULL DEFAULT 0,
    "totalWon" INTEGER NOT NULL DEFAULT 0,
    "totalLost" INTEGER NOT NULL DEFAULT 0,
    "submissionsOnTime" INTEGER NOT NULL DEFAULT 0,
    "submissionsLate" INTEGER NOT NULL DEFAULT 0,
    "completionRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPenalties" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lastCalculatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "performance_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bid_decisions" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "clientCompanyId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "decision" "BidDecisionStatus" NOT NULL DEFAULT 'PENDING',
    "recommendation" TEXT,
    "rationale" TEXT,
    "winProbability" DOUBLE PRECISION,
    "expectedRevenue" DECIMAL(14,2),
    "proposalCostEstimate" DECIMAL(14,2),
    "expectedValue" DECIMAL(14,2),
    "netExpectedValue" DECIMAL(14,2),
    "roiRatio" DOUBLE PRECISION,
    "complianceGate" TEXT,
    "fitScore" DOUBLE PRECISION,
    "marketScore" DOUBLE PRECISION,
    "complianceStatus" "ComplianceStatus" NOT NULL DEFAULT 'PENDING',
    "riskScore" INTEGER,
    "explanationJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bid_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scorecard_criterion_configs" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 0,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scorecard_criterion_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scorecards" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "bidPursuitId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "status" "QualificationStatus" NOT NULL DEFAULT 'NOT_REVIEWED',
    "totalScore" INTEGER NOT NULL DEFAULT 0,
    "recommendation" "ScorecardRecommendation",
    "recommendationVersion" TEXT NOT NULL DEFAULT 'scorecard-v1',
    "finalDecision" "QualificationStatus",
    "isOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "overriddenByUserId" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reviewerUserId" TEXT,
    "reviewerComments" TEXT,
    "submittedForReviewAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scorecards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scorecard_criteria" (
    "id" TEXT NOT NULL,
    "scorecardId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 0,
    "score" INTEGER,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "evidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scorecard_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scorecard_decisions" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "scorecardId" TEXT NOT NULL,
    "bidPursuitId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "status" "QualificationStatus" NOT NULL,
    "recommendation" "ScorecardRecommendation",
    "totalScore" INTEGER NOT NULL DEFAULT 0,
    "isOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "reviewerComments" TEXT,
    "changedByUserId" TEXT,
    "changeReason" TEXT,
    "snapshotJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scorecard_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gate_reviews" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "bidPursuitId" TEXT NOT NULL,
    "scorecardId" TEXT,
    "opportunityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'GATE',
    "reviewerUserId" TEXT,
    "dueDate" TIMESTAMP(3),
    "status" "GateReviewStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "outcome" TEXT,
    "comments" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gate_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_notifications" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "linkPath" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),
    "isArchived" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "user_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_portal_users" (
    "id" TEXT NOT NULL,
    "clientCompanyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "notifyDeliverables" BOOLEAN NOT NULL DEFAULT true,
    "notifyDeadlines" BOOLEAN NOT NULL DEFAULT true,
    "notifyApprovals" BOOLEAN NOT NULL DEFAULT true,
    "smsPhone" TEXT,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_portal_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_requirements" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "clientCompanyId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "templateId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "isPenaltyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "penaltyAmount" DECIMAL(12,2),
    "penaltyPercent" DECIMAL(5,2),
    "status" "DocumentRequirementStatus" NOT NULL DEFAULT 'PENDING',
    "submittedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_templates" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "createdById" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_rewards" (
    "id" TEXT NOT NULL,
    "clientCompanyId" TEXT NOT NULL,
    "rewardType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "value" DECIMAL(12,2),
    "percentDiscount" DECIMAL(5,2),
    "isRedeemed" BOOLEAN NOT NULL DEFAULT false,
    "redeemedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "triggerReason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_logs" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "entityType" "ComplianceLogEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "reason" TEXT,
    "triggeredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_documents" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "clientCompanyId" TEXT NOT NULL,
    "documentType" "ClientDocumentType" NOT NULL DEFAULT 'OTHER',
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL DEFAULT 0,
    "storageKey" TEXT NOT NULL,
    "fileUrl" TEXT,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "isSharedAsTemplate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared_templates" (
    "id" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "submittedByFirmId" TEXT NOT NULL,
    "documentType" "ClientDocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "anonymizedStorageKey" TEXT NOT NULL,
    "status" "SharedTemplateStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewNotes" TEXT,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shared_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_matrices" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "sourceText" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "bidGuidanceJson" JSONB,
    "bidGuidanceAt" TIMESTAMP(3),

    CONSTRAINT "compliance_matrices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matrix_requirements" (
    "id" TEXT NOT NULL,
    "matrixId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "sectionType" TEXT NOT NULL DEFAULT 'INSTRUCTION',
    "requirementText" TEXT NOT NULL,
    "proposalSection" TEXT,
    "status" "MatrixRequirementStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "notes" TEXT,
    "isMandatory" BOOLEAN NOT NULL DEFAULT true,
    "farReference" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "sourceDocumentId" TEXT,
    "sourcePageNumber" INTEGER,
    "evidenceText" TEXT,
    "extractionMethod" TEXT NOT NULL DEFAULT 'AI',
    "extractionConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "isManuallyVerified" BOOLEAN NOT NULL DEFAULT false,
    "manualOverrideReason" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "ownerUserId" TEXT,
    "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
    "reviewReason" TEXT,
    "proposalSectionId" TEXT,
    "coverageStatus" TEXT NOT NULL DEFAULT 'UNCOVERED',
    "coverageScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "consultingFirmId" TEXT,
    "reviewerUserId" TEXT,
    "dueDate" TIMESTAMP(3),
    "completionPercent" INTEGER NOT NULL DEFAULT 0,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "blockerReason" TEXT,
    "relatedStandingDocumentId" TEXT,
    "relatedSubmissionItemId" TEXT,
    "amendmentImpact" TEXT,
    "amendmentRevisionId" TEXT,
    "lastActivityAt" TIMESTAMP(3),
    "extractionJobId" TEXT,
    "lmRole" TEXT,

    CONSTRAINT "matrix_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_opportunity_declines" (
    "id" TEXT NOT NULL,
    "clientCompanyId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "declinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "client_opportunity_declines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_portal_uploads" (
    "id" TEXT NOT NULL,
    "clientCompanyId" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL DEFAULT 0,
    "storageKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_portal_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_usage_logs" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "monthlyPriceUsd" DECIMAL(10,2) NOT NULL,
    "annualPriceUsd" DECIMAL(10,2) NOT NULL,
    "maxUsers" INTEGER NOT NULL,
    "maxClients" INTEGER NOT NULL,
    "aiCallsPerMonth" INTEGER NOT NULL,
    "features" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "billingCycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "trialEndsAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "invoiceNumber" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "subtotalUsd" DECIMAL(10,2) NOT NULL,
    "taxUsd" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalUsd" DECIMAL(10,2) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line_items" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPriceUsd" DECIMAL(10,4) NOT NULL,
    "totalUsd" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addon_subscriptions" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "addonSlug" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "addon_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_webhook_events" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_municipal_opportunities" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "agency" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "contractLevel" "ContractLevel" NOT NULL DEFAULT 'STATE',
    "naicsCode" TEXT,
    "estimatedValue" DECIMAL(18,2),
    "responseDeadline" TIMESTAMP(3),
    "description" TEXT,
    "solicitationNumber" TEXT,
    "contactEmail" TEXT,
    "sourceUrl" TEXT,
    "probabilityScore" DOUBLE PRECISION,
    "isScored" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "state_municipal_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcontract_opportunities" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "primeContractor" TEXT NOT NULL,
    "primeContractorUei" TEXT,
    "naicsCode" TEXT,
    "agency" TEXT,
    "estimatedValue" DECIMAL(18,2),
    "responseDeadline" TIMESTAMP(3),
    "description" TEXT,
    "contactEmail" TEXT,
    "contactName" TEXT,
    "sourceUrl" TEXT,
    "setAside" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "dismissedReason" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "savedOpportunityId" TEXT,
    "externalId" TEXT,
    "scrapedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subcontract_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcontract_contacts" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "primeContractor" TEXT NOT NULL,
    "primeContractorUei" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "agency" TEXT,
    "naicsCode" TEXT,
    "setAside" TEXT,
    "sourceUrl" TEXT,
    "source" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timesSeen" INTEGER NOT NULL DEFAULT 1,
    "hasValidEmail" BOOLEAN NOT NULL DEFAULT false,
    "lastOpportunityId" TEXT,
    "lastOpportunityTitle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subcontract_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "naics_competitive_density" (
    "id" TEXT NOT NULL,
    "naicsCode" TEXT NOT NULL,
    "avgBidders" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "medianBidders" DOUBLE PRECISION,
    "avgAwardValue" DOUBLE PRECISION,
    "smallBizRate" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "sdvosbRate" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "totalContracts" INTEGER NOT NULL DEFAULT 0,
    "lastRefreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "naics_competitive_density_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agency_award_profiles" (
    "id" TEXT NOT NULL,
    "agencyName" TEXT NOT NULL,
    "avgAwardValue" DOUBLE PRECISION,
    "smallBizRate" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "sdvosbRate" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "womenOwnedRate" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "hubzoneRate" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "totalAwards" INTEGER NOT NULL DEFAULT 0,
    "typicalNaics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastRefreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agency_award_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliverable_comments" (
    "id" TEXT NOT NULL,
    "deliverableId" TEXT NOT NULL,
    "authorType" "CommentAuthorType" NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "parentId" TEXT,
    "isResolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deliverable_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_runs" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "triggeredBy" TEXT,
    "status" TEXT NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "yearsBack" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "methodVersion" TEXT NOT NULL DEFAULT 'v2-permutation',
    "cutoffDate" TIMESTAMP(3),
    "predictionCount" INTEGER,
    "brierScore" DOUBLE PRECISION,
    "meanProbability" DOUBLE PRECISION,
    "calibrationBins" JSONB,
    "factorMeans" JSONB,
    "logLoss" DOUBLE PRECISION,
    "rocAuc" DOUBLE PRECISION,
    "ece" DOUBLE PRECISION,
    "brierReliability" DOUBLE PRECISION,
    "brierResolution" DOUBLE PRECISION,
    "brierUncertainty" DOUBLE PRECISION,
    "calibrationCurve" JSONB,
    "plattA" DOUBLE PRECISION,
    "plattB" DOUBLE PRECISION,
    "plattPreBrier" DOUBLE PRECISION,
    "plattPostBrier" DOUBLE PRECISION,

    CONSTRAINT "backtest_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_watchlist_entries" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "naicsCode" TEXT,
    "agency" TEXT,
    "lastDigestAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "market_watchlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_monitoring_profiles" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "alertFrequency" "MonitoringAlertFrequency" NOT NULL DEFAULT 'DISABLED',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "lastResultCount" INTEGER,
    "lastAppliedAt" TIMESTAMP(3),
    "ownerUserId" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'FIRM',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "alertInApp" BOOLEAN NOT NULL DEFAULT true,
    "alertEmail" BOOLEAN NOT NULL DEFAULT false,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "lastEvaluatedAt" TIMESTAMP(3),
    "nextEvaluationAt" TIMESTAMP(3),
    "lastAlertSentAt" TIMESTAMP(3),
    "lastAlertCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_monitoring_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_predictions" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "agency" TEXT NOT NULL,
    "naicsCode" TEXT NOT NULL,
    "awardAmount" DOUBLE PRECISION NOT NULL,
    "awardDate" TIMESTAMP(3) NOT NULL,
    "recipientName" TEXT NOT NULL,
    "recipientUei" TEXT,
    "syntheticClientNaics" TEXT[],
    "syntheticSdvosb" BOOLEAN NOT NULL,
    "syntheticWosb" BOOLEAN NOT NULL,
    "syntheticHubzone" BOOLEAN NOT NULL,
    "syntheticSmallBiz" BOOLEAN NOT NULL,
    "predictedProbability" DOUBLE PRECISION NOT NULL,
    "rawScore" DOUBLE PRECISION NOT NULL,
    "features" JSONB NOT NULL,
    "observedOutcome" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_predictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beta_access_requests" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firmName" TEXT,
    "contactName" TEXT,
    "naicsFocus" TEXT,
    "source" TEXT,
    "notes" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "contactedAt" TIMESTAMP(3),
    "invitedAt" TIMESTAMP(3),
    "invitedFirmId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "beta_access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beta_feedback" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "npsScore" INTEGER NOT NULL,
    "killFeature" TEXT,
    "addFeature" TEXT,
    "freeText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "beta_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "far_clauses" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "subpartNumber" TEXT,
    "title" TEXT NOT NULL,
    "prescribedAt" TEXT,
    "applicableContractTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "setAsideTriggers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agencyTriggers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "flowDownRequired" BOOLEAN NOT NULL DEFAULT false,
    "flowDownThreshold" DECIMAL(14,2),
    "prerequisiteClauseCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "prohibitedClauseCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "commercialItemException" BOOLEAN NOT NULL DEFAULT false,
    "isBlocking" BOOLEAN NOT NULL DEFAULT false,
    "effectiveDate" TIMESTAMP(3),
    "lastRevisedDate" TIMESTAMP(3),
    "text" TEXT NOT NULL DEFAULT '',
    "summary" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "far_clauses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dfars_clauses" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prescribedAt" TEXT,
    "applicableContractTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agencyTriggers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "flowDownRequired" BOOLEAN NOT NULL DEFAULT false,
    "flowDownThreshold" DECIMAL(14,2),
    "prerequisiteClauseCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isBlocking" BOOLEAN NOT NULL DEFAULT false,
    "effectiveDate" TIMESTAMP(3),
    "lastRevisedDate" TIMESTAMP(3),
    "text" TEXT NOT NULL DEFAULT '',
    "summary" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "dfars_clauses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nist_800_171_controls" (
    "id" TEXT NOT NULL,
    "controlId" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "cmmcLevels" INTEGER[] DEFAULT ARRAY[]::INTEGER[],

    CONSTRAINT "nist_800_171_controls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmmc_practices" (
    "id" TEXT NOT NULL,
    "practiceId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "domain" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "nistMapping" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "cmmc_practices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_508_criteria" (
    "id" TEXT NOT NULL,
    "criterionId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "appliesTo" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "section_508_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "far_clause_applicabilities" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "clauseSource" TEXT NOT NULL DEFAULT 'FAR',
    "clauseCode" TEXT NOT NULL,
    "applicabilitySource" TEXT NOT NULL DEFAULT 'AI_EXTRACTED',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "isBlocking" BOOLEAN NOT NULL DEFAULT false,
    "isFlowDown" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "matrixRequirementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "far_clause_applicabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorKind" TEXT DEFAULT 'INTERNAL_USER',
    "externalActorId" TEXT,
    "actorRole" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "rationale" TEXT,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "farContextHash" TEXT,
    "farClausesReferenced" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "llmProvider" TEXT,
    "llmModel" TEXT,
    "llmTask" TEXT,
    "promptHash" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedCostUsd" DECIMAL(10,6),
    "sourceIp" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposals" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_sections" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "proposalId" TEXT,
    "sectionNumber" TEXT,
    "title" TEXT NOT NULL,
    "outline" TEXT,
    "draft" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "ownerUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OUTLINE',
    "reviewerUserId" TEXT,
    "dueDate" TIMESTAMP(3),
    "reviewDate" TIMESTAMP(3),
    "notes" TEXT,
    "dependencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "attachmentKey" TEXT,
    "attachmentName" TEXT,
    "submittedForReviewAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "isAiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "generationStatus" TEXT NOT NULL DEFAULT 'IDLE',
    "generationError" TEXT,
    "pageLimit" INTEGER,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proposal_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_section_versions" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "proposalSectionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'HUMAN',
    "isAiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_section_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_section_reviews" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "proposalSectionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "actorUserId" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_section_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_artifacts" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "artifactType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "fileStorageKey" TEXT,
    "fileType" TEXT,
    "fileSize" INTEGER,
    "externalUrl" TEXT,
    "pastPerformanceRecordId" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "evidence_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_evidence_links" (
    "id" TEXT NOT NULL,
    "proposalSectionId" TEXT NOT NULL,
    "evidenceArtifactId" TEXT NOT NULL,
    "rationale" TEXT,
    "paragraphAnchor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "section_evidence_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adherence_scores" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "proposalSectionId" TEXT,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "requirementCoverage" DOUBLE PRECISION,
    "evaluationAlignment" DOUBLE PRECISION,
    "evidenceSufficiency" DOUBLE PRECISION,
    "farClauseCoverage" DOUBLE PRECISION,
    "readability" DOUBLE PRECISION,
    "consistency" DOUBLE PRECISION,
    "ambiguity" DOUBLE PRECISION,
    "blockersJson" JSONB,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adherence_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "past_performance_records" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "clientCompanyId" TEXT,
    "contractNumber" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerAgency" TEXT,
    "customerPocName" TEXT,
    "customerPocEmail" TEXT,
    "customerPocPhone" TEXT,
    "contractType" TEXT,
    "totalValue" DECIMAL(14,2),
    "periodOfPerformanceStart" TIMESTAMP(3),
    "periodOfPerformanceEnd" TIMESTAMP(3),
    "cparsRating" TEXT,
    "cparsRatingDate" TIMESTAMP(3),
    "cparsLink" TEXT,
    "scopeSummary" TEXT NOT NULL DEFAULT '',
    "relevanceTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "contractTitle" TEXT,
    "contractingOffice" TEXT,
    "naicsCode" TEXT,
    "pscCode" TEXT,
    "fundedValue" DECIMAL(14,2),
    "performerRole" TEXT,
    "workPerformed" TEXT,
    "technicalCapabilities" TEXT,
    "resultsOutcomes" TEXT,
    "quantitativeMetrics" TEXT,
    "setAsideRelevance" TEXT,
    "referenceName" TEXT,
    "referenceTitle" TEXT,
    "referenceEmail" TEXT,
    "referencePhone" TEXT,
    "permissionToContact" BOOLEAN NOT NULL DEFAULT false,
    "referenceAvailability" TEXT,
    "internalNotes" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'DRAFT',
    "ownerUserId" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "linkedOpportunityId" TEXT,
    "sourceContractId" TEXT,
    "sourceSubmissionRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "past_performance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capture_plans" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'IDENTIFY',
    "winThemes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "discriminators" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ghostingTargets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capture_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capture_tasks" (
    "id" TEXT NOT NULL,
    "capturePlanId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capture_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "uei" TEXT,
    "cage" TEXT,
    "primarySetAsides" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "primaryNaicsCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "certifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cmmcLevel" INTEGER,
    "pastPerformanceLink" TEXT,
    "website" TEXT,
    "geography" TEXT,
    "partnerType" "PartnerType" NOT NULL DEFAULT 'BOTH',
    "pastRelationship" TEXT,
    "ownerUserId" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teaming_arrangements" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "arrangementType" TEXT NOT NULL,
    "scopePercent" DOUBLE PRECISION,
    "dollarShare" DECIMAL(14,2),
    "flowDownPackageId" TEXT,
    "notes" TEXT,
    "teamingStatus" "TeamingStatus" NOT NULL DEFAULT 'IDENTIFIED',
    "capabilityContribution" TEXT,
    "capabilityGap" TEXT,
    "workshareDescription" TEXT,
    "agreementStatus" "AgreementStatus" NOT NULL DEFAULT 'NONE',
    "agreementSignedDate" TIMESTAMP(3),
    "agreementDueDate" TIMESTAMP(3),
    "ndaStatus" "AgreementStatus" NOT NULL DEFAULT 'NONE',
    "ownerUserId" TEXT,
    "agreementDocumentKey" TEXT,
    "agreementDocumentName" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teaming_arrangements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teaming_agreement_drafts" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "teamingArrangementId" TEXT NOT NULL,
    "draftType" "TeamingDraftType" NOT NULL DEFAULT 'TEAMING_AGREEMENT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "content" TEXT NOT NULL,
    "generatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teaming_agreement_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_attestations" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "attestedByUserId" TEXT,
    "attestedByName" TEXT NOT NULL,
    "statementVersion" TEXT NOT NULL,
    "statementText" TEXT NOT NULL,
    "draftContentHash" TEXT NOT NULL,
    "attestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_attestations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitors" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL DEFAULT '',
    "uei" TEXT,
    "isIncumbent" BOOLEAN NOT NULL DEFAULT false,
    "perceivedStrengths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "perceivedWeaknesses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pastWinsAtAgency" INTEGER,
    "notes" TEXT,
    "evidenceKind" "EvidenceKind" NOT NULL DEFAULT 'COMPETITOR',
    "confidence" "EvidenceConfidence" NOT NULL DEFAULT 'NOT_AVAILABLE',
    "evidenceSource" TEXT,
    "whyShown" TEXT,
    "agency" TEXT,
    "naicsRelevant" BOOLEAN NOT NULL DEFAULT false,
    "pscRelevant" BOOLEAN NOT NULL DEFAULT false,
    "agencyRelevant" BOOLEAN NOT NULL DEFAULT false,
    "awardReference" TEXT,
    "awardValue" DECIMAL(14,2),
    "periodOfPerformance" TEXT,
    "relevantAwardCount" INTEGER,
    "relevantAwardValue" DECIMAL(14,2),
    "sourceRecordDate" TIMESTAMP(3),
    "lastRefreshedAt" TIMESTAMP(3),
    "verification" "IncumbentVerification" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "correctionReason" TEXT,
    "originalName" TEXT,
    "originalUei" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_cycles" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "cycleType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "approverUserId" TEXT,
    "approvalNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_comments" (
    "id" TEXT NOT NULL,
    "reviewCycleId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "proposalSectionId" TEXT,
    "matrixRequirementId" TEXT,
    "parentCommentId" TEXT,
    "body" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmmc_statuses" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "clientCompanyId" TEXT,
    "level" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "certifyingBody" TEXT,
    "certificationDate" TIMESTAMP(3),
    "expirationDate" TIMESTAMP(3),
    "scope" TEXT,
    "sprsScore" INTEGER,
    "poamCount" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cmmc_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_volumes" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "scenarioName" TEXT NOT NULL DEFAULT 'Base',
    "contractType" TEXT,
    "laborCategoriesJson" JSONB,
    "indirectRatesJson" JSONB,
    "odcLinesJson" JSONB,
    "travelLinesJson" JSONB,
    "totalProposedPrice" DECIMAL(14,2),
    "unallowableFlagsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cost_volumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tos_versions" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Terms of Service',
    "body" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tos_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beta_nda_versions" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Beta Non-Disclosure & IP Protection Agreement',
    "body" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "beta_nda_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beta_weekly_questionnaires" (
    "id" TEXT NOT NULL,
    "weekStarting" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Weekly Beta Feedback',
    "questionsJson" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "beta_weekly_questionnaires_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beta_questionnaire_responses" (
    "id" TEXT NOT NULL,
    "questionnaireId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "answersJson" JSONB NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "beta_questionnaire_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_agreements" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "user_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "winners_award_stage" (
    "id" TEXT NOT NULL,
    "usaspendingAwardId" TEXT NOT NULL,
    "pieceOfTheActionId" TEXT,
    "recipientUei" TEXT,
    "recipientName" TEXT,
    "recipientParentUei" TEXT,
    "agencyToptierCode" TEXT,
    "agencyToptierName" TEXT,
    "agencySubtierCode" TEXT,
    "awardingOfficeCode" TEXT,
    "fundingAgencyToptier" TEXT,
    "naics" TEXT,
    "pscCode" TEXT,
    "setAsideType" TEXT,
    "contractType" TEXT,
    "competitionExtent" TEXT,
    "numberOfOffersReceived" INTEGER,
    "totalObligation" DECIMAL(16,2),
    "baseExercisedOptions" DECIMAL(16,2),
    "baseAndAllOptions" DECIMAL(16,2),
    "periodOfPerformanceStart" TIMESTAMP(3),
    "periodOfPerformanceEnd" TIMESTAMP(3),
    "awardDate" TIMESTAMP(3),
    "fiscalYear" INTEGER,
    "placeOfPerformanceState" TEXT,
    "placeOfPerformanceCountry" TEXT,
    "recipientStateCode" TEXT,
    "recipientCountryCode" TEXT,
    "isRecompete" BOOLEAN NOT NULL DEFAULT false,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refreshBatchId" TEXT NOT NULL,

    CONSTRAINT "winners_award_stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "winners_subaward_stage" (
    "id" TEXT NOT NULL,
    "usaspendingSubawardId" TEXT NOT NULL,
    "primeAwardId" TEXT NOT NULL,
    "subAmount" DECIMAL(16,2),
    "subActionDate" TIMESTAMP(3),
    "subRecipientUei" TEXT,
    "subRecipientName" TEXT,
    "subRecipientParentUei" TEXT,
    "subRecipientStateCode" TEXT,
    "subRecipientSize" TEXT,
    "subRecipientSetAsideFlags" JSONB,
    "subDescription" TEXT,
    "subNaics" TEXT,
    "subPscCode" TEXT,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refreshBatchId" TEXT NOT NULL,

    CONSTRAINT "winners_subaward_stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teaming_relationships" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "clientCompanyId" TEXT NOT NULL,
    "primeUei" TEXT NOT NULL,
    "primeName" TEXT,
    "agencyCode" TEXT NOT NULL,
    "agencyName" TEXT,
    "status" "TeamingRelationshipStatus" NOT NULL DEFAULT 'IDENTIFIED',
    "fitScoreAtSave" DOUBLE PRECISION,
    "notes" TEXT,
    "lastOutreachAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "teaming_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipient_profiles" (
    "id" TEXT NOT NULL,
    "uei" TEXT NOT NULL,
    "legalName" TEXT,
    "cageCode" TEXT,
    "samRegStatus" TEXT,
    "samRegExpiry" TIMESTAMP(3),
    "website" TEXT,
    "phone" TEXT,
    "streetAddress" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zipCode" TEXT,
    "naicsCodes" JSONB,
    "sdvosb" BOOLEAN NOT NULL DEFAULT false,
    "wosb" BOOLEAN NOT NULL DEFAULT false,
    "hubzone" BOOLEAN NOT NULL DEFAULT false,
    "smallBusiness" BOOLEAN NOT NULL DEFAULT false,
    "vaOsdbuVerified" BOOLEAN NOT NULL DEFAULT false,
    "samFetchedAt" TIMESTAMP(3),
    "contactsFetchedAt" TIMESTAMP(3),
    "contactsProvider" TEXT,
    "contactsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recipient_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "tier" "ApiTokenTier" NOT NULL DEFAULT 'CORE',
    "kind" "ApiTokenKind" NOT NULL DEFAULT 'MCP',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "server_name" TEXT NOT NULL,
    "server_version" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "token_fp" CHAR(16) NOT NULL,
    "input_hash" CHAR(64) NOT NULL,
    "output_bytes" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "correlation_id" TEXT,
    "client_info" JSONB,

    CONSTRAINT "mcp_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scw_subaward_analyses" (
    "id" TEXT NOT NULL,
    "primeKey" TEXT NOT NULL,
    "primeUei" TEXT,
    "primeName" TEXT,
    "lookbackYears" INTEGER NOT NULL,
    "totalSubawardDollars" DECIMAL(16,2),
    "averageSubSize" DECIMAL(16,2),
    "sampleSize" INTEGER NOT NULL,
    "smallBusinessPercent" DOUBLE PRECISION,
    "sdvosbPercent" DOUBLE PRECISION,
    "topNaicsSubbed" JSONB,
    "sdvosbGoalGap" JSONB,
    "dataQuality" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scw_subaward_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scw_outreach_drafts" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "primeUei" TEXT,
    "primeName" TEXT NOT NULL,
    "outreachType" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "salutation" TEXT,
    "closing" TEXT,
    "factsCited" JSONB NOT NULL,
    "reviewChecklist" JSONB NOT NULL,
    "requiresHumanReview" BOOLEAN NOT NULL DEFAULT true,
    "humanApprovedAt" TIMESTAMP(3),
    "humanApprovedById" TEXT,
    "sentAt" TIMESTAMP(3),
    "recipientEmail" TEXT,
    "emailVerificationStatus" "EmailVerificationStatus" NOT NULL DEFAULT 'unknown',
    "emailSource" TEXT,
    "llmProvider" TEXT,
    "llmModel" TEXT,
    "tokensUsed" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scw_outreach_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "clientCompanyId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'EMAIL',
    "minMatchThreshold" INTEGER NOT NULL DEFAULT 70,
    "frequency" "NotificationFrequency" NOT NULL DEFAULT 'IMMEDIATE',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sent_notifications" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "clientCompanyId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "scoreAtSend" INTEGER NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'EMAIL',
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sent_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_programs" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "administeringAgency" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "officialUrl" TEXT NOT NULL,
    "prerequisites" TEXT[],
    "keyRequirements" TEXT[],
    "relevanceTags" TEXT[],
    "coreFor" TEXT[],
    "registrationModel" TEXT NOT NULL,
    "nextWindowOpensAt" TIMESTAMP(3),
    "nextWindowClosesAt" TIMESTAMP(3),
    "verificationStatus" TEXT NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3),
    "sourceUrls" TEXT[],
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_progress" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "programCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_award_training" (
    "id" TEXT NOT NULL,
    "awardKey" TEXT NOT NULL,
    "piid" TEXT NOT NULL,
    "naicsCode" TEXT NOT NULL,
    "agencyCode" TEXT,
    "agencyName" TEXT,
    "setAsideCode" TEXT,
    "extentCompetedCode" TEXT,
    "offersReceived" INTEGER,
    "recipientUei" TEXT NOT NULL,
    "recipientParentUei" TEXT,
    "recipientName" TEXT,
    "recipientStateCode" TEXT,
    "obligatedAmount" DECIMAL(16,2) NOT NULL,
    "actionDate" TIMESTAMP(3) NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "ingestBatchId" TEXT NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_award_training_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_win_priors" (
    "id" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "segmentLevel" TEXT NOT NULL,
    "naicsPrefix" TEXT NOT NULL,
    "setAsideBucket" TEXT NOT NULL,
    "awardCount" INTEGER NOT NULL,
    "offersKnownCount" INTEGER NOT NULL,
    "meanInvOffers" DOUBLE PRECISION NOT NULL,
    "shrunkMeanInvOffers" DOUBLE PRECISION NOT NULL,
    "meanOffers" DOUBLE PRECISION,
    "medianOffers" DOUBLE PRECISION,
    "singleOfferShare" DOUBLE PRECISION,
    "incumbencyShare" DOUBLE PRECISION,
    "shrunkIncumbencyShare" DOUBLE PRECISION,
    "builtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_win_priors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "who_wins_models" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "coefficients" JSONB NOT NULL,
    "featureStats" JSONB NOT NULL,
    "trainingGroups" INTEGER NOT NULL,
    "trainingConfig" JSONB NOT NULL,
    "evalReport" JSONB,
    "trainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "who_wins_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_heartbeats" (
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_profiles" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "samStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "samExpiryDate" TIMESTAMP(3),
    "uei" TEXT,
    "cageCode" TEXT,
    "naicsCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "setAsideCerts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reminderLeadDays" INTEGER NOT NULL DEFAULT 60,
    "ownerUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registration_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certifications" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'SET_ASIDE',
    "issuingBody" TEXT,
    "certNumber" TEXT,
    "issueDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "reminderLeadDays" INTEGER NOT NULL DEFAULT 60,
    "ownerUserId" TEXT,
    "documentKey" TEXT,
    "notes" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_policies" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "policyType" TEXT NOT NULL,
    "carrier" TEXT,
    "policyNumber" TEXT,
    "coverageAmount" DECIMAL(14,2),
    "effectiveDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "reminderLeadDays" INTEGER NOT NULL DEFAULT 60,
    "ownerUserId" TEXT,
    "documentKey" TEXT,
    "notes" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "clientCompanyId" TEXT,
    "contractNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "agency" TEXT,
    "contractingOffice" TEXT,
    "contractType" TEXT,
    "awardValue" DECIMAL(14,2),
    "fundedValue" DECIMAL(14,2),
    "ceilingValue" DECIMAL(14,2),
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "ownerUserId" TEXT,
    "customerContactName" TEXT,
    "customerContactEmail" TEXT,
    "customerContactPhone" TEXT,
    "description" TEXT,
    "notes" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_option_periods" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "optionValue" DECIMAL(14,2),
    "exerciseStatus" TEXT NOT NULL DEFAULT 'PLANNED',
    "decisionDate" TIMESTAMP(3),
    "exerciseDeadline" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_option_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clins" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "clinNumber" TEXT NOT NULL,
    "title" TEXT,
    "clinType" TEXT,
    "parentClinId" TEXT,
    "clinLevel" "ClinLevel" NOT NULL DEFAULT 'CLIN',
    "quantity" DECIMAL(14,2),
    "unit" TEXT,
    "unitPrice" DECIMAL(14,2),
    "fundedAmount" DECIMAL(14,2),
    "ceilingAmount" DECIMAL(14,2),
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_modifications" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "modNumber" TEXT NOT NULL,
    "modType" TEXT,
    "effectiveDate" TIMESTAMP(3),
    "signedDate" TIMESTAMP(3),
    "description" TEXT,
    "fundingChange" DECIMAL(14,2),
    "ceilingChange" DECIMAL(14,2),
    "startDateChange" TIMESTAMP(3),
    "endDateChange" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "appliedAt" TIMESTAMP(3),
    "attachmentKey" TEXT,
    "createdByUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_modifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_deliverables" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "clinId" TEXT,
    "name" TEXT NOT NULL,
    "cdrlNumber" TEXT,
    "description" TEXT,
    "deliverableType" TEXT,
    "frequency" TEXT,
    "dueDate" TIMESTAMP(3),
    "ownerUserId" TEXT,
    "reviewerUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "submissionDate" TIMESTAMP(3),
    "submittedByUserId" TEXT,
    "acceptanceStatus" TEXT,
    "acceptanceDate" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "attachmentKey" TEXT,
    "notes" TEXT,
    "lastReminderAt" TIMESTAMP(3),
    "lastEscalationAt" TIMESTAMP(3),
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "partnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_deliverables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_transactions" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "clinId" TEXT,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "effectiveDate" TIMESTAMP(3),
    "referenceNumber" TEXT,
    "modificationId" TEXT,
    "description" TEXT,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "isVoided" BOOLEAN NOT NULL DEFAULT false,
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funding_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_costs" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "clinId" TEXT,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "incurredDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "attachmentKey" TEXT,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "invoicedInvoiceId" TEXT,
    "sourceType" "CostSourceType" NOT NULL DEFAULT 'MANUAL',
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_labor_rates" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "clinId" TEXT,
    "categoryName" TEXT NOT NULL,
    "categoryCode" TEXT,
    "employeeRef" TEXT,
    "billingRate" DECIMAL(14,4),
    "costRate" DECIMAL(14,4),
    "rateType" TEXT NOT NULL DEFAULT 'BILLING',
    "effectiveStart" TIMESTAMP(3),
    "effectiveEnd" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_labor_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_entries" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "clinId" TEXT,
    "userId" TEXT NOT NULL,
    "laborCategory" TEXT NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "hours" DECIMAL(6,2) NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "approverUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "appliedBillingRate" DECIMAL(14,4),
    "appliedCostRate" DECIMAL(14,4),
    "billingAmount" DECIMAL(14,2),
    "costAmount" DECIMAL(14,2),
    "invoicedInvoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_invoices" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "invoiceDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "customerName" TEXT,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "adjustments" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amountPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paymentReference" TEXT,
    "notes" TEXT,
    "attachmentKey" TEXT,
    "createdByUserId" TEXT,
    "approvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_follow_ups" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "contactedAt" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "contactName" TEXT,
    "note" TEXT NOT NULL,
    "nextActionAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_invoice_line_items" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,2),
    "rate" DECIMAL(14,4),
    "amount" DECIMAL(14,2) NOT NULL,
    "clinId" TEXT,
    "sourceTimeEntryId" TEXT,
    "sourceCostId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_payments" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paymentDate" TIMESTAMP(3),
    "referenceNumber" TEXT,
    "method" TEXT,
    "notes" TEXT,
    "recordedByUserId" TEXT,
    "isVoided" BOOLEAN NOT NULL DEFAULT false,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_workspaces" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "proposalId" TEXT,
    "clientCompanyId" TEXT,
    "title" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "contractType" TEXT,
    "notes" TEXT,
    "preferredScenarioId" TEXT,
    "supersedesWorkspaceId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_scenarios" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isPreferred" BOOLEAN NOT NULL DEFAULT false,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "totalDirectLabor" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "totalFringe" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "totalOverhead" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "totalOdc" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "totalSubcontractor" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "totalGA" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "subtotalBeforeFee" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "totalFee" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "totalPrice" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "calculatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_labor_lines" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "categoryName" TEXT NOT NULL,
    "categoryCode" TEXT,
    "description" TEXT,
    "personnelCount" INTEGER,
    "hours" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "baseRate" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "periodLabel" TEXT,
    "escalationPct" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "directLaborAmount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_labor_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_indirect_rates" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rateType" TEXT NOT NULL,
    "percent" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "costBase" TEXT NOT NULL,
    "description" TEXT,
    "effectiveDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "source" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_indirect_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_other_costs" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "costCategory" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,2) NOT NULL DEFAULT 1,
    "unit" TEXT,
    "unitCost" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "vendorName" TEXT,
    "partnerId" TEXT,
    "teamingArrangementId" TEXT,
    "notes" TEXT,
    "attachmentKey" TEXT,
    "attachmentName" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_other_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_templates" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "laborLinesJson" JSONB,
    "indirectRatesJson" JSONB,
    "feeDefaultPct" DECIMAL(7,4),
    "escalationDefaultPct" DECIMAL(7,4),
    "effectiveDate" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_reviews" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "scenarioId" TEXT,
    "actorUserId" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_submissions" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "proposalId" TEXT,
    "title" TEXT NOT NULL,
    "finalDeadline" TIMESTAMP(3),
    "internalDeadline" TIMESTAMP(3),
    "submissionMethod" TEXT,
    "destinationDescription" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "readinessPercent" INTEGER NOT NULL DEFAULT 0,
    "ownerUserId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedByUserId" TEXT,
    "confirmationReference" TEXT,
    "confirmationAttachmentKey" TEXT,
    "confirmationAttachmentName" TEXT,
    "confirmationReceivedAt" TIMESTAMP(3),
    "overrideReason" TEXT,
    "overriddenByUserId" TEXT,
    "notes" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proposal_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_checklist_items" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "itemType" TEXT NOT NULL DEFAULT 'OTHER',
    "isMandatory" BOOLEAN NOT NULL DEFAULT true,
    "ownerUserId" TEXT,
    "dueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "isBlocker" BOOLEAN NOT NULL DEFAULT false,
    "blockerReason" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "sourceMatrixRequirementId" TEXT,
    "sourceProposalSectionId" TEXT,
    "sourceDocumentRequirementId" TEXT,
    "sourceSection" TEXT,
    "sourcePage" INTEGER,
    "attachmentKey" TEXT,
    "attachmentName" TEXT,
    "validationState" TEXT NOT NULL DEFAULT 'UNVALIDATED',
    "validationEvidence" TEXT,
    "validatedByUserId" TEXT,
    "validatedAt" TIMESTAMP(3),
    "isManuallyVerified" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "submission_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_status_history" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "actorUserId" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "past_performance_attachments" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "pastPerformanceRecordId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "past_performance_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "past_performance_selections" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "pastPerformanceRecordId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "proposalId" TEXT,
    "relevanceScore" INTEGER,
    "confidence" TEXT,
    "matchingFactors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missingFactors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "relevanceExplanation" TEXT,
    "scoredAt" TIMESTAMP(3),
    "scoreMethod" TEXT,
    "isSelected" BOOLEAN NOT NULL DEFAULT false,
    "selectedByUserId" TEXT,
    "selectedAt" TIMESTAMP(3),
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "past_performance_selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_source_configs" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "adapterKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "category" "SourceCategory" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "baseUrl" TEXT,
    "authEnvKey" TEXT,
    "configJson" JSONB NOT NULL DEFAULT '{}',
    "cursorValue" TEXT,
    "cursorUpdatedAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastSuccessfulSync" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureMessage" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "dataQuality" "SourceDataQuality" NOT NULL DEFAULT 'UNVERIFIED',
    "verification" "AdapterVerification" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 60,
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "stalenessHours" INTEGER NOT NULL DEFAULT 48,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunity_source_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_sync_runs" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "sourceConfigId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "mode" "SyncMode" NOT NULL DEFAULT 'INCREMENTAL',
    "status" "SyncRunStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "recordsFetched" INTEGER NOT NULL DEFAULT 0,
    "recordsCreated" INTEGER NOT NULL DEFAULT 0,
    "recordsUpdated" INTEGER NOT NULL DEFAULT 0,
    "recordsSkipped" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "cursorBefore" TEXT,
    "cursorAfter" TEXT,
    "errorMessage" TEXT,
    "rateLimited" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agency_forecasts" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "sourceConfigId" TEXT,
    "source" "SourceCategory" NOT NULL DEFAULT 'AGENCY_FORECAST',
    "externalId" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceReference" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceUpdatedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "dataQuality" "SourceDataQuality" NOT NULL DEFAULT 'UNVERIFIED',
    "sourceMetadata" JSONB,
    "agency" TEXT NOT NULL,
    "subAgency" TEXT,
    "contractingOffice" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "anticipatedSolicitationDate" TIMESTAMP(3),
    "anticipatedAwardDate" TIMESTAMP(3),
    "fiscalYear" INTEGER,
    "naicsCode" TEXT,
    "psc" TEXT,
    "setAsideExpectation" TEXT,
    "contractVehicle" TEXT,
    "estimatedValue" DECIMAL(14,2),
    "estimatedValueMin" DECIMAL(14,2),
    "estimatedValueMax" DECIMAL(14,2),
    "incumbentName" TEXT,
    "placeOfPerformance" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "completeness" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "linkedOpportunityId" TEXT,
    "linkState" "ForecastLinkState" NOT NULL DEFAULT 'UNLINKED',
    "linkEvidence" TEXT,
    "linkConfidence" DOUBLE PRECISION,
    "linkedAt" TIMESTAMP(3),
    "linkedByUserId" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_forecasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agency_forecast_versions" (
    "id" TEXT NOT NULL,
    "forecastId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "changedKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "snapshot" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agency_forecast_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recompete_signals" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "sourceContractId" TEXT,
    "sourceOpportunityId" TEXT,
    "sourceAwardRef" TEXT,
    "incumbentName" TEXT,
    "incumbentUei" TEXT,
    "agency" TEXT,
    "contractNumber" TEXT,
    "naicsCode" TEXT,
    "psc" TEXT,
    "popStartDate" TIMESTAMP(3),
    "popEndDate" TIMESTAMP(3),
    "finalPossibleEndDate" TIMESTAMP(3),
    "optionPeriodCount" INTEGER NOT NULL DEFAULT 0,
    "optionPeriodsRemaining" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "leadDays" INTEGER NOT NULL DEFAULT 365,
    "evidence" JSONB NOT NULL,
    "confidence" "EvidenceConfidence" NOT NULL DEFAULT 'AMBIGUOUS',
    "confidenceReason" TEXT,
    "detectionMethod" TEXT NOT NULL DEFAULT 'deterministic-pop-v1',
    "methodVersion" TEXT NOT NULL DEFAULT 'v1',
    "lastCalculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "relatedForecastId" TEXT,
    "relatedOpportunityId" TEXT,
    "verification" "RecompeteVerification" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "correctionReason" TEXT,
    "dismissedReason" TEXT,
    "originalWindowStart" TIMESTAMP(3),
    "originalWindowEnd" TIMESTAMP(3),
    "originalConfidence" "EvidenceConfidence",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recompete_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firm_capabilities" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'TECHNICAL',
    "description" TEXT,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "naicsCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pscCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capacityNote" TEXT,
    "concurrentCapacity" INTEGER,
    "geographies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contractVehicles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "verification" "CapabilityVerification" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "evidenceNote" TEXT,
    "relatedPastPerformanceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "relatedCertificationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "firm_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_matches" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "overallScore" INTEGER NOT NULL,
    "capabilityScore" INTEGER,
    "naicsScore" INTEGER,
    "pscScore" INTEGER,
    "certificationScore" INTEGER,
    "pastPerformanceScore" INTEGER,
    "geographyScore" INTEGER,
    "vehicleScore" INTEGER,
    "keywordScore" INTEGER,
    "matchedCapabilityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missingCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capacityWarning" TEXT,
    "evidence" JSONB NOT NULL,
    "dataLimitations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hasSufficientData" BOOLEAN NOT NULL DEFAULT true,
    "eligibility" "EligibilityState" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "eligibilityReason" TEXT,
    "eligibilityEvidence" JSONB,
    "expiringCertificationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "matchMethod" TEXT NOT NULL DEFAULT 'capability-match-v1',
    "methodVersion" TEXT NOT NULL DEFAULT 'v1',
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opportunity_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitoring_profile_alerts" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "forecastId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "contentFingerprint" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "channel" TEXT NOT NULL DEFAULT 'IN_APP',
    "reason" TEXT,
    "alertCount" INTEGER NOT NULL DEFAULT 1,
    "firstSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monitoring_profile_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_calibrations" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'platt',
    "methodVersion" TEXT NOT NULL DEFAULT 'v1',
    "params" JSONB NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "minSampleSize" INTEGER NOT NULL DEFAULT 30,
    "trainingStart" TIMESTAMP(3) NOT NULL,
    "trainingEnd" TIMESTAMP(3) NOT NULL,
    "holdoutSize" INTEGER NOT NULL DEFAULT 0,
    "brierScore" DOUBLE PRECISION,
    "baselineBrierScore" DOUBLE PRECISION,
    "logLoss" DOUBLE PRECISION,
    "baselineLogLoss" DOUBLE PRECISION,
    "reliabilityBins" JSONB,
    "improvement" DOUBLE PRECISION,
    "state" "CalibrationState" NOT NULL DEFAULT 'DRAFT',
    "activationReason" TEXT,
    "rejectionReason" TEXT,
    "activatedAt" TIMESTAMP(3),
    "activatedByUserId" TEXT,
    "deactivatedAt" TIMESTAMP(3),
    "rolledBackFromId" TEXT,
    "stalenessDays" INTEGER NOT NULL DEFAULT 180,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_calibrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calibration_samples" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "calibrationId" TEXT,
    "opportunityId" TEXT,
    "bidPursuitId" TEXT,
    "submissionRecordId" TEXT,
    "predictedProbability" DOUBLE PRECISION NOT NULL,
    "observedOutcome" INTEGER NOT NULL,
    "outcomeSource" TEXT NOT NULL,
    "verification" "OutcomeVerification" NOT NULL DEFAULT 'SYSTEM_DERIVED',
    "isHoldout" BOOLEAN NOT NULL DEFAULT false,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calibration_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incumbent_retention_stats" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "incumbentName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "incumbentUei" TEXT,
    "agency" TEXT,
    "naicsCode" TEXT,
    "psc" TEXT,
    "contractType" TEXT,
    "similarAwardCount" INTEGER NOT NULL DEFAULT 0,
    "retainedCount" INTEGER NOT NULL DEFAULT 0,
    "lostRecompeteCount" INTEGER NOT NULL DEFAULT 0,
    "retentionRate" DOUBLE PRECISION,
    "agencyRetentionRate" DOUBLE PRECISION,
    "basis" "RateBasis" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "evidence" JSONB NOT NULL,
    "evidenceSource" TEXT,
    "confidence" "EvidenceConfidence" NOT NULL DEFAULT 'NOT_AVAILABLE',
    "explanation" TEXT,
    "methodVersion" TEXT NOT NULL DEFAULT 'v1',
    "lastRefreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incumbent_retention_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitor_award_stats" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "competitorName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "uei" TEXT,
    "agency" TEXT,
    "naicsCode" TEXT,
    "psc" TEXT,
    "contractType" TEXT,
    "valueBandLow" DECIMAL(14,2),
    "valueBandHigh" DECIMAL(14,2),
    "observedAwards" INTEGER NOT NULL DEFAULT 0,
    "comparableAwardPool" INTEGER NOT NULL DEFAULT 0,
    "confirmedWins" INTEGER NOT NULL DEFAULT 0,
    "confirmedLosses" INTEGER NOT NULL DEFAULT 0,
    "confirmedBids" INTEGER NOT NULL DEFAULT 0,
    "confirmedWinRate" DOUBLE PRECISION,
    "observedAwardShare" DOUBLE PRECISION,
    "basis" "RateBasis" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "basisLabel" TEXT NOT NULL,
    "isIncumbent" BOOLEAN NOT NULL DEFAULT false,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "evidence" JSONB NOT NULL,
    "evidenceSource" TEXT,
    "confidence" "EvidenceConfidence" NOT NULL DEFAULT 'NOT_AVAILABLE',
    "explanation" TEXT,
    "methodVersion" TEXT NOT NULL DEFAULT 'v1',
    "lastRefreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitor_award_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_sensitivity_analyses" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "pricingWorkspaceId" TEXT,
    "benchmarkValue" DECIMAL(14,2),
    "benchmarkSource" TEXT,
    "basePrice" DECIMAL(14,2),
    "baseProbability" DOUBLE PRECISION,
    "points" JSONB NOT NULL,
    "assumptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "validity" "SensitivityValidity" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "isMonotonic" BOOLEAN NOT NULL DEFAULT true,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "method" TEXT NOT NULL DEFAULT 'price-position-logit-v1',
    "methodVersion" TEXT NOT NULL DEFAULT 'v1',
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_sensitivity_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability_gap_assessments" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "confirmedCoverage" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "partialCoverage" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missingCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missingCertifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missingEligibility" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capacityGaps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "geographyGaps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "vehicleGaps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "partnerRecommendations" JSONB NOT NULL DEFAULT '[]',
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "limitations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "methodVersion" TEXT NOT NULL DEFAULT 'v1',
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capability_gap_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "solicitation_extraction_jobs" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "documentId" TEXT,
    "complianceMatrixId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" "ExtractionJobStatus" NOT NULL DEFAULT 'QUEUED',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "progressStage" TEXT,
    "parseMethod" TEXT NOT NULL DEFAULT 'DETERMINISTIC',
    "extractorVersion" TEXT NOT NULL DEFAULT 'v1',
    "promptVersion" TEXT,
    "sourceHash" TEXT,
    "isAmendmentReprocess" BOOLEAN NOT NULL DEFAULT false,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "timeoutMs" INTEGER NOT NULL DEFAULT 120000,
    "requirementsCreated" INTEGER NOT NULL DEFAULT 0,
    "requirementsSkipped" INTEGER NOT NULL DEFAULT 0,
    "mappingsCreated" INTEGER NOT NULL DEFAULT 0,
    "clausesCreated" INTEGER NOT NULL DEFAULT 0,
    "milestonesCreated" INTEGER NOT NULL DEFAULT 0,
    "standingDocsCreated" INTEGER NOT NULL DEFAULT 0,
    "unresolvedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "parseWarnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rawResult" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "solicitation_extraction_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_lm_mappings" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "complianceMatrixId" TEXT,
    "instructionSourceSection" TEXT NOT NULL,
    "instructionEvidence" TEXT,
    "instructionRequirementId" TEXT,
    "evaluationSourceSection" TEXT,
    "evaluationEvidence" TEXT,
    "evaluationRequirementId" TEXT,
    "relationshipExplanation" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "origin" TEXT NOT NULL DEFAULT 'AI',
    "verification" "MappingVerification" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
    "reviewReason" TEXT,
    "proposalSectionId" TEXT,
    "extractionJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "section_lm_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clause_obligations" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "clauseNumber" TEXT NOT NULL,
    "clauseTitle" TEXT,
    "clauseSet" TEXT NOT NULL DEFAULT 'FAR',
    "sourceDocumentId" TEXT,
    "sourceSection" TEXT,
    "sourcePageNumber" INTEGER,
    "evidenceText" TEXT,
    "applicability" "ClauseApplicability" NOT NULL DEFAULT 'UNDETERMINED',
    "flowDownStatus" "FlowDownStatus" NOT NULL DEFAULT 'REVIEW_REQUIRED',
    "flowDownCondition" TEXT,
    "affectedPartnerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ownerUserId" TEXT,
    "dueDate" TIMESTAMP(3),
    "complianceStatus" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "legalReviewRequired" BOOLEAN NOT NULL DEFAULT true,
    "legalReviewedByUserId" TEXT,
    "legalReviewedAt" TIMESTAMP(3),
    "isManuallyVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "amendmentImpact" TEXT,
    "amendmentRevisionId" TEXT,
    "extractionJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clause_obligations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clause_obligation_events" (
    "id" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "actorUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clause_obligation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "standing_documents" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "category" "StandingDocumentCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sensitivity" TEXT NOT NULL DEFAULT 'INTERNAL',
    "currentVersionNo" INTEGER NOT NULL DEFAULT 1,
    "effectiveDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "verification" "DocumentVerificationState" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "approvedForReuse" BOOLEAN NOT NULL DEFAULT false,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "ownerUserId" TEXT,
    "sourceSystem" TEXT,
    "sourceRecordId" TEXT,
    "relatedCertificationId" TEXT,
    "relatedInsurancePolicyId" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "standing_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "standing_document_versions" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "fileKey" TEXT,
    "fileName" TEXT,
    "fileType" TEXT,
    "fileSize" INTEGER,
    "fileHash" TEXT,
    "pageCount" INTEGER,
    "changeNote" TEXT,
    "uploadedByUserId" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "standing_document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "standing_document_links" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "note" TEXT,
    "linkedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "standing_document_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_validation_checks" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "checklistItemId" TEXT,
    "checkKey" TEXT NOT NULL,
    "checkLabel" TEXT NOT NULL,
    "outcome" "ValidationOutcome" NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'AUTOMATED',
    "expected" TEXT,
    "actual" TEXT,
    "evidence" TEXT,
    "message" TEXT,
    "isMandatory" BOOLEAN NOT NULL DEFAULT true,
    "isBlocking" BOOLEAN NOT NULL DEFAULT false,
    "validatorVersion" TEXT NOT NULL DEFAULT 'v1',
    "runId" TEXT NOT NULL,
    "performedByUserId" TEXT,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_validation_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matrix_requirement_events" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "actorUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matrix_requirement_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_milestones" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "proposalId" TEXT,
    "submissionId" TEXT,
    "scheduleRunId" TEXT,
    "milestoneType" "MilestoneType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "isAllDay" BOOLEAN NOT NULL DEFAULT false,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "origin" "MilestoneOrigin" NOT NULL DEFAULT 'MANUAL',
    "sourceEvidence" TEXT,
    "sourceSection" TEXT,
    "sourcePage" INTEGER,
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "isInternal" BOOLEAN NOT NULL DEFAULT true,
    "status" "MilestoneStatus" NOT NULL DEFAULT 'PLANNED',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "ownerUserId" TEXT,
    "backupOwnerUserId" TEXT,
    "participantUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dependsOnMilestoneId" TEXT,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "lockReason" TEXT,
    "reminderLeadDays" INTEGER[] DEFAULT ARRAY[14, 7, 3, 1]::INTEGER[],
    "remindersEnabled" BOOLEAN NOT NULL DEFAULT true,
    "escalateAfterDueHours" INTEGER NOT NULL DEFAULT 24,
    "calendarSyncState" TEXT NOT NULL DEFAULT 'NOT_SYNCED',
    "calendarExternalId" TEXT,
    "amendmentImpact" TEXT,
    "amendmentRevisionId" TEXT,
    "acknowledgedByUserId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunity_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestone_events" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "actorUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "milestone_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestone_reminder_logs" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "level" "ReminderLevel" NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'IN_APP',
    "dedupeKey" TEXT NOT NULL,
    "isEscalation" BOOLEAN NOT NULL DEFAULT false,
    "escalatedToUserId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByUserId" TEXT,
    "snoozedUntil" TIMESTAMP(3),
    "suppressedReason" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "milestone_reminder_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amendment_revisions" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "amendmentId" TEXT,
    "revisionNo" INTEGER NOT NULL,
    "amendmentNumber" TEXT,
    "sourceUrl" TEXT,
    "documentName" TEXT,
    "contentHash" TEXT NOT NULL,
    "contentLength" INTEGER NOT NULL DEFAULT 0,
    "externalId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceUpdatedAt" TIMESTAMP(3),
    "dataQuality" "SourceDataQuality" NOT NULL DEFAULT 'UNVERIFIED',
    "diffSummary" JSONB,
    "changedDeadlines" JSONB,
    "changedRequirements" JSONB,
    "changedEvaluation" JSONB,
    "changedClauses" JSONB,
    "changedAttachments" JSONB,
    "questionsAndAnswers" JSONB,
    "aiSummary" TEXT,
    "aiSummaryJson" JSONB,
    "aiPromptVersion" TEXT,
    "humanReviewRequired" BOOLEAN NOT NULL DEFAULT true,
    "acknowledgedByUserId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "amendment_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amendment_impacts" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "area" "AmendmentImpactArea" NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "targetLabel" TEXT,
    "impact" TEXT NOT NULL,
    "recommendedAction" TEXT,
    "reviewRequired" BOOLEAN NOT NULL DEFAULT true,
    "reviewReason" TEXT,
    "acknowledgedByUserId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "dismissedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "amendment_impacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_templates" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "phases" JSONB NOT NULL,
    "minBufferDays" INTEGER NOT NULL DEFAULT 1,
    "workingDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "holidayCalendarKey" TEXT NOT NULL DEFAULT 'US_FEDERAL',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_runs" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "templateId" TEXT,
    "versionNo" INTEGER NOT NULL,
    "anchorDeadline" TIMESTAMP(3) NOT NULL,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "isPreview" BOOLEAN NOT NULL DEFAULT false,
    "isApplied" BOOLEAN NOT NULL DEFAULT false,
    "inputs" JSONB NOT NULL,
    "generated" JSONB NOT NULL,
    "isFeasible" BOOLEAN NOT NULL DEFAULT true,
    "infeasibilityReason" TEXT,
    "overdueMilestoneCount" INTEGER NOT NULL DEFAULT 0,
    "lockedPreserved" INTEGER NOT NULL DEFAULT 0,
    "completedPreserved" INTEGER NOT NULL DEFAULT 0,
    "overrideReason" TEXT,
    "overriddenByUserId" TEXT,
    "generatedByUserId" TEXT,
    "methodVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday_calendar_entries" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT,
    "calendarKey" TEXT NOT NULL DEFAULT 'US_FEDERAL',
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holiday_calendar_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_schedules" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "agentKey" "AgentKey" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "scheduleType" "AgentScheduleType" NOT NULL DEFAULT 'CRON',
    "cronExpression" TEXT,
    "intervalMinutes" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastSuccessfulRunAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureMessage" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "timeoutMs" INTEGER NOT NULL DEFAULT 600000,
    "autonomyLevel" "AgentAutonomyLevel" NOT NULL DEFAULT 'PROPOSE',
    "tokenBudget" INTEGER,
    "costBudgetUsd" DECIMAL(10,4),
    "tokensUsedThisPeriod" INTEGER NOT NULL DEFAULT 0,
    "costUsedThisPeriodUsd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "budgetPeriodStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "agentKey" "AgentKey" NOT NULL,
    "scheduleId" TEXT,
    "eventId" TEXT,
    "triggerType" "AgentTriggerType" NOT NULL,
    "triggerEntityType" TEXT,
    "triggerEntityId" TEXT,
    "initiatedByUserId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'QUEUED',
    "autonomyLevel" "AgentAutonomyLevel" NOT NULL DEFAULT 'PROPOSE',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "timeoutMs" INTEGER NOT NULL DEFAULT 600000,
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "progressStage" TEXT,
    "inputSnapshot" JSONB,
    "inputHash" TEXT,
    "outputSummary" TEXT,
    "confidenceState" "AgentConfidenceState",
    "dataSufficiency" "AgentDataSufficiency",
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "limitations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "tokenInput" INTEGER NOT NULL DEFAULT 0,
    "tokenOutput" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "handlerVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_artifacts" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "agentKey" "AgentKey" NOT NULL,
    "artifactType" "AgentArtifactType" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "structuredData" JSONB NOT NULL,
    "evidence" JSONB,
    "sourceEntityType" TEXT,
    "sourceEntityId" TEXT,
    "confidenceState" "AgentConfidenceState" NOT NULL DEFAULT 'MEDIUM',
    "isHumanVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "supersededByArtifactId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_escalations" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "runId" TEXT,
    "agentKey" "AgentKey" NOT NULL,
    "severity" "AgentEscalationSeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "AgentEscalationStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "recommendedAction" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "assignedToUserId" TEXT,
    "dueAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_escalations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_events" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "dedupeKey" TEXT NOT NULL,
    "status" "AgentEventStatus" NOT NULL DEFAULT 'PENDING',
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "processedAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_notification_preferences" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentKey" "AgentKey" NOT NULL,
    "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "minimumSeverity" "AgentEscalationSeverity" NOT NULL DEFAULT 'MEDIUM',
    "notifyOnSuccess" BOOLEAN NOT NULL DEFAULT false,
    "notifyOnFailure" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnEscalation" BOOLEAN NOT NULL DEFAULT true,
    "digestMode" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pursuit_feedback_signals" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "algorithmVersion" TEXT NOT NULL DEFAULT 'pursuit-feedback-v1',
    "inputHash" TEXT NOT NULL,
    "status" "PursuitFeedbackStatus" NOT NULL DEFAULT 'PROPOSED',
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "pursuedSampleSize" INTEGER NOT NULL DEFAULT 0,
    "ignoredSampleSize" INTEGER NOT NULL DEFAULT 0,
    "minimumSampleSize" INTEGER NOT NULL,
    "confidenceState" "AgentConfidenceState" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "dataSufficiency" "AgentDataSufficiency" NOT NULL DEFAULT 'INSUFFICIENT',
    "baselineWeights" JSONB NOT NULL,
    "proposedWeights" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "summary" TEXT,
    "generatedByRunId" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedByUserId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "revertedByUserId" TEXT,
    "revertedAt" TIMESTAMP(3),
    "supersededBySignalId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pursuit_feedback_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bonding_capacities" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "suretyName" TEXT,
    "singleProjectLimit" DECIMAL(14,2),
    "aggregateLimit" DECIMAL(14,2),
    "committedAmount" DECIMAL(14,2),
    "effectiveDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "status" "BondingCapacityStatus" NOT NULL DEFAULT 'ACTIVE',
    "evidenceReference" TEXT,
    "notes" TEXT,
    "recordedByUserId" TEXT,
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bonding_capacities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qualification_recommendations" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "pursuitId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "agentRunId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "inputHash" TEXT NOT NULL,
    "algorithmVersion" TEXT NOT NULL DEFAULT 'qualification-v1',
    "recommendation" "QualificationRecommendationResult" NOT NULL,
    "strength" "QualificationRecommendationStrength" NOT NULL DEFAULT 'NONE',
    "rawProbability" INTEGER,
    "finalProbability" INTEGER,
    "probabilityMode" TEXT,
    "calibrationnote" TEXT,
    "confidenceLower" INTEGER,
    "confidenceUpper" INTEGER,
    "confidenceState" "AgentConfidenceState" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "dataSufficiency" "AgentDataSufficiency" NOT NULL DEFAULT 'INSUFFICIENT',
    "scorecardScore" INTEGER,
    "isBorderline" BOOLEAN NOT NULL DEFAULT false,
    "borderlineReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capabilityGapSeverity" TEXT,
    "capacityState" TEXT,
    "incumbentEvidence" JSONB,
    "competitorEvidence" JSONB,
    "pricingEvidence" JSONB,
    "complianceEvidence" JSONB,
    "narrative" TEXT NOT NULL,
    "evidence" JSONB,
    "dataLimitations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "proposedPriority" TEXT,
    "status" "QualificationRecommendationStatus" NOT NULL DEFAULT 'ACTIVE',
    "supersedesId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "rejectedByUserId" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "humanDecision" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qualification_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_performance_records" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "contractId" TEXT,
    "opportunityId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "engagementCount" INTEGER NOT NULL DEFAULT 0,
    "deliverablesDue" INTEGER NOT NULL DEFAULT 0,
    "deliverablesOnTime" INTEGER NOT NULL DEFAULT 0,
    "deliverablesLate" INTEGER NOT NULL DEFAULT 0,
    "deliverablesAccepted" INTEGER NOT NULL DEFAULT 0,
    "deliverablesRejected" INTEGER NOT NULL DEFAULT 0,
    "issuesRaised" INTEGER NOT NULL DEFAULT 0,
    "issueSeverityCounts" JSONB NOT NULL DEFAULT '{}',
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "dataSufficiency" "TeamingDataSufficiency" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "computedMetrics" JSONB NOT NULL DEFAULT '{}',
    "evidenceRecordIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "derivedLabel" TEXT,
    "declineEvidence" JSONB,
    "isHumanVerified" BOOLEAN NOT NULL DEFAULT false,
    "humanNotes" TEXT,
    "methodVersion" TEXT NOT NULL DEFAULT 'teaming-performance-v1',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_performance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcontracting_goals" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "pursuitId" TEXT,
    "contractId" TEXT,
    "opportunityId" TEXT,
    "goalType" "SubcontractingGoalType" NOT NULL,
    "category" TEXT,
    "targetType" "SubcontractingGoalTargetType" NOT NULL,
    "targetPercent" DECIMAL(5,2),
    "targetAmount" DECIMAL(14,2),
    "source" "SubcontractingGoalSource" NOT NULL,
    "sourceReference" TEXT,
    "measurementStartDate" TIMESTAMP(3),
    "measurementEndDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "status" "SubcontractingGoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "isHumanVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subcontracting_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcontracting_goal_progress" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "eligibleBaseAmount" DECIMAL(14,2),
    "achievedAmount" DECIMAL(14,2),
    "achievedPercent" DECIMAL(5,2),
    "remainingAmount" DECIMAL(14,2),
    "remainingPercent" DECIMAL(5,2),
    "riskState" "SubcontractingGoalRiskState" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "dataSufficiency" "TeamingDataSufficiency" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "workingDaysRemaining" INTEGER,
    "evidenceRecordIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "limitations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "methodVersion" TEXT NOT NULL DEFAULT 'teaming-goal-v1',
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subcontracting_goal_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "award_benchmark_cohorts" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "pricingWorkspaceId" TEXT,
    "pricingScenarioId" TEXT,
    "inputHash" TEXT NOT NULL,
    "algorithmVersion" TEXT NOT NULL DEFAULT 'award-benchmark-v1',
    "cohortVersion" INTEGER NOT NULL DEFAULT 1,
    "filterLevel" "BenchmarkFilterLevel" NOT NULL,
    "relaxedFilters" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "naics" TEXT,
    "agency" TEXT,
    "setAside" TEXT,
    "valueBandLow" DECIMAL(16,2),
    "valueBandHigh" DECIMAL(16,2),
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "cohortSize" INTEGER NOT NULL DEFAULT 0,
    "sourceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedSourceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exclusionReasons" JSONB NOT NULL DEFAULT '[]',
    "minimumValue" DECIMAL(16,2),
    "p25Value" DECIMAL(16,2),
    "medianValue" DECIMAL(16,2),
    "p75Value" DECIMAL(16,2),
    "maximumValue" DECIMAL(16,2),
    "meanValue" DECIMAL(16,2),
    "distributionData" JSONB NOT NULL DEFAULT '[]',
    "dataSufficiency" "BenchmarkDataSufficiency" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "limitations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "staleAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "award_benchmark_cohorts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability_narratives" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "CapabilityNarrativeCategory" NOT NULL DEFAULT 'TECHNICAL_NARRATIVE',
    "capabilityKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "naicsCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agencyTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "CapabilityNarrativeStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentApprovedVersionId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "capability_narratives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability_narrative_versions" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "capabilityNarrativeId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" "CapabilityNarrativeVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "sourceReferences" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "capability_narrative_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "actual_indirect_rates" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "rateType" TEXT NOT NULL,
    "poolName" TEXT,
    "actualRate" DECIMAL(7,4) NOT NULL,
    "allocationBaseAmount" DECIMAL(14,2),
    "poolCostAmount" DECIMAL(14,2),
    "source" "ActualIndirectRateSource" NOT NULL DEFAULT 'MANUAL_ENTRY',
    "sourceReference" TEXT,
    "status" "ActualIndirectRateStatus" NOT NULL DEFAULT 'DRAFT',
    "isHumanVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "actual_indirect_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dcaa_readiness_checks" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "contractId" TEXT,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "ruleKey" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "verdict" "DcaaReadinessVerdict" NOT NULL,
    "severity" "DcaaReadinessSeverity" NOT NULL,
    "dataSufficiency" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceRecordIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recordsChecked" INTEGER NOT NULL DEFAULT 0,
    "recordsFailing" INTEGER NOT NULL DEFAULT 0,
    "limitations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agentRunId" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dcaa_readiness_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_flow_projections" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "horizonMonths" INTEGER NOT NULL,
    "methodVersion" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "projectedReceipts" DECIMAL(14,2) NOT NULL,
    "projectedDisbursements" DECIMAL(14,2) NOT NULL,
    "netCashFlow" DECIMAL(14,2) NOT NULL,
    "confidenceLower" DECIMAL(14,2),
    "confidenceUpper" DECIMAL(14,2),
    "confidenceState" "CashFlowConfidenceState" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "sourceBreakdown" JSONB NOT NULL DEFAULT '{}',
    "dataSufficiency" TEXT NOT NULL,
    "limitations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agentRunId" TEXT,
    "supersedesId" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_flow_projections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "win_loss_segments" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "segmentType" "WinLossSegmentType" NOT NULL,
    "segmentKey" TEXT NOT NULL,
    "segmentLabel" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "pending" INTEGER NOT NULL DEFAULT 0,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "minimumSampleSize" INTEGER NOT NULL,
    "winRate" DECIMAL(6,5),
    "intervalLower" DECIMAL(6,5),
    "intervalUpper" DECIMAL(6,5),
    "dataSufficiency" "IntelligenceDataSufficiency" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "sourceOutcomeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "limitations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "algorithmVersion" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "agentRunId" TEXT,
    "supersedesId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "win_loss_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capture_recommendations" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "segmentType" "WinLossSegmentType" NOT NULL,
    "segmentKey" TEXT NOT NULL,
    "segmentLabel" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "score" DECIMAL(12,4),
    "scoreState" "CaptureScoreState" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "rank" INTEGER,
    "rationale" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "dataSufficiency" "IntelligenceDataSufficiency" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "status" "CaptureRecommendationStatus" NOT NULL DEFAULT 'ACTIVE',
    "inputHash" TEXT NOT NULL,
    "algorithmVersion" TEXT NOT NULL,
    "agentRunId" TEXT,
    "supersedesId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "dismissedByUserId" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "dismissReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capture_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agency_offices" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "agencyName" TEXT NOT NULL,
    "officeName" TEXT NOT NULL,
    "officeSymbol" TEXT,
    "location" TEXT,
    "notes" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_offices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "government_contacts" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "agencyOfficeId" TEXT,
    "agencyName" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "title" TEXT,
    "contactRole" "GovContactRole" NOT NULL DEFAULT 'OTHER',
    "email" TEXT,
    "phone" TEXT,
    "status" "CrmContactStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "ownerUserId" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "government_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_contacts" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "title" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "status" "CrmContactStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "sourceSubcontractContactId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_activities" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "activityType" "CrmActivityType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "subject" TEXT NOT NULL,
    "summary" TEXT,
    "notes" TEXT,
    "durationMinutes" INTEGER,
    "location" TEXT,
    "participants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "followUpNeeded" BOOLEAN NOT NULL DEFAULT false,
    "sourceReference" TEXT,
    "ownerUserId" TEXT,
    "governmentContactId" TEXT,
    "agencyOfficeId" TEXT,
    "agencyName" TEXT,
    "opportunityId" TEXT,
    "bidPursuitId" TEXT,
    "partnerId" TEXT,
    "partnerContactId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_follow_ups" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "CrmFollowUpStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "CrmPriority" NOT NULL DEFAULT 'MEDIUM',
    "ownerUserId" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "governmentContactId" TEXT,
    "partnerContactId" TEXT,
    "partnerId" TEXT,
    "opportunityId" TEXT,
    "bidPursuitId" TEXT,
    "activityId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_budgets" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" "BudgetStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT,
    "notes" TEXT,
    "effectiveDate" TIMESTAMP(3),
    "supersedesBudgetId" TEXT,
    "createdByUserId" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_budget_lines" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "clinId" TEXT,
    "category" "BudgetCategory" NOT NULL,
    "description" TEXT,
    "plannedAmount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_budget_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_allocations" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "personnelId" TEXT,
    "contractId" TEXT NOT NULL,
    "clinId" TEXT,
    "laborCategory" TEXT,
    "allocationPercent" DECIMAL(5,2) NOT NULL,
    "plannedHoursPerWeek" DECIMAL(6,2),
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "status" "AllocationStatus" NOT NULL DEFAULT 'PLANNED',
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resource_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "clinId" TEXT,
    "partnerId" TEXT,
    "vendorName" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "description" TEXT,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "ceilingAmount" DECIMAL(14,2) NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isSubcontract" BOOLEAN NOT NULL DEFAULT false,
    "teamingArrangementId" TEXT,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "clinId" TEXT,
    "description" TEXT NOT NULL,
    "category" "BudgetCategory" NOT NULL DEFAULT 'SUBCONTRACT',
    "quantity" DECIMAL(14,4),
    "unit" TEXT,
    "unitPrice" DECIMAL(14,4),
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcontract_invoices" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "partnerId" TEXT,
    "vendorName" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "servicePeriodStart" TIMESTAMP(3),
    "servicePeriodEnd" TIMESTAMP(3),
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "SubcontractInvoiceStatus" NOT NULL DEFAULT 'RECEIVED',
    "notes" TEXT,
    "rejectionReason" TEXT,
    "attachmentKey" TEXT,
    "postedContractCostId" TEXT,
    "postedAt" TIMESTAMP(3),
    "paymentRecordedAt" TIMESTAMP(3),
    "paymentReference" TEXT,
    "paymentRecordedByUserId" TEXT,
    "submittedByPortalUserId" TEXT,
    "createdByUserId" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subcontract_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcontract_invoice_lines" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "subcontractInvoiceId" TEXT NOT NULL,
    "clinId" TEXT,
    "description" TEXT NOT NULL,
    "category" "BudgetCategory" NOT NULL DEFAULT 'SUBCONTRACT',
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subcontract_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcontract_flow_downs" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "clauseObligationId" TEXT,
    "clauseNumber" TEXT NOT NULL,
    "clauseTitle" TEXT,
    "state" "FlowDownState" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "evidence" TEXT,
    "notes" TEXT,
    "partnerVisible" BOOLEAN NOT NULL DEFAULT false,
    "partnerAcknowledgedAt" TIMESTAMP(3),
    "partnerAcknowledgedByPortalUserId" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subcontract_flow_downs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personnel" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "userId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "jobTitle" TEXT,
    "employmentType" "PersonnelEmploymentType" NOT NULL DEFAULT 'EMPLOYEE',
    "email" TEXT,
    "phone" TEXT,
    "location" TEXT,
    "summary" TEXT,
    "yearsExperience" INTEGER,
    "source" "PersonnelSource" NOT NULL DEFAULT 'INTERNAL',
    "sourcePartnerId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "personnel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personnel_labor_qualifications" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "personnelId" TEXT NOT NULL,
    "laborCategory" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3),
    "expirationDate" TIMESTAMP(3),
    "verification" "QualificationVerification" NOT NULL DEFAULT 'UNVERIFIED',
    "yearsExperience" INTEGER,
    "evidence" TEXT,
    "notes" TEXT,
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "personnel_labor_qualifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personnel_resumes" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "personnelId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" "ResumeStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT,
    "content" JSONB NOT NULL DEFAULT '{}',
    "fileName" TEXT,
    "fileType" TEXT,
    "fileSize" INTEGER,
    "storageKey" TEXT,
    "source" "PersonnelSource" NOT NULL DEFAULT 'INTERNAL',
    "supersedesResumeId" TEXT,
    "sourcePartnerId" TEXT,
    "sourcePartnerSubmissionId" TEXT,
    "sourcePartnerUploadId" TEXT,
    "createdByUserId" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "personnel_resumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_key_personnel" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "personnelId" TEXT NOT NULL,
    "resumeId" TEXT,
    "proposalRole" TEXT,
    "laborCategory" TEXT,
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proposal_key_personnel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_portal_users" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "partnerContactId" TEXT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "inviteTokenHash" TEXT,
    "inviteExpiresAt" TIMESTAMP(3),
    "invitedAt" TIMESTAMP(3),
    "invitedByUserId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,
    "mfaRecoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mfaEnrolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_portal_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_engagement_access" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "partnerPortalUserId" TEXT NOT NULL,
    "scopeType" "PartnerEngagementScope" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "notes" TEXT,
    "grantedByUserId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_engagement_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_portal_uploads" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "partnerPortalUserId" TEXT NOT NULL,
    "scopeType" "PartnerEngagementScope" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL DEFAULT 0,
    "storageKey" TEXT NOT NULL,
    "notes" TEXT,
    "reviewStatus" "PartnerSubmissionStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_portal_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_personnel_submissions" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "partnerPortalUserId" TEXT NOT NULL,
    "scopeType" "PartnerEngagementScope" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "proposedRole" TEXT,
    "laborCategory" TEXT,
    "content" JSONB NOT NULL DEFAULT '{}',
    "fileName" TEXT,
    "storageKey" TEXT,
    "sourceUploadId" TEXT,
    "status" "PartnerSubmissionStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "importedPersonnelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_personnel_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_portal_password_resets" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "partnerPortalUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_portal_password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_deliverable_submissions" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "deliverableId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "partnerPortalUserId" TEXT NOT NULL,
    "status" "PartnerDeliverableSubmissionStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "fileName" TEXT,
    "fileType" TEXT,
    "fileSize" INTEGER,
    "storageKey" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_deliverable_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_profile_change_requests" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "partnerPortalUserId" TEXT NOT NULL,
    "proposed" JSONB NOT NULL DEFAULT '{}',
    "previous" JSONB NOT NULL DEFAULT '{}',
    "status" "PartnerSubmissionStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "submittedNote" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_profile_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_api_request_logs" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "apiTokenId" TEXT NOT NULL,
    "tokenFp" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "scopeUsed" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'ok',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_api_request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "category" "IntegrationCategory" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "externalAccountId" TEXT,
    "externalAccountName" TEXT,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "config" JSONB NOT NULL DEFAULT '{}',
    "connectedAt" TIMESTAMP(3),
    "connectedByUserId" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "disconnectedAt" TIMESTAMP(3),
    "disconnectedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_oauth_states" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "stateHash" TEXT NOT NULL,
    "codeVerifierEnc" TEXT,
    "redirectUri" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_sync_records" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "localType" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalType" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'EXPORT',
    "payloadHash" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_sync_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_events" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "connectionId" TEXT,
    "provider" "IntegrationProvider" NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "processedAt" TIMESTAMP(3),
    "outcome" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_requests" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "documentType" "SignatureDocumentType" NOT NULL,
    "status" "SignatureRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "teamingArrangementId" TEXT,
    "partnerId" TEXT,
    "purchaseOrderId" TEXT,
    "fileName" TEXT,
    "fileType" TEXT,
    "storageKey" TEXT,
    "provider" "IntegrationProvider",
    "externalEnvelopeId" TEXT,
    "providerStatus" TEXT,
    "sentByUserId" TEXT,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "lastError" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_signers" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "signatureRequestId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "routingOrder" INTEGER NOT NULL DEFAULT 1,
    "role" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "viewedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "externalSignerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_signers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firm_sso_configs" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "providerType" "SsoProviderType" NOT NULL DEFAULT 'OIDC',
    "displayName" TEXT NOT NULL DEFAULT 'Single sign-on',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "issuer" TEXT,
    "clientId" TEXT,
    "clientSecretEnc" TEXT,
    "authorizationUrl" TEXT,
    "tokenUrl" TEXT,
    "jwksUri" TEXT,
    "entryPoint" TEXT,
    "signingCertificate" TEXT,
    "allowedEmailDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "breakGlassEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "autoProvision" BOOLEAN NOT NULL DEFAULT false,
    "defaultRole" TEXT NOT NULL DEFAULT 'VIEWER',
    "lastLoginAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "firm_sso_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_identities" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "ssoConfigId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_login_states" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "codeVerifierEnc" TEXT,
    "redirectUri" TEXT NOT NULL,
    "returnTo" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sso_login_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "consulting_firms_contactEmail_key" ON "consulting_firms"("contactEmail");

-- CreateIndex
CREATE UNIQUE INDEX "consulting_firms_stripeCustomerId_key" ON "consulting_firms"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "consulting_firms_stripeSubscriptionId_key" ON "consulting_firms"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "consulting_firms_subdomain_key" ON "consulting_firms"("subdomain");

-- CreateIndex
CREATE UNIQUE INDEX "consulting_firms_customDomain_key" ON "consulting_firms"("customDomain");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_consultingFirmId_idx" ON "users"("consultingFirmId");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_key" ON "password_reset_tokens"("token");

-- CreateIndex
CREATE INDEX "password_reset_tokens_token_idx" ON "password_reset_tokens"("token");

-- CreateIndex
CREATE INDEX "password_reset_tokens_userId_idx" ON "password_reset_tokens"("userId");

-- CreateIndex
CREATE INDEX "bid_decision_history_consultingFirmId_idx" ON "bid_decision_history"("consultingFirmId");

-- CreateIndex
CREATE INDEX "bid_decision_history_opportunityId_idx" ON "bid_decision_history"("opportunityId");

-- CreateIndex
CREATE INDEX "bid_decision_history_clientCompanyId_idx" ON "bid_decision_history"("clientCompanyId");

-- CreateIndex
CREATE UNIQUE INDEX "naics_codes_code_key" ON "naics_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "client_naics_clientCompanyId_naicsCodeId_key" ON "client_naics"("clientCompanyId", "naicsCodeId");

-- CreateIndex
CREATE INDEX "client_companies_consultingFirmId_idx" ON "client_companies"("consultingFirmId");

-- CreateIndex
CREATE INDEX "opportunities_consultingFirmId_presolicitationKind_idx" ON "opportunities"("consultingFirmId", "presolicitationKind");

-- CreateIndex
CREATE INDEX "opportunities_sourceConfigId_idx" ON "opportunities"("sourceConfigId");

-- CreateIndex
CREATE INDEX "opportunities_consultingFirmId_idx" ON "opportunities"("consultingFirmId");

-- CreateIndex
CREATE INDEX "opportunities_consultingFirmId_solicitationNumber_idx" ON "opportunities"("consultingFirmId", "solicitationNumber");

-- CreateIndex
CREATE INDEX "opportunities_consultingFirmId_isDemo_idx" ON "opportunities"("consultingFirmId", "isDemo");

-- CreateIndex
CREATE INDEX "opportunities_consultingFirmId_source_idx" ON "opportunities"("consultingFirmId", "source");

-- CreateIndex
CREATE INDEX "opportunities_consultingFirmId_status_idx" ON "opportunities"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "opportunities_naicsCodeId_idx" ON "opportunities"("naicsCodeId");

-- CreateIndex
CREATE INDEX "opportunities_agency_idx" ON "opportunities"("agency");

-- CreateIndex
CREATE INDEX "opportunities_responseDeadline_idx" ON "opportunities"("responseDeadline");

-- CreateIndex
CREATE INDEX "opportunities_probabilityScore_idx" ON "opportunities"("probabilityScore");

-- CreateIndex
CREATE INDEX "opportunities_descriptionEnrichmentStatus_idx" ON "opportunities"("descriptionEnrichmentStatus");

-- CreateIndex
CREATE UNIQUE INDEX "opportunities_consultingFirmId_samNoticeId_key" ON "opportunities"("consultingFirmId", "samNoticeId");

-- CreateIndex
CREATE INDEX "award_history_opportunityId_idx" ON "award_history"("opportunityId");

-- CreateIndex
CREATE INDEX "award_history_recipientName_idx" ON "award_history"("recipientName");

-- CreateIndex
CREATE INDEX "opportunity_documents_opportunityId_idx" ON "opportunity_documents"("opportunityId");

-- CreateIndex
CREATE INDEX "opportunity_documents_extractionStatus_idx" ON "opportunity_documents"("extractionStatus");

-- CreateIndex
CREATE INDEX "ingestion_jobs_consultingFirmId_idx" ON "ingestion_jobs"("consultingFirmId");

-- CreateIndex
CREATE INDEX "ingestion_jobs_status_idx" ON "ingestion_jobs"("status");

-- CreateIndex
CREATE INDEX "submission_records_consultingFirmId_idx" ON "submission_records"("consultingFirmId");

-- CreateIndex
CREATE INDEX "submission_records_clientCompanyId_idx" ON "submission_records"("clientCompanyId");

-- CreateIndex
CREATE INDEX "submission_records_outcome_idx" ON "submission_records"("outcome");

-- CreateIndex
CREATE INDEX "bid_pursuits_consultingFirmId_status_idx" ON "bid_pursuits"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "bid_pursuits_consultingFirmId_pipelineStage_idx" ON "bid_pursuits"("consultingFirmId", "pipelineStage");

-- CreateIndex
CREATE INDEX "bid_pursuits_ownerUserId_idx" ON "bid_pursuits"("ownerUserId");

-- CreateIndex
CREATE INDEX "bid_pursuits_consultingFirmId_nextActionDueAt_idx" ON "bid_pursuits"("consultingFirmId", "nextActionDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "bid_pursuits_consultingFirmId_opportunityId_key" ON "bid_pursuits"("consultingFirmId", "opportunityId");

-- CreateIndex
CREATE INDEX "financial_penalties_consultingFirmId_idx" ON "financial_penalties"("consultingFirmId");

-- CreateIndex
CREATE INDEX "financial_penalties_clientCompanyId_idx" ON "financial_penalties"("clientCompanyId");

-- CreateIndex
CREATE UNIQUE INDEX "performance_stats_clientCompanyId_key" ON "performance_stats"("clientCompanyId");

-- CreateIndex
CREATE INDEX "bid_decisions_consultingFirmId_idx" ON "bid_decisions"("consultingFirmId");

-- CreateIndex
CREATE UNIQUE INDEX "bid_decisions_opportunityId_clientCompanyId_key" ON "bid_decisions"("opportunityId", "clientCompanyId");

-- CreateIndex
CREATE INDEX "scorecard_criterion_configs_consultingFirmId_isActive_idx" ON "scorecard_criterion_configs"("consultingFirmId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "scorecard_criterion_configs_consultingFirmId_key_key" ON "scorecard_criterion_configs"("consultingFirmId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "scorecards_bidPursuitId_key" ON "scorecards"("bidPursuitId");

-- CreateIndex
CREATE INDEX "scorecards_consultingFirmId_status_idx" ON "scorecards"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "scorecards_opportunityId_idx" ON "scorecards"("opportunityId");

-- CreateIndex
CREATE INDEX "scorecards_reviewerUserId_idx" ON "scorecards"("reviewerUserId");

-- CreateIndex
CREATE INDEX "scorecard_criteria_scorecardId_idx" ON "scorecard_criteria"("scorecardId");

-- CreateIndex
CREATE UNIQUE INDEX "scorecard_criteria_scorecardId_key_key" ON "scorecard_criteria"("scorecardId", "key");

-- CreateIndex
CREATE INDEX "scorecard_decisions_scorecardId_idx" ON "scorecard_decisions"("scorecardId");

-- CreateIndex
CREATE INDEX "scorecard_decisions_consultingFirmId_idx" ON "scorecard_decisions"("consultingFirmId");

-- CreateIndex
CREATE INDEX "scorecard_decisions_opportunityId_idx" ON "scorecard_decisions"("opportunityId");

-- CreateIndex
CREATE INDEX "gate_reviews_consultingFirmId_status_idx" ON "gate_reviews"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "gate_reviews_reviewerUserId_idx" ON "gate_reviews"("reviewerUserId");

-- CreateIndex
CREATE INDEX "gate_reviews_bidPursuitId_idx" ON "gate_reviews"("bidPursuitId");

-- CreateIndex
CREATE UNIQUE INDEX "user_notifications_dedupeKey_key" ON "user_notifications"("dedupeKey");

-- CreateIndex
CREATE INDEX "user_notifications_consultingFirmId_userId_isRead_idx" ON "user_notifications"("consultingFirmId", "userId", "isRead");

-- CreateIndex
CREATE INDEX "user_notifications_userId_idx" ON "user_notifications"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "client_portal_users_email_key" ON "client_portal_users"("email");

-- CreateIndex
CREATE INDEX "client_portal_users_clientCompanyId_idx" ON "client_portal_users"("clientCompanyId");

-- CreateIndex
CREATE INDEX "document_requirements_consultingFirmId_idx" ON "document_requirements"("consultingFirmId");

-- CreateIndex
CREATE INDEX "document_requirements_clientCompanyId_idx" ON "document_requirements"("clientCompanyId");

-- CreateIndex
CREATE INDEX "document_requirements_opportunityId_idx" ON "document_requirements"("opportunityId");

-- CreateIndex
CREATE INDEX "document_requirements_templateId_idx" ON "document_requirements"("templateId");

-- CreateIndex
CREATE INDEX "document_templates_consultingFirmId_idx" ON "document_templates"("consultingFirmId");

-- CreateIndex
CREATE INDEX "document_templates_createdById_idx" ON "document_templates"("createdById");

-- CreateIndex
CREATE INDEX "compliance_rewards_clientCompanyId_idx" ON "compliance_rewards"("clientCompanyId");

-- CreateIndex
CREATE INDEX "compliance_logs_entityId_idx" ON "compliance_logs"("entityId");

-- CreateIndex
CREATE INDEX "compliance_logs_consultingFirmId_idx" ON "compliance_logs"("consultingFirmId");

-- CreateIndex
CREATE INDEX "client_documents_consultingFirmId_idx" ON "client_documents"("consultingFirmId");

-- CreateIndex
CREATE INDEX "client_documents_clientCompanyId_idx" ON "client_documents"("clientCompanyId");

-- CreateIndex
CREATE UNIQUE INDEX "shared_templates_sourceDocumentId_key" ON "shared_templates"("sourceDocumentId");

-- CreateIndex
CREATE INDEX "shared_templates_status_idx" ON "shared_templates"("status");

-- CreateIndex
CREATE INDEX "shared_templates_documentType_idx" ON "shared_templates"("documentType");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_matrices_opportunityId_key" ON "compliance_matrices"("opportunityId");

-- CreateIndex
CREATE INDEX "compliance_matrices_consultingFirmId_idx" ON "compliance_matrices"("consultingFirmId");

-- CreateIndex
CREATE INDEX "matrix_requirements_matrixId_idx" ON "matrix_requirements"("matrixId");

-- CreateIndex
CREATE INDEX "matrix_requirements_sourceDocumentId_idx" ON "matrix_requirements"("sourceDocumentId");

-- CreateIndex
CREATE INDEX "matrix_requirements_consultingFirmId_status_idx" ON "matrix_requirements"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "matrix_requirements_ownerUserId_idx" ON "matrix_requirements"("ownerUserId");

-- CreateIndex
CREATE INDEX "matrix_requirements_dueDate_idx" ON "matrix_requirements"("dueDate");

-- CreateIndex
CREATE INDEX "client_opportunity_declines_clientCompanyId_idx" ON "client_opportunity_declines"("clientCompanyId");

-- CreateIndex
CREATE UNIQUE INDEX "client_opportunity_declines_clientCompanyId_opportunityId_key" ON "client_opportunity_declines"("clientCompanyId", "opportunityId");

-- CreateIndex
CREATE INDEX "client_portal_uploads_clientCompanyId_idx" ON "client_portal_uploads"("clientCompanyId");

-- CreateIndex
CREATE INDEX "client_portal_uploads_consultingFirmId_idx" ON "client_portal_uploads"("consultingFirmId");

-- CreateIndex
CREATE INDEX "api_usage_logs_consultingFirmId_idx" ON "api_usage_logs"("consultingFirmId");

-- CreateIndex
CREATE INDEX "api_usage_logs_createdAt_idx" ON "api_usage_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_slug_key" ON "subscription_plans"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_consultingFirmId_key" ON "subscriptions"("consultingFirmId");

-- CreateIndex
CREATE INDEX "subscriptions_consultingFirmId_idx" ON "subscriptions"("consultingFirmId");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoiceNumber_key" ON "invoices"("invoiceNumber");

-- CreateIndex
CREATE INDEX "invoices_consultingFirmId_idx" ON "invoices"("consultingFirmId");

-- CreateIndex
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

-- CreateIndex
CREATE UNIQUE INDEX "addon_subscriptions_stripeSubscriptionId_key" ON "addon_subscriptions"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "addon_subscriptions_consultingFirmId_idx" ON "addon_subscriptions"("consultingFirmId");

-- CreateIndex
CREATE UNIQUE INDEX "addon_subscriptions_consultingFirmId_addonSlug_key" ON "addon_subscriptions"("consultingFirmId", "addonSlug");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_webhook_events_eventId_key" ON "stripe_webhook_events"("eventId");

-- CreateIndex
CREATE INDEX "stripe_webhook_events_createdAt_idx" ON "stripe_webhook_events"("createdAt");

-- CreateIndex
CREATE INDEX "state_municipal_opportunities_consultingFirmId_idx" ON "state_municipal_opportunities"("consultingFirmId");

-- CreateIndex
CREATE INDEX "state_municipal_opportunities_state_idx" ON "state_municipal_opportunities"("state");

-- CreateIndex
CREATE INDEX "state_municipal_opportunities_contractLevel_idx" ON "state_municipal_opportunities"("contractLevel");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_opportunities_externalId_key" ON "subcontract_opportunities"("externalId");

-- CreateIndex
CREATE INDEX "subcontract_opportunities_consultingFirmId_idx" ON "subcontract_opportunities"("consultingFirmId");

-- CreateIndex
CREATE INDEX "subcontract_opportunities_naicsCode_idx" ON "subcontract_opportunities"("naicsCode");

-- CreateIndex
CREATE INDEX "subcontract_opportunities_status_idx" ON "subcontract_opportunities"("status");

-- CreateIndex
CREATE INDEX "subcontract_contacts_consultingFirmId_lastSeenAt_idx" ON "subcontract_contacts"("consultingFirmId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "subcontract_contacts_consultingFirmId_source_idx" ON "subcontract_contacts"("consultingFirmId", "source");

-- CreateIndex
CREATE INDEX "subcontract_contacts_primeContractor_idx" ON "subcontract_contacts"("primeContractor");

-- CreateIndex
CREATE INDEX "subcontract_contacts_agency_idx" ON "subcontract_contacts"("agency");

-- CreateIndex
CREATE INDEX "subcontract_contacts_naicsCode_idx" ON "subcontract_contacts"("naicsCode");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_contacts_consultingFirmId_dedupeKey_key" ON "subcontract_contacts"("consultingFirmId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "naics_competitive_density_naicsCode_key" ON "naics_competitive_density"("naicsCode");

-- CreateIndex
CREATE UNIQUE INDEX "agency_award_profiles_agencyName_key" ON "agency_award_profiles"("agencyName");

-- CreateIndex
CREATE INDEX "deliverable_comments_deliverableId_idx" ON "deliverable_comments"("deliverableId");

-- CreateIndex
CREATE INDEX "deliverable_comments_parentId_idx" ON "deliverable_comments"("parentId");

-- CreateIndex
CREATE INDEX "market_watchlist_entries_consultingFirmId_idx" ON "market_watchlist_entries"("consultingFirmId");

-- CreateIndex
CREATE UNIQUE INDEX "market_watchlist_entries_consultingFirmId_naicsCode_agency_key" ON "market_watchlist_entries"("consultingFirmId", "naicsCode", "agency");

-- CreateIndex
CREATE INDEX "saved_monitoring_profiles_consultingFirmId_isArchived_idx" ON "saved_monitoring_profiles"("consultingFirmId", "isArchived");

-- CreateIndex
CREATE INDEX "saved_monitoring_profiles_consultingFirmId_isActive_idx" ON "saved_monitoring_profiles"("consultingFirmId", "isActive");

-- CreateIndex
CREATE INDEX "saved_monitoring_profiles_consultingFirmId_ownerUserId_idx" ON "saved_monitoring_profiles"("consultingFirmId", "ownerUserId");

-- CreateIndex
CREATE INDEX "saved_monitoring_profiles_nextEvaluationAt_idx" ON "saved_monitoring_profiles"("nextEvaluationAt");

-- CreateIndex
CREATE INDEX "backtest_predictions_runId_idx" ON "backtest_predictions"("runId");

-- CreateIndex
CREATE INDEX "beta_access_requests_email_idx" ON "beta_access_requests"("email");

-- CreateIndex
CREATE INDEX "beta_access_requests_status_idx" ON "beta_access_requests"("status");

-- CreateIndex
CREATE INDEX "beta_feedback_consultingFirmId_createdAt_idx" ON "beta_feedback"("consultingFirmId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "far_clauses_code_key" ON "far_clauses"("code");

-- CreateIndex
CREATE INDEX "far_clauses_partNumber_idx" ON "far_clauses"("partNumber");

-- CreateIndex
CREATE INDEX "far_clauses_code_idx" ON "far_clauses"("code");

-- CreateIndex
CREATE UNIQUE INDEX "dfars_clauses_code_key" ON "dfars_clauses"("code");

-- CreateIndex
CREATE INDEX "dfars_clauses_partNumber_idx" ON "dfars_clauses"("partNumber");

-- CreateIndex
CREATE INDEX "dfars_clauses_code_idx" ON "dfars_clauses"("code");

-- CreateIndex
CREATE UNIQUE INDEX "nist_800_171_controls_controlId_key" ON "nist_800_171_controls"("controlId");

-- CreateIndex
CREATE UNIQUE INDEX "cmmc_practices_practiceId_key" ON "cmmc_practices"("practiceId");

-- CreateIndex
CREATE UNIQUE INDEX "section_508_criteria_criterionId_key" ON "section_508_criteria"("criterionId");

-- CreateIndex
CREATE INDEX "far_clause_applicabilities_consultingFirmId_idx" ON "far_clause_applicabilities"("consultingFirmId");

-- CreateIndex
CREATE INDEX "far_clause_applicabilities_opportunityId_idx" ON "far_clause_applicabilities"("opportunityId");

-- CreateIndex
CREATE INDEX "far_clause_applicabilities_clauseSource_clauseCode_idx" ON "far_clause_applicabilities"("clauseSource", "clauseCode");

-- CreateIndex
CREATE INDEX "audit_events_consultingFirmId_idx" ON "audit_events"("consultingFirmId");

-- CreateIndex
CREATE INDEX "audit_events_entityType_entityId_idx" ON "audit_events"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_events_actorUserId_idx" ON "audit_events"("actorUserId");

-- CreateIndex
CREATE INDEX "audit_events_createdAt_idx" ON "audit_events"("createdAt");

-- CreateIndex
CREATE INDEX "proposals_consultingFirmId_opportunityId_idx" ON "proposals"("consultingFirmId", "opportunityId");

-- CreateIndex
CREATE INDEX "proposals_consultingFirmId_status_idx" ON "proposals"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "proposal_sections_consultingFirmId_idx" ON "proposal_sections"("consultingFirmId");

-- CreateIndex
CREATE INDEX "proposal_sections_opportunityId_idx" ON "proposal_sections"("opportunityId");

-- CreateIndex
CREATE INDEX "proposal_sections_proposalId_idx" ON "proposal_sections"("proposalId");

-- CreateIndex
CREATE INDEX "proposal_sections_consultingFirmId_status_idx" ON "proposal_sections"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "proposal_section_versions_proposalSectionId_idx" ON "proposal_section_versions"("proposalSectionId");

-- CreateIndex
CREATE INDEX "proposal_section_versions_consultingFirmId_idx" ON "proposal_section_versions"("consultingFirmId");

-- CreateIndex
CREATE UNIQUE INDEX "proposal_section_versions_proposalSectionId_version_key" ON "proposal_section_versions"("proposalSectionId", "version");

-- CreateIndex
CREATE INDEX "proposal_section_reviews_proposalSectionId_idx" ON "proposal_section_reviews"("proposalSectionId");

-- CreateIndex
CREATE INDEX "proposal_section_reviews_consultingFirmId_idx" ON "proposal_section_reviews"("consultingFirmId");

-- CreateIndex
CREATE INDEX "evidence_artifacts_consultingFirmId_idx" ON "evidence_artifacts"("consultingFirmId");

-- CreateIndex
CREATE INDEX "evidence_artifacts_opportunityId_idx" ON "evidence_artifacts"("opportunityId");

-- CreateIndex
CREATE INDEX "evidence_artifacts_pastPerformanceRecordId_idx" ON "evidence_artifacts"("pastPerformanceRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "section_evidence_links_proposalSectionId_evidenceArtifactId_key" ON "section_evidence_links"("proposalSectionId", "evidenceArtifactId");

-- CreateIndex
CREATE INDEX "adherence_scores_consultingFirmId_idx" ON "adherence_scores"("consultingFirmId");

-- CreateIndex
CREATE INDEX "adherence_scores_opportunityId_idx" ON "adherence_scores"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "past_performance_records_sourceContractId_key" ON "past_performance_records"("sourceContractId");

-- CreateIndex
CREATE UNIQUE INDEX "past_performance_records_sourceSubmissionRecordId_key" ON "past_performance_records"("sourceSubmissionRecordId");

-- CreateIndex
CREATE INDEX "past_performance_records_consultingFirmId_idx" ON "past_performance_records"("consultingFirmId");

-- CreateIndex
CREATE INDEX "past_performance_records_clientCompanyId_idx" ON "past_performance_records"("clientCompanyId");

-- CreateIndex
CREATE INDEX "past_performance_records_consultingFirmId_customerAgency_idx" ON "past_performance_records"("consultingFirmId", "customerAgency");

-- CreateIndex
CREATE INDEX "past_performance_records_consultingFirmId_naicsCode_idx" ON "past_performance_records"("consultingFirmId", "naicsCode");

-- CreateIndex
CREATE INDEX "past_performance_records_consultingFirmId_isArchived_idx" ON "past_performance_records"("consultingFirmId", "isArchived");

-- CreateIndex
CREATE UNIQUE INDEX "capture_plans_opportunityId_key" ON "capture_plans"("opportunityId");

-- CreateIndex
CREATE INDEX "capture_plans_consultingFirmId_idx" ON "capture_plans"("consultingFirmId");

-- CreateIndex
CREATE INDEX "capture_tasks_capturePlanId_idx" ON "capture_tasks"("capturePlanId");

-- CreateIndex
CREATE INDEX "partners_consultingFirmId_idx" ON "partners"("consultingFirmId");

-- CreateIndex
CREATE INDEX "partners_consultingFirmId_isActive_idx" ON "partners"("consultingFirmId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "partners_consultingFirmId_uei_key" ON "partners"("consultingFirmId", "uei");

-- CreateIndex
CREATE INDEX "teaming_arrangements_consultingFirmId_idx" ON "teaming_arrangements"("consultingFirmId");

-- CreateIndex
CREATE INDEX "teaming_arrangements_opportunityId_idx" ON "teaming_arrangements"("opportunityId");

-- CreateIndex
CREATE INDEX "teaming_arrangements_partnerId_idx" ON "teaming_arrangements"("partnerId");

-- CreateIndex
CREATE INDEX "teaming_arrangements_consultingFirmId_agreementStatus_idx" ON "teaming_arrangements"("consultingFirmId", "agreementStatus");

-- CreateIndex
CREATE UNIQUE INDEX "teaming_arrangements_consultingFirmId_opportunityId_partner_key" ON "teaming_arrangements"("consultingFirmId", "opportunityId", "partnerId", "role");

-- CreateIndex
CREATE INDEX "teaming_agreement_drafts_consultingFirmId_idx" ON "teaming_agreement_drafts"("consultingFirmId");

-- CreateIndex
CREATE INDEX "teaming_agreement_drafts_teamingArrangementId_idx" ON "teaming_agreement_drafts"("teamingArrangementId");

-- CreateIndex
CREATE UNIQUE INDEX "teaming_agreement_drafts_teamingArrangementId_draftType_ver_key" ON "teaming_agreement_drafts"("teamingArrangementId", "draftType", "version");

-- CreateIndex
CREATE UNIQUE INDEX "proposal_attestations_opportunityId_key" ON "proposal_attestations"("opportunityId");

-- CreateIndex
CREATE INDEX "proposal_attestations_consultingFirmId_idx" ON "proposal_attestations"("consultingFirmId");

-- CreateIndex
CREATE INDEX "competitors_consultingFirmId_idx" ON "competitors"("consultingFirmId");

-- CreateIndex
CREATE INDEX "competitors_opportunityId_evidenceKind_idx" ON "competitors"("opportunityId", "evidenceKind");

-- CreateIndex
CREATE UNIQUE INDEX "competitors_consultingFirmId_opportunityId_evidenceKind_nor_key" ON "competitors"("consultingFirmId", "opportunityId", "evidenceKind", "normalizedName");

-- CreateIndex
CREATE INDEX "review_cycles_consultingFirmId_idx" ON "review_cycles"("consultingFirmId");

-- CreateIndex
CREATE INDEX "review_cycles_opportunityId_idx" ON "review_cycles"("opportunityId");

-- CreateIndex
CREATE INDEX "review_comments_reviewCycleId_idx" ON "review_comments"("reviewCycleId");

-- CreateIndex
CREATE INDEX "cmmc_statuses_consultingFirmId_idx" ON "cmmc_statuses"("consultingFirmId");

-- CreateIndex
CREATE INDEX "cmmc_statuses_clientCompanyId_idx" ON "cmmc_statuses"("clientCompanyId");

-- CreateIndex
CREATE INDEX "cost_volumes_consultingFirmId_idx" ON "cost_volumes"("consultingFirmId");

-- CreateIndex
CREATE INDEX "cost_volumes_opportunityId_idx" ON "cost_volumes"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_key" ON "email_verification_tokens"("token");

-- CreateIndex
CREATE INDEX "email_verification_tokens_token_idx" ON "email_verification_tokens"("token");

-- CreateIndex
CREATE INDEX "email_verification_tokens_userId_idx" ON "email_verification_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "tos_versions_version_key" ON "tos_versions"("version");

-- CreateIndex
CREATE INDEX "tos_versions_isCurrent_idx" ON "tos_versions"("isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "beta_nda_versions_version_key" ON "beta_nda_versions"("version");

-- CreateIndex
CREATE INDEX "beta_nda_versions_isCurrent_idx" ON "beta_nda_versions"("isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "beta_weekly_questionnaires_weekStarting_key" ON "beta_weekly_questionnaires"("weekStarting");

-- CreateIndex
CREATE INDEX "beta_weekly_questionnaires_weekStarting_idx" ON "beta_weekly_questionnaires"("weekStarting");

-- CreateIndex
CREATE INDEX "beta_weekly_questionnaires_isActive_idx" ON "beta_weekly_questionnaires"("isActive");

-- CreateIndex
CREATE INDEX "beta_questionnaire_responses_userId_idx" ON "beta_questionnaire_responses"("userId");

-- CreateIndex
CREATE INDEX "beta_questionnaire_responses_consultingFirmId_idx" ON "beta_questionnaire_responses"("consultingFirmId");

-- CreateIndex
CREATE UNIQUE INDEX "beta_questionnaire_responses_questionnaireId_userId_key" ON "beta_questionnaire_responses"("questionnaireId", "userId");

-- CreateIndex
CREATE INDEX "user_agreements_userId_idx" ON "user_agreements"("userId");

-- CreateIndex
CREATE INDEX "user_agreements_documentType_version_idx" ON "user_agreements"("documentType", "version");

-- CreateIndex
CREATE UNIQUE INDEX "user_agreements_userId_documentType_version_key" ON "user_agreements"("userId", "documentType", "version");

-- CreateIndex
CREATE UNIQUE INDEX "winners_award_stage_usaspendingAwardId_key" ON "winners_award_stage"("usaspendingAwardId");

-- CreateIndex
CREATE INDEX "winners_award_stage_agencyToptierCode_fiscalYear_idx" ON "winners_award_stage"("agencyToptierCode", "fiscalYear");

-- CreateIndex
CREATE INDEX "winners_award_stage_naics_fiscalYear_idx" ON "winners_award_stage"("naics", "fiscalYear");

-- CreateIndex
CREATE INDEX "winners_award_stage_agencyToptierCode_pscCode_idx" ON "winners_award_stage"("agencyToptierCode", "pscCode");

-- CreateIndex
CREATE INDEX "winners_award_stage_agencyToptierCode_setAsideType_idx" ON "winners_award_stage"("agencyToptierCode", "setAsideType");

-- CreateIndex
CREATE INDEX "winners_award_stage_recipientUei_idx" ON "winners_award_stage"("recipientUei");

-- CreateIndex
CREATE INDEX "winners_award_stage_refreshBatchId_idx" ON "winners_award_stage"("refreshBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "winners_subaward_stage_usaspendingSubawardId_key" ON "winners_subaward_stage"("usaspendingSubawardId");

-- CreateIndex
CREATE INDEX "winners_subaward_stage_primeAwardId_idx" ON "winners_subaward_stage"("primeAwardId");

-- CreateIndex
CREATE INDEX "winners_subaward_stage_subRecipientUei_idx" ON "winners_subaward_stage"("subRecipientUei");

-- CreateIndex
CREATE INDEX "winners_subaward_stage_subNaics_idx" ON "winners_subaward_stage"("subNaics");

-- CreateIndex
CREATE INDEX "winners_subaward_stage_refreshBatchId_idx" ON "winners_subaward_stage"("refreshBatchId");

-- CreateIndex
CREATE INDEX "teaming_relationships_consultingFirmId_idx" ON "teaming_relationships"("consultingFirmId");

-- CreateIndex
CREATE INDEX "teaming_relationships_clientCompanyId_idx" ON "teaming_relationships"("clientCompanyId");

-- CreateIndex
CREATE INDEX "teaming_relationships_primeUei_idx" ON "teaming_relationships"("primeUei");

-- CreateIndex
CREATE INDEX "teaming_relationships_status_idx" ON "teaming_relationships"("status");

-- CreateIndex
CREATE UNIQUE INDEX "teaming_relationships_consultingFirmId_clientCompanyId_prim_key" ON "teaming_relationships"("consultingFirmId", "clientCompanyId", "primeUei", "agencyCode");

-- CreateIndex
CREATE UNIQUE INDEX "recipient_profiles_uei_key" ON "recipient_profiles"("uei");

-- CreateIndex
CREATE INDEX "recipient_profiles_legalName_idx" ON "recipient_profiles"("legalName");

-- CreateIndex
CREATE INDEX "recipient_profiles_samFetchedAt_idx" ON "recipient_profiles"("samFetchedAt");

-- CreateIndex
CREATE INDEX "recipient_profiles_vaOsdbuVerified_idx" ON "recipient_profiles"("vaOsdbuVerified");

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_tokenHash_key" ON "api_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "api_tokens_consultingFirmId_idx" ON "api_tokens"("consultingFirmId");

-- CreateIndex
CREATE INDEX "api_tokens_tokenHash_idx" ON "api_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "mcp_audit_log_tenant_id_ts_idx" ON "mcp_audit_log"("tenant_id", "ts" DESC);

-- CreateIndex
CREATE INDEX "mcp_audit_log_server_name_tool_name_ts_idx" ON "mcp_audit_log"("server_name", "tool_name", "ts" DESC);

-- CreateIndex
CREATE INDEX "scw_subaward_analyses_primeUei_idx" ON "scw_subaward_analyses"("primeUei");

-- CreateIndex
CREATE INDEX "scw_subaward_analyses_primeName_idx" ON "scw_subaward_analyses"("primeName");

-- CreateIndex
CREATE INDEX "scw_subaward_analyses_expiresAt_idx" ON "scw_subaward_analyses"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "scw_subaward_analyses_primeKey_lookbackYears_key" ON "scw_subaward_analyses"("primeKey", "lookbackYears");

-- CreateIndex
CREATE INDEX "scw_outreach_drafts_opportunityId_idx" ON "scw_outreach_drafts"("opportunityId");

-- CreateIndex
CREATE INDEX "scw_outreach_drafts_consultingFirmId_idx" ON "scw_outreach_drafts"("consultingFirmId");

-- CreateIndex
CREATE INDEX "scw_outreach_drafts_primeUei_idx" ON "scw_outreach_drafts"("primeUei");

-- CreateIndex
CREATE INDEX "scw_outreach_drafts_primeName_idx" ON "scw_outreach_drafts"("primeName");

-- CreateIndex
CREATE INDEX "scw_outreach_drafts_requiresHumanReview_humanApprovedAt_idx" ON "scw_outreach_drafts"("requiresHumanReview", "humanApprovedAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_clientCompanyId_key" ON "notification_preferences"("clientCompanyId");

-- CreateIndex
CREATE INDEX "notification_preferences_consultingFirmId_idx" ON "notification_preferences"("consultingFirmId");

-- CreateIndex
CREATE INDEX "sent_notifications_consultingFirmId_idx" ON "sent_notifications"("consultingFirmId");

-- CreateIndex
CREATE INDEX "sent_notifications_opportunityId_idx" ON "sent_notifications"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "sent_notifications_clientCompanyId_opportunityId_key" ON "sent_notifications"("clientCompanyId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_programs_code_key" ON "onboarding_programs"("code");

-- CreateIndex
CREATE INDEX "onboarding_programs_tier_idx" ON "onboarding_programs"("tier");

-- CreateIndex
CREATE INDEX "onboarding_programs_verificationStatus_idx" ON "onboarding_programs"("verificationStatus");

-- CreateIndex
CREATE INDEX "onboarding_progress_tenantId_idx" ON "onboarding_progress"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_progress_tenantId_programCode_key" ON "onboarding_progress"("tenantId", "programCode");

-- CreateIndex
CREATE UNIQUE INDEX "public_award_training_awardKey_key" ON "public_award_training"("awardKey");

-- CreateIndex
CREATE INDEX "public_award_training_naicsCode_fiscalYear_idx" ON "public_award_training"("naicsCode", "fiscalYear");

-- CreateIndex
CREATE INDEX "public_award_training_recipientUei_idx" ON "public_award_training"("recipientUei");

-- CreateIndex
CREATE INDEX "public_award_training_recipientParentUei_idx" ON "public_award_training"("recipientParentUei");

-- CreateIndex
CREATE INDEX "public_award_training_agencyCode_idx" ON "public_award_training"("agencyCode");

-- CreateIndex
CREATE INDEX "public_award_training_ingestBatchId_idx" ON "public_award_training"("ingestBatchId");

-- CreateIndex
CREATE INDEX "public_win_priors_modelVersion_naicsPrefix_idx" ON "public_win_priors"("modelVersion", "naicsPrefix");

-- CreateIndex
CREATE UNIQUE INDEX "public_win_priors_modelVersion_segmentLevel_naicsPrefix_set_key" ON "public_win_priors"("modelVersion", "segmentLevel", "naicsPrefix", "setAsideBucket");

-- CreateIndex
CREATE UNIQUE INDEX "who_wins_models_version_key" ON "who_wins_models"("version");

-- CreateIndex
CREATE INDEX "who_wins_models_status_idx" ON "who_wins_models"("status");

-- CreateIndex
CREATE UNIQUE INDEX "job_heartbeats_jobName_key" ON "job_heartbeats"("jobName");

-- CreateIndex
CREATE UNIQUE INDEX "registration_profiles_consultingFirmId_key" ON "registration_profiles"("consultingFirmId");

-- CreateIndex
CREATE INDEX "certifications_consultingFirmId_idx" ON "certifications"("consultingFirmId");

-- CreateIndex
CREATE INDEX "certifications_consultingFirmId_expiryDate_idx" ON "certifications"("consultingFirmId", "expiryDate");

-- CreateIndex
CREATE INDEX "insurance_policies_consultingFirmId_idx" ON "insurance_policies"("consultingFirmId");

-- CreateIndex
CREATE INDEX "insurance_policies_consultingFirmId_expiryDate_idx" ON "insurance_policies"("consultingFirmId", "expiryDate");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_opportunityId_key" ON "contracts"("opportunityId");

-- CreateIndex
CREATE INDEX "contracts_consultingFirmId_idx" ON "contracts"("consultingFirmId");

-- CreateIndex
CREATE INDEX "contracts_consultingFirmId_status_idx" ON "contracts"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "contracts_consultingFirmId_endDate_idx" ON "contracts"("consultingFirmId", "endDate");

-- CreateIndex
CREATE INDEX "contracts_clientCompanyId_idx" ON "contracts"("clientCompanyId");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_consultingFirmId_opportunityId_key" ON "contracts"("consultingFirmId", "opportunityId");

-- CreateIndex
CREATE INDEX "contract_option_periods_consultingFirmId_idx" ON "contract_option_periods"("consultingFirmId");

-- CreateIndex
CREATE INDEX "contract_option_periods_contractId_idx" ON "contract_option_periods"("contractId");

-- CreateIndex
CREATE INDEX "contract_option_periods_consultingFirmId_exerciseDeadline_idx" ON "contract_option_periods"("consultingFirmId", "exerciseDeadline");

-- CreateIndex
CREATE INDEX "clins_consultingFirmId_idx" ON "clins"("consultingFirmId");

-- CreateIndex
CREATE INDEX "clins_contractId_idx" ON "clins"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "clins_contractId_clinNumber_key" ON "clins"("contractId", "clinNumber");

-- CreateIndex
CREATE INDEX "contract_modifications_consultingFirmId_idx" ON "contract_modifications"("consultingFirmId");

-- CreateIndex
CREATE INDEX "contract_modifications_contractId_idx" ON "contract_modifications"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "contract_modifications_contractId_modNumber_key" ON "contract_modifications"("contractId", "modNumber");

-- CreateIndex
CREATE INDEX "contract_deliverables_consultingFirmId_idx" ON "contract_deliverables"("consultingFirmId");

-- CreateIndex
CREATE INDEX "contract_deliverables_contractId_idx" ON "contract_deliverables"("contractId");

-- CreateIndex
CREATE INDEX "contract_deliverables_consultingFirmId_dueDate_idx" ON "contract_deliverables"("consultingFirmId", "dueDate");

-- CreateIndex
CREATE INDEX "contract_deliverables_consultingFirmId_status_idx" ON "contract_deliverables"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "contract_deliverables_partnerId_idx" ON "contract_deliverables"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "funding_transactions_modificationId_key" ON "funding_transactions"("modificationId");

-- CreateIndex
CREATE INDEX "funding_transactions_consultingFirmId_idx" ON "funding_transactions"("consultingFirmId");

-- CreateIndex
CREATE INDEX "funding_transactions_contractId_idx" ON "funding_transactions"("contractId");

-- CreateIndex
CREATE INDEX "funding_transactions_clinId_idx" ON "funding_transactions"("clinId");

-- CreateIndex
CREATE INDEX "contract_costs_consultingFirmId_idx" ON "contract_costs"("consultingFirmId");

-- CreateIndex
CREATE INDEX "contract_costs_contractId_idx" ON "contract_costs"("contractId");

-- CreateIndex
CREATE INDEX "contract_costs_consultingFirmId_status_idx" ON "contract_costs"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "contract_costs_consultingFirmId_sourceType_sourceId_idx" ON "contract_costs"("consultingFirmId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "contract_labor_rates_consultingFirmId_idx" ON "contract_labor_rates"("consultingFirmId");

-- CreateIndex
CREATE INDEX "contract_labor_rates_contractId_idx" ON "contract_labor_rates"("contractId");

-- CreateIndex
CREATE INDEX "contract_labor_rates_contractId_categoryName_idx" ON "contract_labor_rates"("contractId", "categoryName");

-- CreateIndex
CREATE INDEX "time_entries_consultingFirmId_idx" ON "time_entries"("consultingFirmId");

-- CreateIndex
CREATE INDEX "time_entries_contractId_idx" ON "time_entries"("contractId");

-- CreateIndex
CREATE INDEX "time_entries_consultingFirmId_workDate_idx" ON "time_entries"("consultingFirmId", "workDate");

-- CreateIndex
CREATE INDEX "time_entries_userId_idx" ON "time_entries"("userId");

-- CreateIndex
CREATE INDEX "time_entries_consultingFirmId_status_idx" ON "time_entries"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "contract_invoices_consultingFirmId_idx" ON "contract_invoices"("consultingFirmId");

-- CreateIndex
CREATE INDEX "contract_invoices_contractId_idx" ON "contract_invoices"("contractId");

-- CreateIndex
CREATE INDEX "contract_invoices_consultingFirmId_status_idx" ON "contract_invoices"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "contract_invoices_consultingFirmId_dueDate_idx" ON "contract_invoices"("consultingFirmId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "contract_invoices_consultingFirmId_invoiceNumber_key" ON "contract_invoices"("consultingFirmId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "invoice_follow_ups_consultingFirmId_invoiceId_idx" ON "invoice_follow_ups"("consultingFirmId", "invoiceId");

-- CreateIndex
CREATE INDEX "invoice_follow_ups_consultingFirmId_nextActionAt_idx" ON "invoice_follow_ups"("consultingFirmId", "nextActionAt");

-- CreateIndex
CREATE INDEX "contract_invoice_line_items_invoiceId_idx" ON "contract_invoice_line_items"("invoiceId");

-- CreateIndex
CREATE INDEX "contract_invoice_line_items_consultingFirmId_idx" ON "contract_invoice_line_items"("consultingFirmId");

-- CreateIndex
CREATE INDEX "contract_invoice_line_items_clinId_idx" ON "contract_invoice_line_items"("clinId");

-- CreateIndex
CREATE INDEX "invoice_payments_consultingFirmId_idx" ON "invoice_payments"("consultingFirmId");

-- CreateIndex
CREATE INDEX "invoice_payments_invoiceId_idx" ON "invoice_payments"("invoiceId");

-- CreateIndex
CREATE INDEX "pricing_workspaces_consultingFirmId_opportunityId_idx" ON "pricing_workspaces"("consultingFirmId", "opportunityId");

-- CreateIndex
CREATE INDEX "pricing_workspaces_consultingFirmId_status_idx" ON "pricing_workspaces"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "pricing_workspaces_opportunityId_version_idx" ON "pricing_workspaces"("opportunityId", "version");

-- CreateIndex
CREATE INDEX "pricing_scenarios_consultingFirmId_idx" ON "pricing_scenarios"("consultingFirmId");

-- CreateIndex
CREATE INDEX "pricing_scenarios_workspaceId_idx" ON "pricing_scenarios"("workspaceId");

-- CreateIndex
CREATE INDEX "pricing_labor_lines_consultingFirmId_idx" ON "pricing_labor_lines"("consultingFirmId");

-- CreateIndex
CREATE INDEX "pricing_labor_lines_scenarioId_idx" ON "pricing_labor_lines"("scenarioId");

-- CreateIndex
CREATE INDEX "pricing_indirect_rates_consultingFirmId_idx" ON "pricing_indirect_rates"("consultingFirmId");

-- CreateIndex
CREATE INDEX "pricing_indirect_rates_scenarioId_idx" ON "pricing_indirect_rates"("scenarioId");

-- CreateIndex
CREATE INDEX "pricing_other_costs_consultingFirmId_idx" ON "pricing_other_costs"("consultingFirmId");

-- CreateIndex
CREATE INDEX "pricing_other_costs_scenarioId_idx" ON "pricing_other_costs"("scenarioId");

-- CreateIndex
CREATE INDEX "pricing_templates_consultingFirmId_idx" ON "pricing_templates"("consultingFirmId");

-- CreateIndex
CREATE INDEX "pricing_templates_consultingFirmId_isArchived_idx" ON "pricing_templates"("consultingFirmId", "isArchived");

-- CreateIndex
CREATE INDEX "pricing_reviews_consultingFirmId_idx" ON "pricing_reviews"("consultingFirmId");

-- CreateIndex
CREATE INDEX "pricing_reviews_workspaceId_idx" ON "pricing_reviews"("workspaceId");

-- CreateIndex
CREATE INDEX "proposal_submissions_consultingFirmId_opportunityId_idx" ON "proposal_submissions"("consultingFirmId", "opportunityId");

-- CreateIndex
CREATE INDEX "proposal_submissions_consultingFirmId_status_idx" ON "proposal_submissions"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "proposal_submissions_finalDeadline_idx" ON "proposal_submissions"("finalDeadline");

-- CreateIndex
CREATE INDEX "submission_checklist_items_consultingFirmId_idx" ON "submission_checklist_items"("consultingFirmId");

-- CreateIndex
CREATE INDEX "submission_checklist_items_submissionId_idx" ON "submission_checklist_items"("submissionId");

-- CreateIndex
CREATE INDEX "submission_checklist_items_submissionId_status_idx" ON "submission_checklist_items"("submissionId", "status");

-- CreateIndex
CREATE INDEX "submission_status_history_consultingFirmId_idx" ON "submission_status_history"("consultingFirmId");

-- CreateIndex
CREATE INDEX "submission_status_history_submissionId_idx" ON "submission_status_history"("submissionId");

-- CreateIndex
CREATE INDEX "past_performance_attachments_consultingFirmId_idx" ON "past_performance_attachments"("consultingFirmId");

-- CreateIndex
CREATE INDEX "past_performance_attachments_pastPerformanceRecordId_idx" ON "past_performance_attachments"("pastPerformanceRecordId");

-- CreateIndex
CREATE INDEX "past_performance_selections_consultingFirmId_idx" ON "past_performance_selections"("consultingFirmId");

-- CreateIndex
CREATE INDEX "past_performance_selections_opportunityId_idx" ON "past_performance_selections"("opportunityId");

-- CreateIndex
CREATE INDEX "past_performance_selections_pastPerformanceRecordId_idx" ON "past_performance_selections"("pastPerformanceRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "past_performance_selections_opportunityId_pastPerformanceRe_key" ON "past_performance_selections"("opportunityId", "pastPerformanceRecordId");

-- CreateIndex
CREATE INDEX "opportunity_source_configs_consultingFirmId_isEnabled_idx" ON "opportunity_source_configs"("consultingFirmId", "isEnabled");

-- CreateIndex
CREATE INDEX "opportunity_source_configs_nextRunAt_idx" ON "opportunity_source_configs"("nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "opportunity_source_configs_consultingFirmId_adapterKey_key" ON "opportunity_source_configs"("consultingFirmId", "adapterKey");

-- CreateIndex
CREATE UNIQUE INDEX "source_sync_runs_idempotencyKey_key" ON "source_sync_runs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "source_sync_runs_consultingFirmId_status_idx" ON "source_sync_runs"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "source_sync_runs_sourceConfigId_createdAt_idx" ON "source_sync_runs"("sourceConfigId", "createdAt");

-- CreateIndex
CREATE INDEX "agency_forecasts_consultingFirmId_agency_idx" ON "agency_forecasts"("consultingFirmId", "agency");

-- CreateIndex
CREATE INDEX "agency_forecasts_consultingFirmId_fiscalYear_idx" ON "agency_forecasts"("consultingFirmId", "fiscalYear");

-- CreateIndex
CREATE INDEX "agency_forecasts_consultingFirmId_anticipatedSolicitationDa_idx" ON "agency_forecasts"("consultingFirmId", "anticipatedSolicitationDate");

-- CreateIndex
CREATE INDEX "agency_forecasts_consultingFirmId_naicsCode_idx" ON "agency_forecasts"("consultingFirmId", "naicsCode");

-- CreateIndex
CREATE INDEX "agency_forecasts_linkedOpportunityId_idx" ON "agency_forecasts"("linkedOpportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "agency_forecasts_consultingFirmId_externalId_key" ON "agency_forecasts"("consultingFirmId", "externalId");

-- CreateIndex
CREATE INDEX "agency_forecast_versions_forecastId_idx" ON "agency_forecast_versions"("forecastId");

-- CreateIndex
CREATE UNIQUE INDEX "agency_forecast_versions_forecastId_versionNo_key" ON "agency_forecast_versions"("forecastId", "versionNo");

-- CreateIndex
CREATE INDEX "recompete_signals_consultingFirmId_windowStart_idx" ON "recompete_signals"("consultingFirmId", "windowStart");

-- CreateIndex
CREATE INDEX "recompete_signals_consultingFirmId_verification_idx" ON "recompete_signals"("consultingFirmId", "verification");

-- CreateIndex
CREATE UNIQUE INDEX "recompete_signals_consultingFirmId_detectionMethod_sourceCo_key" ON "recompete_signals"("consultingFirmId", "detectionMethod", "sourceContractId", "sourceOpportunityId", "sourceAwardRef");

-- CreateIndex
CREATE INDEX "firm_capabilities_consultingFirmId_isArchived_idx" ON "firm_capabilities"("consultingFirmId", "isArchived");

-- CreateIndex
CREATE INDEX "firm_capabilities_consultingFirmId_category_idx" ON "firm_capabilities"("consultingFirmId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "opportunity_matches_opportunityId_key" ON "opportunity_matches"("opportunityId");

-- CreateIndex
CREATE INDEX "opportunity_matches_consultingFirmId_overallScore_idx" ON "opportunity_matches"("consultingFirmId", "overallScore");

-- CreateIndex
CREATE INDEX "opportunity_matches_consultingFirmId_eligibility_idx" ON "opportunity_matches"("consultingFirmId", "eligibility");

-- CreateIndex
CREATE UNIQUE INDEX "opportunity_matches_consultingFirmId_opportunityId_key" ON "opportunity_matches"("consultingFirmId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "monitoring_profile_alerts_dedupeKey_key" ON "monitoring_profile_alerts"("dedupeKey");

-- CreateIndex
CREATE INDEX "monitoring_profile_alerts_consultingFirmId_profileId_idx" ON "monitoring_profile_alerts"("consultingFirmId", "profileId");

-- CreateIndex
CREATE INDEX "monitoring_profile_alerts_profileId_lastSentAt_idx" ON "monitoring_profile_alerts"("profileId", "lastSentAt");

-- CreateIndex
CREATE INDEX "tenant_calibrations_consultingFirmId_state_idx" ON "tenant_calibrations"("consultingFirmId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_calibrations_consultingFirmId_version_key" ON "tenant_calibrations"("consultingFirmId", "version");

-- CreateIndex
CREATE INDEX "calibration_samples_consultingFirmId_observedAt_idx" ON "calibration_samples"("consultingFirmId", "observedAt");

-- CreateIndex
CREATE INDEX "calibration_samples_calibrationId_idx" ON "calibration_samples"("calibrationId");

-- CreateIndex
CREATE UNIQUE INDEX "calibration_samples_consultingFirmId_opportunityId_outcomeS_key" ON "calibration_samples"("consultingFirmId", "opportunityId", "outcomeSource");

-- CreateIndex
CREATE INDEX "incumbent_retention_stats_consultingFirmId_normalizedName_idx" ON "incumbent_retention_stats"("consultingFirmId", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "incumbent_retention_stats_consultingFirmId_normalizedName_a_key" ON "incumbent_retention_stats"("consultingFirmId", "normalizedName", "agency", "naicsCode");

-- CreateIndex
CREATE INDEX "competitor_award_stats_consultingFirmId_normalizedName_idx" ON "competitor_award_stats"("consultingFirmId", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "competitor_award_stats_consultingFirmId_normalizedName_agen_key" ON "competitor_award_stats"("consultingFirmId", "normalizedName", "agency", "naicsCode");

-- CreateIndex
CREATE INDEX "pricing_sensitivity_analyses_consultingFirmId_opportunityId_idx" ON "pricing_sensitivity_analyses"("consultingFirmId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "capability_gap_assessments_opportunityId_key" ON "capability_gap_assessments"("opportunityId");

-- CreateIndex
CREATE INDEX "capability_gap_assessments_consultingFirmId_idx" ON "capability_gap_assessments"("consultingFirmId");

-- CreateIndex
CREATE UNIQUE INDEX "capability_gap_assessments_consultingFirmId_opportunityId_key" ON "capability_gap_assessments"("consultingFirmId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "solicitation_extraction_jobs_idempotencyKey_key" ON "solicitation_extraction_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "solicitation_extraction_jobs_consultingFirmId_status_idx" ON "solicitation_extraction_jobs"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "solicitation_extraction_jobs_opportunityId_idx" ON "solicitation_extraction_jobs"("opportunityId");

-- CreateIndex
CREATE INDEX "section_lm_mappings_consultingFirmId_opportunityId_idx" ON "section_lm_mappings"("consultingFirmId", "opportunityId");

-- CreateIndex
CREATE INDEX "section_lm_mappings_opportunityId_verification_idx" ON "section_lm_mappings"("opportunityId", "verification");

-- CreateIndex
CREATE INDEX "clause_obligations_consultingFirmId_opportunityId_idx" ON "clause_obligations"("consultingFirmId", "opportunityId");

-- CreateIndex
CREATE INDEX "clause_obligations_opportunityId_flowDownStatus_idx" ON "clause_obligations"("opportunityId", "flowDownStatus");

-- CreateIndex
CREATE UNIQUE INDEX "clause_obligations_consultingFirmId_opportunityId_clauseNum_key" ON "clause_obligations"("consultingFirmId", "opportunityId", "clauseNumber");

-- CreateIndex
CREATE INDEX "clause_obligation_events_obligationId_idx" ON "clause_obligation_events"("obligationId");

-- CreateIndex
CREATE INDEX "standing_documents_consultingFirmId_category_idx" ON "standing_documents"("consultingFirmId", "category");

-- CreateIndex
CREATE INDEX "standing_documents_consultingFirmId_isArchived_idx" ON "standing_documents"("consultingFirmId", "isArchived");

-- CreateIndex
CREATE INDEX "standing_documents_consultingFirmId_expiryDate_idx" ON "standing_documents"("consultingFirmId", "expiryDate");

-- CreateIndex
CREATE INDEX "standing_document_versions_documentId_idx" ON "standing_document_versions"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "standing_document_versions_documentId_versionNo_key" ON "standing_document_versions"("documentId", "versionNo");

-- CreateIndex
CREATE INDEX "standing_document_links_consultingFirmId_targetType_targetI_idx" ON "standing_document_links"("consultingFirmId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "standing_document_links_opportunityId_idx" ON "standing_document_links"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "standing_document_links_documentId_targetType_targetId_key" ON "standing_document_links"("documentId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "submission_validation_checks_consultingFirmId_submissionId_idx" ON "submission_validation_checks"("consultingFirmId", "submissionId");

-- CreateIndex
CREATE INDEX "submission_validation_checks_submissionId_runId_idx" ON "submission_validation_checks"("submissionId", "runId");

-- CreateIndex
CREATE INDEX "matrix_requirement_events_requirementId_idx" ON "matrix_requirement_events"("requirementId");

-- CreateIndex
CREATE INDEX "matrix_requirement_events_consultingFirmId_idx" ON "matrix_requirement_events"("consultingFirmId");

-- CreateIndex
CREATE INDEX "opportunity_milestones_consultingFirmId_opportunityId_idx" ON "opportunity_milestones"("consultingFirmId", "opportunityId");

-- CreateIndex
CREATE INDEX "opportunity_milestones_consultingFirmId_status_idx" ON "opportunity_milestones"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "opportunity_milestones_consultingFirmId_endAt_idx" ON "opportunity_milestones"("consultingFirmId", "endAt");

-- CreateIndex
CREATE INDEX "opportunity_milestones_opportunityId_milestoneType_idx" ON "opportunity_milestones"("opportunityId", "milestoneType");

-- CreateIndex
CREATE INDEX "milestone_events_milestoneId_idx" ON "milestone_events"("milestoneId");

-- CreateIndex
CREATE UNIQUE INDEX "milestone_reminder_logs_dedupeKey_key" ON "milestone_reminder_logs"("dedupeKey");

-- CreateIndex
CREATE INDEX "milestone_reminder_logs_consultingFirmId_milestoneId_idx" ON "milestone_reminder_logs"("consultingFirmId", "milestoneId");

-- CreateIndex
CREATE INDEX "milestone_reminder_logs_userId_sentAt_idx" ON "milestone_reminder_logs"("userId", "sentAt");

-- CreateIndex
CREATE INDEX "amendment_revisions_consultingFirmId_opportunityId_idx" ON "amendment_revisions"("consultingFirmId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "amendment_revisions_opportunityId_revisionNo_key" ON "amendment_revisions"("opportunityId", "revisionNo");

-- CreateIndex
CREATE UNIQUE INDEX "amendment_revisions_opportunityId_contentHash_key" ON "amendment_revisions"("opportunityId", "contentHash");

-- CreateIndex
CREATE INDEX "amendment_impacts_consultingFirmId_opportunityId_idx" ON "amendment_impacts"("consultingFirmId", "opportunityId");

-- CreateIndex
CREATE INDEX "amendment_impacts_revisionId_idx" ON "amendment_impacts"("revisionId");

-- CreateIndex
CREATE INDEX "schedule_templates_consultingFirmId_isArchived_idx" ON "schedule_templates"("consultingFirmId", "isArchived");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_templates_consultingFirmId_name_key" ON "schedule_templates"("consultingFirmId", "name");

-- CreateIndex
CREATE INDEX "schedule_runs_consultingFirmId_opportunityId_idx" ON "schedule_runs"("consultingFirmId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_runs_opportunityId_versionNo_key" ON "schedule_runs"("opportunityId", "versionNo");

-- CreateIndex
CREATE INDEX "holiday_calendar_entries_calendarKey_date_idx" ON "holiday_calendar_entries"("calendarKey", "date");

-- CreateIndex
CREATE UNIQUE INDEX "holiday_calendar_entries_calendarKey_date_consultingFirmId_key" ON "holiday_calendar_entries"("calendarKey", "date", "consultingFirmId");

-- CreateIndex
CREATE INDEX "agent_schedules_consultingFirmId_idx" ON "agent_schedules"("consultingFirmId");

-- CreateIndex
CREATE INDEX "agent_schedules_agentKey_idx" ON "agent_schedules"("agentKey");

-- CreateIndex
CREATE INDEX "agent_schedules_isEnabled_idx" ON "agent_schedules"("isEnabled");

-- CreateIndex
CREATE INDEX "agent_schedules_isEnabled_nextRunAt_idx" ON "agent_schedules"("isEnabled", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_schedules_consultingFirmId_agentKey_key" ON "agent_schedules"("consultingFirmId", "agentKey");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_idempotencyKey_key" ON "agent_runs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "agent_runs_consultingFirmId_agentKey_status_idx" ON "agent_runs"("consultingFirmId", "agentKey", "status");

-- CreateIndex
CREATE INDEX "agent_runs_consultingFirmId_createdAt_idx" ON "agent_runs"("consultingFirmId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_runs_consultingFirmId_triggerEntityType_triggerEntity_idx" ON "agent_runs"("consultingFirmId", "triggerEntityType", "triggerEntityId");

-- CreateIndex
CREATE INDEX "agent_runs_status_heartbeatAt_idx" ON "agent_runs"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "agent_runs_scheduleId_idx" ON "agent_runs"("scheduleId");

-- CreateIndex
CREATE INDEX "agent_runs_eventId_idx" ON "agent_runs"("eventId");

-- CreateIndex
CREATE INDEX "agent_artifacts_consultingFirmId_agentKey_artifactType_idx" ON "agent_artifacts"("consultingFirmId", "agentKey", "artifactType");

-- CreateIndex
CREATE INDEX "agent_artifacts_consultingFirmId_sourceEntityType_sourceEnt_idx" ON "agent_artifacts"("consultingFirmId", "sourceEntityType", "sourceEntityId");

-- CreateIndex
CREATE INDEX "agent_artifacts_runId_idx" ON "agent_artifacts"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_escalations_dedupeKey_key" ON "agent_escalations"("dedupeKey");

-- CreateIndex
CREATE INDEX "agent_escalations_consultingFirmId_status_severity_idx" ON "agent_escalations"("consultingFirmId", "status", "severity");

-- CreateIndex
CREATE INDEX "agent_escalations_consultingFirmId_agentKey_status_idx" ON "agent_escalations"("consultingFirmId", "agentKey", "status");

-- CreateIndex
CREATE INDEX "agent_escalations_assignedToUserId_idx" ON "agent_escalations"("assignedToUserId");

-- CreateIndex
CREATE INDEX "agent_escalations_runId_idx" ON "agent_escalations"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_events_dedupeKey_key" ON "agent_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "agent_events_status_availableAt_idx" ON "agent_events"("status", "availableAt");

-- CreateIndex
CREATE INDEX "agent_events_consultingFirmId_eventType_idx" ON "agent_events"("consultingFirmId", "eventType");

-- CreateIndex
CREATE INDEX "agent_events_consultingFirmId_entityType_entityId_idx" ON "agent_events"("consultingFirmId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "agent_notification_preferences_consultingFirmId_idx" ON "agent_notification_preferences"("consultingFirmId");

-- CreateIndex
CREATE INDEX "agent_notification_preferences_consultingFirmId_agentKey_idx" ON "agent_notification_preferences"("consultingFirmId", "agentKey");

-- CreateIndex
CREATE UNIQUE INDEX "agent_notification_preferences_userId_agentKey_key" ON "agent_notification_preferences"("userId", "agentKey");

-- CreateIndex
CREATE INDEX "pursuit_feedback_signals_consultingFirmId_status_idx" ON "pursuit_feedback_signals"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "pursuit_feedback_signals_consultingFirmId_generatedAt_idx" ON "pursuit_feedback_signals"("consultingFirmId", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "pursuit_feedback_signals_consultingFirmId_inputHash_key" ON "pursuit_feedback_signals"("consultingFirmId", "inputHash");

-- CreateIndex
CREATE INDEX "bonding_capacities_consultingFirmId_status_idx" ON "bonding_capacities"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "bonding_capacities_consultingFirmId_expiryDate_idx" ON "bonding_capacities"("consultingFirmId", "expiryDate");

-- CreateIndex
CREATE INDEX "qualification_recommendations_consultingFirmId_status_idx" ON "qualification_recommendations"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "qualification_recommendations_consultingFirmId_pursuitId_ve_idx" ON "qualification_recommendations"("consultingFirmId", "pursuitId", "version");

-- CreateIndex
CREATE INDEX "qualification_recommendations_consultingFirmId_createdAt_idx" ON "qualification_recommendations"("consultingFirmId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "qualification_recommendations_pursuitId_inputHash_key" ON "qualification_recommendations"("pursuitId", "inputHash");

-- CreateIndex
CREATE INDEX "partner_performance_records_consultingFirmId_idx" ON "partner_performance_records"("consultingFirmId");

-- CreateIndex
CREATE INDEX "partner_performance_records_consultingFirmId_partnerId_idx" ON "partner_performance_records"("consultingFirmId", "partnerId");

-- CreateIndex
CREATE INDEX "partner_performance_records_consultingFirmId_periodEnd_idx" ON "partner_performance_records"("consultingFirmId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "partner_performance_records_partnerId_periodStart_periodEnd_key" ON "partner_performance_records"("partnerId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "subcontracting_goals_consultingFirmId_idx" ON "subcontracting_goals"("consultingFirmId");

-- CreateIndex
CREATE INDEX "subcontracting_goals_consultingFirmId_status_idx" ON "subcontracting_goals"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "subcontracting_goals_consultingFirmId_dueDate_idx" ON "subcontracting_goals"("consultingFirmId", "dueDate");

-- CreateIndex
CREATE INDEX "subcontracting_goals_pursuitId_idx" ON "subcontracting_goals"("pursuitId");

-- CreateIndex
CREATE INDEX "subcontracting_goals_contractId_idx" ON "subcontracting_goals"("contractId");

-- CreateIndex
CREATE INDEX "subcontracting_goal_progress_consultingFirmId_idx" ON "subcontracting_goal_progress"("consultingFirmId");

-- CreateIndex
CREATE INDEX "subcontracting_goal_progress_goalId_idx" ON "subcontracting_goal_progress"("goalId");

-- CreateIndex
CREATE INDEX "subcontracting_goal_progress_consultingFirmId_riskState_idx" ON "subcontracting_goal_progress"("consultingFirmId", "riskState");

-- CreateIndex
CREATE UNIQUE INDEX "subcontracting_goal_progress_goalId_periodStart_periodEnd_key" ON "subcontracting_goal_progress"("goalId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "award_benchmark_cohorts_consultingFirmId_idx" ON "award_benchmark_cohorts"("consultingFirmId");

-- CreateIndex
CREATE INDEX "award_benchmark_cohorts_consultingFirmId_pricingScenarioId_idx" ON "award_benchmark_cohorts"("consultingFirmId", "pricingScenarioId");

-- CreateIndex
CREATE INDEX "award_benchmark_cohorts_consultingFirmId_pricingWorkspaceId_idx" ON "award_benchmark_cohorts"("consultingFirmId", "pricingWorkspaceId");

-- CreateIndex
CREATE INDEX "award_benchmark_cohorts_consultingFirmId_computedAt_idx" ON "award_benchmark_cohorts"("consultingFirmId", "computedAt");

-- CreateIndex
CREATE INDEX "award_benchmark_cohorts_staleAt_idx" ON "award_benchmark_cohorts"("staleAt");

-- CreateIndex
CREATE UNIQUE INDEX "award_benchmark_cohorts_consultingFirmId_inputHash_key" ON "award_benchmark_cohorts"("consultingFirmId", "inputHash");

-- CreateIndex
CREATE INDEX "capability_narratives_consultingFirmId_idx" ON "capability_narratives"("consultingFirmId");

-- CreateIndex
CREATE INDEX "capability_narratives_consultingFirmId_status_idx" ON "capability_narratives"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "capability_narratives_consultingFirmId_category_idx" ON "capability_narratives"("consultingFirmId", "category");

-- CreateIndex
CREATE INDEX "capability_narrative_versions_consultingFirmId_idx" ON "capability_narrative_versions"("consultingFirmId");

-- CreateIndex
CREATE INDEX "capability_narrative_versions_consultingFirmId_status_idx" ON "capability_narrative_versions"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "capability_narrative_versions_capabilityNarrativeId_status_idx" ON "capability_narrative_versions"("capabilityNarrativeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "capability_narrative_versions_capabilityNarrativeId_version_key" ON "capability_narrative_versions"("capabilityNarrativeId", "versionNumber");

-- CreateIndex
CREATE INDEX "actual_indirect_rates_consultingFirmId_idx" ON "actual_indirect_rates"("consultingFirmId");

-- CreateIndex
CREATE INDEX "actual_indirect_rates_consultingFirmId_fiscalYear_idx" ON "actual_indirect_rates"("consultingFirmId", "fiscalYear");

-- CreateIndex
CREATE INDEX "actual_indirect_rates_consultingFirmId_rateType_idx" ON "actual_indirect_rates"("consultingFirmId", "rateType");

-- CreateIndex
CREATE INDEX "actual_indirect_rates_consultingFirmId_periodStart_periodEn_idx" ON "actual_indirect_rates"("consultingFirmId", "periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "actual_indirect_rates_consultingFirmId_rateType_periodStart_key" ON "actual_indirect_rates"("consultingFirmId", "rateType", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "dcaa_readiness_checks_consultingFirmId_idx" ON "dcaa_readiness_checks"("consultingFirmId");

-- CreateIndex
CREATE INDEX "dcaa_readiness_checks_consultingFirmId_checkedAt_idx" ON "dcaa_readiness_checks"("consultingFirmId", "checkedAt");

-- CreateIndex
CREATE INDEX "dcaa_readiness_checks_consultingFirmId_ruleKey_idx" ON "dcaa_readiness_checks"("consultingFirmId", "ruleKey");

-- CreateIndex
CREATE INDEX "dcaa_readiness_checks_consultingFirmId_verdict_idx" ON "dcaa_readiness_checks"("consultingFirmId", "verdict");

-- CreateIndex
CREATE INDEX "dcaa_readiness_checks_contractId_idx" ON "dcaa_readiness_checks"("contractId");

-- CreateIndex
CREATE INDEX "cash_flow_projections_consultingFirmId_idx" ON "cash_flow_projections"("consultingFirmId");

-- CreateIndex
CREATE INDEX "cash_flow_projections_consultingFirmId_computedAt_idx" ON "cash_flow_projections"("consultingFirmId", "computedAt");

-- CreateIndex
CREATE INDEX "cash_flow_projections_consultingFirmId_periodStart_periodEn_idx" ON "cash_flow_projections"("consultingFirmId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "cash_flow_projections_consultingFirmId_inputHash_idx" ON "cash_flow_projections"("consultingFirmId", "inputHash");

-- CreateIndex
CREATE INDEX "win_loss_segments_consultingFirmId_idx" ON "win_loss_segments"("consultingFirmId");

-- CreateIndex
CREATE INDEX "win_loss_segments_consultingFirmId_segmentType_idx" ON "win_loss_segments"("consultingFirmId", "segmentType");

-- CreateIndex
CREATE INDEX "win_loss_segments_consultingFirmId_segmentType_segmentKey_idx" ON "win_loss_segments"("consultingFirmId", "segmentType", "segmentKey");

-- CreateIndex
CREATE INDEX "win_loss_segments_consultingFirmId_inputHash_idx" ON "win_loss_segments"("consultingFirmId", "inputHash");

-- CreateIndex
CREATE INDEX "win_loss_segments_consultingFirmId_computedAt_idx" ON "win_loss_segments"("consultingFirmId", "computedAt");

-- CreateIndex
CREATE INDEX "capture_recommendations_consultingFirmId_idx" ON "capture_recommendations"("consultingFirmId");

-- CreateIndex
CREATE INDEX "capture_recommendations_consultingFirmId_status_idx" ON "capture_recommendations"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "capture_recommendations_consultingFirmId_segmentType_segmen_idx" ON "capture_recommendations"("consultingFirmId", "segmentType", "segmentKey");

-- CreateIndex
CREATE INDEX "capture_recommendations_consultingFirmId_inputHash_idx" ON "capture_recommendations"("consultingFirmId", "inputHash");

-- CreateIndex
CREATE INDEX "capture_recommendations_consultingFirmId_status_rank_idx" ON "capture_recommendations"("consultingFirmId", "status", "rank");

-- CreateIndex
CREATE INDEX "agency_offices_consultingFirmId_agencyName_idx" ON "agency_offices"("consultingFirmId", "agencyName");

-- CreateIndex
CREATE INDEX "agency_offices_consultingFirmId_isArchived_idx" ON "agency_offices"("consultingFirmId", "isArchived");

-- CreateIndex
CREATE UNIQUE INDEX "agency_offices_consultingFirmId_agencyName_officeName_key" ON "agency_offices"("consultingFirmId", "agencyName", "officeName");

-- CreateIndex
CREATE INDEX "government_contacts_consultingFirmId_agencyName_idx" ON "government_contacts"("consultingFirmId", "agencyName");

-- CreateIndex
CREATE INDEX "government_contacts_consultingFirmId_agencyOfficeId_idx" ON "government_contacts"("consultingFirmId", "agencyOfficeId");

-- CreateIndex
CREATE INDEX "government_contacts_consultingFirmId_isArchived_idx" ON "government_contacts"("consultingFirmId", "isArchived");

-- CreateIndex
CREATE INDEX "partner_contacts_consultingFirmId_partnerId_idx" ON "partner_contacts"("consultingFirmId", "partnerId");

-- CreateIndex
CREATE INDEX "partner_contacts_consultingFirmId_status_idx" ON "partner_contacts"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "crm_activities_consultingFirmId_occurredAt_idx" ON "crm_activities"("consultingFirmId", "occurredAt");

-- CreateIndex
CREATE INDEX "crm_activities_consultingFirmId_governmentContactId_occurre_idx" ON "crm_activities"("consultingFirmId", "governmentContactId", "occurredAt");

-- CreateIndex
CREATE INDEX "crm_activities_consultingFirmId_partnerId_occurredAt_idx" ON "crm_activities"("consultingFirmId", "partnerId", "occurredAt");

-- CreateIndex
CREATE INDEX "crm_activities_consultingFirmId_opportunityId_idx" ON "crm_activities"("consultingFirmId", "opportunityId");

-- CreateIndex
CREATE INDEX "crm_activities_consultingFirmId_agencyName_occurredAt_idx" ON "crm_activities"("consultingFirmId", "agencyName", "occurredAt");

-- CreateIndex
CREATE INDEX "crm_follow_ups_consultingFirmId_status_dueAt_idx" ON "crm_follow_ups"("consultingFirmId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "crm_follow_ups_consultingFirmId_ownerUserId_status_idx" ON "crm_follow_ups"("consultingFirmId", "ownerUserId", "status");

-- CreateIndex
CREATE INDEX "crm_follow_ups_consultingFirmId_governmentContactId_idx" ON "crm_follow_ups"("consultingFirmId", "governmentContactId");

-- CreateIndex
CREATE INDEX "crm_follow_ups_consultingFirmId_partnerId_idx" ON "crm_follow_ups"("consultingFirmId", "partnerId");

-- CreateIndex
CREATE INDEX "contract_budgets_consultingFirmId_contractId_status_idx" ON "contract_budgets"("consultingFirmId", "contractId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "contract_budgets_contractId_versionNumber_key" ON "contract_budgets"("contractId", "versionNumber");

-- CreateIndex
CREATE INDEX "contract_budget_lines_consultingFirmId_budgetId_idx" ON "contract_budget_lines"("consultingFirmId", "budgetId");

-- CreateIndex
CREATE INDEX "contract_budget_lines_budgetId_clinId_category_idx" ON "contract_budget_lines"("budgetId", "clinId", "category");

-- CreateIndex
CREATE INDEX "resource_allocations_consultingFirmId_userId_startDate_idx" ON "resource_allocations"("consultingFirmId", "userId", "startDate");

-- CreateIndex
CREATE INDEX "resource_allocations_consultingFirmId_contractId_status_idx" ON "resource_allocations"("consultingFirmId", "contractId", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_consultingFirmId_contractId_status_idx" ON "purchase_orders"("consultingFirmId", "contractId", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_consultingFirmId_partnerId_idx" ON "purchase_orders"("consultingFirmId", "partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_consultingFirmId_poNumber_key" ON "purchase_orders"("consultingFirmId", "poNumber");

-- CreateIndex
CREATE INDEX "purchase_order_lines_consultingFirmId_purchaseOrderId_idx" ON "purchase_order_lines"("consultingFirmId", "purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_invoices_postedContractCostId_key" ON "subcontract_invoices"("postedContractCostId");

-- CreateIndex
CREATE INDEX "subcontract_invoices_consultingFirmId_status_idx" ON "subcontract_invoices"("consultingFirmId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_invoices_consultingFirmId_purchaseOrderId_invoi_key" ON "subcontract_invoices"("consultingFirmId", "purchaseOrderId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "subcontract_invoice_lines_consultingFirmId_subcontractInvoi_idx" ON "subcontract_invoice_lines"("consultingFirmId", "subcontractInvoiceId");

-- CreateIndex
CREATE INDEX "subcontract_flow_downs_consultingFirmId_purchaseOrderId_idx" ON "subcontract_flow_downs"("consultingFirmId", "purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_flow_downs_purchaseOrderId_clauseNumber_key" ON "subcontract_flow_downs"("purchaseOrderId", "clauseNumber");

-- CreateIndex
CREATE INDEX "personnel_consultingFirmId_isArchived_idx" ON "personnel"("consultingFirmId", "isArchived");

-- CreateIndex
CREATE INDEX "personnel_consultingFirmId_userId_idx" ON "personnel"("consultingFirmId", "userId");

-- CreateIndex
CREATE INDEX "personnel_consultingFirmId_lastName_idx" ON "personnel"("consultingFirmId", "lastName");

-- CreateIndex
CREATE INDEX "personnel_labor_qualifications_consultingFirmId_laborCatego_idx" ON "personnel_labor_qualifications"("consultingFirmId", "laborCategory");

-- CreateIndex
CREATE UNIQUE INDEX "personnel_labor_qualifications_personnelId_laborCategory_key" ON "personnel_labor_qualifications"("personnelId", "laborCategory");

-- CreateIndex
CREATE INDEX "personnel_resumes_consultingFirmId_personnelId_status_idx" ON "personnel_resumes"("consultingFirmId", "personnelId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "personnel_resumes_personnelId_versionNumber_key" ON "personnel_resumes"("personnelId", "versionNumber");

-- CreateIndex
CREATE INDEX "proposal_key_personnel_consultingFirmId_proposalId_idx" ON "proposal_key_personnel"("consultingFirmId", "proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "proposal_key_personnel_proposalId_personnelId_key" ON "proposal_key_personnel"("proposalId", "personnelId");

-- CreateIndex
CREATE INDEX "partner_portal_users_consultingFirmId_partnerId_idx" ON "partner_portal_users"("consultingFirmId", "partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "partner_portal_users_consultingFirmId_email_key" ON "partner_portal_users"("consultingFirmId", "email");

-- CreateIndex
CREATE INDEX "partner_engagement_access_consultingFirmId_scopeType_scopeI_idx" ON "partner_engagement_access"("consultingFirmId", "scopeType", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "partner_engagement_access_partnerPortalUserId_scopeType_sco_key" ON "partner_engagement_access"("partnerPortalUserId", "scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "partner_portal_uploads_consultingFirmId_partnerId_idx" ON "partner_portal_uploads"("consultingFirmId", "partnerId");

-- CreateIndex
CREATE INDEX "partner_portal_uploads_consultingFirmId_scopeType_scopeId_idx" ON "partner_portal_uploads"("consultingFirmId", "scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "partner_personnel_submissions_consultingFirmId_partnerId_st_idx" ON "partner_personnel_submissions"("consultingFirmId", "partnerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "partner_portal_password_resets_tokenHash_key" ON "partner_portal_password_resets"("tokenHash");

-- CreateIndex
CREATE INDEX "partner_portal_password_resets_partnerPortalUserId_idx" ON "partner_portal_password_resets"("partnerPortalUserId");

-- CreateIndex
CREATE INDEX "partner_portal_password_resets_expiresAt_idx" ON "partner_portal_password_resets"("expiresAt");

-- CreateIndex
CREATE INDEX "partner_deliverable_submissions_consultingFirmId_deliverabl_idx" ON "partner_deliverable_submissions"("consultingFirmId", "deliverableId");

-- CreateIndex
CREATE INDEX "partner_deliverable_submissions_consultingFirmId_partnerId__idx" ON "partner_deliverable_submissions"("consultingFirmId", "partnerId", "status");

-- CreateIndex
CREATE INDEX "partner_profile_change_requests_consultingFirmId_partnerId__idx" ON "partner_profile_change_requests"("consultingFirmId", "partnerId", "status");

-- CreateIndex
CREATE INDEX "public_api_request_logs_consultingFirmId_createdAt_idx" ON "public_api_request_logs"("consultingFirmId", "createdAt");

-- CreateIndex
CREATE INDEX "public_api_request_logs_apiTokenId_createdAt_idx" ON "public_api_request_logs"("apiTokenId", "createdAt");

-- CreateIndex
CREATE INDEX "integration_connections_consultingFirmId_category_idx" ON "integration_connections"("consultingFirmId", "category");

-- CreateIndex
CREATE INDEX "integration_connections_provider_externalAccountId_idx" ON "integration_connections"("provider", "externalAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_consultingFirmId_provider_key" ON "integration_connections"("consultingFirmId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "integration_oauth_states_stateHash_key" ON "integration_oauth_states"("stateHash");

-- CreateIndex
CREATE INDEX "integration_oauth_states_consultingFirmId_provider_idx" ON "integration_oauth_states"("consultingFirmId", "provider");

-- CreateIndex
CREATE INDEX "integration_oauth_states_expiresAt_idx" ON "integration_oauth_states"("expiresAt");

-- CreateIndex
CREATE INDEX "integration_sync_records_consultingFirmId_localType_idx" ON "integration_sync_records"("consultingFirmId", "localType");

-- CreateIndex
CREATE UNIQUE INDEX "integration_sync_records_connectionId_localType_localId_key" ON "integration_sync_records"("connectionId", "localType", "localId");

-- CreateIndex
CREATE UNIQUE INDEX "integration_sync_records_connectionId_externalId_key" ON "integration_sync_records"("connectionId", "externalId");

-- CreateIndex
CREATE INDEX "integration_events_consultingFirmId_createdAt_idx" ON "integration_events"("consultingFirmId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "integration_events_provider_externalEventId_key" ON "integration_events"("provider", "externalEventId");

-- CreateIndex
CREATE INDEX "signature_requests_consultingFirmId_status_idx" ON "signature_requests"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "signature_requests_consultingFirmId_documentType_idx" ON "signature_requests"("consultingFirmId", "documentType");

-- CreateIndex
CREATE UNIQUE INDEX "signature_requests_provider_externalEnvelopeId_key" ON "signature_requests"("provider", "externalEnvelopeId");

-- CreateIndex
CREATE INDEX "signature_signers_signatureRequestId_idx" ON "signature_signers"("signatureRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "firm_sso_configs_consultingFirmId_key" ON "firm_sso_configs"("consultingFirmId");

-- CreateIndex
CREATE INDEX "sso_identities_consultingFirmId_idx" ON "sso_identities"("consultingFirmId");

-- CreateIndex
CREATE UNIQUE INDEX "sso_identities_issuer_subject_key" ON "sso_identities"("issuer", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "sso_identities_ssoConfigId_userId_key" ON "sso_identities"("ssoConfigId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "sso_login_states_stateHash_key" ON "sso_login_states"("stateHash");

-- CreateIndex
CREATE INDEX "sso_login_states_expiresAt_idx" ON "sso_login_states"("expiresAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_naics" ADD CONSTRAINT "client_naics_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_naics" ADD CONSTRAINT "client_naics_naicsCodeId_fkey" FOREIGN KEY ("naicsCodeId") REFERENCES "naics_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_companies" ADD CONSTRAINT "client_companies_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_naicsCodeId_fkey" FOREIGN KEY ("naicsCodeId") REFERENCES "naics_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_sourceConfigId_fkey" FOREIGN KEY ("sourceConfigId") REFERENCES "opportunity_source_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amendments" ADD CONSTRAINT "amendments_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "award_history" ADD CONSTRAINT "award_history_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_documents" ADD CONSTRAINT "opportunity_documents_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_records" ADD CONSTRAINT "submission_records_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_records" ADD CONSTRAINT "submission_records_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_records" ADD CONSTRAINT "submission_records_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_records" ADD CONSTRAINT "submission_records_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bid_pursuits" ADD CONSTRAINT "bid_pursuits_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bid_pursuits" ADD CONSTRAINT "bid_pursuits_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bid_pursuits" ADD CONSTRAINT "bid_pursuits_submissionRecordId_fkey" FOREIGN KEY ("submissionRecordId") REFERENCES "submission_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bid_pursuits" ADD CONSTRAINT "bid_pursuits_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_penalties" ADD CONSTRAINT "financial_penalties_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_penalties" ADD CONSTRAINT "financial_penalties_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_penalties" ADD CONSTRAINT "financial_penalties_submissionRecordId_fkey" FOREIGN KEY ("submissionRecordId") REFERENCES "submission_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_stats" ADD CONSTRAINT "performance_stats_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bid_decisions" ADD CONSTRAINT "bid_decisions_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bid_decisions" ADD CONSTRAINT "bid_decisions_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bid_decisions" ADD CONSTRAINT "bid_decisions_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecard_criterion_configs" ADD CONSTRAINT "scorecard_criterion_configs_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_bidPursuitId_fkey" FOREIGN KEY ("bidPursuitId") REFERENCES "bid_pursuits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecard_criteria" ADD CONSTRAINT "scorecard_criteria_scorecardId_fkey" FOREIGN KEY ("scorecardId") REFERENCES "scorecards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecard_decisions" ADD CONSTRAINT "scorecard_decisions_scorecardId_fkey" FOREIGN KEY ("scorecardId") REFERENCES "scorecards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecard_decisions" ADD CONSTRAINT "scorecard_decisions_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_reviews" ADD CONSTRAINT "gate_reviews_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_reviews" ADD CONSTRAINT "gate_reviews_bidPursuitId_fkey" FOREIGN KEY ("bidPursuitId") REFERENCES "bid_pursuits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_users" ADD CONSTRAINT "client_portal_users_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_requirements" ADD CONSTRAINT "document_requirements_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_requirements" ADD CONSTRAINT "document_requirements_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_requirements" ADD CONSTRAINT "document_requirements_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_requirements" ADD CONSTRAINT "document_requirements_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "document_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_rewards" ADD CONSTRAINT "compliance_rewards_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_logs" ADD CONSTRAINT "compliance_logs_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_documents" ADD CONSTRAINT "client_documents_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_documents" ADD CONSTRAINT "client_documents_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_templates" ADD CONSTRAINT "shared_templates_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "client_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_templates" ADD CONSTRAINT "shared_templates_submittedByFirmId_fkey" FOREIGN KEY ("submittedByFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_matrices" ADD CONSTRAINT "compliance_matrices_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_matrices" ADD CONSTRAINT "compliance_matrices_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matrix_requirements" ADD CONSTRAINT "matrix_requirements_matrixId_fkey" FOREIGN KEY ("matrixId") REFERENCES "compliance_matrices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matrix_requirements" ADD CONSTRAINT "matrix_requirements_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "opportunity_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_opportunity_declines" ADD CONSTRAINT "client_opportunity_declines_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_opportunity_declines" ADD CONSTRAINT "client_opportunity_declines_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_uploads" ADD CONSTRAINT "client_portal_uploads_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portal_uploads" ADD CONSTRAINT "client_portal_uploads_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_usage_logs" ADD CONSTRAINT "api_usage_logs_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addon_subscriptions" ADD CONSTRAINT "addon_subscriptions_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_municipal_opportunities" ADD CONSTRAINT "state_municipal_opportunities_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_opportunities" ADD CONSTRAINT "subcontract_opportunities_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_contacts" ADD CONSTRAINT "subcontract_contacts_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliverable_comments" ADD CONSTRAINT "deliverable_comments_deliverableId_fkey" FOREIGN KEY ("deliverableId") REFERENCES "client_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliverable_comments" ADD CONSTRAINT "deliverable_comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "deliverable_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_monitoring_profiles" ADD CONSTRAINT "saved_monitoring_profiles_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtest_predictions" ADD CONSTRAINT "backtest_predictions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "backtest_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beta_feedback" ADD CONSTRAINT "beta_feedback_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_sections" ADD CONSTRAINT "proposal_sections_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "proposals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_section_versions" ADD CONSTRAINT "proposal_section_versions_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_section_versions" ADD CONSTRAINT "proposal_section_versions_proposalSectionId_fkey" FOREIGN KEY ("proposalSectionId") REFERENCES "proposal_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_section_reviews" ADD CONSTRAINT "proposal_section_reviews_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_section_reviews" ADD CONSTRAINT "proposal_section_reviews_proposalSectionId_fkey" FOREIGN KEY ("proposalSectionId") REFERENCES "proposal_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_artifacts" ADD CONSTRAINT "evidence_artifacts_pastPerformanceRecordId_fkey" FOREIGN KEY ("pastPerformanceRecordId") REFERENCES "past_performance_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_evidence_links" ADD CONSTRAINT "section_evidence_links_proposalSectionId_fkey" FOREIGN KEY ("proposalSectionId") REFERENCES "proposal_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_evidence_links" ADD CONSTRAINT "section_evidence_links_evidenceArtifactId_fkey" FOREIGN KEY ("evidenceArtifactId") REFERENCES "evidence_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adherence_scores" ADD CONSTRAINT "adherence_scores_proposalSectionId_fkey" FOREIGN KEY ("proposalSectionId") REFERENCES "proposal_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "past_performance_records" ADD CONSTRAINT "past_performance_records_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capture_tasks" ADD CONSTRAINT "capture_tasks_capturePlanId_fkey" FOREIGN KEY ("capturePlanId") REFERENCES "capture_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners" ADD CONSTRAINT "partners_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teaming_arrangements" ADD CONSTRAINT "teaming_arrangements_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teaming_arrangements" ADD CONSTRAINT "teaming_arrangements_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teaming_arrangements" ADD CONSTRAINT "teaming_arrangements_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teaming_agreement_drafts" ADD CONSTRAINT "teaming_agreement_drafts_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teaming_agreement_drafts" ADD CONSTRAINT "teaming_agreement_drafts_teamingArrangementId_fkey" FOREIGN KEY ("teamingArrangementId") REFERENCES "teaming_arrangements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_attestations" ADD CONSTRAINT "proposal_attestations_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_attestations" ADD CONSTRAINT "proposal_attestations_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_reviewCycleId_fkey" FOREIGN KEY ("reviewCycleId") REFERENCES "review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beta_questionnaire_responses" ADD CONSTRAINT "beta_questionnaire_responses_questionnaireId_fkey" FOREIGN KEY ("questionnaireId") REFERENCES "beta_weekly_questionnaires"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_agreements" ADD CONSTRAINT "user_agreements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teaming_relationships" ADD CONSTRAINT "teaming_relationships_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teaming_relationships" ADD CONSTRAINT "teaming_relationships_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scw_outreach_drafts" ADD CONSTRAINT "scw_outreach_drafts_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scw_outreach_drafts" ADD CONSTRAINT "scw_outreach_drafts_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scw_outreach_drafts" ADD CONSTRAINT "scw_outreach_drafts_humanApprovedById_fkey" FOREIGN KEY ("humanApprovedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sent_notifications" ADD CONSTRAINT "sent_notifications_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sent_notifications" ADD CONSTRAINT "sent_notifications_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sent_notifications" ADD CONSTRAINT "sent_notifications_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_programCode_fkey" FOREIGN KEY ("programCode") REFERENCES "onboarding_programs"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_profiles" ADD CONSTRAINT "registration_profiles_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certifications" ADD CONSTRAINT "certifications_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_option_periods" ADD CONSTRAINT "contract_option_periods_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clins" ADD CONSTRAINT "clins_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clins" ADD CONSTRAINT "clins_parentClinId_fkey" FOREIGN KEY ("parentClinId") REFERENCES "clins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_modifications" ADD CONSTRAINT "contract_modifications_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_deliverables" ADD CONSTRAINT "contract_deliverables_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_deliverables" ADD CONSTRAINT "contract_deliverables_clinId_fkey" FOREIGN KEY ("clinId") REFERENCES "clins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_deliverables" ADD CONSTRAINT "contract_deliverables_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_transactions" ADD CONSTRAINT "funding_transactions_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_transactions" ADD CONSTRAINT "funding_transactions_clinId_fkey" FOREIGN KEY ("clinId") REFERENCES "clins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_costs" ADD CONSTRAINT "contract_costs_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_costs" ADD CONSTRAINT "contract_costs_clinId_fkey" FOREIGN KEY ("clinId") REFERENCES "clins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_labor_rates" ADD CONSTRAINT "contract_labor_rates_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_labor_rates" ADD CONSTRAINT "contract_labor_rates_clinId_fkey" FOREIGN KEY ("clinId") REFERENCES "clins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_clinId_fkey" FOREIGN KEY ("clinId") REFERENCES "clins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_invoices" ADD CONSTRAINT "contract_invoices_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_follow_ups" ADD CONSTRAINT "invoice_follow_ups_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "contract_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_invoice_line_items" ADD CONSTRAINT "contract_invoice_line_items_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "contract_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_invoice_line_items" ADD CONSTRAINT "contract_invoice_line_items_clinId_fkey" FOREIGN KEY ("clinId") REFERENCES "clins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "contract_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_scenarios" ADD CONSTRAINT "pricing_scenarios_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "pricing_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_labor_lines" ADD CONSTRAINT "pricing_labor_lines_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "pricing_scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_indirect_rates" ADD CONSTRAINT "pricing_indirect_rates_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "pricing_scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_other_costs" ADD CONSTRAINT "pricing_other_costs_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "pricing_scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_reviews" ADD CONSTRAINT "pricing_reviews_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "pricing_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_checklist_items" ADD CONSTRAINT "submission_checklist_items_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "proposal_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_status_history" ADD CONSTRAINT "submission_status_history_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "proposal_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "past_performance_attachments" ADD CONSTRAINT "past_performance_attachments_pastPerformanceRecordId_fkey" FOREIGN KEY ("pastPerformanceRecordId") REFERENCES "past_performance_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "past_performance_selections" ADD CONSTRAINT "past_performance_selections_pastPerformanceRecordId_fkey" FOREIGN KEY ("pastPerformanceRecordId") REFERENCES "past_performance_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_source_configs" ADD CONSTRAINT "opportunity_source_configs_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_sync_runs" ADD CONSTRAINT "source_sync_runs_sourceConfigId_fkey" FOREIGN KEY ("sourceConfigId") REFERENCES "opportunity_source_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agency_forecasts" ADD CONSTRAINT "agency_forecasts_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agency_forecasts" ADD CONSTRAINT "agency_forecasts_sourceConfigId_fkey" FOREIGN KEY ("sourceConfigId") REFERENCES "opportunity_source_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agency_forecasts" ADD CONSTRAINT "agency_forecasts_linkedOpportunityId_fkey" FOREIGN KEY ("linkedOpportunityId") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agency_forecast_versions" ADD CONSTRAINT "agency_forecast_versions_forecastId_fkey" FOREIGN KEY ("forecastId") REFERENCES "agency_forecasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recompete_signals" ADD CONSTRAINT "recompete_signals_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "firm_capabilities" ADD CONSTRAINT "firm_capabilities_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_matches" ADD CONSTRAINT "opportunity_matches_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitoring_profile_alerts" ADD CONSTRAINT "monitoring_profile_alerts_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "saved_monitoring_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_calibrations" ADD CONSTRAINT "tenant_calibrations_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calibration_samples" ADD CONSTRAINT "calibration_samples_calibrationId_fkey" FOREIGN KEY ("calibrationId") REFERENCES "tenant_calibrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incumbent_retention_stats" ADD CONSTRAINT "incumbent_retention_stats_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_award_stats" ADD CONSTRAINT "competitor_award_stats_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_sensitivity_analyses" ADD CONSTRAINT "pricing_sensitivity_analyses_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capability_gap_assessments" ADD CONSTRAINT "capability_gap_assessments_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitation_extraction_jobs" ADD CONSTRAINT "solicitation_extraction_jobs_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_lm_mappings" ADD CONSTRAINT "section_lm_mappings_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clause_obligations" ADD CONSTRAINT "clause_obligations_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clause_obligation_events" ADD CONSTRAINT "clause_obligation_events_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "clause_obligations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standing_documents" ADD CONSTRAINT "standing_documents_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standing_document_versions" ADD CONSTRAINT "standing_document_versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "standing_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standing_document_links" ADD CONSTRAINT "standing_document_links_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "standing_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_validation_checks" ADD CONSTRAINT "submission_validation_checks_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "proposal_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matrix_requirement_events" ADD CONSTRAINT "matrix_requirement_events_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "matrix_requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_milestones" ADD CONSTRAINT "opportunity_milestones_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestone_events" ADD CONSTRAINT "milestone_events_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "opportunity_milestones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestone_reminder_logs" ADD CONSTRAINT "milestone_reminder_logs_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "opportunity_milestones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amendment_revisions" ADD CONSTRAINT "amendment_revisions_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amendment_impacts" ADD CONSTRAINT "amendment_impacts_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "amendment_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "schedule_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "agent_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "agent_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_artifacts" ADD CONSTRAINT "agent_artifacts_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_escalations" ADD CONSTRAINT "agent_escalations_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_escalations" ADD CONSTRAINT "agent_escalations_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_notification_preferences" ADD CONSTRAINT "agent_notification_preferences_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_notification_preferences" ADD CONSTRAINT "agent_notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pursuit_feedback_signals" ADD CONSTRAINT "pursuit_feedback_signals_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pursuit_feedback_signals" ADD CONSTRAINT "pursuit_feedback_signals_appliedByUserId_fkey" FOREIGN KEY ("appliedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pursuit_feedback_signals" ADD CONSTRAINT "pursuit_feedback_signals_revertedByUserId_fkey" FOREIGN KEY ("revertedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonding_capacities" ADD CONSTRAINT "bonding_capacities_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonding_capacities" ADD CONSTRAINT "bonding_capacities_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonding_capacities" ADD CONSTRAINT "bonding_capacities_verifiedByUserId_fkey" FOREIGN KEY ("verifiedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_recommendations" ADD CONSTRAINT "qualification_recommendations_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_recommendations" ADD CONSTRAINT "qualification_recommendations_pursuitId_fkey" FOREIGN KEY ("pursuitId") REFERENCES "bid_pursuits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_recommendations" ADD CONSTRAINT "qualification_recommendations_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_recommendations" ADD CONSTRAINT "qualification_recommendations_rejectedByUserId_fkey" FOREIGN KEY ("rejectedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_performance_records" ADD CONSTRAINT "partner_performance_records_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_performance_records" ADD CONSTRAINT "partner_performance_records_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontracting_goals" ADD CONSTRAINT "subcontracting_goals_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontracting_goal_progress" ADD CONSTRAINT "subcontracting_goal_progress_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontracting_goal_progress" ADD CONSTRAINT "subcontracting_goal_progress_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "subcontracting_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "award_benchmark_cohorts" ADD CONSTRAINT "award_benchmark_cohorts_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capability_narratives" ADD CONSTRAINT "capability_narratives_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capability_narrative_versions" ADD CONSTRAINT "capability_narrative_versions_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capability_narrative_versions" ADD CONSTRAINT "capability_narrative_versions_capabilityNarrativeId_fkey" FOREIGN KEY ("capabilityNarrativeId") REFERENCES "capability_narratives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actual_indirect_rates" ADD CONSTRAINT "actual_indirect_rates_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dcaa_readiness_checks" ADD CONSTRAINT "dcaa_readiness_checks_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_flow_projections" ADD CONSTRAINT "cash_flow_projections_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "win_loss_segments" ADD CONSTRAINT "win_loss_segments_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capture_recommendations" ADD CONSTRAINT "capture_recommendations_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agency_offices" ADD CONSTRAINT "agency_offices_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "government_contacts" ADD CONSTRAINT "government_contacts_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "government_contacts" ADD CONSTRAINT "government_contacts_agencyOfficeId_fkey" FOREIGN KEY ("agencyOfficeId") REFERENCES "agency_offices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "government_contacts" ADD CONSTRAINT "government_contacts_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_contacts" ADD CONSTRAINT "partner_contacts_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_contacts" ADD CONSTRAINT "partner_contacts_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_governmentContactId_fkey" FOREIGN KEY ("governmentContactId") REFERENCES "government_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_agencyOfficeId_fkey" FOREIGN KEY ("agencyOfficeId") REFERENCES "agency_offices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_bidPursuitId_fkey" FOREIGN KEY ("bidPursuitId") REFERENCES "bid_pursuits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_partnerContactId_fkey" FOREIGN KEY ("partnerContactId") REFERENCES "partner_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_follow_ups" ADD CONSTRAINT "crm_follow_ups_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_follow_ups" ADD CONSTRAINT "crm_follow_ups_governmentContactId_fkey" FOREIGN KEY ("governmentContactId") REFERENCES "government_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_follow_ups" ADD CONSTRAINT "crm_follow_ups_partnerContactId_fkey" FOREIGN KEY ("partnerContactId") REFERENCES "partner_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_follow_ups" ADD CONSTRAINT "crm_follow_ups_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_follow_ups" ADD CONSTRAINT "crm_follow_ups_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_follow_ups" ADD CONSTRAINT "crm_follow_ups_bidPursuitId_fkey" FOREIGN KEY ("bidPursuitId") REFERENCES "bid_pursuits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_follow_ups" ADD CONSTRAINT "crm_follow_ups_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "crm_activities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_follow_ups" ADD CONSTRAINT "crm_follow_ups_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_budgets" ADD CONSTRAINT "contract_budgets_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_budgets" ADD CONSTRAINT "contract_budgets_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_budget_lines" ADD CONSTRAINT "contract_budget_lines_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "contract_budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_budget_lines" ADD CONSTRAINT "contract_budget_lines_clinId_fkey" FOREIGN KEY ("clinId") REFERENCES "clins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_clinId_fkey" FOREIGN KEY ("clinId") REFERENCES "clins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_personnelId_fkey" FOREIGN KEY ("personnelId") REFERENCES "personnel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_clinId_fkey" FOREIGN KEY ("clinId") REFERENCES "clins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_clinId_fkey" FOREIGN KEY ("clinId") REFERENCES "clins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_invoices" ADD CONSTRAINT "subcontract_invoices_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_invoices" ADD CONSTRAINT "subcontract_invoices_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_invoices" ADD CONSTRAINT "subcontract_invoices_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_invoice_lines" ADD CONSTRAINT "subcontract_invoice_lines_subcontractInvoiceId_fkey" FOREIGN KEY ("subcontractInvoiceId") REFERENCES "subcontract_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_invoice_lines" ADD CONSTRAINT "subcontract_invoice_lines_clinId_fkey" FOREIGN KEY ("clinId") REFERENCES "clins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_flow_downs" ADD CONSTRAINT "subcontract_flow_downs_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_flow_downs" ADD CONSTRAINT "subcontract_flow_downs_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_flow_downs" ADD CONSTRAINT "subcontract_flow_downs_clauseObligationId_fkey" FOREIGN KEY ("clauseObligationId") REFERENCES "clause_obligations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personnel" ADD CONSTRAINT "personnel_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personnel" ADD CONSTRAINT "personnel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personnel" ADD CONSTRAINT "personnel_sourcePartnerId_fkey" FOREIGN KEY ("sourcePartnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personnel_labor_qualifications" ADD CONSTRAINT "personnel_labor_qualifications_personnelId_fkey" FOREIGN KEY ("personnelId") REFERENCES "personnel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personnel_resumes" ADD CONSTRAINT "personnel_resumes_personnelId_fkey" FOREIGN KEY ("personnelId") REFERENCES "personnel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_key_personnel" ADD CONSTRAINT "proposal_key_personnel_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_key_personnel" ADD CONSTRAINT "proposal_key_personnel_personnelId_fkey" FOREIGN KEY ("personnelId") REFERENCES "personnel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_key_personnel" ADD CONSTRAINT "proposal_key_personnel_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "personnel_resumes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_portal_users" ADD CONSTRAINT "partner_portal_users_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_portal_users" ADD CONSTRAINT "partner_portal_users_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_portal_users" ADD CONSTRAINT "partner_portal_users_partnerContactId_fkey" FOREIGN KEY ("partnerContactId") REFERENCES "partner_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_engagement_access" ADD CONSTRAINT "partner_engagement_access_partnerPortalUserId_fkey" FOREIGN KEY ("partnerPortalUserId") REFERENCES "partner_portal_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_portal_uploads" ADD CONSTRAINT "partner_portal_uploads_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_portal_uploads" ADD CONSTRAINT "partner_portal_uploads_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_portal_uploads" ADD CONSTRAINT "partner_portal_uploads_partnerPortalUserId_fkey" FOREIGN KEY ("partnerPortalUserId") REFERENCES "partner_portal_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_personnel_submissions" ADD CONSTRAINT "partner_personnel_submissions_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_personnel_submissions" ADD CONSTRAINT "partner_personnel_submissions_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_personnel_submissions" ADD CONSTRAINT "partner_personnel_submissions_partnerPortalUserId_fkey" FOREIGN KEY ("partnerPortalUserId") REFERENCES "partner_portal_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_portal_password_resets" ADD CONSTRAINT "partner_portal_password_resets_partnerPortalUserId_fkey" FOREIGN KEY ("partnerPortalUserId") REFERENCES "partner_portal_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_deliverable_submissions" ADD CONSTRAINT "partner_deliverable_submissions_deliverableId_fkey" FOREIGN KEY ("deliverableId") REFERENCES "contract_deliverables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_deliverable_submissions" ADD CONSTRAINT "partner_deliverable_submissions_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_deliverable_submissions" ADD CONSTRAINT "partner_deliverable_submissions_partnerPortalUserId_fkey" FOREIGN KEY ("partnerPortalUserId") REFERENCES "partner_portal_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_profile_change_requests" ADD CONSTRAINT "partner_profile_change_requests_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_profile_change_requests" ADD CONSTRAINT "partner_profile_change_requests_partnerPortalUserId_fkey" FOREIGN KEY ("partnerPortalUserId") REFERENCES "partner_portal_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_sync_records" ADD CONSTRAINT "integration_sync_records_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_signers" ADD CONSTRAINT "signature_signers_signatureRequestId_fkey" FOREIGN KEY ("signatureRequestId") REFERENCES "signature_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "firm_sso_configs" ADD CONSTRAINT "firm_sso_configs_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_ssoConfigId_fkey" FOREIGN KEY ("ssoConfigId") REFERENCES "firm_sso_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

