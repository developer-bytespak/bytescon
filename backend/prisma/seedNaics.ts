import { PrismaClient } from '@prisma/client'

interface NaicsEntry {
  code: string
  description: string
  sector: string
}

// Curated list of NAICS 2022 codes most relevant to federal contracting + small business
// growth sectors. Not exhaustive — the picker has an "Add this code anyway" fallback for
// codes outside this list. Expand here as needed.
const NAICS: NaicsEntry[] = [
  // 11 Agriculture, Forestry, Fishing & Hunting
  { code: '111110', description: 'Soybean Farming', sector: '11' },
  { code: '111998', description: 'All Other Miscellaneous Crop Farming', sector: '11' },
  { code: '112120', description: 'Dairy Cattle and Milk Production', sector: '11' },
  { code: '113310', description: 'Logging', sector: '11' },
  { code: '114111', description: 'Finfish Fishing', sector: '11' },
  { code: '115310', description: 'Support Activities for Forestry', sector: '11' },

  // 21 Mining, Quarrying, Oil & Gas
  { code: '211120', description: 'Crude Petroleum Extraction', sector: '21' },
  { code: '212311', description: 'Dimension Stone Mining and Quarrying', sector: '21' },
  { code: '213112', description: 'Support Activities for Oil and Gas Operations', sector: '21' },

  // 22 Utilities
  { code: '221111', description: 'Hydroelectric Power Generation', sector: '22' },
  { code: '221112', description: 'Fossil Fuel Electric Power Generation', sector: '22' },
  { code: '221113', description: 'Nuclear Electric Power Generation', sector: '22' },
  { code: '221114', description: 'Solar Electric Power Generation', sector: '22' },
  { code: '221115', description: 'Wind Electric Power Generation', sector: '22' },
  { code: '221310', description: 'Water Supply and Irrigation Systems', sector: '22' },
  { code: '221320', description: 'Sewage Treatment Facilities', sector: '22' },

  // 23 Construction
  { code: '236115', description: 'New Single-Family Housing Construction (except For-Sale Builders)', sector: '23' },
  { code: '236116', description: 'New Multifamily Housing Construction (except For-Sale Builders)', sector: '23' },
  { code: '236210', description: 'Industrial Building Construction', sector: '23' },
  { code: '236220', description: 'Commercial and Institutional Building Construction', sector: '23' },
  { code: '237110', description: 'Water and Sewer Line and Related Structures Construction', sector: '23' },
  { code: '237120', description: 'Oil and Gas Pipeline and Related Structures Construction', sector: '23' },
  { code: '237130', description: 'Power and Communication Line and Related Structures Construction', sector: '23' },
  { code: '237210', description: 'Land Subdivision', sector: '23' },
  { code: '237310', description: 'Highway, Street, and Bridge Construction', sector: '23' },
  { code: '237990', description: 'Other Heavy and Civil Engineering Construction', sector: '23' },
  { code: '238110', description: 'Poured Concrete Foundation and Structure Contractors', sector: '23' },
  { code: '238120', description: 'Structural Steel and Precast Concrete Contractors', sector: '23' },
  { code: '238130', description: 'Framing Contractors', sector: '23' },
  { code: '238140', description: 'Masonry Contractors', sector: '23' },
  { code: '238150', description: 'Glass and Glazing Contractors', sector: '23' },
  { code: '238160', description: 'Roofing Contractors', sector: '23' },
  { code: '238170', description: 'Siding Contractors', sector: '23' },
  { code: '238210', description: 'Electrical Contractors and Other Wiring Installation Contractors', sector: '23' },
  { code: '238220', description: 'Plumbing, Heating, and Air-Conditioning Contractors', sector: '23' },
  { code: '238290', description: 'Other Building Equipment Contractors', sector: '23' },
  { code: '238310', description: 'Drywall and Insulation Contractors', sector: '23' },
  { code: '238320', description: 'Painting and Wall Covering Contractors', sector: '23' },
  { code: '238330', description: 'Flooring Contractors', sector: '23' },
  { code: '238340', description: 'Tile and Terrazzo Contractors', sector: '23' },
  { code: '238350', description: 'Finish Carpentry Contractors', sector: '23' },
  { code: '238390', description: 'Other Building Finishing Contractors', sector: '23' },
  { code: '238910', description: 'Site Preparation Contractors', sector: '23' },
  { code: '238990', description: 'All Other Specialty Trade Contractors', sector: '23' },

  // 31-33 Manufacturing
  { code: '311422', description: 'Specialty Canning', sector: '31' },
  { code: '315250', description: 'Cut and Sew Apparel Manufacturing', sector: '31' },
  { code: '321113', description: 'Sawmills', sector: '32' },
  { code: '322121', description: 'Paper (except Newsprint) Mills', sector: '32' },
  { code: '323111', description: 'Commercial Printing (except Screen and Books)', sector: '32' },
  { code: '325199', description: 'All Other Basic Organic Chemical Manufacturing', sector: '32' },
  { code: '325412', description: 'Pharmaceutical Preparation Manufacturing', sector: '32' },
  { code: '325413', description: 'In-Vitro Diagnostic Substance Manufacturing', sector: '32' },
  { code: '325414', description: 'Biological Product (except Diagnostic) Manufacturing', sector: '32' },
  { code: '326211', description: 'Tire Manufacturing (except Retreading)', sector: '32' },
  { code: '331110', description: 'Iron and Steel Mills and Ferroalloy Manufacturing', sector: '33' },
  { code: '332710', description: 'Machine Shops', sector: '33' },
  { code: '332721', description: 'Precision Turned Product Manufacturing', sector: '33' },
  { code: '332722', description: 'Bolt, Nut, Screw, Rivet, and Washer Manufacturing', sector: '33' },
  { code: '332911', description: 'Industrial Valve Manufacturing', sector: '33' },
  { code: '332993', description: 'Ammunition (except Small Arms) Manufacturing', sector: '33' },
  { code: '332994', description: 'Small Arms, Ordnance, and Ordnance Accessories Manufacturing', sector: '33' },
  { code: '332995', description: 'Other Ordnance and Accessories Manufacturing', sector: '33' },
  { code: '333310', description: 'Commercial and Service Industry Machinery Manufacturing', sector: '33' },
  { code: '333611', description: 'Turbine and Turbine Generator Set Units Manufacturing', sector: '33' },
  { code: '334111', description: 'Electronic Computer Manufacturing', sector: '33' },
  { code: '334112', description: 'Computer Storage Device Manufacturing', sector: '33' },
  { code: '334118', description: 'Computer Terminal and Other Computer Peripheral Equipment Manufacturing', sector: '33' },
  { code: '334210', description: 'Telephone Apparatus Manufacturing', sector: '33' },
  { code: '334220', description: 'Radio and Television Broadcasting and Wireless Communications Equipment Manufacturing', sector: '33' },
  { code: '334290', description: 'Other Communications Equipment Manufacturing', sector: '33' },
  { code: '334310', description: 'Audio and Video Equipment Manufacturing', sector: '33' },
  { code: '334412', description: 'Bare Printed Circuit Board Manufacturing', sector: '33' },
  { code: '334413', description: 'Semiconductor and Related Device Manufacturing', sector: '33' },
  { code: '334418', description: 'Printed Circuit Assembly (Electronic Assembly) Manufacturing', sector: '33' },
  { code: '334419', description: 'Other Electronic Component Manufacturing', sector: '33' },
  { code: '334510', description: 'Electromedical and Electrotherapeutic Apparatus Manufacturing', sector: '33' },
  { code: '334511', description: 'Search, Detection, Navigation, Guidance, Aeronautical, and Nautical System and Instrument Manufacturing', sector: '33' },
  { code: '334512', description: 'Automatic Environmental Control Manufacturing for Residential, Commercial, and Appliance Use', sector: '33' },
  { code: '334513', description: 'Instruments and Related Products Manufacturing for Measuring, Displaying, and Controlling Industrial Process Variables', sector: '33' },
  { code: '334514', description: 'Totalizing Fluid Meter and Counting Device Manufacturing', sector: '33' },
  { code: '334515', description: 'Instrument Manufacturing for Measuring and Testing Electricity and Electrical Signals', sector: '33' },
  { code: '334516', description: 'Analytical Laboratory Instrument Manufacturing', sector: '33' },
  { code: '334517', description: 'Irradiation Apparatus Manufacturing', sector: '33' },
  { code: '334519', description: 'Other Measuring and Controlling Device Manufacturing', sector: '33' },
  { code: '335311', description: 'Power, Distribution, and Specialty Transformer Manufacturing', sector: '33' },
  { code: '336411', description: 'Aircraft Manufacturing', sector: '33' },
  { code: '336412', description: 'Aircraft Engine and Engine Parts Manufacturing', sector: '33' },
  { code: '336413', description: 'Other Aircraft Parts and Auxiliary Equipment Manufacturing', sector: '33' },
  { code: '336414', description: 'Guided Missile and Space Vehicle Manufacturing', sector: '33' },
  { code: '336415', description: 'Guided Missile and Space Vehicle Propulsion Unit and Propulsion Unit Parts Manufacturing', sector: '33' },
  { code: '336419', description: 'Other Guided Missile and Space Vehicle Parts and Auxiliary Equipment Manufacturing', sector: '33' },
  { code: '336611', description: 'Ship Building and Repairing', sector: '33' },
  { code: '336992', description: 'Military Armored Vehicle, Tank, and Tank Component Manufacturing', sector: '33' },
  { code: '339112', description: 'Surgical and Medical Instrument Manufacturing', sector: '33' },
  { code: '339113', description: 'Surgical Appliance and Supplies Manufacturing', sector: '33' },
  { code: '339114', description: 'Dental Equipment and Supplies Manufacturing', sector: '33' },

  // 42 Wholesale Trade
  { code: '423430', description: 'Computer and Computer Peripheral Equipment and Software Merchant Wholesalers', sector: '42' },
  { code: '423450', description: 'Medical, Dental, and Hospital Equipment and Supplies Merchant Wholesalers', sector: '42' },
  { code: '423610', description: 'Electrical Apparatus and Equipment, Wiring Supplies, and Related Equipment Merchant Wholesalers', sector: '42' },
  { code: '423690', description: 'Other Electronic Parts and Equipment Merchant Wholesalers', sector: '42' },
  { code: '423830', description: 'Industrial Machinery and Equipment Merchant Wholesalers', sector: '42' },
  { code: '423860', description: 'Transportation Equipment and Supplies (except Motor Vehicle) Merchant Wholesalers', sector: '42' },

  // 44-45 Retail Trade (limited federal relevance)
  { code: '441110', description: 'New Car Dealers', sector: '44' },
  { code: '454110', description: 'Electronic Shopping and Mail-Order Houses', sector: '45' },

  // 48-49 Transportation & Warehousing
  { code: '481111', description: 'Scheduled Passenger Air Transportation', sector: '48' },
  { code: '481211', description: 'Nonscheduled Chartered Passenger Air Transportation', sector: '48' },
  { code: '481212', description: 'Nonscheduled Chartered Freight Air Transportation', sector: '48' },
  { code: '482111', description: 'Line-Haul Railroads', sector: '48' },
  { code: '483111', description: 'Deep Sea Freight Transportation', sector: '48' },
  { code: '484110', description: 'General Freight Trucking, Local', sector: '48' },
  { code: '484121', description: 'General Freight Trucking, Long-Distance, Truckload', sector: '48' },
  { code: '484122', description: 'General Freight Trucking, Long-Distance, Less Than Truckload', sector: '48' },
  { code: '484220', description: 'Specialized Freight (except Used Goods) Trucking, Local', sector: '48' },
  { code: '484230', description: 'Specialized Freight (except Used Goods) Trucking, Long-Distance', sector: '48' },
  { code: '485310', description: 'Taxi and Ridesharing Services', sector: '48' },
  { code: '485410', description: 'School and Employee Bus Transportation', sector: '48' },
  { code: '486210', description: 'Pipeline Transportation of Natural Gas', sector: '48' },
  { code: '488119', description: 'Other Airport Operations', sector: '48' },
  { code: '488210', description: 'Support Activities for Rail Transportation', sector: '48' },
  { code: '488310', description: 'Port and Harbor Operations', sector: '48' },
  { code: '488410', description: 'Motor Vehicle Towing', sector: '48' },
  { code: '488490', description: 'Other Support Activities for Road Transportation', sector: '48' },
  { code: '488510', description: 'Freight Transportation Arrangement', sector: '48' },
  { code: '488991', description: 'Packing and Crating', sector: '48' },
  { code: '492110', description: 'Couriers and Express Delivery Services', sector: '49' },
  { code: '492210', description: 'Local Messengers and Local Delivery', sector: '49' },
  { code: '493110', description: 'General Warehousing and Storage', sector: '49' },
  { code: '493120', description: 'Refrigerated Warehousing and Storage', sector: '49' },
  { code: '493190', description: 'Other Warehousing and Storage', sector: '49' },

  // 51 Information / IT
  { code: '511210', description: 'Software Publishers', sector: '51' },
  { code: '512110', description: 'Motion Picture and Video Production', sector: '51' },
  { code: '517111', description: 'Wired Telecommunications Carriers', sector: '51' },
  { code: '517112', description: 'Wireless Telecommunications Carriers (except Satellite)', sector: '51' },
  { code: '517410', description: 'Satellite Telecommunications', sector: '51' },
  { code: '517911', description: 'Telecommunications Resellers', sector: '51' },
  { code: '518210', description: 'Computing Infrastructure Providers, Data Processing, Web Hosting, and Related Services', sector: '51' },
  { code: '519130', description: 'Internet Publishing and Broadcasting and Web Search Portals', sector: '51' },
  { code: '519290', description: 'Web Search Portals, Libraries, Archives, and Other Information Services', sector: '51' },

  // 52 Finance & Insurance
  { code: '522110', description: 'Commercial Banking', sector: '52' },
  { code: '523110', description: 'Investment Banking and Securities Intermediation', sector: '52' },
  { code: '524113', description: 'Direct Life Insurance Carriers', sector: '52' },
  { code: '524126', description: 'Direct Property and Casualty Insurance Carriers', sector: '52' },

  // 53 Real Estate, Rental & Leasing
  { code: '531120', description: 'Lessors of Nonresidential Buildings (except Miniwarehouses)', sector: '53' },
  { code: '532411', description: 'Commercial Air, Rail, and Water Transportation Equipment Rental and Leasing', sector: '53' },
  { code: '532412', description: 'Construction, Mining, and Forestry Machinery and Equipment Rental and Leasing', sector: '53' },

  // 54 Professional, Scientific & Technical Services (heavy federal contracting)
  { code: '541110', description: 'Offices of Lawyers', sector: '54' },
  { code: '541191', description: 'Title Abstract and Settlement Offices', sector: '54' },
  { code: '541211', description: 'Offices of Certified Public Accountants', sector: '54' },
  { code: '541213', description: 'Tax Preparation Services', sector: '54' },
  { code: '541214', description: 'Payroll Services', sector: '54' },
  { code: '541219', description: 'Other Accounting Services', sector: '54' },
  { code: '541310', description: 'Architectural Services', sector: '54' },
  { code: '541320', description: 'Landscape Architectural Services', sector: '54' },
  { code: '541330', description: 'Engineering Services', sector: '54' },
  { code: '541340', description: 'Drafting Services', sector: '54' },
  { code: '541350', description: 'Building Inspection Services', sector: '54' },
  { code: '541360', description: 'Geophysical Surveying and Mapping Services', sector: '54' },
  { code: '541370', description: 'Surveying and Mapping (except Geophysical) Services', sector: '54' },
  { code: '541380', description: 'Testing Laboratories and Services', sector: '54' },
  { code: '541410', description: 'Interior Design Services', sector: '54' },
  { code: '541420', description: 'Industrial Design Services', sector: '54' },
  { code: '541430', description: 'Graphic Design Services', sector: '54' },
  { code: '541490', description: 'Other Specialized Design Services', sector: '54' },
  { code: '541511', description: 'Custom Computer Programming Services', sector: '54' },
  { code: '541512', description: 'Computer Systems Design Services', sector: '54' },
  { code: '541513', description: 'Computer Facilities Management Services', sector: '54' },
  { code: '541519', description: 'Other Computer Related Services', sector: '54' },
  { code: '541611', description: 'Administrative Management and General Management Consulting Services', sector: '54' },
  { code: '541612', description: 'Human Resources Consulting Services', sector: '54' },
  { code: '541613', description: 'Marketing Consulting Services', sector: '54' },
  { code: '541614', description: 'Process, Physical Distribution, and Logistics Consulting Services', sector: '54' },
  { code: '541618', description: 'Other Management Consulting Services', sector: '54' },
  { code: '541620', description: 'Environmental Consulting Services', sector: '54' },
  { code: '541690', description: 'Other Scientific and Technical Consulting Services', sector: '54' },
  { code: '541713', description: 'Research and Development in Nanotechnology', sector: '54' },
  { code: '541714', description: 'Research and Development in Biotechnology (except Nanobiotechnology)', sector: '54' },
  { code: '541715', description: 'Research and Development in the Physical, Engineering, and Life Sciences (except Nanotechnology and Biotechnology)', sector: '54' },
  { code: '541720', description: 'Research and Development in the Social Sciences and Humanities', sector: '54' },
  { code: '541810', description: 'Advertising Agencies', sector: '54' },
  { code: '541820', description: 'Public Relations Agencies', sector: '54' },
  { code: '541830', description: 'Media Buying Agencies', sector: '54' },
  { code: '541860', description: 'Direct Mail Advertising', sector: '54' },
  { code: '541910', description: 'Marketing Research and Public Opinion Polling', sector: '54' },
  { code: '541921', description: 'Photography Studios, Portrait', sector: '54' },
  { code: '541922', description: 'Commercial Photography', sector: '54' },
  { code: '541930', description: 'Translation and Interpretation Services', sector: '54' },
  { code: '541940', description: 'Veterinary Services', sector: '54' },
  { code: '541990', description: 'All Other Professional, Scientific, and Technical Services', sector: '54' },

  // 55 Management of Companies
  { code: '551114', description: 'Corporate, Subsidiary, and Regional Managing Offices', sector: '55' },

  // 56 Administrative & Support Services
  { code: '561110', description: 'Office Administrative Services', sector: '56' },
  { code: '561210', description: 'Facilities Support Services', sector: '56' },
  { code: '561311', description: 'Employment Placement Agencies', sector: '56' },
  { code: '561312', description: 'Executive Search Services', sector: '56' },
  { code: '561320', description: 'Temporary Help Services', sector: '56' },
  { code: '561330', description: 'Professional Employer Organizations', sector: '56' },
  { code: '561410', description: 'Document Preparation Services', sector: '56' },
  { code: '561421', description: 'Telephone Answering Services', sector: '56' },
  { code: '561422', description: 'Telemarketing Bureaus and Other Contact Centers', sector: '56' },
  { code: '561431', description: 'Private Mail Centers', sector: '56' },
  { code: '561439', description: 'Other Business Service Centers (including Copy Shops)', sector: '56' },
  { code: '561440', description: 'Collection Agencies', sector: '56' },
  { code: '561450', description: 'Credit Bureaus', sector: '56' },
  { code: '561492', description: 'Court Reporting and Stenotype Services', sector: '56' },
  { code: '561499', description: 'All Other Business Support Services', sector: '56' },
  { code: '561510', description: 'Travel Agencies', sector: '56' },
  { code: '561520', description: 'Tour Operators', sector: '56' },
  { code: '561599', description: 'All Other Travel Arrangement and Reservation Services', sector: '56' },
  { code: '561611', description: 'Investigation and Personal Background Check Services', sector: '56' },
  { code: '561612', description: 'Security Guards and Patrol Services', sector: '56' },
  { code: '561613', description: 'Armored Car Services', sector: '56' },
  { code: '561621', description: 'Security Systems Services (except Locksmiths)', sector: '56' },
  { code: '561622', description: 'Locksmiths', sector: '56' },
  { code: '561710', description: 'Exterminating and Pest Control Services', sector: '56' },
  { code: '561720', description: 'Janitorial Services', sector: '56' },
  { code: '561730', description: 'Landscaping Services', sector: '56' },
  { code: '561740', description: 'Carpet and Upholstery Cleaning Services', sector: '56' },
  { code: '561790', description: 'Other Services to Buildings and Dwellings', sector: '56' },
  { code: '561910', description: 'Packaging and Labeling Services', sector: '56' },
  { code: '561920', description: 'Convention and Trade Show Organizers', sector: '56' },
  { code: '561990', description: 'All Other Support Services', sector: '56' },
  { code: '562111', description: 'Solid Waste Collection', sector: '56' },
  { code: '562112', description: 'Hazardous Waste Collection', sector: '56' },
  { code: '562211', description: 'Hazardous Waste Treatment and Disposal', sector: '56' },
  { code: '562910', description: 'Remediation Services', sector: '56' },
  { code: '562998', description: 'All Other Miscellaneous Waste Management Services', sector: '56' },

  // 61 Educational Services
  { code: '611310', description: 'Colleges, Universities, and Professional Schools', sector: '61' },
  { code: '611420', description: 'Computer Training', sector: '61' },
  { code: '611430', description: 'Professional and Management Development Training', sector: '61' },
  { code: '611512', description: 'Flight Training', sector: '61' },
  { code: '611519', description: 'Other Technical and Trade Schools', sector: '61' },
  { code: '611699', description: 'All Other Miscellaneous Schools and Instruction', sector: '61' },
  { code: '611710', description: 'Educational Support Services', sector: '61' },

  // 62 Health Care & Social Assistance
  { code: '621111', description: 'Offices of Physicians (except Mental Health Specialists)', sector: '62' },
  { code: '621210', description: 'Offices of Dentists', sector: '62' },
  { code: '621310', description: 'Offices of Chiropractors', sector: '62' },
  { code: '621320', description: 'Offices of Optometrists', sector: '62' },
  { code: '621330', description: 'Offices of Mental Health Practitioners (except Physicians)', sector: '62' },
  { code: '621399', description: 'Offices of All Other Miscellaneous Health Practitioners', sector: '62' },
  { code: '621410', description: 'Family Planning Centers', sector: '62' },
  { code: '621498', description: 'All Other Outpatient Care Centers', sector: '62' },
  { code: '621511', description: 'Medical Laboratories', sector: '62' },
  { code: '621512', description: 'Diagnostic Imaging Centers', sector: '62' },
  { code: '621610', description: 'Home Health Care Services', sector: '62' },
  { code: '621910', description: 'Ambulance Services', sector: '62' },
  { code: '621991', description: 'Blood and Organ Banks', sector: '62' },
  { code: '621999', description: 'All Other Miscellaneous Ambulatory Health Care Services', sector: '62' },
  { code: '622110', description: 'General Medical and Surgical Hospitals', sector: '62' },
  { code: '622210', description: 'Psychiatric and Substance Abuse Hospitals', sector: '62' },
  { code: '623110', description: 'Nursing Care Facilities (Skilled Nursing Facilities)', sector: '62' },
  { code: '624190', description: 'Other Individual and Family Services', sector: '62' },
  { code: '624310', description: 'Vocational Rehabilitation Services', sector: '62' },

  // 71 Arts, Entertainment & Recreation
  { code: '711510', description: 'Independent Artists, Writers, and Performers', sector: '71' },
  { code: '712110', description: 'Museums', sector: '71' },

  // 72 Accommodation & Food Services
  { code: '721110', description: 'Hotels (except Casino Hotels) and Motels', sector: '72' },
  { code: '722310', description: 'Food Service Contractors', sector: '72' },
  { code: '722320', description: 'Caterers', sector: '72' },

  // 81 Other Services
  { code: '811111', description: 'General Automotive Repair', sector: '81' },
  { code: '811121', description: 'Automotive Body, Paint, and Interior Repair and Maintenance', sector: '81' },
  { code: '811198', description: 'All Other Automotive Repair and Maintenance', sector: '81' },
  { code: '811210', description: 'Electronic and Precision Equipment Repair and Maintenance', sector: '81' },
  { code: '811310', description: 'Commercial and Industrial Machinery and Equipment (except Automotive and Electronic) Repair and Maintenance', sector: '81' },
  { code: '811411', description: 'Home and Garden Equipment Repair and Maintenance', sector: '81' },
  { code: '812332', description: 'Industrial Launderers', sector: '81' },

  // 92 Public Administration
  { code: '921110', description: 'Executive Offices', sector: '92' },
  { code: '921120', description: 'Legislative Bodies', sector: '92' },
  { code: '922120', description: 'Police Protection', sector: '92' },
  { code: '922160', description: 'Fire Protection', sector: '92' },
  { code: '923110', description: 'Administration of Education Programs', sector: '92' },
  { code: '923120', description: 'Administration of Public Health Programs', sector: '92' },
  { code: '923130', description: 'Administration of Human Resource Programs (except Education, Public Health, and Veterans Affairs Programs)', sector: '92' },
  { code: '924110', description: 'Administration of Air and Water Resource and Solid Waste Management Programs', sector: '92' },
  { code: '925110', description: 'Administration of Housing Programs', sector: '92' },
  { code: '926110', description: 'Administration of General Economic Programs', sector: '92' },
  { code: '926130', description: 'Regulation and Administration of Communications, Electric, Gas, and Other Utilities', sector: '92' },
  { code: '927110', description: 'Space Research and Technology', sector: '92' },
  { code: '928110', description: 'National Security', sector: '92' },
  { code: '928120', description: 'International Affairs', sector: '92' },
]

export async function seedNaicsCodes(prisma: PrismaClient) {
  console.log(`Seeding ${NAICS.length} NAICS codes...`)
  for (const entry of NAICS) {
    await prisma.naicsCode.upsert({
      where: { code: entry.code },
      create: { code: entry.code, description: entry.description, sector: entry.sector },
      update: { description: entry.description, sector: entry.sector },
    })
  }
  const total = await prisma.naicsCode.count()
  console.log(`NAICS seed complete. Total in DB: ${total}`)
}

// Standalone runner — `npm run db:seed:naics`
if (require.main === module) {
  const prisma = new PrismaClient()
  seedNaicsCodes(prisma)
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}
