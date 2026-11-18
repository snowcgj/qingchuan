// The local SQLite adapter and the previous hosted D1 adapter share this surface.
type DB = {prepare(sql:string):{bind(...values:(string|number|null)[]):{
  first<T>():Promise<T|null>;
  run():Promise<{meta:{changes:number}}>;
}}};
type Room = {id:string; receiver:string; sender:string; offer:string|null; answer:string|null; claimed:number; expires:number};
const json = (body:unknown, status=200) => Response.json(body, {status, headers:{'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer'}});
const token = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
export async function signaling(request:Request, db:DB):Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({error:'不允许的请求来源'},403);
  if (request.method === 'POST' && url.pathname === '/api/rooms') {
    await db.prepare('DELETE FROM rooms WHERE expires < ?').bind(Date.now()).run();
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    const creator = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip)))).map(v=>v.toString(16).padStart(2,'0')).join('');
    const count = await db.prepare('SELECT COUNT(*) AS count FROM rooms WHERE creator = ?').bind(creator).first<{count:number}>();
    if ((count?.count || 0) >= 20) return json({error:'创建过于频繁，请稍后再试'},429);
    const room={id:crypto.randomUUID(), receiver:token(), sender:token(), expires:Date.now()+30*60*1000};
    await db.prepare('INSERT INTO rooms (id, receiver, sender, expires, creator) VALUES (?, ?, ?, ?, ?)').bind(room.id,room.receiver,room.sender,room.expires,creator).run();
    return json(room,201);
  }
  const match=url.pathname.match(/^\/api\/rooms\/([a-f0-9-]{36})(?:\/(offer|answer|claim))?$/);
  if (!match) return json({error:'入口不存在'},404);
  const room=await db.prepare('SELECT * FROM rooms WHERE id = ? AND expires > ?').bind(match[1],Date.now()).first<Room>();
  if(!room) return json({error:'二维码已失效，请在电脑上重新创建'},404);
  const auth=request.headers.get('Authorization')?.replace(/^Bearer /,'');
  const isReceiver=auth===room.receiver, isSender=auth===room.sender;
  if(!isReceiver&&!isSender) return json({error:'配对凭证无效，请重新扫码'},403);
  const action=match[2];
  if(request.method==='GET'&&!action) return json({offer:isSender&&room.offer?JSON.parse(room.offer):null,answer:isReceiver&&room.answer?JSON.parse(room.answer):null,claimed:!!room.claimed,expires:room.expires});
  if(request.method==='DELETE'&&!action&&isReceiver) {
    await db.prepare('DELETE FROM rooms WHERE id = ?').bind(room.id).run(); return json({ok:true});
  }
  if(request.method==='POST'&&action==='claim'&&isSender) {
    const result=await db.prepare('UPDATE rooms SET claimed = 1 WHERE id = ? AND claimed = 0').bind(room.id).run();
    return result.meta.changes?json({ok:true}):json({error:'此二维码已被使用，请在电脑上重新创建'},409);
  }
  if(request.method==='POST'&&((action==='offer'&&isReceiver)||(action==='answer'&&isSender&&room.claimed))) {
    const body=await request.text();
    if(body.length>32000) return json({error:'连接信息过长'},413);
    let sdp;try{sdp=JSON.parse(body)}catch{return json({error:'连接信息无效'},400)}
    if(sdp.type!==action||typeof sdp.sdp!=='string'||sdp.sdp.length<10) return json({error:'连接信息无效'},400);
    if(room[action]) return json({error:'连接信息已提交，请重新配对'},409);
    await db.prepare(`UPDATE rooms SET ${action} = ? WHERE id = ? AND ${action} IS NULL`).bind(JSON.stringify({type:sdp.type,sdp:sdp.sdp}),room.id).run();
    return json({ok:true});
  }
  return json({error:'不允许的操作'},405);
}
