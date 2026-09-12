import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as OTPAuth from 'otpauth';

async function server(t,enabled) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ap-channel-api-'));
  const base=`http://127.0.0.1:${36000+Math.floor(Math.random()*2000)}`;
  const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,NODE_ENV:'test',PORT:new URL(base).port,
    AGENTPULSE_PUBLIC_ORIGIN:base,AGENTPULSE_DATA_DIR:dir,AGENTPULSE_BRIDGE_TOKEN:'test-bridge',
    AGENTPULSE_MOBILE_TOKEN:'test-setup',AGENTPULSE_CLAUDE_CHANNEL_ENABLED:String(enabled)},stdio:'ignore'});
  t.after(async()=>{if(child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}fs.rmSync(dir,{recursive:true,force:true});});
  for(let i=0;i<80;i++){try{if((await fetch(base+'/healthz')).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  const post=(url,body,headers={})=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json',origin:base,...headers},body:JSON.stringify(body)});
  const setup=await(await post('/api/auth/setup',{email:'owner@example.com',password:'synthetic-test-password',token:'test-setup'})).json();
  const confirm=await post('/api/auth/confirm',{enrollment:setup.enrollment,code:OTPAuth.URI.parse(setup.uri).generate()});
  const owner={cookie:confirm.headers.get('set-cookie').split(';')[0],'x-csrf-token':(await confirm.json()).csrf};
  return {base,post,owner,bridge:{authorization:'Bearer test-bridge'}};
}

test('Claude Channel API keeps bridge and owner authority separate and reports lifecycle', {timeout:20000}, async t=>{
  const app=await server(t,true),start=Date.now();
  const scope={machineId:'mac-1',sessionId:'session-1',channelId:'channel-1'};
  const snapshot=(status,updatedAt,eventId,activity)=>({machineId:'mac-1',machineName:'Synthetic Mac',sessions:[{
    id:'session-1',provider:'claude',project:'sample',cwd:'/tmp/sample',tty:'ttys001',pid:123,
    status,activity,summary:status==='idle'?'Synthetic response':'',summaryAt:status==='idle'?updatedAt:0,eventId,updatedAt,
  }]});
  assert.equal((await app.post('/api/bridge/sessions',snapshot('idle',start,'old-stop','Stop'),app.bridge)).status,200);
  assert.equal((await app.post('/api/bridge/claude-channels/connect',scope)).status,401);
  assert.equal((await app.post('/api/bridge/claude-channels/connect',scope,{authorization:'Bearer wrong'})).status,401);
  assert.equal((await app.post('/api/bridge/claude-channels/connect',scope,app.bridge)).status,200);

  const message={machineId:'mac-1',sessionId:'session-1',id:'message-1',text:'Give me a status update.'};
  assert.equal((await app.post('/api/mobile/claude-channels/send',message)).status,401);
  assert.equal((await app.post('/api/mobile/claude-channels/send',message,{cookie:app.owner.cookie})).status,403);
  assert.equal((await app.post('/api/mobile/claude-channels/send',message,{...app.owner,origin:'https://other.example'})).status,403);
  const sent=await app.post('/api/mobile/claude-channels/send',message,app.owner);
  assert.equal(sent.status,200);assert.equal((await sent.json()).status,'queued');

  const claimed=await app.post('/api/bridge/claude-channels/poll',scope,app.bridge);
  assert.deepEqual(await claimed.json(),{status:'message',message:{id:'message-1',text:message.text}});
  assert.equal((await app.post('/api/bridge/claude-channels/ack',{...scope,id:'message-1'},app.owner)).status,401);
  assert.equal((await app.post('/api/bridge/claude-channels/ack',{...scope,id:'message-1'},app.bridge)).status,200);
  let sessions=await(await fetch(app.base+'/api/mobile/sessions',{headers:app.owner})).json();
  assert.equal(sessions.sessions[0].channel.ready,true);
  assert.equal(sessions.sessions[0].channel.messages[0].status,'delivered');
  assert.equal(JSON.stringify(sessions).includes('channel-1'),false);

  await app.post('/api/bridge/sessions',snapshot('working',start+1,'old-stop','Bash'),app.bridge);
  sessions=await(await fetch(app.base+'/api/mobile/sessions',{headers:app.owner})).json();
  assert.equal(sessions.sessions[0].channel.messages[0].status,'working');
  await app.post('/api/bridge/sessions',snapshot('idle',start+2,'new-stop','Stop'),app.bridge);
  sessions=await(await fetch(app.base+'/api/mobile/sessions',{headers:app.owner})).json();
  assert.equal(sessions.sessions[0].channel.messages[0].status,'completed');
});

test('disabled Channel routes fail closed while session listing remains available', {timeout:20000}, async t=>{
  const app=await server(t,false);
  const scope={machineId:'mac-1',sessionId:'session-1',channelId:'channel-1'};
  assert.equal((await app.post('/api/bridge/claude-channels/connect',scope,app.bridge)).status,404);
  assert.equal((await app.post('/api/mobile/claude-channels/send',{machineId:'mac-1',sessionId:'session-1',id:'m',text:'status'},app.owner)).status,404);
  const response=await fetch(app.base+'/api/mobile/sessions',{headers:app.owner});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).sessions,[]);
});
