'use strict';
const crypto=require('node:crypto');
const {promisify}=require('node:util');
const scrypt=promisify(crypto.scrypt);
const pbkdf2=promisify(crypto.pbkdf2);
const {AppError,need,hash,id}=require('./core');
const {StaffAccess}=require('./staff-auth');
const COOKIE='__Host-ailis_ebay';
function key(env,name) {
  const value=Buffer.from(env[name]||'','base64');
  if(value.length!==32) throw new AppError('サーバーの認証・暗号化設定が必要です。',503,'setup_required');
  return value;
}
function seal(value,environment,env=process.env) {
  const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',key(env,'AILIS_EBAY_ENCRYPTION_KEY'),iv);
  c.setAAD(Buffer.from('ailis-ebay:'+environment));
  const data=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);
  return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');
}
function unseal(value,environment,env=process.env) {
  try {
    const raw=Buffer.from(value,'base64'),d=crypto.createDecipheriv('aes-256-gcm',key(env,'AILIS_EBAY_ENCRYPTION_KEY'),raw.subarray(0,12));
    d.setAAD(Buffer.from('ailis-ebay:'+environment)); d.setAuthTag(raw.subarray(12,28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)),d.final()]).toString('utf8'));
  } catch(_) {throw new AppError('eBayの保存済み認証情報を読み取れません。管理者に接続設定の確認を依頼してください。',503,'credentials');}
}
function safeEqual(a,b) {const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||'')); return x.length===y.length && crypto.timingSafeEqual(x,y);}
function origin(env=process.env) {
  let u; try {u=new URL(env.AILIS_EBAY_ORIGIN);} catch(_) {throw new AppError('共通出品画面のURL設定が必要です。',503,'setup_required');}
  need(u.protocol==='https:' && u.origin===env.AILIS_EBAY_ORIGIN,'共通出品画面のHTTPSオリジンを設定してください。');
  return u.origin;
}
function checkRequest(req,env=process.env) {
  if(req.headers['x-ailis-request']!=='trading-v1' || (req.method==='POST' && req.headers.origin!==origin(env))
    || (req.headers.origin && req.headers.origin!==origin(env))
    || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site']!=='same-origin')) {
    throw new AppError('共通出品画面から操作してください。',403,'origin');
  }
  if(req.method==='POST' && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')) throw new AppError('JSON形式で送信してください。',415);
}
function cookie(value,maxAge=28800) {return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;}
class Auth {
  constructor(store,env=process.env) {this.store=store;this.env=env;this.staff=new StaffAccess(store,env,()=>this.stamp());}
  stamp() {return crypto.createHmac('sha256',key(this.env,'AILIS_SESSION_SECRET')).update((this.env.AILIS_LOGIN_USER||'')+'\n'+(this.env.AILIS_LOGIN_PASSWORD_HASH||'')).digest('hex');}
  async session(req) {
    const token=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
    if(!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const r=await this.store.db.query('SELECT csrf FROM ail_ebay_sessions WHERE token_hash=$1 AND credential_stamp=$2 AND expires_at>now()',[hash(token),this.stamp()]);
    if(!r.rows[0]) return null;
    const identity=await this.staff.identity(req,hash(token));
    return identity?{csrf:r.rows[0].csrf,hash:hash(token),...identity}:null;
  }
  async require(req,mutation=true) {
    const session=await this.session(req);
    if(!session) throw new AppError('ログインしてください。',401,'login_required');
    if(mutation && !safeEqual(req.headers['x-ailis-csrf'],session.csrf)) throw new AppError('画面を再読込して操作してください。',403,'csrf');
    return session;
  }
  async login(req,data) {
    const configured=this.env.AILIS_LOGIN_PASSWORD_HASH||'';
    const parts=configured.split(':');
    const isScrypt=parts.length===3 && parts[0]==='scrypt' && /^[a-f0-9]{32}$/.test(parts[1]) && /^[a-f0-9]{128}$/.test(parts[2]);
    const isPbkdf2=parts.length===4 && parts[0]==='pbkdf2-sha256' && parts[1]==='600000' && /^[a-f0-9]{32}$/.test(parts[2]) && /^[a-f0-9]{64}$/.test(parts[3]);
    if(!this.env.AILIS_LOGIN_USER || (!isScrypt && !isPbkdf2)) throw new AppError('担当者ログインの初期設定が必要です。',503,'setup_required');
    // Platform adapters supply metadata separately from caller-controlled headers.
    const address=req.clientAddress??(req.headers['x-vercel-forwarded-for']||req.socket?.remoteAddress||'unknown');
    const rateKey=crypto.createHmac('sha256',key(this.env,'AILIS_SESSION_SECRET')).update(String(address)).digest('hex');
    await this.store.rate('login:'+rateKey,10,900);
    need(typeof data.password==='string' && data.password.length<=1024,'ログイン名とパスワードを確認してください。');
    const calculated=isScrypt?await scrypt(data.password,parts[1],64,{N:32768,r:8,p:1,maxmem:64*1024*1024}):await pbkdf2(data.password,Buffer.from(parts[2],'hex'),600000,32,'sha256');
    if(!safeEqual(data.username,this.env.AILIS_LOGIN_USER) || !safeEqual(calculated.toString('hex'),isScrypt?parts[2]:parts[3])) throw new AppError('ログイン名とパスワードを確認してください。',401,'login_failed');
    await this.store.db.query('DELETE FROM ail_ebay_sessions WHERE expires_at<now()');
    const token=id()+id(),csrf=id()+id();
    await this.store.db.query('INSERT INTO ail_ebay_sessions(token_hash,csrf,credential_stamp) VALUES($1,$2,$3)',[hash(token),csrf,this.stamp()]);
    return {csrf,cookie:cookie(token)};
  }
  async logout(session) {await this.store.db.query('DELETE FROM ail_ebay_sessions WHERE token_hash=$1',[session.hash]);return cookie('',0);}
}
module.exports={seal,unseal,safeEqual,origin,checkRequest,Auth};
