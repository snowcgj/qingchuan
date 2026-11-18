'use client';
import {useEffect,useRef,useState} from 'react';
import QRCode from 'qrcode';
import {randomId} from '../lib/browser-crypto';
import {zipSync} from 'fflate';
import {ArrowUpRight,ArrowDownToLine,Check,CheckCheck,ChevronRight,Copy,ImagePlus,Images,Laptop,LoaderCircle,RefreshCw,Send,ShieldCheck,Smartphone,Upload,X,Wifi} from 'lucide-react';
import {Transfer,MAX_FILE,MAX_TOTAL,type Received,type Event} from '../lib/transfer';
type Room={id:string;receiver:string;sender:string;expires:number};
type Item={id:string;file:File;url:string;status:'waiting'|'sending'|'done'|'error';error?:string};
const size=(n:number)=>n<1024*1024?`${Math.max(1,Math.round(n/1024))} KB`:`${(n/1024/1024).toFixed(1)} MB`;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(path:string,token?:string,method='GET',body?:unknown){
  const response=await fetch(path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000),cache:'no-store'});
  const data=await response.json() as Room & {error?:string;offer?:RTCSessionDescriptionInit;answer?:RTCSessionDescriptionInit;claimed?:boolean};if(!response.ok)throw new Error(data.error||'请求失败，请稍后重试');return data;
}
function triggerDownload(url:string,name:string){const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();}
function save(blob:Blob,name:string){const url=URL.createObjectURL(blob);triggerDownload(url,name);setTimeout(()=>URL.revokeObjectURL(url),60000);}
function fileDownloadUrl(file:Received,name=file.name){if(!file.downloadPath)return undefined;const url=new URL(file.downloadPath,location.origin);url.searchParams.set('name',safeName(name));return url.pathname+url.search;}
function archiveDownloadUrl(files:Received[]){if(!files.length||files.some(file=>!file.downloadPath))return undefined;const keys=files.map(file=>file.downloadPath!.split('/')[3]);return '/api/downloads/archive?keys='+keys.join('.');}
function safeName(name:string){return name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,200)||'photo';}
const makeQR=(url:string)=>QRCode.toDataURL(url,{width:320,margin:2,color:{dark:'#173c33',light:'#ffffff'},errorCorrectionLevel:'M'});
async function copyText(text:string){
  if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return;}
  const field=document.createElement('textarea');field.value=text;field.style.cssText='position:fixed;left:-10000px;top:0';
  document.body.appendChild(field);field.select();const ok=document.execCommand('copy');field.remove();if(!ok)throw new Error('copy failed');
}
export default function Home(){
  const [mode,setMode]=useState<'receive'|'send'>('receive');
  const [panel,setPanel]=useState<'receive'|'send'>('receive');
  const [ready,setReady]=useState(false),[status,setStatus]=useState('等待建立接收会话'),[error,setError]=useState('');
  const [busy,setBusy]=useState(false),[connected,setConnected]=useState(false),[qr,setQr]=useState(''),[link,setLink]=useState('');
  const [expires,setExpires]=useState(0),[now,setNow]=useState(Date.now());
  const [localOrigins,setLocalOrigins]=useState<{label:string;origin:string}[]>([]),[pairOrigin,setPairOrigin]=useState('');
  const [localRelay,setLocalRelay]=useState(false);
  const [files,setFiles]=useState<Received[]>([]),[queue,setQueue]=useState<Item[]>([]);
  const [sending,setSending]=useState(false),[packing,setPacking]=useState(false),[copied,setCopied]=useState(false);
  const [progress,setProgress]=useState<{name:string;loaded:number;total:number}|null>(null);
  const [incoming,setIncoming]=useState<{name:string;loaded:number;total:number}|null>(null);
  const [downloadNotice,setDownloadNotice]=useState('');
  const transfer=useRef<Transfer|null>(null),currentRoom=useRef<Room|null>(null),generation=useRef(0);
  const heldFiles=useRef<Received[]>([]),heldQueue=useRef<Item[]>([]),sendingLock=useRef(false),input=useRef<HTMLInputElement>(null);
  const join=useRef<{id:string;token:string}|null>(null);
  const emit=(event:Event)=>{
    if(event.kind==='status'){setStatus(event.text);if(event.connected!==undefined){setConnected(event.connected);if(event.connected){setBusy(false);setError('');setQr('');setLink('');}}}
    if(event.kind==='error'){setError(event.text);setConnected(false);setBusy(false);}
    if(event.kind==='progress'){if(event.direction==='send')setProgress(event);else setIncoming(event);}
    if(event.kind==='file'){heldFiles.current=[...heldFiles.current,event.file];setFiles(heldFiles.current);setIncoming(null);if(!sendingLock.current&&!heldQueue.current.some(item=>item.status!=='done'))setPanel('receive');}
  };
  useEffect(()=>{
    const readPairing=()=>{
      const target=new URLSearchParams(location.hash.slice(1)).get('send');
      if(!target){if(join.current){generation.current++;transfer.current?.close();join.current=null;setConnected(false);setBusy(false);setMode('receive');}return;}
      const [id,token]=target.split('.');setMode('send');
      if(!/^[a-f0-9-]{36}$/.test(id)||! /^[a-f0-9]{64}$/.test(token||'')){setError('二维码链接不完整，请重新扫码');return;}
      if(join.current?.id===id&&join.current.token===token)return;
      generation.current++;transfer.current?.close();join.current={id,token};setConnected(false);setBusy(false);setError('');setProgress(null);setIncoming(null);setPanel('send');setStatus('准备连接电脑');
      heldQueue.current=heldQueue.current.map(item=>({...item,status:'waiting',error:undefined}));setQueue(heldQueue.current);
    };
    readPairing();window.addEventListener('hashchange',readPairing);
    let mounted=true;
    fetch('/api/local-info').then(r=>r.ok?r.json():null).then((info:unknown)=>{
      const data=info as {local?:boolean;transport?:string;origins?:{label:string;origin:string}[]}|null;
      if(mounted&&data?.local&&data.origins){setLocalRelay(data.transport==='websocket');setLocalOrigins(data.origins);setPairOrigin(data.origins.find(n=>n.origin===location.origin)?.origin||data.origins[0]?.origin||location.origin);}
    }).catch(()=>{}).finally(()=>{if(mounted)setReady(true)});
    const timer=setInterval(()=>setNow(Date.now()),1000);
    const warn=(e:BeforeUnloadEvent)=>{if(heldFiles.current.length||sendingLock.current){e.preventDefault();e.returnValue='';}};
    window.addEventListener('beforeunload',warn);
    return()=>{mounted=false;clearInterval(timer);window.removeEventListener('hashchange',readPairing);window.removeEventListener('beforeunload',warn);generation.current++;transfer.current?.close();heldFiles.current.forEach(f=>URL.revokeObjectURL(f.url));heldQueue.current.forEach(f=>URL.revokeObjectURL(f.url));};
  },[]);
  function updateQueue(next:Item[]){heldQueue.current=next;setQueue(next);}
  function clearDelivered(){
    if(sendingLock.current)return;
    const completed=heldQueue.current.filter(item=>item.status==='done');
    updateQueue(heldQueue.current.filter(item=>item.status!=='done'));
    completed.forEach(item=>URL.revokeObjectURL(item.url));
    if(connected)setStatus('手机和电脑已连接，可以继续传照片');
  }
  async function receive(){
    const gen=++generation.current;transfer.current?.close();setConnected(false);setError('');setQr('');setLink('');setBusy(true);setProgress(null);setIncoming(null);setStatus('正在准备二维码…');
    try{
      const old=currentRoom.current;if(old) await api(`/api/rooms/${old.id}`,old.receiver,'DELETE').catch(()=>{});
      const room:Room=await api('/api/rooms',undefined,'POST');currentRoom.current=room;setExpires(room.expires);if(gen!==generation.current)return;
      const t=new Transfer(emit,true,heldFiles.current.reduce((n,f)=>n+f.size,0),localRelay?{id:room.id,token:room.receiver}:undefined);transfer.current=t;
      if(!localRelay){const offer=await t.description('offer');if(gen!==generation.current)return;await api(`/api/rooms/${room.id}/offer`,room.receiver,'POST',offer);}
      const url=`${pairOrigin||location.origin}/#send=${room.id}.${room.sender}`;
      setLink(url);setQr(await makeQR(url));
      setBusy(false);setStatus('等待手机扫码连接');t.waitForScan();
      if(localRelay)return;
      while(gen===generation.current&&!t.closed){
        if(Date.now()>room.expires){t.close();setQr('');setLink('');setStatus('二维码已过期');return;}
        const state=await api(`/api/rooms/${room.id}`,room.receiver);
        if(state.claimed){setStatus('手机已扫码，正在建立连接…');t.startConnectionTimeout();}
        if(state.answer){await t.pc.setRemoteDescription(state.answer);break;}
        await pause(2000);
      }
    }catch(e){if(gen===generation.current){transfer.current?.close();setError((e as Error).message);setBusy(false);setQr('');setLink('');setStatus('接收会话未能建立');}}
  }
  async function connect(){
    if(!join.current)return;const gen=++generation.current;
    transfer.current?.close();setBusy(true);setConnected(false);setError('');setStatus('正在连接电脑…');
    try{
      const {id,token}=join.current,state=await api(`/api/rooms/${id}`,token);
      if(!localRelay&&!state.offer)throw new Error('电脑尚未准备好，请稍后再试');await api(`/api/rooms/${id}/claim`,token,'POST');if(gen!==generation.current)return;
      const t=new Transfer(emit,false,heldFiles.current.reduce((n,f)=>n+f.size,0),localRelay?{id,token}:undefined);transfer.current=t;if(localRelay)return;await t.pc.setRemoteDescription(state.offer!);
      const answer=await t.description('answer');if(gen!==generation.current)return;
      await api(`/api/rooms/${id}/answer`,token,'POST',answer);
    }catch(e){if(gen===generation.current){transfer.current?.close();setError((e as Error).message);setBusy(false);setStatus('连接未能建立');}}
  }
  function select(selected:FileList|null){
    if(!selected||sendingLock.current)return;setError('');const next=[...heldQueue.current],messages:string[]=[];
    for(const file of Array.from(selected)){
      if(!file.type.startsWith('image/')&&!/\.(heic|heif|jpg|jpeg|png|gif|webp|avif|bmp)$/i.test(file.name)){messages.push(`${file.name} 不是支持的照片`);continue;}
      if(file.size===0||file.size>MAX_FILE){messages.push(`${file.name} 超出单张 50 MB 限制或为空`);continue;}
      if(next.length>=100||next.reduce((n,i)=>n+i.file.size,0)+file.size>MAX_TOTAL){messages.push('每批最多 100 张、合计 200 MB');break;}
      next.push({id:randomId(),file,url:URL.createObjectURL(file),status:'waiting'});
    }
    updateQueue(next);if(messages.length)setError(messages.join('；'));if(input.current)input.current.value='';
  }
  async function send(){
    if(sendingLock.current)return;sendingLock.current=true;setSending(true);setError('');const t=transfer.current;
    try{
      if(!t||!connected)throw new Error('请先连接对方设备');
      for(const item of heldQueue.current.filter(i=>i.status!=='done')){
        updateQueue(heldQueue.current.map(i=>i.id===item.id?{...i,status:'sending',error:undefined}:i));
        try{await t.send(item.file);updateQueue(heldQueue.current.map(i=>i.id===item.id?{...i,status:'done'}:i));}
        catch(e){updateQueue(heldQueue.current.map(i=>i.id===item.id?{...i,status:'error',error:(e as Error).message}:i));throw e;}
      }setStatus(mode==='receive'?'照片已送达手机，请在手机页面下载保存':'这一批照片已全部收到，去电脑上保存吧');
    }catch(e){setError((e as Error).message)}finally{sendingLock.current=false;setSending(false);setProgress(null);}
  }
  async function downloadAll(){
    setPacking(true);setError('');try{
      const entries:Record<string,Uint8Array>=Object.create(null);
      for(const file of files){let name=safeName(file.name),n=1;while(Object.hasOwn(entries,name)){const base=safeName(file.name),dot=base.lastIndexOf('.');name=dot>0?`${base.slice(0,dot)} (${n++})${base.slice(dot)}`:`${base} (${n++})`;}entries[name]=new Uint8Array(await file.blob.arrayBuffer());}
      const data=zipSync(entries,{level:0});save(new Blob([data.slice().buffer],{type:'application/zip'}),`轻传-${new Date().toLocaleDateString('sv-SE')}.zip`);
    }catch{setError('打包失败，请尝试逐张下载')}finally{setPacking(false)}
  }
  function downloadOriginals(){
    const names=new Set<string>();
    for(const file of files){
      const base=safeName(file.name);let name=base,n=1;const dot=base.lastIndexOf('.');
      while(names.has(name))name=dot>0?`${base.slice(0,dot)} (${n++})${base.slice(dot)}`:`${base} (${n++})`;
      names.add(name);const link=fileDownloadUrl(file,name);if(link)triggerDownload(link,name);else save(file.blob,name);
    }
    setDownloadNotice(`已分别提交 ${files.length} 个原图下载任务，浏览器可能逐张要求确认。若想减少弹窗，请改用「打包下载（ZIP）」，它只提交一个任务，解压后是原图。`);
  }
  const active=!!qr&&now<expires;
  const total=files.reduce((n,f)=>n+f.size,0),waiting=queue.filter(i=>i.status!=='done').length;
  const percent=progress?Math.round(progress.loaded/progress.total*100):0;
  const incomingPercent=incoming?Math.round(incoming.loaded/incoming.total*100):0;
  const isPhone=mode==='send',other=isPhone?'电脑':'手机';
  const phoneBatch=isPhone&&files.length>1,archiveUrl=archiveDownloadUrl(files);
  const zipLabel=phoneBatch?'打包下载（ZIP）':'打包下载';
  const showingSend=localRelay?panel==='send':isPhone;
  const inbox=<section className="inbox card">
    <div className="section-top">
      <div><span className="step-label">02 / 接收照片</span><h2>你的照片收件箱 <span className="count">{files.length}</span></h2></div>
      {files.length>0&&<div className="download-actions">
        {isPhone&&files.length===1&&(files[0].downloadPath?<a className="button primary small" href={fileDownloadUrl(files[0])} download={safeName(files[0].name)}><ArrowDownToLine size={16}/>下载原图</a>:<button className="button primary small" onClick={()=>save(files[0].blob,safeName(files[0].name))}><ArrowDownToLine size={16}/>下载原图</button>)}
        {(!isPhone||phoneBatch)&&(archiveUrl?<a className={`button ${phoneBatch?'primary':'secondary'} small`} href={archiveUrl} download="轻传照片.zip"><ArrowDownToLine size={16}/>{zipLabel}</a>:<button className={`button ${phoneBatch?'primary':'secondary'} small`} onClick={downloadAll} disabled={packing}>{packing?<LoaderCircle size={16} className="spin"/>:<ArrowDownToLine size={16}/>} {packing?'打包中…':zipLabel}</button>)}
        {phoneBatch&&<button className="button secondary small" onClick={downloadOriginals}><Images size={16}/>分别下载原图</button>}
      </div>}
    </div>
    {phoneBatch&&<p className="batch-download-hint">想减少确认弹窗，请选 ZIP：只下载一个压缩包，解压后是全部原图。分别下载仍可能逐张确认。</p>}
    {incoming&&<div className="progress-panel"><span><LoaderCircle className="spin" size={16}/>正在接收 {incoming.name}</span><b>{incomingPercent===100?'校验中':`${incomingPercent}%`}</b><div className="progress-track"><i style={{width:`${incomingPercent}%`}}/></div></div>}
    {files.length===0?<div className="empty-inbox">
      <div className="photo-stack"><div className="back-photo"/><div className="front-photo"><Images size={43} strokeWidth={1.3}/><span/></div><span className="stack-plus">+</span></div>
      <h3>给照片留好了位置</h3><p>{other}发送后，照片会出现在这里<br/>支持原文件传输，不额外压缩</p>
      <div className="empty-steps"><span><Smartphone size={15}/>连接</span><ChevronRight size={14}/><span><ImagePlus size={15}/>选图</span><ChevronRight size={14}/><span><ArrowDownToLine size={15}/>接收</span></div>
    </div>:<>
      <div className="received-summary"><span><Check size={15}/>已收到 {files.length} 张 · {size(total)}</span><span>请下载后再关闭页面</span></div>
      <div className="photo-grid">{files.map(file=><article className="photo-card" key={file.id}>
        <div className="photo-preview">{file.downloadPath?<a className="photo-preview-link" href={file.downloadPath+'?view=1'} target="_blank" rel="noopener noreferrer" title={`打开原图 ${file.name}`}><img src={file.url} alt={file.name} onError={e=>{e.currentTarget.style.display='none'}}/></a>:<img src={file.url} alt={file.name} onError={e=>{e.currentTarget.style.display='none'}}/>}<span className="photo-fallback"><Images size={28}/></span></div>
        <div className="photo-info"><div><strong title={file.name}>{file.name}</strong><span>{size(file.size)}</span></div>{file.downloadPath?<a className={isPhone?'photo-download':'icon-button'} title={`下载 ${file.name}`} href={fileDownloadUrl(file)} download={safeName(file.name)}><ArrowDownToLine size={17}/>{isPhone&&'下载'}</a>:<button className={isPhone?'photo-download':'icon-button'} title={`下载 ${file.name}`} onClick={()=>save(file.blob,safeName(file.name))}><ArrowDownToLine size={17}/>{isPhone&&'下载'}</button>}</div>
      </article>)}</div>
      {isPhone&&<p className="save-hint">点「下载」后请确认浏览器的保存提示；也可点击预览图打开原图，再长按保存。临时下载链接 15 分钟有效，保存位置取决于手机浏览器。</p>}
      {downloadNotice&&<p className="download-notice" role="status">{downloadNotice}</p>}
      <button className="clear-button" onClick={()=>{if(confirm('确认已经保存需要的照片？清空后不能恢复。')){files.forEach(f=>URL.revokeObjectURL(f.url));heldFiles.current=[];setFiles([]);setDownloadNotice('');transfer.current?.releaseReceived();}}}>清空已接收照片</button>
    </>}
    <div className="inbox-foot"><ShieldCheck size={15}/><span>照片暂存在当前页面，网站不保存照片。下载后再关闭。</span></div>
  </section>;
  const composer=<section className="card sender-card">
    <div className="section-top"><span className="step-label">02 / 选择并发送</span><Images size={20}/></div>
    <input ref={input} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={e=>select(e.target.files)}/>
    <button className="choose-area" onClick={()=>input.current?.click()} disabled={sending} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();select(e.dataTransfer.files)}}>
      <span><ImagePlus size={30}/></span><strong>{queue.length?'继续添加照片':isPhone?'选择手机里的照片':'选择电脑里的照片'}</strong><p>{isPhone?'支持多选':'支持多选，也可拖入照片'} · 单张最多 50 MB</p>
    </button>
    {queue.length>0&&<>
      <div className="queue-summary"><span>已选 {queue.length} 张 · {size(queue.reduce((n,i)=>n+i.file.size,0))}</span><span>{queue.filter(i=>i.status==='done').length} 张已送达</span></div>
      <div className="queue">{queue.map(item=><div className="queue-item" key={item.id}>
        <div className="queue-thumbnail"><img src={item.url} alt="" onError={e=>{e.currentTarget.style.display='none'}}/><Images size={20}/></div>
        <div className="queue-text"><strong>{item.file.name}</strong><span className={item.status==='error'?'error-text':''}>{item.status==='done'?`${other}已完整收到`:item.status==='sending'?progress?.name===item.file.name?(percent===100?`等待${other}校验…`:`发送中 ${percent}%`):'正在准备照片…':item.status==='error'?item.error:size(item.file.size)}</span></div>
        {item.status==='done'?<Check size={19} className="success-icon"/>:item.status==='sending'?<LoaderCircle size={18} className="spin"/>:<button className="icon-button" disabled={sending} aria-label={`移除 ${item.file.name}`} onClick={()=>{URL.revokeObjectURL(item.url);updateQueue(queue.filter(i=>i.id!==item.id))}}><X size={17}/></button>}
      </div>)}</div>
    </>}
    {queue.some(item=>item.status==='done')&&<div className="queue-actions"><button className="button secondary small" onClick={clearDelivered} disabled={sending}>清除已送达</button></div>}
    {progress&&sending&&<div className="progress-track send-progress"><i style={{width:`${percent}%`}}/></div>}
    <button className="button primary full send-button" disabled={!connected||!waiting||sending} onClick={send}>
      {sending?<LoaderCircle size={18} className="spin"/>:waiting?<Send size={18}/>:queue.length?<CheckCheck size={18}/>:<Upload size={18}/>}
      {sending?'正在发送，请保持页面打开':waiting?`发送 ${waiting} 张照片`:queue.length?'已全部送达':'选择照片后发送'}
    </button>
    <p className="sender-note">照片送达后，请在{other}页面下载保存。</p>
  </section>;
  return <div className="app-shell">
    <header className="topbar"><a href="/" className="brand" aria-label="轻传首页"><span className="brand-mark"><ArrowUpRight size={23}/></span><span>轻传<span className="brand-en">QINGCHUAN</span></span></a><div className="header-note"><span className="live-dot"/>照片互传 · 无需安装</div></header>
    <main className={isPhone?'mobile-main':''}>
      <div className="intro">
        <span className="eyebrow">KEEP YOUR PHOTOS CLOSE</span>
        <h1>{showingSend?<>{isPhone?'手机':'电脑'}里的照片，<br/>发到{other}<span className="title-dot">。</span></>:<>{other}里的照片，<br/>{isPhone?'收到手机':'轻轻传过来'}<span className="title-dot">。</span></>}</h1>
        <p>{isPhone?'连接一次，照片双向传。收到后记得下载保存。':'电脑开着这个页面，手机扫一扫。连接后即可双向传图。'}</p>
      </div>
      {!ready?<div className="card loading"><LoaderCircle className="spin"/>正在准备…</div>:<>
        {localRelay&&<nav className="transfer-tabs" aria-label="照片传输方向">
          <button className={!showingSend?'selected':''} aria-pressed={!showingSend} onClick={()=>setPanel('receive')}><ArrowDownToLine size={16}/>接收{other}照片{files.length>0&&<span>{files.length}</span>}</button>
          <button className={showingSend?'selected':''} aria-pressed={showingSend} onClick={()=>setPanel('send')}><Send size={16}/>发送到{other}{sending&&<LoaderCircle size={14} className="spin"/>}</button>
        </nav>}
        {!isPhone?<div className="workspace">
          <section className="pair-card card">
            <div className="section-top"><span className="step-label">01 / 连接手机</span><Smartphone size={20}/></div>
            {localOrigins.length>0&&<label className="network-choice">手机连接的网络<select aria-label="手机连接的网络" value={pairOrigin} disabled={busy||connected} onChange={async e=>{const origin=e.target.value;setPairOrigin(origin);if(link){const next=origin+'/'+new URL(link).hash;setLink(next);setQr(await makeQR(next));}}}>{localOrigins.map(n=><option key={n.origin} value={n.origin}>{n.label}</option>)}</select></label>}
            <div className={`qr-wrap ${connected?'is-connected':''}`}>
              {connected?<div className="connected-art"><span><CheckCheck size={48}/></span><h3>已经连上了</h3><p>{showingSend?'选择电脑照片，发送到手机':'可以接收手机照片，也可以切换发送'}</p></div>:active?<img className="qr-image" src={qr} alt="手机扫码连接此电脑"/>:<div className="qr-placeholder"><div className="placeholder-grid"/><Smartphone size={30}/><span>{busy?'正在准备…':'等待开启接收'}</span></div>}
            </div>
            <div className={`connection-state ${connected?'online':''}`} role="status"><span className={`live-dot ${connected?'':'muted'}`}/>{status}</div>
            <p className="pair-hint">{connected?(localRelay?'经电脑本地服务传输 · 不保存照片':'连接已加密 · 照片直接传到此浏览器'):active?`用手机相机或浏览器扫码 · ${Math.max(1,Math.ceil((expires-now)/60000))} 分钟内有效`:'让手机和电脑连接同一 Wi-Fi 或手机热点'}</p>
            <button className="button primary full" onClick={receive} disabled={busy}>{busy?<LoaderCircle size={18} className="spin"/>:expires>0?<RefreshCw size={17}/>:<Laptop size={18}/>} {busy?'正在准备…':expires>0?'重新配对':'开启接收'}</button>
            {active&&!connected&&<button className="button text full" data-pair-link={link} onClick={async()=>{try{await copyText(link);setCopied(true);setTimeout(()=>setCopied(false),2000)}catch{setError('复制失败，请直接扫码')}}}>{copied?<Check size={15}/>:<Copy size={15}/>} {copied?'配对链接已复制':'复制配对链接'}</button>}
            <div className="pair-foot"><ShieldCheck size={15}/><span>二维码仅供本次配对，请勿转发</span></div>
          </section>
          {showingSend?composer:inbox}
        </div>:<div className="sender-layout">
          <section className="card sender-card">
            <div className="section-top"><span className="step-label">01 / 连接电脑</span><Laptop size={20}/></div>
            <div className={`sender-status ${connected?'online':''}`}><span className="device-icon">{connected?<CheckCheck size={24}/>:<Laptop size={24}/>}</span><div><strong>{connected?'已连接到电脑':'连接照片接收站'}</strong><p role="status">{status}</p></div></div>
            {!connected&&<button className="button primary full" onClick={connect} disabled={busy||!join.current}>{busy?<LoaderCircle size={17} className="spin"/>:<Wifi size={17}/>} {busy?'正在连接…':'连接这台电脑'}</button>}
          </section>
          {showingSend?composer:inbox}
        </div>}
      </>}
      {error&&<div className="error-banner" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={()=>setError('')}><X size={17}/></button></div>}
      <div className="principles"><span><ShieldCheck size={17}/>照片不在服务器留存</span><span><Images size={17}/>不额外压缩画质</span><span><Wifi size={17}/>同一网络，连接更顺畅</span></div>
    </main>
    <footer><span>轻传 · 让照片少绕一点路</span><span>KEEP IT SIMPLE. KEEP IT CLOSE.</span></footer>
  </div>;
}
