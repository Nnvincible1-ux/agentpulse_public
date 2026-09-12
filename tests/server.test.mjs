import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as OTPAuth from 'otpauth';

const port = 19188 + Math.floor(Math.random() * 3000);
const base = `http://127.0.0.1:${port}`;
const bridgeToken = 'bridge-test-token';
const mobileToken = 'mobile-test-token';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpulse-'));
let child;
let ownerCookie, csrf;

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('server did not start');
}

function api(url, token, options = {}) {
  const headers = token === mobileToken ? {cookie:ownerCookie,origin:base,'x-csrf-token':csrf,...options.headers} : {authorization:`Bearer ${token}`,...options.headers};
  return fetch(`${base}${url}`, { ...options, headers });
}

test.before(async () => {
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve('.'),
    env: { ...process.env, PORT: String(port), AGENTPULSE_BRIDGE_TOKEN: bridgeToken, AGENTPULSE_MOBILE_TOKEN: mobileToken, AGENTPULSE_DATA_DIR: dataDir, AGENTPULSE_PUBLIC_ORIGIN: base, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForServer();
  const publicStatus=await fetch(`${base}/api/auth/status`);
  assert.equal(publicStatus.status,200);
  assert.equal((await publicStatus.json()).configured,false);
  const post=body=>({method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify(body)});
  const begin=await fetch(`${base}/api/auth/setup`,post({token:mobileToken,email:'test@example.com',password:'synthetic-owner-password'}));
  assert.equal(begin.status,200);
  const pending=await begin.json();
  const confirm=await fetch(`${base}/api/auth/confirm`,post({enrollment:pending.enrollment,code:OTPAuth.URI.parse(pending.uri).generate()}));
  assert.equal(confirm.status,200);
  ownerCookie=confirm.headers.get('set-cookie').split(';')[0];
  csrf=(await confirm.json()).csrf;
});

test.after(() => {
  child?.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('permission request round trip', async () => {
  const create = await api('/api/bridge/requests', bridgeToken, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'r1', provider: 'claude', kind: 'permission', project: 'demo', title: 'Bash', detail: 'git status', canApprove: true })
  });
  assert.equal(create.status, 201);

  const list = await api('/api/mobile/requests', mobileToken);
  const listBody = await list.json();
  assert.equal(listBody.requests.length, 1);
  assert.equal(listBody.requests[0].id, 'r1');

  const answer = await api('/api/mobile/requests/r1/verdict', mobileToken, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' })
  });
  assert.equal(answer.status, 200);

  const verdict = await api('/api/bridge/requests/r1/verdict', bridgeToken);
  const verdictBody = await verdict.json();
  assert.equal(verdictBody.status, 'answered');
  assert.equal(verdictBody.verdict.action, 'approve');
});

test('server rejects remote approval when request is not approvable', async () => {
  await api('/api/bridge/requests', bridgeToken, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'r2', provider: 'claude', kind: 'permission', project: 'demo', title: 'Bash', detail: 'git push', canApprove: false })
  });
  const answer = await api('/api/mobile/requests/r2/verdict', mobileToken, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' })
  });
  assert.equal(answer.status, 400);
});

test('question supports selected option and custom reply', async () => {
  await api('/api/bridge/requests', bridgeToken, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'q1', provider: 'claude', kind: 'question', project: 'demo', title: 'Choice', detail: 'Which?', canApprove: true,
      options: [{ label: 'A' }, { label: 'B', recommended: true }], recommendedIndex: 1 })
  });
  const answer = await api('/api/mobile/requests/q1/verdict', mobileToken, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'custom', answer: 'Use B, but keep tests unchanged' })
  });
  assert.equal(answer.status, 200);
  const verdict = await api('/api/bridge/requests/q1/verdict', bridgeToken);
  const body = await verdict.json();
  assert.equal(body.verdict.action, 'custom');
  assert.match(body.verdict.answer, /keep tests unchanged/);
});

test('one request carries two Claude questions and requires every answer', async () => {
  const questions = [
    { question: 'Which colour?', header: 'Colour', multiSelect: false,
      options: [{ label: 'Blue', description: '', recommended: false },
        { label: 'Green', description: '', recommended: false }], recommendedIndexes: [] },
    { question: 'Which environments?', header: 'Targets', multiSelect: true,
      options: [{ label: 'Test', description: '', recommended: false },
        { label: 'Stage', description: '', recommended: false },
        { label: 'Production', description: '', recommended: false }], recommendedIndexes: [] },
  ];
  const create = await api('/api/bridge/requests', bridgeToken, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'q2', provider: 'claude', kind: 'question',
      project: 'demo', title: '2 questions', detail: 'Claude has 2 questions.',
      canApprove: true, questions }),
  });
  assert.equal(create.status, 201);

  const listed = await (await api('/api/mobile/requests', mobileToken)).json();
  const item = listed.requests.find(request => request.id === 'q2');
  assert.deepEqual(item.questions, questions);

  const incomplete = await api('/api/mobile/requests/q2/verdict', mobileToken, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'answers', answers: [{ optionIndexes: [1] }] }),
  });
  assert.equal(incomplete.status, 400);

  const answer = await api('/api/mobile/requests/q2/verdict', mobileToken, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'answers', answers: [
      { optionIndexes: [1] }, { optionIndexes: [0, 2] },
    ] }),
  });
  assert.equal(answer.status, 200);
  const verdict = await (await api('/api/bridge/requests/q2/verdict', bridgeToken)).json();
  assert.deepEqual(verdict.verdict.answers, [
    { optionIndexes: [1] }, { optionIndexes: [0, 2] },
  ]);
});

test('mobile API rejects the bridge token', async () => {
  const r = await api('/api/mobile/requests', bridgeToken);
  assert.equal(r.status, 401);
});

test('Claude permission hook sends choices and receives the mobile answer', { timeout: 10000 }, async () => {
  const hook = spawn('python3', ['bridge/agentpulse_hook.py', 'claude', 'permission'], {
    env: { ...process.env, AGENTPULSE_SERVER: base, AGENTPULSE_BRIDGE_TOKEN: bridgeToken },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  hook.stdout.on('data', data => { output += data; });
  const exited = new Promise((resolve, reject) => {
    hook.once('error', reject);
    hook.once('exit', resolve);
  });
  try {
    hook.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which colour?', header: 'Colour', multiSelect: false,
        options: [{ label: 'Blue' }, { label: 'Green' }] }] } }));
    let question;
    for (let i = 0; i < 60 && !question; i++) {
      const response = await api('/api/mobile/requests', mobileToken);
      question = (await response.json()).requests.find(item => item.title === 'Colour');
      if (!question) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(question, 'question must appear in the mobile inbox');
    assert.equal(question.kind, 'question');
    assert.deepEqual(question.options.map(option => option.label), ['Blue', 'Green']);
    const response = await api(`/api/mobile/requests/${question.id}/verdict`, mobileToken, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'option', optionIndex: 1 }),
    });
    assert.equal(response.status, 200);
    assert.equal(await exited, 0);
    const result = JSON.parse(output).hookSpecificOutput;
    assert.equal(result.hookEventName, 'PermissionRequest');
    assert.equal(result.decision.behavior, 'allow');
    assert.deepEqual(result.decision.updatedInput.answers, { 'Which colour?': 'Green' });
  } finally {
    hook.kill('SIGTERM');
  }
});

test('Claude permission hook returns two answers from one mobile request', { timeout: 10000 }, async () => {
  const hook = spawn('python3', ['bridge/agentpulse_hook.py', 'claude', 'permission'], {
    env: { ...process.env, AGENTPULSE_SERVER: base, AGENTPULSE_BRIDGE_TOKEN: bridgeToken },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  hook.stdout.on('data', data => { output += data; });
  const exited = new Promise((resolve, reject) => {
    hook.once('error', reject);
    hook.once('exit', resolve);
  });
  try {
    hook.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion',
      tool_input: { questions: [
        { question: 'Which colour?', header: 'Colour', multiSelect: false,
          options: [{ label: 'Blue' }, { label: 'Green' }] },
        { question: 'Which environments?', header: 'Targets', multiSelect: true,
          options: [{ label: 'Test' }, { label: 'Stage' }, { label: 'Production' }] },
      ] } }));
    let request;
    for (let i = 0; i < 60 && !request; i++) {
      const response = await api('/api/mobile/requests', mobileToken);
      request = (await response.json()).requests.find(item => item.title === '2 questions');
      if (!request) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(request.questions.length, 2);
    const response = await api(`/api/mobile/requests/${request.id}/verdict`, mobileToken, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'answers', answers: [
        { optionIndexes: [1] }, { optionIndexes: [0, 2] },
      ] }),
    });
    assert.equal(response.status, 200);
    assert.equal(await exited, 0);
    const result = JSON.parse(output).hookSpecificOutput;
    assert.equal(result.hookEventName, 'PermissionRequest');
    assert.equal(result.decision.behavior, 'allow');
    assert.deepEqual(result.decision.updatedInput.answers, {
      'Which colour?': 'Green',
      'Which environments?': 'Test, Production',
    });
  } finally {
    hook.kill('SIGTERM');
  }
});

test('expanded Claude and Codex approvals return a single explicit allow decision', { timeout: 15000 }, async () => {
  for (const provider of ['claude', 'codex']) {
    const command = 'git push origin feature/' + provider + ' &&\ngh pr create --title "Password reset" --body "' + 'Reviewed change '.repeat(400) + '" 2>&1 | tail -2';
    const args = provider === 'claude'
      ? ['bridge/agentpulse_hook.py', 'claude', 'permission']
      : ['codex-plugin/scripts/permission_hook.py'];
    const hook = spawn('python3', args, {
      env: { ...process.env, AGENTPULSE_SERVER: base, AGENTPULSE_BRIDGE_TOKEN: bridgeToken,
        AGENTPULSE_ALLOW_MUTATING_REMOTE_APPROVALS: 'true', AGENTPULSE_SHOW_PRIVATE_CONTENT: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    hook.stdout.on('data', data => { output += data; });
    const exited = new Promise((resolve, reject) => {
      hook.once('error', reject);
      hook.once('exit', resolve);
    });
    try {
      hook.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash',
        tool_input: { command } }));
      let request;
      for (let i = 0; i < 60 && !request; i++) {
        const response = await api('/api/mobile/requests', mobileToken);
        request = (await response.json()).requests.find(item => item.detail === command);
        if (!request) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(request, provider + ' request must appear with the complete command');
      assert.equal(request.canApprove, true);
      const response = await api('/api/mobile/requests/' + request.id + '/verdict', mobileToken, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      });
      assert.equal(response.status, 200);
      assert.equal(await exited, 0);
      assert.deepEqual(JSON.parse(output).hookSpecificOutput, {
        hookEventName: 'PermissionRequest', decision: { behavior: 'allow' },
      });
    } finally {
      hook.kill('SIGTERM');
    }
  }
});

test('PWA shell is served', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /AgentPulse/);
});

test('install manifest has valid PNG icons and the font is served locally', async () => {
  const response = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(response.status, 200);
  const manifest = await response.json();
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) {
    const image = await fetch(new URL(icon.src, base));
    assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type'), /image\/png/);
    const bytes = Buffer.from(await image.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const size = Number(icon.sizes.split('x')[0]);
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  const font = await fetch(`${base}/fonts/Manrope.ttf`);
  assert.equal(font.status, 200);
  assert.match(font.headers.get('content-type'), /font\/ttf/);
});


test('old mobile token and notification action links cannot bypass login',async()=>{
  const response=await fetch(`${base}/api/mobile/requests`,{headers:{authorization:`Bearer ${mobileToken}`}});
  assert.equal(response.status,401);
  assert.equal(response.headers.get('cache-control'),'no-store');
  for(const method of ['GET','POST']) assert.equal((await fetch(`${base}/api/action/old-token/approve`,{method})).status,410);
});
test('mobile mutations require session, same origin and csrf',async()=>{
  for(const headers of [{cookie:ownerCookie},{cookie:ownerCookie,origin:base},{cookie:ownerCookie,origin:'https://evil.example','x-csrf-token':csrf}]) {
    const response=await fetch(`${base}/api/mobile/requests/r2/verdict`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({action:'deny'})});
    assert.equal(response.status,403);
  }
});
test('hidden requests cannot receive remote approval or answers',async()=>{
  await api('/api/bridge/requests',bridgeToken,{method:'POST',body:JSON.stringify({requestId:'hidden1',provider:'claude',kind:'question',hidden:true,canApprove:true,options:[{label:'X'}]})});
  for(const body of [{action:'approve'},{action:'option',optionIndex:0},{action:'custom',answer:'yes'},
    {action:'answers',answers:[{optionIndexes:[0]}]}]) {
    const r=await api('/api/mobile/requests/hidden1/verdict',mobileToken,{method:'POST',body:JSON.stringify(body)});
    assert.equal(r.status,400);
  }
});
test('push configuration is private and rejects arbitrary endpoints',async()=>{
  const config=await api('/api/mobile/config',mobileToken);
  const body=await config.json();
  assert.ok(body.pushPublicKey); assert.equal(body.ntfyTopic,undefined);
  const sub=await api('/api/mobile/push/subscribe',mobileToken,{method:'POST',body:JSON.stringify({endpoint:'https://127.0.0.1/secret',keys:{}})});
  assert.equal(sub.status,400);
});
test('duplicate bridge request cannot overwrite a pending decision',async()=>{
  const r=await api('/api/bridge/requests',bridgeToken,{method:'POST',body:JSON.stringify({requestId:'r2',provider:'claude',kind:'permission',canApprove:true})});
  assert.equal(r.status,409);
});

test('browser auth mutations reject cross-origin setup and login',async()=>{
  for(const endpoint of ['setup','login']) {
    const response=await fetch(`${base}/api/auth/${endpoint}`,{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{}'});
    assert.equal(response.status,403);
  }
});
test('JSON bodies must be objects and cannot replace request state with prototype keys',async()=>{
  for(const body of ['null','[]','"text"']) {
    const response=await api('/api/auth/login',mobileToken,{method:'POST',body});
    assert.equal(response.status,400);
  }
  const response=await api('/api/bridge/requests',bridgeToken,{method:'POST',body:JSON.stringify({requestId:'__proto__',provider:'claude',kind:'question'})});
  assert.equal(response.status,400);
});
test('private long command roundtrip requires login and a live receiver',async()=>{
  const command='echo "password reset"\n'+'# synthetic '.repeat(1000);
  const body={requestId:'leased',continuous:true,provider:'claude',kind:'permission',sessionId:'native-1',machineId:'mac-a',lease:true,waitSeconds:3600,canApprove:true,detail:command};
  const created=await api('/api/bridge/requests',bridgeToken,{method:'POST',body:JSON.stringify(body)});
  assert.equal(created.status,201);
  const requests=await (await api('/api/mobile/requests',mobileToken)).json();
  const item=requests.requests.find(x=>x.id==='leased');
  assert.equal(item.detail,command); assert.equal(item.machineId,'mac-a'); assert.equal(item.sessionKey.length,32);
  assert.equal(item.expiresAt,null); assert.equal(item.continuous,true); assert.ok(item.receiverUntil>Date.now());
  assert.equal((await api('/api/mobile/requests',bridgeToken)).status,401);
  assert.equal((await api('/api/mobile/requests/leased/verdict',mobileToken,{method:'POST',body:JSON.stringify({action:'approve'})})).status,200);
  const received=await (await api('/api/bridge/requests/leased/verdict',bridgeToken)).json();
  assert.equal(received.verdict.action,'approve');
  assert.equal((await api('/api/mobile/requests/leased/verdict',mobileToken,{method:'POST',body:JSON.stringify({action:'approve'})})).status,409);
  assert.equal((await api('/api/bridge/requests',bridgeToken,{method:'POST',body:JSON.stringify({...body,requestId:'too-long',detail:'x'.repeat(65537)})})).status,400);
  await api('/api/bridge/requests',bridgeToken,{method:'POST',body:JSON.stringify({...body,requestId:'cancelled'})});
  assert.equal((await api('/api/bridge/requests/cancelled',mobileToken,{method:'DELETE'})).status,401);
  assert.equal((await api('/api/bridge/requests/cancelled',bridgeToken,{method:'DELETE'})).status,200);
  assert.equal((await api('/api/mobile/requests/cancelled/verdict',mobileToken,{method:'POST',body:JSON.stringify({action:'approve'})})).status,409);
});

test('logout revokes the session and its server-tracked push subscription',async()=>{
  const crypto=await import('node:crypto');
  const ec=crypto.createECDH('prime256v1');ec.generateKeys();
  const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-logout-test',keys:{p256dh:ec.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')}};
  const subscribe=await api('/api/mobile/push/subscribe',mobileToken,{method:'POST',body:JSON.stringify(subscription)});
  assert.equal(subscribe.status,200);
  const logout=await api('/api/auth/logout',mobileToken,{method:'POST',body:'{}'});
  assert.equal(logout.status,200);
  assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await api('/api/mobile/requests',mobileToken)).status,401);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir,'push.json'),'utf8')).subscriptions.length,0);
});
