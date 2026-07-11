'use strict';

const nodemailer = require('nodemailer');

function createTransporter() {
  const port = parseInt((process.env.SMTP_PORT || '587').trim(), 10);
  const smtpSecure = (process.env.SMTP_SECURE || '').trim();
  // Port 465 uses implicit SSL (secure must be true).
  // Port 587/25 use STARTTLS (secure false, then upgrade).
  // SMTP_SECURE=true/false overrides the auto-detection if explicitly set.
  const secure = smtpSecure === 'true' ? true
               : smtpSecure === 'false' ? false
               : port === 465;
  return nodemailer.createTransport({
    host: (process.env.SMTP_HOST || '').trim(),
    port,
    secure,
    auth: {
      user: (process.env.SMTP_USER || '').trim(),
      pass: (process.env.SMTP_PASSWORD || '').trim(),
    },
  });
}

// Call once at startup to confirm SMTP connectivity. Logs result but does not
// throw — a broken mail config should not prevent the server from starting.
async function verifySmtp() {
  if (!process.env.SMTP_HOST) {
    console.warn('[emailService] SMTP_HOST not set — email sending is disabled.');
    return;
  }
  try {
    const t = createTransporter();
    await t.verify();
    console.log(`[emailService] SMTP ready: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587} user=${process.env.SMTP_USER}`);
  } catch (err) {
    console.error(`[emailService] SMTP connection failed (user=${process.env.SMTP_USER} host=${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587} secure=${process.env.SMTP_PORT === '465'}): ${err.message}`);
  }
}

function resolveFrom() {
  // Namecheap (and most providers) require the FROM address to match the
  // authenticated SMTP_USER. If SMTP_FROM is not set, use SMTP_USER directly
  // so the envelope sender always matches the authenticated account.
  if (process.env.SMTP_FROM) return process.env.SMTP_FROM.trim();
  const user = (process.env.SMTP_USER || '').trim();
  if (user) return `handsbreadth LLC <${user}>`;
  return 'handsbreadth LLC <noreply@handsbreadth.com>';
}

/**
 * Send the email-verification message to a newly registered user.
 * If SMTP_HOST is not configured, logs the verify URL to the console instead
 * (useful for local development).
 */
async function sendVerificationEmail({ to, username, verifyUrl, createdAt }) {
  const date = new Date(createdAt).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  if (!process.env.SMTP_HOST) {
    console.warn(
      '[emailService] SMTP not configured — skipping verification email.\n' +
      `  Verify URL for ${username}: ${verifyUrl}`
    );
    return;
  }

  const from = resolveFrom();

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:2rem 1rem">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;box-shadow:0 2px 14px rgba(24,36,113,.09);overflow:hidden">

        <!-- Header -->
        <tr><td style="background:#182471;padding:1.5rem 2rem;text-align:center">
          <span style="color:#fff;font-size:1.25rem;font-weight:700;letter-spacing:.01em">handsbreadth LLC</span>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:2rem">
          <h1 style="color:#182471;font-size:1.35rem;margin:0 0 .75rem">Verify your email address</h1>
          <p style="color:#444;font-size:.95rem;line-height:1.6;margin:0 0 1rem">
            Hi <strong>${escHtml(username)}</strong>,
          </p>
          <p style="color:#444;font-size:.95rem;line-height:1.6;margin:0 0 1.5rem">
            Thank you for registering with <strong>UpQ task server</strong> by handsbreadth LLC.
            Please click the button below to verify your email address and complete your registration.
          </p>

          <!-- Registration details -->
          <table width="100%" cellpadding="0" cellspacing="0"
                 style="background:#f4f6fb;border-radius:8px;padding:.9rem 1.1rem;margin-bottom:1.75rem;font-size:.86rem;color:#555">
            <tr>
              <td style="padding:.2rem 0"><strong style="color:#888">Username:</strong></td>
              <td style="padding:.2rem 0;text-align:right">${escHtml(username)}</td>
            </tr>
            <tr>
              <td style="padding:.2rem 0"><strong style="color:#888">Email:</strong></td>
              <td style="padding:.2rem 0;text-align:right">${escHtml(to)}</td>
            </tr>
            <tr>
              <td style="padding:.2rem 0"><strong style="color:#888">Registered:</strong></td>
              <td style="padding:.2rem 0;text-align:right">${date}</td>
            </tr>
          </table>

          <!-- CTA button -->
          <div style="text-align:center;margin-bottom:1.5rem">
            <a href="${verifyUrl}"
               style="background:#182471;color:#fff;padding:.85rem 2.25rem;border-radius:8px;
                      text-decoration:none;font-weight:700;font-size:1rem;display:inline-block;
                      letter-spacing:.01em">
              Verify Email Address
            </a>
          </div>

          <p style="font-size:.78rem;color:#aaa;line-height:1.5;margin:0">
            This link expires in <strong>24 hours</strong>. If you didn't create this account, you
            can safely ignore this email — no action is required.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f4f6fb;padding:.9rem 2rem;text-align:center;font-size:.75rem;color:#bbb;border-top:1px solid #eef0f8">
          handsbreadth LLC &nbsp;·&nbsp; All rights reserved
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text =
    `Verify your email address — UpQ task server\n\n` +
    `Hi ${username},\n\n` +
    `Thank you for registering with UpQ task server by handsbreadth LLC.\n\n` +
    `Registration details:\n` +
    `  Username:   ${username}\n` +
    `  Email:      ${to}\n` +
    `  Registered: ${date}\n\n` +
    `Click the link below to verify your email address (expires in 24 hours):\n` +
    `${verifyUrl}\n\n` +
    `If you didn't create this account, you can safely ignore this email.\n\n` +
    `handsbreadth LLC`;

  const transporter = createTransporter();
  await transporter.sendMail({
    from,
    to,
    subject: 'Verify your UpQ task server email address',
    html,
    text,
  });
}

/**
 * Send a new verification email when the user requests a resend.
 * Delegates to sendVerificationEmail with the same template.
 */
async function resendVerificationEmail(opts) {
  return sendVerificationEmail(opts);
}

/**
 * Send a password-reset email.
 * If SMTP_HOST is not configured, logs the reset URL to the console instead.
 */
async function sendPasswordResetEmail({ to, username, resetUrl }) {
  if (!process.env.SMTP_HOST) {
    console.warn(
      '[emailService] SMTP not configured — skipping password-reset email.\n' +
      `  Reset URL for ${username}: ${resetUrl}`
    );
    return;
  }

  const from = resolveFrom();

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:2rem 1rem">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;box-shadow:0 2px 14px rgba(24,36,113,.09);overflow:hidden">

        <!-- Header -->
        <tr><td style="background:#182471;padding:1.5rem 2rem;text-align:center">
          <span style="color:#fff;font-size:1.25rem;font-weight:700;letter-spacing:.01em">handsbreadth LLC</span>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:2rem">
          <h1 style="color:#182471;font-size:1.35rem;margin:0 0 .75rem">Reset your password</h1>
          <p style="color:#444;font-size:.95rem;line-height:1.6;margin:0 0 1rem">
            Hi <strong>${escHtml(username)}</strong>,
          </p>
          <p style="color:#444;font-size:.95rem;line-height:1.6;margin:0 0 1.75rem">
            We received a request to reset the password for your <strong>UpQ task server</strong> account.
            Click the button below to choose a new password.
          </p>

          <!-- CTA button -->
          <div style="text-align:center;margin-bottom:1.5rem">
            <a href="${resetUrl}"
               style="background:#182471;color:#fff;padding:.85rem 2.25rem;border-radius:8px;
                      text-decoration:none;font-weight:700;font-size:1rem;display:inline-block;
                      letter-spacing:.01em">
              Reset Password
            </a>
          </div>

          <p style="font-size:.78rem;color:#aaa;line-height:1.5;margin:0">
            This link expires in <strong>1 hour</strong>. If you didn't request a password reset, you
            can safely ignore this email — your password will not change.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f4f6fb;padding:.9rem 2rem;text-align:center;font-size:.75rem;color:#bbb;border-top:1px solid #eef0f8">
          handsbreadth LLC &nbsp;·&nbsp; All rights reserved
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text =
    `Reset your password — UpQ task server\n\n` +
    `Hi ${username},\n\n` +
    `We received a request to reset the password for your UpQ task server account.\n\n` +
    `Click the link below to choose a new password (expires in 1 hour):\n` +
    `${resetUrl}\n\n` +
    `If you didn't request a password reset, you can safely ignore this email.\n\n` +
    `handsbreadth LLC`;

  const transporter = createTransporter();
  await transporter.sendMail({
    from,
    to,
    subject: 'Reset your UpQ task server password',
    html,
    text,
  });
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTrialEndingWarningEmail({ to, username, trialEndDate, daysRemaining, upgradeUrl }) {
  const formattedDate = new Date(trialEndDate).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
  const dayWord = daysRemaining === 1 ? 'day' : 'days';

  if (!process.env.SMTP_HOST) {
    console.warn(
      `[emailService] SMTP not configured — skipping trial ending warning email.\n` +
      `  Trial ending in ${daysRemaining} ${dayWord} for ${username} (${to})`
    );
    return;
  }

  const from = resolveFrom();

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:2rem 1rem">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;box-shadow:0 2px 14px rgba(24,36,113,.09);overflow:hidden">
        <tr><td style="background:#182471;padding:1.5rem 2rem;text-align:center">
          <span style="color:#fff;font-size:1.25rem;font-weight:700;letter-spacing:.01em">handsbreadth LLC</span>
        </td></tr>
        <tr><td style="padding:2rem">
          <h1 style="color:#182471;font-size:1.35rem;margin:0 0 .75rem">Your free trial ends in ${daysRemaining} ${dayWord}</h1>
          <p style="color:#444;font-size:.95rem;line-height:1.6;margin:0 0 1rem">
            Hi <strong>${escHtml(username)}</strong>,
          </p>
          <p style="color:#444;font-size:.95rem;line-height:1.6;margin:0 0 1.5rem">
            Your free trial of <strong>UpQ task server</strong> ends on <strong>${formattedDate}</strong>.
            Subscribe now to keep uninterrupted access to all your tasks.
          </p>
          <div style="text-align:center;margin-bottom:1.5rem">
            <a href="${upgradeUrl}"
               style="background:#182471;color:#fff;padding:.85rem 2.25rem;border-radius:8px;
                      text-decoration:none;font-weight:700;font-size:1rem;display:inline-block;
                      letter-spacing:.01em">
              Subscribe Now
            </a>
          </div>
          <p style="font-size:.78rem;color:#aaa;line-height:1.5;margin:0">
            If you have questions, visit our <a href="${upgradeUrl.replace('/pricing.html', '/support.html')}" style="color:#aaa">support page</a>.
          </p>
        </td></tr>
        <tr><td style="background:#f4f6fb;padding:.9rem 2rem;text-align:center;font-size:.75rem;color:#bbb;border-top:1px solid #eef0f8">
          handsbreadth LLC &nbsp;·&nbsp; All rights reserved
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text =
    `Your free trial ends in ${daysRemaining} ${dayWord} — UpQ task server\n\n` +
    `Hi ${username},\n\n` +
    `Your free trial of UpQ task server ends on ${formattedDate}.\n` +
    `Subscribe now to keep uninterrupted access to all your tasks:\n` +
    `${upgradeUrl}\n\n` +
    `handsbreadth LLC`;

  const transporter = createTransporter();
  await transporter.sendMail({
    from,
    to,
    subject: `Your UpQ free trial ends in ${daysRemaining} ${dayWord}`,
    html,
    text,
  });
}

async function sendPaymentFailedEmail({ to, username, updatePaymentUrl }) {
  if (!process.env.SMTP_HOST) {
    console.warn(
      `[emailService] SMTP not configured — skipping payment failed email for ${username} (${to})`
    );
    return;
  }

  const from = resolveFrom();

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:2rem 1rem">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;box-shadow:0 2px 14px rgba(24,36,113,.09);overflow:hidden">
        <tr><td style="background:#182471;padding:1.5rem 2rem;text-align:center">
          <span style="color:#fff;font-size:1.25rem;font-weight:700;letter-spacing:.01em">handsbreadth LLC</span>
        </td></tr>
        <tr><td style="padding:2rem">
          <h1 style="color:#c0392b;font-size:1.35rem;margin:0 0 .75rem">Payment failed</h1>
          <p style="color:#444;font-size:.95rem;line-height:1.6;margin:0 0 1rem">
            Hi <strong>${escHtml(username)}</strong>,
          </p>
          <p style="color:#444;font-size:.95rem;line-height:1.6;margin:0 0 1.5rem">
            We were unable to process the payment for your <strong>UpQ task server</strong> subscription.
            Please update your billing information to avoid losing access.
          </p>
          <div style="text-align:center;margin-bottom:1.5rem">
            <a href="${updatePaymentUrl}"
               style="background:#c0392b;color:#fff;padding:.85rem 2.25rem;border-radius:8px;
                      text-decoration:none;font-weight:700;font-size:1rem;display:inline-block;
                      letter-spacing:.01em">
              Update Payment Info
            </a>
          </div>
          <p style="font-size:.78rem;color:#aaa;line-height:1.5;margin:0">
            If you believe this is an error, please <a href="${updatePaymentUrl.replace('/settings.html', '/support.html')}" style="color:#aaa">contact support</a>.
          </p>
        </td></tr>
        <tr><td style="background:#f4f6fb;padding:.9rem 2rem;text-align:center;font-size:.75rem;color:#bbb;border-top:1px solid #eef0f8">
          handsbreadth LLC &nbsp;·&nbsp; All rights reserved
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text =
    `Payment failed — UpQ task server\n\n` +
    `Hi ${username},\n\n` +
    `We were unable to process the payment for your UpQ task server subscription.\n` +
    `Please update your billing information to avoid losing access:\n` +
    `${updatePaymentUrl}\n\n` +
    `handsbreadth LLC`;

  const transporter = createTransporter();
  await transporter.sendMail({
    from,
    to,
    subject: 'Action required: UpQ payment failed',
    html,
    text,
  });
}

async function sendSubscriptionExpiredEmail({ to, username, resubscribeUrl }) {
  if (!process.env.SMTP_HOST) {
    console.warn(
      `[emailService] SMTP not configured — skipping subscription expired email for ${username} (${to})`
    );
    return;
  }

  const from = resolveFrom();

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:2rem 1rem">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;box-shadow:0 2px 14px rgba(24,36,113,.09);overflow:hidden">
        <tr><td style="background:#182471;padding:1.5rem 2rem;text-align:center">
          <span style="color:#fff;font-size:1.25rem;font-weight:700;letter-spacing:.01em">handsbreadth LLC</span>
        </td></tr>
        <tr><td style="padding:2rem">
          <h1 style="color:#182471;font-size:1.35rem;margin:0 0 .75rem">Your subscription has ended</h1>
          <p style="color:#444;font-size:.95rem;line-height:1.6;margin:0 0 1rem">
            Hi <strong>${escHtml(username)}</strong>,
          </p>
          <p style="color:#444;font-size:.95rem;line-height:1.6;margin:0 0 1.5rem">
            Your <strong>UpQ task server</strong> subscription has ended. Subscribe again to restore
            access to all your tasks and connected services.
          </p>
          <div style="text-align:center;margin-bottom:1.5rem">
            <a href="${resubscribeUrl}"
               style="background:#182471;color:#fff;padding:.85rem 2.25rem;border-radius:8px;
                      text-decoration:none;font-weight:700;font-size:1rem;display:inline-block;
                      letter-spacing:.01em">
              Resubscribe
            </a>
          </div>
          <p style="font-size:.78rem;color:#aaa;line-height:1.5;margin:0">
            Your account and data are retained. You can resubscribe at any time.
          </p>
        </td></tr>
        <tr><td style="background:#f4f6fb;padding:.9rem 2rem;text-align:center;font-size:.75rem;color:#bbb;border-top:1px solid #eef0f8">
          handsbreadth LLC &nbsp;·&nbsp; All rights reserved
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text =
    `Your UpQ subscription has ended\n\n` +
    `Hi ${username},\n\n` +
    `Your UpQ task server subscription has ended. Subscribe again to restore access:\n` +
    `${resubscribeUrl}\n\n` +
    `Your account and data are retained. You can resubscribe at any time.\n\n` +
    `handsbreadth LLC`;

  const transporter = createTransporter();
  await transporter.sendMail({
    from,
    to,
    subject: 'Your UpQ task server subscription has ended',
    html,
    text,
  });
}

/**
 * Send an operational alert to the admin (not a user-facing email).
 * Recipient is ADMIN_ALERT_EMAIL if set, otherwise falls back to SMTP_USER
 * so alerts land somewhere by default even without extra configuration.
 */
async function sendAdminAlertEmail({ subject, message }) {
  if (!process.env.SMTP_HOST) {
    console.warn(`[emailService] SMTP not configured — skipping admin alert: ${subject}`);
    return;
  }
  const to = (process.env.ADMIN_ALERT_EMAIL || process.env.SMTP_USER || '').trim();
  if (!to) {
    console.warn(`[emailService] No ADMIN_ALERT_EMAIL or SMTP_USER configured — skipping admin alert: ${subject}`);
    return;
  }

  const transporter = createTransporter();
  await transporter.sendMail({
    from: resolveFrom(),
    to,
    subject: `[UpQ Alert] ${subject}`,
    text: message,
  });
}

module.exports = { sendVerificationEmail, resendVerificationEmail, sendPasswordResetEmail, verifySmtp, sendTrialEndingWarningEmail, sendPaymentFailedEmail, sendSubscriptionExpiredEmail, sendAdminAlertEmail };
