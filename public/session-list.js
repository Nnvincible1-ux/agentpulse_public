export function isLiveTerminal(s){return s.online===true&&s.status!=='closed'&&typeof s.tty==='string'&&!['','??','?'].includes(s.tty);}
export function selectSessions(sessions,provider,filter){
 return sessions.filter(s=>s.provider===provider&&(filter==='all'||(isLiveTerminal(s)&&(filter!=='waiting'||s.status==='waiting'||s.reply?.ready))))
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
