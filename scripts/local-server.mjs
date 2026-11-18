import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {networkInterfaces} from 'node:os';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {signaling} from '../lib/signaling.ts';
import {createLocalRelay} from './local-relay.mjs';
import {createMemoryDownloads} from './memory-downloads.mjs';

const root=path.resolve(fileURLToPath(new URL('../dist-local/',import.meta.url)));
const port=Number(process.env.PORT||4317);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('PORT 必须为 1024 到 65535 之间的整数');
const sqlite=new DatabaseSync(':memory:');
const downloads=createMemoryDownloads();
sqlite.exec(await readFile(new URL('../db/schema.sql',import.meta.url),'utf8'));
const db={
  prepare(sql){
    const statement=sqlite.prepare(sql);
    return {bind(...params){return {
      async first(){return statement.get(...params)??null},
      async run(){const result=statement.run(...params);return {meta:{changes:Number(result.changes)}}},
    }}};
  },
};
function networks(){
  return Object.entries(networkInterfaces()).flatMap(([name,addresses])=>{
    if(/vmware|vEthernet|virtual|vpn|bluetooth|蓝牙|loopback|wsl|docker|tailscale|zerotier/i.test(name))return [];
    return (addresses||[]).filter(a=>a.family==='IPv4'&&!a.internal&&!a.address.startsWith('169.254.')).map(a=>({label:`${name} · ${a.address}`,origin:`http://${a.address}:${port}`}));
  }).sort((a,b)=>Number(/wi-?fi|wlan|无线/i.test(b.label))-Number(/wi-?fi|wlan|无线/i.test(a.label)));
}
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const allowedHosts=()=>new Set([`localhost:${port}`,`127.0.0.1:${port}`,...Object.values(networkInterfaces()).flat().filter(Boolean).filter(a=>a.family==='IPv4').map(a=>`${a.address}:${port}`)]);
async function handle(req,res){
  res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Cache-Control','no-store');
  if(!allowedHosts().has(req.headers.host)){res.writeHead(403);res.end('不允许的主机地址');return;}
  const url=new URL(req.url,`http://${req.headers.host}`);
  if(url.pathname==='/api/local-info'){
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({app:'qingchuan',version:4,local:true,transport:'websocket',origins:networks()}));return;
  }
  if(url.pathname.startsWith('/api/downloads/')){downloads.handle(req,res,url);return;}
  if(url.pathname.startsWith('/api/rooms')){
    const localRoom=url.pathname.match(/^\/api\/rooms\/([a-f0-9-]{36})(?:\/(claim))?$/);
    if(localRoom&&req.method==='POST'&&localRoom[2]==='claim'){
      const token=req.headers.authorization?.replace(/^Bearer /,'');
      const room=sqlite.prepare('SELECT * FROM rooms WHERE id = ? AND expires > ?').get(localRoom[1],Date.now());
      if(room&&token===room.sender&&!relay.senderConnected(room.id)&&(!req.headers.origin||req.headers.origin===url.origin)){
        sqlite.prepare('UPDATE rooms SET claimed = 1 WHERE id = ?').run(room.id);
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true}));return;
      }
    }
    if(!['GET','POST','DELETE'].includes(req.method)){res.writeHead(405);res.end();return;}
    const parts=[];let bytes=0;
    for await(const part of req){bytes+=part.length;if(bytes>32768){res.writeHead(413,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'连接信息过长'}));return;}parts.push(part);}
    const headers=new Headers();
    for(const name of ['authorization','origin','content-type'])if(req.headers[name])headers.set(name,req.headers[name]);
    headers.set('CF-Connecting-IP',req.socket.remoteAddress||'local');
    const request=new Request(url,{method:req.method,headers,...(parts.length?{body:Buffer.concat(parts)}:{})});
    const response=await signaling(request,db);
    if(response.ok&&req.method==='DELETE'&&localRoom)relay.revoke(localRoom[1]);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
  const pathname=decodeURIComponent(url.pathname);
  const filename=path.resolve(root,pathname==='/'?'index.html':`.${pathname}`);
  if(filename!==root&&!filename.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{const content=await readFile(filename);res.setHeader('Content-Type',types[path.extname(filename)]||'application/octet-stream');res.end(req.method==='HEAD'?undefined:content)}
  catch{res.writeHead(404);res.end('文件不存在')}
}
const server=createServer((req,res)=>void handle(req,res).catch(error=>{
  if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});
  res.end(JSON.stringify({error:'本地服务发生错误，请重新启动'}));console.error(error.message);
}));
const relay=createLocalRelay(server,sqlite,allowedHosts,downloads);
server.requestTimeout=30000;server.headersTimeout=15000;
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`端口 ${port} 已被占用，可能已经启动过。请打开 http://127.0.0.1:${port}`:error.message);process.exitCode=1});
server.listen(port,'0.0.0.0',()=>{
  void mkdir(new URL('../work/',import.meta.url),{recursive:true}).then(()=>writeFile(new URL('../work/local-server.pid',import.meta.url),String(process.pid))).catch(()=>{});
  console.log(`\n轻传本地服务已启动\n电脑打开：http://127.0.0.1:${port}\n`);
  for(const item of networks())console.log(`手机入口：${item.origin} (${item.label})`);
  console.log('\n手机与电脑连接同一 Wi-Fi 或热点。关闭此窗口或按 Ctrl+C 停止服务。\n');
  if(process.argv.includes('--open'))spawn('explorer.exe',[`http://127.0.0.1:${port}`],{windowsHide:true,stdio:'ignore'}).on('error',()=>{});
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close();downloads.close();sqlite.close();process.exit(0)});
