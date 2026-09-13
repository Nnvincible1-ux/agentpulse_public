import test from 'node:test';
import assert from 'node:assert/strict';
import {isLiveTerminal,selectSessions,responseNote,responseExcerpt} from '../public/session-list.js';
import {composerMode,activeChannelMessage,channelStatusText,channelIsStalled} from '../public/session-replies.js';
const row={id:'one',machineId:'mac',provider:'claude',tty:'ttys001',online:true,status:'idle',updatedAt:100,summary:'Actual answer',summaryAt:80};
test('live terminals exclude closed, offline and app/background processes',()=>{
 assert.equal(isLiveTerminal(row),true);
 for(const update of [{status:'closed'},{online:false},{tty:'??'},{tty:''}])assert.equal(isLiveTerminal({...row,...update}),false);
 assert.equal(isLiveTerminal({...row,status:'untracked'}),true);
});
test('providers remain separate and the newest real update wins over waiting status',()=>{
 const rows=[{...row,id:'old',status:'waiting'},{...row,id:'new',updatedAt:200},{...row,id:'codex',provider:'codex',updatedAt:300},{...row,id:'dead',status:'closed',updatedAt:500}];
 assert.deepEqual(selectSessions(rows,'claude','live').map(s=>s.id),['new','old']);
 assert.deepEqual(selectSessions(rows,'codex','live').map(s=>s.id),['codex']);
 assert.equal(selectSessions(rows,'claude','all')[0].id,'dead');
 assert.deepEqual(rows.map(s=>s.id),['old','new','codex','dead']);
});
test('waiting filter includes ready follow-up channels and excludes stale records',()=>{
 assert.equal(selectSessions([{...row,reply:{ready:true}}],'claude','waiting').length,1);
 assert.equal(selectSessions([{...row,status:'waiting',online:false}],'claude','waiting').length,0);
});
test('previous and missing output are identified rather than presented as live terminal text',()=>{
 assert.match(responseNote({...row,status:'working'}),/previous completed response/);
 assert.match(responseNote({...row,summaryTruncated:true}),/shortened/);
 assert.match(responseNote({...row,summaryHidden:true}),/withheld/);
 assert.match(responseNote({...row,summary:''}),/No agent response/);
});

test('collapsed preview uses the final paragraph without changing the full response',()=>{
 const s={...row,summary:'Deploy complete.\n\nAccount pages remain unpushed until you say so.'};
 assert.equal(responseExcerpt(s),'Account pages remain unpushed until you say so.');
 assert.ok(s.summary.startsWith('Deploy complete.'));
 assert.equal(responseExcerpt({...s,summaryHidden:true}),'Response withheld');
});

test('live Claude channels stay writable while Claude is working',()=>{
 const session={...row,status:'working',channel:{enabled:true,ready:true,messages:[]},reply:{ready:false,messages:[]}};
 assert.equal(composerMode(session,1000),'channel');
 assert.equal(composerMode({...session,provider:'codex'},1000),'none');
 assert.equal(composerMode({...session,channel:{enabled:true,ready:false,messages:[]}},1000),'none');
 assert.equal(composerMode({...session,status:'idle',channel:{enabled:false,ready:false,messages:[]},reply:{ready:true,until:2000,messages:[]}},1000),'reply');
});

test('current channel instruction and delivery labels are explicit',()=>{
 const messages=[
  {id:'old',text:'Old',status:'completed',createdAt:100},
  {id:'current',text:'Run items 1–3.',status:'working',createdAt:200,deliveredAt:210},
 ];
 assert.equal(activeChannelMessage(messages).id,'current');
 assert.equal(channelStatusText('queued'),'Queued on AgentPulse');
 assert.equal(channelStatusText('claimed'),'Delivering to Claude Code');
 assert.equal(channelStatusText('delivered'),'Handed to Claude Channel — processing not confirmed');
 assert.equal(channelStatusText('working'),'Claude is working');
 assert.equal(channelStatusText('completed'),'Response ready');
 assert.match(channelStatusText('expired'),/could not be confirmed/);
});

test('inactivity warning needs an online delivered instruction and two quiet minutes',()=>{
 const message={status:'working',createdAt:1000,deliveredAt:2000};
 assert.equal(channelIsStalled({...row,online:true,updatedAt:3000},message,122999),false);
 assert.equal(channelIsStalled({...row,online:true,updatedAt:3000},message,123000),true);
 assert.equal(channelIsStalled({...row,online:false,updatedAt:3000},message,200000),false);
 assert.equal(channelIsStalled({...row,online:true,updatedAt:3000},{...message,status:'queued'},200000),false);
});
