// =============================================================
// The business types a demo account can be, and the invented work each one sees.
//
// These are the industry groups the app already uses for NAICS codes (see
// frontend NaicsPicker). IT is split by code prefix rather than by the two-digit
// sector, because federal IT work is mostly NAICS 5415, inside Professional Services.
// =============================================================

export interface DemoBusinessType {
  key: string
  label: string
  /** NAICS prefixes this business's opportunities must start with. */
  naicsPrefixes: string[]
  /** One per sample client. Each is a real NAICS code in this industry. */
  naicsCodes: [string, string, string]
  clientSuffixes: [string, string, string]
  partnerSuffixes: [string, string]
  /** 20 open opportunities: the first 16 start off the pipeline, the last 4 on it. */
  opportunities: string[]
  /** 6 past bids. */
  pastBids: string[]
  agencies: [string, string, string, string]
  contract: { title: string; work: string }
  capabilities: [{ title: string; content: string }, { title: string; content: string }]
  jobTitles: [string, string, string]
}

export const DEMO_BUSINESS_TYPES: DemoBusinessType[] = [
  {
    key: 'CONSTRUCTION', label: 'Construction', naicsPrefixes: ['23'], naicsCodes: ['236220', '237310', '238210'],
    clientSuffixes: ['Builders', 'Civil Works', 'Electrical Contractors'], partnerSuffixes: ['Site Services', 'Mechanical Group'],
    opportunities: ['Federal Courthouse Renovation', 'Runway Pavement Rehabilitation', 'Medical Center Electrical Upgrade', 'Veterans Clinic Expansion', 'Highway Bridge Deck Replacement', 'Barracks Fire Alarm Replacement', 'Office Building HVAC Modernization', 'Border Station New Construction', 'Dormitory Plumbing Replacement', 'Levee Repair and Armoring', 'Fire Station Addition', 'Hangar Door Replacement', 'Water Treatment Plant Upgrade', 'Perimeter Fence Installation', 'Parking Lot Resurfacing', 'Seismic Retrofit of Clinic Wing', 'Laboratory Building Roof Replacement', 'Access Road Reconstruction', 'Warehouse Lighting Retrofit', 'Training Center Design-Build'],
    pastBids: ['Administrative Building Interior Renovation', 'Parking Structure Repair', 'Emergency Generator Installation', 'Visitor Center Addition', 'Stormwater Drainage Improvements', 'Substation Upgrade'],
    agencies: ['General Services Administration', 'Department of Veterans Affairs', 'Army Corps of Engineers', 'Department of Transportation'],
    contract: { title: 'Multi-Building Repair and Alteration', work: 'Repair and alteration work across occupied federal buildings.' },
    capabilities: [{ title: 'Occupied Building Renovation', content: 'We phase work around building occupants, with safety plans, after-hours scheduling and daily coordination with the facility manager.' }, { title: 'Design-Build Delivery', content: 'A single team carries design and construction, so scope, schedule and cost stay accountable from concept through closeout.' }],
    jobTitles: ['Project Manager', 'Site Superintendent', 'Quality Control Manager'],
  },
  {
    key: 'MANUFACTURING', label: 'Manufacturing', naicsPrefixes: ['31', '32', '33'], naicsCodes: ['332710', '334511', '336413'],
    clientSuffixes: ['Precision Machining', 'Instruments', 'Aerospace Components'], partnerSuffixes: ['Metal Finishing', 'Test Labs'],
    opportunities: ['Machined Parts for Ground Vehicles', 'Navigation Sensor Assemblies', 'Aircraft Landing Gear Components', 'Precision Valve Manufacturing', 'Radar Enclosure Fabrication', 'Hydraulic Actuator Production', 'Shipboard Pump Components', 'Avionics Circuit Card Assemblies', 'Generator Housing Fabrication', 'Antenna Mast Assemblies', 'Pressure Vessel Production', 'Tactical Vehicle Brake Components', 'Shipboard Valve Manufacturing', 'Night Vision Mount Machining', 'Cable Harness Assemblies', 'Replacement Impeller Castings', 'Armored Door Hinge Production', 'Weather Instrument Assemblies', 'Turbine Bracket Manufacturing', 'Optical Sight Housings'],
    pastBids: ['Vehicle Suspension Brackets', 'Sensor Calibration Fixtures', 'Aircraft Seat Track Components', 'Replacement Gear Sets', 'Test Equipment Enclosures', 'Fuel System Fittings'],
    agencies: ['Defense Logistics Agency', 'Department of the Navy', 'Department of the Air Force', 'Department of the Army'],
    contract: { title: 'Machined Spare Parts Supply', work: 'Production and delivery of machined spare parts to approved drawings.' },
    capabilities: [{ title: 'Precision Machining to Drawing', content: 'Our machinists work to government drawings with first-article inspection and full material traceability.' }, { title: 'Quality Management', content: 'We hold documented inspection plans, calibrated gauges and corrective action procedures for every production lot.' }],
    jobTitles: ['Production Manager', 'Quality Engineer', 'Manufacturing Engineer'],
  },
  {
    key: 'WHOLESALE', label: 'Wholesale Trade', naicsPrefixes: ['42'], naicsCodes: ['423450', '423430', '424210'],
    clientSuffixes: ['Medical Supply', 'Technology Distribution', 'Pharmaceutical Supply'], partnerSuffixes: ['Freight Partners', 'Warehouse Services'],
    opportunities: ['Medical Supplies Distribution', 'Laptop and Peripheral Supply', 'Pharmaceutical Prime Vendor Support', 'Surgical Instruments Supply', 'Network Equipment Reseller', 'Vaccine Cold-Chain Distribution', 'Hospital Consumables Blanket Purchase', 'Monitors and Docking Stations', 'Laboratory Reagent Supply', 'Rugged Laptop Procurement', 'Dental Supply Distribution', 'Server Hardware Reseller', 'Respiratory Therapy Supplies', 'Printer Toner Supply Contract', 'Wheelchair and Mobility Equipment', 'Network Cabling Supply', 'Over-the-Counter Medication Supply', 'Diagnostic Equipment Supply', 'Tablet Device Procurement', 'Personal Protective Equipment Supply'],
    pastBids: ['Wound Care Products', 'Desktop Computer Refresh', 'Clinic Supply Replenishment', 'Printer Supply Contract', 'Exam Room Equipment', 'Prescription Packaging Supply'],
    agencies: ['Department of Veterans Affairs', 'Defense Logistics Agency', 'Department of Health and Human Services', 'General Services Administration'],
    contract: { title: 'Clinical Supplies Blanket Purchase Agreement', work: 'Ordering, warehousing and delivery of clinical supplies to regional facilities.' },
    capabilities: [{ title: 'Authorized Product Distribution', content: 'We source from authorized manufacturers, with traceable lots and verified Trade Agreements Act compliance.' }, { title: 'Delivery to Federal Facilities', content: 'Our distribution network meets scheduled and urgent delivery windows with order status reporting.' }],
    jobTitles: ['Contract Manager', 'Supply Chain Lead', 'Customer Account Manager'],
  },
  {
    key: 'TRANSPORTATION', label: 'Transportation', naicsPrefixes: ['48', '49'], naicsCodes: ['484121', '488510', '493110'],
    clientSuffixes: ['Freightways', 'Logistics', 'Warehousing'], partnerSuffixes: ['Fleet Services', 'Cold Chain'],
    opportunities: ['Regional Freight Brokerage', 'Medical Equipment Transport Services', 'Relief Supply Warehousing', 'Household Goods Shipment Support', 'Fleet Vehicle Delivery', 'Hazardous Materials Hauling', 'Courier Services for Regional Offices', 'Military Cargo Drayage', 'Ambulance Transport Services', 'Cross-Dock Freight Operations', 'Vehicle Shuttle Services', 'Secure Document Courier', 'Refrigerated Pharmaceutical Transport', 'Military Household Goods Storage', 'Regional Parcel Delivery', 'Heavy Equipment Hauling', 'Regional Courier and Distribution Services', 'Records Storage and Retrieval', 'Base Supply Line Haul', 'Emergency Response Logistics'],
    pastBids: ['Medical Supply Courier Services', 'Fleet Logistics Support', 'Regional Warehouse Operations', 'Equipment Relocation Services', 'Mail Delivery Routes', 'Disaster Staging Area Support'],
    agencies: ['Department of Veterans Affairs', 'General Services Administration', 'Federal Emergency Management Agency', 'Department of Defense'],
    contract: { title: 'Regional Freight Services', work: 'Scheduled and same-day freight between federal facilities.' },
    capabilities: [{ title: 'Time-Critical Freight', content: 'Our dispatch team tracks every load and escalates exceptions before a delivery window is missed.' }, { title: 'Warehousing and Inventory', content: 'We receive, store and issue government property with cycle counts and full custody records.' }],
    jobTitles: ['Operations Manager', 'Fleet Safety Manager', 'Logistics Coordinator'],
  },
  {
    key: 'IT', label: 'Information / IT', naicsPrefixes: ['51', '5415'], naicsCodes: ['541512', '541519', '518210'],
    clientSuffixes: ['Technologies', 'Secure Systems', 'Data Services'], partnerSuffixes: ['Cyber', 'Network Engineering'],
    opportunities: ['Zero Trust Architecture Assessment and Support', 'Enterprise Help Desk Modernization', 'Cloud Migration for Benefits Systems', 'Identity Management Modernization', 'Data Center Hosting Services', 'Network Operations Center Support', 'Application Sustainment Services', 'Data Analytics Platform Sustainment', 'Email Migration to Cloud', 'Mobile Device Management Services', 'Software Testing Services', 'Cybersecurity Assessment and Authorization', 'Service Desk Consolidation', 'Legacy Application Modernization', 'Data Warehouse Operations', 'Network Refresh Engineering', 'Cloud Security Posture Assessment', 'Endpoint Security Rollout', 'Disaster Recovery Hosting', 'Security Operations Center Support'],
    pastBids: ['Network Security Monitoring Support', 'Identity Management Upgrade', 'Cloud Hosting Services', 'Software Development Support', 'Records System Migration', 'Base Network Maintenance'],
    agencies: ['Department of Homeland Security', 'Department of Veterans Affairs', 'Social Security Administration', 'Department of Defense'],
    contract: { title: 'IT Support Services', work: 'Help desk and field support across regional sites.' },
    capabilities: [{ title: 'Zero Trust Implementation', content: 'Our engineers assess identity, device and network controls against federal guidance, then deliver a phased plan that keeps mission systems running.' }, { title: 'Federal Help Desk Operations', content: 'We run tiered support with documented escalation paths, measured against agreed service levels and reported monthly.' }],
    jobTitles: ['Program Manager', 'Cybersecurity Lead', 'Senior Support Engineer'],
  },
  {
    key: 'FINANCE', label: 'Finance & Insurance', naicsPrefixes: ['52'], naicsCodes: ['522320', '524292', '523940'],
    clientSuffixes: ['Payment Services', 'Claims Administration', 'Financial Advisors'], partnerSuffixes: ['Audit Partners', 'Actuarial Group'],
    opportunities: ['Payment Card Processing Services', 'Workers Compensation Claims Administration', 'Retirement Plan Advisory Services', 'Loan Servicing Support', 'Disaster Loan Processing', 'Benefit Payment Processing', 'Claims Audit Support', 'Investment Portfolio Advisory', 'Travel Card Program Support', 'Grant Audit Services', 'Pension Fund Administration', 'Fraud Analytics Services', 'Accounts Receivable Collections', 'Flood Insurance Claims Review', 'Payroll Processing Support', 'Investment Compliance Review', 'Debt Collection Support', 'Crop Insurance Claims Review', 'Grant Payment Disbursement', 'Federal Employee Benefits Administration'],
    pastBids: ['Electronic Funds Transfer Support', 'Medical Claims Review', 'Pension Advisory Services', 'Student Loan Servicing Support', 'Insurance Claims Processing', 'Treasury Reporting Support'],
    agencies: ['Department of the Treasury', 'Department of Labor', 'Small Business Administration', 'Department of Education'],
    contract: { title: 'Claims Administration Services', work: 'Intake, review and payment of benefit claims.' },
    capabilities: [{ title: 'Accurate Claims Processing', content: 'Our examiners follow documented rules with dual review, so payments are correct and every decision can be audited.' }, { title: 'Secure Financial Operations', content: 'We separate duties, reconcile daily and report exceptions to the program office.' }],
    jobTitles: ['Program Director', 'Claims Manager', 'Senior Financial Analyst'],
  },
  {
    key: 'PROFESSIONAL', label: 'Professional Services', naicsPrefixes: ['5411', '5412', '5413', '5414', '5416', '5417', '5418', '5419'], naicsCodes: ['541611', '541330', '541618'],
    clientSuffixes: ['Consulting', 'Engineering', 'Advisors'], partnerSuffixes: ['Research Group', 'Strategy Partners'],
    opportunities: ['Program Management Support Services', 'Engineering Technical Assistance', 'Organizational Assessment', 'Acquisition Support Services', 'Environmental Engineering Review', 'Change Management Support', 'Strategic Planning Support', 'Systems Engineering Advisory', 'Cost Estimating Support', 'Environmental Impact Study', 'Data Governance Advisory', 'Independent Verification and Validation', 'Logistics Planning Study', 'Market Research Services', 'Training Needs Analysis', 'Program Evaluation Services', 'Workforce Planning Study', 'Facility Condition Assessments', 'Policy Analysis Support', 'Enterprise Transformation Advisory'],
    pastBids: ['Budget Formulation Support', 'Structural Engineering Reviews', 'Process Improvement Study', 'Contract Closeout Support', 'Safety Engineering Services', 'Performance Measurement Support'],
    agencies: ['Department of Defense', 'Department of Energy', 'General Services Administration', 'Department of the Interior'],
    contract: { title: 'Program Management Support', work: 'Planning, reporting and risk management for a federal program office.' },
    capabilities: [{ title: 'Program Management', content: 'Our consultants set up schedules, risk registers and reporting that give leaders a clear view of cost and progress.' }, { title: 'Independent Technical Review', content: 'Licensed engineers review designs and findings, with recommendations the agency can act on.' }],
    jobTitles: ['Engagement Manager', 'Principal Engineer', 'Senior Consultant'],
  },
  {
    key: 'ADMIN_SUPPORT', label: 'Admin & Support', naicsPrefixes: ['56'], naicsCodes: ['561210', '561720', '561320'],
    clientSuffixes: ['Facility Services', 'Building Care', 'Staffing'], partnerSuffixes: ['Grounds Care', 'Security Services'],
    opportunities: ['Facilities Operations Support', 'Janitorial and Grounds Maintenance', 'Administrative Staffing Support', 'Base Operations Support', 'Custodial Services for Regional Offices', 'Clerical Support Services', 'Mailroom Operations', 'Reception and Call Center Staffing', 'Call Center Operations', 'Records Digitization Services', 'Security Guard Services', 'Snow and Ice Removal', 'Visitor Center Staffing', 'Warehouse Custodial Services', 'Document Scanning and Indexing', 'Event Support Staffing', 'Federal Campus Custodial Services', 'Grounds Maintenance Services', 'Temporary Staffing Services', 'Integrated Facilities Management'],
    pastBids: ['Federal Building Custodial Services', 'Base Facilities Maintenance', 'Temporary Clerical Support', 'Landscaping Services', 'Front Office Staffing', 'Pest Control Services'],
    agencies: ['General Services Administration', 'Department of the Army', 'Department of Veterans Affairs', 'Department of Agriculture'],
    contract: { title: 'Facilities Support Services', work: 'Custodial, grounds and front-desk services across federal buildings.' },
    capabilities: [{ title: 'Facilities Operations', content: 'We run preventive maintenance and custodial schedules with inspections reported to the facility manager.' }, { title: 'Staffing to Requirement', content: 'We recruit, screen and backfill qualified staff so posts stay covered.' }],
    jobTitles: ['Operations Manager', 'Site Supervisor', 'Staffing Coordinator'],
  },
  {
    key: 'EDUCATION', label: 'Education', naicsPrefixes: ['61'], naicsCodes: ['611430', '611699', '611710'],
    clientSuffixes: ['Learning', 'Training Institute', 'Education Services'], partnerSuffixes: ['Curriculum Design', 'Instructor Network'],
    opportunities: ['Leadership Development Training', 'Language Instruction Services', 'Technical Training Curriculum', 'Veterans Education Counseling', 'Cybersecurity Workforce Training', 'Safety Certification Training', 'Instructor-Led Acquisition Courses', 'Testing and Assessment Services', 'Executive Coaching Program', 'Financial Literacy Training', 'Project Management Certification Courses', 'English Language Instruction', 'Safety Awareness Training', 'Data Analytics Bootcamp', 'Customer Service Training', 'Instructor Certification Program', 'Grant Writing Workshops', 'Virtual Classroom Delivery', 'Apprenticeship Program Support', 'Enterprise Learning Program'],
    pastBids: ['Supervisor Training Program', 'Foreign Language Courses', 'Equipment Operator Training', 'Career Counseling Services', 'Records Management Training', 'Exam Administration Support'],
    agencies: ['Department of Education', 'Department of Labor', 'Department of Defense', 'Department of Veterans Affairs'],
    contract: { title: 'Workforce Training Services', work: 'Design and delivery of instructor-led and virtual courses.' },
    capabilities: [{ title: 'Curriculum Development', content: 'Our instructional designers build courses around measurable objectives and the agency’s real tasks.' }, { title: 'Blended Delivery', content: 'We deliver in the classroom and online, with completion tracking and learner feedback.' }],
    jobTitles: ['Training Program Manager', 'Lead Instructor', 'Instructional Designer'],
  },
  {
    key: 'HEALTH', label: 'Health Care', naicsPrefixes: ['62'], naicsCodes: ['621111', '621610', '621511'],
    clientSuffixes: ['Medical Group', 'Home Health', 'Diagnostics'], partnerSuffixes: ['Nurse Staffing', 'Clinical Partners'],
    opportunities: ['Primary Care Clinic Services', 'Home Health Nursing Services', 'Laboratory Testing Services', 'Occupational Health Services', 'Tele-Mental Health Services', 'Physical Therapy Services', 'Medical Staffing for Clinics', 'Community Care Coordination', 'Audiology Services', 'Behavioral Health Counseling', 'Pharmacy Staffing Services', 'Mobile Vaccination Clinics', 'Sleep Study Services', 'Nutrition Counseling Services', 'Urgent Care Staffing', 'Occupational Therapy Services', 'Physical Examination Services', 'Dialysis Treatment Services', 'Hospice Care Services', 'Integrated Health Clinic Operations'],
    pastBids: ['Veterans Clinic Staffing', 'Skilled Nursing Visits', 'Blood Testing Services', 'Employee Health Screening', 'Radiology Reading Services', 'Dental Care Services'],
    agencies: ['Department of Veterans Affairs', 'Department of Health and Human Services', 'Indian Health Service', 'Defense Health Agency'],
    contract: { title: 'Community Clinic Services', work: 'Primary care staffing and patient services at community clinics.' },
    capabilities: [{ title: 'Credentialed Clinical Staffing', content: 'We verify licenses and privileges before placement, and keep clinics staffed through planned backups.' }, { title: 'Patient Quality and Safety', content: 'Our quality program tracks outcomes and patient satisfaction, and reports them to the agency.' }],
    jobTitles: ['Medical Director', 'Nurse Manager', 'Clinic Administrator'],
  },
  {
    key: 'OTHER_SERVICES', label: 'Other Services', naicsPrefixes: ['81'], naicsCodes: ['811310', '811210', '812332'],
    clientSuffixes: ['Equipment Repair', 'Electronics Repair', 'Laundry Services'], partnerSuffixes: ['Field Technicians', 'Parts Supply'],
    opportunities: ['Industrial Equipment Maintenance', 'Medical Equipment Repair', 'Hospital Linen Services', 'Generator Maintenance', 'Radio Equipment Repair', 'Uniform Laundry Services', 'Elevator Maintenance', 'Copier Maintenance Services', 'Fleet Vehicle Repair', 'HVAC Equipment Maintenance', 'Fitness Equipment Servicing', 'Lock and Key Services', 'Cafeteria Equipment Repair', 'Two-Way Radio Maintenance', 'Water Cooler Servicing', 'Dry Cleaning Services', 'Boiler Inspection and Repair', 'Test Equipment Calibration Repair', 'Dining Facility Linen Supply', 'Regional Equipment Maintenance Program'],
    pastBids: ['Forklift Repair Services', 'Biomedical Equipment Maintenance', 'Barracks Laundry Services', 'Compressor Maintenance', 'Electronics Bench Repair', 'Kitchen Equipment Repair'],
    agencies: ['Department of Veterans Affairs', 'Department of the Army', 'General Services Administration', 'Department of the Navy'],
    contract: { title: 'Equipment Maintenance Services', work: 'Scheduled maintenance and on-call repair of facility equipment.' },
    capabilities: [{ title: 'Preventive Maintenance', content: 'We schedule, document and report maintenance, so equipment stays available and downtime is planned.' }, { title: 'Rapid On-Call Repair', content: 'Our certified technicians respond within agreed times and carry common parts.' }],
    jobTitles: ['Service Manager', 'Lead Technician', 'Maintenance Planner'],
  },
  {
    key: 'PUBLIC_ADMIN', label: 'Public Admin', naicsPrefixes: ['92'], naicsCodes: ['921190', '923120', '926150'],
    clientSuffixes: ['Public Sector Services', 'Program Support', 'Regulatory Services'], partnerSuffixes: ['Policy Support', 'Records Services'],
    opportunities: ['Public Records Administration', 'Public Health Program Administration', 'Licensing Program Support', 'Benefit Eligibility Processing', 'Public Inquiry Center Support', 'Regulatory Compliance Reviews', 'Grant Program Administration', 'Permit Processing Support', 'Election Support Services', 'Public Records Request Processing', 'Benefits Call Center Support', 'Census Field Operations Support', 'Regulatory Filing Support', 'Permit Inspection Scheduling', 'Public Meeting Transcription', 'Grant Reporting Support', 'Community Outreach Administration', 'Inspection Program Support', 'Rulemaking Docket Support', 'Enterprise Program Administration'],
    pastBids: ['Freedom of Information Act Support', 'Health Program Reporting', 'Professional License Processing', 'Case File Management', 'Public Comment Review', 'Survey Administration'],
    agencies: ['Department of Health and Human Services', 'Department of the Interior', 'Department of Labor', 'Environmental Protection Agency'],
    contract: { title: 'Program Administration Support', work: 'Case processing and reporting for a federal benefit program.' },
    capabilities: [{ title: 'Program Administration', content: 'We process cases to documented rules, with quality checks and clear reporting to the program office.' }, { title: 'Public-Facing Support', content: 'Our trained agents answer inquiries accurately and within agreed service levels.' }],
    jobTitles: ['Program Manager', 'Case Processing Lead', 'Compliance Analyst'],
  },
]

export const businessTypeByKey = (key: string | null | undefined): DemoBusinessType | undefined =>
  DEMO_BUSINESS_TYPES.find((type) => type.key === key)

export const DEFAULT_BUSINESS_TYPE = DEMO_BUSINESS_TYPES.find((type) => type.key === 'IT') as DemoBusinessType
