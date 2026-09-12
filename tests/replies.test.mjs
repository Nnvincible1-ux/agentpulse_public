import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Replies } from '../lib/replies.mjs';
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ap-replies-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let now=100000;
  const session={id:'session',machineId:'mac',eventId:'turn',status:'idle',online:true};
  const opts={dir,now:()=>now,lookup:(machine,id)=>machine===session.machineId&&id===session.id?session:null};
  const replies=new Replies(opts);
  const receiver={machineId:'mac',sessionId:'session',eventId:'turn',receiverId:'receiver',deadline:now+100000};
  const message={machineId:'mac',sessionId:'session',id:'message',windowId:'receiver',text:'Pusha kontosidorna också.'};
  return {dir,opts,replies,receiver,message,session,tick:ms=>now+=ms};
}
test('only a live receiver for the exact session accepts a message; one claim and acknowledgement',t=>{
  const f=fixture(t),r=f.replies;
  assert.throws(()=>r.send(f.message),/not_ready/);
  assert.deepEqual(r.poll(f.receiver),{status:'waiting'});
  assert.equal(r.view(f.session).ready,true);
  assert.equal(r.send(f.message).status,'queued');
  assert.equal(r.send(f.message).id,'message');
  assert.throws(()=>r.send({...f.message,id:'second'}),/pending/);
  assert.deepEqual(r.poll(f.receiver),{status:'message',message:{id:'message',text:f.message.text}});
  assert.deepEqual(r.poll(f.receiver),{status:'closed'});
  assert.equal(r.view(f.session).messages[0].status,'claimed');
  r.ack({...f.receiver,id:'message'});
  assert.equal(r.view(f.session).messages[0].status,'delivered');
  assert.equal(r.send(f.message).status,'delivered');
  assert.equal(fs.statSync(path.join(f.dir,'replies.json')).mode&0o777,0o600);
});
test('stale and wrong session receivers cannot receive old messages',t=>{
  const f=fixture(t),r=f.replies;
  r.poll(f.receiver);r.send(f.message);
  assert.throws(()=>r.poll({...f.receiver,machineId:'other'}),/not_ready/);
  assert.throws(()=>r.poll({...f.receiver,receiverId:'other'}),/receiver_exists/);
  f.session.eventId='next-turn';
  assert.deepEqual(r.poll(f.receiver),{status:'closed'});
  assert.equal(r.view(f.session).messages[0].status,'expired');
});
test('offline receivers, expired deadlines and busy sessions disable sending',t=>{
  const f=fixture(t),r=f.replies;
  r.poll(f.receiver);f.tick(21000);
  assert.equal(r.view(f.session).ready,false);
  assert.throws(()=>r.send(f.message),/not_ready/);
  assert.throws(()=>r.poll({...f.receiver,deadline:0}),/invalid_receiver/);
  f.session.status='working';
  assert.throws(()=>r.poll({...f.receiver,receiverId:'new'}),/not_ready/);
});
test('release and cancel never send text, and new receivers do not inherit queued instructions',t=>{
  const f=fixture(t),r=f.replies;
  r.poll(f.receiver);r.send(f.message);
  r.cancel({...f.message});
  assert.deepEqual(r.poll(f.receiver),{status:'waiting'});
  r.send({...f.message,id:'next'});r.release(f.message);
  assert.deepEqual(r.poll(f.receiver),{status:'closed'});
  assert.equal(r.view(f.session).messages[0].status,'cancelled');
  f.session.eventId='new-turn';
  assert.deepEqual(r.poll({...f.receiver,eventId:'new-turn',receiverId:'new'}),{status:'waiting'});
});
test('restart expires unsent messages; claimed messages are never replayed',t=>{
  const f=fixture(t);f.replies.poll(f.receiver);f.replies.send(f.message);
  const restarted=new Replies(f.opts);
  assert.equal(restarted.view(f.session).messages[0].status,'expired');
  restarted.poll(f.receiver);restarted.send({...f.message,id:'second'});restarted.poll(f.receiver);
  const again=new Replies(f.opts);
  again.poll(f.receiver);
  assert.equal(again.view(f.session).messages[0].status,'claimed');
  assert.deepEqual(again.poll(f.receiver),{status:'waiting'});
});
test('validation, duplicate identity, size limit, acknowledgement scope and retention',t=>{
  const f=fixture(t),r=f.replies;r.poll(f.receiver);
  for(const text of ['', ' ', 'x'.repeat(4001), '\u001bhello']) assert.throws(()=>r.send({...f.message,text}),/invalid_message/);
  assert.throws(()=>r.send({...f.message,id:'__proto__'}),/invalid_message/);
  r.send(f.message);
  assert.throws(()=>r.send({...f.message,text:'different'}),/id_conflict/);
  r.poll(f.receiver);
  assert.throws(()=>r.ack({...f.receiver,id:'message',receiverId:'wrong'}),/not_claimed/);
  f.tick(86400001);r.prune();assert.deepEqual(r.view(f.session).messages,[]);
});

test('a stale mobile form cannot send to or release a newer receiving window',t=>{
  const f=fixture(t),r=f.replies;r.poll(f.receiver);r.release(f.message);
  f.session.eventId='next';r.poll({...f.receiver,eventId:'next',receiverId:'new'});
  assert.throws(()=>r.send(f.message),/window_changed/);
  assert.throws(()=>r.release(f.message),/window_changed/);
  assert.equal(r.view(f.session).ready,true);
});
