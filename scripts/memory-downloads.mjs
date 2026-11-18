import {createHash,randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {zipSync} from 'fflate';

const MAX_BYTES=200*1024*1024;
const TTL=15*60*1000;
export function safeFilename(name){return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,200)||'photo';}
function disposition(name,inline=false){
  const clean=safeFilename(name),ascii=clean.replace(/[^\x20-\x7e]/g,'_');
  const encoded=encodeURIComponent(clean).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
  return `${inline?'inline':'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
function sendFile(req,res,{chunks,size,type,name},inline=false){
  let start=0,end=size-1,status=200;
  const range=req.headers.range;
  if(range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}
    if(match[1]){start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),end)}
    else start=Math.max(0,size-Number(match[2]));
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}
    status=206;
  }
  const headers={'Content-Type':type,'Content-Disposition':disposition(name,inline),'Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
  if(inline)headers['Content-Security-Policy']="sandbox; default-src 'none'; style-src 'unsafe-inline'";
  if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${size}`;
  res.writeHead(status,headers);
  if(req.method==='HEAD'){res.end();return;}
  // Snapshot the buffers so a cache eviction cannot truncate an active download.
  const parts=[];let offset=0;
  for(const chunk of chunks){const from=Math.max(0,start-offset),to=Math.min(chunk.length,end+1-offset);if(to>from)parts.push(chunk.subarray(from,to));offset+=chunk.length;if(offset>end)break;}
  const stream=Readable.from(parts);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
}

export function createMemoryDownloads({maxBytes=MAX_BYTES,ttl=TTL,now=Date.now}={}){
  const records=new Map();let reserved=0;
  function drop(record){
    if(!record||records.get(record.key)!==record)return;
    records.delete(record.key);reserved-=record.size;record.chunks=[];record.closed=true;record.hasher=null;
  }
  function prune(){for(const record of records.values())if(record.expires<=now())drop(record);}
  const cleanup=setInterval(prune,30000);cleanup.unref();
  function get(key){prune();const record=records.get(key);return record?.ready?record:null;}
  return {
    reserve(meta){
      if(!Number.isSafeInteger(meta.size)||meta.size<1||meta.size>maxBytes)throw new Error('本地下载缓存暂时已满，请稍后再试');
      prune();
      while(reserved+meta.size>maxBytes){const oldest=Array.from(records.values()).find(record=>record.ready);if(!oldest)throw new Error('本地下载缓存暂时已满，请稍后再试');drop(oldest);}
      const record={key:randomBytes(32).toString('hex'),name:safeFilename(meta.name),size:meta.size,type:meta.type,expectedHash:meta.hash,received:0,chunks:[],created:now(),expires:now()+ttl,ready:false,closed:false,hasher:createHash('sha256')};
      records.set(record.key,record);reserved+=meta.size;return record;
    },
    append(record,chunk){
      if(record.closed||record.ready||record.received+chunk.length>record.size)throw new Error('下载缓存已失效或照片大小不符，请重新发送');
      record.chunks.push(chunk);record.hasher.update(chunk);record.received+=chunk.length;record.expires=now()+ttl;
    },
    complete(record){
      if(record.closed||record.ready||record.received!==record.size||record.hasher.digest('hex')!==record.expectedHash){drop(record);throw new Error('照片下载副本校验失败，请重试');}
      record.ready=true;record.hasher=null;record.expires=now()+ttl;
    },
    drop,
    close(){clearInterval(cleanup);for(const record of records.values())drop(record);},
    handle(req,res,url){
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
      if(url.pathname==='/api/downloads/archive'){
        const keys=(url.searchParams.get('keys')||'').split('.');
        if(keys.length>100||keys.some(key=>! /^[a-f0-9]{64}$/.test(key))){res.writeHead(400);res.end('下载链接无效');return;}
        const files=keys.map(get);
        if(files.some(file=>!file)){res.writeHead(410,{'Content-Type':'text/plain; charset=utf-8'});res.end('部分临时下载链接已过期，请重新发送照片。');return;}
        if(files.reduce((sum,file)=>sum+file.size,0)>maxBytes){res.writeHead(413);res.end('文件过大');return;}
        const entries=Object.create(null);
        for(const file of files){let name=file.name,index=1;const dot=file.name.lastIndexOf('.');while(Object.hasOwn(entries,name))name=dot>0?`${file.name.slice(0,dot)} (${index++})${file.name.slice(dot)}`:`${file.name} (${index++})`;entries[name]=[Buffer.concat(file.chunks,file.size),{mtime:new Date(file.created)}];}
        const data=zipSync(entries,{level:0});
        sendFile(req,res,{chunks:[Buffer.from(data.buffer,data.byteOffset,data.byteLength)],size:data.byteLength,type:'application/zip',name:'轻传照片.zip'});return;
      }
      const match=url.pathname.match(/^\/api\/downloads\/([a-f0-9]{64})(?:\/[^/]+)?$/);
      const record=match&&get(match[1]);
      if(!record){res.writeHead(410,{'Content-Type':'text/plain; charset=utf-8'});res.end('临时下载链接已过期或不存在，请重新发送照片。');return;}
      sendFile(req,res,{...record,name:safeFilename(url.searchParams.get('name')||record.name)},url.searchParams.get('view')==='1');
    },
  };
}
