import api from '../../api/ebay-trading.js';
import service from '../../lib/ebay/service.js';

const MAX_BODY=1500000;
async function readBody(request) {
  if(Number(request.headers.get('content-length'))>MAX_BODY) throw new Error('body_limit');
  if(!request.body) return '';
  const reader=request.body.getReader(),parts=[];let size=0;
  try {
    while(true) {
      const {done,value}=await reader.read();if(done) break;
      size+=value.byteLength;
      if(size>MAX_BODY) {await reader.cancel();throw new Error('body_limit');}
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts).toString('utf8');
  } finally {reader.releaseLock();}
}

export function createNetlifyHandler({store,env=process.env,remote,clock=Date.now,fetchImpl=fetch}={}) {
  return async function handler(request,context={}) {
    // Netlify's synchronous limit is 60s. Stop eBay I/O after 40s, leaving
    // time to commit an unknown outcome rather than automatically resending.
    const deadline=clock()+40000;
    const headers=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    let status=200,body=null;
    const res={
      setHeader(name,value) {headers.set(name,value);},
      status(value) {status=value;return this;},
      json(value) {headers.set('Content-Type','application/json; charset=utf-8');body=JSON.stringify(value);return this;},
      end() {return this;}
    };
    let raw='';
    try {if(request.method==='POST') raw=await readBody(request);}
    catch(error) {
      const limit=error.message==='body_limit';
      res.status(limit?413:400).json({ok:false,error:limit?'送信データが大きすぎます。画像は分割して送信してください。':'送信データを読み取れませんでした。'});
      return new Response(body,{status,headers});
    }
    const req={method:request.method,url:request.url,headers:Object.fromEntries(request.headers),body:raw,
      // context.ip is supplied by Netlify. Never trust forwarded headers here.
      clientAddress:context.ip||'unknown'};
    await api.createHandler({store,env,remote:remote||service.createTransport({deadline,clock,fetchImpl})})(req,res);
    return new Response(body,{status,headers});
  };
}

export default createNetlifyHandler();
export const config={path:'/api/ebay-trading'};
