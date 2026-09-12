'use strict';
// Offline integration test: two isolated browser profiles, real API handler and
// PostgreSQL SQL via PGlite. All eBay and HTTP traffic is intercepted.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.AILIS_PLAYWRIGHT_MODULE||'playwright');
const {fixture,env,password,product}=require('./ebay-fixture');
const {Auth}=require('../lib/ebay/security');
const root=path.resolve(__dirname,'..'),origin=env.AILIS_EBAY_ORIGIN;
const headerLines=fs.readFileSync(path.join(root,'netlify.toml'),'utf8').split('[headers.values]')[1];
const headers=Object.fromEntries([...headerLines.matchAll(/^\s*([\w-]+) = (".*")\s*$/gm)].map(m=>[m[1],JSON.parse(m[2])]));
async function main() {
  const {createNetlifyHandler}=await import('../netlify/functions/ebay-trading.mjs');
  const f=await fixture(),browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
  const handler=createNetlifyHandler({store:f.store,env,remote:f.remote.request.bind(f.remote)}),errors=[];
  async function profile() {
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.protocol==='file:') return route.continue();
      if(url.origin===origin) {
        if(url.pathname==='/api/ebay-trading') {
          const response=await handler(new Request(url,{method:request.method(),headers:await request.allHeaders(),body:request.postData()||undefined}),{ip:'192.0.2.1'});
          return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
        }
        const file=url.pathname==='/ebay/'?'index.html':url.pathname.slice('/ebay/'.length);
        if(!['index.html','style.css','app.js'].includes(file)) return route.fulfill({status:404,body:'Not found'});
        return route.fulfill({status:200,headers:{...headers,'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':'application/javascript'},body:fs.readFileSync(path.join(root,'ebay',file))});
      }
      if(['auth.ebay.com','auth.sandbox.ebay.com'].includes(url.hostname)) {
        return route.fulfill({status:302,headers:{Location:origin+'/api/ebay-trading?action=callback&state='+url.searchParams.get('state')+'&code=mock-code'},body:''});
      }
      if(request.resourceType()==='image') return route.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')});
      return route.abort();
    });
    return context;
  }
  async function idle(page) {await page.waitForFunction(()=>!document.querySelector('#settings-toggle').disabled);}
  async function login(page) {
    await page.locator('#login-user').fill('test-staff');await page.locator('#login-password').fill(password);
    await page.locator('#login-form button').click();await page.locator('#app-content').waitFor({state:'visible'});await idle(page);
  }
  try {
    const pc1=await profile();let page=await pc1.newPage();
    const contract=path.resolve(root,'../AILIS/yrtools_minami/AILIS/tests/ebayContractTest.html');
    let generated=product('file-handoff');
    if(fs.existsSync(contract)) {
      await page.goto(pathToFileURL(contract).href);
      generated=await page.evaluate(()=>{
        const result=AILIS_EBAY.buildFinalEbayJson({categoryId:'169291',pricing:{quickUsd:2100.2,targetUsd:2250.1,highUsd:2400},countryOfOrigin:'France',itemSpecifics:{Brand:'Louis Vuitton'}});
        if(!result.ok) throw new Error(JSON.stringify(result));return result.json;
      });
      await page.addScriptTag({path:path.resolve(root,'../AILIS/yrtools_minami/AILIS/pages/ebayTradingBridge.js')});
      await page.evaluate(({origin,product})=>{
        window.AILIS_EBAY_CONNECTION={portalUrl:origin+'/ebay/'};
        const button=document.createElement('button');button.id='shared-test-open';button.textContent='API出品へ';
        button.onclick=()=>AILIS_EBAY.openEbayTradingPortal(product,'minami');document.body.appendChild(button);
      },{origin,product:generated});
      const popup=pc1.waitForEvent('page');await page.locator('#shared-test-open').click();page=await popup;
    } else await page.goto(origin+'/ebay/#ailis='+encodeURIComponent(JSON.stringify({product:generated,store:'minami'})));
    await page.locator('#login').waitFor({state:'visible'});assert.equal(new URL(page.url()).hash,'');
    assert.equal(await page.locator('#workspace').isVisible(),false);
    await page.reload();await page.locator('#login').waitFor({state:'visible'});await login(page);
    assert.match(await page.locator('#product-summary').innerText(),new RegExp(generated.sku));
    assert.equal(await page.locator('#login-password').inputValue(),'');assert.equal(await page.evaluate(()=>window.opener),null);
    await page.locator('#settings-toggle').click();await page.locator('#connect-ebay').click();
    await page.waitForURL(/connected=sandbox|draft=/);await page.locator('#message').filter({hasText:'eBayに接続しました'}).waitFor();await idle(page);
    assert.match(await page.locator('#product-summary').innerText(),new RegExp(generated.sku));
    await page.locator('#load-policies').click();await idle(page);assert.match(await page.locator('#policy-details').innerText(),/ポリシー/);
    await page.locator('#settings-toggle').click();
    await page.locator('#image-urls').fill('https://example.com/a.jpg\nhttps://example.com/b.jpg');await page.locator('#add-urls').click();await idle(page);
    assert.equal(await page.locator('.image-card').count(),2);
    await page.locator('.image-card').nth(1).locator('[data-direction="-1"]').click();await idle(page);
    assert.equal(await page.locator('.image-card img').first().getAttribute('src'),'https://example.com/b.jpg');
    await page.locator('#verify').click();await idle(page);assert.match(await page.locator('#verification').innerText(),/事前検査を通過/);
    assert.equal(await page.locator('#publish').isEnabled(),false);
    const durl=page.url(),pc2=await profile(),other=await pc2.newPage();
    await other.goto(durl);await other.locator('#login').waitFor({state:'visible'});await login(other);
    assert.match(await other.locator('#draft-state').innerText(),/検査済み/);
    const artifacts=process.env.AILIS_TEST_ARTIFACTS;
    if(artifacts) {fs.mkdirSync(artifacts,{recursive:true});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(artifacts,'ebay-shared-desktop.png'),fullPage:true});}
    await page.locator('#publish-confirm').check();await other.locator('#publish-confirm').check();
    await Promise.all([page.locator('#publish').click(),other.locator('#publish').click()]);await idle(page);await idle(other);
    assert.equal(f.remote.adds().length,1);
    await other.locator('#reload-draft').click();await idle(other);assert.match(await other.locator('#published-result').innerText(),/123456789012/);
    await page.locator('#clone-draft').click();await idle(page);
    const image=Buffer.alloc(3*1048576+10);Buffer.from([255,216,255]).copy(image);
    await page.locator('#image-files').setInputFiles({name:'camera.jpg',mimeType:'image/jpeg',buffer:image});await idle(page);
    assert.equal(await page.locator('.image-card').count(),1);
    await page.locator('#verify').click();await idle(page);await page.locator('#publish-confirm').check();assert.equal(await page.locator('#publish').isEnabled(),false);
    await page.locator('#settings-toggle').click();await page.locator('#production_enabled').check();await page.locator('#settings-form button[type=submit]').click();await idle(page);
    await page.locator('#verify').click();await idle(page);f.remote.mode='timeout';await page.locator('#publish-confirm').check();await page.locator('#publish').click();await idle(page);
    assert.match(await page.locator('#draft-state').innerText(),/結果確認/);await page.locator('#reconcile').click();await idle(page);assert.match(await page.locator('#published-result').innerText(),/出品が完了/);
    await page.setViewportSize({width:390,height:844});await page.evaluate(()=>scrollTo(0,0));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(artifacts) await page.screenshot({path:path.join(artifacts,'ebay-shared-mobile.png'),fullPage:true});
    await page.locator('#logout').click();await page.locator('#login').waitFor({state:'visible'});
    await page.reload();await page.locator('#login').waitFor({state:'visible'});assert.equal(await page.locator('#app-content').isVisible(),false);
    const setupFile=path.resolve(root,'../AILIS/eBay_管理者初期設定.html');
    if(fs.existsSync(setupFile)) {
      await page.goto(pathToFileURL(setupFile).href);await page.locator('#user').fill('browser-setup-staff');await page.locator('#password').fill(password);
      await page.locator('#generate').click();await page.locator('#result').waitFor({state:'visible'});
      const values=await page.locator('#values textarea').evaluateAll(items=>Object.fromEntries(items.map(el=>[el.dataset.key,el.value])));
      assert.equal(await page.locator('#password').inputValue(),'');assert.match(values.AILIS_LOGIN_PASSWORD_HASH,/^pbkdf2-sha256:600000:/);
      const auth=new Auth(f.store,{...env,...values});const login=await auth.login({headers:{'x-vercel-forwarded-for':'setup-check'}},{username:values.AILIS_LOGIN_USER,password});
      assert.ok(login.csrf);await page.locator('#clear').click();assert.equal(await page.locator('#values textarea').count(),0);
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: file HTML handoff, login/reload/OAuth recovery, two independent PCs, one publish, chunk upload, production guard, timeout/reconcile, mobile, logout. No real eBay calls.');
  } finally {await browser.close();await f.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
