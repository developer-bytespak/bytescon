// =============================================================
// State Procurement Scraper -- Multi-State Edition
// Sources: NY NYSCR, TX ESBD, FL VBS, VA eVA, GA GPR,
//          NC eProcurement, OH Procure, IL BidBuy, CA eProcure,
//          MD eMMA (auth), PA eMarketplace (auth),
//          SAM.gov API (key), USAspending (fallback)
// =============================================================

import axios, { AxiosInstance } from 'axios'
import https from 'https'
import { logger } from '../utils/logger'

/** Agent that skips SSL verification for government portals with cert issues */
const relaxedHttpsAgent = new https.Agent({ rejectUnauthorized: false })

export interface StateOpportunityRecord {
  title:              string
  agency:             string
  state:              string
  contractLevel:      'STATE' | 'MUNICIPAL' | 'COUNTY' | 'FEDERAL'
  naicsCode:          string | null
  estimatedValue:     number | null
  responseDeadline:   Date | null
  description:        string | null
  solicitationNumber: string | null
  contactEmail:       string | null
  sourceUrl:          string | null
  postedAt:           Date | null
  source:             string
}

export const TOP_20_STATES = [
  { abbr: 'CA', name: 'California',     level: 'STATE' as const },
  { abbr: 'TX', name: 'Texas',          level: 'STATE' as const },
  { abbr: 'FL', name: 'Florida',        level: 'STATE' as const },
  { abbr: 'NY', name: 'New York',       level: 'STATE' as const },
  { abbr: 'PA', name: 'Pennsylvania',   level: 'STATE' as const },
  { abbr: 'IL', name: 'Illinois',       level: 'STATE' as const },
  { abbr: 'OH', name: 'Ohio',           level: 'STATE' as const },
  { abbr: 'GA', name: 'Georgia',        level: 'STATE' as const },
  { abbr: 'NC', name: 'North Carolina', level: 'STATE' as const },
  { abbr: 'MI', name: 'Michigan',       level: 'STATE' as const },
  { abbr: 'VA', name: 'Virginia',       level: 'STATE' as const },
  { abbr: 'WA', name: 'Washington',     level: 'STATE' as const },
  { abbr: 'AZ', name: 'Arizona',        level: 'STATE' as const },
  { abbr: 'CO', name: 'Colorado',       level: 'STATE' as const },
  { abbr: 'MD', name: 'Maryland',       level: 'STATE' as const },
  { abbr: 'MN', name: 'Minnesota',      level: 'STATE' as const },
  { abbr: 'TN', name: 'Tennessee',      level: 'STATE' as const },
  { abbr: 'IN', name: 'Indiana',        level: 'STATE' as const },
  { abbr: 'WI', name: 'Wisconsin',      level: 'STATE' as const },
  { abbr: 'MO', name: 'Missouri',       level: 'STATE' as const },
]

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function httpClient(extra?: Record<string, string>): AxiosInstance {
  return axios.create({
    timeout: 20000,
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...extra,
    },
    maxRedirects: 5,
  })
}

function tryDate(s: string | null | undefined): Date | null {
  if (!s) return null
  try { const d = new Date(s); return isNaN(d.getTime()) ? null : d } catch { return null }
}

function extractCookies(h: string[] | string | undefined): string {
  if (!h) return ''
  return (Array.isArray(h) ? h : [h]).map(x => x.split(';')[0]).join('; ')
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .trim()
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

function parseTableRows(html: string, state: string, defaultAgency: string, src: string, baseUrl: string): StateOpportunityRecord[] {
  const out: StateOpportunityRecord[] = []
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []
  for (const row of rows) {
    if (/<th/i.test(row)) continue
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map(stripTags)
    if (cells.length < 3) continue
    const title = cells[1] || cells[0] || ''
    if (!title || title.length < 5) continue
    const hm = /<a[^>]+href="([^"]+)"/.exec(row)
    const rawHref = hm ? hm[1] : ''
    out.push({
      title: title.trim(),
      agency: (cells[2] || defaultAgency).trim(),
      state, contractLevel: 'STATE',
      naicsCode: null, estimatedValue: null,
      responseDeadline: tryDate(cells[4] || cells[3]),
      description: null,
      solicitationNumber: cells[0]?.trim() || null,
      contactEmail: null,
      sourceUrl: rawHref ? (rawHref.startsWith('http') ? rawHref : baseUrl + rawHref) : baseUrl,
      postedAt: null,
      source: src,
    })
  }
  return out
}

export async function scrapeNYSCR(maxPages = 4): Promise<StateOpportunityRecord[]> {
  const results: StateOpportunityRecord[] = []
  const client = httpClient()
  for (let page = 1; page <= maxPages; page++) {
    try {
      const resp = await client.get(`https://www.nyscr.ny.gov/Ads/Search?Page=${page}`)
      const html: string = resp.data
      const blocks = html.match(/<div class="opp-list-item[^"]*"[^>]*data-ad-id="\d+"[\s\S]*?(?=<div class="opp-list-item|<\/main)/g) || []
      if (!blocks.length) break
      for (const block of blocks) {
        const adIdM = /data-ad-id="(\d+)"/.exec(block)
        const titleM = /title="Full Title: ([^"]+)"/.exec(block)
        const adId = adIdM?.[1]; const title = titleM?.[1]?.trim() || ''
        if (!title) continue
        const ef = (label: string) => {
          const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const m = new RegExp(`${esc}[\\s\\S]*?<div class="px-2[^"]*">([^<]+)<`).exec(block)
          return m ? m[1].trim() : ''
        }
        const crM = /<div class="px-2 fw-bold fs-5">(\d+)<\/div>/.exec(block)
        results.push({
          title, agency: ef('Agency:') || 'New York Agency',
          state: 'NY', contractLevel: 'STATE',
          naicsCode: null, estimatedValue: null,
          responseDeadline: tryDate(ef('Due date:')),
          description: ef('Category:') ? `Category: ${ef('Category:')}` : null,
          solicitationNumber: crM ? `NYSCR-${crM[1]}` : null,
          contactEmail: null,
          sourceUrl: adId ? `https://www.nyscr.ny.gov/Ads/Detail?adId=${adId}` : 'https://www.nyscr.ny.gov/Ads/Search',
          postedAt: tryDate(ef('Issue date:')), source: 'NYSCR',
        })
      }
      await sleep(600)
    } catch (err) { logger.warn('NYSCR page failed', { page, error: (err as Error).message }); break }
  }
  logger.info('NYSCR complete', { count: results.length })
  return results
}

export async function scrapeTXESBD(maxPages = 3): Promise<StateOpportunityRecord[]> {
  const results: StateOpportunityRecord[] = []
  // TX ESBD (esbd.texas.gov) was decommissioned — Texas migrated to SmartBuy.
  // Use Texas open data (Socrata) for procurement solicitations.
  const client = httpClient({ Accept: 'application/json, text/html, */*' })

  // 1. Texas open data API — state procurement bids
  try {
    const resp = await client.get('https://data.texas.gov/resource/sbt8-9pxd.json', {
      params: { '$where': "status='Open'", '$limit': 100, '$order': 'close_date DESC' },
    })
    const items: any[] = Array.isArray(resp.data) ? resp.data : []
    for (const item of items) {
      const title = String(item.bid_title || item.description || item.bid_number || '').trim()
      if (!title) continue
      results.push({
        title, agency: item.agency || item.department_name || 'Texas State Agency',
        state: 'TX', contractLevel: 'STATE',
        naicsCode: item.commodity_code || null, estimatedValue: null,
        responseDeadline: tryDate(item.close_date || item.due_date),
        description: item.description?.slice(0, 500) || null,
        solicitationNumber: item.bid_number || item.solicitation_number || null,
        contactEmail: item.buyer_email || item.contact_email || null,
        sourceUrl: item.url || 'https://www.txsmartbuy.com/sp',
        postedAt: tryDate(item.open_date || item.issue_date), source: 'TX_ESBD',
      })
    }
  } catch (err) {
    logger.warn('TX open data API failed', { error: (err as Error).message })
  }

  // 2. Fallback: Texas Comptroller purchasing HTML listing
  if (!results.length) {
    try {
      const BASE = 'https://comptroller.texas.gov'
      for (let page = 1; page <= maxPages; page++) {
        const resp = await client.get(`${BASE}/purchasing/contracts/open-market.php`, {
          params: { page }, headers: { Accept: 'text/html' },
        })
        const added = parseTableRows(resp.data, 'TX', 'Texas State Agency', 'TX_ESBD', BASE)
        results.push(...added); if (!added.length) break; await sleep(500)
      }
    } catch (err) { logger.warn('TX Comptroller HTML fallback failed', { error: (err as Error).message }) }
  }

  logger.info('TX ESBD complete', { count: results.length }); return results
}

export async function scrapeFLVBS(maxPages = 3, user?: string, pass?: string): Promise<StateOpportunityRecord[]> {
  const results: StateOpportunityRecord[] = []
  const BASE = 'https://www.myfloridamarketplace.com'
  const client = httpClient()
  let cookies = ''

  // Session auth when credentials provided
  if (user && pass) {
    try {
      // FL VBS login page
      const loginPage = await client.get(`${BASE}/vbs/vbsapp/login.asp`, { httpsAgent: relaxedHttpsAgent })
      cookies = extractCookies(loginPage.headers['set-cookie'])

      const loginResp = await client.post(
        `${BASE}/vbs/vbsapp/login.asp`,
        new URLSearchParams({ username: user, password: pass, submit: 'Login' }).toString(),
        {
          httpsAgent: relaxedHttpsAgent,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookies,
            Referer: `${BASE}/vbs/vbsapp/login.asp`,
          },
          maxRedirects: 10,
        },
      )
      cookies = [cookies, extractCookies(loginResp.headers['set-cookie'])].filter(Boolean).join('; ')
      logger.info('FL VBS login succeeded')
    } catch (err) {
      logger.warn('FL VBS login failed', { error: (err as Error).message })
    }
  }

  try {
    for (let page = 1; page <= maxPages; page++) {
      const resp = await client.get(`${BASE}/vbs/search.asp`, {
        httpsAgent: relaxedHttpsAgent,
        params: { mode: 0, posting_type: 0, agency_id: '', keywords: '', currentpage: page },
        headers: cookies ? { Cookie: cookies } : {},
      })
      const rows = (resp.data as string).match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []
      let added = 0
      for (const row of rows) {
        if (/<th/i.test(row)) continue
        const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map(stripTags)
        if (cells.length < 4) continue
        const title = cells[1] || cells[0] || ''
        if (!title || title.length < 5) continue
        const hm = /<a[^>]+href="([^"]+)"/.exec(row)
        const rawHref = hm ? hm[1] : ''
        results.push({
          title: title.trim(), agency: (cells[2] || 'Florida State Agency').trim(),
          state: 'FL', contractLevel: 'STATE',
          naicsCode: null, estimatedValue: null,
          responseDeadline: tryDate(cells[4] || cells[3]), description: null,
          solicitationNumber: cells[0]?.trim() || null, contactEmail: null,
          sourceUrl: rawHref ? (rawHref.startsWith('http') ? rawHref : `${BASE}${rawHref}`) : BASE,
          postedAt: null, source: 'FL_VBS',
        })
        added++
      }
      if (!added) break
      await sleep(600)
    }
  } catch (err) { logger.warn('FL VBS scrape failed', { error: (err as Error).message }) }
  logger.info('FL VBS complete', { count: results.length }); return results
}

export async function scrapeVAeVA(): Promise<StateOpportunityRecord[]> {
  const results: StateOpportunityRecord[] = []
  const BASE = 'https://eva.virginia.gov'
  const client = httpClient({ Accept: 'application/json, text/html, */*' })
  // VA eVA: try multiple known public-facing URLs for open solicitations
  const tryUrls = [
    `${BASE}/procurement/webapp/PPRPT/OpenOpportunities/search.do`,
    `${BASE}/procurement/webapp/PPRPT/bidOpportunitySearch.do`,
    `${BASE}/procurement/webapp/PPRPT/AwardedContracts/search.do`,
  ]
  for (const url of tryUrls) {
    try {
      const resp = await client.get(url, {
        params: { searchType: 'open', format: 'json', maxResults: 50 },
        headers: { Accept: 'text/html' },
      })
      const rows = parseTableRows(resp.data, 'VA', 'Virginia Agency', 'VA_EVA', BASE)
      if (rows.length) { results.push(...rows); break }
    } catch { /* try next URL */ }
  }
  if (!results.length) logger.warn('VA eVA: all URLs returned no data')
  logger.info('VA eVA complete', { count: results.length }); return results
}

export async function scrapeGAGPR(maxPages = 3): Promise<StateOpportunityRecord[]> {
  const results: StateOpportunityRecord[] = []
  const client = httpClient()
  // GA Procurement Registry — try current and legacy URLs
  const tryBases = [
    'https://ssl.doas.state.ga.us/gpr',
    'https://doas.georgia.gov/gpr',
  ]
  for (const BASE of tryBases) {
    try {
      for (let page = 1; page <= maxPages; page++) {
        const resp = await client.get(`${BASE}/index.jsp`, { params: { action: 'searchOppListing', Status: 'O', page } })
        const added = parseTableRows(resp.data, 'GA', 'Georgia Agency', 'GA_GPR', BASE)
        results.push(...added); if (!added.length) break; await sleep(500)
      }
      if (results.length) break
    } catch { /* try next base */ }
  }
  if (!results.length) logger.warn('GA GPR: all URLs returned no data')
  logger.info('GA GPR complete', { count: results.length }); return results
}

export async function scrapeNCIPS(maxPages = 3): Promise<StateOpportunityRecord[]> {
  const results: StateOpportunityRecord[] = []
  const client = httpClient({ Accept: 'application/json, text/html, */*' })
  // NC: try multiple known public endpoints
  const tryUrls = [
    { url: 'https://eprocurement.nc.gov/prd/app/sourcing/RfxPublicBrowse', params: { page: 1, pageSize: 50, status: 'OPEN' } },
    { url: 'https://eprocurement.nc.gov/prd/app/sourcing/bidRfx', params: { pageID: 'bidRfxPublic' } },
  ]
  for (const { url, params } of tryUrls) {
    try {
      const resp = await client.get(url, { params })
      const items: any[] = resp.data?.data ?? resp.data?.records ?? (Array.isArray(resp.data) ? resp.data : [])
      for (const item of items) {
        const title = String(item.name || item.rfxName || item.title || '').trim(); if (!title) continue
        results.push({
          title, agency: item.org || item.department || 'North Carolina Agency',
          state: 'NC', contractLevel: 'STATE',
          naicsCode: null, estimatedValue: null,
          responseDeadline: tryDate(item.closeDate || item.dueDate),
          description: item.description?.slice(0, 500) || null,
          solicitationNumber: item.eventId || item.rfxId || null,
          contactEmail: item.buyerEmail || null,
          sourceUrl: item.eventId ? `https://eprocurement.nc.gov/prd/app/sourcing/RfxPublicDetail?eventId=${item.eventId}` : 'https://eprocurement.nc.gov',
          postedAt: tryDate(item.openDate || item.postedDate), source: 'NC_EPROCUREMENT',
        })
      }
      if (results.length) break
      // Try HTML parse fallback
      const htmlRows = parseTableRows(resp.data, 'NC', 'North Carolina Agency', 'NC_EPROCUREMENT', 'https://eprocurement.nc.gov')
      results.push(...htmlRows); if (htmlRows.length) break
    } catch { /* try next */ }
  }
  // Old IPS fallback
  if (!results.length) {
    for (let page = 1; page <= maxPages; page++) {
      try {
        const r2 = await client.get('https://www.ips.state.nc.us/ips/BidDetail.aspx', {
          params: { mode: 'all', page }, headers: { Accept: 'text/html' },
        })
        const added = parseTableRows(r2.data, 'NC', 'North Carolina Agency', 'NC_IPS', 'https://www.ips.state.nc.us/ips/')
        results.push(...added); if (!added.length) break; await sleep(500)
      } catch { break }
    }
  }
  if (!results.length) logger.warn('NC: all URLs returned no data')
  logger.info('NC complete', { count: results.length }); return results
}

export async function scrapeOHProcurement(maxPages = 3): Promise<StateOpportunityRecord[]> {
  const results: StateOpportunityRecord[] = []
  const client = httpClient()
  const tryBases = ['https://procure.ohio.gov', 'https://www.ohiobids.org']
  for (const BASE of tryBases) {
    try {
      for (let page = 1; page <= maxPages; page++) {
        const resp = await client.get(`${BASE}/proc/index.aspx`, { params: { action: 'oppListing', status: 'Open', page } })
        const added = parseTableRows(resp.data, 'OH', 'Ohio State Agency', 'OH_PROCURE', BASE)
        results.push(...added); if (!added.length) break; await sleep(500)
      }
      if (results.length) break
    } catch { /* try next base */ }
  }
  if (!results.length) logger.warn('OH Procurement: all URLs returned no data')
  logger.info('OH Procurement complete', { count: results.length }); return results
}

export async function scrapeILBidBuy(maxPages = 3): Promise<StateOpportunityRecord[]> {
  const results: StateOpportunityRecord[] = []
  const BASE = 'https://bidbuy.illinois.gov'
  const client = httpClient({ Accept: 'application/json, text/html, */*', 'Accept-Encoding': 'identity' })
  try {
    const resp = await client.get(`${BASE}/bso/external/publicBids.sdo`, {
      params: { searchType: 'ALL', statusCode: 'O', format: 'json', pageSize: 50, pageNumber: 1 },
      decompress: true,
    })
    const items: any[] = resp.data?.bids ?? resp.data?.data ?? (Array.isArray(resp.data) ? resp.data : [])
    for (const item of items) {
      const title = String(item.bidTitle || item.title || '').trim(); if (!title) continue
      results.push({
        title, agency: item.agency || item.orgName || 'Illinois Agency',
        state: 'IL', contractLevel: 'STATE',
        naicsCode: null, estimatedValue: null,
        responseDeadline: tryDate(item.closeDate || item.endDate),
        description: item.description?.slice(0, 500) || null,
        solicitationNumber: item.bidNumber || null, contactEmail: item.buyerEmail || null,
        sourceUrl: item.bidNumber ? `${BASE}/bso/external/bidDetail.sdo?docId=${item.bidNumber}` : BASE,
        postedAt: tryDate(item.openDate || item.startDate), source: 'IL_BIDBUY',
      })
    }
    if (!results.length) {
      for (let page = 1; page <= maxPages; page++) {
        try {
          const r2 = await client.get(`${BASE}/bso/external/publicBids.sdo`, {
            params: { searchType: 'ALL', statusCode: 'O', pageNumber: page }, headers: { Accept: 'text/html' },
          })
          const added = parseTableRows(r2.data, 'IL', 'Illinois Agency', 'IL_BIDBUY', BASE)
          results.push(...added); if (!added.length) break; await sleep(500)
        } catch { break }
      }
    }
  } catch (err) { logger.warn('IL BidBuy scrape failed', { error: (err as Error).message }) }
  logger.info('IL BidBuy complete', { count: results.length }); return results
}

export async function scrapeCAeProcure(maxPages = 3, user?: string, pass?: string): Promise<StateOpportunityRecord[]> {
  const results: StateOpportunityRecord[] = []
  const BASE = 'https://caleprocure.ca.gov'
  const client = httpClient({ Accept: 'application/json, text/html, */*' })

  let cookies = ''

  // Session auth when credentials provided
  if (user && pass) {
    try {
      // Load login page to get CSRF/viewstate tokens
      const loginPage = await client.get(`${BASE}/pages/public/login.aspx`, { httpsAgent: relaxedHttpsAgent })
      cookies = extractCookies(loginPage.headers['set-cookie'])
      const html: string = loginPage.data

      // Extract ASP.NET hidden fields
      const hiddenFields: Record<string, string> = {}
      for (const m of html.matchAll(/type="hidden"[^>]*name="([^"]*)"[^>]*value="([^"]*)"/gi)) {
        hiddenFields[m[1]] = m[2]
      }

      const loginResp = await client.post(
        `${BASE}/pages/public/login.aspx`,
        new URLSearchParams({
          ...hiddenFields,
          'ctl00$MainContent$txtUserName': user,
          'ctl00$MainContent$txtPassword': pass,
          'ctl00$MainContent$btnLogin': 'Sign In',
        }).toString(),
        {
          httpsAgent: relaxedHttpsAgent,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookies,
            Referer: `${BASE}/pages/public/login.aspx`,
          },
          maxRedirects: 10,
        },
      )
      cookies = [cookies, extractCookies(loginResp.headers['set-cookie'])].filter(Boolean).join('; ')
      logger.info('CA eProcure login succeeded')
    } catch (err) {
      logger.warn('CA eProcure login failed', { error: (err as Error).message })
    }
  }

  // Fetch bid listings (authenticated or public)
  try {
    for (let page = 1; page <= maxPages; page++) {
      const resp = await client.get(`${BASE}/pages/supplier/bid-contract-listing.aspx`, {
        httpsAgent: relaxedHttpsAgent,
        params: { status: 'A', page },
        headers: {
          Accept: 'text/html',
          ...(cookies ? { Cookie: cookies } : {}),
        },
      })
      const html: string = resp.data

      // Try JSON API response first
      const items: any[] = (typeof resp.data === 'object' && resp.data !== null)
        ? (resp.data?.bids ?? resp.data?.data ?? (Array.isArray(resp.data) ? resp.data : []))
        : []

      if (items.length) {
        for (const item of items) {
          const title = String(item.Bid_Title || item.bidTitle || item.TITLE || '').trim()
          if (!title) continue
          results.push({
            title, agency: item.Entity_Name || item.Department || 'California Agency',
            state: 'CA', contractLevel: 'STATE',
            naicsCode: null, estimatedValue: null,
            responseDeadline: tryDate(item.Bid_Close_Dt || item.closeDate),
            description: item.Bid_Description?.slice(0, 500) || null,
            solicitationNumber: item.Bid_No || item.bidNo || null,
            contactEmail: item.Contact_Email || null,
            sourceUrl: item.Bid_No ? `${BASE}/pages/supplier/bid-detail.aspx?BID_NO=${item.Bid_No}` : BASE,
            postedAt: tryDate(item.Bid_Open_Dt || item.openDate), source: 'CA_EPROCURE',
          })
        }
        break
      }

      // Parse HTML table
      const added = parseTableRows(html, 'CA', 'California Agency', 'CA_EPROCURE', BASE)
      results.push(...added)
      if (!added.length) break
      await sleep(500)
    }
  } catch (err) {
    logger.warn('CA eProcure fetch failed', { error: (err as Error).message })
  }

  logger.info('CA eProcure complete', { count: results.length })
  return results
}

export async function scrapeMDEmma(user?: string, pass?: string): Promise<StateOpportunityRecord[]> {
  const results: StateOpportunityRecord[] = []
  const BASE = 'https://emma.maryland.gov'
  const client = httpClient()
  try {
    let cookies = ''
    if (user && pass) {
      const loginPage = await client.get(`${BASE}/page.aspx/en/usr/login`)
      cookies = extractCookies(loginPage.headers['set-cookie'])
      const csrfM = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(loginPage.data)
      const csrf = csrfM?.[1] ?? ''
      const lr = await client.post(`${BASE}/page.aspx/en/usr/login`,
        new URLSearchParams({ UserName: user, Password: pass, __RequestVerificationToken: csrf }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies, Referer: `${BASE}/page.aspx/en/usr/login` }, maxRedirects: 5 })
      cookies = [cookies, extractCookies(lr.headers['set-cookie'])].filter(Boolean).join('; ')
    }
    const lr2 = await client.get(`${BASE}/page.aspx/en/bpm/process_manage_extranet/272`, { headers: cookies ? { Cookie: cookies } : {} })
    results.push(...parseTableRows(lr2.data, 'MD', 'Maryland Agency', 'MD_EMMA', BASE))
  } catch (err) { logger.warn('MD eMMA scrape failed', { error: (err as Error).message }) }
  logger.info('MD eMMA complete', { count: results.length }); return results
}

export async function scrapePAeMarketplace(user?: string, pass?: string): Promise<StateOpportunityRecord[]> {
  const results: StateOpportunityRecord[] = []
  if (!user || !pass) return results
  const BASE = 'https://www.pasupplierportal.state.pa.us'
  const client = httpClient()
  try {
    const lp = await client.get(`${BASE}/prd/fsproxy/proxy.ashx`, { params: { page: 'usr/login' } })
    const cookies = extractCookies(lp.headers['set-cookie'])
    const hf: Record<string, string> = {}
    for (const m of lp.data.matchAll(/type="hidden"[^>]*name="([^"]*)"[^>]*value="([^"]*)"/gi)) hf[m[1]] = m[2]
    const lr = await client.post(`${BASE}/prd/fsproxy/proxy.ashx?page=usr/login`,
      new URLSearchParams({ ...hf, 'ctl00$MainContent$txtUserID': user, 'ctl00$MainContent$txtPassword': pass, 'ctl00$MainContent$btnSubmit': 'Sign In' }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies, Referer: `${BASE}/prd/fsproxy/proxy.ashx?page=usr/login` }, maxRedirects: 10 })
    const ac = [cookies, extractCookies(lr.headers['set-cookie'])].filter(Boolean).join('; ')
    const list = await client.get(`${BASE}/prd/fsproxy/proxy.ashx`, { params: { page: 'opp/bidSearch', statusType: 'O' }, headers: { Cookie: ac } })
    results.push(...parseTableRows(list.data, 'PA', 'Pennsylvania Agency', 'PA_EMARKETPLACE', BASE))
  } catch (err) { logger.warn('PA eMarketplace scrape failed', { error: (err as Error).message }) }
  logger.info('PA eMarketplace complete', { count: results.length }); return results
}

export async function scrapeSamGovByState(samApiKey: string, maxStates = 20): Promise<StateOpportunityRecord[]> {
  const results: StateOpportunityRecord[] = []
  const client = httpClient({ Accept: 'application/json' })
  const today = new Date(); const from = new Date(today.getTime() - 90 * 86400000)
  const fmt = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
  for (const si of TOP_20_STATES.slice(0, maxStates)) {
    try {
      const resp = await client.get('https://api.sam.gov/opportunities/v2/search', {
        params: { api_key: samApiKey, postedFrom: fmt(from), postedTo: fmt(today), ptype: 'o,k,p,r', status: 'active', state: si.abbr, limit: 25, offset: 0 },
      })
      for (const opp of (resp.data?.opportunitiesData ?? [])) {
        const title = opp.title?.trim() || ''; if (!title) continue
        results.push({
          title, agency: opp.departmentName || opp.subtierName || `${si.name} Agency`,
          state: si.abbr, contractLevel: si.level,
          naicsCode: opp.naicsCode?.trim() || null, estimatedValue: null,
          responseDeadline: tryDate(opp.responseDeadLine),
          description: opp.description?.slice(0, 500) || null,
          solicitationNumber: opp.solicitationNumber || opp.noticeId || null,
          contactEmail: opp.pointOfContact?.[0]?.email || null,
          sourceUrl: opp.uiLink || (opp.noticeId ? `https://sam.gov/opp/${opp.noticeId}/view` : null),
          postedAt: tryDate(opp.postedDate), source: 'SAM_GOV',
        })
      }
      await sleep(400)
    } catch (err) { logger.warn(`SAM.gov failed for ${si.abbr}`, { error: (err as Error).message }) }
  }
  logger.info('SAM.gov state scrape complete', { count: results.length }); return results
}

export async function scrapeUSAspendingContracts(states: typeof TOP_20_STATES = TOP_20_STATES.slice(0, 10)): Promise<StateOpportunityRecord[]> {
  const results: StateOpportunityRecord[] = []
  const client = httpClient({ Accept: 'application/json' })
  const endDate = new Date().toISOString().split('T')[0]
  const startDate = new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0]
  for (const si of states) {
    try {
      const resp = await client.post('https://api.usaspending.gov/api/v2/search/spending_by_award/', {
        filters: {
          time_period: [{ start_date: startDate, end_date: endDate }],
          place_of_performance_states: [si.abbr],
          award_type_codes: ['A', 'B', 'C', 'D'],
        },
        fields: ['Award Amount', 'Recipient Name', 'Start Date', 'Award ID',
                 'Description', 'Awarding Agency', 'NAICS Code',
                 'Period of Performance Current End Date', 'Awarding Sub Agency'],
        page: 1, limit: 20, sort: 'Award Amount', order: 'desc', subawards: false,
      })
      for (const r of (resp.data?.results ?? [])) {
        const rawTitle = ((r['Description'] as string) || '').trim()
        const awardId = r['Award ID'] as string | null
        const agency = (r['Awarding Sub Agency'] || r['Awarding Agency'] || si.name) as string
        results.push({
          title: rawTitle || `${si.name} Contract -- ${agency}`,
          agency, state: si.abbr, contractLevel: si.level,
          naicsCode: r['NAICS Code'] as string | null,
          estimatedValue: r['Award Amount'] ? parseFloat(r['Award Amount'] as string) : null,
          responseDeadline: tryDate(r['Period of Performance Current End Date'] as string),
          description: `Awarded ${si.name} state contract. Recipient: ${r['Recipient Name'] || 'Unknown'}. Similar contracts are regularly re-bid.`,
          solicitationNumber: awardId, contactEmail: null,
          sourceUrl: awardId ? `https://www.usaspending.gov/award/${encodeURIComponent(awardId)}` : null,
          postedAt: tryDate(r['Start Date'] as string), source: 'USASPENDING',
        })
      }
      await sleep(800)
    } catch (err) { logger.warn(`USAspending failed for ${si.abbr}`, { error: (err as Error).message }) }
  }
  logger.info('USAspending complete', { count: results.length }); return results
}
