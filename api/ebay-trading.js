'use strict';
const {AppError}=require('../lib/ebay/core');
const {productionStore}=require('../lib/ebay/store');
const {Service}=require('../lib/ebay/service');
const {Auth,checkRequest,origin}=require('../lib/ebay/security');
const {ADMIN_ACTIONS}=require('../lib/ebay/staff-auth');
function createHandler({store,env=process.env,remote}={}) {
  return async function handler(req,res) {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    // Deliberately no wildcard CORS on any seller-account operation.
    try {
      const url=new URL(req.url,origin(env)),action=url.searchParams.get('action');
      if(!['GET','POST'].includes(req.method)) return res.status(405).json({ok:false,error:'GET / POSTのみ使用できます。'});
      const isCallback=req.method==='GET' && action==='callback';
      if(!isCallback) checkRequest(req,env);
      const db=store||productionStore(),auth=new Auth(db,env),service=new Service(db,env,remote);
      if(isCallback) {
        try {
          const session=await auth.require(req,false);
          auth.staff.authorize(session,'oauth_callback');
          const connected=await service.oauthCallback(Object.fromEntries(url.searchParams),session.hash);
          res.setHeader('Location',origin(env)+'/ebay/?connected='+connected);
        } catch(_) {res.setHeader('Location',origin(env)+'/ebay/?connection_error=1');}
        return res.status(303).end();
      }
      if(req.method==='GET' && action==='session') {
        const session=await auth.session(req);
        return res.status(200).json({ok:true,authenticated:!!session,csrf:session?.csrf||'',role:session?.role||'',staff_id:session?.staff_id||'',browser_registered:!!await auth.staff.browser(req)});
      }
      if(req.method!=='POST') return res.status(405).json({ok:false,error:'POSTで操作してください。'});
      const raw=typeof req.body==='string'?req.body:JSON.stringify(req.body||{});
      if(Buffer.byteLength(raw)>1500000) throw new AppError('送信データが大きすぎます。画像は出品画面のファイル選択から送信してください。',413);
      let data;try {data=typeof req.body==='string'?JSON.parse(req.body):req.body;} catch(_) {throw new AppError('JSONを読み取れませんでした。');}
      if(!data || typeof data!=='object' || Array.isArray(data)) throw new AppError('リクエストが不正です。');
      if(data.action==='login' || data.action==='staff_login') {
        const login=await (data.action==='login'?auth.login(req,data):auth.staff.login(req,data));res.setHeader('Set-Cookie',login.cookie);
        return res.status(200).json({ok:true,authenticated:true,csrf:login.csrf});
      }
      const session=await auth.require(req);
      if(data.action==='logout') {res.setHeader('Set-Cookie',await auth.logout(session));return res.status(200).json({ok:true});}
      auth.staff.authorize(session,data.action);
      if(ADMIN_ACTIONS.has(data.action)) {
        const result=await auth.staff.dispatch(req,data,session);
        if(result.cookie) res.setHeader('Set-Cookie',result.cookie);
        return res.status(200).json({ok:true,...result.data});
      }
      return res.status(200).json({ok:true,...await service.dispatch(data,session)});
    } catch(e) {
      const known=e instanceof AppError;
      return res.status(known?e.status:503).json({ok:false,code:known?e.code:'unavailable',error:known?e.message:'共通サーバーで処理を完了できませんでした。出品操作の場合は保存状態・結果を照会してください。',details:known?e.details:[]});
    }
  };
}
module.exports=createHandler();
module.exports.createHandler=createHandler;
