'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const {Store}=require('../lib/ebay/store');
const {Service}=require('../lib/ebay/service');
const {seal}=require('../lib/ebay/security');
const c=require('../lib/ebay/core');
const password='local-test-password-only';
const salt='11223344556677881122334455667788';
const env={AILIS_EBAY_ORIGIN:'https://ailis-ebay.example',AILIS_LOGIN_USER:'test-staff',
  AILIS_LOGIN_PASSWORD_HASH:'scrypt:'+salt+':'+crypto.scryptSync(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024}).toString('hex'),
  AILIS_SESSION_SECRET:Buffer.alloc(32,1).toString('base64'),AILIS_EBAY_ENCRYPTION_KEY:Buffer.alloc(32,2).toString('base64')};
for(const e of ['SANDBOX','PRODUCTION']) for(const k of ['CLIENT_ID','CLIENT_SECRET','RUNAME']) env['EBAY_'+e+'_'+k]='test-'+e+'-'+k;
function product(sku='test-minami') {return {schema:'ailis-ebay-v1',sku,title:'Sample & confirmed <bag>',description:'Confirmed description & details\nSecond line',categoryId:'169291',countryOfOrigin:'France',
  condition:{id:'3000',description:'Some scratches',name:'Used'},pricing:{quickUsd:500,targetUsd:650,autoRejectBelowUsd:500,bestOfferEnabled:true,autoAcceptUsd:null},
  listing:{marketplace:'EBAY_US',format:'FixedPrice',duration:'GTC',quantity:1},itemSpecifics:{Brand:['Louis Vuitton'],Style:['Shoulder Bag'],UPC:['Does not apply']},itemSpecificsRequired:['Size','Model']};}
class FakeEbay {
  constructor() {this.calls=[];this.mode='success';this.items=new Map();this.delay=null;}
  async request(url,opts={}) {
    this.calls.push({url,...opts});
    if(this.delay) await this.delay;
    const call=opts.headers?.['X-EBAY-API-CALL-NAME'];
    const response=body=>({status:200,headers:new Headers(),text:`<${call}Response xmlns="urn:ebay:apis:eBLBaseComponents">${body}</${call}Response>`});
    if(url.includes('/oauth2/token')) return {status:200,text:JSON.stringify({access_token:'mock-access',refresh_token:'mock-refresh',expires_in:7200})};
    if(url.includes('/sell/account/')) {
      const kind=url.match(/\/(fulfillment|return|payment)_policy/)[1];
      return {status:200,text:JSON.stringify({[kind+'Policies']:[{[kind+'PolicyId']:'123',name:'Sample policy',marketplaceId:'EBAY_US'}]})};
    }
    if(url.includes('/image/create_image_from_file')) return {status:201,text:JSON.stringify({imageUrl:'https://i.ebayimg.com/mock.jpg',expirationDate:new Date(Date.now()+86400000*30).toISOString()})};
    if(call==='GetUser') return response('<Ack>Success</Ack><User><UserID>test-seller</UserID><EIASToken>stable-seller</EIASToken></User>');
    if(call==='VerifyAddFixedPriceItem') return response('<Ack>Warning</Ack><Errors><SeverityCode>Warning</SeverityCode><ErrorCode>123</ErrorCode><LongMessage>Test warning</LongMessage></Errors><Fees><Fee><Name>ListingFee</Name><Fee currencyID="USD">0.35</Fee></Fee></Fees>');
    if(call==='AddFixedPriceItem') {
      const sku=opts.body.match(/<SKU>(.*?)<\/SKU>/s)[1],uuid=opts.body.match(/<UUID>(.*?)<\/UUID>/s)[1];
      if(this.mode==='request-error') return response('<Ack>Failure</Ack><Errors><SeverityCode>Error</SeverityCode><ErrorCode>1234</ErrorCode><ErrorClassification>RequestError</ErrorClassification><LongMessage>Invalid category field</LongMessage></Errors>');
      this.items.set(sku,{uuid,item:'123456789012'});
      if(this.mode==='timeout') throw new Error('mock timeout after acceptance');
      if(this.mode==='malformed') return {status:200,text:'<oops'};
      if(this.mode==='http500') return {status:500,text:'unavailable'};
      if(this.mode==='system-error') return response('<Ack>Failure</Ack><Errors><SeverityCode>Error</SeverityCode><ErrorCode>1000</ErrorCode><ErrorClassification>SystemError</ErrorClassification><LongMessage>Service unavailable</LongMessage></Errors>');
      if(this.mode==='duplicate') return response('<Ack>Failure</Ack><Errors><SeverityCode>Error</SeverityCode><ErrorCode>488</ErrorCode><ErrorClassification>RequestError</ErrorClassification><LongMessage>Duplicate UUID</LongMessage></Errors>');
      return response('<Ack>Success</Ack><ItemID>123456789012</ItemID>');
    }
    if(call==='GetItem') {
      const sku=opts.body.match(/<SKU>(.*?)<\/SKU>/s)[1],i=this.items.get(sku);
      return i?response(`<Ack>Success</Ack><Item><ItemID>${i.item}</ItemID><UUID>${i.uuid}</UUID><SKU>${sku}</SKU></Item>`):response('<Ack>Failure</Ack>');
    }
    throw new Error('Unexpected external call '+url);
  }
  adds() {return this.calls.filter(c=>c.headers?.['X-EBAY-API-CALL-NAME']==='AddFixedPriceItem');}
}
async function fixture() {
  const pg=new PGlite();await pg.exec(fs.readFileSync(path.join(__dirname,'../db/ebay.sql'),'utf8'));
  // PGlite has one connection: serialize complete transactions, just as PostgreSQL
  // would serialize contending row locks. All SQL is the production Store's SQL.
  let tail=Promise.resolve();
  async function connect() {const previous=tail;let release;tail=new Promise(r=>release=r);await previous;return {query:(...args)=>pg.query(...args),release};}
  const db={connect,query:async(...args)=>{const cl=await connect();try{return await cl.query(...args);}finally{cl.release();}}};
  const store=new Store(db),remote=new FakeEbay(),service=new Service(store,env,remote.request.bind(remote));
  for(const e of ['sandbox','production']) await store.saveSettings(e,{store_locations:{minami:{location:'Yamagata, Yamagata, Japan',postal_code:'990-2444'},kita:{location:'Yamagata, Yamagata, Japan',postal_code:'990-0810'},izumi:{location:'Izumi-ku, Sendai, Miyagi, Japan',postal_code:'981-3117'}},shipping_policy_id:'123',return_policy_id:'234',payment_policy_id:'345',seller_id:'test-seller',seller_key:'stable-seller',checked_at:c.now(),production_enabled:false,
    credentials:seal({access_token:'mock-'+e,refresh_token:'mock-refresh-'+e,expires_at:c.now()+7200},e,env)},0);
  const draft=async(sku='test-minami',e='sandbox')=>store.create(e,c.product(product(sku)),'minami');
  const ready=async(sku='test-minami',e='sandbox')=>{let d=await draft(sku,e);d.images=[{id:c.id(),url:'https://example.com/a.jpg',name:'Sample',source:'url'}];d=await store.saveDraft(d,d.revision);return service.verify(d);};
  return {pg,db,store,service,remote,draft,ready,close:()=>pg.close()};
}
module.exports={fixture,env,password,product,FakeEbay};
