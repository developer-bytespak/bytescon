/**
 * GB-106 seed dataset, federal platforms and vehicles.
 *
 * INTEGRITY RULE: every record carries its primary source URL(s) and a
 * verificationStatus. Records whose registration timing could not be confirmed
 * against a primary federal source are marked NEEDS_VERIFICATION with the date
 * fields left null. No date or status in this file may be invented. When a
 * window or status cannot be confirmed, the honest value is null + NEEDS_VERIFICATION,
 * and the freshness job will keep surfacing it until a human confirms it.
 *
 * Verification pass date: 2026-06-06. See DATA_SOURCES.md for the full citation list.
 */

import {
  OnboardingProgram,
  OnboardingTier,
  ProgramCategory,
  RegistrationModel,
  VerificationStatus,
} from '../types/onboarding.types';

const VERIFIED_ON = '2026-06-06';

export const ONBOARDING_PROGRAMS: OnboardingProgram[] = [
  // ---- TIER 0, FOUNDATIONAL --------------------------------------------------
  {
    code: 'SAM_REG',
    name: 'SAM.gov Entity Registration',
    shortName: 'SAM.gov',
    tier: OnboardingTier.Foundational,
    category: ProgramCategory.Foundational,
    administeringAgency: 'GSA (System for Award Management)',
    description:
      'Full entity registration in SAM.gov, the gateway record every federal buyer and payment system reads. Issues the UEI and triggers automatic CAGE assignment. Required before any vehicle, certification, or award.',
    officialUrl: 'https://sam.gov/entity-registration',
    prerequisites: [],
    keyRequirements: [
      'Login.gov account with multi-factor authentication',
      'Legal business name and address matching IRS records exactly',
      'EIN/TIN (validated against IRS)',
      'Banking information for electronic funds transfer',
      'Government and electronic business points of contact',
    ],
    relevanceTags: ['foundational', 'all', 'prerequisite'],
    coreFor: [],
    registrationModel: RegistrationModel.Application,
    nextWindowOpensAt: null, // Open continuously, no window.
    nextWindowClosesAt: null,
    verificationStatus: VerificationStatus.Verified,
    lastVerifiedAt: VERIFIED_ON,
    sourceUrls: ['https://sam.gov/entity-registration'],
    notes:
      'Free. Activation typically 7 to 15 business days after submission. Renew every 365 days. Beware third parties charging fees for a free process.',
  },
  {
    code: 'UEI',
    name: 'Unique Entity Identifier',
    shortName: 'UEI',
    tier: OnboardingTier.Foundational,
    category: ProgramCategory.Foundational,
    administeringAgency: 'GSA (SAM.gov)',
    description:
      'Twelve-character identifier assigned during SAM.gov entity validation. Replaced the DUNS number in April 2022. Not obtained separately and never through a paid third party.',
    officialUrl: 'https://sam.gov/entity-registration',
    prerequisites: [],
    keyRequirements: ['Generated automatically during SAM.gov entity validation'],
    relevanceTags: ['foundational', 'all', 'prerequisite'],
    coreFor: [],
    registrationModel: RegistrationModel.Application,
    nextWindowOpensAt: null,
    nextWindowClosesAt: null,
    verificationStatus: VerificationStatus.Verified,
    lastVerifiedAt: VERIFIED_ON,
    sourceUrls: ['https://sam.gov/entity-registration'],
    notes: 'Tracked as a distinct step for client clarity, but issued inside the SAM_REG flow.',
  },
  {
    code: 'CAGE',
    name: 'Commercial and Government Entity (CAGE) Code',
    shortName: 'CAGE',
    tier: OnboardingTier.Foundational,
    category: ProgramCategory.Foundational,
    administeringAgency: 'Defense Logistics Agency (DLA)',
    description:
      'Five-character facility identifier used by DoD and NATO. Assigned automatically by DLA during SAM.gov registration if the entity does not already hold one.',
    officialUrl: 'https://cage.dla.mil/',
    prerequisites: ['SAM_REG'],
    keyRequirements: ['Assigned automatically during SAM.gov validation, typically 3 to 5 business days'],
    relevanceTags: ['foundational', 'all', 'dod', 'prerequisite'],
    coreFor: [],
    registrationModel: RegistrationModel.Application,
    nextWindowOpensAt: null,
    nextWindowClosesAt: null,
    verificationStatus: VerificationStatus.Verified,
    lastVerifiedAt: VERIFIED_ON,
    sourceUrls: ['https://sam.gov/entity-registration', 'https://cage.dla.mil/'],
    notes: 'No separate application needed for domestic entities registering in SAM.gov.',
  },

  // ---- TIER 1, CERTIFICATION -------------------------------------------------
  {
    code: 'SBA_VETCERT',
    name: 'SBA Veteran Small Business Certification (SDVOSB)',
    shortName: 'SBA VetCert SDVOSB',
    tier: OnboardingTier.Certification,
    category: ProgramCategory.Certification,
    administeringAgency: 'Small Business Administration (SBA)',
    description:
      'Federal SDVOSB certification through SBA VetCert. Unlocks sole-source and set-aside contracts across all federal agencies. Since 22 December 2024, self-certification no longer counts toward agency or prime subcontracting goals, so certification is mandatory to claim SDVOSB status.',
    officialUrl: 'https://veterans.certify.sba.gov/',
    prerequisites: ['SAM_REG'],
    keyRequirements: [
      'At least 51 percent unconditional, direct ownership by one or more service-disabled veterans',
      'Service-disabled veteran holds the highest officer position and controls daily operations',
      'Active SAM.gov registration and SBA size standard met for at least one NAICS code',
      'Supporting documents: DD-214, VA disability rating letter, ownership and operating agreements',
    ],
    relevanceTags: ['sdvosb', 'certification', 'set_aside', 'veteran', 'all'],
    coreFor: [],
    registrationModel: RegistrationModel.Application,
    nextWindowOpensAt: null,
    nextWindowClosesAt: null,
    verificationStatus: VerificationStatus.Verified,
    lastVerifiedAt: VERIFIED_ON,
    sourceUrls: [
      'https://veterans.certify.sba.gov/',
      'https://www.sba.gov/federal-contracting/contracting-assistance-programs/veteran-contracting-assistance-programs',
    ],
    notes:
      'Certification valid three years. VA SDVOSB/VOSB programs moved to SBA on 1 January 2023. Federal SDVOSB prime and subcontract goal raised to 5 percent under NDAA FY2024.',
  },

  // ---- TIER 2, VEHICLES ------------------------------------------------------
  {
    code: 'TMSS_2_0',
    name: 'GSA Transportation Management Services Solution (TMSS) 2.0 / Freight Management Program',
    shortName: 'TMSS 2.0',
    tier: OnboardingTier.Vehicle,
    category: ProgramCategory.Vehicle,
    administeringAgency: 'GSA Center for Transportation Management',
    description:
      'GSA freight execution and planning platform for federal freight shipping. Open to Transportation Service Providers, including brokers, via the Freight Management Program Standard Tender of Service. No FAR contract award is required, entry is by meeting the Standard Tender of Service requirements and filing rates. The most directly relevant federal channel for transportation and logistics clients.',
    officialUrl:
      'https://www.gsa.gov/buy-through-us/products-and-services/transportation-and-logistics-services/transportation-programs/tmss-20',
    prerequisites: ['SAM_REG'],
    keyRequirements: [
      'Active SAM.gov registration with SCAC linked to the profile',
      'Proof of cargo insurance, $150,000 minimum',
      'Agreement to the GSA Freight Management Program Standard Tender of Service (non-negotiable terms)',
      'File rates in TMSS 2.0 during the applicable filing period',
    ],
    relevanceTags: ['freight', 'logistics', 'transportation', 'broker', 'tsp', 'scac'],
    coreFor: ['freight_brokerage', 'logistics'],
    registrationModel: RegistrationModel.Windowed,
    // The only documented broker open-registration window (1 May to 15 June 2025) has passed.
    // The next 2026 window timing is NOT confirmed against a primary source, so dates are null.
    nextWindowOpensAt: null,
    nextWindowClosesAt: null,
    verificationStatus: VerificationStatus.NeedsVerification,
    lastVerifiedAt: VERIFIED_ON,
    sourceUrls: [
      'https://www.gsa.gov/buy-through-us/products-and-services/transportation-and-logistics-services/transportation-programs/tmss-20',
      'https://www.gsa.gov/buy-through-us/products-and-services/transportation-and-logistics-services/transportation-programs/freight-management-program',
      'https://tmss.gsa.gov/tmss/signon',
    ],
    notes:
      'Program requirements are VERIFIED and stable. The next broker registration window date is NEEDS_VERIFICATION, confirm via Transportation.Programs@gsa.gov before advising a client of a date. Designated OMB Tier 2 Category Management solution.',
  },
  {
    code: 'GSA_MAS',
    name: 'GSA Multiple Award Schedule (MAS)',
    shortName: 'GSA MAS',
    tier: OnboardingTier.Vehicle,
    category: ProgramCategory.Vehicle,
    administeringAgency: 'GSA Federal Acquisition Service',
    description:
      'The consolidated federal commercial schedule. Includes a Transportation and Logistics Services category relevant to transportation and logistics clients. New offerors submit a single offer via GSA eOffer against the active MAS solicitation.',
    officialUrl: 'https://www.gsa.gov/buy-through-us/purchasing-programs/multiple-award-schedule',
    prerequisites: ['SAM_REG'],
    keyRequirements: [
      'Minimum two years in business',
      'Documented past performance and financial stability',
      'Commercial pricing history (Commercial Sales Practices disclosure)',
      'Adequate accounting system',
      'Offer submitted through GSA eOffer against solicitation 47QSMD20R0001',
    ],
    relevanceTags: ['vehicle', 'logistics', 'transportation', 'products', 'professional_services', 'all'],
    coreFor: [],
    registrationModel: RegistrationModel.Continuous,
    nextWindowOpensAt: null, // Continuously open intake.
    nextWindowClosesAt: null,
    verificationStatus: VerificationStatus.Verified,
    lastVerifiedAt: VERIFIED_ON,
    sourceUrls: [
      'https://www.gsa.gov/buy-through-us/purchasing-programs/multiple-award-schedule',
      'https://www.gsa.gov/sell-to-government/step-1-learn-about-government-contracting/how-to-access-contract-opportunities/help-with-mas-contracts-to-sell-to-government/roadmap-to-get-a-mas-contract',
    ],
    notes:
      'MINIMUM SALES (current, verified): $100,000 in total schedule sales during the first five-year period, then $125,000 during each subsequent five-year period. This SUPERSEDES the legacy "$25,000 per year" figure stored in the GB-106 spec, which was the pre-2024 rule. Application cycle typically 6 to 12 months. IFF and sales reported via the Sales Reporting Portal.',
  },
  {
    code: 'OASIS_PLUS',
    name: 'OASIS+ (One Acquisition Solution for Integrated Services Plus), Phase II',
    shortName: 'OASIS+',
    tier: OnboardingTier.Vehicle,
    category: ProgramCategory.Vehicle,
    administeringAgency: 'GSA',
    description:
      'Governmentwide professional services contract, now a continuously open on-ramp across 13 domains with a small business set-aside track. Best fit for professional and management services rather than freight execution work.',
    officialUrl: 'https://www.gsa.gov/buy-through-us/products-and-services/professional-services/buy-services/oasis-plus',
    prerequisites: ['SAM_REG'],
    keyRequirements: [
      'Qualifying past performance mapped to a target domain self-scoring matrix',
      'Proposal submitted via the Symphony Procurement Suite (OASIS+ Submission Portal)',
      'Meet the objective qualification thresholds for the chosen domain',
    ],
    relevanceTags: ['vehicle', 'professional_services', 'services', 'small_business'],
    coreFor: [],
    registrationModel: RegistrationModel.Continuous,
    nextWindowOpensAt: null, // Continuously open since 12 Jan 2026.
    nextWindowClosesAt: null,
    verificationStatus: VerificationStatus.Verified,
    lastVerifiedAt: VERIFIED_ON,
    sourceUrls: [
      'https://www.gsa.gov/buy-through-us/products-and-services/professional-services/buy-services/oasis-plus',
      'https://www.gsa.gov/buy-through-us/products-and-services/professional-services/buy-services/oasis-plus/sellers-guide/solicitations-continuously-open',
    ],
    notes:
      'All six solicitations continuously open since 12 January 2026, rolling awards. Primarily a professional services vehicle; limited relevance for freight-execution clients.',
  },
  {
    code: 'POLARIS_SDVOSB',
    name: 'GSA Polaris GWAC, SDVOSB Pool',
    shortName: 'Polaris SDVOSB',
    tier: OnboardingTier.Vehicle,
    category: ProgramCategory.Vehicle,
    administeringAgency: 'GSA',
    description:
      'Governmentwide acquisition contract for IT products and services and emerging technology, with a dedicated SDVOSB pool. Out of domain for transportation clients and currently in phased award from a closed solicitation rather than open intake.',
    officialUrl: 'https://www.gsa.gov/technology/it-contract-vehicles-and-purchasing-programs/governmentwide-acquisition-contracts-gwacs/polaris',
    prerequisites: ['SAM_REG', 'SBA_VETCERT'],
    keyRequirements: [
      'SDVOSB status (SBA VetCert)',
      'IT and emerging-technology past performance relevant to the Polaris scope',
      'Submission against the SDVOSB pool solicitation 47QTCB22R0007 when open',
    ],
    relevanceTags: ['vehicle', 'it', 'emerging_tech', 'sdvosb', 'software'],
    coreFor: [],
    registrationModel: RegistrationModel.Phased,
    // Original 2022 solicitation closed. Awards proceeding in phases. No confirmed open on-ramp for new entrants.
    nextWindowOpensAt: null,
    nextWindowClosesAt: null,
    verificationStatus: VerificationStatus.NeedsVerification,
    lastVerifiedAt: VERIFIED_ON,
    sourceUrls: [
      'https://www.gsa.gov/technology/it-contract-vehicles-and-purchasing-programs/governmentwide-acquisition-contracts-gwacs/polaris',
    ],
    notes:
      'IT-focused; not a fit for transportation clients. SDVOSB pool (solicitation 47QTCB22R0007) is in phased awards from a closed solicitation, no confirmed open on-ramp for new offerors. Re-verify before advising entry.',
  },
];

/** Convenience map for prerequisite resolution and lookups. */
export const PROGRAM_BY_CODE: Readonly<Record<string, OnboardingProgram>> = Object.freeze(
  ONBOARDING_PROGRAMS.reduce<Record<string, OnboardingProgram>>((acc, p) => {
    acc[p.code] = p;
    return acc;
  }, {})
);
