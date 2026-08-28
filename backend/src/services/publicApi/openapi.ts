// =============================================================
// §8.4 — The OpenAPI 3.1 description of Public API v1.
//
// One canonical document, checked in beside the router it describes, and
// pinned by a test that walks the router's own registered paths and fails when
// one is missing from here. Documentation that can drift silently is worse
// than none, because it is believed.
//
// Examples are invented values. No real token, key, tenant id or customer name
// appears anywhere in this file.
// =============================================================
import { PUBLIC_API_SCOPES, PUBLIC_API_SCOPE_DESCRIPTIONS } from './scopes'
import { TIER_RATE_LIMITS } from './rateLimit'

const errorResponse = {
  description: 'Error',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
      example: { error: { code: 'UNAUTHORIZED', message: 'That API token is not valid.', requestId: null } },
    },
  },
}

const pageParams = [
  { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 }, description: 'Page size. Values above 100 are clamped to 100.' },
  { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 }, description: 'Rows to skip.' },
]

function listOp(summary: string, scope: string, schemaRef: string, extraParams: unknown[] = []) {
  return {
    summary,
    security: [{ bearerAuth: [] }],
    'x-required-scope': scope,
    parameters: [...pageParams, ...extraParams],
    responses: {
      200: {
        description: 'A page of records.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                data: { type: 'array', items: { $ref: schemaRef } },
                meta: { $ref: '#/components/schemas/PageMeta' },
              },
            },
          },
        },
      },
      401: errorResponse, 403: errorResponse, 429: errorResponse,
    },
  }
}

function getOp(summary: string, scope: string, schemaRef: string) {
  return {
    summary,
    security: [{ bearerAuth: [] }],
    'x-required-scope': scope,
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      200: {
        description: 'One record.',
        content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: schemaRef } } } } },
      },
      401: errorResponse, 403: errorResponse, 404: errorResponse, 429: errorResponse,
    },
  }
}

const str = { type: 'string' } as const
const strNull = { type: ['string', 'null'] } as const

export const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'Bytescon Public API',
    version: '1.0.0',
    description: [
      'A read-only API over a firm\'s own Bytescon data.',
      '',
      'AUTHENTICATION — send an API token as `Authorization: Bearer <token>`. Tokens are minted by a firm ADMIN, shown once, and stored only as a hash. The tenant is determined by the token: sending a `consultingFirmId` in a query string or body is refused rather than ignored.',
      '',
      'SCOPES — each endpoint requires one scope, listed as `x-required-scope`. A token holds exactly the scopes it was minted with. Scopes are not roles.',
      '',
      'PAGINATION — every list endpoint returns `{ data, meta }`. `limit` defaults to 25 and is clamped to 100.',
      '',
      `RATE LIMITS — a fixed one-minute window per token: ${Object.entries(TIER_RATE_LIMITS).map(([t, n]) => `${t} ${n}/min`).join(', ')}. Responses carry \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\` and \`X-RateLimit-Reset\`; a 429 also carries \`Retry-After\`.`,
      '',
      'WRITES — there are none in v1. Bid decisions, proposal approval, submission, budget, purchase-order and invoice approval, payment, flow-down review, portal access grants and resume approval are human decisions and are not exposed to an API credential.',
    ].join('\n'),
  },
  servers: [{ url: '/api/v1', description: 'Version 1' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'An API token minted in Settings → API access.' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', enum: ['UNAUTHORIZED', 'INSUFFICIENT_SCOPE', 'NOT_FOUND', 'INVALID_REQUEST', 'TENANT_NOT_ADDRESSABLE', 'RATE_LIMITED', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR'] },
              message: str,
              requestId: strNull,
            },
            required: ['code', 'message'],
          },
        },
      },
      PageMeta: {
        type: 'object',
        properties: {
          limit: { type: 'integer' }, offset: { type: 'integer' },
          total: { type: 'integer' }, hasMore: { type: 'boolean' },
        },
      },
      Opportunity: {
        type: 'object',
        properties: {
          id: str, title: str, agency: str, subagency: strNull, solicitationNumber: strNull,
          naicsCode: strNull, psc: strNull, setAsideType: str, status: str,
          postedDate: strNull, responseDeadline: strNull, placeOfPerformance: strNull,
          estimatedValue: { ...strNull, description: 'Exact decimal string, or null.' },
          source: str, sourceUrl: strNull, createdAt: str,
        },
      },
      Pursuit: {
        type: 'object',
        properties: {
          id: str, opportunityId: str, opportunityTitle: strNull, status: str,
          pipelineStage: str, priority: str, nextAction: strNull, nextActionDueAt: strNull,
          closedAt: strNull, closeReason: strNull, decidedAt: strNull, lastActivityAt: str, createdAt: str,
        },
      },
      Contract: {
        type: 'object',
        properties: {
          id: str, contractNumber: str, title: str, agency: strNull, contractType: strNull,
          status: str, startDate: strNull, endDate: strNull,
          ceilingValue: strNull, fundedValue: strNull, createdAt: str,
        },
      },
      Contact: {
        type: 'object',
        properties: {
          id: str, kind: { type: 'string', enum: ['GOVERNMENT', 'PARTNER'] }, fullName: str,
          title: strNull, email: strNull, phone: strNull, organization: strNull,
          status: strNull, updatedAt: str,
        },
      },
      Partner: {
        type: 'object',
        properties: {
          id: str, name: str, uei: strNull, cage: strNull, partnerType: str,
          website: strNull, geography: strNull,
          capabilities: { type: 'array', items: str },
          certifications: { type: 'array', items: str },
          primaryNaicsCodes: { type: 'array', items: str },
          isActive: { type: 'boolean' }, updatedAt: str,
        },
      },
      Personnel: {
        type: 'object',
        properties: {
          id: str, firstName: str, lastName: str, jobTitle: strNull, employmentType: str,
          location: strNull,
          yearsExperienceStated: { type: ['integer', 'null'], description: 'Only what a human recorded. Never inferred from employment dates.' },
          verifiedLaborCategories: { type: 'array', items: str },
          hasApprovedResume: { type: 'boolean' }, isActive: { type: 'boolean' }, updatedAt: str,
        },
      },
    },
  },
  paths: {
    '/openapi.json': {
      get: { summary: 'This document.', security: [], responses: { 200: { description: 'The OpenAPI document.' } } },
    },
    '/scopes': {
      get: {
        summary: 'The scopes an API token may hold.',
        security: [],
        responses: {
          200: {
            description: 'Scope list.',
            content: {
              'application/json': {
                example: { data: PUBLIC_API_SCOPES.map((s) => ({ scope: s, description: PUBLIC_API_SCOPE_DESCRIPTIONS[s] })) },
              },
            },
          },
        },
      },
    },
    '/opportunities': {
      get: listOp('List opportunities.', 'opportunities:read', '#/components/schemas/Opportunity', [
        { name: 'status', in: 'query', schema: str },
        { name: 'agency', in: 'query', schema: str },
        { name: 'naicsCode', in: 'query', schema: str },
        { name: 'postedFrom', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'postedTo', in: 'query', schema: { type: 'string', format: 'date-time' } },
      ]),
    },
    '/opportunities/{id}': { get: getOp('Read one opportunity.', 'opportunities:read', '#/components/schemas/Opportunity') },
    '/pursuits': {
      get: listOp('List pursuits.', 'pursuits:read', '#/components/schemas/Pursuit', [
        { name: 'pipelineStage', in: 'query', schema: str },
        { name: 'includeClosed', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
      ]),
    },
    '/pursuits/{id}': { get: getOp('Read one pursuit.', 'pursuits:read', '#/components/schemas/Pursuit') },
    '/contracts': {
      get: listOp('List contracts.', 'contracts:read', '#/components/schemas/Contract', [
        { name: 'status', in: 'query', schema: str },
        { name: 'agency', in: 'query', schema: str },
      ]),
    },
    '/contracts/{id}': { get: getOp('Read one contract.', 'contracts:read', '#/components/schemas/Contract') },
    '/crm/contacts': {
      get: listOp('List contacts.', 'crm:read', '#/components/schemas/Contact', [
        { name: 'kind', in: 'query', schema: { type: 'string', enum: ['GOVERNMENT', 'PARTNER'] } },
      ]),
    },
    '/partners': { get: listOp('List teaming partners.', 'partners:read', '#/components/schemas/Partner') },
    '/personnel': {
      get: listOp('List personnel.', 'personnel:read', '#/components/schemas/Personnel', [
        { name: 'laborCategory', in: 'query', schema: str, description: 'Matches only VERIFIED qualifications.' },
      ]),
    },
    '/analytics/portfolio': {
      get: {
        summary: 'Aggregate portfolio counts and recorded contract ceiling.',
        security: [{ bearerAuth: [] }],
        'x-required-scope': 'analytics:read',
        responses: { 200: { description: 'Portfolio counts.' }, 401: errorResponse, 403: errorResponse, 429: errorResponse },
      },
    },
  },
} as const
