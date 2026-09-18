const OFFLINE_RETENTION=24*3600000;
// A terminal stays listed while its Mac is offline for up to a day; the row is labelled Offline until a snapshot closes or refreshes it.
export function isLiveTerminal(s,now=Date.now()){
 if(s.status==='closed'||typeof s.tty!=='string'||['','??','?'].includes(s.tty))return false;
 return s.online===true||(Number.isFinite(s.updatedAt)&&s.updatedAt>now-OFFLINE_RETENTION);
}
export function selectSessions(sessions,provider,filter,now=Date.now()){
 return sessions.filter(s=>s.provider===provider&&(filter==='all'||(isLiveTerminal(s,now)&&(filter!=='waiting'||(s.online===true&&(s.status==='waiting'||s.reply?.ready))))))
  .sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));
}
export function responseNote(s){
 if(s.summaryHidden)return 'The response was withheld because it may contain credentials. Read it on your computer.';
 if(!s.summary)return 'No agent response has been captured yet. Start a new turn with the session hooks enabled.';
 const parts=[];
 if(s.status==='working')parts.push('The agent is working. This is its previous completed response.');
 else if(s.activity==='Stop'&&s.summaryAt&&s.summaryAt<s.updatedAt)parts.push('The latest event contained no response text. This is the last captured response.');
 if(s.summaryTruncated)parts.push('This response was shortened at 8,000 characters. Read the full response on your computer before replying.');
 return parts.join(' ');
}

export function responseExcerpt(s){
 if(s.summaryHidden)return 'Response withheld';
 const text=typeof s.summary==='string'?s.summary.trim():'';
 return text?text.split(/\n\s*\n/).at(-1).replace(/\s+/g,' '):'No response captured yet';
}

export function age(timestamp,now=Date.now()){
 const seconds=Math.max(0,Math.floor((now-timestamp)/1000));
 if(seconds<60)return `${seconds} seconds ago`;
 const minutes=Math.floor(seconds/60);if(minutes<60)return `${minutes} minute${minutes===1?'':'s'} ago`;
 const hours=Math.floor(minutes/60);return `${hours} hour${hours===1?'':'s'} ago`;
}
const EVENT_NAMES=new Set(['SessionStart','UserPromptSubmit','Stop','StopFailure','SessionEnd','Interrupt']);
// Collapsed row: what the terminal is doing right now, then the last captured response line.
export function sessionPreview(s,now=Date.now()){
 const excerpt=responseExcerpt(s);
 if(s.status!=='working'&&s.status!=='waiting')return excerpt;
 const tool=typeof s.activity==='string'&&s.activity&&!EVENT_NAMES.has(s.activity)?s.activity:'';
 const when=s.updatedAt>0?' · '+age(s.updatedAt,now):'';
 const line=s.status==='waiting'?'Waiting for you'+(tool?' · '+tool:''):tool?'Running '+tool:'Working';
 return line+when+'\n'+excerpt;
}
