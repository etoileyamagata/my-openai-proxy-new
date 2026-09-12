'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const c=require('../lib/ebay/core');
const {Service}=require('../lib/ebay/service');
const {Store}=require('../lib/ebay/store');
const {Auth,seal,unseal,checkRequest}=require('../lib/ebay/security');
const {createHandler}=require('../api/ebay-trading');
const {fixture,env,password,product}=require('./ebay-fixture');
const confirmed=d=>({confirmed:true,verification_id:d.verification.id});
test('Shared Trading API',async t=>{
  const f=await fixture();t.after(f.close);
  await t.test('XML retains approved fields and does not guess omitted review priorities',async()=>{
    const d=await f.draft('xml-test'),s=await f.store.settings('sandbox');d.images=[{url:'https://example.com/a.jpg'}];
    const xml=c.listingXml('AddFixedPriceItem',d,s);
    assert.match(xml,/<Country>JP<\/Country>/);assert.match(xml,/<Name>Country of Origin<\/Name><Value>France/);
    assert.match(xml,/<StartPrice currencyID="USD">650.00/);assert.match(xml,/<MinimumBestOfferPrice currencyID="USD">500.00/);
    assert.match(xml,/<Title>Sample &amp; confirmed &lt;bag&gt;/);assert.doesNotMatch(xml,/<MaximumBestOfferPrice>|<Name>Size<\/Name>|<Name>UPC<\/Name>/);
    assert.match(xml,/<ProductListingDetails><UPC>Does not apply/);assert.match(xml,/<InventoryTrackingMethod>SKU/);
    assert.throws(()=>c.product({...product(),sku:''}));assert.throws(()=>c.product({...product(),categoryId:'1'}));
    assert.throws(()=>c.parse('<!DOCTYPE x><GetUserResponse><Ack>Success</Ack></GetUserResponse>','GetUser'));
  });
  await t.test('verification never publishes and final checkbox, ID, expiry are required',async()=>{
    const d=await f.ready('verify-test');assert.equal(f.remote.adds().length,0);assert.equal(d.verification.fees[0].value,'0.35');
    await assert.rejects(()=>f.service.publish(d,{}),/最終確認/);
    await assert.rejects(()=>f.service.publish(d,{confirmed:true,verification_id:'wrong'}),/事前検査/);
    d.verification.expires_at=0;await assert.rejects(()=>f.service.publish(d,confirmed(d)),/事前検査/);
  });
  await t.test('two independent server instances publish a draft only once',async()=>{
    const d=await f.ready('concurrent'),second=new Service(new Store(f.db),env,f.remote.request.bind(f.remote));
    const before=f.remote.adds().length;
    const results=await Promise.allSettled([f.service.publish(structuredClone(d),confirmed(d)),second.publish(structuredClone(d),confirmed(d))]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.remote.adds().length,before+1);
    assert.equal((await f.store.draft(d.id)).state,'published');
  });
  await t.test('changed product with the same SKU cannot bypass shared reservation',async()=>{
    const d=await f.ready('shared-sku');await f.service.publish(d,confirmed(d));
    const p=product('shared-sku');p.title='Edited';let other=await f.store.create('sandbox',c.product(p),'kita');other.images=d.images;other=await f.store.saveDraft(other,other.revision);other=await f.service.verify(other);
    await assert.rejects(()=>f.service.publish(other,confirmed(other)),/SKU/);
  });
  await t.test('worklist removes confirmed listings but keeps unfinished and uncertain work',async()=>{
    const unfinished=await f.draft('worklist-draft');
    let pending=await f.ready('worklist-pending');f.remote.mode='timeout';
    pending=await f.service.publish(pending,confirmed(pending));f.remote.mode='success';
    const done=await f.ready('worklist-done');await f.service.publish(done,confirmed(done));
    const rows=await f.store.worklist();
    assert(rows.some(x=>x.id===unfinished.id));assert(rows.some(x=>x.id===pending.id));
    assert(!rows.some(x=>x.state==='published'));
    assert.equal((await f.store.draft(done.id)).item_id,(await f.service.publish(await f.store.draft(done.id),{})).item_id);
    await f.service.reconcile(pending);
    assert(!(await f.store.worklist()).some(x=>x.id===pending.id));
    const changed=await f.draft('worklist-done');
    assert.equal(changed.state,'published');
  });
  for(const mode of ['timeout','malformed','http500','system-error','duplicate']) await t.test(mode+' is durable and cannot trigger an automatic retry',async()=>{
    const d=await f.ready('unknown-'+mode);f.remote.mode=mode;
    const sent=await f.service.publish(d,confirmed(d));assert.equal(sent.state,'unknown');
    const restarted=new Service(new Store(f.db),env,f.remote.request.bind(f.remote));
    await assert.rejects(()=>restarted.publish(awaitableClone(sent),{}),/送信済み/);
    const result=await restarted.reconcile(await f.store.draft(d.id));assert.equal(result.state,'published');
    f.remote.mode='success';
  });
  await t.test('process death after reserve remains blocked without sending twice',async()=>{
    const d=await f.ready('crash'),s=await f.store.settings('sandbox');await f.store.reserve(d,s);
    const loaded=await new Store(f.db).draft(d.id);assert.equal(loaded.state,'sending');
    await assert.rejects(()=>f.service.publish(loaded,confirmed(d)),/送信済み/);
    assert.equal((await f.service.reconcile(loaded)).state,'sending');
  });
  await t.test('unrelated item with same SKU is not accepted as reconciliation',async()=>{
    let d=await f.ready('older-item');f.remote.mode='timeout';d=await f.service.publish(d,confirmed(d));f.remote.mode='success';
    f.remote.items.get('older-item').uuid='OTHER';assert.equal((await f.service.reconcile(d)).state,'unknown');
  });
  await t.test('explicit request failure can be corrected, reverified and retried',async()=>{
    let d=await f.ready('fix-request'),old=d.uuid;f.remote.mode='request-error';d=await f.service.publish(d,confirmed(d));assert.equal(d.state,'failed');
    f.remote.mode='success';d=await f.service.verify(d);assert.notEqual(d.uuid,old);assert.equal((await f.service.publish(d,confirmed(d))).state,'published');
  });
  await t.test('stale PC cannot overwrite images or publish after another PC edits',async()=>{
    let d=await f.ready('stale'),copy=structuredClone(d);
    d.images.push({id:c.id(),url:'https://example.com/b.jpg'});d=await f.store.saveDraft(f.service.invalidate(d),d.revision);
    await assert.rejects(()=>f.store.saveDraft(copy,copy.revision),/別のPC/);
    await assert.rejects(()=>f.service.publish(copy,confirmed(copy)),/別のPC/);
  });
  await t.test('shared policy changes invalidate existing verification',async()=>{
    const d=await f.ready('changed-settings'),s=await f.store.settings('sandbox');
    await f.service.saveSettings('sandbox',{location:'Tokyo, Japan'},s.revision);
    await assert.rejects(()=>f.service.publish(d,confirmed(d)),/再検査/);
  });
  await t.test('production enablement and sandbox images are kept separate',async()=>{
    const d=await f.ready('production-check','production');await assert.rejects(()=>f.service.publish(d,confirmed(d)),/本番出品/);
    const sd=await f.draft('sandbox-upload'),s=await f.store.settings('sandbox');
    await assert.rejects(()=>f.store.beginUpload(sd,s,100,'x.jpg'),/Sandbox/);
  });
  await t.test('12 MB image uploads use bounded chunks, exact reconstruction and one consumption',async()=>{
    const d=await f.draft('large-upload','production'),s=await f.store.settings('production');
    const bytes=Buffer.alloc(12*1024*1024,7);Buffer.from([255,216,255]).copy(bytes);
    const uid=await f.store.beginUpload(d,s,bytes.length,'camera.jpg');
    for(let i=0;i<12;i++) await f.store.chunk(uid,i,bytes.subarray(i*1048576,(i+1)*1048576).toString('base64'));
    const saved=await f.service.finishUpload(uid);assert.equal(saved.images.length,1);assert.equal(saved.images[0].sha256,c.hash(bytes));
    const upload=f.remote.calls.findLast(x=>x.url.includes('/image/create_image_from_file'));assert.equal(upload.body.get('image').size,bytes.length);
    await assert.rejects(()=>f.service.finishUpload(uid),/処理済み/);
    assert.equal((await f.db.query('SELECT * FROM ail_ebay_chunks')).rows.length,0);
  });
  await t.test('encrypted tokens cannot be decrypted under another environment',async()=>{
    const cipher=seal({access_token:'SECRET'},'production',env);assert.equal(unseal(cipher,'production',env).access_token,'SECRET');
    assert.throws(()=>unseal(cipher,'sandbox',env));
    const publicConfig=await f.service.settings('production');assert.doesNotMatch(JSON.stringify(publicConfig),/mock-|credentials|access_token|client_secret/);
  });
  await t.test('OAuth state is one-use, browser-bound, and account connect resets production',async()=>{
    const url=new URL(await f.service.oauthStart('production','sessionA'));assert.equal(url.hostname,'auth.ebay.com');
    await assert.rejects(()=>f.service.oauthCallback({state:url.searchParams.get('state'),code:'code'},'sessionB'),/別のブラウザ/);
    await f.service.oauthCallback({state:url.searchParams.get('state'),code:'code'},'sessionA');
    await assert.rejects(()=>f.service.oauthCallback({state:url.searchParams.get('state'),code:'code'},'sessionA'),/期限切れ/);
    assert.equal((await f.store.settings('production')).production_enabled,false);
  });
  await t.test('token refresh preserves account and fails on concurrent config changes',async()=>{
    let s=await f.store.settings('sandbox');s.credentials=seal({refresh_token:'mock-refresh',expires_at:0},'sandbox',env);s=await f.store.saveSettings('sandbox',s,s.revision);
    assert.equal(await f.service.token('sandbox',s),'mock-access');
    assert.equal((await f.store.settings('sandbox')).revision,s.revision);
    const stale={...s};await f.service.saveSettings('sandbox',{location:'Kyoto, Japan'},s.revision);
    await assert.rejects(()=>f.service.token('sandbox',stale),/別のPC/);
  });
  await t.test('saving settings cannot overwrite a concurrent refreshed token',async()=>{
    const s=await f.store.settings('sandbox'),old=s.credentials;
    await f.store.refreshCredentials('sandbox',s.revision,old,seal({access_token:'newer-token'},'sandbox',env));
    await assert.rejects(()=>f.store.saveSettings('sandbox',{...s,location:'Osaka, Japan'},s.revision,old),/別のPC/);
    assert.equal(unseal((await f.store.settings('sandbox')).credentials,'sandbox',env).access_token,'newer-token');
  });
  await t.test('incomplete and invalid image uploads fail before eBay is contacted',async()=>{
    const d=await f.draft('incomplete-image','production'),s=await f.store.settings('production'),before=f.remote.calls.length;
    await assert.rejects(()=>f.store.beginUpload(d,s,12582913,'big.jpg'),/12MB/);
    const uid=await f.store.beginUpload(d,s,20,'sample.png');
    await assert.rejects(()=>f.store.chunk(uid,0,'!!bad-data'),/不正/);
    await assert.rejects(()=>f.service.finishUpload(uid),/完了していません/);
    assert.equal(f.remote.calls.length,before);
  });
  await t.test('OAuth state cannot replace a connection changed on another PC',async()=>{
    const url=new URL(await f.service.oauthStart('sandbox','stale-session'));
    const s=await f.store.settings('sandbox');await f.service.saveSettings('sandbox',{location:'Nara, Japan'},s.revision);
    await assert.rejects(()=>f.service.oauthCallback({state:url.searchParams.get('state'),code:'code'},'stale-session'),/別のPC/);
  });
  await t.test('file/null origins cannot invoke API; login sessions, CSRF, logout are enforced',async()=>{
    for(const origin of ['null','https://other.example',undefined]) assert.throws(()=>checkRequest({method:'POST',headers:{origin,'x-ailis-request':'trading-v1','content-type':'application/json'}},env));
    const handler=createHandler({store:f.store,env,remote:f.remote.request.bind(f.remote)});
    async function call(body,headers={}) {
      const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(s){this.statusCode=s;return this;},json(data){this.body=data;return this;}};
      await handler({method:'POST',url:'/api/ebay-trading',body,headers:{origin:env.AILIS_EBAY_ORIGIN,'x-ailis-request':'trading-v1','content-type':'application/json',...headers}},res);return res;
    }
    assert.equal((await call({action:'history'})).statusCode,401);
    const crossSite={headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v;},status(s){this.statusCode=s;return this;},json(data){this.body=data;}};
    await handler({method:'POST',url:'/api/ebay-trading?action=callback',body:JSON.stringify({action:'login',username:'test-staff',password}),headers:{origin:'https://other.example','content-type':'text/plain'}},crossSite);
    assert.equal(crossSite.statusCode,403);assert.equal(crossSite.headers['Set-Cookie'],undefined);
    const login=await call({action:'login',username:'test-staff',password});assert.equal(login.statusCode,200);assert.match(login.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Lax/);
    const cookie=login.headers['Set-Cookie'].split(';')[0],headers={cookie,'x-ailis-csrf':login.body.csrf};
    assert.equal((await call({action:'history'},{cookie})).statusCode,403);
    const history=await call({action:'history'},headers);assert.equal(history.statusCode,200);assert.ok(history.body.drafts.length>0);assert.equal(history.headers['Access-Control-Allow-Origin'],undefined);
    await call({action:'logout'},headers);assert.equal((await call({action:'history'},headers)).statusCode,401);
  });
  await t.test('wrong credentials are rejected and a shared rate limit survives new instances',async()=>{
    const req={headers:{'x-vercel-forwarded-for':'test-login-rate'}};
    for(let i=0;i<10;i++) await assert.rejects(()=>new Auth(new Store(f.db),env).login(req,{username:'test-staff',password:'wrong-password'}),/パスワード/);
    await assert.rejects(()=>new Auth(new Store(f.db),env).login(req,{username:'test-staff',password}),/操作回数/);
  });
});
function awaitableClone(value) {return structuredClone(value);}
