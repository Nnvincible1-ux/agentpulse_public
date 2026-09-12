import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {Auth} from './lib/auth.mjs';
import {Push} from './lib/push.mjs';
import {Sessions} from './lib/sessions.mjs';
import {requestLive, requestSessionKey} from './lib/request-lifecycle.mjs';
import {Replies} from './lib/replies.mjs';
import {equal,fail} from './lib/storage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const dataDir = process.env.AGENTPULSE_DATA_DIR ? path.resolve(process.env.AGENTPULSE_DATA_DIR) : path.join(__dirname, 'data');
const statePath = path.join(dataDir, 'state.json');
fs.mkdirSync(dataDir, { recursive: true });

const PORT = Number(process.env.PORT || 8788);
const BRIDGE_TOKEN = process.env.AGENTPULSE_BRIDGE_TOKEN || '';
const MOBILE_TOKEN = process.env.AGENTPULSE_MOBILE_TOKEN || '';
const PUBLIC_ORIGIN = (process.env.AGENTPULSE_PUBLIC_ORIGIN || '').replace(/\/$/, '');
const TTL_SECONDS = Math.max(30, Math.min(300, Number(process.env.AGENTPULSE_REQUEST_TTL_SECONDS || 120)));
const ownerAuth = new Auth({dir:dataDir,origin:PUBLIC_ORIGIN,bootstrapToken:MOBILE_TOKEN});
const push = new Push({dir:dataDir,origin:PUBLIC_ORIGIN});
const sessions = new Sessions({dir:dataDir});
const replies = new Replies({dir:dataDir,lookup:(machineId,id)=>sessions.list().find(s=>s.machineId===machineId&&s.id===id)});
setInterval(() => {
  try { sessions.prune(); replies.prune(); } catch { console.error('Session cleanup failed.'); }
}, 60000).unref();

if (!BRIDGE_TOKEN || (!MOBILE_TOKEN && !ownerAuth.configured)) {
  console.error('Missing AGENTPULSE_BRIDGE_TOKEN or AGENTPULSE_MOBILE_TOKEN');
  process.exit(1);
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), {mode:0o600});
  fs.renameSync(tmp, file);
}
let state = loadJson(statePath, { requests: {} });
if (!state.requests || typeof state.requests !== 'object') state.requests = {};
// A restarted server cannot prove that an earlier terminal prompt still exists.
// Discard its unanswered leases instead of showing stale, unanswerable cards.
let discardedLeases = false;
for (const [id, item] of Object.entries(state.requests)) {
  if (item?.lease && item.status === 'pending') {
    delete state.requests[id]; discardedLeases = true;
  }
}
if (discardedLeases) saveJson(statePath, state);

function json(res, status, body, extra = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, ...extra });
  res.end(data);
}
function auth(req, expected) { return equal(req.headers.authorization, `Bearer ${expected}`); }
async function readBody(req, max = 64 * 1024) {
  const chunks = []; let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > max) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const value = raw ? JSON.parse(raw) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400,'JSON body must be an object.');
  return value;
}
function nowIso() { return new Date().toISOString(); }
function cleanup() {
  const now = Date.now(); let changed = false;
  for (const [id, item] of Object.entries(state.requests)) {
    if (!item || (item.status === 'pending' && item.lease && !(item.receiverUntil > now)) ||
        (!item.continuous && new Date(item.expiresAt).getTime() <= now) || item.status === 'consumed') {
      delete state.requests[id]; changed = true;
    }
  }
  if (changed) saveJson(statePath, state);
}
setInterval(cleanup, 15000).unref();

function normalizeRequest(input) {
  if (input?.requestId != null && (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) || ['__proto__','constructor','prototype'].includes(input.requestId))) throw fail(400,'invalid_request_id');
  if (!input || !['claude', 'codex'].includes(input.provider) || !['question', 'permission'].includes(input.kind)) throw fail(400,'invalid_request');
  if (typeof input.detail === 'string' && input.detail.length > 65536) throw fail(400,'request_detail_too_long');
  const duration = input.lease === true && Number.isInteger(input.waitSeconds) ? Math.max(15, Math.min(3600, input.waitSeconds)) : TTL_SECONDS;
  const options = Array.isArray(input.options) ? input.options.slice(0, 8).map((o, index) => ({
    index, label: String(o?.label || '').slice(0, 240), description: String(o?.description || '').slice(0, 1000), recommended: o?.recommended === true
  })) : [];
  const recommendedIndex = Number.isInteger(input.recommendedIndex) && input.recommendedIndex >= 0 && input.recommendedIndex < options.length ? input.recommendedIndex : null;
  let questions = [];
  if (input.kind === 'question' && input.questions != null) {
    if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4)
      throw fail(400,'invalid_questions');
    const seen = new Set();
    questions = input.questions.map(question => {
      if (!question || typeof question !== 'object' || Array.isArray(question) ||
          typeof question.question !== 'string' || !question.question.trim() || question.question.length > 2000 || seen.has(question.question) ||
          typeof question.header !== 'string' || question.header.length > 400 ||
          !Array.isArray(question.options) || question.options.length < 1 || question.options.length > 8)
        throw fail(400,'invalid_questions');
      seen.add(question.question);
      const nestedOptions = question.options.map(option => {
        if (!option || typeof option !== 'object' || Array.isArray(option) ||
            typeof option.label !== 'string' || !option.label || option.label.length > 240 ||
            (option.description != null && (typeof option.description !== 'string' || option.description.length > 1000)))
          throw fail(400,'invalid_questions');
        return {label:option.label, description:option.description || '', recommended:option.recommended === true};
      });
      const recommendedIndexes = Array.isArray(question.recommendedIndexes) ? question.recommendedIndexes :
        nestedOptions.flatMap((option,index)=>option.recommended?[index]:[]);
      if (recommendedIndexes.some((index,position)=>!Number.isInteger(index) || index < 0 || index >= nestedOptions.length || recommendedIndexes.indexOf(index) !== position))
        throw fail(400,'invalid_questions');
      return {question:question.question, header:question.header || 'Question', multiSelect:question.multiSelect === true,
        options:nestedOptions, recommendedIndexes};
    });
  }
  return {
    id: String(input.requestId || crypto.randomUUID()).slice(0, 128),
    provider: input.provider, kind: input.kind,
    project: String(input.project || 'unknown').slice(0, 160),
    sessionId: String(input.sessionId || '').slice(0, 256),
    machineId: typeof input.machineId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input.machineId) ? input.machineId : '',
    lease: input.lease === true, continuous: input.lease === true && input.continuous === true, receiverSeenAt: Date.now(), receiverSavedAt: Date.now(), receiverUntil: input.lease === true ? Date.now() + 30000 : null,
    title: String(input.title || '').slice(0, 400), detail: String(input.detail || ''),
    tool: String(input.tool || '').slice(0, 120), canApprove: input.canApprove === true, hidden: input.hidden === true,
    options, recommendedIndex, questions,
    createdAt: nowIso(), expiresAt: input.lease === true && input.continuous === true ? null : new Date(Date.now() + duration * 1000).toISOString(),
    status: 'pending', verdict: null
  };
}
function mobileView(item) {
  return { id:item.id, sessionKey:requestSessionKey(item), continuous:item.continuous === true, machineId:item.machineId || "", receiverUntil:item.lease ? item.receiverUntil : null, provider:item.provider, kind:item.kind, project:item.project, title:item.hidden?'':item.title, detail:item.hidden?'':item.detail, tool:item.hidden?'':item.tool,
    canApprove:item.canApprove, hidden:item.hidden, options:item.hidden?[]:item.options, recommendedIndex:item.hidden?null:item.recommendedIndex,
    questions:item.hidden?[]:(item.questions || []),
    createdAt:item.createdAt, expiresAt:item.expiresAt, status:item.status };
}
function verdictAllowed(item, body) {
  const action = body?.action;
  if (!['approve','deny','leave_it','option','custom','answers'].includes(action)) return false;
  if (item.hidden && ['approve','option','custom','answers'].includes(action)) return false;
  if (action === 'approve' && (item.kind !== 'permission' || !item.canApprove)) return false;
  if (action === 'option') return item.kind === 'question' && Number.isInteger(body.optionIndex) && body.optionIndex >= 0 && body.optionIndex < item.options.length;
  if (action === 'custom') return item.kind === 'question' && typeof body.answer === 'string' && body.answer.trim().length > 0 && body.answer.length <= 1000;
  if (action === 'answers') return item.kind === 'question' && questionAnswers(item,body) !== null;
  return true;
}
function questionAnswers(item, body) {
  const questions = item.questions || [];
  if (!questions.length || !Array.isArray(body?.answers) || body.answers.length !== questions.length) return null;
  const normalized = [];
  for (let index=0; index<questions.length; index++) {
    const question=questions[index], answer=body.answers[index];
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
    if (typeof answer.answer === 'string' && answer.answer.trim() && answer.answer.length <= 1000) {
      normalized.push({answer:answer.answer.trim()});
      continue;
    }
    const selected=answer.optionIndexes;
    if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length ||
        (!question.multiSelect && selected.length !== 1) ||
        selected.some(option=>!Number.isInteger(option) || option < 0 || option >= question.options.length)) return null;
    normalized.push({optionIndexes:[...selected]});
  }
  return normalized;
}
function resolveItem(item, body) {
  if (!requestLive(item) || !verdictAllowed(item, body)) return false;
  const answers = body.action === 'answers' ? questionAnswers(item,body) : null;
  item.verdict = { action: body.action, optionIndex: Number.isInteger(body.optionIndex) ? body.optionIndex : null,
    answer: typeof body.answer === 'string' ? body.answer.trim() : null, ...(answers?{answers}:{}), answeredAt: nowIso() };
  item.status = 'answered'; saveJson(statePath, state); return true;
}

const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.webmanifest':'application/manifest+json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ttf':'font/ttf' };
function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  rel = path.normalize(rel).replace(/^\.\.(?:[\\/]|$)/, '');
  const file = path.join(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const data = fs.readFileSync(file);
  res.writeHead(200, { 'content-type':mime[path.extname(file)] || 'application/octet-stream', 'content-length':data.length, 'cache-control':['.html','.js'].includes(path.extname(file)) ? 'no-cache' : 'public, max-age=300' });
  res.end(data); return true;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('referrer-policy','no-referrer');
  res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (PUBLIC_ORIGIN.startsWith('https:')) res.setHeader('strict-transport-security','max-age=31536000');
  try {
    cleanup();
    const url = new URL(req.url, PUBLIC_ORIGIN); const p = url.pathname;
    if (req.method === 'GET' && p === '/healthz') return json(res,200,{ok:true,now:nowIso()});
    if (p.startsWith('/api/action/')) return json(res,410,{error:'Open AgentPulse and sign in to respond.'});
    if (p.startsWith('/api/auth/')) {
      const session=ownerAuth.session(req);
      if(req.method==='GET' && p==='/api/auth/status') return json(res,200,{configured:ownerAuth.configured,authenticated:Boolean(session),...(session?{csrf:session.csrf,email:ownerAuth.owner.email}:{})});
      if(req.method!=='POST') return json(res,404,{error:'not_found'});
      ownerAuth.checkMutation(req);
      const body=await readBody(req,8192);
      let result;
      if(p==='/api/auth/setup') return json(res,200,await ownerAuth.beginSetup(body));
      if(p==='/api/auth/confirm') result=ownerAuth.confirmSetup(body);
      else if(p==='/api/auth/login') result=await ownerAuth.login(body);
      else if(p==='/api/auth/reset-password') return json(res,200,await ownerAuth.resetPassword(body),{'set-cookie':ownerAuth.cookie('',0)});
      else if(p==='/api/auth/logout') {
        if(!session) return json(res,401,{error:'unauthorized'});
        ownerAuth.checkMutation(req,session);
        if(ownerAuth.session(req)!==session) return json(res,401,{error:'unauthorized'});
        if(session.pushEndpoint) push.unsubscribe(session.pushEndpoint);
        if(typeof body.endpoint==='string') push.unsubscribe(body.endpoint);
        return json(res,200,{ok:true},{'set-cookie':ownerAuth.logout(req)});
      } else return json(res,404,{error:'not_found'});
      const {cookie,...data}=result;
      return json(res,200,data,{'set-cookie':cookie});
    }

    if (p.startsWith('/api/bridge/')) {
      if (!auth(req, BRIDGE_TOKEN)) return json(res,401,{error:'unauthorized'});
      if (req.method === 'POST' && ['/api/bridge/replies/poll','/api/bridge/replies/ack'].includes(p)) {
        const body=await readBody(req,8192);
        return json(res,200,p.endsWith('/poll')?replies.poll(body):replies.ack(body));
      }
      if (req.method === 'POST' && p === '/api/bridge/sessions') {
        const notifications = sessions.update(await readBody(req, 1024 * 1024));
        for (const session of notifications) void push.notifySession(session).catch(() => console.error('Session notification delivery failed.'));
        return json(res,200,{ok:true});
      }
      if (req.method === 'POST' && p === '/api/bridge/requests') {
        const item = normalizeRequest(await readBody(req, 512 * 1024));
        if(Object.hasOwn(state.requests,item.id)) return json(res,409,{error:'request_exists'});
        state.requests[item.id] = item; saveJson(statePath,state);
        void push.notify(item).catch(()=>console.error('Notification delivery failed.'));
        return json(res,201,{id:item.id,expiresAt:item.expiresAt,detailDigest:crypto.createHash('sha256').update(item.detail).digest('hex')});
      }
      const cancelled = p.match(/^\/api\/bridge\/requests\/([^/]+)$/);
      if (req.method === 'DELETE' && cancelled) {
        delete state.requests[decodeURIComponent(cancelled[1])]; saveJson(statePath,state);
        return json(res,200,{ok:true});
      }
      const m = p.match(/^\/api\/bridge\/requests\/([^/]+)\/verdict$/);
      if (req.method === 'GET' && m) {
        const id = decodeURIComponent(m[1]);
        const item = state.requests[id];
        if (!item) return json(res,404,{status:'gone'});
        if (item.lease) {
          if (item.status === 'pending' && !(item.receiverUntil > Date.now())) {
            delete state.requests[id]; saveJson(statePath,state);
            return json(res,404,{status:'gone'});
          }
          item.receiverSeenAt = Date.now(); item.receiverUntil = item.receiverSeenAt + 30000;
          if (item.receiverSeenAt - (item.receiverSavedAt || 0) >= 60000) {
            item.receiverSavedAt = item.receiverSeenAt; saveJson(statePath,state);
          }
        }
        if (item.status !== 'answered') return json(res,200,{status:'pending',expiresAt:item.expiresAt});
        const verdict = item.verdict; item.status = 'consumed'; saveJson(statePath,state); return json(res,200,{status:'answered',verdict});
      }
      return json(res,404,{error:'not_found'});
    }

    if (p.startsWith('/api/mobile/')) {
      const session=ownerAuth.session(req);
      if (!session) return json(res,401,{error:'unauthorized'});
      if (req.method==='GET' && p==='/api/mobile/sessions') {
        replies.prune();
        return json(res,200,{sessions:sessions.list().map(s=>({...s,reply:replies.view(s)}))});
      }
      if(req.method!=='GET') ownerAuth.checkMutation(req,session);
      if(req.method==='POST' && ['/api/mobile/replies/send','/api/mobile/replies/cancel','/api/mobile/replies/release'].includes(p)) {
        const body=await readBody(req,32768);
        if(ownerAuth.session(req)!==session) return json(res,401,{error:'unauthorized'});
        const result=p.endsWith('/send')?replies.send(body):p.endsWith('/cancel')?replies.cancel(body):replies.release(body);
        return json(res,200,result);
      }
      if (req.method === 'GET' && p === '/api/mobile/config') return json(res,200,{pushPublicKey:push.publicKey});
      if(req.method==='POST' && p.startsWith('/api/mobile/push/')) {
        const body=await readBody(req,8192);
        if(ownerAuth.session(req)!==session) return json(res,401,{error:'unauthorized'});
        if(p==='/api/mobile/push/subscribe') {push.subscribe(body); ownerAuth.attachPushEndpoint(session,body.endpoint); return json(res,200,{ok:true});}
        if(p==='/api/mobile/push/unsubscribe') {if(typeof body.endpoint!=='string') throw fail(400,'invalid_subscription'); push.unsubscribe(body.endpoint); return json(res,200,{ok:true});}
        if(p==='/api/mobile/push/test') return json(res,200,await push.test(body.endpoint));
      }
      if (req.method === 'GET' && p === '/api/mobile/requests') {
        const items = Object.values(state.requests).filter(item=>requestLive(item)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
        return json(res,200,{requests:items.map(mobileView)});
      }
      const m = p.match(/^\/api\/mobile\/requests\/([^/]+)\/verdict$/);
      if (req.method === 'POST' && m) {
        const body = await readBody(req);
        if(ownerAuth.session(req)!==session) return json(res,401,{error:'unauthorized'});
        cleanup();
        const item = state.requests[decodeURIComponent(m[1])];
        if (!requestLive(item)) return json(res,409,{error:'request_not_pending'});
        if (!resolveItem(item, body)) return json(res,400,{error:'invalid_verdict'});
        return json(res,200,{ok:true});
      }
      return json(res,404,{error:'not_found'});
    }

    if (req.method === 'GET' && serveStatic(res,p)) return;
    return json(res,404,{error:'not_found'});
  } catch (error) {
    if (error?.message === 'body_too_large') return json(res,413,{error:'body_too_large'});
    if(error?.status) return json(res,error.status,{error:error.message},error.status===429?{'retry-after':'300'}:{});
    if (error instanceof SyntaxError || error instanceof URIError) return json(res,400,{error:'invalid_json'});
    console.error('Request failed:', error?.name || 'Error'); return json(res,500,{error:'internal_error'});
  }
});

server.listen(PORT,'0.0.0.0',()=>console.log(`AgentPulse listening on :${PORT}`));
