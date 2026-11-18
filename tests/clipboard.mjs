import {chromium,expect} from '@playwright/test';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const base=process.env.TEST_URL||'http://127.0.0.1:4317';
const browser=await chromium.launch({channel:'msedge',headless:true});
const output=new URL('../work/test-output/',import.meta.url);await mkdir(output,{recursive:true});
try{
  const desktop=await browser.newContext({viewport:{width:1360,height:980},permissions:['clipboard-read','clipboard-write']});
  const mobile=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true});
  const pc=await desktop.newPage(),phone=await mobile.newPage(),clipboard=await desktop.newPage(),errors=[];
  for(const page of [pc,phone])page.on('pageerror',e=>errors.push(e.message));
  await pc.goto(base);await clipboard.goto(base);
  const fixture=await desktop.newPage();await fixture.setContent('<body style="background:#dce9d3;color:#193c33;font:38px sans-serif">轻传 · 剪贴板图片</body>');
  const png=await fixture.screenshot({clip:{x:0,y:0,width:600,height:400}});await fixture.close();
  const bytes=Array.from(png);
  // Synthetic events cover file-list variations; actual Ctrl+V below covers native clipboard delivery.
  async function paste(page,names=[],{text='',fallback=false,target='body',type='image/png'}={}){
    return page.evaluate(({names,bytes,text,fallback,target,type})=>{
      const data=new DataTransfer();for(const name of names)data.items.add(new File([new Uint8Array(bytes)],name,{type}));
      if(text)data.setData('text/plain',text);
      if(fallback)Object.defineProperty(data,'files',{value:new DataTransfer().files});
      const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});
      document.querySelector(target).dispatchEvent(event);return event.defaultPrevented;
    },{names,bytes,text,fallback,target,type});
  }
  const queue=page=>page.locator('.queue-item');
  const names=page=>queue(page).locator('.queue-text strong').allTextContents();
  const clearQueue=async page=>{
    while(await queue(page).count())await queue(page).first().getByRole('button',{name:/^移除 /}).click();
    const dismiss=page.getByRole('button',{name:'关闭移除提示'});if(await dismiss.isVisible())await dismiss.click();
  };

  expect(await paste(pc,['不应加入.png'])).toBe(false);await expect(queue(pc)).toHaveCount(0);
  await pc.getByRole('button',{name:'发送到手机',exact:true}).click();
  expect(await paste(pc,['剪贴板一.png','剪贴板二.png'],{text:'同一次粘贴还含有文本'})).toBe(true);
  expect(await names(pc)).toEqual(['剪贴板一.png','剪贴板二.png']);
  await expect(pc.locator('.paste-notice')).toContainText('已粘贴 2 张');
  expect(await paste(pc,['备用路径.png'],{fallback:true})).toBe(true);await expect(queue(pc)).toHaveCount(3);
  expect(await paste(pc,[],{text:'C:\\photos\\一.png'})).toBe(false);
  await expect(queue(pc)).toHaveCount(3);await expect(pc.locator('.paste-notice')).toContainText('没有可读取的图片');
  expect(await paste(pc,['文档.txt'],{type:'text/plain'})).toBe(false);await expect(queue(pc)).toHaveCount(3);
  await pc.evaluate(()=>{const field=document.createElement('textarea');field.id='paste-text';document.querySelector('.app-shell').append(field)});
  expect(await paste(pc,['输入框里的图片.png'],{target:'#paste-text'})).toBe(false);await expect(queue(pc)).toHaveCount(3);
  await clipboard.evaluate(()=>navigator.clipboard.writeText('保留普通文字粘贴'));
  await pc.bringToFront();await pc.locator('#paste-text').focus();await pc.keyboard.press('Control+v');
  await expect(pc.locator('#paste-text')).toHaveValue('保留普通文字粘贴');
  await pc.evaluate(()=>document.querySelector('#paste-text').remove());
  await clearQueue(pc);
  console.log('PASS: only desktop send panel handles paste; multiple files and clipboard-item fallback add once, text/path/non-images ignored, editable fields keep native text paste');

  await clipboard.evaluate(async bytes=>navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([new Uint8Array(bytes)],{type:'image/png'})})]),bytes);
  await pc.bringToFront();await pc.locator('.sender-card').click({position:{x:15,y:15}});await pc.keyboard.press('Control+v');
  await expect(queue(pc)).toHaveCount(1);await expect(pc.locator('.paste-notice')).toContainText('确认后点击发送');
  const nativeName=(await names(pc))[0];expect(nativeName).toBeTruthy();
  const pastedBytes=Buffer.from(await queue(pc).locator('img').evaluate(async img=>Array.from(new Uint8Array(await(await fetch(img.src)).arrayBuffer()))));
  await expect(pc.getByRole('button',{name:'发送 1 张照片'})).toBeDisabled();
  await pc.getByRole('button',{name:'开启接收',exact:true}).click();
  const pairing=pc.getByRole('button',{name:'复制配对链接'});await expect(pairing).toBeVisible();
  await phone.goto(await pairing.getAttribute('data-pair-link'));await phone.getByRole('button',{name:'连接这台电脑'}).click();
  await expect(pc.getByText('已经连上了')).toBeVisible();
  await expect(phone.locator('.photo-card')).toHaveCount(0);
  await pc.getByRole('button',{name:'发送 1 张照片'}).click();
  await expect(pc.getByRole('button',{name:'已全部送达'})).toBeVisible();
  await phone.getByRole('button',{name:/^接收电脑照片/}).click();await expect(phone.locator('.photo-card')).toHaveCount(1);
  const download=phone.waitForEvent('download');await phone.getByTitle('下载 '+nativeName).click();
  expect((await readFile(await(await download).path())).equals(pastedBytes)).toBe(true);
  await pc.getByRole('button',{name:'清除已送达'}).click();
  await phone.getByRole('button',{name:'发送到电脑',exact:true}).click();
  expect(await paste(phone,['手机不启用.png'])).toBe(false);await expect(queue(phone)).toHaveCount(0);
  console.log('PASS: real OS clipboard image + Ctrl+V adds a preview without auto-send; explicit transfer and original download preserve bytes; phone workflow unaffected');

  const info=await(await pc.request.get(base+'/api/local-info')).json();
  const lanOrigin=info.origins?.[0]?.origin;
  if(lanOrigin){
    const lan=await desktop.newPage();await lan.goto(lanOrigin);await lan.getByRole('button',{name:'发送到手机',exact:true}).click();
    expect(await lan.evaluate(()=>isSecureContext)).toBe(false);
    await clipboard.evaluate(async bytes=>navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([new Uint8Array(bytes)],{type:'image/png'})})]),bytes);
    await lan.bringToFront();await lan.locator('.sender-card').click({position:{x:15,y:15}});await lan.keyboard.press('Control+v');await expect(queue(lan)).toHaveCount(1);
    await lan.close();console.log('PASS: native Ctrl+V also works on actual LAN HTTP origin without a secure context');
  }

  await pc.bringToFront();
  await pc.evaluate(()=>{
    const read=File.prototype.arrayBuffer;File.prototype.arrayBuffer=async function(){await new Promise(resolve=>{globalThis.resumeClipboardSend=resolve});return read.call(this)};
  });
  await paste(pc,['发送中.png']);await pc.getByRole('button',{name:'发送 1 张照片'}).click();
  await expect(pc.getByRole('button',{name:'正在发送，请保持页面打开'})).toBeVisible();
  await paste(pc,['不应追加.png']);await expect(queue(pc)).toHaveCount(1);await expect(pc.locator('.paste-notice')).toContainText('正在发送');
  await pc.evaluate(()=>globalThis.resumeClipboardSend());await expect(pc.getByRole('button',{name:'已全部送达'})).toBeVisible();
  await pc.getByRole('button',{name:'清除已送达'}).click();
  await paste(pc,Array.from({length:100},(_,i)=>`数量-${i}.png`));await expect(queue(pc)).toHaveCount(100);
  await paste(pc,['超出数量.png']);await expect(queue(pc)).toHaveCount(100);await expect(pc.getByRole('alert')).toContainText('每批最多 100 张');
  console.log('PASS: pasting respects sending lock and the shared 100-photo batch limit');
  await clearQueue(pc);await paste(pc,['粘贴预览.png']);
  await pc.screenshot({path:fileURLToPath(new URL('剪贴板-电脑.png',output)),fullPage:true});
  expect(errors).toEqual([]);
}finally{await browser.close()}
