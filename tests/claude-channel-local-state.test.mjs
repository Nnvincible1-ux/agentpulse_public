import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadConnection,readMonitorState,findClaudeSession,writePresence,removePresence,
} from '../claude-channel/local-state.mjs';

function home(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ap-channel-home-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const config=path.join(root,'.config','agentpulse');
  const monitor=path.join(config,'monitor');
  fs.mkdirSync(monitor,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(config,'connection.json'),JSON.stringify({server:'https://pulse.example.com',token:'synthetic-token'}),{mode:0o600});
  fs.writeFileSync(path.join(monitor,'machine.json'),JSON.stringify({id:'machine-1'}),{mode:0o600});
  fs.writeFileSync(path.join(monitor,'sessions.json'),JSON.stringify([{id:'session-1',provider:'claude',pid:40,status:'working',processStarted:'start-1'}]),{mode:0o600});
  return root;
}

test('loads only private connection and monitor files with safe origins',t=>{
  const root=home(t);
  assert.deepEqual(loadConnection({home:root}),{server:'https://pulse.example.com',token:'synthetic-token'});
  assert.deepEqual(readMonitorState({home:root}),{machineId:'machine-1',sessions:[{id:'session-1',provider:'claude',pid:40,status:'working',processStarted:'start-1'}]});
  const file=path.join(root,'.config','agentpulse','connection.json');
  fs.chmodSync(file,0o644);assert.throws(()=>loadConnection({home:root}),/private/);
  fs.chmodSync(file,0o600);fs.writeFileSync(file,JSON.stringify({server:'http://public.example.com',token:'synthetic-token'}));
  assert.throws(()=>loadConnection({home:root}),/HTTPS/);
  fs.writeFileSync(file,JSON.stringify({server:'http://127.0.0.1:8788',token:'synthetic-token'}));
  assert.equal(loadConnection({home:root}).server,'http://127.0.0.1:8788');
});

test('rejects a symlink instead of following a connection file',t=>{
  const root=home(t),config=path.join(root,'.config','agentpulse'),file=path.join(config,'connection.json'),target=path.join(root,'target.json');
  fs.renameSync(file,target);fs.symlinkSync(target,file);
  assert.throws(()=>loadConnection({home:root}),/safely open|private/);
});

test('matches only the exact live Claude ancestor and process identity',()=>{
  const processes=new Map([
    [50,{pid:50,ppid:45,command:'node',started:'child'}],
    [45,{pid:45,ppid:40,command:'helper',started:'helper'}],
    [40,{pid:40,ppid:1,command:'/usr/local/bin/claude',arguments:'/usr/local/bin/claude --dangerously-load-development-channels server:agentpulse',started:'start-1'}],
  ]);
  const sessions=[{id:'session-1',provider:'claude',pid:40,status:'working',processStarted:'start-1'}];
  assert.equal(findClaudeSession({pid:50,processes,sessions}).id,'session-1');
  assert.equal(findClaudeSession({pid:50,processes,sessions:[{...sessions[0],provider:'codex'}]}),null);
  assert.equal(findClaudeSession({pid:50,processes,sessions:[{...sessions[0],status:'closed'}]}),null);
  assert.equal(findClaudeSession({pid:50,processes,sessions:[{...sessions[0],processStarted:'other'}]}),null);
  assert.equal(findClaudeSession({pid:99,processes,sessions}),null);
});

test('rejects a Claude MCP subprocess when its parent session did not opt in to the AgentPulse channel',()=>{
  const sessions=[{id:'session-1',provider:'claude',pid:40,status:'idle',processStarted:'start-1'}];
  const process=(arguments_)=>new Map([
    [50,{pid:50,ppid:40,command:'node',arguments:'node agentpulse-channel.mjs',started:'child'}],
    [40,{pid:40,ppid:1,command:'/usr/local/bin/claude',arguments:arguments_,started:'start-1'}],
  ]);
  assert.equal(findClaudeSession({pid:50,processes:process('/usr/local/bin/claude'),sessions}),null);
  assert.equal(findClaudeSession({pid:50,processes:process('/usr/local/bin/claude --dangerously-load-development-channels server:other'),sessions}),null);
  assert.equal(findClaudeSession({pid:50,processes:process('/usr/local/bin/claude --dangerously-load-development-channels server:agentpulse'),sessions}).id,'session-1');
});

test('presence markers are private and only their writer removes them',t=>{
  const root=home(t),marker=writePresence({home:root,sessionId:'session-1',pid:123,updatedAt:5000});
  assert.equal(fs.statSync(marker).mode&0o777,0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker,'utf8')),{version:1,sessionId:'session-1',pid:123,updatedAt:5000});
  assert.equal(removePresence({home:root,sessionId:'session-1',pid:999}),false);
  assert.equal(fs.existsSync(marker),true);
  assert.equal(removePresence({home:root,sessionId:'session-1',pid:123}),true);
  assert.equal(fs.existsSync(marker),false);
  assert.throws(()=>writePresence({home:root,sessionId:'../escape',pid:123,updatedAt:5000}),/session/);
});
