import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {unzipSync} from 'fflate';
import {createMemoryDownloads} from '../scripts/memory-downloads.mjs';

const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
function store(cache,buffer,name='测试照片.png'){
  const record=cache.reserve({name,size:buffer.length,type:'image/png',hash:hash(buffer)});
  const middle=Math.floor(buffer.length/2);cache.append(record,buffer.subarray(0,middle));cache.append(record,buffer.subarray(middle));cache.complete(record);return record;
}
test('HTTP originals, encoded filenames, ranges, inline preview, and ZIP preserve bytes',async()=>{
  let time=Date.now();const cache=createMemoryDownloads({ttl:1000,now:()=>time}),server=createServer((req,res)=>cache.handle(req,res,new URL(req.url,'http://localhost')));
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    const data=Buffer.from('0123456789 original image data'),one=store(cache,data),two=store(cache,data);
    const path='/api/downloads/'+one.key+'/photo.png';
    const response=await fetch(origin+path);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/^attachment;/);assert.match(response.headers.get('content-disposition'),/filename\*=UTF-8''%/);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),data);
    const partial=await fetch(origin+path,{headers:{Range:'bytes=3-8'}});assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),`bytes 3-8/${data.length}`);assert.deepEqual(Buffer.from(await partial.arrayBuffer()),data.subarray(3,9));
    const suffix=await fetch(origin+path,{headers:{Range:'bytes=-4'}});assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),data.subarray(-4));
    const invalid=await fetch(origin+path,{headers:{Range:'bytes=999-'}});assert.equal(invalid.status,416);
    const head=await fetch(origin+path,{method:'HEAD'});assert.equal(head.headers.get('content-length'),String(data.length));assert.equal((await head.arrayBuffer()).byteLength,0);
    const inline=await fetch(origin+path+'?view=1');assert.match(inline.headers.get('content-disposition'),/^inline;/);assert.match(inline.headers.get('content-security-policy'),/sandbox/);
    const missing=await fetch(origin+'/api/downloads/'+'0'.repeat(64));assert.equal(missing.status,410);
    const archive=await fetch(origin+'/api/downloads/archive?keys='+one.key+'.'+two.key);assert.equal(archive.headers.get('content-type'),'application/zip');
    const files=unzipSync(new Uint8Array(await archive.arrayBuffer()));assert.deepEqual(Object.keys(files).sort(),['测试照片.png','测试照片 (1).png'].sort());for(const item of Object.values(files))assert.deepEqual(Buffer.from(item),data);
    const injection=await fetch(origin+path+'?name='+encodeURIComponent('bad\r\nX-Evil: yes.png'));assert.equal(injection.headers.get('x-evil'),null);
    time+=1001;const expired=await fetch(origin+path);assert.equal(expired.status,410);
  }finally{cache.close();server.close();await once(server,'close')}
});
test('temporary download cache expires, bounds memory, and rejects corrupt/incomplete photos',()=>{
  let time=Date.now();const cache=createMemoryDownloads({maxBytes:20,ttl:1000,now:()=>time});
  try{
    const record=cache.reserve({name:'a.png',size:10,type:'image/png',hash:hash(Buffer.alloc(10))});cache.append(record,Buffer.alloc(5));assert.throws(()=>cache.complete(record),/校验失败/);
    const corrupt=cache.reserve({name:'a.png',size:10,type:'image/png',hash:hash(Buffer.alloc(10))});cache.append(corrupt,Buffer.alloc(10,1));assert.throws(()=>cache.complete(corrupt),/校验失败/);
    store(cache,Buffer.alloc(15));store(cache,Buffer.alloc(15)); // Evicts a completed record instead of exceeding the budget.
    time+=1001;store(cache,Buffer.alloc(20));
    assert.throws(()=>cache.reserve({name:'big.png',size:21,type:'image/png',hash:''}),/已满/);
  }finally{cache.close()}
});
