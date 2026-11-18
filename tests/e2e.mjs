import {chromium,expect} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {fileURLToPath} from 'node:url';
const base=process.env.TEST_URL||'http://127.0.0.1:4317';
const output=new URL('../work/test-output/',import.meta.url);
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const errors=[];
try{
  const desktop=await browser.newContext({viewport:{width:1360,height:950},permissions:['clipboard-read','clipboard-write']});
  const phone=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true});
  for(const context of [desktop,phone])await context.addInitScript(()=>{
    globalThis.RTCPeerConnection=class {constructor(){throw new Error('WebRTC disabled for local regression test')}};
  });
  const receiver=await desktop.newPage(),sender=await phone.newPage();
  for(const p of [receiver,sender])p.on('pageerror',e=>errors.push(e.message));
  const res=await receiver.goto(base);expect(res.status()).toBe(200);
  await expect(receiver.getByRole('button',{name:'开启接收'})).toBeEnabled();
  await receiver.screenshot({path:fileURLToPath(new URL('轻传-电脑首页.png',output))});
  await receiver.getByRole('button',{name:'开启接收'}).click();
  await expect(receiver.getByAltText('手机扫码连接此电脑')).toBeVisible({timeout:30000});
  const copyButton=receiver.getByRole('button',{name:'复制配对链接'});
  const link=await copyButton.getAttribute('data-pair-link');
  if(await receiver.evaluate(()=>isSecureContext)){
    await copyButton.click();expect(await receiver.evaluate(()=>navigator.clipboard.readText())).toBe(link);
  }
  const target=new URLSearchParams(new URL(link).hash.slice(1)).get('send');
  const [id,token]=target.split('.');
  const unauthorized=await receiver.evaluate(async id=>(await fetch(`/api/rooms/${id}`)).status,id);expect(unauthorized).toBe(403);
  if(base.startsWith('http://127.0.0.1')){const badOrigin=await fetch(`${base}/api/rooms`,{method:'POST',headers:{Origin:'https://invalid.example'}});expect(badOrigin.status).toBe(403);}
  await sender.goto(link);
  if(new URL(link).protocol==='http:'&&!['127.0.0.1','localhost'].includes(new URL(link).hostname)){
    expect(await sender.evaluate(()=>isSecureContext)).toBe(false);
    expect(await sender.evaluate(()=>!!crypto.subtle)).toBe(false);
    console.log('PASS: phone uses actual LAN HTTP origin without WebCrypto');
  }
  await expect(sender.getByRole('button',{name:'连接这台电脑'})).toBeEnabled();
  await sender.getByRole('button',{name:'连接这台电脑'}).click();
  await expect(receiver.getByText('已经连上了')).toBeVisible({timeout:45000});
  await expect(sender.getByText('已连接到电脑',{exact:true})).toBeVisible({timeout:10000});
  const metadata=await receiver.evaluate(()=>fetch('/api/local-info').then(r=>r.json()));expect(metadata.transport).toBe('websocket');
  const duplicateClaim=await sender.evaluate(async({id,token})=>(await fetch(`/api/rooms/${id}/claim`,{method:'POST',headers:{Authorization:`Bearer ${token}`}})).status,{id,token});expect(duplicateClaim).toBe(409);
  const badRole=await sender.evaluate(async({id,token})=>(await fetch(`/api/rooms/${id}/offer`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({type:'offer',sdp:'this is invalid sdp'})})).status,{id,token});expect(badRole).toBe(405);
  console.log('PASS: same-port local connection with WebRTC completely disabled, role authorization, duplicate connection rejected');
  const fixture=await desktop.newPage();
  await fixture.setContent('<html><body style="margin:0;width:640px;height:440px;background:linear-gradient(155deg,#e5dec5,#7da38c);display:grid;place-items:center;font-family:sans-serif;color:#193c33"><div style="text-align:center"><div style="font-size:70px">↗</div><h1 style="font-size:44px;font-weight:400;letter-spacing:12px">轻传</h1><p style="letter-spacing:5px">KEEP IT CLOSE</p></div></body></html>');
  const png=await fixture.screenshot({clip:{x:0,y:0,width:640,height:440}});await fixture.close();
  const large=Buffer.concat([png,randomBytes(5*1024*1024)]);
  const payloads=[{name:'同名照片.png',mimeType:'image/png',buffer:png},{name:'同名照片.png',mimeType:'image/png',buffer:png},{name:'大照片.png',mimeType:'image/png',buffer:large}];
  await sender.locator('input[type=file]').setInputFiles(payloads);
  await sender.getByRole('button',{name:'发送 3 张照片'}).click();
  await expect(receiver.locator('.photo-card')).toHaveCount(3,{timeout:45000});
  await expect(sender.getByRole('button',{name:'已全部送达'})).toBeVisible({timeout:10000});
  expect(await sender.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const one=receiver.waitForEvent('download');await receiver.getByTitle('下载 大照片.png').click();
  const oneFile=await readFile(await (await one).path());expect(createHash('sha256').update(oneFile).digest('hex')).toBe(createHash('sha256').update(large).digest('hex'));
  const all=receiver.waitForEvent('download');await receiver.getByRole('link',{name:'打包下载'}).click();
  const zip=unzipSync(await readFile(await (await all).path()));
  expect(Object.keys(zip).sort()).toEqual(['同名照片 (1).png','同名照片.png','大照片.png'].sort());
  expect(Buffer.from(zip['大照片.png']).equals(large)).toBe(true);
  console.log('PASS: 3-photo batch, 5 MB chunked transfer, receiver checksum ACK, byte-identical download, ZIP duplicate filenames');
  await receiver.screenshot({path:fileURLToPath(new URL('轻传-电脑接收.png',output)),fullPage:true});
  await sender.screenshot({path:fileURLToPath(new URL('轻传-手机发送.png',output)),fullPage:true});
  await sender.locator('input[type=file]').setInputFiles({name:'not-an-image.txt',mimeType:'text/plain',buffer:Buffer.from('no')});
  await expect(sender.getByRole('alert')).toContainText('不是支持的照片');
  await receiver.getByRole('button',{name:'重新配对'}).click();
  await expect(receiver.getByAltText('手机扫码连接此电脑')).toBeVisible({timeout:10000});
  const nextLink=await receiver.getByRole('button',{name:'复制配对链接'}).getAttribute('data-pair-link');
  await sender.evaluate(hash=>{location.hash=hash},new URL(nextLink).hash);
  await expect(sender.getByRole('button',{name:'连接这台电脑'})).toBeEnabled();
  await sender.getByRole('button',{name:'连接这台电脑'}).click();
  await expect(receiver.getByText('已经连上了')).toBeVisible({timeout:10000});
  await sender.getByRole('button',{name:'发送 3 张照片'}).click();
  await expect(receiver.locator('.photo-card')).toHaveCount(6,{timeout:20000});
  await expect(sender.getByRole('button',{name:'已全部送达'})).toBeVisible();
  console.log('PASS: rescan a new QR in the same tab without leaving the page, retained photos resend correctly');
  await sender.reload();await expect(sender.getByRole('button',{name:'连接这台电脑'})).toBeEnabled();
  await sender.getByRole('button',{name:'连接这台电脑'}).click();
  await expect(sender.getByText('已连接到电脑',{exact:true})).toBeVisible({timeout:10000});
  console.log('PASS: reconnect using the same pairing after phone page refresh');
  await sender.close();await expect(receiver.getByRole('status')).toContainText(/对方已断开|连接暂时中断/,{timeout:15000});
  await receiver.getByRole('button',{name:'重新配对'}).click();await expect(receiver.getByAltText('手机扫码连接此电脑')).toBeVisible({timeout:30000});
  const old=await receiver.evaluate(async({id,token})=>(await fetch(`/api/rooms/${id}`,{headers:{Authorization:`Bearer ${token}`}})).status,{id,token});expect(old).toBe(404);
  await expect(receiver.locator('.photo-card')).toHaveCount(6);
  console.log('PASS: invalid file rejection, disconnect notice, new pairing invalidates old link, existing photos retained');
  expect(errors).toEqual([]);console.log('PASS: no browser page errors; phone layout fits 393 px');
}finally{await browser.close()}
