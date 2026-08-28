# GB-106 Data Sources and Verification Trail

Verification pass date: 2026-06-06. Every program record in `onboarding.seed.ts`
carries its `verificationStatus`, `lastVerifiedAt`, and `sourceUrls`. This file
is the human-readable trail behind those fields.

The integrity rule for this module: no federal date or status is invented. When
a registration window or intake status cannot be confirmed against a primary
source, the record is marked `NEEDS_VERIFICATION`, the date fields are left
null, and the freshness job keeps surfacing it until a human confirms it.

## Verification status summary

| Program | Status | Why |
|---|---|---|
| SAM.gov / UEI / CAGE | VERIFIED | Process, fees, and timelines confirmed against SAM.gov. |
| SBA VetCert SDVOSB | VERIFIED | Mandate, ownership rules, and portal confirmed against SBA. |
| GSA MAS | VERIFIED | Intake model and current sales thresholds confirmed against GSA. See conflict note below. |
| OASIS+ Phase II | VERIFIED | Continuous open status since 2026-01-12 confirmed against GSA. |
| TMSS 2.0 | NEEDS_VERIFICATION | Requirements verified, but the next broker registration window date is unconfirmed. |
| Polaris SDVOSB pool | NEEDS_VERIFICATION | IT vehicle in phased award from a closed solicitation, no confirmed open intake for new entrants. |

## SPEC CONFLICT, action required (GSA MAS minimum sales)

The stored GB-106 spec carries a "GSA MAS $25,000 Year 1 threshold rule" (Year 1
grace period, then $25,000 per year). Live GSA data shows this is the pre-2024
rule and has been superseded.

- Current verified rule: $100,000 in total schedule sales during the first
  five-year period, then $125,000 during each subsequent five-year period.
- The seed (`GSA_MAS.notes`) carries the current figures with the supersession
  noted. The legacy $25,000 figure is NOT written into the module.
- Recommended follow-up: update the stored memory rule so downstream proposals
  and advice stop citing the $25,000 per-year figure. This is a business
  decision left to you, the module itself is internally consistent and current.

## Source URLs by program

### Tier 0, Foundational
- SAM.gov entity registration: https://sam.gov/entity-registration
- CAGE (DLA): https://cage.dla.mil/

### Tier 1, Certification
- SBA VetCert portal: https://veterans.certify.sba.gov/
- SBA veteran contracting assistance: https://www.sba.gov/federal-contracting/contracting-assistance-programs/veteran-contracting-assistance-programs

### Tier 2, Vehicles
- GSA TMSS 2.0: https://www.gsa.gov/buy-through-us/products-and-services/transportation-and-logistics-services/transportation-programs/tmss-20
- GSA Freight Management Program: https://www.gsa.gov/buy-through-us/products-and-services/transportation-and-logistics-services/transportation-programs/freight-management-program
- TMSS 2.0 portal: https://tmss.gsa.gov/tmss/signon
- GSA MAS: https://www.gsa.gov/buy-through-us/purchasing-programs/multiple-award-schedule
- GSA MAS roadmap (new offerors): https://www.gsa.gov/sell-to-government/step-1-learn-about-government-contracting/how-to-access-contract-opportunities/help-with-mas-contracts-to-sell-to-government/roadmap-to-get-a-mas-contract
- OASIS+: https://www.gsa.gov/buy-through-us/products-and-services/professional-services/buy-services/oasis-plus
- OASIS+ continuously open solicitations: https://www.gsa.gov/buy-through-us/products-and-services/professional-services/buy-services/oasis-plus/sellers-guide/solicitations-continuously-open
- Polaris GWAC: https://www.gsa.gov/technology/it-contract-vehicles-and-purchasing-programs/governmentwide-acquisition-contracts-gwacs/polaris

## Key verified facts captured in the seed

- SAM.gov registration is free, uses Login.gov, issues the 12-character UEI
  (replaced DUNS in April 2022), triggers automatic DLA CAGE assignment in
  roughly 3 to 5 business days, activates in roughly 7 to 15 business days, and
  renews every 365 days.
- SBA VetCert SDVOSB: 51 percent unconditional direct ownership and control by
  one or more service-disabled veterans, valid three years, self-certification
  eliminated 2024-12-22, SDVOSB federal goal raised to 5 percent under NDAA
  FY2024.
- TMSS 2.0 TSP entry requires SAM.gov registration with SCAC linked, proof of
  $150,000 cargo insurance, agreement to the Freight Management Program Standard
  Tender of Service, and rate filing in TMSS 2.0. The standing requirements are
  stable, only the next broker registration window date is unconfirmed. The last
  documented broker window (1 May to 15 June 2025) has passed. Confirm the next
  window via Transportation.Programs@gsa.gov before quoting a date.
- OASIS+ Phase II: all six solicitations continuously open since 2026-01-12,
  13 domains, rolling awards, submission via the Symphony Procurement Suite.
- Polaris GWAC SDVOSB pool: IT and emerging-technology scope, solicitation
  47QTCB22R0007, currently in phased awards from a closed solicitation. Out of
  domain for a freight brokerage.

## Re-verification cadence

The freshness job (`onboarding.freshness.job.ts`) flags any record older than
its max-age threshold (default 30 days) or marked `NEEDS_VERIFICATION`. Re-run
the verification pass on flagged records, update `lastVerifiedAt` and the date
fields in the seed, then re-seed with `seed.gb106.ts`.
