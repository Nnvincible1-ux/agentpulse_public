import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as OTPAuth from 'otpauth';

test('authenticated follow-ups travel through real HTTP to each Stop listener; unauthorized writes fail', {timeout:20000}, async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ap-replies-api-'));
  const base=`http://127.0.0.1:${34000+Math.floor(Math.random()*2000)}`;
  const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,NODE_ENV:'test',PORT:new URL(base).port,AGENTPULSE_PUBLIC_ORIGIN:base,AGENTPULSE_DATA_DIR:dir,AGENTPULSE_BRIDGE_TOKEN:'test-bridge',AGENTPULSE_MOBILE_TOKEN:'test-setup'},stdio:'ignore'});
  t.after(async()=>{if(child.exitCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill();await exit;}fs.rmSync(dir,{recursive:true,force:true});});
  let ready=false;
  for(let i=0;i<80;i++){try{if((await fetch(base+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
  assert.ok(ready);
  const post=(url,body,headers={})=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json',origin:base,...headers},body:JSON.stringify(body)});
  const bridge={authorization:'Bearer test-bridge'};
  const pending=await(await post('/api/auth/setup',{email:'owner@example.com',password:'synthetic-test-password',token:'test-setup'})).json();
  const confirm=await post('/api/auth/confirm',{enrollment:pending.enrollment,code:OTPAuth.URI.parse(pending.uri).generate()});
  const owner={cookie:confirm.headers.get('set-cookie').split(';')[0],'x-csrf-token':(await confirm.json()).csrf};
  const sessions=['claude','codex'].map(provider=>({id:provider,machineId:'mac',provider,project:provider,cwd:'/tmp/sample',tty:'ttys001',pid:123,status:'idle',activity:'Stop',eventId:'turn-'+provider,updatedAt:Date.now()}));
  await post('/api/bridge/sessions',{machineId:'mac',machineName:'Synthetic Mac',sessions},bridge);
  const message={machineId:'mac',sessionId:'claude',id:'test-message',text:'Pusha kontosidorna också.'};
  assert.equal((await post('/api/mobile/replies/send',message)).status,401);
  assert.equal((await post('/api/mobile/replies/send',message,bridge)).status,401);
  assert.equal((await post('/api/mobile/replies/send',message,{cookie:owner.cookie})).status,403);
  assert.equal((await post('/api/mobile/replies/send',message,{...owner,origin:'https://other.example'})).status,403);
  assert.equal((await post('/api/bridge/replies/poll',{},owner)).status,401);
  assert.equal((await post('/api/mobile/replies/send',message,owner)).status,409);
  for(const provider of ['claude','codex']){
    // Transport and hook output are real; no model or shell command is executed.
    const code=`import sys,json,urllib.request;sys.path.insert(0,'bridge');from mobile_replies import listen\ndef request(action,body):\n r=urllib.request.Request(${JSON.stringify(base)}+'/api/bridge/replies/'+action,data=json.dumps(body).encode(),headers={'Authorization':'Bearer test-bridge','Content-Type':'application/json'});return json.load(urllib.request.urlopen(r))\nlisten({'machineId':'mac','sessionId':${JSON.stringify(provider)},'eventId':'turn-'+${JSON.stringify(provider)}},request,wait_seconds=10,idle=lambda:1e9)\n`;
    const hook=spawn('python3',['-B','-c',code],{stdio:['ignore','pipe','pipe']});let output='',errors='';hook.stdout.on('data',d=>output+=d);hook.stderr.on('data',d=>errors+=d);
    const exit=new Promise(r=>hook.once('exit',r));t.after(()=>hook.kill());
    let session;
    for(let i=0;i<80;i++){
      session=(await(await fetch(base+'/api/mobile/sessions',{headers:owner})).json()).sessions.find(s=>s.id===provider);
      if(session?.reply.ready)break;await new Promise(r=>setTimeout(r,50));
    }
    assert.equal(session.reply.ready,true,errors);
    const body={...message,id:'message-'+provider,sessionId:provider,windowId:session.reply.windowId};
    const response=await post('/api/mobile/replies/send',body,owner);assert.equal(response.status,200);assert.equal((await response.json()).status,'queued');
    assert.equal(await exit,0,errors);
    const result=JSON.parse(output);assert.equal(result.decision,'block');assert.ok(result.reason.endsWith(body.text));
    const view=(await(await fetch(base+'/api/mobile/sessions',{headers:owner})).json()).sessions.find(s=>s.id===provider);
    assert.equal(view.reply.messages[0].status,'delivered');assert.equal(view.reply.ready,false);
    assert.equal((await(await post('/api/mobile/replies/send',body,owner)).json()).status,'delivered');
  }
});
