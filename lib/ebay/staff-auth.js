'use strict';
const crypto=require('node:crypto');
const {AppError,need,hash,id}=require('./core');
const BROWSER_COOKIE='__Host-ailis_ebay_browser';
const STAFF_ACTIONS=new Set(['settings','worklist','history','create','draft','clone','image_begin','image_chunk','image_finish','image_url','image_move','image_remove','verify','publish','reconcile']);
const ADMIN_ACTIONS=new Set(['access_list','browser_register','browser_revoke','staff_import','staff_set_active']);
function tokenFrom(req,name) {
  const value=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);
  return /^[a-f0-9]{64}$/.test(value||'')?value:null;
}
// Staff codes are distributed identifiers, not passwords. The browser token is the credential.
function staffCodeHash(code) {return hash('ailis-staff-code-v1:'+code);}
function sessionCookie(token) {return `__Host-ailis_ebay=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`;}
class StaffAccess {
  constructor(store,env,stamp) {this.store=store;this.env=env;this.stamp=stamp;}
  async browser(req) {
    const token=tokenFrom(req,BROWSER_COOKIE);
    if(!token) return null;
    const r=await this.store.db.query('SELECT id,label,expires_at FROM ail_ebay_browsers WHERE token_hash=$1 AND credential_stamp=$2 AND revoked_at IS NULL AND expires_at>now()',[hash(token),this.stamp()]);
    return r.rows[0]||null;
  }
  async identity(req,sessionHash) {
    const r=await this.store.db.query('SELECT ss.staff_id,ss.browser_id,s.active,s.version=ss.staff_version AS current_version FROM ail_ebay_staff_sessions ss JOIN ail_ebay_staff s ON s.staff_id=ss.staff_id WHERE ss.session_hash=$1',[sessionHash]);
    if(!r.rows.length) return {role:'admin'};
    const staff=r.rows[0],browser=await this.browser(req);
    if(!staff.active || !staff.current_version || !browser || browser.id!==staff.browser_id) return null;
    return {role:'staff',staff_id:staff.staff_id};
  }
  authorize(session,action) {
    if(session.role==='admin') return;
    if(session.role!=='staff' || !STAFF_ACTIONS.has(action)) throw new AppError('この操作は管理者ログインが必要です。',403,'admin_required');
  }
  async login(req,data) {
    const address=req.clientAddress??(req.headers['x-vercel-forwarded-for']||req.socket?.remoteAddress||'unknown');
    const rateKey=crypto.createHmac('sha256',this.stamp()).update(String(address)).digest('hex');
    await this.store.rate('staff-login-ip:'+rateKey,20,900);
    const browser=await this.browser(req);
    if(!browser) throw new AppError('このブラウザーは未登録、または登録期限切れです。管理者に登録を依頼してください。',401,'browser_required');
    await this.store.rate('staff-login-browser:'+browser.id,10,900);
    if(typeof data.code!=='string' || !/^\d{6}$/.test(data.code)) throw new AppError('有効な6桁のスタッフコードを入力してください。',401,'staff_login_failed');
    const token=id()+id(),csrf=id()+id();
    return this.store.transaction(async client=>{
      const r=await client.query('SELECT staff_id,version FROM ail_ebay_staff WHERE code_hash=$1 AND active=true FOR SHARE',[staffCodeHash(data.code)]);
      if(!r.rows[0]) throw new AppError('有効な6桁のスタッフコードを入力してください。',401,'staff_login_failed');
      const current=await client.query('SELECT id FROM ail_ebay_browsers WHERE id=$1 AND credential_stamp=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE',[browser.id,this.stamp()]);
      if(!current.rows.length) throw new AppError('ブラウザーの登録を確認してください。',401,'browser_required');
      await client.query('DELETE FROM ail_ebay_sessions WHERE expires_at<now()');
      await client.query('INSERT INTO ail_ebay_sessions(token_hash,csrf,credential_stamp) VALUES($1,$2,$3)',[hash(token),csrf,this.stamp()]);
      await client.query('INSERT INTO ail_ebay_staff_sessions(session_hash,staff_id,staff_version,browser_id) VALUES($1,$2,$3,$4)',[hash(token),r.rows[0].staff_id,r.rows[0].version,browser.id]);
      return {csrf,cookie:sessionCookie(token)};
    });
  }
  async list(req) {
    const browser=await this.browser(req);
    const staff=await this.store.db.query('SELECT staff_id,active FROM ail_ebay_staff ORDER BY staff_id');
    const browsers=await this.store.db.query('SELECT id,label,created_at,expires_at,revoked_at,credential_stamp=$1 AS current_credentials FROM ail_ebay_browsers ORDER BY created_at DESC LIMIT 200',[this.stamp()]);
    return {staff:staff.rows,browsers:browsers.rows.map(b=>({...b,current:b.id===browser?.id}))};
  }
  async dispatch(req,data,session) {
    need(ADMIN_ACTIONS.has(data.action),'操作が不正です。');
    this.authorize(session,data.action);
    let cookie;
    if(data.action==='browser_register') {
      need(typeof data.label==='string' && data.label.trim().length>0 && data.label.trim().length<=80,'店舗・PCを見分ける名前を80文字以内で入力してください。');
      const token=id()+id(),previous=await this.browser(req);
      await this.store.transaction(async client=>{
        if(previous) await client.query('UPDATE ail_ebay_browsers SET revoked_at=now() WHERE id=$1',[previous.id]);
        await client.query('INSERT INTO ail_ebay_browsers(id,token_hash,credential_stamp,label) VALUES($1,$2,$3,$4)',[id(),hash(token),this.stamp(),data.label.trim()]);
      });
      cookie=`${BROWSER_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=7776000`;
    }
    if(data.action==='browser_revoke') {
      need(typeof data.browser_id==='string' && /^[a-f0-9]{32}$/.test(data.browser_id),'ブラウザーを選んでください。');
      await this.store.db.query('UPDATE ail_ebay_browsers SET revoked_at=now() WHERE id=$1',[data.browser_id]);
    }
    if(data.action==='staff_set_active') {
      need(typeof data.staff_id==='string' && /^\d{3}$/.test(data.staff_id) && typeof data.active==='boolean','スタッフと利用状態を選んでください。');
      await this.store.db.query('UPDATE ail_ebay_staff SET active=$1,version=version+1 WHERE staff_id=$2',[data.active,data.staff_id]);
    }
    if(data.action==='staff_import') await this.importRoster(data.staff_codes);
    return {data:await this.list(req),cookie};
  }
  async importRoster(map) {
    need(map && typeof map==='object' && !Array.isArray(map),'スタッフ一覧を読み取れません。');
    const entries=Object.entries(map);
    need(entries.length>0 && entries.length<=300,'スタッフ一覧は1〜300件で指定してください。');
    need(entries.every(([code,short])=>/^\d{6}$/.test(code) && typeof short==='string' && /^\d{3}$/.test(short)),'スタッフコードは6桁、タイトル用コードは3桁で指定してください。');
    need(new Set(entries.map(([,short])=>short)).size===entries.length,'タイトル用コードが重複しています。');
    await this.store.transaction(async client=>{
      // Serialize roster imports; an old local file must never re-enable a disabled member.
      await client.query('LOCK TABLE ail_ebay_staff IN SHARE ROW EXCLUSIVE MODE');
      for(const [code,short] of entries) {
        await client.query('INSERT INTO ail_ebay_staff(staff_id,code_hash) VALUES($1,$2) ON CONFLICT(staff_id) DO UPDATE SET code_hash=EXCLUDED.code_hash,version=ail_ebay_staff.version+CASE WHEN ail_ebay_staff.code_hash<>EXCLUDED.code_hash THEN 1 ELSE 0 END',[short,staffCodeHash(code)]);
      }
      await client.query('UPDATE ail_ebay_staff SET active=false,version=version+1 WHERE active=true AND NOT(staff_id=ANY($1::text[]))',[entries.map(([,short])=>short)]);
    });
  }
}
module.exports={StaffAccess,staffCodeHash,ADMIN_ACTIONS};
