import {chromium,expect} from '@playwright/test';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {unzipSync} from 'fflate';

const base=process.env.TEST_URL||'http://127.0.0.1:4317';
const browser=await chromium.launch({channel:'msedge',headless:true});
const output=new URL('../work/test-output/',import.meta.url);await mkdir(output,{recursive:true});
try{
  const desktop=await browser.newContext({viewport:{width:1360,height:980}});
  const mobile=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true});
  const pc=await desktop.newPage(),phone=await mobile.newPage(),errors=[];
  for(const page of [pc,phone]){
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      const revoke=URL.revokeObjectURL;
      globalThis.revokedPhotos=[];
      URL.revokeObjectURL=url=>{globalThis.revokedPhotos.push(url);revoke(url)};
    });
  }
  await pc.goto(base);
  await pc.getByRole('button',{name:'开启接收',exact:true}).click();
  const pairing=pc.getByRole('button',{name:'复制配对链接'});await expect(pairing).toBeVisible();
  const link=await pairing.getAttribute('data-pair-link');
  await phone.goto(link);await phone.getByRole('button',{name:'连接这台电脑'}).click();
  await expect(pc.getByText('已经连上了')).toBeVisible();
  const fixture=await desktop.newPage();await fixture.setContent('<body style="background:#dce9d3;color:#193c33;font:40px sans-serif">轻传 · 单张移除测试</body>');
  const png=await fixture.screenshot();await fixture.close();
  const image=name=>({name,mimeType:'image/png',buffer:png});
  const queue=page=>page.locator('.queue-item');
  const inbox=page=>page.locator('.photo-card');
  const remove=(page,name)=>page.getByRole('button',{name:'移除 '+name,exact:true});
  const undo=page=>page.getByRole('button',{name:'撤销',exact:true});
  const blobReadable=(page,url)=>page.evaluate(async value=>{try{return(await fetch(value)).ok}catch{return false}},url);
  const queueNames=page=>queue(page).locator('.queue-text strong').allTextContents();

  await pc.getByRole('button',{name:'发送到手机',exact:true}).click();
  await pc.locator('input[type=file]').setInputFiles([image('一.png'),image('二.png'),image('三.png')]);
  const secondUrl=await queue(pc).nth(1).locator('img').getAttribute('src');
  await remove(pc,'二.png').click();await expect(queue(pc)).toHaveCount(2);
  expect(await blobReadable(pc,secondUrl)).toBe(true);
  await pc.locator('input[type=file]').setInputFiles(image('追加.png'));
  await undo(pc).click();expect(await queueNames(pc)).toEqual(['一.png','二.png','三.png','追加.png']);
  await remove(pc,'追加.png').click();await pc.getByRole('button',{name:'关闭移除提示'}).click();
  await pc.getByRole('button',{name:'发送 3 张照片'}).click();
  await expect(pc.getByRole('button',{name:'已全部送达'})).toBeVisible();
  await phone.getByRole('button',{name:/^接收电脑照片/}).click();await expect(inbox(phone)).toHaveCount(3);
  await expect(remove(phone,'二.png')).toHaveCSS('opacity','1');
  await remove(pc,'二.png').click();await expect(queue(pc)).toHaveCount(2);await expect(inbox(phone)).toHaveCount(3);
  await undo(pc).click();await expect(queue(pc)).toHaveCount(3);await expect(pc.getByRole('button',{name:'已全部送达'})).toBeVisible();
  console.log('PASS: desktop removes waiting/delivered items, undo preserves order, new additions, Blob previews and delivery state; peer keeps received files');

  const original=phone.getByTitle('下载 二.png');
  const downloadUrl=await original.getAttribute('href');
  const receivedUrl=await inbox(phone).nth(1).locator('img').getAttribute('src');
  await remove(phone,'二.png').click();await expect(inbox(phone)).toHaveCount(2);
  await expect(phone.locator('.received-summary')).toContainText('已收到 2 张');
  expect(await blobReadable(phone,receivedUrl)).toBe(true);
  const zip=phone.waitForEvent('download');await phone.getByRole('link',{name:'打包下载（ZIP）',exact:true}).click();
  const entries=unzipSync(await readFile(await(await zip).path()));expect(Object.keys(entries).sort()).toEqual(['一.png','三.png']);
  await undo(phone).click();await expect(inbox(phone)).toHaveCount(3);
  const restored=phone.waitForEvent('download');await phone.getByTitle('下载 二.png').click();expect((await readFile(await(await restored).path())).equals(png)).toBe(true);
  expect(await blobReadable(phone,receivedUrl)).toBe(true);
  await remove(phone,'一.png').click();await remove(phone,'二.png').click();
  await undo(phone).click();await expect(inbox(phone)).toHaveCount(2);
  const expiryUrl=await inbox(phone).first().locator('img').getAttribute('src');
  await remove(phone,'二.png').click();await expect(undo(phone)).toBeHidden({timeout:7000});
  expect(await phone.evaluate(url=>globalThis.revokedPhotos.includes(url),expiryUrl)).toBe(true);
  expect(await blobReadable(phone,expiryUrl)).toBe(false);
  expect((await phone.request.get(new URL(downloadUrl,base).href)).ok()).toBe(true);
  console.log('PASS: mobile receiver removal updates count and ZIP contents; undo restores original download; consecutive removals and timeout release Blob without deleting cached original');

  await phone.getByRole('button',{name:'发送到电脑',exact:true}).click();
  await phone.locator('input[type=file]').setInputFiles([image('手机一.png'),image('手机二.png')]);
  await expect(remove(phone,'手机一.png')).toBeVisible();
  await expect(remove(phone,'手机一.png')).toHaveCSS('opacity','1');
  await remove(phone,'手机一.png').click();await expect(queue(phone)).toHaveCount(1);await undo(phone).click();
  expect(await queueNames(phone)).toEqual(['手机一.png','手机二.png']);
  await phone.getByRole('button',{name:'发送 2 张照片'}).click();await expect(phone.getByRole('button',{name:'已全部送达'})).toBeVisible();
  await pc.getByRole('button',{name:/^接收手机照片/}).click();await expect(inbox(pc)).toHaveCount(2);
  await remove(pc,'手机一.png').click();await undo(pc).click();await expect(inbox(pc)).toHaveCount(2);
  await phone.getByRole('button',{name:'移除 手机一.png',exact:true}).click();await expect(queue(phone)).toHaveCount(1);
  await undo(phone).click();await expect(queue(phone)).toHaveCount(2);
  console.log('PASS: mobile sender and desktop receiver both support individual removal and undo');

  await pc.getByRole('button',{name:'发送到手机',exact:true}).click();
  await pc.getByRole('button',{name:'清除已送达'}).click();
  await pc.evaluate(()=>{
    const read=File.prototype.arrayBuffer;
    File.prototype.arrayBuffer=async function(){
      if(this.name==='等待.png')await new Promise(resolve=>{globalThis.resumePhoto=resolve});
      if(this.name==='失败.png')throw new Error('模拟读取失败');
      return read.call(this);
    };
  });
  await pc.locator('input[type=file]').setInputFiles([image('等待.png'),image('稍后.png')]);
  await pc.getByRole('button',{name:'发送 2 张照片'}).click();
  await expect(remove(pc,'等待.png')).toBeDisabled();await expect(remove(pc,'稍后.png')).toBeDisabled();
  await pc.evaluate(()=>globalThis.resumePhoto());await expect(pc.getByRole('button',{name:'已全部送达'})).toBeVisible();
  await pc.getByRole('button',{name:'清除已送达'}).click();
  await pc.locator('input[type=file]').setInputFiles(image('失败.png'));await pc.getByRole('button',{name:'发送 1 张照片'}).click();
  await expect(pc.locator('.queue-text')).toContainText('模拟读取失败');
  await remove(pc,'失败.png').click();await undo(pc).click();await expect(pc.locator('.queue-text')).toContainText('模拟读取失败');
  await remove(pc,'失败.png').click();await pc.getByRole('button',{name:'关闭移除提示'}).click();
  console.log('PASS: removal disabled during a running batch; failed items can be removed/undone without losing error state');

  await phone.getByRole('button',{name:/^接收电脑照片/}).click();
  await remove(phone,'三.png').click();
  phone.once('dialog',dialog=>dialog.accept());await phone.getByRole('button',{name:'清空已接收照片'}).click();
  await expect(inbox(phone)).toHaveCount(0);await expect(undo(phone)).toBeHidden();
  await pc.getByRole('button',{name:/^接收手机照片/}).click();
  await remove(pc,'手机一.png').hover();
  await pc.screenshot({path:fileURLToPath(new URL('单张移除-电脑.png',output)),fullPage:true});
  await remove(pc,'手机一.png').click();
  await pc.screenshot({path:fileURLToPath(new URL('单张移除-撤销.png',output)),fullPage:true});
  await phone.getByRole('button',{name:'发送到电脑',exact:true}).click();
  await phone.screenshot({path:fileURLToPath(new URL('单张移除-手机.png',output)),fullPage:true});
  expect(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(pc.getByText('已经连上了')).toBeVisible();expect(errors).toEqual([]);
  console.log('PASS: clearing inbox finalizes pending removal; no browser errors or mobile horizontal overflow; connection stays usable');
}finally{await browser.close()}
