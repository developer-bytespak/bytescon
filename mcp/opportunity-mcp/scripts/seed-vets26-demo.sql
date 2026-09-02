-- VETS26 demo opportunities (2026-05-25).
--
-- Seeds 8 opportunities under Bytes Platform (consultingFirmId
-- be68e12e-...) so search_opportunities returns realistic results
-- during the VETS26 demo. Idempotent: deterministic ids +
-- ON CONFLICT DO NOTHING.
--
-- Usage:
--   docker exec -i bytescon_postgres psql -U bytescon_user -d bytescon_platform \
--     < mcp/opportunity-mcp/scripts/seed-vets26-demo.sql

INSERT INTO opportunities (
  id, "consultingFirmId", title, agency, "naicsCode", "setAsideType",
  "marketCategory", "postedDate", "responseDeadline", description,
  "sourceUrl", "probabilityScore", "isScored", status, "isEnriched",
  "recompeteFlag", "incumbentSignalDetected", "createdAt", "updatedAt"
) VALUES
  ('demo-vets26-001', 'be68e12e-c855-49ba-9f65-5a25f1d9e69b',
   'Telehealth Platform Modernization Support Services',
   'Department of Veterans Affairs', '541512', 'SDVOSB', 'SERVICES',
   '2026-05-20 09:00:00', '2026-06-12 17:00:00',
   'VHA seeks SDVOSB partner to modernize the My HealtheVet telehealth stack, including video infrastructure, scheduling integration, and Section 508 accessibility uplift. Period of performance 12 months with two 12-month options.',
   'https://sam.gov/opp/demo-vets26-001/view', 0.78, true, 'ACTIVE', true,
   false, false, NOW(), NOW()),

  ('demo-vets26-002', 'be68e12e-c855-49ba-9f65-5a25f1d9e69b',
   'Cybersecurity Risk Assessment for VHA Regional Networks',
   'Department of Veterans Affairs', '541512', 'SDVOSB', 'SERVICES',
   '2026-05-20 09:00:00', '2026-06-20 17:00:00',
   'Conduct NIST 800-53 Rev 5 risk assessments across four VISN regional networks. Deliverables include POA&M, executive briefings, and remediation roadmap aligned to OMB M-22-09 zero-trust milestones.',
   'https://sam.gov/opp/demo-vets26-002/view', 0.71, true, 'ACTIVE', true,
   false, false, NOW(), NOW()),

  ('demo-vets26-003', 'be68e12e-c855-49ba-9f65-5a25f1d9e69b',
   'Logistics Readiness Program Management Office Support',
   'Department of the Army', '541611', 'SDVOSB', 'SERVICES',
   '2026-05-20 09:00:00', '2026-07-08 17:00:00',
   'Army G-4 requires PMO support for Logistics Readiness modernization initiatives across CONUS installations. Scope: schedule integration, risk management, IMS maintenance, stakeholder reporting.',
   'https://sam.gov/opp/demo-vets26-003/view', 0.64, true, 'ACTIVE', true,
   false, false, NOW(), NOW()),

  ('demo-vets26-004', 'be68e12e-c855-49ba-9f65-5a25f1d9e69b',
   'Naval Aviation Maintenance Data Analytics Services',
   'Department of the Navy', '541330', 'NONE', 'SERVICES',
   '2026-05-20 09:00:00', '2026-07-15 17:00:00',
   'NAVAIR seeks data engineering and predictive maintenance analytics support for F/A-18 and E-2D fleet sustainment. Requires DoD SECRET clearance and Palantir Foundry experience.',
   'https://sam.gov/opp/demo-vets26-004/view', 0.55, true, 'ACTIVE', true,
   false, false, NOW(), NOW()),

  ('demo-vets26-005', 'be68e12e-c855-49ba-9f65-5a25f1d9e69b',
   'CMMC Level 2 Compliance Advisory for DAF Suppliers',
   'Department of the Air Force', '541512', 'SDVOSB', 'SERVICES',
   '2026-05-20 09:00:00', '2026-07-22 17:00:00',
   'Air Force Sustainment Center seeks advisory services to guide a portfolio of 40+ supplier SMBs through CMMC Level 2 certification. Includes gap assessments, SSP authoring, and pre-assessment coaching.',
   'https://sam.gov/opp/demo-vets26-005/view', 0.73, true, 'ACTIVE', true,
   false, false, NOW(), NOW()),

  ('demo-vets26-006', 'be68e12e-c855-49ba-9f65-5a25f1d9e69b',
   'Behavioral Health Care Coordination Training Curriculum',
   'Defense Health Agency', '611430', 'WOSB', 'SERVICES',
   '2026-05-20 09:00:00', '2026-08-05 17:00:00',
   'DHA seeks WOSB partner to design and deliver care-coordinator training across MTFs. Curriculum spans trauma-informed care, suicide-risk screening, and PHR documentation standards.',
   'https://sam.gov/opp/demo-vets26-006/view', 0.61, true, 'ACTIVE', true,
   false, false, NOW(), NOW()),

  ('demo-vets26-007', 'be68e12e-c855-49ba-9f65-5a25f1d9e69b',
   'TSA Workforce Analytics and Reporting Platform',
   'Department of Homeland Security', '541618', 'NONE', 'SERVICES',
   '2026-05-20 09:00:00', '2026-08-19 17:00:00',
   'TSA Office of Human Capital seeks a managed analytics platform for screener workforce metrics including attrition forecasting, schedule adherence, and EEO reporting dashboards.',
   'https://sam.gov/opp/demo-vets26-007/view', 0.49, true, 'ACTIVE', true,
   false, false, NOW(), NOW()),

  ('demo-vets26-008', 'be68e12e-c855-49ba-9f65-5a25f1d9e69b',
   'OASIS+ Task Order Capture Strategy Consulting',
   'General Services Administration', '541611', 'SBA_8A', 'SERVICES',
   '2026-05-20 09:00:00', '2026-09-03 17:00:00',
   'GSA OASIS+ program office seeks 8(a) advisory support to coach SMB primes on task-order capture, including agency outreach, teaming strategy, and pricing optimization for FY26 fiscal-year close.',
   'https://sam.gov/opp/demo-vets26-008/view', 0.58, true, 'ACTIVE', true,
   false, false, NOW(), NOW())

ON CONFLICT (id) DO NOTHING;

SELECT id, agency, "setAsideType", title, "responseDeadline"::date, "probabilityScore"
FROM opportunities
WHERE "consultingFirmId" = 'be68e12e-c855-49ba-9f65-5a25f1d9e69b'
  AND status = 'ACTIVE'
ORDER BY "responseDeadline";
