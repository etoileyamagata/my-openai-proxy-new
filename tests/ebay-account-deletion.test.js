'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const official = require('./fixtures/ebay-deletion-official.json');
const {fixture, env: baseEnv} = require('./ebay-fixture');
const {configuration, challengeResponse, parseNotification, signatureHeader,
  createEbaySignatureVerifier, createDeletionHandler} = require('../lib/ebay/account-deletion');
const {deleteAccountData, accountMatches} = require('../lib/ebay/account-deletion-store');
const env = {...baseEnv, EBAY_DELETION_ENDPOINT: 'https://ailis-ebay.example/api/ebay-account-deletion',
  EBAY_DELETION_VERIFICATION_TOKEN: '0123456789abcdef'.repeat(4)};
const account = {eiasToken: 'stable-seller', username: 'test-seller', userId: 'immutable-seller'};
const raw = JSON.stringify(official.message);
function req(body = raw, header = official.signature, extra = {}) {
  return new Request(env.EBAY_DELETION_ENDPOINT, {method: 'POST', body,
    headers: {'content-type': 'application/json', ...(header ? {'x-ebay-signature': header} : {}), ...extra}});
}
function transport(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({url, options});
    if (url.endsWith('/identity/v1/oauth2/token')) return new Response(JSON.stringify(
      overrides.token || {access_token: 'fixture-token-only', expires_in: 7200}), {status: overrides.tokenStatus || 200});
    return new Response(JSON.stringify(overrides.key || official.response), {status: overrides.keyStatus || 200});
  };
  return {calls, fetchImpl};
}
function handler(options = {}) {
  const remote = transport(options.remote);
  const processed = [];
  const logs = [];
  const verifySignature = createEbaySignatureVerifier({env, fetchImpl: remote.fetchImpl});
  const run = createDeletionHandler({env, verifySignature,
    processDeletion: async identity => {processed.push(identity);}, logger: code => logs.push(code), ...options.handler});
  return {run, processed, logs, ...remote};
}
async function dbTest(t) {
  const f = await fixture(); t.after(() => f.close()); return f;
}
async function rows(f, table) { return (await f.db.query('SELECT * FROM ' + table)).rows; }
async function changeSeller(f, key, name) {
  const s = await f.store.settings('production');
  return f.store.saveSettings('production', {...s, seller_key: key, seller_id: name}, s.revision, s.credentials);
}
test('challenge: correct SHA-256, JSON and no external/DB calls', async () => {
  const h = handler();
  const response = await h.run(new Request(env.EBAY_DELETION_ENDPOINT + '?challenge_code=abc123'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await response.json(), {challengeResponse: crypto.createHash('sha256')
    .update('abc123' + env.EBAY_DELETION_VERIFICATION_TOKEN + env.EBAY_DELETION_ENDPOINT).digest('hex')});
  assert.equal(h.calls.length, 0); assert.equal(h.processed.length, 0);
});
test('challenge: independent of production OAuth keys and staff login', async () => {
  const run = createDeletionHandler({env: {EBAY_DELETION_ENDPOINT: env.EBAY_DELETION_ENDPOINT,
    EBAY_DELETION_VERIFICATION_TOKEN: env.EBAY_DELETION_VERIFICATION_TOKEN}});
  assert.equal((await run(new Request(env.EBAY_DELETION_ENDPOINT + '?challenge_code=test'))).status, 200);
});
test('challenge: missing, empty, duplicate and control-character values fail', async () => {
  const h = handler();
  for (const query of ['', '?challenge_code=', '?challenge_code=a&challenge_code=b', '?challenge_code=%0a']) {
    assert.equal((await h.run(new Request(env.EBAY_DELETION_ENDPOINT + query))).status, 400);
  }
  assert.equal(h.processed.length, 0);
});
test('configuration: invalid tokens, URLs and missing settings fail closed', async () => {
  for (const token of ['', 'a'.repeat(31), 'a'.repeat(81), 'a'.repeat(32) + '!']) {
    assert.throws(() => configuration({...env, EBAY_DELETION_VERIFICATION_TOKEN: token}));
  }
  for (const url of ['http://ailis-ebay.example/api/ebay-account-deletion', 'https://localhost/api/ebay-account-deletion',
    env.EBAY_DELETION_ENDPOINT + '/', env.EBAY_DELETION_ENDPOINT + '?a=b', 'https://u:p@ailis-ebay.example/api/ebay-account-deletion']) {
    assert.throws(() => configuration({...env, EBAY_DELETION_ENDPOINT: url}));
  }
  const h = createDeletionHandler({env: {}});
  assert.equal((await h(new Request(env.EBAY_DELETION_ENDPOINT + '?challenge_code=a'))).status, 503);
});
test('challenge: endpoint and verification-token changes change the digest', () => {
  const config = configuration(env);
  assert.notEqual(challengeResponse('test', config), challengeResponse('test', {...config, token: 'a'.repeat(64)}));
  assert.notEqual(challengeResponse('test', config), challengeResponse('test', {...config, endpoint: config.endpoint + '/'}));
});
test('HTTP: methods other than GET/POST are rejected', async () => {
  const h = handler();
  const r = await h.run(new Request(env.EBAY_DELETION_ENDPOINT, {method: 'DELETE'}));
  assert.equal(r.status, 405); assert.equal(r.headers.get('allow'), 'GET, POST'); assert.equal(h.calls.length, 0);
});
test('HTTP: wrong content type rejected without verification or DB writes', async () => {
  const h = handler(); const r = await h.run(req(raw, official.signature, {'content-type': 'text/plain'}));
  assert.equal(r.status, 415); assert.equal(h.calls.length, 0); assert.equal(h.processed.length, 0);
});
test('signature: official eBay VALID vector passes real ECDSA validation', async () => {
  const h = handler(); const r = await h.run(req());
  assert.equal(r.status, 204); assert.equal(await r.text(), '');
  assert.deepEqual(h.processed, [official.message.notification.data]); assert.equal(h.calls.length, 2);
  assert.deepEqual(h.logs, ['ebay_account_deletion_completed']);
});
test('signature: official Node SDK JSON serialization accepted for pretty JSON', async () => {
  const h = handler(); const r = await h.run(req(JSON.stringify(official.message, null, 2)));
  assert.equal(r.status, 204); assert.equal(h.processed.length, 1);
});
test('signature: modified user ID fails and never invokes deletion', async () => {
  const h = handler(); const modified = structuredClone(official.message);
  modified.notification.data.userId = 'modified';
  assert.equal((await h.run(req(JSON.stringify(modified)))).status, 412);
  assert.equal(h.processed.length, 0);
});
test('signature: absent, invalid base64, empty and invalid JSON headers fail', async () => {
  for (const header of [null, '%%', Buffer.from('{}').toString('base64'), Buffer.from('not-json').toString('base64')]) {
    const h = handler(); assert.equal((await h.run(req(raw, header))).status, 412); assert.equal(h.processed.length, 0);
    assert.equal(h.calls.length, 0);
  }
});
test('signature: unknown algorithms and attacker-controlled key paths fail', async () => {
  for (const modification of [{alg: 'none'}, {digest: 'MD5'}, {kid: '../../internal'}, {kid: 'https://evil.invalid/key'}]) {
    const header = {...JSON.parse(Buffer.from(official.signature, 'base64')), ...modification};
    const h = handler();
    assert.equal((await h.run(req(raw, Buffer.from(JSON.stringify(header)).toString('base64')))).status, 412);
    assert.equal(h.calls.length, 0); assert.equal(h.processed.length, 0);
  }
});
test('signature: independently generated raw-body ECDSA proof also validates', async () => {
  const pair = crypto.generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const body = JSON.stringify(official.message, null, 3);
  const signature = crypto.sign('sha1', Buffer.from(body), pair.privateKey).toString('base64');
  const header = Buffer.from(JSON.stringify({kid: 'local-generated-test', alg: 'ecdsa', digest: 'SHA1', signature})).toString('base64');
  const h = handler({remote: {key: {key: pair.publicKey.export({type: 'spki', format: 'pem'}), algorithm: 'ECDSA', digest: 'SHA1'}}});
  assert.equal((await h.run(req(body, header))).status, 204);
});
test('public key: failed eBay retrieval returns 503 without deleting data', async () => {
  for (const remote of [{tokenStatus: 503}, {keyStatus: 503}, {key: {key: 'broken', algorithm: 'ECDSA', digest: 'SHA1'}},
    {key: {...official.response, digest: 'SHA256'}}, {token: {access_token: '', expires_in: 7200}}]) {
    const h = handler({remote}); assert.equal((await h.run(req())).status, 503); assert.equal(h.processed.length, 0);
  }
});
test('public key: token and public key are cached then refreshed at expiry', async () => {
  let now = 1000000; const remote = transport();
  const validate = createEbaySignatureVerifier({env, fetchImpl: remote.fetchImpl, clock: () => now});
  await validate(raw, official.message, official.signature); assert.equal(remote.calls.length, 2);
  await validate(raw, official.message, official.signature); assert.equal(remote.calls.length, 2);
  now += 3600001;
  await validate(raw, official.message, official.signature); assert.equal(remote.calls.length, 3);
  now += 3600001;
  await validate(raw, official.message, official.signature); assert.equal(remote.calls.length, 5);
  assert.equal(remote.calls[0].options.redirect, 'error');
  assert.match(remote.calls[0].options.body, /grant_type=client_credentials/);
  assert.equal(remote.calls[1].url, 'https://api.ebay.com/commerce/notification/v1/public_key/' + official.public_key);
});
test('public key: concurrent requests share token/key fetches', async () => {
  const remote = transport(); const validate = createEbaySignatureVerifier({env, fetchImpl: remote.fetchImpl});
  await Promise.all(Array.from({length: 8}, () => validate(raw, official.message, official.signature)));
  assert.equal(remote.calls.length, 2);
});
test('public key: credentials missing is 503; no secret is returned or logged', async () => {
  const h = handler({handler: {verifySignature: createEbaySignatureVerifier({env: {}, fetchImpl: transport().fetchImpl})}});
  const r = await h.run(req()); assert.equal(r.status, 503);
  const text = await r.text(); assert(!text.includes(official.message.notification.data.eiasToken));
  assert(!JSON.stringify(h.logs).includes(env.EBAY_DELETION_VERIFICATION_TOKEN));
});
test('notification: unsupported topics/schema, malformed JSON and missing account fail', async () => {
  const variants = ['{'];
  for (const edit of [m => {m.metadata.topic = 'OTHER';}, m => {m.metadata.schemaVersion = '2.0';},
    m => {m.notification.data = {};}, m => {m.notification.data.eiasToken = 42;},
    m => {m.notification.notificationId = '';}, m => {m.notification.data.username = '\nuser';}]) {
    const value = structuredClone(official.message); edit(value); variants.push(JSON.stringify(value));
  }
  for (const body of variants) {const h = handler(); assert.equal((await h.run(req(body))).status, 400); assert.equal(h.processed.length, 0);}
});
test('notification: each documented account identifier can be present alone', () => {
  for (const key of ['eiasToken', 'userId', 'username']) {
    const value = structuredClone(official.message); value.notification.data = {[key]: 'id123'};
    assert.deepEqual(parseNotification(JSON.stringify(value)).identity, {[key]: 'id123'});
  }
});
test('HTTP: oversized payload is rejected even without Content-Length', async () => {
  const h = handler(); assert.equal((await h.run(req(' '.repeat(65537)))).status, 413); assert.equal(h.processed.length, 0);
  assert.equal((await h.run(req(raw, official.signature, {'content-length': '100000'}))).status, 413);
});
test('HTTP: invalid UTF-8 fails without processing', async () => {
  const h = handler(); assert.equal((await h.run(req(Buffer.from([255, 254, 253])))).status, 400); assert.equal(h.processed.length, 0);
});
test('HTTP: transaction error is retryable and not falsely acknowledged', async () => {
  const h = handler({handler: {processDeletion: async () => {throw new Error('secret-do-not-log');}}});
  const r = await h.run(req()); assert.equal(r.status, 503); assert.equal(h.logs[0], 'deletion_processing_unavailable');
  assert(!JSON.stringify(h.logs).includes('secret-do-not-log'));
});
test('identity: stable IDs take priority over a reused username', () => {
  assert(accountMatches({seller_id: 'test-seller', seller_key: 'stable-seller'}, account));
  assert(!accountMatches({seller_id: 'test-seller', seller_key: 'different-stable-id'}, account));
  assert(accountMatches({seller_id: 'test-seller', seller_key: 'test-seller'}, account));
  assert(!accountMatches({}, account)); assert(!accountMatches({seller_id: ''}, {}));
});
test('DB: verified production data deleted; Sandbox and unassociated AILIS input remain', async t => {
  const f = await dbTest(t); const prod = await f.ready('production-to-delete', 'production');
  const sandbox = await f.ready('sandbox-to-keep', 'sandbox'); const local = await f.draft('unassociated-local', 'production');
  const result = await deleteAccountData(f.store, account);
  assert.equal(result.disconnected, true); assert.equal(result.drafts, 1);
  await assert.rejects(f.store.draft(prod.id)); assert.equal((await f.store.draft(sandbox.id)).id, sandbox.id);
  assert.equal((await f.store.draft(local.id)).id, local.id);
  const s = await f.store.settings('production'); assert.equal(s.production_enabled, false);
  assert.equal(s.credentials, undefined); assert.equal(s.seller_key, undefined); assert.equal(s._deletion_identity, undefined);
  assert((await f.store.settings('sandbox')).credentials);
});
test('DB: historical account removed without disconnecting a different current account', async t => {
  const f = await dbTest(t); const old = await f.ready('account-a', 'production');
  await changeSeller(f, 'new-stable-key', 'new-seller'); const current = await f.ready('account-b', 'production');
  const result = await deleteAccountData(f.store, account); assert.equal(result.disconnected, false); assert.equal(result.drafts, 1);
  await assert.rejects(f.store.draft(old.id)); assert.equal((await f.store.draft(current.id)).id, current.id);
  assert.equal((await f.store.settings('production')).seller_key, 'new-stable-key');
});
test('DB: same username with different EIAS is not deleted', async t => {
  const f = await dbTest(t); await changeSeller(f, 'new-stable-key', 'test-seller');
  const d = await f.ready('reused-name', 'production'); const result = await deleteAccountData(f.store, account);
  assert.equal(result.drafts, 0); assert.equal(result.disconnected, false); assert.equal((await f.store.draft(d.id)).id, d.id);
});
test('DB: signed notice for an unknown account changes no data or revisions', async t => {
  const f = await dbTest(t); const d = await f.ready('existing', 'production');
  const before = await f.store.settings('production');
  const r = await deleteAccountData(f.store, {username: 'other', eiasToken: 'other-stable', userId: 'other-id'});
  assert.deepEqual(r, {disconnected: false, drafts: 0, submissions: 0, uploads: 0});
  assert.deepEqual(await f.store.settings('production'), before); assert.equal((await f.store.draft(d.id)).id, d.id);
});
test('DB: repeated notifications are idempotent', async t => {
  const f = await dbTest(t); await f.ready('delete-once', 'production');
  await deleteAccountData(f.store, account); const before = await f.store.settings('production');
  const twice = await deleteAccountData(f.store, account);
  assert.deepEqual(twice, {disconnected: false, drafts: 0, submissions: 0, uploads: 0});
  assert.deepEqual(await f.store.settings('production'), before);
});
test('DB: submitted listing record and dependent uploads/chunks are removed locally only', async t => {
  const f = await dbTest(t); const s = await f.store.settings('production');
  await f.store.saveSettings('production', {...s, production_enabled: true}, s.revision, s.credentials);
  let d = await f.ready('published-to-delete', 'production');
  const upload = await f.store.beginUpload(d, await f.store.settings('production'), 3, 'photo.jpg');
  await f.store.chunk(upload, 0, Buffer.from([1,2,3]).toString('base64'));
  d = await f.service.publish(d, {confirmed: true, verification_id: d.verification.id});
  const calls = f.remote.calls.length; const result = await deleteAccountData(f.store, account);
  assert.equal(result.drafts, 1); assert.equal(result.submissions, 1); assert.equal(result.uploads, 1);
  assert.equal((await rows(f, 'ail_ebay_chunks')).length, 0);
  assert.equal(f.remote.calls.length, calls); assert(f.remote.items.has('published-to-delete'));
});
test('DB: image-only record associated with deleted seller is removed', async t => {
  const f = await dbTest(t); let d = await f.draft('image-only', 'production');
  d.images = [{id: 'image', source: 'media', seller_key: 'stable-seller', url: 'https://i.ebayimg.com/test.jpg'}];
  await f.store.saveDraft(d, d.revision); assert.equal((await deleteAccountData(f.store, account)).drafts, 1);
});
test('DB: legacy verification with only username is handled', async t => {
  const f = await dbTest(t); let d = await f.ready('legacy', 'production');
  delete d.ebay_account; delete d.verification.seller_key; await f.store.saveDraft(d, d.revision);
  assert.equal((await deleteAccountData(f.store, account)).drafts, 1);
});
test('DB: connection recheck retains private deletion identity', async t => {
  const f = await dbTest(t); const s = await f.store.settings('production');
  const intermediate = {...s}; delete intermediate.seller_id; delete intermediate.seller_key;
  intermediate.production_enabled = false;
  await f.store.saveSettings('production', intermediate, s.revision, s.credentials);
  assert.equal((await deleteAccountData(f.store, account)).disconnected, true);
  assert.equal((await f.store.settings('production')).credentials, undefined);
});
test('DB: stale settings, token refresh and draft writes cannot restore deleted state', async t => {
  const f = await dbTest(t); const d = await f.ready('stale', 'production'); const s = await f.store.settings('production');
  await deleteAccountData(f.store, account);
  await assert.rejects(f.store.saveSettings('production', s, s.revision, s.credentials));
  assert.equal(await f.store.refreshCredentials('production', s.revision, s.credentials, 'old-restored-token'), false);
  await assert.rejects(f.store.saveDraft(d, d.revision));
});
test('DB: pending production OAuth and staff sessions expire, Sandbox OAuth remains', async t => {
  const f = await dbTest(t);
  await f.store.oauthStart('staff', 'production', (await f.store.settings('production')).revision);
  await f.store.oauthStart('staff', 'sandbox', (await f.store.settings('sandbox')).revision);
  await f.db.query("INSERT INTO ail_ebay_sessions(token_hash,csrf,credential_stamp) VALUES('test','test','test')");
  await deleteAccountData(f.store, account);
  assert.equal((await rows(f, 'ail_ebay_sessions')).length, 0);
  const oauth = await rows(f, 'ail_ebay_oauth'); assert.equal(oauth.length, 1); assert.equal(oauth[0].environment, 'sandbox');
});
test('DB: mid-transaction error rolls back account and product deletion', async t => {
  const f = await dbTest(t); const d = await f.ready('rollback', 'production'); const s = await f.store.settings('production');
  const broken = {transaction: fn => f.store.transaction(client => fn({query: (sql, args) => {
    if (sql.startsWith('DELETE FROM ail_ebay_drafts')) throw new Error('simulated failure');
    return client.query(sql, args);
  }}))};
  await assert.rejects(deleteAccountData(broken, account));
  assert.equal((await f.store.draft(d.id)).id, d.id); assert.deepEqual(await f.store.settings('production'), s);
});
test('DB: no identifiers fails before starting transaction', async () => {
  let touched = false;
  await assert.rejects(deleteAccountData({transaction: () => {touched = true;}}, {})); assert.equal(touched, false);
});
test('Netlify route: official signed notification through real adapter and real test SQL', async t => {
  const f = await dbTest(t); const {createAccountDeletionHandler, config} = await import('../netlify/functions/ebay-account-deletion.mjs');
  assert.equal(config.path, '/api/ebay-account-deletion');
  await changeSeller(f, official.message.notification.data.eiasToken, official.message.notification.data.username);
  const d = await f.ready('official-end-to-end', 'production'); const remote = transport();
  const run = createAccountDeletionHandler({store: f.store, env, fetchImpl: remote.fetchImpl, logger: () => {}});
  assert.equal((await run(req())).status, 204); await assert.rejects(f.store.draft(d.id));
  assert.equal((await f.store.settings('production')).credentials, undefined);
});

test('DB: username-only notice matches when no conflicting stable identifier was supplied', async t => {
  const f = await dbTest(t); await f.ready('username-only', 'production');
  const r = await deleteAccountData(f.store, {username: 'test-seller'});
  assert.equal(r.drafts, 1); assert.equal(r.disconnected, true);
});
test('DB: eias-only notice identifies the connected account and linked drafts', async t => {
  const f = await dbTest(t); await f.ready('eias-only', 'production');
  const r = await deleteAccountData(f.store, {eiasToken: 'stable-seller'});
  assert.equal(r.drafts, 1); assert.equal(r.disconnected, true);
});
test('DB: explicit credential clearing also drops the private identity marker', async t => {
  const f = await dbTest(t); let s = await f.store.settings('production');
  await f.service.saveSettings('production', {clear_credentials: true}, s.revision);
  s = await f.store.settings('production'); assert.equal(s._deletion_identity, undefined);
});

test('DB: legacy username does not override conflicting image ownership', async t => {
  const f = await dbTest(t); await changeSeller(f, 'new-stable-key', 'test-seller');
  let d = await f.ready('legacy-reused-username', 'production');
  delete d.ebay_account; delete d.verification.seller_key;
  d.images = [{id: 'image-b', source: 'media', seller_key: 'new-stable-key', url: 'https://i.ebayimg.com/b.jpg'}];
  await f.store.saveDraft(d, d.revision);
  assert.equal((await deleteAccountData(f.store, account)).drafts, 0);
  assert.equal((await f.store.draft(d.id)).id, d.id);
});
