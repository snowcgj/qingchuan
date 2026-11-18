import {chromium,expect} from '@playwright/test';
import {readFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {unzipSync} from 'fflate';

const base=process.env.TEST_URL||'http://127.0.0.1:4317';
const output=new URL('../work/test-output/',import.meta.url);await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const errors=[];
try{
  const desktop=await browser.newContext({viewport:{width:1360,height:980}});
  const mobile=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true});
  for(const context of [desktop,mobile])await context.addInitScript(()=>{
    globalThis.RTCPeerConnection=class {constructor(){throw new Error('WebRTC disabled')}};
    const click=HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click=function(){if(this.href.startsWith('blob:'))throw new Error('Blob downloads disabled for compatibility test');return click.call(this)};
  });
  const pc=await desktop.newPage(),phone=await mobile.newPage();
  for(const page of [pc,phone])page.on('pageerror',error=>errors.push(error.message));
  await pc.goto(base);await pc.getByRole('button',{name:'开启接收',exact:true}).click();
  await expect(pc.getByAltText('手机扫码连接此电脑')).toBeVisible();
  const link=await pc.getByRole('button',{name:'复制配对链接'}).getAttribute('data-pair-link');
  await pc.getByRole('button',{name:'发送到手机',exact:true}).click();
  const fixture=await desktop.newPage();
  await fixture.setContent('<body style="margin:0;background:#dce9d3;color:#193c33;font:36px sans-serif;display:grid;place-items:center;width:600px;height:400px">轻传 · 双向照片测试</body>');
  const png=await fixture.screenshot({clip:{x:0,y:0,width:600,height:400}});await fixture.close();
  const large=Buffer.concat([png,randomBytes(5*1024*1024)]);
  await pc.locator('input[type=file]').setInputFiles([
    {name:'同名照片.png',mimeType:'image/png',buffer:png},
    {name:'同名照片.png',mimeType:'image/png',buffer:png},
    {name:'电脑大图.png',mimeType:'image/png',buffer:large},
  ]);
  await expect(pc.getByRole('button',{name:'发送 3 张照片'})).toBeDisabled();
  await phone.goto(link);await phone.getByRole('button',{name:'连接这台电脑'}).click();
  await expect(pc.getByText('已经连上了')).toBeVisible();
  await pc.getByRole('button',{name:'发送 3 张照片'}).click();
  await expect(phone.locator('.photo-card')).toHaveCount(3,{timeout:20000});
  await expect(pc.getByRole('button',{name:'已全部送达'})).toBeVisible();
  await expect(phone.getByRole('button',{name:/^接收电脑照片/})).toHaveAttribute('aria-pressed','true');
  const nativeLink=phone.getByTitle('下载 电脑大图.png');expect(await nativeLink.evaluate(element=>element.tagName)).toBe('A');
  const linkUsesHttp=await nativeLink.evaluate(element=>element.href.startsWith('http://'));expect(linkUsesHttp).toBe(true);
  const single=phone.waitForEvent('download');await nativeLink.click();
  expect((await readFile(await (await single).path())).equals(large)).toBe(true);
  const originals=[];const collect=download=>originals.push(download);phone.on('download',collect);
  await phone.getByRole('button',{name:'分别下载原图'}).click();
  await expect.poll(()=>originals.length).toBe(3);phone.off('download',collect);
  expect(originals.map(d=>d.suggestedFilename()).sort()).toEqual(['同名照片.png','同名照片 (1).png','电脑大图.png'].sort());
  for(const download of originals){const received=await readFile(await download.path());expect(received.equals(download.suggestedFilename()==='电脑大图.png'?large:png)).toBe(true);}
  const zipLink=phone.getByRole('link',{name:'打包下载（ZIP）',exact:true});
  await expect(zipLink).toHaveClass(/primary/);
  const zipDownloads=[];const countZip=download=>zipDownloads.push(download);phone.on('download',countZip);
  const zipped=phone.waitForEvent('download');await zipLink.click();
  const zipFile=await zipped;const entries=unzipSync(await readFile(await zipFile.path()));expect(Buffer.from(entries['电脑大图.png']).equals(large)).toBe(true);
  expect(Object.keys(entries).length).toBe(3);expect(zipDownloads.length).toBe(1);phone.off('download',countZip);
  expect(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await phone.screenshot({path:fileURLToPath(new URL('轻传-手机接收.png',output)),fullPage:true});
  await pc.screenshot({path:fileURLToPath(new URL('轻传-电脑发送.png',output)),fullPage:true});
  const preview=phone.waitForEvent('popup');await phone.getByTitle('打开原图 电脑大图.png').click();
  const originalPage=await preview;await originalPage.waitForLoadState();expect(new URL(originalPage.url()).pathname.startsWith('/api/downloads/')).toBe(true);await expect(originalPage.locator('img')).toBeVisible();expect(await originalPage.locator('img').evaluate(img=>img.naturalWidth)).toBeGreaterThan(0);await originalPage.close();
  console.log('PASS: real HTTP downloads with Blob downloads disabled; 5 MB original, batch, ZIP byte-identical; original opens in separate tab');

  await pc.locator('input[type=file]').setInputFiles({name:'电脑追加.png',mimeType:'image/png',buffer:png});
  await pc.getByRole('button',{name:'清除已送达'}).click();
  await expect(pc.locator('.queue-item')).toHaveCount(1);
  await phone.getByRole('button',{name:'发送到电脑',exact:true}).click();
  await phone.locator('input[type=file]').setInputFiles({name:'手机回复.png',mimeType:'image/png',buffer:png});
  await Promise.all([pc.getByRole('button',{name:'发送 1 张照片'}).click(),phone.getByRole('button',{name:'发送 1 张照片'}).click()]);
  await pc.getByRole('button',{name:/^接收手机照片/}).click();
  await phone.getByRole('button',{name:/^接收电脑照片/}).click();
  await expect(pc.locator('.photo-card')).toHaveCount(1,{timeout:10000});
  await expect(phone.locator('.photo-card')).toHaveCount(4,{timeout:10000});
  const reply=pc.waitForEvent('download');await pc.getByTitle('下载 手机回复.png').click();expect((await readFile(await (await reply).path())).equals(png)).toBe(true);
  for(const [page,target] of [[pc,'手机'],[phone,'电脑']]){
    await page.getByRole('button',{name:`发送到${target}`,exact:true}).click();
    await expect(page.getByRole('button',{name:'已全部送达'})).toBeVisible();
    await page.getByRole('button',{name:'清除已送达'}).click();await expect(page.locator('.queue-item')).toHaveCount(0);
  }
  await expect(pc.getByText('已经连上了')).toBeVisible();
  expect(errors).toEqual([]);
  console.log('PASS: simultaneous bidirectional files, clear completed preserves pending files, both queues clear without disconnect, no page errors');
}finally{await browser.close()}
