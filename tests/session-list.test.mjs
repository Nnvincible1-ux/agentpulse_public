import test from 'node:test';
import assert from 'node:assert/strict';
import {isLiveTerminal,selectSessions,responseNote,responseExcerpt} from '../public/session-list.js';
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
