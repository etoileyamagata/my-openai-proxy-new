'use strict';
const {createHash, randomBytes} = require('node:crypto');
const {XMLParser, XMLValidator} = require('fast-xml-parser');
const NS = 'urn:ebay:apis:eBLBaseComponents';
const TTL = 900;
const MAX_IMAGE = 12 * 1024 * 1024;
const categories = new Set(['31387','169291','52357','45258','2996','261988','261989','261990','261993','261994']);
const fields = ['shipping_policy_id','return_policy_id','payment_policy_id'];
const stores = Object.freeze({minami:'山形南店',kita:'山形北店',izumi:'仙台泉店'});
const environments = {sandbox:'https://api.sandbox.ebay.com',production:'https://api.ebay.com'};
class AppError extends Error {
  constructor(message, status=400, code='invalid', details=[]) { super(message); Object.assign(this,{status,code,details}); }
}
function need(ok, message, code='invalid') { if (!ok) throw new AppError(message,400,code); }
const id = () => randomBytes(16).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => Math.floor(Date.now()/1000);
function environment(env) { need(Object.hasOwn(environments,env),'接続先が不正です。'); return env; }
function clean(value, label, max=200, optional=false) {
  need(typeof value === 'string',label+'は文字列で指定してください。');
  value=value.trim();
  need((optional || value) && [...value].length<=max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/u.test(value)
    && value.isWellFormed(),label+'の入力・文字数を確認してください。');
  return value;
}
function money(value, label) {
  const s=String(value), n=Number(value);
  need(/^[0-9]+(?:\.[0-9]{1,2})?$/.test(s) && n>0 && n<=10000000,label+'は小数2桁以内の正の金額で指定してください。');
  return n.toFixed(2);
}
function imageUrl(value) {
  value=clean(value,'画像URL',1000);
  let u; try {u=new URL(value);} catch (_) {throw new AppError('画像は公開HTTPS URLを指定してください。');}
  need(u.protocol==='https:' && !u.username && !u.password && !u.hash && !/[\s<>"\\]/.test(value),'画像は公開HTTPS URLを指定してください。');
  return value;
}
function product(input) {
  need(input && input.schema==='ailis-ebay-v1','AILISのeBay商品情報が必要です。');
  const p=structuredClone(input);
  for(const [k,n] of [['sku',50],['title',80],['description',40000],['countryOfOrigin',65]]) p[k]=clean(p[k],k,n);
  p.categoryId=String(p.categoryId);
  need(categories.has(p.categoryId),'AILIS対応カテゴリを選んでください。');
  need(p.condition && /^\d{3,5}$/.test(String(p.condition.id)),'コンディションIDが必要です。');
  p.condition.description=clean(p.condition.description||'','コンディション説明',1000,true);
  need(p.pricing && p.listing,'価格と出品条件が必要です。');
  for(const k of ['quickUsd','targetUsd','autoRejectBelowUsd']) p.pricing[k]=money(p.pricing[k],k);
  need(Number(p.pricing.quickUsd)<=Number(p.pricing.targetUsd) && p.pricing.quickUsd===p.pricing.autoRejectBelowUsd,'QUICK・TARGET・自動拒否価格の関係を確認してください。');
  need(p.pricing.bestOfferEnabled===true && p.pricing.autoAcceptUsd==null,'Best Offer有効・自動承諾なしに対応しています。');
  const l=p.listing;
  need(l.marketplace==='EBAY_US' && l.format==='FixedPrice' && l.duration==='GTC' && l.quantity===1,'米国・固定価格・GTC・数量1に対応しています。');
  need(p.itemSpecifics && typeof p.itemSpecifics==='object' && !Array.isArray(p.itemSpecifics),'商品属性が必要です。');
  const specifics=Object.create(null);
  for(const [key,raw] of Object.entries(p.itemSpecifics)) {
    const name=clean(key,'属性名',65), values=Array.isArray(raw)?raw:[raw];
    need(values.length>0 && values.length<=30,'属性値の数を確認してください。');
    specifics[name]=values.map(v=>clean(v,name,name==='California Prop 65 Warning'?800:65));
    if(name==='UPC') need(values.length===1,'UPCは1つだけ指定してください。');
  }
  // The legacy "required" list contains review priorities, including skippable fields.
  // Let VerifyAddFixedPriceItem decide actual category requirements; never invent values.
  specifics['Country of Origin']=[p.countryOfOrigin];
  need(Object.keys(specifics).filter(k=>k!=='UPC').length<=45,'商品属性は製造国を含め45項目以内で指定してください。');
  p.itemSpecifics=specifics;
  return p;
}
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const tag = (name,value) => `<${name}>${escape(value)}</${name}>`;
const request = (call,body='') => `<?xml version="1.0" encoding="utf-8"?><${call}Request xmlns="${NS}"><ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel>${body}</${call}Request>`;
function storeLocations(input) {
  need(input && typeof input==='object' && !Array.isArray(input),'店舗別の商品所在地を指定してください。');
  const result={};
  for(const [store,value] of Object.entries(input)) {
    need(Object.hasOwn(stores,store),'登録されていない店舗です。','store_unknown');
    need(value && typeof value==='object' && !Array.isArray(value),'店舗別の商品所在地を確認してください。');
    const location=clean(value.location,stores[store]+'の商品所在地',80,true);
    const postal_code=clean(value.postal_code,stores[store]+'の郵便番号',10,true);
    if(location || postal_code) {
      need(location && /^[\x20-\x7e]+$/.test(location),stores[store]+'の商品所在地を英語で指定してください。');
      need(/^\d{3}-?\d{4}$/.test(postal_code),stores[store]+'の日本の郵便番号を指定してください。');
    }
    result[store]={location,postal_code};
  }
  return result;
}
function itemLocation(draft,s) {
  need(Object.hasOwn(stores,draft.store),'商品の在庫店舗を確認し、店舗のAILISから引き継ぎ直してください。','store_unknown');
  const address=s.store_locations?.[draft.store];
  need(address?.location && address?.postal_code,stores[draft.store]+'の商品所在地と郵便番号を接続設定で登録してください。','store_location');
  return {store:draft.store,store_name:stores[draft.store],...storeLocations({[draft.store]:address})[draft.store]};
}
function listingXml(call,draft,s) {
  const p=product(draft.product);
  need(s.seller_id,'先にeBayへ接続してください。');
  const {location,postal_code:postal}=itemLocation(draft,s);
  need(draft.images.length>=1 && draft.images.length<=24,'画像を1〜24枚登録してください。');
  let body=tag('SKU',p.sku)+tag('InventoryTrackingMethod','SKU')+tag('UUID',draft.uuid)+tag('Title',p.title);
  body+=tag('Description','<div>'+escape(p.description).replace(/\n/g,'<br>')+'</div>');
  body+=`<PrimaryCategory>${tag('CategoryID',p.categoryId)}</PrimaryCategory>`+tag('CategoryMappingAllowed','false')+tag('ConditionID',p.condition.id);
  if(p.condition.description) body+=tag('ConditionDescription',p.condition.description);
  for(const [k,v] of Object.entries({Country:'JP',Currency:'USD',Site:'US',Location:location,PostalCode:postal,ListingDuration:'GTC',ListingType:'FixedPriceItem',Quantity:1})) body+=tag(k,v);
  body+=`<StartPrice currencyID="USD">${p.pricing.targetUsd}</StartPrice><BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails><ListingDetails><MinimumBestOfferPrice currencyID="USD">${p.pricing.quickUsd}</MinimumBestOfferPrice></ListingDetails>`;
  body+='<PictureDetails>'+draft.images.map(im=>{
    need(!im.expires_at || im.expires_at>now()+TTL,'有効期限が近い画像を登録し直してください。');
    need(im.source!=='media' || im.seller_key===s.seller_key,'別アカウントで登録した画像を登録し直してください。');
    return tag('PictureURL',imageUrl(im.url));
  }).join('')+'</PictureDetails><ItemSpecifics>';
  for(const [name,values] of Object.entries(p.itemSpecifics)) if(name!=='UPC') body+='<NameValueList>'+tag('Name',name)+values.map(v=>tag('Value',v)).join('')+'</NameValueList>';
  body+='</ItemSpecifics>';
  if(p.itemSpecifics.UPC) body+='<ProductListingDetails>'+tag('UPC',p.itemSpecifics.UPC[0])+'<IncludeeBayProductDetails>false</IncludeeBayProductDetails><IncludeStockPhotoURL>false</IncludeStockPhotoURL></ProductListingDetails>';
  body+='<SellerProfiles>';
  for(const [kind,t] of [['shipping','Shipping'],['return','Return'],['payment','Payment']]) {
    need(/^[1-9]\d{0,19}$/.test(s[kind+'_policy_id']||''),kind+'のポリシーIDを設定してください。');
    body+=`<Seller${t}Profile>${tag(t+'ProfileID',s[kind+'_policy_id'])}</Seller${t}Profile>`;
  }
  return request(call,'<Item>'+body+'</SellerProfiles></Item>');
}
const array = v => v==null?[]:Array.isArray(v)?v:[v];
function parse(raw,call) {
  need(typeof raw==='string' && Buffer.byteLength(raw)<=4*1024*1024 && !/<!DOCTYPE|<!ENTITY/i.test(raw) && XMLValidator.validate(raw)===true,'eBayのXML応答を読み取れませんでした。','response');
  const parsed=new XMLParser({ignoreAttributes:false,removeNSPrefix:true,parseTagValue:false,parseAttributeValue:false}).parse(raw);
  const root=parsed[call+'Response'];
  need(root && ['Success','Warning','Failure','PartialFailure'].includes(root.Ack),'eBayの応答を確認できませんでした。','response');
  return {root,result:{ack:root.Ack,messages:array(root.Errors).map(e=>({code:e.ErrorCode||'',severity:e.SeverityCode||'',classification:e.ErrorClassification||'',message:String(e.LongMessage||e.ShortMessage||'').slice(0,1800)})),
    fees:array(root.Fees?.Fee).map(f=>({name:f.Name,value:typeof f.Fee==='object'?f.Fee['#text']:f.Fee,currency:f.Fee?.['@_currencyID']||'USD'}))}};
}
function fingerprint(d,s) {return hash(listingXml('AddFixedPriceItem',d,s)+JSON.stringify([d.environment,s.seller_key,s.revision]));}
function publicSettings(s,env,ready) {
  return {...Object.fromEntries(fields.map(k=>[k,s[k]||''])),environment:env,revision:s.revision,production_enabled:s.production_enabled===true,
    stores:Object.entries(stores).map(([key,name])=>({key,name})),
    store_locations:Object.fromEntries(Object.keys(stores).map(key=>[key,{location:s.store_locations?.[key]?.location||'',postal_code:s.store_locations?.[key]?.postal_code||''}])),
    seller_id:s.seller_id||'',checked_at:s.checked_at||null,oauth_ready:ready,connected:!!s.credentials};
}
module.exports={AppError,need,id,hash,now,clean,environment,environments,product,imageUrl,listingXml,parse,request,tag,fingerprint,publicSettings,fields,stores,storeLocations,itemLocation,TTL,MAX_IMAGE};
