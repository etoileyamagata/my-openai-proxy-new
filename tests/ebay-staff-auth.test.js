'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {fixture,env,password,product}=require('./ebay-fixture');
const {staffCodeHash}=require('../lib/ebay/staff-auth');

test('registered browser and staff access through the Netlify HTTP boundary',async t=>{
  const {createNetlifyHandler}=await import('../netlify/functions/ebay-trading.mjs');
  const f=await fixture();t.after(f.close);
  const handler=createNetlifyHandler({store:f.store,env,remote:f.remote.request.bind(f.remote)});
  const migration=fs.readFileSync(path.join(__dirname,'../db/ebay-staff-access.sql'),'utf8');
  await f.pg.exec(migration); // Idempotent, and matches fresh installation schema.
  function browser(ip) {
    const jar=new Map();let csrf='';
    return {
      jar,
      async call(action,data={},headers={}) {
        const get=action==='session';
        const request=new Request(env.AILIS_EBAY_ORIGIN+'/api/ebay-trading'+(get?'?action=session':''),{
          method:get?'GET':'POST',headers:{origin:env.AILIS_EBAY_ORIGIN,'content-type':'application/json','x-ailis-request':'trading-v1','x-ailis-csrf':csrf,cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...headers},
          ...(!get?{body:JSON.stringify({action,...data})}:{})});
        const r=await handler(request,{ip});
        const set=r.headers.get('set-cookie');
        if(set) {const [k,v]=set.split(';')[0].split('=');jar.set(k,v);}
        const body=await r.json();if(body.csrf) csrf=body.csrf;
        return {status:r.status,body,set};
      }
    };
  }
  const admin=browser('192.0.2.1'),worker=browser('192.0.2.2');
  let browserId,staffSession;
  await t.test('existing password grants admin only; unregistered browser cannot use staff codes',async()=>{
    assert.equal((await admin.call('login',{username:env.AILIS_LOGIN_USER,password})).status,200);
    assert.equal((await admin.call('session')).body.role,'admin');
    assert.equal((await worker.call('staff_login',{code:'111111'})).body.code,'browser_required');
    assert.equal((await admin.call('staff_import',{staff_codes:{'111111':'001','222222':'022','333333':'003'}})).status,200);
    assert.equal((await admin.call('staff_set_active',{staff_id:'022',active:false})).status,200);
    const rows=(await f.db.query('SELECT * FROM ail_ebay_staff')).rows;
    assert.equal(rows.length,3);assert.equal(rows.find(s=>s.staff_id==='001').code_hash,staffCodeHash('111111'));
    assert.ok(!JSON.stringify(rows).includes('111111'));
  });
  await t.test('enrollment requires admin and CSRF; tokens stay in secure HttpOnly cookies',async()=>{
    assert.equal((await admin.call('browser_register',{label:'Test browser'},{'x-ailis-csrf':'wrong'})).body.code,'csrf');
    const r=await admin.call('browser_register',{label:'Test browser'});
    assert.equal(r.status,200);assert.match(r.set,/__Host-ailis_ebay_browser=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=7776000/);
    assert.ok(!JSON.stringify(r.body).includes(admin.jar.get('__Host-ailis_ebay_browser')));
    worker.jar.set('__Host-ailis_ebay_browser',admin.jar.get('__Host-ailis_ebay_browser'));
    browserId=(await admin.call('access_list')).body.browsers.find(b=>b.current).id;
    assert.equal((await worker.call('session')).body.browser_registered,true);
    assert.equal((await worker.call('staff_login',{code:'222222'})).body.code,'staff_login_failed');
    assert.equal((await worker.call('staff_login',{code:'001'})).body.code,'staff_login_failed');
    assert.equal((await worker.call('staff_login',{code:'111111'})).status,200);
    const s=await worker.call('session');assert.equal(s.body.role,'staff');assert.equal(s.body.staff_id,'001');
    staffSession=worker.jar.get('__Host-ailis_ebay');
  });
  await t.test('staff can prepare the product but cannot change settings, OAuth, staff or browser grants',async()=>{
    for(const action of ['access_list','browser_register','browser_revoke','staff_import','staff_set_active','save_settings','check_connection','oauth_start','policies','new_future_admin_action']) {
      assert.equal((await worker.call(action,{label:'No',staff_id:'022',active:true,staff_codes:{'222222':'022'}})).body.code,'admin_required',action);
    }
    assert.equal((await worker.call('settings',{environment:'production'})).status,200);
    const result=await worker.call('create',{environment:'production',store:'kita',product:product('local-staff-kita')});
    assert.equal(result.status,200);assert.equal(result.body.draft.store,'kita');
    assert.equal(result.body.draft.state,'draft');assert.equal(f.remote.calls.length,0);
    assert.equal((await worker.call('worklist',{}, {'x-ailis-csrf':'bad'})).body.code,'csrf');
    assert.equal((await worker.call('worklist',{}, {origin:'https://attacker.example'})).body.code,'origin');
    const other=browser('192.0.2.3');other.jar.set('__Host-ailis_ebay',staffSession);
    assert.equal((await other.call('session')).body.authenticated,false);
  });
  await t.test('disabled staff is rejected immediately and stays disabled after stale roster import',async()=>{
    await admin.call('staff_set_active',{staff_id:'001',active:false});
    assert.equal((await worker.call('session')).body.authenticated,false);
    await admin.call('staff_import',{staff_codes:{'111111':'001','222222':'022','333333':'003'}});
    assert.equal((await worker.call('staff_login',{code:'111111'})).body.code,'staff_login_failed');
    assert.equal((await worker.call('staff_login',{code:'222222'})).body.code,'staff_login_failed');
    await admin.call('staff_set_active',{staff_id:'001',active:true});
    assert.equal((await worker.call('session')).body.authenticated,false,'re-enabling does not revive old sessions');
    assert.equal((await worker.call('staff_login',{code:'111111'})).status,200);
  });
  await t.test('browser revocation invalidates active staff sessions and further code logins',async()=>{
    await admin.call('browser_revoke',{browser_id:browserId});
    assert.equal((await worker.call('session')).body.authenticated,false);
    assert.equal((await worker.call('staff_login',{code:'111111'})).body.code,'browser_required');
    assert.equal((await admin.call('session')).body.role,'admin');
  });
  await t.test('staff session timeout, browser expiry, credential change, and logout are enforced',async()=>{
    await admin.call('browser_register',{label:'Second test browser'});
    const fresh=browser('192.0.2.20');fresh.jar.set('__Host-ailis_ebay_browser',admin.jar.get('__Host-ailis_ebay_browser'));
    assert.equal((await fresh.call('staff_login',{code:'111111'})).status,200);
    await f.db.query("UPDATE ail_ebay_sessions SET expires_at=now()-interval '1 second' WHERE token_hash IN (SELECT session_hash FROM ail_ebay_staff_sessions)");
    assert.equal((await fresh.call('session')).body.authenticated,false);
    assert.equal((await fresh.call('staff_login',{code:'111111'})).status,200);
    assert.equal((await fresh.call('logout')).status,200);
    const loggedOut=await fresh.call('session');assert.equal(loggedOut.body.authenticated,false);assert.equal(loggedOut.body.browser_registered,true);
    assert.equal((await fresh.call('staff_login',{code:'111111'})).status,200);
    const changed=createNetlifyHandler({store:f.store,env:{...env,AILIS_LOGIN_USER:'changed-admin'},remote:f.remote.request.bind(f.remote)});
    const r=await changed(new Request(env.AILIS_EBAY_ORIGIN+'/api/ebay-trading?action=session',{headers:{'x-ailis-request':'trading-v1',cookie:[...fresh.jar].map(([k,v])=>k+'='+v).join('; ')}}),{ip:'192.0.2.20'});
    const body=await r.json();assert.equal(body.authenticated,false);assert.equal(body.browser_registered,false);
    await f.db.query("UPDATE ail_ebay_browsers SET expires_at=now()-interval '1 second'");
    assert.equal((await fresh.call('session')).body.authenticated,false);
  });
  await t.test('roster import validates duplicates, preserves leading zeros and disables removed members',async()=>{
    assert.equal((await admin.call('staff_import',{staff_codes:{'111111':'001','444444':'001'}})).status,400);
    assert.equal((await admin.call('staff_import',{staff_codes:{'000123':'009','111111':'001'}})).status,200);
    const members=(await admin.call('access_list')).body.staff;
    assert.equal(members.find(x=>x.staff_id==='003').active,false);
    assert.equal(members.find(x=>x.staff_id==='022').active,false);
    assert.equal(members.find(x=>x.staff_id==='009').active,true);
  });
  await t.test('guessing limit follows registered browser across spoofed headers and client IPs',async()=>{
    await admin.call('browser_register',{label:'Rate limit test'});
    for(let i=0;i<11;i++) {
      const attempt=browser('192.0.2.'+(100+i));attempt.jar.set('__Host-ailis_ebay_browser',admin.jar.get('__Host-ailis_ebay_browser'));
      const r=await attempt.call('staff_login',{code:'999999'},{'x-forwarded-for':'spoof-'+i});
      assert.equal(r.status,i<10?401:429);
    }
  });
});
