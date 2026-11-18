import assert from 'node:assert/strict';
import {once} from 'node:events';
import WebSocket from 'ws';

const base=process.env.TEST_URL||'http://127.0.0.1:4317';
const response=await fetch(base+'/api/rooms',{method:'POST'});
assert.equal(response.status,201);
const room=await response.json(),sockets=[];
async function connect(token){
  const ws=new WebSocket(base.replace(/^http/,'ws')+'/api/transfer',{origin:base});sockets.push(ws);
  const queue=[],waiters=[];
  ws.on('message',data=>{const msg=JSON.parse(data.toString());const i=waiters.findIndex(w=>w.kind===msg.kind);if(i>=0){const w=waiters.splice(i,1)[0];clearTimeout(w.timer);w.resolve(msg)}else queue.push(msg)});
  ws.on('error',()=>{});await once(ws,'open');ws.send(JSON.stringify({kind:'auth',id:room.id,token}));
  return {ws,wait(kind){const i=queue.findIndex(m=>m.kind===kind);if(i>=0)return Promise.resolve(queue.splice(i,1)[0]);return new Promise((resolve,reject)=>{const entry={kind,resolve,timer:setTimeout(()=>reject(new Error('Missing message: '+kind)),3000)};waiters.push(entry)})}};
}
try{
  const invalid=await connect('0'.repeat(64));await invalid.wait('relay-error');
  const unclaimed=await connect(room.sender);await unclaimed.wait('relay-error');
  const receiver=await connect(room.receiver);await receiver.wait('relay-waiting');
  const claim=await fetch(base+`/api/rooms/${room.id}/claim`,{method:'POST',headers:{Authorization:'Bearer '+room.sender}});assert.equal(claim.status,200);
  const sender=await connect(room.sender);await sender.wait('peer-ready');await receiver.wait('peer-ready');
  const duplicate=await connect(room.receiver);await duplicate.wait('relay-error');
  receiver.ws.send(Buffer.from([1,2,3]));await receiver.wait('relay-error');await sender.wait('peer-left');
  console.log('PASS: local relay rejects invalid credentials, unclaimed sender, duplicate receiver, and undeclared binary data');
  const denied=new WebSocket(base.replace(/^http/,'ws')+'/api/transfer',{origin:'https://invalid.example'});
  await assert.rejects(once(denied,'open'),/403/);denied.terminate();
  console.log('PASS: cross-origin WebSocket upgrade rejected');
}finally{
  for(const ws of sockets)ws.close();
  await fetch(base+`/api/rooms/${room.id}`,{method:'DELETE',headers:{Authorization:'Bearer '+room.receiver}});
}
