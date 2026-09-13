import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);

function roots(home=os.homedir()) {
  const config=path.join(home,'.config','agentpulse');
  return {connection:path.join(config,'connection.json'),monitor:path.join(config,'monitor')};
}

function readPrivateJson(file,label,maxBytes=1024*1024) {
  let fd;
  try {
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  } catch {
    throw new Error(`Cannot safely open the private AgentPulse ${label}.`);
  }
  try {
    const info=fs.fstatSync(fd);
    if(!info.isFile()||info.uid!==process.getuid()||(info.mode&0o077)!==0||info.size>maxBytes)throw new Error(`AgentPulse ${label} must be a private file owned by you.`);
    try{return JSON.parse(fs.readFileSync(fd,'utf8'));}
    catch{throw new Error(`AgentPulse ${label} contains invalid JSON.`);}
  } finally {
    fs.closeSync(fd);
  }
}

function validServer(value) {
  let url;
  try{url=new URL(value);}catch{return null;}
  const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:'&&!(local&&url.protocol==='http:'))return null;
  if(url.username||url.password||url.search||url.hash)return null;
  return url.origin;
}

export function loadConnection({home=os.homedir()}={}) {
  const data=readPrivateJson(roots(home).connection,'connection file');
  const server=validServer(data?.server);
  if(!server)throw new Error('AgentPulse server must use HTTPS. Localhost HTTP is allowed only for testing.');
  const token=data?.token;
  if(typeof token!=='string'||!token||/[^\x21-\x7e]/.test(token))throw new Error('AgentPulse bridge token is invalid.');
  return {server,token};
}

export function readMonitorState({home=os.homedir()}={}) {
  const monitor=roots(home).monitor;
  const machine=readPrivateJson(path.join(monitor,'machine.json'),'machine registry');
  const sessions=readPrivateJson(path.join(monitor,'sessions.json'),'session registry');
  if(!validId(machine?.id)||!Array.isArray(sessions)||sessions.length>100)throw new Error('AgentPulse monitor registry is invalid.');
  return {machineId:machine.id,sessions};
}

export function parseProcesses(raw) {
  const rows=new Map();
  for(const line of String(raw).split('\n')) {
    const match=line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+?)\s*$/);
    if(!match)continue;
    const pid=Number(match[1]),ppid=Number(match[2]);
    rows.set(pid,{pid,ppid,started:match[3],command:match[4]});
  }
  return rows;
}

export function readProcesses() {
  const processes=parseProcesses(execFileSync('/bin/ps',['-axo','pid=,ppid=,lstart=,comm='],{encoding:'utf8',timeout:3000}));
  const argumentsRaw=execFileSync('/bin/ps',['-axo','pid=,args='],{encoding:'utf8',timeout:3000});
  for(const line of argumentsRaw.split('\n')) {
    const match=line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if(match&&processes.has(Number(match[1])))processes.get(Number(match[1])).arguments=match[2];
  }
  return processes;
}

export function claudeChannelOptedIn(process) {
  const args=process?.arguments;
  return typeof args==='string'&&/(?:^|\s)--dangerously-load-development-channels(?:=|\s+)server:agentpulse(?=\s|$)/.test(args);
}

export function findClaudeSession({pid=process.pid,processes,sessions}) {
  let current=pid,claude=null;
  for(let depth=0;depth<30;depth++) {
    const row=processes.get(current);
    if(!row)break;
    if(path.basename(row.command).toLowerCase()==='claude'){claude=row;break;}
    current=row.ppid;
  }
  if(!claude||!claudeChannelOptedIn(claude))return null;
  return sessions.find(session=>session?.provider==='claude'&&session.pid===claude.pid&&session.status!=='closed'&&
    validId(session.id)&&(!session.processStarted||session.processStarted===claude.started))||null;
}

function privateDirectory(directory) {
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const info=fs.lstatSync(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid())throw new Error('Unsafe AgentPulse channel directory.');
  fs.chmodSync(directory,0o700);
}

function markerPath(home,sessionId) {
  if(!validId(sessionId))throw new Error('Invalid AgentPulse session ID.');
  return path.join(roots(home).monitor,'channels',`${sessionId}.json`);
}

export function writePresence({home=os.homedir(),sessionId,pid=process.pid,updatedAt=Date.now()}) {
  if(!Number.isSafeInteger(pid)||pid<1||!Number.isSafeInteger(updatedAt)||updatedAt<0)throw new Error('Invalid AgentPulse channel presence.');
  const file=markerPath(home,sessionId),directory=path.dirname(file);
  privateDirectory(directory);
  const temporary=path.join(directory,`.channel-${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd=fs.openSync(temporary,'wx',0o600);
    fs.writeFileSync(fd,JSON.stringify({version:1,sessionId,pid,updatedAt}));
    fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(temporary,file);fs.chmodSync(file,0o600);
    return file;
  } finally {
    if(fd!==undefined)fs.closeSync(fd);
    try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}

export function removePresence({home=os.homedir(),sessionId,pid=process.pid}) {
  const file=markerPath(home,sessionId);
  let data;
  try{data=readPrivateJson(file,'channel marker',8192);}catch(error){
    if(!fs.existsSync(file))return false;
    throw error;
  }
  if(data?.version!==1||data.sessionId!==sessionId||data.pid!==pid)return false;
  fs.unlinkSync(file);return true;
}
