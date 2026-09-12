import path from 'node:path';
import {readPrivate,writePrivate,fail} from './storage.mjs';

const CHANNEL_TTL_MS=25000;
const DISCONNECT_LEASE_MS=60000;
const MESSAGE_TTL_MS=86400000;
const MAX_MESSAGES=1000;
const VALID_STATUSES=new Set(['queued','claimed','delivered','working','completed','cancelled','expired']);
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const sessionId=value=>value.sessionId??value.id;
const scoped=(a,b)=>a.machineId===b.machineId&&a.sessionId===sessionId(b);
const sessionKey=value=>`${value.machineId}:${sessionId(value)}`;
const cleanText=value=>typeof value==='string'&&value.trim()&&value.length<=4000&&!/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\t]/g,''));
const publicMessage=message=>({
  id:message.id,text:message.text,status:message.status,createdAt:message.createdAt,
  claimedAt:message.claimedAt??null,deliveredAt:message.deliveredAt??null,
  workingAt:message.workingAt??null,completedAt:message.completedAt??null,
  expiredAt:message.expiredAt??null,
});

function validStore(value) {
  return value?.version===1&&Array.isArray(value.messages)&&value.messages.length<=MAX_MESSAGES&&
    value.messages.every(message=>validId(message?.id)&&validId(message?.machineId)&&validId(message?.sessionId)&&
      validId(message?.channelId)&&VALID_STATUSES.has(message?.status)&&typeof message?.text==='string'&&
      Number.isSafeInteger(message?.createdAt)&&message.createdAt>=0);
}

export class ClaudeChannels {
  constructor({dir,lookup,enabled=false,now=Date.now}) {
    this.file=path.join(dir,'claude-channels.json');
    this.lookup=lookup;
    this.enabled=enabled===true;
    this.now=now;
    this.connections=new Map();
    const stored=readPrivate(this.file,validStore);
    this.data=stored||{version:1,messages:[]};
    let changed=!stored;
    for(const message of this.data.messages) {
      if(message.status==='queued'||message.status==='claimed') {
        message.status='expired';message.expiredAt=this.now();changed=true;
      }
    }
    this.prune(changed);
  }
  ensureEnabled(){if(!this.enabled)throw fail(404,'channel_disabled');}
  scope(body){
    if(!validId(body?.machineId)||!validId(body?.sessionId))throw fail(400,'invalid_session');
  }
  channelScope(body){
    this.scope(body);
    if(!validId(body?.channelId))throw fail(400,'invalid_channel');
  }
  liveSession(body) {
    const session=this.lookup(body.machineId,body.sessionId);
    return session?.provider==='claude'&&session.online===true&&!['closed','untracked'].includes(session.status)?session:null;
  }
  ready(connection) {
    return Boolean(connection&&!connection.closed&&connection.seenAt>this.now()-CHANNEL_TTL_MS&&this.liveSession(connection));
  }
  active(body) {
    const connection=this.connections.get(sessionKey(body));
    return this.ready(connection)&&connection.channelId===body.channelId?connection:null;
  }
  save(){writePrivate(this.file,this.data);}
  expireConnection(connection) {
    if(!connection||connection.closed)return false;
    connection.closed=true;
    let changed=false;
    for(const message of this.data.messages) {
      if(!scoped(message,connection)||message.channelId!==connection.channelId)continue;
      if(message.status==='queued') {
        message.expiresAt=Math.min(message.expiresAt??Infinity,this.now()+DISCONNECT_LEASE_MS);changed=true;
      } else if(message.status==='claimed') {
        message.status='expired';message.expiredAt=this.now();message.expiredReason='delivery_uncertain';changed=true;
      }
    }
    return changed;
  }
  connect(body) {
    this.ensureEnabled();this.channelScope(body);this.prune();
    if(!this.liveSession(body))throw fail(409,'session_not_ready');
    const key=sessionKey(body),current=this.connections.get(key);
    if(this.ready(current)&&current.channelId!==body.channelId)throw fail(409,'channel_exists');
    if(current&&current.channelId!==body.channelId)this.expireConnection(current);
    this.connections.set(key,{machineId:body.machineId,sessionId:body.sessionId,channelId:body.channelId,seenAt:this.now(),closed:false});
    this.save();return {ok:true};
  }
  poll(body) {
    this.ensureEnabled();this.channelScope(body);this.prune();
    const connection=this.active(body);
    if(!connection)throw fail(409,'channel_not_ready');
    connection.seenAt=this.now();
    const message=this.data.messages.find(item=>scoped(item,body)&&item.channelId===body.channelId&&item.status==='queued'&&
      (item.expiresAt==null||item.expiresAt>this.now()));
    if(!message)return {status:'waiting'};
    message.status='claimed';message.claimedAt=this.now();delete message.expiresAt;this.save();
    return {status:'message',message:{id:message.id,text:message.text}};
  }
  ack(body) {
    this.ensureEnabled();this.channelScope(body);this.prune();
    if(!this.active(body))throw fail(409,'channel_not_ready');
    if(!validId(body?.id))throw fail(400,'invalid_message');
    const message=this.data.messages.find(item=>item.id===body.id&&scoped(item,body)&&item.channelId===body.channelId);
    if(!message||!['claimed','delivered'].includes(message.status))throw fail(409,'message_not_claimed');
    if(message.status==='claimed'){message.status='delivered';message.deliveredAt=this.now();this.save();}
    return {ok:true};
  }
  disconnect(body) {
    this.ensureEnabled();this.channelScope(body);
    const key=sessionKey(body),connection=this.connections.get(key);
    if(connection&&connection.channelId!==body.channelId)throw fail(409,'channel_not_ready');
    const changed=this.expireConnection(connection);
    if(connection)this.connections.delete(key);
    if(changed)this.save();
    return {ok:true};
  }
  validateMessage(body) {
    this.scope(body);
    if(!validId(body?.id)||!cleanText(body?.text))throw fail(400,'invalid_message');
  }
  send(body) {
    this.ensureEnabled();this.validateMessage(body);this.prune();
    const session=this.liveSession(body),connection=this.connections.get(sessionKey(body));
    if(!session||!this.ready(connection))throw fail(409,'channel_not_ready');
    const duplicate=this.data.messages.find(message=>message.id===body.id);
    if(duplicate) {
      if(!scoped(duplicate,body)||duplicate.text!==body.text)throw fail(409,'message_id_conflict');
      return publicMessage(duplicate);
    }
    if(this.data.messages.some(message=>scoped(message,body)&&['queued','claimed'].includes(message.status)))throw fail(409,'message_pending');
    if(this.data.messages.length>=MAX_MESSAGES)throw fail(429,'message_limit');
    const message={
      id:body.id,text:body.text,machineId:body.machineId,sessionId:body.sessionId,channelId:connection.channelId,
      status:'queued',createdAt:this.now(),baselineUpdatedAt:session.updatedAt||0,baselineEventId:session.eventId||'',
    };
    this.data.messages.push(message);this.save();return publicMessage(message);
  }
  update(body) {
    this.ensureEnabled();this.validateMessage(body);this.prune();
    const message=this.data.messages.find(item=>item.id===body.id&&scoped(item,body));
    if(!message||message.status!=='queued')throw fail(409,'message_not_pending');
    message.text=body.text;this.save();return publicMessage(message);
  }
  cancel(body) {
    this.ensureEnabled();this.scope(body);this.prune();
    if(!validId(body?.id))throw fail(400,'invalid_message');
    const message=this.data.messages.find(item=>item.id===body.id&&scoped(item,body));
    if(!message||message.status!=='queued')throw fail(409,'message_not_pending');
    message.status='cancelled';this.save();return {ok:true};
  }
  observe(session) {
    if(!this.enabled||session?.provider!=='claude')return;
    const candidates=this.data.messages.filter(message=>scoped(message,session)&&['delivered','working'].includes(message.status))
      .sort((a,b)=>a.createdAt-b.createdAt);
    const message=candidates[0];
    if(!message||!(session.updatedAt>message.baselineUpdatedAt))return;
    let changed=false;
    if(['idle','error'].includes(session.status)&&session.eventId&&session.eventId!==message.baselineEventId) {
      message.status='completed';message.completedAt=this.now();changed=true;
    } else if(message.status==='delivered'&&['working','waiting'].includes(session.status)) {
      message.status='working';message.workingAt=this.now();changed=true;
    }
    if(changed)this.save();
  }
  view(session) {
    if(!this.enabled)return {enabled:false,ready:false,lastHeartbeat:null,messages:[]};
    this.prune();
    const connection=this.connections.get(sessionKey(session)),ready=this.ready(connection);
    return {
      enabled:true,ready,lastHeartbeat:connection?.seenAt??null,
      messages:this.data.messages.filter(message=>scoped(message,session)).slice(-10).reverse().map(publicMessage),
    };
  }
  prune(forceSave=false) {
    const now=this.now();let changed=forceSave;
    for(const [key,connection] of this.connections) {
      if(!this.ready(connection)) {
        changed=this.expireConnection(connection)||changed;
        this.connections.delete(key);
      }
    }
    for(const message of this.data.messages) {
      if(message.status==='queued'&&message.expiresAt!=null&&message.expiresAt<=now) {
        message.status='expired';message.expiredAt=now;message.expiredReason='channel_disconnected';changed=true;
      }
    }
    const retained=this.data.messages.filter(message=>message.createdAt>now-MESSAGE_TTL_MS).slice(-MAX_MESSAGES);
    if(retained.length!==this.data.messages.length){this.data.messages=retained;changed=true;}
    if(changed)this.save();
  }
}
