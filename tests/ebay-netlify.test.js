'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture,env,password}=require('./ebay-fixture');
const {seal}=require('../lib/ebay/security');
const {createTransport}=require('../lib/ebay/service');

test('Netlify HTTP boundary',async t=>{
  const {createNetlifyHandler,config}=await import('../netlify/functions/ebay-trading.mjs');
  const f=await fixture();t.after(f.close);
  const handler=createNetlifyHandler({store:f.store,env,remote:f.remote.request.bind(f.remote)});
  const ip={ip:'192.0.2.10'};
  let cookie='',csrf='';
  const request=(data,extra={})=>new Request(env.AILIS_EBAY_ORIGIN+'/api/ebay-trading',{
    method:'POST',headers:{origin:env.AILIS_EBAY_ORIGIN,'content-type':'application/json',
      'x-ailis-request':'trading-v1',cookie,'x-ailis-csrf':csrf,...extra},body:JSON.stringify(data)});
  async function login() {
    const r=await handler(request({action:'login',username:env.AILIS_LOGIN_USER,password}),ip);
    assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];csrf=(await r.json()).csrf;
    assert.match(r.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/);
  }
  await t.test('web Request/Response carries cookie, CSRF, history, and logout',async()=>{
    assert.equal(config.path,'/api/ebay-trading');await login();
    const session=await handler(new Request(env.AILIS_EBAY_ORIGIN+'/api/ebay-trading?action=session',{
      headers:{cookie,'x-ailis-request':'trading-v1'}}),ip);
    assert.equal((await session.json()).authenticated,true);
    const history=await handler(request({action:'history'}),ip);
    assert.equal(history.status,200);assert.deepEqual((await history.json()).drafts,[]);
    assert.equal(history.headers.get('cache-control'),'no-store');
    assert.equal(history.headers.get('access-control-allow-origin'),null);
    assert.equal((await handler(request({action:'history'},{origin:'https://attacker.example'}),ip)).status,403);
    assert.equal((await handler(request({action:'history'},{'x-ailis-csrf':'wrong'}),ip)).status,403);
    assert.equal((await handler(request({action:'logout'}),ip)).status,200);
    assert.equal((await handler(request({action:'history'}),ip)).status,401);
  });
  await t.test('OAuth redirects survive adapter and POST cannot use callback exemption',async()=>{
    await login();
    const response=await handler(new Request(env.AILIS_EBAY_ORIGIN+'/api/ebay-trading?action=callback&state=bad&code=bad',{headers:{cookie}}),ip);
    assert.equal(response.status,303);assert.equal(response.headers.get('location'),env.AILIS_EBAY_ORIGIN+'/ebay/?connection_error=1');
    assert.equal(await response.text(),'');
    const post=new Request(env.AILIS_EBAY_ORIGIN+'/api/ebay-trading?action=callback',{
      method:'POST',headers:{'content-type':'application/json',origin:'https://attacker.example'},body:JSON.stringify({action:'login',username:env.AILIS_LOGIN_USER,password})});
    assert.equal((await handler(post,ip)).status,403);
  });
  await t.test('body cap uses bytes and handles chunked requests without Content-Length',async()=>{
    const r=await handler(new Request(env.AILIS_EBAY_ORIGIN+'/api/ebay-trading',{
      method:'POST',body:JSON.stringify({payload:'画'.repeat(510000)})}),ip);
    assert.equal(r.status,413);assert.equal(r.headers.get('cache-control'),'no-store');
    assert.equal((await handler(new Request(env.AILIS_EBAY_ORIGIN+'/api/ebay-trading',{
      method:'POST',headers:{origin:env.AILIS_EBAY_ORIGIN,'x-ailis-request':'trading-v1','content-type':'application/json'},body:'{' }),ip)).status,400);
  });
  await t.test('one-MiB image chunks pass through real HTTP adapter into shared storage',async()=>{
    const draft=await f.draft('netlify-image','production');
    const settings=await f.store.settings('production');
    const begin=await handler(request({action:'image_begin',environment:'production',draft_id:draft.id,
      expected_revision:draft.revision,settings_revision:settings.revision,name:'sample.jpg',size:1048576}),ip);
    assert.equal(begin.status,200);
    const start=await begin.json();assert.equal(start.ok,true);
    const chunk=await handler(request({action:'image_chunk',upload_id:start.upload_id,part:0,base64:Buffer.alloc(1048576,1).toString('base64')}),ip);
    assert.equal(chunk.status,200);assert.equal((await chunk.json()).ok,true);
    await f.store.endUpload(start.upload_id);
  });
  await t.test('caller forwarded headers cannot evade login rate limits',async()=>{
    for(let i=0;i<11;i++) {
      const response=await handler(request({action:'login',username:'wrong',password:'wrong'},
        {'x-vercel-forwarded-for':'spoof-'+i,'x-forwarded-for':'spoof-'+i,'x-nf-client-connection-ip':'spoof-'+i}),{ip:'192.0.2.99'});
      assert.equal(response.status,i<10?401:429);
    }
  });
  await t.test('deadline exhausted by token refresh leaves a durable reservation with no blind Add retry',async()=>{
    const draft=await f.ready('netlify-deadline');
    const settings=await f.store.settings('sandbox');
    await f.store.refreshCredentials('sandbox',settings.revision,settings.credentials,
      seal({access_token:'expired',refresh_token:'mock-refresh',expires_at:0},'sandbox',env));
    let time=0;
    const fetchImpl=async(url,options)=>{
      const result=await f.remote.request(url,options);
      if(url.includes('/oauth2/token')) time=41000;
      return new Response(result.text,{status:result.status,headers:result.headers});
    };
    const deadlineHandler=createNetlifyHandler({store:f.store,env:{...env,EBAY_SANDBOX_CLIENT_ID:'mock',EBAY_SANDBOX_CLIENT_SECRET:'mock',EBAY_SANDBOX_RUNAME:'mock'},clock:()=>time,fetchImpl});
    const data={action:'publish',draft_id:draft.id,expected_revision:draft.revision,confirmed:true,verification_id:draft.verification.id};
    const response=await deadlineHandler(request(data),ip);
    assert.equal(response.status,200);assert.equal((await response.json()).draft.state,'unknown');
    assert.equal(f.remote.adds().length,0);
    assert.equal((await f.store.draft(draft.id)).state,'unknown');
    assert.equal((await handler(request(data),ip)).status,409);
    assert.equal(f.remote.adds().length,0);
  });
});

test('transport has a shared deadline across separate eBay calls and never retries',async()=>{
  let time=0,calls=0;
  const transport=createTransport({deadline:40000,clock:()=>time,fetchImpl:async(_url,options)=>{
    calls++;assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
    time=41000;return new Response('ok');
  }});
  assert.equal((await transport('https://api.ebay.com/mock')).text,'ok');
  await assert.rejects(()=>transport('https://api.ebay.com/mock'),e=>e.code==='transport');
  assert.equal(calls,1);
});
