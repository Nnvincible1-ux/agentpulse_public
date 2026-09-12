#!/usr/bin/env node
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  loadConnection,readMonitorState,readProcesses,findClaudeSession,writePresence,removePresence,
} from './local-state.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fatal=(code,message)=>Object.assign(new Error(message),{code,fatal:true});

export function createMcpServer() {
  return new Server(
    {name:'agentpulse-claude-channel',version:'0.1.0'},
    {capabilities:{experimental:{'claude/channel':{}}}},
  );
}

export function createBridgeApi({server,token,fetchImpl=fetch}) {
  async function request(action,body) {
    let response;
    try {
      response=await fetchImpl(`${server}/api/bridge/claude-channels/${action}`,{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
        headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body),
      });
    } catch(error) {
      if(error?.fatal)throw error;
      throw new Error('AgentPulse server is temporarily unavailable.');
    }
    if(response.status===401||response.status===403)throw fatal('bridge_auth_rejected','AgentPulse bridge authentication was rejected.');
    if(response.status===409)throw Object.assign(new Error('AgentPulse channel registration was lost.'),{code:'channel_registration_lost'});
    if(response.status>=400&&response.status<500)throw fatal('bridge_request_rejected','AgentPulse rejected the channel registration.');
    if(!response.ok)throw new Error('AgentPulse server is temporarily unavailable.');
    try{return await response.json();}
    catch{throw new Error('AgentPulse returned an invalid channel response.');}
  }
  return {
    connect:body=>request('connect',body),poll:body=>request('poll',body),
    ack:body=>request('ack',body),disconnect:body=>request('disconnect',body),
  };
}

export async function deliverOnce({api,mcp,scope,seen}) {
  const result=await api.poll(scope);
  if(result?.status==='waiting')return false;
  if(result?.status!=='message'||typeof result.message?.id!=='string'||typeof result.message?.text!=='string')
    throw fatal('invalid_poll_response','AgentPulse returned an invalid channel response.');
  if(seen.has(result.message.id))throw fatal('duplicate_claim','AgentPulse returned a duplicate claimed message.');
  seen.add(result.message.id);
  try {
    await mcp.notification({method:'notifications/claude/channel',params:{content:result.message.text,meta:{message_id:result.message.id}}});
  } catch(error) {
    if(error&&typeof error==='object')error.fatal=true;
    throw error;
  }
  try {
    await api.ack({...scope,id:result.message.id});
  } catch(error) {
    if(error?.code!=='channel_registration_lost'&&error&&typeof error==='object')error.fatal=true;
    throw error;
  }
  return true;
}

export async function runChannelLoop({
  api,mcp,scope,home,pid=process.pid,signal,clock=Date.now,sleepFn=sleep,
  writePresenceFn=writePresence,removePresenceFn=removePresence,maxIterations=Infinity,
}) {
  let connected=false,delay=1000,iterations=0;
  const marker=()=>writePresenceFn({home,sessionId:scope.sessionId,pid,updatedAt:clock()});
  try {
    const seen=new Set();
    while(!signal?.aborted&&iterations<maxIterations) {
      if(!connected) {
        try {
          await api.connect(scope);connected=true;marker();delay=1000;
        } catch(error) {
          if(error?.fatal)throw error;
          await sleepFn(delay);delay=Math.min(delay*2,10000);continue;
        }
      }
      try {
        const delivered=await deliverOnce({api,mcp,scope,seen});
        marker();iterations++;delay=1000;
        if(!delivered&&iterations<maxIterations)await sleepFn(1000);
      } catch(error) {
        if(error?.fatal)throw error;
        if(error?.code==='channel_registration_lost'){connected=false;continue;}
        await sleepFn(delay);delay=Math.min(delay*2,10000);
      }
    }
  } finally {
    if(connected)try{await api.disconnect(scope);}catch{}
    try{removePresenceFn({home,sessionId:scope.sessionId,pid});}catch{}
  }
}

export async function findSessionWithRetry({home,pid=process.pid,clock=Date.now,sleepFn=sleep,timeoutMs=30000}) {
  const deadline=clock()+timeoutMs;
  do {
    try {
      const state=readMonitorState({home});
      const session=findClaudeSession({pid,processes:readProcesses(),sessions:state.sessions});
      if(session)return {machineId:state.machineId,session};
    } catch {}
    if(clock()>=deadline)break;
    await sleepFn(500);
  } while(true);
  throw fatal('session_not_found','No matching monitored Claude session was found.');
}

async function main() {
  const mcp=createMcpServer(),transport=new StdioServerTransport();
  const controller=new AbortController();
  mcp.onclose=()=>controller.abort();
  process.once('SIGINT',()=>controller.abort());
  process.once('SIGTERM',()=>controller.abort());
  await mcp.connect(transport);
  const connection=loadConnection();
  const {machineId,session}=await findSessionWithRetry({});
  const scope={machineId,sessionId:session.id,channelId:crypto.randomUUID()};
  await runChannelLoop({api:createBridgeApi(connection),mcp,scope,signal:controller.signal});
  await mcp.close();
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{
    const known=new Set(['bridge_auth_rejected','bridge_request_rejected','session_not_found','invalid_poll_response','duplicate_claim']);
    const reason=known.has(error?.code)?error.code:'channel_unavailable';
    process.stderr.write(`AgentPulse Channel stopped: ${reason}.\n`);
    process.exitCode=1;
  });
}
