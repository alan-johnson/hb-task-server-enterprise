'use strict';

const { pool } = require('../db/db');
const {
  sendTrialEndingWarningEmail,
  sendSubscriptionExpiredEmail,
} = require('../emailService');

function toMySQL(date) {
  return new Date(date).toISOString().replace('T', ' ').replace('Z', '');
}

const WARNING_DAYS = 14;
const baseUrl = () => process.env.WEB_URL || 'http://localhost';

async function expireStaleTrials() {
  const result = await pool.query(
    `SELECT user_id, username, email
     FROM users
     WHERE subscription_status = 'trialing'
       AND trial_end IS NOT NULL
       AND trial_end < NOW()`
  );
  if (result.rows.length === 0) return;

  const ids = result.rows.map(r => r.user_id);
  await pool.query(
    `UPDATE users SET subscription_status = 'canceled', trial_end = NULL, subscription_period_end = NULL
     WHERE user_id IN (${ids.map(() => '?').join(',')})`,
    ids
  );

  for (const row of result.rows) {
    if (!row.email) continue;
    try {
      await sendSubscriptionExpiredEmail({
        to: row.email,
        username: row.username,
        resubscribeUrl: `${baseUrl()}/pricing.html`,
      });
    } catch (err) {
      console.error(`[subscriptionMaintenance] Failed to send expired email to ${row.email}:`, err.message);
    }
  }

  console.log(`[subscriptionMaintenance] Expired ${ids.length} stale trial(s)`);
}

async function sendTrialEndingWarnings() {
  const cutoff = toMySQL(new Date(Date.now() + WARNING_DAYS * 24 * 60 * 60 * 1000));
  const result = await pool.query(
    `SELECT user_id, username, email, trial_end
     FROM users
     WHERE subscription_status = 'trialing'
       AND trial_end IS NOT NULL
       AND trial_end > NOW()
       AND trial_end <= ?
       AND trial_warning_sent_at IS NULL`,
    [cutoff]
  );
  if (result.rows.length === 0) return;

  for (const row of result.rows) {
    const trialEnd = new Date(row.trial_end);
    const daysRemaining = Math.max(1, Math.ceil((trialEnd - Date.now()) / (24 * 60 * 60 * 1000)));

    if (row.email) {
      try {
        await sendTrialEndingWarningEmail({
          to: row.email,
          username: row.username,
          trialEndDate: trialEnd.toISOString(),
          daysRemaining,
          upgradeUrl: `${baseUrl()}/pricing.html`,
        });
      } catch (err) {
        console.error(`[subscriptionMaintenance] Failed to send trial warning to ${row.email}:`, err.message);
        continue;
      }
    }

    await pool.query(
      'UPDATE users SET trial_warning_sent_at = NOW() WHERE user_id = ?',
      [row.user_id]
    );
  }

  console.log(`[subscriptionMaintenance] Sent ${result.rows.length} trial-ending warning(s)`);
}

async function runSubscriptionMaintenance() {
  console.log('[subscriptionMaintenance] Running daily maintenance…');
  try {
    await expireStaleTrials();
    await sendTrialEndingWarnings();
  } catch (err) {
    console.error('[subscriptionMaintenance] Maintenance error:', err.message);
  }
}

module.exports = { runSubscriptionMaintenance };
