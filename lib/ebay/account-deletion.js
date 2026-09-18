// eBay marketplace account deletion: transport/validation only.
// No listing, order or inventory mutation API is called by this module.
'use strict';
const {createHash, createPublicKey, verify} = require('node:crypto');
const MAX_BODY = 65536;
const ENDPOINT_PATH = '/api/ebay-account-deletion';
const API_ORIGIN = 'https://api.ebay.com';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';
class DeletionError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
function requireValue(ok, code, status = 400) {
  if (!ok) throw new DeletionError(code, status);
}
function configuration(env) {
  const endpoint = env.EBAY_DELETION_ENDPOINT;
  const token = env.EBAY_DELETION_VERIFICATION_TOKEN;
  requireValue(typeof endpoint === 'string' && endpoint.length < 2000,
    'deletion_endpoint_not_configured', 503);
  let url;
  try { url = new URL(endpoint); } catch (_) { throw new DeletionError('invalid_deletion_endpoint', 503); }
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
    url.pathname === ENDPOINT_PATH && url.href === endpoint &&
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'invalid_deletion_endpoint', 503);
  requireValue(typeof token === 'string' && /^[A-Za-z0-9_-]{32,80}$/.test(token),
    'invalid_deletion_verification_token', 503);
  return {endpoint, token};
}
function challengeResponse(code, config) {
  requireValue(typeof code === 'string' && code.length > 0 && code.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/.test(code), 'invalid_challenge');
  return createHash('sha256').update(code).update(config.token).update(config.endpoint).digest('hex');
}
function decode64(value, limit) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= limit &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value), 'invalid_signature', 412);
  const bytes = Buffer.from(value, 'base64');
  requireValue(bytes.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, ''),
    'invalid_signature', 412);
  return bytes;
}
function signatureHeader(value) {
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(decode64(value, 4096))); }
  catch (_) { throw new DeletionError('invalid_signature', 412); }
  requireValue(parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
    typeof parsed.kid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(parsed.kid) &&
    String(parsed.alg).toUpperCase() === 'ECDSA' && String(parsed.digest).toUpperCase() === 'SHA1',
    'unsupported_signature', 412);
  return {kid: parsed.kid, bytes: decode64(parsed.signature, 1024)};
}
function parseNotification(raw) {
  requireValue(typeof raw === 'string' && Buffer.byteLength(raw) <= MAX_BODY, 'invalid_body');
  let message;
  try { message = JSON.parse(raw); } catch (_) { throw new DeletionError('invalid_json'); }
  requireValue(message && message.metadata?.topic === 'MARKETPLACE_ACCOUNT_DELETION' &&
    message.metadata.schemaVersion === '1.0', 'unsupported_notification');
  const notification = message.notification;
  const data = notification?.data;
  requireValue(notification && typeof notification.notificationId === 'string' &&
    notification.notificationId.length > 0 && notification.notificationId.length <= 256 &&
    data && typeof data === 'object' && !Array.isArray(data), 'invalid_notification');
  const identity = {};
  for (const field of ['username', 'userId', 'eiasToken']) {
    const value = data[field];
    if (value === undefined || value === null || value === '') continue;
    requireValue(typeof value === 'string' && value.length <= 2048 && value.trim() === value &&
      !/[\u0000-\u001f\u007f]/.test(value), 'invalid_account_identifier');
    identity[field] = value;
  }
  requireValue(Object.keys(identity).length > 0, 'missing_account_identifier');
  return {message, identity};
}
async function readLimitedBody(request) {
  const length = request.headers.get('content-length');
  requireValue(!length || (/^\d+$/.test(length) && Number(length) <= MAX_BODY), 'body_too_large', 413);
  if (!request.body) throw new DeletionError('empty_body');
  const reader = request.body.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY) { await reader.cancel(); throw new DeletionError('body_too_large', 413); }
      parts.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(parts)); }
  catch (_) { throw new DeletionError('invalid_utf8'); }
}
// The only remote destinations are these two fixed eBay APIs. A notification's
// key ID is an encoded path component, never a URL supplied by the sender.
function createEbaySignatureVerifier({env = process.env, fetchImpl = fetch, clock = Date.now} = {}) {
  let access = null;
  let tokenPromise = null;
  const keys = new Map();
  const pending = new Map();
  const credentials = () => {
    const client = env.EBAY_PRODUCTION_CLIENT_ID;
    const secret = env.EBAY_PRODUCTION_CLIENT_SECRET;
    requireValue(typeof client === 'string' && client.length > 0 && client.length < 2048 &&
      typeof secret === 'string' && secret.length > 0 && secret.length < 4096,
      'production_app_keys_not_configured', 503);
    return Buffer.from(client + ':' + secret).toString('base64');
  };
  async function fetchJson(url, options) {
    let response;
    try { response = await fetchImpl(url, {...options, redirect: 'error', signal: AbortSignal.timeout(4000)}); }
    catch (_) { throw new DeletionError('ebay_verification_unavailable', 503); }
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});
      throw new DeletionError('ebay_verification_unavailable', 503);
    }
    try { return JSON.parse(await readLimitedBody(response)); }
    catch (_) { throw new DeletionError('invalid_ebay_verification_response', 503); }
  }
  async function applicationToken() {
    if (access && access.expires > clock() + 60000) return access.value;
    if (!tokenPromise) tokenPromise = (async () => {
      const result = await fetchJson(API_ORIGIN + '/identity/v1/oauth2/token', {
        method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + credentials(), Accept: 'application/json'},
        body: new URLSearchParams({grant_type: 'client_credentials', scope: SCOPE}).toString()
      });
      requireValue(typeof result.access_token === 'string' && result.access_token.length > 0 &&
        result.access_token.length < 20000 && Number(result.expires_in) > 60,
        'invalid_ebay_application_token', 503);
      access = {value: result.access_token, expires: clock() + Number(result.expires_in) * 1000};
      return access.value;
    })().finally(() => { tokenPromise = null; });
    return tokenPromise;
  }
  async function publicKey(kid) {
    const cached = keys.get(kid);
    if (cached && cached.expires > clock()) return cached.key;
    if (!pending.has(kid)) pending.set(kid, (async () => {
      const result = await fetchJson(API_ORIGIN + '/commerce/notification/v1/public_key/' + encodeURIComponent(kid), {
        headers: {Authorization: 'Bearer ' + await applicationToken(), Accept: 'application/json'}
      });
      requireValue(String(result.algorithm).toUpperCase() === 'ECDSA' &&
        String(result.digest).toUpperCase() === 'SHA1' && typeof result.key === 'string' && result.key.length < 10000,
        'invalid_ebay_public_key', 503);
      let key;
      try {
        const pem = result.key.trim().replace(/-----BEGIN PUBLIC KEY-----\s*/, '-----BEGIN PUBLIC KEY-----\n')
          .replace(/\s*-----END PUBLIC KEY-----$/, '\n-----END PUBLIC KEY-----');
        key = createPublicKey(pem);
      } catch (_) { throw new DeletionError('invalid_ebay_public_key', 503); }
      requireValue(key.asymmetricKeyType === 'ec', 'invalid_ebay_public_key', 503);
      for (const [id, entry] of keys) if (entry.expires <= clock()) keys.delete(id);
      if (keys.size >= 100) keys.delete(keys.keys().next().value);
      keys.set(kid, {key, expires: clock() + 3600000});
      return key;
    })().finally(() => { pending.delete(kid); }));
    return pending.get(kid);
  }
  return async function verifyNotification(raw, message, header) {
    const signature = signatureHeader(header);
    const key = await publicKey(signature.kid);
    // eBay's Node SDK signs JSON.stringify(message). Also accept a valid
    // signature on the original body, without accepting unsigned content.
    let valid = false;
    try {
      valid = verify('sha1', Buffer.from(raw), key, signature.bytes) ||
        verify('sha1', Buffer.from(JSON.stringify(message)), key, signature.bytes);
    } catch (_) { valid = false; }
    requireValue(valid, 'signature_verification_failed', 412);
  };
}
function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  }});
}
function createDeletionHandler({env = process.env, verifySignature, processDeletion, logger = () => {}} = {}) {
  const validate = verifySignature || createEbaySignatureVerifier({env});
  return async function handler(request) {
    try {
      if (!['GET', 'POST'].includes(request.method)) {
        const response = jsonResponse(405, {error: 'method_not_allowed'});
        response.headers.set('Allow', 'GET, POST');
        return response;
      }
      const config = configuration(env);
      const url = new URL(request.url);
      requireValue(url.pathname === ENDPOINT_PATH, 'not_found', 404);
      if (request.method === 'GET') {
        const values = url.searchParams.getAll('challenge_code');
        requireValue(values.length === 1, 'invalid_challenge');
        return jsonResponse(200, {challengeResponse: challengeResponse(values[0], config)});
      }
      requireValue((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() === 'application/json',
        'json_content_type_required', 415);
      // Reject malformed/missing signatures without acquiring a DB connection.
      const header = request.headers.get('x-ebay-signature');
      signatureHeader(header);
      const raw = await readLimitedBody(request);
      const {message, identity} = parseNotification(raw);
      await validate(raw, message, header);
      requireValue(typeof processDeletion === 'function', 'deletion_processor_not_configured', 503);
      // Acknowledge only after an atomic, idempotent deletion transaction.
      // Transient errors return 503 so eBay can retry; nothing is silently lost.
      await processDeletion(identity);
      try { logger('ebay_account_deletion_completed'); } catch (_) {}
      return new Response(null, {status: 204, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
    } catch (error) {
      const code = error instanceof DeletionError ? error.code : 'deletion_processing_unavailable';
      const status = error instanceof DeletionError ? error.status : 503;
      // Never log request bodies, identifiers, credentials or remote errors.
      try { logger(code); } catch (_) {}
      return jsonResponse(status, {error: code});
    }
  };
}
module.exports = {MAX_BODY, ENDPOINT_PATH, DeletionError, configuration, challengeResponse,
  signatureHeader, parseNotification, createEbaySignatureVerifier, createDeletionHandler};
