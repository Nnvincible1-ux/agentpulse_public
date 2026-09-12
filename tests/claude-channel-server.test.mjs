import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridgeApi,createMcpServer,deliverOnce,runChannelLoop} from '../claude-channel/agentpulse-channel.mjs';

const scope={machineId:'mac-1',sessionId:'session-1',channelId:'channel-1'};

test('declares only the Claude channel experimental capability',()=>{
  const server=createMcpServer();
  assert.deepEqual(server._capabilities,{experimental:{'claude/channel':{}}});
  assert.equal(Object.hasOwn(server._capabilities.experimental,'claude/channel/permission'),false);
});

test('writes a channel notification before acknowledging transport delivery',async()=>{
  const calls=[];
  const api={poll:async body=>(calls.push(['poll',body]),{status:'message',message:{id:'message-1',text:'Continue with items 1–3.'}}),
    ack:async body=>{calls.push(['ack',body]);return {ok:true};}};
  const mcp={notification:async value=>calls.push(['notification',value])};
  assert.equal(await deliverOnce({api,mcp,scope,seen:new Set()}),true);
  assert.deepEqual(calls,[
    ['poll',scope],
    ['notification',{method:'notifications/claude/channel',params:{content:'Continue with items 1–3.',meta:{message_id:'message-1'}}}],
    ['ack',{...scope,id:'message-1'}],
  ]);
});

test('never acknowledges a failed or duplicate notification write',async()=>{
  let acknowledgements=0;
  const api={poll:async()=>({status:'message',message:{id:'message-1',text:'Status'}}),ack:async()=>acknowledgements++};
  await assert.rejects(deliverOnce({api,mcp:{notification:async()=>{throw new Error('closed');}},scope,seen:new Set()}),/closed/);
  assert.equal(acknowledgements,0);
  const seen=new Set(['message-1']);
  await assert.rejects(deliverOnce({api,mcp:{notification:async()=>{}},scope,seen}),error=>error.code==='duplicate_claim');
  assert.equal(acknowledgements,0);
});

test('an unconfirmed acknowledgement stops delivery without emitting the message again',async()=>{
  let notifications=0;
  const api={poll:async()=>({status:'message',message:{id:'message-1',text:'Status'}}),ack:async()=>{throw new Error('temporary');}};
  await assert.rejects(deliverOnce({api,mcp:{notification:async()=>notifications++},scope,seen:new Set()}),error=>error.fatal===true);
  assert.equal(notifications,1);
});

test('bridge API uses bearer auth, exact paths and no redirects',async()=>{
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url,options});
    return {ok:true,status:200,json:async()=>({status:'waiting'})};
  };
  const api=createBridgeApi({server:'https://pulse.example.com',token:'synthetic-token',fetchImpl});
  await api.poll(scope);
  assert.equal(calls[0].url,'https://pulse.example.com/api/bridge/claude-channels/poll');
  assert.equal(calls[0].options.headers.authorization,'Bearer synthetic-token');
  assert.equal(calls[0].options.redirect,'error');
  assert.deepEqual(JSON.parse(calls[0].options.body),scope);
});

test('loop refreshes presence, retries a transient connect and cleans up its exact scope',async()=>{
  const calls=[],presence=[];let attempts=0;
  const api={
    connect:async body=>{calls.push(['connect',body]);if(attempts++===0)throw new Error('temporary');return {ok:true};},
    poll:async body=>(calls.push(['poll',body]),{status:'waiting'}),
    disconnect:async body=>calls.push(['disconnect',body]),ack:async()=>{},
  };
  await runChannelLoop({api,mcp:{notification:async()=>{}},scope,home:'/unused',pid:321,maxIterations:1,
    sleepFn:async ms=>calls.push(['sleep',ms]),writePresenceFn:value=>presence.push(['write',value]),removePresenceFn:value=>(presence.push(['remove',value]),true),clock:()=>5000});
  assert.deepEqual(calls.map(call=>call[0]),['connect','sleep','connect','poll','disconnect']);
  assert.equal(presence.filter(call=>call[0]==='write').length,2);
  assert.deepEqual(presence.at(-1),['remove',{home:'/unused',sessionId:'session-1',pid:321}]);
});

test('authorization rejection is fatal and contains no token or response payload',async()=>{
  const api=createBridgeApi({server:'https://pulse.example.com',token:'synthetic-secret',fetchImpl:async()=>({ok:false,status:401,json:async()=>({secret:'payload'})})});
  await assert.rejects(api.connect(scope),error=>error.code==='bridge_auth_rejected'&&!error.message.includes('synthetic-secret')&&!error.message.includes('payload'));
});

test('a lost server registration reconnects without replaying a claimed message',async()=>{
  const calls=[];let polls=0;
  const lost=Object.assign(new Error('lost'),{code:'channel_registration_lost'});
  const api={connect:async()=>calls.push('connect'),poll:async()=>{calls.push('poll');if(polls++===0)throw lost;return {status:'waiting'};},
    disconnect:async()=>calls.push('disconnect'),ack:async()=>{throw new Error('unexpected ack');}};
  await runChannelLoop({api,mcp:{notification:async()=>{}},scope,home:'/unused',maxIterations:1,
    sleepFn:async()=>{},writePresenceFn:()=>{},removePresenceFn:()=>true});
  assert.deepEqual(calls,['connect','poll','connect','poll','disconnect']);
});
