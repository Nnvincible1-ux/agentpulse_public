import path from 'node:path';
import {readPrivate,writePrivate,fail} from './storage.mjs';
const validId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const key=b=>b.machineId+':'+b.sessionId;
const scoped=(a,b)=>a.machineId===b.machineId&&a.sessionId===b.sessionId;
const publicMessage=({id,text,status,createdAt})=>({id,text,status,createdAt});
export class Replies {
  constructor({dir,lookup,now=Date.now}) {
    this.file=path.join(dir,'replies.json');this.lookup=lookup;this.now=now;this.receivers=new Map();
    this.data=readPrivate(this.file,v=>v?.version===1&&Array.isArray(v.messages)&&v.messages.length<=1000)||{version:1,messages:[]};
    // A restart cannot prove the old live receiver survived. Never replay its queue.
    for(const m of this.data.messages) if(m.status==='queued') m.status='expired';
    this.prune();this.save();
  }
  save(){writePrivate(this.file,this.data);}
  scope(b){if(!validId(b?.machineId)||!validId(b?.sessionId))throw fail(400,'invalid_session');}
  live(r){const s=this.lookup(r.machineId,r.sessionId);return s?.online&&s.status==='idle'&&s.eventId===r.eventId;}
  ready(r){return r&&!r.closed&&r.seenAt>this.now()-20000&&r.deadline>this.now()&&this.live(r);}
  close(r,status='expired'){
    // The first reason wins: 'delivered' (claimed), 'cancelled' (released) or 'expired' (heartbeat/turn lost).
    r.closed=true;r.closedReason??=status;
    for(const m of this.data.messages)if(m.receiverId===r.receiverId&&scoped(m,r)&&m.status==='queued')m.status=status;
  }
  prune(){
    for(const [k,r] of this.receivers){
      if(!this.ready(r))this.close(r);
      if(r.deadline<this.now()-60000)this.receivers.delete(k);
    }
    this.data.messages=this.data.messages.filter(m=>m.createdAt>this.now()-86400000);
    this.save();
  }
  poll(b){
    this.scope(b);
    if(!validId(b.receiverId)||!validId(b.eventId)||!Number.isSafeInteger(b.deadline)||b.deadline<=this.now()||b.deadline>this.now()+8*3600000+5000)throw fail(400,'invalid_receiver');
    let r=this.receivers.get(key(b));
    if(r?.receiverId===b.receiverId){
      if(r.eventId!==b.eventId||r.deadline!==b.deadline)throw fail(409,'receiver_conflict');
      // A lost heartbeat (for example the Mac slept) is reported as 'expired' so the hook may reopen the turn with a fresh receiver.
      if(!this.ready(r)){this.close(r);this.save();return {status:'closed',reason:r.closedReason};}
    }else{
      if(!this.live(b))throw fail(409,'session_not_ready');
      if(this.ready(r))throw fail(409,'receiver_exists');
      if(r)this.close(r);
      if(this.receivers.size>=1000&&!r)throw fail(409,'receiver_limit');
      r={...b,seenAt:this.now(),closed:false};this.receivers.set(key(b),r);
    }
    r.seenAt=this.now();
    const m=this.data.messages.find(m=>scoped(m,b)&&m.receiverId===r.receiverId&&m.status==='queued');
    if(!m)return {status:'waiting'};
    // Persist the claim before sending. A lost HTTP response is uncertain, never retried as a command.
    m.status='claimed';this.close(r,'delivered');this.save();
    return {status:'message',message:{id:m.id,text:m.text}};
  }
  send(b){
    this.scope(b);this.prune();
    if(!validId(b.id)||typeof b.text!=='string'||!b.text.trim()||b.text.length>4000||/[\p{Cc}\p{Cf}]/u.test(b.text.replace(/[\n\t]/g,'')))throw fail(400,'invalid_message');
    const old=this.data.messages.find(m=>m.id===b.id);
    if(old){if(!scoped(old,b)||old.text!==b.text)throw fail(409,'message_id_conflict');return publicMessage(old);}
    const r=this.receivers.get(key(b));
    if(!this.ready(r))throw fail(409,'session_not_ready');
    if(b.windowId!==r.receiverId)throw fail(409,'window_changed');
    if(this.data.messages.some(m=>scoped(m,b)&&m.status==='queued'))throw fail(409,'message_pending');
    if(this.data.messages.length>=1000)throw fail(429,'message_limit');
    const m={id:b.id,text:b.text,machineId:b.machineId,sessionId:b.sessionId,receiverId:r.receiverId,status:'queued',createdAt:this.now()};
    this.data.messages.push(m);this.save();return publicMessage(m);
  }
  ack(b){
    this.scope(b);
    const m=this.data.messages.find(m=>m.id===b.id&&scoped(m,b)&&m.receiverId===b.receiverId);
    if(!m||!['claimed','delivered'].includes(m.status))throw fail(409,'message_not_claimed');
    m.status='delivered';this.save();return {ok:true};
  }
  cancel(b){
    this.scope(b);const m=this.data.messages.find(m=>m.id===b.id&&scoped(m,b));
    if(!m||m.status!=='queued')throw fail(409,'message_not_pending');
    m.status='cancelled';this.save();return {ok:true};
  }
  release(b){this.scope(b);const r=this.receivers.get(key(b));if(r&&b.windowId!==r.receiverId)throw fail(409,'window_changed');if(r)this.close(r,'cancelled');this.save();return {ok:true};}
  view(s){
    const b={machineId:s.machineId,sessionId:s.id},r=this.receivers.get(key(b));
    return {ready:Boolean(this.ready(r)),windowId:this.ready(r)?r.receiverId:null,until:this.ready(r)?r.deadline:null,messages:this.data.messages.filter(m=>scoped(m,b)).slice(-10).reverse().map(publicMessage)};
  }
}
