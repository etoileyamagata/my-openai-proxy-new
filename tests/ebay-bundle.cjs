'use strict';
// Run against an extracted Netlify function artifact, outside the repository:
// node tests/ebay-bundle.cjs <artifact-directory>
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),{createRequire}=require('node:module');
const {fixture,env,password}=require('./ebay-fixture');
(async()=>{
  assert(process.argv[2],'Pass an extracted Netlify function artifact directory.');
  const artifact=path.resolve(process.argv[2]);
  const entry=['netlify/functions/ebay-trading.mjs','ebay-trading.mjs'].map(p=>path.join(artifact,p)).find(p=>fs.existsSync(p));
  assert(entry,'The deployed eBay function is missing.');
  const bundledRequire=createRequire(entry);
  for(const name of ['pg','fast-xml-parser']) {
    assert(bundledRequire.resolve(name).startsWith(artifact+path.sep),name+' must resolve inside the deployment artifact.');
  }
  const bundled=await import(pathToFileURL(entry));
  const f=await fixture();
  try {
    const handler=bundled.createNetlifyHandler({store:f.store,env,remote:f.remote.request.bind(f.remote)});
    const origin=env.AILIS_EBAY_ORIGIN;
    const headers={Origin:origin,'Content-Type':'application/json','X-AILIS-Request':'trading-v1','Sec-Fetch-Site':'same-origin'};
    const post=data=>handler(new Request(origin+'/api/ebay-trading',{method:'POST',headers,body:JSON.stringify(data)}),{ip:'127.0.0.1'});
    const login=await post({action:'login',username:env.AILIS_LOGIN_USER,password});
    assert.equal(login.status,200);const data=await login.json();assert(data.authenticated);
    headers.Cookie=login.headers.get('set-cookie').split(';')[0];headers['X-AILIS-CSRF']=data.csrf;
    let d=await f.draft('bundled-xml');d.images=[{id:'testimage',url:'https://example.com/a.jpg'}];d=await f.store.saveDraft(d,d.revision);
    const verification=await post({action:'verify',draft_id:d.id,expected_revision:d.revision});
    assert.equal(verification.status,200);assert.equal((await verification.json()).draft.state,'verified');
    assert.equal(f.remote.adds().length,0);
    console.log('PASS: isolated deployment dependencies, login/cookie and Trading XML verification. No real eBay calls.');
  } finally {await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
