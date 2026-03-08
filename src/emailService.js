'use strict';

const nodemailer = require('nodemailer');

function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
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

  const from = process.env.SMTP_FROM || 'handsbreadth LLC <noreply@handsbreadth.com>';

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
            Thank you for registering with <strong>hb Task Server</strong> by handsbreadth LLC.
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
    `Verify your email address — hb Task Server\n\n` +
    `Hi ${username},\n\n` +
    `Thank you for registering with hb Task Server by handsbreadth LLC.\n\n` +
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
    subject: 'Verify your hb Task Server email address',
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

  const from = process.env.SMTP_FROM || 'handsbreadth LLC <noreply@handsbreadth.com>';

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
            We received a request to reset the password for your <strong>hb Task Server</strong> account.
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
    `Reset your password — hb Task Server\n\n` +
    `Hi ${username},\n\n` +
    `We received a request to reset the password for your hb Task Server account.\n\n` +
    `Click the link below to choose a new password (expires in 1 hour):\n` +
    `${resetUrl}\n\n` +
    `If you didn't request a password reset, you can safely ignore this email.\n\n` +
    `handsbreadth LLC`;

  const transporter = createTransporter();
  await transporter.sendMail({
    from,
    to,
    subject: 'Reset your hb Task Server password',
    html,
    text,
  });
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { sendVerificationEmail, resendVerificationEmail, sendPasswordResetEmail };
