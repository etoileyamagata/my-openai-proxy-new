'use strict';
const {AppError,need,id,hash,now,environment}=require('./core');
const conflict=()=>new AppError('別のPCで内容が変更されました。保存状態を再読込してください。',409,'conflict');
class Store {
  constructor(db) { this.db=db; }
  async transaction(fn) {
    const c=await this.db.connect();
    try { await c.query('BEGIN'); const result=await fn(c); await c.query('COMMIT'); return result; }
    catch(e) {try {await c.query('ROLLBACK');} catch(_) {} throw e;}
    finally {c.release();}
  }
  async settings(env) {
    environment(env);
    const r=await this.db.query('SELECT data,revision FROM ail_ebay_settings WHERE environment=$1',[env]);
    need(r.rows[0],'共通データベースの初期設定が必要です。');
    return {...r.rows[0].data,revision:r.rows[0].revision};
  }
  async saveSettings(env,s,revision,expectedCredentials) {
    const checkCredentials=arguments.length>=4;
    environment(env);
    return this.transaction(async client=>{
      const previous=await client.query('SELECT data,revision FROM ail_ebay_settings WHERE environment=$1 FOR UPDATE',[env]);
      const row=previous.rows[0];
      if(!row || row.revision!==revision || (checkCredentials && (row.data.credentials||null)!==(expectedCredentials||null))) throw conflict();
      const {revision:ignored,...data}=s;
      delete data._deletion_identity;
      if(data.credentials) {
        const account=data.seller_key || data.seller_id ? data : row.data._deletion_identity || row.data;
        if(account.seller_key || account.seller_id) {
          data._deletion_identity={seller_key:account.seller_key||'',seller_id:account.seller_id||''};
        }
      }
      const r=await client.query('UPDATE ail_ebay_settings SET data=$1,revision=revision+1 WHERE environment=$2 AND revision=$3 RETURNING data,revision',[JSON.stringify(data),env,revision]);
      if(!r.rows.length) throw conflict();
      return {...r.rows[0].data,revision:r.rows[0].revision};
    });
  }
  async refreshCredentials(env,revision,oldValue,value) {
    const r=await this.db.query("UPDATE ail_ebay_settings SET data=jsonb_set(data,'{credentials}',to_jsonb($1::text)) WHERE environment=$2 AND revision=$3 AND data->>'credentials'=$4 RETURNING environment",[value,env,revision,oldValue]);
    return !!r.rows.length;
  }
  async draft(draftId) {
    need(typeof draftId==='string' && /^[a-f0-9]{32}$/.test(draftId),'出品準備IDが不正です。');
    const r=await this.db.query('SELECT data,revision FROM ail_ebay_drafts WHERE id=$1',[draftId]);
    need(r.rows[0],'出品準備が見つかりません。');
    return {...r.rows[0].data,revision:r.rows[0].revision};
  }
  async create(env,p,store) {
    const key=hash(JSON.stringify([env,store,p]));
    const d={id:id(),uuid:id().toUpperCase(),environment:env,store,product:p,images:[],state:'draft',verification:null,created_at:now(),updated_at:now()};
    const r=await this.db.query('INSERT INTO ail_ebay_drafts(id,content_key,data) VALUES($1,$2,$3) ON CONFLICT(content_key) DO UPDATE SET content_key=EXCLUDED.content_key RETURNING data,revision',[d.id,key,JSON.stringify(d)]);
    return {...r.rows[0].data,revision:r.rows[0].revision};
  }
  async saveDraft(d,expected,settingsRevision=null) {
    return this.transaction(async c=>{
      if(settingsRevision!==null) {
        const r=await c.query('SELECT revision FROM ail_ebay_settings WHERE environment=$1 FOR SHARE',[d.environment]);
        if(r.rows[0]?.revision!==settingsRevision) throw conflict();
      }
      const {revision:ignored,...data}=d; data.updated_at=now();
      const r=await c.query('UPDATE ail_ebay_drafts SET data=$1,revision=revision+1,updated_at=now() WHERE id=$2 AND revision=$3 RETURNING data,revision',[JSON.stringify(data),d.id,expected]);
      if(!r.rows.length) throw conflict();
      return {...r.rows[0].data,revision:r.rows[0].revision};
    });
  }
  async reserve(d,s) {
    // The transaction commits the unique SKU reservation before any listing call.
    // Row locks and revision checks work across PCs and independent Vercel instances.
    return this.transaction(async c=>{
      const sr=await c.query('SELECT revision FROM ail_ebay_settings WHERE environment=$1 FOR UPDATE',[d.environment]);
      const dr=await c.query('SELECT revision FROM ail_ebay_drafts WHERE id=$1 FOR UPDATE',[d.id]);
      if(sr.rows[0]?.revision!==s.revision || dr.rows[0]?.revision!==d.revision) throw conflict();
      need(d.verification.expires_at>now(),'検査期限が切れました。再検査してください。');
      const reserved=await c.query(`INSERT INTO ail_ebay_submissions(environment,seller,sku,draft_id,attempt,state) VALUES($1,$2,$3,$4,$5,'sending')
        ON CONFLICT(environment,seller,sku) DO UPDATE SET draft_id=EXCLUDED.draft_id,attempt=EXCLUDED.attempt,state='sending',item_id='',updated_at=now()
        WHERE ail_ebay_submissions.state='failed' RETURNING draft_id`,[d.environment,s.seller_key,d.product.sku,d.id,d.uuid]);
      if(!reserved.rows.length) throw new AppError('このSKUは送信済み、または結果確認中です。作業中の商品とeBay側の出品を確認してください。',409,'duplicate');
      const {revision:ignored,...data}={...d,state:'sending',submitted_seller:s.seller_key,submitted_seller_id:s.seller_id,sent_at:now(),updated_at:now()};
      const r=await c.query('UPDATE ail_ebay_drafts SET data=$1,revision=revision+1,updated_at=now() WHERE id=$2 RETURNING revision',[JSON.stringify(data),d.id]);
      return {...data,revision:r.rows[0].revision};
    });
  }
  async outcome(d) {
    return this.transaction(async c=>{
      const {revision:ignored,...data}=d; data.updated_at=now();
      const r=await c.query('UPDATE ail_ebay_drafts SET data=$1,revision=revision+1,updated_at=now() WHERE id=$2 AND revision=$3 RETURNING revision',[JSON.stringify(data),d.id,d.revision]);
      if(!r.rows.length) throw conflict();
      const sr=await c.query('UPDATE ail_ebay_submissions SET state=$1,item_id=$2,updated_at=now() WHERE environment=$3 AND seller=$4 AND sku=$5 AND draft_id=$6 AND attempt=$7 RETURNING draft_id',[d.state,d.item_id||'',d.environment,d.submitted_seller,d.product.sku,d.id,d.uuid]);
      need(sr.rows.length,'出品の送信記録が一致しません。');
      return {...data,revision:r.rows[0].revision};
    });
  }
  async worklist() {
    const r=await this.db.query(`SELECT data->>'id' id,data->>'environment' environment,data->>'store' store,data->>'state' state,
      data->>'item_id' item_id,data->>'updated_at' updated_at,data->'product'->>'sku' sku,data->'product'->>'title' title
      FROM ail_ebay_drafts WHERE data->>'state' <> 'published' ORDER BY updated_at DESC LIMIT 100`);
    return r.rows;
  }
  async rate(key,limit,seconds) {
    await this.db.query('DELETE FROM ail_ebay_rates WHERE expires_at<now()');
    const r=await this.db.query(`INSERT INTO ail_ebay_rates(key,hits,expires_at) VALUES($1,1,now()+$2*interval '1 second')
      ON CONFLICT(key) DO UPDATE SET hits=ail_ebay_rates.hits+1 RETURNING hits`,[key,seconds]);
    if(r.rows[0].hits>limit) throw new AppError('操作回数が多いため、しばらく待ってから試してください。',429,'rate_limit');
  }
  async oauthStart(sessionHash,env,revision) {
    await this.db.query('DELETE FROM ail_ebay_oauth WHERE expires_at<now()');
    const state=id()+id();
    await this.db.query('INSERT INTO ail_ebay_oauth(state_hash,session_hash,environment,revision) VALUES($1,$2,$3,$4)',[hash(state),sessionHash,env,revision]);
    return state;
  }
  async oauthConsume(state,sessionHash) {
    need(typeof state==='string' && /^[a-f0-9]{64}$/.test(state),'eBay認証を最初からやり直してください。');
    const r=await this.db.query('DELETE FROM ail_ebay_oauth WHERE state_hash=$1 AND session_hash=$2 AND expires_at>now() RETURNING environment,revision',[hash(state),sessionHash]);
    need(r.rows.length,'eBay認証の期限切れ、または別のブラウザでの操作です。接続をやり直してください。');
    return r.rows[0];
  }
  async beginUpload(d,s,size,name) {
    need(d.environment==='production','Sandboxでは公開HTTPS画像URLを使ってください。');
    need(Number.isInteger(size) && size>0 && size<=12582912,'画像は12MB以下を選んでください。');
    await this.db.query('DELETE FROM ail_ebay_uploads WHERE expires_at<now()');
    await this.rate('uploads',240,3600);
    const uploadId=id();
    await this.db.query('INSERT INTO ail_ebay_uploads(id,draft_id,revision,settings_revision,size,name) VALUES($1,$2,$3,$4,$5,$6)',[uploadId,d.id,d.revision,s.revision,size,name]);
    return uploadId;
  }
  async chunk(uploadId,part,encoded) {
    need(/^[a-f0-9]{32}$/.test(uploadId) && Number.isInteger(part) && part>=0 && part<12,'画像の送信番号が不正です。');
    need(typeof encoded==='string' && encoded.length<=1398104 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded),'画像データが不正です。');
    const raw=Buffer.from(encoded,'base64');
    need(raw.toString('base64')===encoded && raw.length>0 && raw.length<=1048576,'画像データが不正です。');
    const r=await this.db.query(`INSERT INTO ail_ebay_chunks(upload_id,part,data)
      SELECT id,$2,$3 FROM ail_ebay_uploads WHERE id=$1 AND expires_at>now() AND NOT consumed AND $2*1048576+octet_length($3::bytea)<=size
      ON CONFLICT(upload_id,part) DO UPDATE SET data=EXCLUDED.data RETURNING upload_id`,[uploadId,part,raw]);
    need(r.rows.length,'画像送信の期限が切れました。ファイルを選び直してください。');
  }
  async consumeUpload(uploadId) {
    need(/^[a-f0-9]{32}$/.test(uploadId),'画像の送信IDが不正です。');
    return this.transaction(async c=>{
      const r=await c.query('UPDATE ail_ebay_uploads SET consumed=true WHERE id=$1 AND NOT consumed AND expires_at>now() RETURNING *',[uploadId]);
      need(r.rows.length,'この画像は処理済み、または送信期限切れです。');
      const u=r.rows[0], parts=(await c.query('SELECT part,data FROM ail_ebay_chunks WHERE upload_id=$1 ORDER BY part',[uploadId])).rows;
      need(parts.length===Math.ceil(u.size/1048576) && parts.every((p,i)=>p.part===i && p.data.length===Math.min(1048576,u.size-i*1048576)),'画像の分割送信が完了していません。');
      return {...u,raw:Buffer.concat(parts.map(p=>Buffer.from(p.data)))};
    });
  }
  async endUpload(uploadId) {await this.db.query('DELETE FROM ail_ebay_uploads WHERE id=$1',[uploadId]);}
}
let store;
function productionStore() {
  if(!store) {
    need(process.env.DATABASE_URL,'共通データベースの接続設定が必要です。');
    const {Pool}=require('pg');
    const pool=new Pool({connectionString:process.env.DATABASE_URL,max:3,idleTimeoutMillis:10000,connectionTimeoutMillis:10000,allowExitOnIdle:true});
    pool.on('error',()=>{}); // Do not put connection URLs or credentials into logs.
    store=new Store(pool);
  }
  return store;
}
module.exports={Store,productionStore,conflict};
