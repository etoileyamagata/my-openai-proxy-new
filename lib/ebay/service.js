'use strict';
const c=require('./core');
const {seal,unseal}=require('./security');
const {conflict}=require('./store');
const policies={shipping:['fulfillment','fulfillmentPolicies','fulfillmentPolicyId'],return:['return','returnPolicies','returnPolicyId'],payment:['payment','paymentPolicies','paymentPolicyId']};
function createTransport({deadline=Infinity,clock=Date.now,fetchImpl=fetch}={}) {
  return async function transport(url,options={}) {
  try {
    const remaining=Math.min(45000,deadline-clock());
    if(remaining<=0) throw new Error('request deadline exceeded');
    const response=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(Math.ceil(remaining))});
    const reader=response.body.getReader(),parts=[];let size=0;
    while(true) {const {done,value}=await reader.read();if(done) break;size+=value.length;if(size>4*1024*1024) {await reader.cancel();throw new Error('response too large');}parts.push(Buffer.from(value));}
    return {status:response.status,headers:response.headers,text:Buffer.concat(parts).toString('utf8')};
  } catch(_) {throw new c.AppError('eBayとの通信を完了できませんでした。',502,'transport');}
  };
}
const transport=createTransport();
class Service {
  constructor(store,env=process.env,remote=transport) {this.store=store;this.env=env;this.remote=remote;}
  keys(env,required=true) {
    c.environment(env);const prefix='EBAY_'+env.toUpperCase()+'_';
    const keys={client:this.env[prefix+'CLIENT_ID'],secret:this.env[prefix+'CLIENT_SECRET'],runame:this.env[prefix+'RUNAME']};
    if(required) c.need(Object.values(keys).every(Boolean),'管理者によるeBay開発者キーと認証戻り先の設定が必要です。','setup_required');
    return keys;
  }
  async settings(env) {return c.publicSettings(await this.store.settings(env),env,Object.values(this.keys(env,false)).every(Boolean));}
  async saveSettings(env,data,revision) {
    const s=await this.store.settings(env);
    const expectedCredentials=s.credentials;
    if(s.revision!==revision) throw conflict();
    c.need(data && typeof data==='object','設定が不正です。');
    c.need(!['access_token','refresh_token','client_id','client_secret','credentials','seller_key','seller_id'].some(k=>Object.hasOwn(data,k)),'認証情報はeBayの接続画面で設定してください。');
    for(const field of c.fields) if(Object.hasOwn(data,field)) s[field]=c.clean(data[field],field,80,true);
    if(Object.hasOwn(data,'production_enabled')) {c.need(!data.production_enabled || s.seller_id,'eBayへの接続確認が必要です。');s.production_enabled=data.production_enabled===true;}
    if(data.clear_credentials===true) {
      delete s.credentials;delete s.seller_key;delete s.seller_id;delete s.checked_at;s.production_enabled=false;
      for(const f of c.fields.filter(k=>k.endsWith('_policy_id'))) s[f]='';
    }
    await this.store.saveSettings(env,s,revision,expectedCredentials);
    return this.settings(env);
  }
  async oauthToken(env,parameters) {
    const keys=this.keys(env),r=await this.remote(c.environments[env]+'/identity/v1/oauth2/token',{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:'Basic '+Buffer.from(keys.client+':'+keys.secret).toString('base64')},body:new URLSearchParams(parameters).toString()});
    c.need(r.status===200,'eBay認証を更新できませんでした。接続をやり直してください。','oauth');
    let token;try {token=JSON.parse(r.text);} catch(_) {throw new c.AppError('eBay認証の応答を確認できません。');}
    c.need(typeof token.access_token==='string' && token.access_token.length<12000 && Number(token.expires_in)>0,'eBay認証の応答を確認できません。');
    return {...token,expires_at:c.now()+Number(token.expires_in)};
  }
  async token(env,s) {
    c.need(s.credentials,'接続設定でeBayアカウントに接続してください。','credentials');
    let token=unseal(s.credentials,env,this.env);
    if(!token.access_token || token.expires_at<c.now()+180) {
      c.need(token.refresh_token,'eBayへの接続をやり直してください。','oauth');
      const fresh=await this.oauthToken(env,{grant_type:'refresh_token',refresh_token:token.refresh_token});
      token={...token,...fresh};
      const saved=await this.store.refreshCredentials(env,s.revision,s.credentials,seal(token,env,this.env));
      if(!saved) throw conflict();
    }
    return token.access_token;
  }
  async trading(env,call,xml,token) {
    const response=await this.remote(c.environments[env]+'/ws/api.dll',{method:'POST',body:xml,headers:{'Content-Type':'text/xml; charset=utf-8',
      'X-EBAY-API-CALL-NAME':call,'X-EBAY-API-SITEID':'0','X-EBAY-API-COMPATIBILITY-LEVEL':'1477','X-EBAY-API-IAF-TOKEN':token}});
    if(response.status!==200) throw new c.AppError('eBay APIとの通信に失敗しました（HTTP '+response.status+'）。',502,'transport');
    return c.parse(response.text,call);
  }
  async user(env,token) {
    const {root,result}=await this.trading(env,'GetUser',c.request('GetUser'),token);
    if(!['Success','Warning'].includes(result.ack)) throw new c.AppError('eBayアカウントを確認できませんでした。',400,'ebay',result.messages);
    const seller=c.clean(root.User?.UserID,'eBayユーザーID',100);
    return {seller_id:seller,seller_key:root.User.EIASToken||seller.toLowerCase(),checked_at:c.now()};
  }
  async oauthStart(env,sessionHash) {
    const keys=this.keys(env),s=await this.store.settings(env);
    await this.store.rate('oauth:'+sessionHash,10,600);
    const state=await this.store.oauthStart(sessionHash,env,s.revision);
    const url=new URL(env==='sandbox'?'https://auth.sandbox.ebay.com/oauth2/authorize':'https://auth.ebay.com/oauth2/authorize');
    const scopes=['https://api.ebay.com/oauth/api_scope','https://api.ebay.com/oauth/api_scope/sell.account.readonly'];
    if(env==='production') scopes.push('https://api.ebay.com/oauth/api_scope/sell.inventory');
    url.search=new URLSearchParams({client_id:keys.client,redirect_uri:keys.runame,response_type:'code',scope:scopes.join(' '),state,prompt:'login'}).toString();
    return url.href;
  }
  async oauthCallback(query,sessionHash) {
    const state=await this.store.oauthConsume(query.state,sessionHash),env=state.environment;
    c.need(!query.error && typeof query.code==='string' && query.code.length<=12000,'eBayでの接続が完了しませんでした。もう一度接続してください。');
    const s=await this.store.settings(env);
    if(s.revision!==state.revision) throw conflict();
    const token=await this.oauthToken(env,{grant_type:'authorization_code',code:query.code,redirect_uri:this.keys(env).runame});
    c.need(token.refresh_token,'eBay認証の更新情報を取得できませんでした。');
    const user=await this.user(env,token.access_token);
    if(s.seller_key!==user.seller_key) for(const f of c.fields.filter(k=>k.endsWith('_policy_id'))) s[f]='';
    await this.store.saveSettings(env,{...s,...user,credentials:seal(token,env,this.env),production_enabled:false},state.revision,s.credentials);
    return env;
  }
  async checkConnection(env,revision) {
    let s=await this.store.settings(env);
    if(s.revision!==revision) throw conflict();
    const expectedSeller=s.seller_key;
    delete s.seller_id;delete s.seller_key;delete s.checked_at;s.production_enabled=false;
    s=await this.store.saveSettings(env,s,s.revision,s.credentials);
    const user=await this.user(env,await this.token(env,s));
    c.need(!expectedSeller || expectedSeller===user.seller_key,'出品者が変更されています。eBayとの接続をやり直してください。');
    // Token refresh can replace ciphertext without changing settings revision.
    const current=await this.store.settings(env);
    if(current.revision!==s.revision) throw conflict();
    await this.store.saveSettings(env,{...current,...user},s.revision,current.credentials);
    return this.settings(env);
  }
  async getPolicies(env) {
    const s=await this.store.settings(env),token=await this.token(env,s);
    return Object.fromEntries(await Promise.all(Object.entries(policies).map(async([kind,[resource,list,key]])=>{
      const r=await this.remote(c.environments[env]+'/sell/account/v1/'+resource+'_policy?marketplace_id=EBAY_US',{headers:{Authorization:'Bearer '+token,Accept:'application/json'}});
      c.need(r.status===200,'ポリシーを取得できません。eBayの設定と接続権限を確認してください。');
      const data=JSON.parse(r.text);
      return [kind,(data[list]||[]).map(p=>({id:String(p[key]),name:p.name||'',details:p}))];
    })));
  }
  editable(d) {c.need(!['sending','unknown','published'].includes(d.state),'送信済みの出品準備は変更できません。出品履歴・結果照会を確認してください。','locked');}
  invalidate(d) {d.verification=null;d.state='draft';delete d.last_result;return d;}
  async verify(d) {
    this.editable(d);
    if(d.state==='failed') d.uuid=c.id().toUpperCase();
    d=await this.store.saveDraft(this.invalidate(d),d.revision);
    const s=await this.store.settings(d.environment),fingerprint=c.fingerprint(d,s);
    const token=await this.token(d.environment,s);
    const {result}=await this.trading(d.environment,'VerifyAddFixedPriceItem',c.listingXml('VerifyAddFixedPriceItem',d,s),token);
    d.last_result=result;
    if(['Success','Warning'].includes(result.ack)) {
      d.state='verified';d.verification={...result,id:c.id(),fingerprint,expires_at:c.now()+c.TTL,seller_id:s.seller_id,settings_revision:s.revision,
        settings:Object.fromEntries(c.fields.map(f=>[f,s[f]||'']))};
    }
    return this.store.saveDraft(d,d.revision,s.revision);
  }
  async publish(d,data) {
    if(d.state==='published') return d;
    this.editable(d);
    c.need(data.confirmed===true,'出品内容の最終確認が必要です。');
    const v=d.verification;
    c.need(d.state==='verified' && v && data.verification_id===v.id && v.expires_at>c.now(),'事前検査を行ってから出品してください。','verify_required');
    const s=await this.store.settings(d.environment);
    c.need(v.fingerprint===c.fingerprint(d,s),'出品内容・設定が変わりました。再検査してください。','verify_required');
    c.need(d.environment!=='production' || s.production_enabled===true,'接続設定で本番出品を有効にしてください。','production_disabled');
    const token=await this.token(d.environment,s),xml=c.listingXml('AddFixedPriceItem',d,s);
    d=await this.store.reserve(d,s);
    // No retries. A timeout or process termination leaves a durable reservation.
    try {
      const {root,result}=await this.trading(d.environment,'AddFixedPriceItem',xml,token);
      d.last_result=result;
      if(['Success','Warning'].includes(result.ack) && /^\d+$/.test(root.ItemID||'')) {d.state='published';d.item_id=root.ItemID;}
      else if(result.ack==='Failure' && result.messages.some(m=>m.severity==='Error')
        && result.messages.every(m=>m.severity!=='Error' || m.classification==='RequestError')
        && !result.messages.some(m=>['488','492','21919067'].includes(m.code) || /duplicate|already/i.test(m.message))) {d.state='failed';d.verification=null;}
      else d.state='unknown';
    } catch(_) {
      d.state='unknown';d.last_result={ack:'Unknown',messages:[{code:'result_unknown',severity:'Error',message:'出品結果を確認できません。再送せず、結果を照会してください。'}],fees:[]};
    }
    return this.store.outcome(d);
  }
  async reconcile(d) {
    c.need(['sending','unknown'].includes(d.state),'結果不明の出品だけ照会できます。');
    const s=await this.store.settings(d.environment);
    c.need(s.seller_key===d.submitted_seller,'出品時のeBayアカウントで接続してください。');
    const {root,result}=await this.trading(d.environment,'GetItem',c.request('GetItem',c.tag('SKU',d.product.sku)),await this.token(d.environment,s));
    const item=root.Item||{};
    if(['Success','Warning'].includes(result.ack) && /^\d+$/.test(item.ItemID||'') && String(item.UUID||'').toUpperCase()===d.uuid && item.SKU===d.product.sku) {
      d.state='published';d.item_id=item.ItemID;d.last_result=result;return this.store.outcome(d);
    }
    d.reconcile_result={message:'この送信の出品結果を確定できません。時間をおいて再照会するか、Seller HubでSKUを確認してください。再出品は停止しています。',found_item_id:item.ItemID||'',...result};
    return this.store.saveDraft(d,d.revision);
  }
  async finishUpload(uploadId) {
    const u=await this.store.consumeUpload(uploadId);
    try {
      let d=await this.store.draft(u.draft_id);this.editable(d);
      const s=await this.store.settings(d.environment);
      if(d.revision!==u.revision || s.revision!==u.settings_revision) throw conflict();
      c.need(d.environment==='production' && s.seller_id,'本番のeBay接続を確認してください。');
      c.need(d.images.length<24,'画像は24枚以内にしてください。');
      const raw=u.raw,digest=c.hash(raw);
      c.need(!d.images.some(im=>im.sha256===digest),'この画像は登録済みです。');
      let type,ext;
      if(raw.subarray(0,3).equals(Buffer.from([255,216,255]))) {type='image/jpeg';ext='jpg';}
      else if(raw.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {type='image/png';ext='png';}
      else if(['GIF87a','GIF89a'].includes(raw.subarray(0,6).toString())) {type='image/gif';ext='gif';}
      else throw new c.AppError('JPEG・PNG・GIF画像を選んでください。');
      const form=new FormData();form.append('image',new Blob([raw],{type}),'image.'+ext);
      const r=await this.remote('https://apim.ebay.com/commerce/media/v1_beta/image/create_image_from_file',{method:'POST',headers:{Authorization:'Bearer '+await this.token('production',s)},body:form});
      c.need(r.status===201,'eBayへの画像登録に失敗しました（HTTP '+r.status+'）。形式・サイズ・接続権限を確認してください。');
      const data=JSON.parse(r.text),expiry=data.expirationDate?Date.parse(data.expirationDate)/1000:null;
      c.need(!data.expirationDate || Number.isFinite(expiry),'画像の有効期限を確認できません。');
      d.images.push({id:c.id(),url:c.imageUrl(data.imageUrl),name:u.name,sha256:digest,source:'media',seller_key:s.seller_key,expires_at:expiry});
      return this.store.saveDraft(this.invalidate(d),d.revision,s.revision);
    } finally {await this.store.endUpload(uploadId);}
  }
  async dispatch(data,session) {
    const action=data.action,env=c.environment(data.environment||'sandbox');
    if(action==='settings') return {settings:await this.settings(env)};
    if(action==='save_settings') return {settings:await this.saveSettings(env,data.settings,data.settings_revision)};
    if(action==='check_connection') return {settings:await this.checkConnection(env,data.settings_revision)};
    if(action==='oauth_start') return {url:await this.oauthStart(env,session.hash)};
    if(action==='policies') return {policies:await this.getPolicies(env)};
    if(action==='history') return {drafts:await this.store.history()};
    if(action==='create') return {draft:await this.store.create(env,c.product(data.product),c.clean(data.store||'','店舗',80,true))};
    if(action==='image_chunk') {await this.store.chunk(data.upload_id,data.part,data.base64);return {};}
    if(action==='image_finish') return {draft:await this.finishUpload(data.upload_id)};
    let d=await this.store.draft(data.draft_id);
    if(action==='draft') return {draft:d};
    if(action==='clone') return {draft:await this.store.create(env,c.product(d.product),d.store)};
    if(action==='publish' && d.state==='published') return {draft:d};
    if(d.revision!==data.expected_revision) throw conflict();
    if(action==='verify') return {draft:await this.verify(d)};
    if(action==='publish') return {draft:await this.publish(d,data)};
    if(action==='reconcile') return {draft:await this.reconcile(d)};
    this.editable(d);
    if(action==='image_begin') {
      c.need(d.images.length<24,'画像は24枚以内にしてください。');
      const s=await this.store.settings(d.environment);c.need(s.seller_id,'先にeBayへ接続してください。');
      return {upload_id:await this.store.beginUpload(d,s,data.size,c.clean(data.name,'ファイル名',200))};
    }
    if(action==='image_url') {
      const urls=Array.isArray(data.urls)?data.urls:[data.url];
      c.need(urls.length>0 && d.images.length+urls.length<=24,'画像は1〜24枚で指定してください。');
      for(const url of urls) {const value=c.imageUrl(url);c.need(!d.images.some(im=>im.url===value),'この画像URLは登録済みです。');d.images.push({id:c.id(),url:value,name:'URL画像',source:'url'});}
    } else if(['image_move','image_remove'].includes(action)) {
      const index=d.images.findIndex(im=>im.id===data.image_id);c.need(index>=0,'画像が見つかりません。');
      if(action==='image_remove') d.images.splice(index,1);
      else {c.need([-1,1].includes(data.direction),'画像移動方向が不正です。');const target=index+data.direction;c.need(target>=0 && target<d.images.length,'画像の移動先を確認してください。');[d.images[index],d.images[target]]=[d.images[target],d.images[index]];}
    } else throw new c.AppError('操作が不正です。');
    return {draft:await this.store.saveDraft(this.invalidate(d),d.revision)};
  }
}
module.exports={Service,transport,createTransport};
