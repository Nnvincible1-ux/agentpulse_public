import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ClaudeChannels} from '../lib/claude-channels.mjs';

function fixture(t,{enabled=true}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ap-claude-channels-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let clock=100000;
  const session={id:'session-1',machineId:'mac-1',provider:'claude',status:'idle',online:true,updatedAt:90000,eventId:'old-stop'};
  const sessions=new Map([['mac-1:session-1',session]]);
  const options={dir,enabled,now:()=>clock,lookup:(machineId,id)=>sessions.get(`${machineId}:${id}`)};
  const channels=new ClaudeChannels(options);
  const scope={machineId:'mac-1',sessionId:'session-1',channelId:'channel-1'};
  const message={machineId:'mac-1',sessionId:'session-1',id:'message-1',text:'Continue with items 1–3.'};
  return {dir,options,channels,scope,message,session,tick(ms){clock+=ms;return clock;}};
}

test('connect, claim, acknowledge, work and completion use exact lifecycle evidence',t=>{
  const f=fixture(t),c=f.channels;
  assert.deepEqual(c.connect(f.scope),{ok:true});
  assert.equal(c.view(f.session).ready,true);
  assert.equal(c.view(f.session).lastHeartbeat,100000);
  assert.equal(c.send(f.message).status,'queued');
  assert.deepEqual(c.poll(f.scope),{status:'message',message:{id:'message-1',text:f.message.text}});
  assert.equal(c.view(f.session).messages[0].status,'claimed');
  assert.deepEqual(c.ack({...f.scope,id:'message-1'}),{ok:true});
  assert.equal(c.view(f.session).messages[0].status,'delivered');
  f.session.status='working';f.session.updatedAt=f.tick(1);c.observe(f.session);
  assert.equal(c.view(f.session).messages[0].status,'working');
  f.session.status='idle';f.session.updatedAt=f.tick(1);f.session.eventId='new-stop';c.observe(f.session);
  assert.equal(c.view(f.session).messages[0].status,'completed');
  assert.equal(c.view(f.session).messages[0].completedAt,100002);
  assert.equal(fs.statSync(path.join(f.dir,'claude-channels.json')).mode&0o777,0o600);
});

test('messages and acknowledgements are scoped to one channel instance',t=>{
  const f=fixture(t),c=f.channels;c.connect(f.scope);c.send(f.message);
  assert.throws(()=>c.poll({...f.scope,machineId:'other'}),/session_not_ready|channel_not_ready/);
  assert.throws(()=>c.poll({...f.scope,channelId:'other'}),/channel_not_ready/);
  c.poll(f.scope);
  assert.throws(()=>c.ack({...f.scope,channelId:'other',id:f.message.id}),/channel_not_ready/);
  assert.throws(()=>c.ack({...f.scope,id:'other'}),/message_not_claimed/);
});

test('one unclaimed message is allowed and queued text may be edited or cancelled',t=>{
  const f=fixture(t),c=f.channels;c.connect(f.scope);
  assert.equal(c.send(f.message).status,'queued');
  assert.equal(c.send(f.message).status,'queued');
  assert.throws(()=>c.send({...f.message,id:'message-2'}),/message_pending/);
  assert.equal(c.update({...f.message,text:'Continue with items 1–2.'}).text,'Continue with items 1–2.');
  c.poll(f.scope);
  assert.throws(()=>c.update({...f.message,text:'Too late'}),/message_not_pending/);
  c.ack({...f.scope,id:f.message.id});
  assert.equal(c.send({...f.message,id:'message-2'}).status,'queued');
  assert.deepEqual(c.cancel({...f.message,id:'message-2'}),{ok:true});
  assert.equal(c.view(f.session).messages[0].status,'cancelled');
});

test('disconnect keeps queued text briefly cancellable and makes a claim uncertain',t=>{
  const f=fixture(t),c=f.channels;c.connect(f.scope);c.send(f.message);c.disconnect(f.scope);
  assert.equal(c.view(f.session).ready,false);
  assert.equal(c.view(f.session).messages[0].status,'queued');
  f.tick(60001);c.prune();
  assert.equal(c.view(f.session).messages[0].status,'expired');

  const second={...f.scope,channelId:'channel-2'};c.connect(second);c.send({...f.message,id:'message-2'});c.poll(second);c.disconnect(second);
  assert.equal(c.view(f.session).messages[0].status,'expired');
});

test('stale heartbeat closes the channel and never transfers its message to a reconnect',t=>{
  const f=fixture(t),c=f.channels;c.connect(f.scope);c.send(f.message);f.tick(25001);c.prune();
  assert.equal(c.view(f.session).ready,false);
  const next={...f.scope,channelId:'channel-2'};c.connect(next);
  assert.deepEqual(c.poll(next),{status:'waiting'});
  assert.deepEqual(c.cancel(f.message),{ok:true});
});

test('restart expires queued and claimed messages but retains acknowledged history',t=>{
  const f=fixture(t);f.channels.connect(f.scope);f.channels.send(f.message);
  let restarted=new ClaudeChannels(f.options);
  assert.equal(restarted.view(f.session).messages[0].status,'expired');
  restarted.connect(f.scope);restarted.send({...f.message,id:'message-2'});restarted.poll(f.scope);
  restarted=new ClaudeChannels(f.options);
  assert.equal(restarted.view(f.session).messages[0].status,'expired');
  restarted.connect(f.scope);restarted.send({...f.message,id:'message-3'});restarted.poll(f.scope);restarted.ack({...f.scope,id:'message-3'});
  restarted=new ClaudeChannels(f.options);
  assert.equal(restarted.view(f.session).messages[0].status,'delivered');
});

test('validation, availability, duplicate identity, capacity and retention fail closed',t=>{
  const f=fixture(t),c=f.channels;
  assert.throws(()=>c.send(f.message),/channel_not_ready/);
  f.session.provider='codex';assert.throws(()=>c.connect(f.scope),/session_not_ready/);f.session.provider='claude';
  f.session.online=false;assert.throws(()=>c.connect(f.scope),/session_not_ready/);f.session.online=true;
  c.connect(f.scope);
  for(const text of ['', ' ', 'x'.repeat(4001), '\u001bhello'])assert.throws(()=>c.send({...f.message,text}),/invalid_message/);
  assert.throws(()=>c.send({...f.message,id:'__proto__'}),/invalid_message/);
  c.send(f.message);
  assert.throws(()=>c.send({...f.message,text:'different'}),/message_id_conflict/);
  c.cancel(f.message);
  for(let i=0;i<1000;i++)c.data.messages.push({...c.data.messages[0],id:`historic-${i}`,status:'completed',createdAt:100000+i});
  assert.throws(()=>c.send({...f.message,id:'over-capacity'}),/message_limit/);
  f.tick(86402000);c.prune();assert.deepEqual(c.view(f.session).messages,[]);
});

test('disabled mode exposes no ready channel',t=>{
  const f=fixture(t,{enabled:false});
  assert.throws(()=>f.channels.connect(f.scope),/channel_disabled/);
  assert.throws(()=>f.channels.send(f.message),/channel_disabled/);
  assert.deepEqual(f.channels.view(f.session),{enabled:false,ready:false,lastHeartbeat:null,messages:[]});
});
