import {sha256} from '@noble/hashes/sha2.js';

// HTTP on a LAN does not expose WebCrypto.subtle or randomUUID.
// getRandomValues is available there; keep identifiers cryptographically random.
export function randomId():string {
  if(crypto.randomUUID)return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;
  bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export async function digest(data:ArrayBuffer):Promise<string> {
  const hash=crypto.subtle
    ?new Uint8Array(await crypto.subtle.digest('SHA-256',data))
    :sha256(new Uint8Array(data));
  return Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('');
}
