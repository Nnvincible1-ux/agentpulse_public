import test from 'node:test';
import assert from 'node:assert/strict';
import {requestLive,requestSessionKey} from '../lib/request-lifecycle.mjs';
import {requestsForSession} from '../public/session-requests.js';
import {canAnswer} from '../public/request-state.js';
test('a dead receiver cannot receive approval despite a future expiry',()=>{
 const now=100000, item={status:'pending',expiresAt:new Date(now+3600000).toISOString(),lease:true,receiverUntil:now+30000};
 assert.equal(requestLive(item,now),true);
 assert.equal(requestLive(item,now+30001),false);
 assert.equal(canAnswer(item,true,false,now+30001),false);
 assert.equal(requestLive({...item,status:'answered'},now),false);
 assert.equal(requestLive({...item,receiverUntil:0},now),false);
 assert.equal(requestLive({...item,lease:false},now),true);
});
test('commands attach only to the exact provider and machine, never an ambiguous legacy session',()=>{
 const a={id:requestSessionKey({provider:'claude',sessionId:'native-1'}),provider:'claude',machineId:'mac-a'}, b={...a,machineId:'mac-b'};
 const req={id:'request',provider:'claude',sessionKey:a.id,machineId:'mac-a'};
 assert.deepEqual(requestsForSession(a,[a,b],[req]),[req]);
 assert.deepEqual(requestsForSession(b,[a,b],[req]),[]);
 assert.deepEqual(requestsForSession({...a,provider:'codex'},[a,b],[req]),[]);
 assert.deepEqual(requestsForSession(a,[a,b],[{...req,machineId:''}]),[]);
 assert.equal(requestsForSession(a,[a],[{...req,machineId:''}]).length,1);
});

test('continuous requests have no age deadline while the exact receiver stays alive',()=>{
 const days=40*86400000, item={status:'pending',continuous:true,lease:true,expiresAt:null,receiverUntil:days+30000};
 assert.equal(requestLive(item,days),true);
 assert.equal(canAnswer(item,true,false,days),true);
 assert.equal(requestLive(item,days+30001),false);
});
