// Deletes only data associated with an authenticated production notification.
// Existing AILIS product files, other stores' systems and eBay listings are not touched.
'use strict';
const {DeletionError} = require('./account-deletion');
function nonempty(value) { return typeof value === 'string' && value.length > 0 ? value : ''; }
function accountMatches(account, identity) {
  if (!account || typeof account !== 'object') return false;
  const key = nonempty(account.seller_key);
  const name = nonempty(account.seller_id);
  const userId = nonempty(identity.userId);
  const eias = nonempty(identity.eiasToken);
  const username = nonempty(identity.username);
  if (key && key !== name.toLowerCase() && eias) {
    // Prefer a stable identifier. A reused username never overrides a
    // conflicting EIAS/immutable identifier.
    return (eias && key === eias) || (userId && key === userId) || false;
  }
  return (eias && key === eias) || (userId && (name === userId || key === userId)) ||
    (username && ((name && name.toLowerCase() === username.toLowerCase()) || key === username.toLowerCase())) || false;
}
// Expressions are fixed code, not interpolated user inputs. Values are bound.
function identitySql(key, name) {
  return `(CASE WHEN NULLIF($1, '') IS NOT NULL AND COALESCE(${key}, '') <> '' AND COALESCE(${key}, '') <> lower(COALESCE(${name}, ''))
    THEN (COALESCE(${key}, '') = NULLIF($1, '') OR COALESCE(${key}, '') = NULLIF($2, ''))
    ELSE (COALESCE(${key}, '') = NULLIF($1, '') OR COALESCE(${name}, '') = NULLIF($2, '') OR COALESCE(${key}, '') = NULLIF($2, '')
      OR lower(COALESCE(${name}, '')) = lower(NULLIF($3, '')) OR COALESCE(${key}, '') = lower(NULLIF($3, '')))
    END)`;
}
const mainIdentity = identitySql("data->>'submitted_seller'", "data->>'submitted_seller_id'");
const draftIdentity = identitySql("data->'ebay_account'->>'seller_key'", "data->'ebay_account'->>'seller_id'");
const verificationKey = "COALESCE(data->'verification'->>'seller_key', data->'ebay_account'->>'seller_key', data->>'submitted_seller')";
const verifyIdentity = `(${identitySql(verificationKey, "data->'verification'->>'seller_id'")}
  AND (COALESCE(${verificationKey}, '') <> '' OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(data->'images')='array'
      THEN data->'images' ELSE '[]'::jsonb END) im WHERE COALESCE(im->>'seller_key','') <> '')))`;
async function deleteAccountData(store, identity) {
  if (!identity || !['eiasToken', 'userId', 'username'].some(k => nonempty(identity[k]))) {
    throw new DeletionError('missing_account_identifier');
  }
  return store.transaction(async client => {
    await client.query("SET LOCAL statement_timeout = '8000ms'");
    await client.query("SET LOCAL lock_timeout = '3000ms'");
    const settingsResult = await client.query(
      "SELECT data,revision FROM ail_ebay_settings WHERE environment='production' FOR UPDATE");
    if (settingsResult.rows.length !== 1) throw new DeletionError('production_settings_missing', 503);
    const settings = settingsResult.rows[0].data;
    const current = accountMatches(settings, identity) || accountMatches(settings._deletion_identity, identity);
    const parameters = [nonempty(identity.eiasToken), nonempty(identity.userId), nonempty(identity.username)];
    const selected = await client.query(`SELECT id FROM ail_ebay_drafts
      WHERE data->>'environment'='production' AND (
        ${mainIdentity} OR ${draftIdentity} OR ${verifyIdentity}
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(data->'images')='array'
          THEN data->'images' ELSE '[]'::jsonb END) im
          WHERE im->>'seller_key'=NULLIF($1,'') OR im->>'seller_key'=NULLIF($2,''))
        OR id IN (SELECT draft_id FROM ail_ebay_submissions WHERE environment='production'
          AND (seller=NULLIF($1,'') OR seller=NULLIF($2,'') OR seller=lower(NULLIF($3,''))))
      ) ORDER BY id FOR UPDATE`, parameters);
    const ids = selected.rows.map(row => row.id);
    // Remove dependent rows first; chunks use the existing ON DELETE CASCADE.
    const submissions = await client.query(`DELETE FROM ail_ebay_submissions WHERE environment='production'
      AND (draft_id=ANY($1::text[]) OR seller=NULLIF($2,'') OR seller=NULLIF($3,'') OR seller=lower(NULLIF($4,'')))`,
      [ids, parameters[0], parameters[1], parameters[2]]);
    const uploads = await client.query('DELETE FROM ail_ebay_uploads WHERE draft_id=ANY($1::text[])', [ids]);
    const drafts = await client.query("DELETE FROM ail_ebay_drafts WHERE id=ANY($1::text[]) AND data->>'environment'='production'", [ids]);
    if (current) {
      // Keep the environment row so existing APIs return a disconnected state.
      // Incrementing revision invalidates in-flight saves and token refreshes.
      await client.query(`UPDATE ail_ebay_settings SET data='{"production_enabled":false}'::jsonb,
        revision=revision+1 WHERE environment='production'`);
      await client.query("DELETE FROM ail_ebay_oauth WHERE environment='production'");
    }
    if (current || ids.length || submissions.rowCount) {
      // These sessions are shared staff sessions, not eBay user accounts.
      // Expire them to prevent continuing with stale browser state.
      await client.query('DELETE FROM ail_ebay_sessions');
    }
    return {disconnected: current, drafts: drafts.rowCount, submissions: submissions.rowCount, uploads: uploads.rowCount};
  });
}
module.exports = {deleteAccountData, accountMatches};
