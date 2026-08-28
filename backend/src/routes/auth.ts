// =============================================================
// Auth Routes
// =============================================================
import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../config/database';
import { generateToken, authenticateJWT, requireRole, buildJwtPayload, setSessionCookie, clearSessionCookie } from '../middleware/auth';
import { checkUserLimit } from '../middleware/tierGate';
import { enforceTenantScope, getTenantId } from '../middleware/tenant';
import { AuthenticatedRequest } from '../types';
import { UnauthorizedError, NotFoundError, ConflictError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';
import { sendEmail, buildEmailVerificationUrl, buildPasswordResetUrl } from '../services/mailer';
import { passwordLoginAllowed } from '../services/sso/ssoService';
import { renderBrandedEmail } from '../services/brandedEmailTemplates';
import { logAudit } from '../services/auditService';
import { revokeUserTokens } from '../services/tokenRevocation';
import { runFirstIngest } from '../services/firstIngest';
import { EmailField, OptionalEmailField } from '../utils/email';
import { rejectScopedToken } from '../middleware/rejectScopedToken';
import { requirePlatformAdmin } from '../middleware/platformAdmin';
import { encryptSecret, decryptSecret } from '../utils/fieldCrypto';
import { generateMfaEnrollment, verifyTotp, generateRecoveryCodes, matchRecoveryCode } from '../services/mfaService';

// Build the standard authenticated-session response ({ token, user, firm }).
// Shared by /login, /complete-agreements, and /mfa/verify so the session shape
// stays identical across every issuance point.
function buildSessionData(user: {
  id: string
  email: string
  firstName: string
  lastName: string
  role: string
  consultingFirmId: string
  consultingFirm: { id: string; name: string }
}) {
  const token = generateToken(
    buildJwtPayload({ userId: user.id, consultingFirmId: user.consultingFirmId, role: user.role, email: user.email }),
  )
  return {
    token,
    user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role },
    firm: { id: user.consultingFirm.id, name: user.consultingFirm.name },
  }
}

// -------------------------------------------------------------
// Helpers — email verification + current legal versions
// -------------------------------------------------------------

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function issueEmailVerificationToken(userId: string): Promise<string> {
  const cryptoMod = await import('crypto');
  const token = cryptoMod.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
  await prisma.emailVerificationToken.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  await prisma.emailVerificationToken.create({
    data: { userId, token, expiresAt },
  });
  return token;
}

async function getCurrentLegalVersions() {
  const tos = await prisma.termsOfServiceVersion.findFirst({ where: { isCurrent: true } });
  if (!tos) {
    throw new Error('Legal documents are not seeded. Run `npm run db:seed`.');
  }
  return { tos };
}

async function userHasAcceptedCurrentLegal(userId: string): Promise<boolean> {
  const { tos } = await getCurrentLegalVersions();
  const tosOk = await prisma.userAgreement.findUnique({
    where: { userId_documentType_version: { userId, documentType: 'TOS', version: tos.version } },
  });
  return Boolean(tosOk);
}

// Stricter rate limit for login — 10 attempts per 15 minutes per IP
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many login attempts. Please wait 15 minutes.', code: 'RATE_LIMITED' },
});

// Firm registration limit — 10 signups per hour per IP. Defense-in-depth
// against mass account creation; the shared SAM.gov starter-ingest quota spend
// is additionally gated behind email verification (see /verify-email).
const registerRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many registration attempts. Please wait and try again.', code: 'RATE_LIMITED' },
});

const router = Router();
const passwordSchema = z
  .string()
  .min(12)
  .regex(/[A-Z]/, 'Must include uppercase')
  .regex(/[a-z]/, 'Must include lowercase')
  .regex(/[0-9]/, 'Must include number')
  .regex(/[^A-Za-z0-9]/, 'Must include symbol')

const LoginSchema = z.object({
  email: EmailField,
  password: z.string().min(1),
});

const RegisterFirmSchema = z.object({
  firmName: z.string().min(2).max(120),
  contactEmail: EmailField,
  firstName: z.string().min(1).max(60),
  lastName: z.string().min(1).max(60),
  email: OptionalEmailField,
  password: passwordSchema,
  acceptedTosVersion: z.string().min(1),
});

const RegisterUserSchema = z.object({
  email: EmailField,
  password: passwordSchema,
  firstName: z.string().min(1).max(60),
  lastName: z.string().min(1).max(60),
  role: z.enum(['ADMIN', 'CONSULTANT']).default('CONSULTANT'),
});

// Email-invite a read-only team member. The admin supplies only the name +
// email; the invitee sets their own password via the emailed link.
const InviteUserSchema = z.object({
  email: EmailField,
  firstName: z.string().min(1).max(60),
  lastName: z.string().min(1).max(60),
});

const AcceptAgreementsSchema = z.object({
  acceptedTosVersion: z.string().min(1),
});

/**
 * GET /api/auth/beta-status
 * Public — returns beta slot availability.
 */
router.get('/beta-status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // GA: signups are open (no slot cap). Endpoint retained for the SPA's
    // registration check; always reports open.
    const used = await prisma.consultingFirm.count({ where: { isTest: false } });
    res.json({
      success: true,
      data: {
        slotsTotal: -1,
        slotsUsed: used,
        slotsRemaining: -1,
        isBetaOpen: true,
      },
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/auth/register-firm
 * Creates tenant + first admin user. Requires acceptance of the
 * current ToS. User must verify their email (and accept
 * agreements during signup) before login is permitted.
 */
router.post('/register-firm', registerRateLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = RegisterFirmSchema.parse(req.body);
    const adminEmail = body.email || body.contactEmail;

    // GA: open self-serve signups (no slot cap).

    // Legal version gate — must accept the current ToS version.
    const { tos } = await getCurrentLegalVersions();
    if (body.acceptedTosVersion !== tos.version) {
      return res.status(409).json({
        success: false,
        error: `Terms of Service have been updated. Please accept v${tos.version}.`,
        code: 'TOS_VERSION_MISMATCH',
        currentVersion: tos.version,
      });
    }

    const existingFirm = await prisma.consultingFirm.findUnique({
      where: { contactEmail: body.contactEmail },
      select: { id: true },
    });
    if (existingFirm) throw new ConflictError('A firm with this contact email already exists');

    const existingUser = await prisma.user.findUnique({
      where: { email: adminEmail },
      select: { id: true },
    });
    if (existingUser) throw new ConflictError('A user with this email already exists');

    const passwordHash = await bcrypt.hash(body.password, 12);
    const ip = req.ip ?? null;
    const userAgent = req.get('user-agent') ?? null;

    const created = await prisma.$transaction(async (tx) => {
      const firm = await tx.consultingFirm.create({
        data: {
          name: body.firmName,
          contactEmail: body.contactEmail,
          // Trial grant: enough tokens to exercise every AI feature during the
          // 14-day all-access trial (outline = 1, full draft = 5). Ongoing
          // tokens come from the add-on modules the firm subscribes to.
          proposalTokens: 25,
        },
      });

      const user = await tx.user.create({
        data: {
          consultingFirmId: firm.id,
          email: adminEmail,
          passwordHash,
          firstName: body.firstName,
          lastName: body.lastName,
          role: 'ADMIN',
          isActive: true,
          isEmailVerified: false,
        },
      });

      // Persist immutable evidence of acceptance — version + contentHash
      // are pinned to whatever was current at the moment of signup.
      await tx.userAgreement.createMany({
        data: [
          {
            userId: user.id,
            documentType: 'TOS',
            documentId: tos.id,
            version: tos.version,
            contentHash: tos.contentHash,
            ip,
            userAgent,
          },
        ],
      });

      return { firm, user };
    });

    // Issue a verification token and send the email. In dev (no mail
    // provider configured) the URL is logged to the server log only —
    // never returned in the response, so this endpoint is safe to expose.
    const verificationToken = await issueEmailVerificationToken(created.user.id);
    const verificationUrl = buildEmailVerificationUrl(verificationToken);
    const verifyEmail = await renderBrandedEmail({
      firmId: created.firm.id,
      recipientName: created.user.firstName,
      subject: 'Verify your Bytes Platform GovCon account',
      preheader: 'Confirm your email to activate your account.',
      bodyHtml: `<p>Welcome to Bytes Platform GovCon. Confirm your email address to activate your account.</p><p style="color:#94a3b8;font-size:13px;">This link expires in 24 hours.</p>`,
      ctaUrl: verificationUrl,
      ctaText: 'Verify my email',
    });
    const mailResult = await sendEmail({
      to: adminEmail,
      subject: 'Verify your Bytes Platform GovCon account',
      category: 'EMAIL_VERIFICATION',
      htmlBody: verifyEmail.html,
      textBody: verifyEmail.text,
      consultingFirmId: created.firm.id,
      actorUserId: created.user.id,
    });
    if (!mailResult.delivered && !mailResult.devFallback) {
      logger.warn('Registration verification email failed to send', {
        userId: created.user.id,
        provider: mailResult.provider,
        error: mailResult.error,
      });
    }
    if (mailResult.devFallback && process.env.NODE_ENV !== 'production') {
      logger.info('Dev mailer fallback — verification URL', { userId: created.user.id, url: verificationUrl });
    }

    void logAudit({
      consultingFirmId: created.firm.id,
      actorUserId: created.user.id,
      action: 'CREATE',
      entityType: 'User',
      entityId: created.user.id,
      rationale: 'Firm registration; awaiting email verification',
      sourceIp: ip,
      userAgent,
    });

    res.status(201).json({
      success: true,
      data: {
        requiresEmailVerification: true,
        email: created.user.email,
        firmName: created.firm.name,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/login
 */
router.post('/login', loginRateLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = LoginSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email },
      include: { consultingFirm: true },
    });

    if (!user || !user.isActive || !user.consultingFirm.isActive) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedError('Invalid credentials');
    }

    // Gate 0 — §8.5. When the firm enforces single sign-on, a password is no
    // longer a way in, except for the break-glass accounts it nominated. The
    // check runs AFTER the password comparison on purpose: refusing earlier
    // would tell an anonymous caller which addresses belong to an
    // SSO-enforcing organization.
    const ssoDecision = await passwordLoginAllowed(user.consultingFirmId, user.email);
    if (!ssoDecision.allowed) {
      return res.status(403).json({
        success: false,
        error: 'Your organization requires single sign-on. Use the sign-in link for your organization.',
        code: 'SSO_REQUIRED',
      });
    }

    // Gate 1 — email must be verified before any session is issued.
    if (!user.isEmailVerified) {
      return res.status(403).json({
        success: false,
        error: 'Verify your email before signing in. Check your inbox for the verification link.',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }

    // Gate 2 — current ToS must be accepted. Issue a SCOPED
    // completion token (scope='accept_agreements') that ONLY the
    // /api/auth/complete-agreements endpoint accepts; full-access
    // routes (rejectScopedToken or scope guard) refuse it.
    const agreementsOk = await userHasAcceptedCurrentLegal(user.id);
    if (!agreementsOk) {
      const { tos } = await getCurrentLegalVersions();
      const completionToken = generateToken(buildJwtPayload({
        userId: user.id,
        consultingFirmId: user.consultingFirmId,
        role: user.role,
        email: user.email,
        scope: 'accept_agreements',
      }));
      return res.status(403).json({
        success: false,
        error: 'You must accept the current Terms of Service before signing in.',
        code: 'AGREEMENT_REQUIRED',
        currentVersions: { tosVersion: tos.version },
        completionToken,
      });
    }

    // GA: no weekly-questionnaire login gate. Login proceeds once email is
    // verified (Gate 1) and current legal is accepted (Gate 2).

    // Gate 3 — MFA. If enabled, do NOT issue a full session; return a scoped
    // mfa_challenge token the user exchanges at POST /api/auth/mfa/verify for the
    // real session (mirrors the accept_agreements gate).
    if (user.mfaEnabled) {
      const mfaChallengeToken = generateToken(buildJwtPayload({
        userId: user.id,
        consultingFirmId: user.consultingFirmId,
        role: user.role,
        email: user.email,
        scope: 'mfa_challenge',
      }));
      return res.status(403).json({
        success: false,
        error: 'Enter the 6-digit code from your authenticator app.',
        code: 'MFA_REQUIRED',
        mfaChallengeToken,
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const token = generateToken(buildJwtPayload({
      userId: user.id,
      consultingFirmId: user.consultingFirmId,
      role: user.role,
      email: user.email,
    }));

    void logAudit({
      consultingFirmId: user.consultingFirmId,
      actorUserId: user.id,
      action: 'LOGIN',
      entityType: 'User',
      entityId: user.id,
      sourceIp: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });

    setSessionCookie(res, token);
    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
        },
        firm: {
          id: user.consultingFirm.id,
          name: user.consultingFirm.name,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/logout
 * Clears the http-only session cookie. Because the cookie is httpOnly it is
 * unreadable/unclearable from page JS, so the client calls this to end the
 * session. Always succeeds (idempotent) so the UI can clear local state even
 * if no valid session is present.
 */
router.post('/logout', (req: Request, res: Response) => {
  clearSessionCookie(res);
  res.json({ success: true, message: 'Logged out.' });
});

/**
 * GET /api/auth/profile
 */
router.get(
  '/profile',
  authenticateJWT,
  rejectScopedToken,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        include: { consultingFirm: true },
      });

      if (!user) throw new NotFoundError('User');

      res.json({
        success: true,
        data: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          consultingFirm: user.consultingFirm,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/auth/register-user
 * Adds a user inside the current tenant. ADMIN only.
 */
router.post(
  '/register-user',
  authenticateJWT,
  enforceTenantScope,
  requireRole('ADMIN'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const body = RegisterUserSchema.parse(req.body);
      const consultingFirmId = getTenantId(req);

      const existing = await prisma.user.findUnique({
        where: { email: body.email },
        select: { id: true },
      });
      if (existing) throw new ConflictError('A user with this email already exists');

      const user = await prisma.user.create({
        data: {
          consultingFirmId,
          email: body.email,
          passwordHash: await bcrypt.hash(body.password, 12),
          firstName: body.firstName,
          lastName: body.lastName,
          role: body.role,
          isActive: true,
          isEmailVerified: false,
        },
      });

      // Email-verify the new tenant user. They will also be prompted to
      // accept the current ToS on first sign-in. In dev (no
      // mail provider configured) the URL is logged server-side only.
      const verificationToken = await issueEmailVerificationToken(user.id);
      const verificationUrl = buildEmailVerificationUrl(verificationToken);
      const inviteEmail = await renderBrandedEmail({
        firmId: consultingFirmId,
        recipientName: user.firstName,
        subject: 'You have been added to a Bytes Platform GovCon workspace',
        preheader: 'Verify your email to activate your team-member account.',
        bodyHtml: `<p>You were invited to a Bytes Platform GovCon workspace. Confirm your email address to activate your account.</p><p style="color:#94a3b8;font-size:13px;">This link expires in 24 hours.</p>`,
        ctaUrl: verificationUrl,
        ctaText: 'Verify my email',
      });
      const mailResult = await sendEmail({
        to: user.email,
        subject: 'You have been added to a Bytes Platform GovCon workspace',
        category: 'EMAIL_VERIFICATION',
        htmlBody: inviteEmail.html,
        textBody: inviteEmail.text,
        consultingFirmId,
        actorUserId: user.id,
      });
      if (!mailResult.delivered && !mailResult.devFallback) {
        logger.warn('Invite verification email failed to send', {
          userId: user.id,
          provider: mailResult.provider,
          error: mailResult.error,
        });
      }
      if (mailResult.devFallback && process.env.NODE_ENV !== 'production') {
        logger.info('Dev mailer fallback — verification URL', { userId: user.id, url: verificationUrl });
      }

      logger.info('User registered (verification pending)', {
        consultingFirmId,
        createdUserId: user.id,
        createdBy: req.user?.userId,
      });

      void logAudit({
        consultingFirmId,
        actorUserId: req.user?.userId ?? null,
        action: 'CREATE',
        entityType: 'User',
        entityId: user.id,
        rationale: 'Admin-invited user; verification pending',
        sourceIp: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });

      res.status(201).json({
        success: true,
        data: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          requiresEmailVerification: true,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/auth/invite-user
 * Email-invites a read-only (CONSULTANT) team member into the current tenant.
 * The invitee receives an emailed link and sets their own password (which also
 * verifies their email, see /reset-password). ADMIN only.
 */
router.post(
  '/invite-user',
  authenticateJWT,
  enforceTenantScope,
  requireRole('ADMIN'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const body = InviteUserSchema.parse(req.body);
      const consultingFirmId = getTenantId(req);

      const existing = await prisma.user.findUnique({
        where: { email: body.email },
        select: { id: true },
      });
      if (existing) throw new ConflictError('A user with this email already exists');

      // Seat limit — a firm may only invite up to its plan's maxUsers
      // (Starter = 1 seat / owner only; higher tiers scale up; unlimited = -1).
      const seat = await checkUserLimit(consultingFirmId);
      if (!seat.allowed) {
        return res.status(403).json({
          success: false,
          code: 'TIER_LIMIT',
          error: seat.max <= 1
            ? 'Your plan includes a single seat (just you). Upgrade to invite team members.'
            : `Your plan includes ${seat.max} seats and all are in use. Upgrade your plan to invite more.`,
        });
      }

      // Create the read-only member with an unusable random password; the
      // invitee sets their real one via the emailed link.
      const cryptoMod = await import('crypto');
      const randomPassword = cryptoMod.randomBytes(48).toString('hex');
      const user = await prisma.user.create({
        data: {
          consultingFirmId,
          email: body.email,
          passwordHash: await bcrypt.hash(randomPassword, 12),
          firstName: body.firstName,
          lastName: body.lastName,
          role: 'CONSULTANT',
          isActive: true,
          isEmailVerified: false,
        },
      });

      // Issue a password-set token (reuses the reset-password flow) with a
      // generous invite TTL.
      const token = cryptoMod.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
      await prisma.passwordResetToken.create({
        data: { userId: user.id, token, expiresAt },
      });

      const inviteUrl = `${buildPasswordResetUrl(token)}&invite=1`;
      const inviterName = req.user?.email ?? 'A teammate';
      const inviteEmail = await renderBrandedEmail({
        firmId: consultingFirmId,
        recipientName: user.firstName,
        subject: "You've been invited to a Bytes Platform GovCon workspace",
        preheader: 'Set your password to activate your team-member account.',
        bodyHtml: `<p>${inviterName} invited you to join their Bytes Platform GovCon workspace as a team member.</p><p>Click below to set your password and sign in. You'll have read-only access to the workspace.</p><p style="color:#94a3b8;font-size:13px;">This link expires in 7 days.</p>`,
        ctaUrl: inviteUrl,
        ctaText: 'Set my password',
      });
      const mailResult = await sendEmail({
        to: user.email,
        subject: "You've been invited to a Bytes Platform GovCon workspace",
        category: 'EMAIL_VERIFICATION',
        htmlBody: inviteEmail.html,
        textBody: inviteEmail.text,
        consultingFirmId,
        actorUserId: user.id,
      });
      if (!mailResult.delivered && !mailResult.devFallback) {
        logger.warn('Team-member invite email failed to send', {
          userId: user.id,
          provider: mailResult.provider,
          error: mailResult.error,
        });
      }
      if (mailResult.devFallback && process.env.NODE_ENV !== 'production') {
        logger.info('Dev mailer fallback — invite URL', { userId: user.id, url: inviteUrl });
      }

      void logAudit({
        consultingFirmId,
        actorUserId: req.user?.userId ?? null,
        action: 'CREATE',
        entityType: 'User',
        entityId: user.id,
        rationale: 'Admin-invited read-only team member; password-set pending',
        sourceIp: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });

      res.status(201).json({
        success: true,
        data: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          requiresPasswordSetup: true,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /api/auth/change-password
 * Authenticated user changes their own password.
 */
router.put(
  '/change-password',
  authenticateJWT,
  rejectScopedToken,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const schema = z.object({
        currentPassword: z.string().min(1),
        newPassword: passwordSchema,
      });
      const { currentPassword, newPassword } = schema.parse(req.body);

      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
      });
      if (!user) throw new NotFoundError('User');

      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) throw new UnauthorizedError('Current password is incorrect');

      const passwordHash = await bcrypt.hash(newPassword, 12);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });

      logger.info('User changed password', { userId: user.id });

      res.json({ success: true, message: 'Password updated successfully' });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/auth/forgot-password
 * Generates a password reset token (valid 1 hour).
 * In production, this would send an email. For now, returns the token in response
 * so the frontend can redirect to the reset page.
 */
router.post('/forgot-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = z.object({ email: EmailField }).parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, firstName: true, consultingFirmId: true },
    });

    // Always return success to prevent email enumeration
    if (!user) {
      return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
    }

    // Generate a secure random token
    const crypto = await import('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Invalidate any existing tokens for this user
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    await prisma.passwordResetToken.create({
      data: { userId: user.id, token, expiresAt },
    });

    logger.info('Password reset token generated', { userId: user.id });

    const resetUrl = buildPasswordResetUrl(token);
    const resetEmail = await renderBrandedEmail({
      firmId: user.consultingFirmId,
      recipientName: user.firstName,
      subject: 'Bytes Platform GovCon — password reset link',
      preheader: 'Reset your password — this link expires in 1 hour.',
      bodyHtml: `<p>We received a request to reset your password. Click below to choose a new one.</p><p style="color:#94a3b8;font-size:13px;">This link expires in 1 hour. If you didn't request a reset, you can safely ignore this email.</p>`,
      ctaUrl: resetUrl,
      ctaText: 'Reset my password',
    });
    const mailResult = await sendEmail({
      to: user.email,
      subject: 'Bytes Platform GovCon — password reset link',
      category: 'PASSWORD_RESET',
      htmlBody: resetEmail.html,
      textBody: resetEmail.text,
      consultingFirmId: user.consultingFirmId,
      actorUserId: user.id,
    });
    if (!mailResult.delivered && !mailResult.devFallback) {
      logger.warn('Password-reset email failed to send', {
        userId: user.id,
        provider: mailResult.provider,
        error: mailResult.error,
      });
    }
    if (mailResult.devFallback && process.env.NODE_ENV !== 'production') {
      logger.info('Dev mailer fallback — password reset URL', { userId: user.id, url: resetUrl });
    }

    res.json({
      success: true,
      message: 'If that email exists, a reset link has been sent.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/reset-password
 * Resets password using a valid token.
 */
router.post('/reset-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      token: z.string().min(1),
      newPassword: passwordSchema,
    });
    const { token, newPassword } = schema.parse(req.body);

    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired reset token. Please request a new one.',
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: resetToken.userId },
        // Setting a password via an emailed link also proves control of the
        // inbox, so confirm the email here. This is what activates an invited
        // team member (created unverified) for their first sign-in. No-op for
        // ordinary forgot-password users, who are already verified.
        data: { passwordHash, isEmailVerified: true, emailVerifiedAt: new Date() },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      }),
    ]);

    // Invalidate every session minted before this reset so a leaked/old token
    // (or the attacker who triggered the reset flow) can't keep using it.
    await revokeUserTokens(resetToken.userId);

    logger.info('Password reset completed', { userId: resetToken.userId });

    res.json({ success: true, message: 'Password has been reset. You can now sign in.' });
  } catch (err) {
    next(err);
  }
});

// =============================================================
// LEGAL — current ToS, post-signup acceptance flow
// =============================================================

/**
 * GET /api/auth/legal/current
 * Public — returns the current ToS (version, hash, body)
 * so the signup screen can display it and pin the version the user
 * is accepting.
 */
router.get('/legal/current', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { tos } = await getCurrentLegalVersions();
    res.json({
      success: true,
      data: {
        tos: { version: tos.version, title: tos.title, contentHash: tos.contentHash, body: tos.body, effectiveAt: tos.effectiveAt },
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/verify-email { token }
 * Marks the user's email as verified. Public — token-bound.
 */
router.post('/verify-email', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.body);

    const record = await prisma.emailVerificationToken.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!record || record.consumedAt || record.expiresAt < new Date()) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired verification token. Request a new one.',
        code: 'INVALID_OR_EXPIRED',
      });
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { isEmailVerified: true, emailVerifiedAt: new Date() },
      }),
      prisma.emailVerificationToken.update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      }),
    ]);

    void logAudit({
      consultingFirmId: record.user.consultingFirmId,
      actorUserId: record.user.id,
      action: 'EMAIL_VERIFIED',
      entityType: 'User',
      entityId: record.user.id,
      sourceIp: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });

    res.json({
      success: true,
      message: 'Email verified. You can now sign in.',
    });

    // Kick off a bounded "starter board" ingest so the firm sees recent SAM.gov
    // opportunities the moment they first sign in — no API key required on their
    // end. Triggered here (not at signup) so the shared SAM.gov quota is only
    // ever spent on confirmed inboxes; runFirstIngest self-guards to run once
    // per firm (skips if already ingested) and swallows its own errors, so this
    // void call can never block or break email verification.
    void runFirstIngest(record.user.consultingFirmId);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/resend-verification { email }
 * Public, rate-limited. Always returns success to prevent enumeration.
 */
router.post(
  '/resend-verification',
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many resend attempts. Try again later.', code: 'RATE_LIMITED' },
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = z.object({ email: EmailField }).parse(req.body);
      const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, firstName: true, isEmailVerified: true, email: true, consultingFirmId: true },
      });

      // Always respond success to avoid revealing whether the email exists.
      if (!user || user.isEmailVerified) {
        return res.json({ success: true, message: 'If an unverified account exists, a new link has been sent.' });
      }

      const token = await issueEmailVerificationToken(user.id);
      const url = buildEmailVerificationUrl(token);
      const resendEmail = await renderBrandedEmail({
        firmId: user.consultingFirmId,
        recipientName: user.firstName,
        subject: 'Bytes Platform GovCon — new verification link',
        preheader: 'Here is your new email verification link.',
        bodyHtml: `<p>Here is a new link to verify your email and activate your account.</p><p style="color:#94a3b8;font-size:13px;">This link expires in 24 hours.</p>`,
        ctaUrl: url,
        ctaText: 'Verify my email',
      });
      const result = await sendEmail({
        to: user.email,
        subject: 'Bytes Platform GovCon — new verification link',
        category: 'EMAIL_VERIFICATION',
        htmlBody: resendEmail.html,
        textBody: resendEmail.text,
        consultingFirmId: user.consultingFirmId,
        actorUserId: user.id,
      });

      // Surface delivery failure in logs so operators see broken-mailer
      // states immediately. Public response stays anti-enumeration-safe.
      if (!result.delivered && !result.devFallback) {
        logger.warn('Verification email failed to send', {
          userId: user.id,
          provider: result.provider,
          error: result.error,
        });
      }

      // Dev fallback: surface the URL only when we know we did not send,
      // and only in non-production. Production never leaks the token.
      const includeDevUrl = result.devFallback && process.env.NODE_ENV !== 'production';
      if (includeDevUrl) {
        logger.info('Dev mailer fallback — verification URL', { userId: user.id, url });
      }

      res.json({ success: true, message: 'If an unverified account exists, a new link has been sent.' });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/auth/accept-agreements
 * Authenticated. Records acceptance of the current ToS. Used
 * when an existing user must re-accept after a version bump (or when an
 * admin-invited user accepts on first sign-in).
 */
router.post(
  '/accept-agreements',
  authenticateJWT,
  rejectScopedToken,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const body = AcceptAgreementsSchema.parse(req.body);
      const { tos } = await getCurrentLegalVersions();

      if (body.acceptedTosVersion !== tos.version) {
        return res.status(409).json({
          success: false,
          error: 'Stale Terms of Service version. Please reload and accept the latest.',
          code: 'TOS_VERSION_MISMATCH',
          currentVersion: tos.version,
        });
      }

      const userId = req.user!.userId;
      const ip = req.ip ?? null;
      const userAgent = req.get('user-agent') ?? null;

      await prisma.userAgreement.createMany({
        data: [
          { userId, documentType: 'TOS', documentId: tos.id, version: tos.version, contentHash: tos.contentHash, ip, userAgent },
        ],
        skipDuplicates: true,
      });

      void logAudit({
        consultingFirmId: req.user!.consultingFirmId,
        actorUserId: userId,
        action: 'AGREEMENT_ACCEPTED',
        entityType: 'UserAgreement',
        entityId: userId,
        rationale: `Accepted ToS v${tos.version}`,
        sourceIp: ip,
        userAgent,
      });

      res.json({ success: true, message: 'Agreements recorded.' });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/auth/complete-agreements
 * Accepts EITHER a full session JWT OR a scoped completionToken
 * (scope='accept_agreements') issued by login gate-2. On success:
 * records the UserAgreement rows, runs gate-3 questionnaire check,
 * and either issues a full session JWT or hands off to the
 * questionnaire flow with a new scoped token.
 *
 * This is the only endpoint an accept_agreements scoped token can reach.
 */
router.post(
  '/complete-agreements',
  authenticateJWT,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const tokenScope = (req.user as any)?.scope;
      if (tokenScope && tokenScope !== 'accept_agreements') {
        return res.status(403).json({
          success: false,
          error: 'This endpoint requires a full session or accept_agreements scoped token.',
          code: 'WRONG_SCOPE',
        });
      }

      const body = AcceptAgreementsSchema.parse(req.body);
      const { tos } = await getCurrentLegalVersions();

      if (body.acceptedTosVersion !== tos.version) {
        return res.status(409).json({
          success: false,
          error: 'Stale Terms of Service version. Please reload and accept the latest.',
          code: 'TOS_VERSION_MISMATCH',
          currentVersion: tos.version,
        });
      }

      const userId = req.user!.userId;
      const consultingFirmId = req.user!.consultingFirmId;
      const role = req.user!.role;
      const email = req.user!.email;
      const ip = req.ip ?? null;
      const userAgent = req.get('user-agent') ?? null;

      await prisma.userAgreement.createMany({
        data: [
          { userId, documentType: 'TOS', documentId: tos.id, version: tos.version, contentHash: tos.contentHash, ip, userAgent },
        ],
        skipDuplicates: true,
      });

      void logAudit({
        consultingFirmId,
        actorUserId: userId,
        action: 'AGREEMENT_ACCEPTED',
        entityType: 'UserAgreement',
        entityId: userId,
        rationale: `Accepted ToS v${tos.version} via login gate`,
        sourceIp: ip,
        userAgent,
      });

      // GA: no weekly-questionnaire gate — issue the full session now that
      // email is verified and current legal is accepted.
      const fullToken = generateToken(buildJwtPayload({ userId, consultingFirmId, role, email }));

      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { consultingFirm: true },
      });
      if (!user) throw new NotFoundError('User');

      // Gate 3 — MFA also gates the ToS-completion session-issuance path; without
      // this a user with pending ToS + MFA could obtain a full session here and
      // bypass the second factor.
      if (user.mfaEnabled) {
        const mfaChallengeToken = generateToken(buildJwtPayload({
          userId: user.id,
          consultingFirmId: user.consultingFirmId,
          role: user.role,
          email: user.email,
          scope: 'mfa_challenge',
        }));
        return res.status(403).json({
          success: false,
          error: 'Enter the 6-digit code from your authenticator app.',
          code: 'MFA_REQUIRED',
          mfaChallengeToken,
        });
      }

      await prisma.user.update({
        where: { id: userId },
        data: { lastLoginAt: new Date() },
      });

      void logAudit({
        consultingFirmId,
        actorUserId: userId,
        action: 'LOGIN',
        entityType: 'User',
        entityId: userId,
        sourceIp: ip,
        userAgent,
      });

      setSessionCookie(res, fullToken);
      res.json({
        success: true,
        data: {
          token: fullToken,
          user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
          },
          firm: {
            id: user.consultingFirm.id,
            name: user.consultingFirm.name,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// =============================================================
// MFA (TOTP) — opt-in two-factor. See FIXES.md FIX-3.
// The mfa_challenge scoped token can only reach /mfa/verify: enforceTenantScope
// rejects scoped tokens on every data route, and the full-session MFA endpoints
// below add rejectScopedToken. Its holder has proven the password, not yet 2FA.
// =============================================================
const MfaCodeSchema = z.object({ code: z.string().min(1) });

// Per-account throttle on code-guessing MFA endpoints (keyed on userId, IP
// fallback) — the second factor must not be weaker than the password gate.
const mfaRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthenticatedRequest).user?.userId || req.ip || 'unknown',
  message: { success: false, error: 'Too many attempts. Please wait a few minutes and try again.', code: 'RATE_LIMITED' },
});

// GET /api/auth/mfa/status — is MFA enabled for the current user?
router.get('/mfa/status', authenticateJWT, rejectScopedToken, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { mfaEnabled: true } });
    res.json({ success: true, data: { enabled: !!u?.mfaEnabled } });
  } catch (err) { next(err); }
});

// POST /api/auth/mfa/enroll — begin enrollment; store an unconfirmed (encrypted) secret.
router.post('/mfa/enroll', authenticateJWT, rejectScopedToken, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { email: true, mfaEnabled: true } });
    if (!u) throw new NotFoundError('User');
    if (u.mfaEnabled) throw new ValidationError('MFA is already enabled. Disable it before re-enrolling.');
    const { secret, otpauthUri } = generateMfaEnrollment(u.email);
    await prisma.user.update({ where: { id: req.user!.userId }, data: { mfaSecret: encryptSecret(secret) } });
    res.json({ success: true, data: { secret, otpauthUri } });
  } catch (err) { next(err); }
});

// POST /api/auth/mfa/enroll/verify — confirm the code, enable MFA, return recovery codes ONCE.
router.post('/mfa/enroll/verify', authenticateJWT, rejectScopedToken, mfaRateLimit, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { code } = MfaCodeSchema.parse(req.body);
    const u = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { mfaSecret: true } });
    if (!u?.mfaSecret) throw new ValidationError('Start enrollment first (POST /mfa/enroll).');
    if (!verifyTotp(decryptSecret(u.mfaSecret), code)) {
      throw new UnauthorizedError('Invalid code. Check your authenticator app and try again.');
    }
    const { plain, hashed } = await generateRecoveryCodes(10);
    await prisma.user.update({
      where: { id: req.user!.userId },
      data: { mfaEnabled: true, mfaEnrolledAt: new Date(), mfaRecoveryCodes: hashed },
    });
    void logAudit({ consultingFirmId: req.user!.consultingFirmId, actorUserId: req.user!.userId, action: 'UPDATE', entityType: 'User', entityId: req.user!.userId, rationale: 'MFA enabled', sourceIp: req.ip ?? null, userAgent: req.get('user-agent') ?? null });
    res.json({ success: true, data: { recoveryCodes: plain } });
  } catch (err) { next(err); }
});

// POST /api/auth/mfa/verify — exchange the mfa_challenge token + code for a full session.
router.post('/mfa/verify', authenticateJWT, mfaRateLimit, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if ((req.user as { scope?: string } | undefined)?.scope !== 'mfa_challenge') {
      return res.status(403).json({ success: false, error: 'This endpoint requires an MFA challenge token.', code: 'WRONG_SCOPE' });
    }
    const { code } = MfaCodeSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, include: { consultingFirm: true } });
    if (!user || !user.isActive || !user.consultingFirm.isActive || !user.mfaEnabled || !user.mfaSecret) {
      throw new UnauthorizedError('MFA is not configured for this account.');
    }

    let ok = verifyTotp(decryptSecret(user.mfaSecret), code);
    if (!ok) {
      const idx = await matchRecoveryCode(user.mfaRecoveryCodes, code);
      if (idx >= 0) {
        const usedHash = user.mfaRecoveryCodes[idx];
        // Atomically consume exactly this recovery code (array_remove + presence
        // guard) so concurrent requests can't double-use or un-consume a code.
        const consumed = await prisma.$executeRaw`UPDATE "users" SET "mfaRecoveryCodes" = array_remove("mfaRecoveryCodes", ${usedHash}) WHERE "id" = ${user.id} AND ${usedHash} = ANY("mfaRecoveryCodes")`;
        if (consumed > 0) {
          ok = true;
          void logAudit({ consultingFirmId: user.consultingFirmId, actorUserId: user.id, action: 'UPDATE', entityType: 'User', entityId: user.id, rationale: 'MFA recovery code used', sourceIp: req.ip ?? null, userAgent: req.get('user-agent') ?? null });
        }
      }
    }
    if (!ok) throw new UnauthorizedError('Invalid code.');

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    void logAudit({ consultingFirmId: user.consultingFirmId, actorUserId: user.id, action: 'LOGIN', entityType: 'User', entityId: user.id, rationale: 'MFA verified', sourceIp: req.ip ?? null, userAgent: req.get('user-agent') ?? null });
    const sessionData = buildSessionData(user);
    setSessionCookie(res, sessionData.token);
    res.json({ success: true, data: sessionData });
  } catch (err) { next(err); }
});

// POST /api/auth/mfa/disable — turn MFA off (requires a valid TOTP or recovery code).
router.post('/mfa/disable', authenticateJWT, rejectScopedToken, mfaRateLimit, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { code } = MfaCodeSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { mfaEnabled: true, mfaSecret: true, mfaRecoveryCodes: true } });
    if (!user?.mfaEnabled || !user.mfaSecret) throw new ValidationError('MFA is not enabled.');
    const ok = verifyTotp(decryptSecret(user.mfaSecret), code) || (await matchRecoveryCode(user.mfaRecoveryCodes, code)) >= 0;
    if (!ok) throw new UnauthorizedError('Invalid code.');
    await prisma.user.update({ where: { id: req.user!.userId }, data: { mfaEnabled: false, mfaSecret: null, mfaRecoveryCodes: [], mfaEnrolledAt: null } });
    void logAudit({ consultingFirmId: req.user!.consultingFirmId, actorUserId: req.user!.userId, action: 'UPDATE', entityType: 'User', entityId: req.user!.userId, rationale: 'MFA disabled', sourceIp: req.ip ?? null, userAgent: req.get('user-agent') ?? null });
    res.json({ success: true, data: { enabled: false } });
  } catch (err) { next(err); }
});

// POST /api/auth/mfa/reset — BREAK-GLASS: a platform admin clears a locked-out
// user's MFA (lost device AND recovery codes).
router.post('/mfa/reset', authenticateJWT, rejectScopedToken, requirePlatformAdmin, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body);
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, consultingFirmId: true, email: true } });
    if (!target) throw new NotFoundError('User');
    await prisma.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecret: null, mfaRecoveryCodes: [], mfaEnrolledAt: null } });
    void logAudit({ consultingFirmId: target.consultingFirmId, actorUserId: req.user!.userId, action: 'UPDATE', entityType: 'User', entityId: userId, rationale: `MFA reset (break-glass) for ${target.email}`, sourceIp: req.ip ?? null, userAgent: req.get('user-agent') ?? null });
    res.json({ success: true, data: { userId, mfaReset: true } });
  } catch (err) { next(err); }
});

export default router;
