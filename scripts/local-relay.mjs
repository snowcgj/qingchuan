import {WebSocketServer,WebSocket} from 'ws';

// Reuse the HTTP server's TCP port. Binary frames are forwarded, never persisted.
export function createLocalRelay(server,sqlite,allowedHosts,downloads){
  const wss=new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false});
  const pairs=new Map();
  const streams=new WeakMap();
  const send=(ws,body)=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(body))};
  const fail=(ws,message)=>{send(ws,{kind:'relay-error',message});ws.close(1008,'Connection rejected')};
  server.on('upgrade',(req,socket,head)=>{
    const expected=`http://${req.headers.host}`;
    if(req.url!=='/api/transfer'||!allowedHosts().has(req.headers.host)||req.headers.origin!==expected){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
  });
  wss.on('connection',ws=>{
    const stream={active:null,awaitingAck:null};streams.set(ws,stream);
    let id,role,pressureTimer;
    const authTimer=setTimeout(()=>fail(ws,'配对超时，请重新连接'),5000);
    ws.on('error',()=>{});
    ws.on('message',(data,isBinary)=>{
      try{
      if(!role){
        if(isBinary||data.length>1024){fail(ws,'配对信息无效');return;}
        let auth;try{auth=JSON.parse(data.toString())}catch{fail(ws,'配对信息无效');return;}
        const room=typeof auth.id==='string'?sqlite.prepare('SELECT * FROM rooms WHERE id = ? AND expires > ?').get(auth.id,Date.now()):null;
        if(!room||auth.kind!=='auth'||typeof auth.token!=='string'){fail(ws,'二维码已失效，请重新扫码');return;}
        const identity=auth.token===room.receiver?'receiver':auth.token===room.sender&&room.claimed?'sender':null;
        if(!identity){fail(ws,'配对凭证无效');return;}
        const pair=pairs.get(room.id)||{};
        if(pair[identity]?.readyState===WebSocket.OPEN){fail(ws,'此连接正在使用，请先断开旧页面');return;}
        id=room.id;role=identity;pair[role]=ws;pairs.set(id,pair);clearTimeout(authTimer);
        send(ws,{kind:'relay-waiting'});
        if(pair.receiver?.readyState===WebSocket.OPEN&&pair.sender?.readyState===WebSocket.OPEN){
          send(pair.receiver,{kind:'peer-ready'});send(pair.sender,{kind:'peer-ready'});
        }
        return;
      }
      const pair=pairs.get(id),target=pair?.[role==='receiver'?'sender':'receiver'];
      const room=sqlite.prepare('SELECT id FROM rooms WHERE id = ?').get(id);
      if(!room){fail(ws,'电脑已重新配对，请扫描新二维码');return;}
      if(!target||target.readyState!==WebSocket.OPEN){send(ws,{kind:'peer-left'});return;}
      if(isBinary){
        if(!stream.active||stream.active.received+data.length>stream.active.size){fail(ws,'收到未声明或超出大小的照片数据');return;}
        stream.active.received+=data.length;
        downloads.append(stream.active.download,data);
      }else{
        if(data.length>8192){fail(ws,'文件信息过长');return;}
        let meta;try{meta=JSON.parse(data.toString())}catch{fail(ws,'文件信息无效');return;}
        // Role identifies the paired device; both devices may send and receive.
        const allowed=['begin','end','ack','reject'];
        if(!allowed.includes(meta.kind)){fail(ws,'不允许的消息');return;}
        if(meta.kind==='begin'){
          if(stream.active||stream.awaitingAck||typeof meta.id!=='string'||meta.id.length>128||typeof meta.name!=='string'||meta.name.length>255||!Number.isInteger(meta.size)||meta.size<1||meta.size>50*1024*1024||typeof meta.type!=='string'||!meta.type.startsWith('image/')||typeof meta.hash!=='string'||! /^[a-f0-9]{64}$/.test(meta.hash)){fail(ws,'照片信息无效或上一张尚未完成');return;}
          if(!/^image\/[a-z0-9.+-]+$/i.test(meta.type)){fail(ws,'照片类型无效');return;}
          const download=downloads.reserve(meta);
          stream.lastDownload=null;
          stream.active={id:meta.id,size:meta.size,received:0,download};
          data=Buffer.from(JSON.stringify({...meta,downloadKey:download.key}));
        }else if(meta.kind==='end'){
          if(!stream.active||stream.active.id!==meta.id||stream.active.received!==stream.active.size){fail(ws,'照片未完整传输');return;}
          downloads.complete(stream.active.download);
          stream.lastDownload=stream.active.download;stream.awaitingAck=stream.active.id;stream.active=null;
        }else if(meta.kind==='ack'){
          const peer=streams.get(target);if(!peer||peer.awaitingAck!==meta.id){fail(ws,'接收确认无效');return;}peer.awaitingAck=null;peer.lastDownload=null;
        }else if(meta.kind==='reject'){
          const peer=streams.get(target);if(peer){downloads.drop(peer.active?.download);downloads.drop(peer.lastDownload);peer.active=null;peer.awaitingAck=null;}
        }
      }
      target.send(data,{binary:isBinary},error=>{if(error)ws.close(1011,'Forwarding failed')});
      if(target.bufferedAmount>1024*1024&&!pressureTimer){
        ws.pause();const deadline=Date.now()+30000;
        pressureTimer=setInterval(()=>{
          if(target.readyState!==WebSocket.OPEN||ws.readyState!==WebSocket.OPEN||Date.now()>deadline){clearInterval(pressureTimer);pressureTimer=undefined;ws.resume();ws.close(1013,'Receiver is unavailable');return;}
          if(target.bufferedAmount<256*1024){clearInterval(pressureTimer);pressureTimer=undefined;ws.resume();}
        },20);
      }
      }catch(error){downloads.drop(stream.active?.download);stream.active=null;fail(ws,error.message||'文件传输失败，请重试');}
    });
    ws.on('close',()=>{
      clearTimeout(authTimer);clearInterval(pressureTimer);
      downloads.drop(stream.active?.download);
      const pair=pairs.get(id);if(!pair||pair[role]!==ws)return;
      delete pair[role];const peer=pair[role==='receiver'?'sender':'receiver'];
      const peerStream=peer&&streams.get(peer);if(peerStream){downloads.drop(peerStream.active?.download);peerStream.active=null;peerStream.awaitingAck=null;}
      send(peer,{kind:'peer-left'});
      if(!pair.receiver&&!pair.sender)pairs.delete(id);
    });
  });
  return {
    senderConnected(id){return pairs.get(id)?.sender?.readyState===WebSocket.OPEN},
    revoke(id){const pair=pairs.get(id);if(pair)for(const ws of Object.values(pair)){send(ws,{kind:'relay-error',message:'电脑已重新配对，请扫描新二维码'});ws.close(1000,'Pairing changed')}pairs.delete(id)},
  };
}
