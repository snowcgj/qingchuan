import {digest,randomId} from './browser-crypto';
export const MAX_FILE=50*1024*1024;
export const MAX_TOTAL=200*1024*1024;
export type Received={id:string;name:string;size:number;type:string;blob:Blob;url:string;downloadPath?:string};
export type Event={kind:'status';text:string;connected?:boolean}|{kind:'progress';direction:'send'|'receive';name:string;loaded:number;total:number}|{kind:'file';file:Received}|{kind:'error';text:string};
type Meta={kind:'begin';id:string;name:string;size:number;type:string;hash:string;downloadKey?:string};
export type RelayOptions={id:string;token:string};
export class Transfer {
  pc!:RTCPeerConnection;
  channel?:RTCDataChannel|WebSocket;
  closed=false;
  private pending?:{meta:Meta;parts:ArrayBuffer[];loaded:number};
  private ack?:{id:string;resolve:()=>void;reject:(error:Error)=>void};
  private retained=0;
  private channelTimer?:ReturnType<typeof setTimeout>;
  private relayMode=false;
  private peerReady=false;
  constructor(private emit:(event:Event)=>void,receiver:boolean,retained=0,relay?:RelayOptions){
    this.retained=retained;
    if(relay){
      this.relayMode=true;
      const url=new URL('/api/transfer',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
      const channel=new WebSocket(url);this.bind(channel);
      channel.onopen=()=>channel.send(JSON.stringify({kind:'auth',...relay}));
      this.startConnectionTimeout();return;
    }
    this.pc=new RTCPeerConnection({iceServers:location.protocol==='http:'?[]:[{urls:'stun:stun.cloudflare.com:3478'}]});
    this.pc.onconnectionstatechange=()=>{
      const state=this.pc.connectionState;
      if(state==='failed') {this.emit({kind:'error',text:'连接未能建立，请让手机和电脑连接同一 Wi-Fi 或热点，然后重新配对。'});this.close();}
      if(state==='disconnected') this.emit({kind:'status',text:'连接暂时中断，正在等待恢复…',connected:false});
      if(state==='connected'&&this.channel?.readyState==='open') this.emit({kind:'status',text:'手机和电脑已连接，可以传照片了',connected:true});
    };
    if(receiver)this.bind(this.pc.createDataChannel('photos',{ordered:true}));
    else this.pc.ondatachannel=e=>this.bind(e.channel);
    this.startConnectionTimeout();
  }
  waitForScan(){clearTimeout(this.channelTimer);this.channelTimer=undefined;}
  releaseReceived(){this.retained=0;}
  startConnectionTimeout(){if(this.channelTimer)return;this.channelTimer=setTimeout(()=>{if(this.channel?.readyState!=='open'&&!this.closed){this.emit({kind:'error',text:'连接超时。请确认两台设备在同一 Wi-Fi 或热点下，再重新配对。'});this.close();}},90000);}
  private bind(channel:RTCDataChannel|WebSocket){
    this.channel=channel;channel.binaryType='arraybuffer';if('bufferedAmountLowThreshold' in channel)channel.bufferedAmountLowThreshold=256*1024;
    channel.onopen=()=>{this.peerReady=true;clearTimeout(this.channelTimer);this.emit({kind:'status',text:'手机和电脑已连接，可以传照片了',connected:true});};
    channel.onclose=()=>{this.peerReady=false;this.pending=undefined;this.ack?.reject(new Error('连接已断开，请重新配对后重试'));this.ack=undefined;if(!this.closed)this.emit({kind:'status',text:'对方已断开，请重新配对；已收到的照片仍可下载。',connected:false});};
    channel.onerror=()=>{this.ack?.reject(new Error('传输连接出错'));this.emit({kind:'error',text:'传输连接出错，请重新配对'});};
    channel.onmessage=e=>{void this.message(e.data).catch(error=>{this.pending=undefined;try{channel.send(JSON.stringify({kind:'reject',message:String(error.message)}))}catch{}this.emit({kind:'error',text:error.message});});};
  }
  private async message(data:string|ArrayBuffer){
    if(typeof data==='string'){
      if(data.length>8192)throw new Error('文件信息过长');
      const m=JSON.parse(data);
      if(this.relayMode&&m.kind==='peer-ready'){this.peerReady=true;clearTimeout(this.channelTimer);this.emit({kind:'status',text:'手机和电脑已连接，可以传照片了',connected:true});return;}
      if(this.relayMode&&m.kind==='relay-waiting')return;
      if(this.relayMode&&m.kind==='relay-error'){this.emit({kind:'error',text:m.message||'本地连接失败，请重试'});this.close();return;}
      if(this.relayMode&&m.kind==='peer-left'){this.peerReady=false;this.pending=undefined;this.ack?.reject(new Error('对方已断开，请重新连接'));this.ack=undefined;this.emit({kind:'status',text:'对方已断开，请重新连接；已收到的照片仍可下载。',connected:false});return;}
      if(m.kind==='ack'&&this.ack&&m.id===this.ack.id){this.ack.resolve();this.ack=undefined;return;}
      if(m.kind==='reject'){this.ack?.reject(new Error(m.message||'对方未能接收，请重试'));this.ack=undefined;return;}
      if(m.kind==='begin'){
        if(this.pending)throw new Error('上一张照片尚未接收完成');
        if(!Number.isInteger(m.size)||m.size<1||m.size>MAX_FILE||this.retained+m.size>MAX_TOTAL||typeof m.name!=='string'||m.name.length>255||typeof m.type!=='string'||!/^image\//.test(m.type)||!/^\w{64}$/.test(m.hash))throw new Error('照片格式或大小不符合要求，请重新选择');
        this.pending={meta:m,parts:[],loaded:0};
        this.emit({kind:'progress',direction:'receive',name:m.name,loaded:0,total:m.size});
      }else if(m.kind==='end'){
        const p=this.pending;if(!p||m.id!==p.meta.id||p.loaded!==p.meta.size)throw new Error('照片未完整收到，请重试');
        const blob=new Blob(p.parts,{type:p.meta.type});
        if(await digest(await blob.arrayBuffer())!==p.meta.hash)throw new Error('照片校验失败，请重试');
        this.retained+=blob.size;this.pending=undefined;
        const downloadPath=this.relayMode&&/^[a-f0-9]{64}$/.test(p.meta.downloadKey||'')?`/api/downloads/${p.meta.downloadKey}/${encodeURIComponent(p.meta.name)}`:undefined;
        this.emit({kind:'file',file:{...p.meta,blob,url:URL.createObjectURL(blob),downloadPath}});
        this.channel?.send(JSON.stringify({kind:'ack',id:p.meta.id}));
      }
    }else{
      const p=this.pending;if(!p||data.byteLength>65536||p.loaded+data.byteLength>p.meta.size)throw new Error('收到无效的照片数据');
      p.parts.push(data);p.loaded+=data.byteLength;
      this.emit({kind:'progress',direction:'receive',name:p.meta.name,loaded:p.loaded,total:p.meta.size});
    }
  }
  async description(kind:'offer'|'answer'){
    const description=kind==='offer'?await this.pc.createOffer():await this.pc.createAnswer();
    await this.pc.setLocalDescription(description);
    if(this.pc.iceGatheringState!=='complete')await new Promise<void>(resolve=>{
      const done=()=>{clearTimeout(timer);this.pc.removeEventListener('icegatheringstatechange',change);resolve()};
      const change=()=>{if(this.pc.iceGatheringState==='complete')done()};
      const timer=setTimeout(done,10000);this.pc.addEventListener('icegatheringstatechange',change);
    });
    return this.pc.localDescription!.toJSON();
  }
  async send(file:File){
    const channel=this.channel;if(!channel||!this.isOpen()||!this.peerReady)throw new Error('尚未连接对方设备，请先重新配对');
    if(this.ack)throw new Error('上一张照片尚未接收完成');
    const data=await file.arrayBuffer();const hash=await digest(data);const id=randomId();
    channel.send(JSON.stringify({kind:'begin',id,name:file.name,size:file.size,type:file.type||'image/heic',hash}));
    for(let offset=0;offset<data.byteLength;offset+=65536){
      if(this.closed||!this.isOpen()||!this.peerReady)throw new Error('连接已断开，请重新配对');
      const deadline=Date.now()+30000;
      while(channel.bufferedAmount>1024*1024){
        await new Promise(resolve=>setTimeout(resolve,20));
        if(Date.now()>deadline){this.close();throw new Error('传输停滞，请重新配对后重试');}
        if(this.closed||!this.isOpen()||!this.peerReady)throw new Error('连接已断开，请重新配对');
      }
      channel.send(data.slice(offset,offset+65536));
      this.emit({kind:'progress',direction:'send',name:file.name,loaded:Math.min(offset+65536,data.byteLength),total:data.byteLength});
    }
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.ack=undefined;this.close();reject(new Error('接收确认超时，请查看对方接收页并重新配对'))},60000);
      this.ack={id,resolve:()=>{clearTimeout(timer);resolve()},reject:error=>{clearTimeout(timer);reject(error)}};
      channel.send(JSON.stringify({kind:'end',id}));
    });
  }
  private isOpen(){return this.channel?.readyState==='open'||this.channel?.readyState===1;}
  close(){this.closed=true;this.peerReady=false;clearTimeout(this.channelTimer);this.ack?.reject(new Error('连接已关闭'));this.ack=undefined;this.pending=undefined;this.channel?.close();this.pc?.close();}
}
