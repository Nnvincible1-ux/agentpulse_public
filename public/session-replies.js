import {api} from './auth.js';
const drafts=new Map();
const key=s=>s.machineId+':'+s.id;
const labels={queued:'Queued for this session',claimed:'Delivery is unconfirmed. Check the session before sending again.',delivered:'Sent to the session',cancelled:'Cancelled',expired:'Not sent — the receiving window closed'};
function el(tag,className,text){const node=document.createElement(tag);node.className=className;if(text!=null)node.textContent=text;return node;}
export function clearReplyDrafts(){drafts.clear();}
export function replyComposer(s,rerender){
  const k=key(s);if(!drafts.has(k))drafts.set(k,{text:'',id:crypto.randomUUID(),error:'',busy:false});
  const draft=drafts.get(k),reply=s.reply||{ready:false,messages:[]};
  const form=el('form','session-reply');
  const label=el('label','',`Message ${s.provider==='claude'?'Claude':'Codex'} · ${s.project}`);
  const input=el('textarea','');input.id='reply-'+k;label.htmlFor=input.id;input.dataset.replyKey=k;
  input.value=draft.text;input.maxLength=4000;input.rows=3;input.placeholder='For example: Push the account pages too.';
  const pending=reply.messages.some(m=>m.status==='queued');
  const ready=reply.ready&&s.online&&reply.until>Date.now();
  input.disabled=draft.busy;
  const note=el('p','field-note',ready?`This session can receive a follow-up until ${new Date(reply.until).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}.`:
    (!s.tty || s.tty==='??' || s.tty==='?')?'This app/background process is status-only. Send follow-ups from sessions running in a terminal.':
    !s.online?'The Mac is offline. Reconnect it before sending.':s.status==='working'?'The agent is working. You can draft a message and send it after the next response.':s.status==='waiting'?'Answer the pending request in Inbox first.':
    'No reply channel is open. Start or resume the session on your computer with the updated hooks.');
  note.id=input.id+'-note';input.setAttribute('aria-describedby',note.id);
  const actions=el('div','reply-actions');
  const send=el('button','primary',draft.busy?'Sending…':'Send follow-up');send.type='submit';
  send.disabled=!ready||pending||draft.busy||!draft.text.trim();
  input.addEventListener('input',()=>{draft.text=input.value;draft.id=crypto.randomUUID();draft.error='';draft.windowId=null;send.disabled=!ready||pending||draft.busy||!draft.text.trim();});
  async function act(action,extra={}){
    if(draft.busy)return;draft.busy=true;draft.error='';rerender();
    try{
      const result=await api('/api/mobile/replies/'+action,{method:'POST',body:JSON.stringify({machineId:s.machineId,sessionId:s.id,windowId:action==='send'?draft.windowId:reply.windowId,...extra})});
      if(action==='send'){
        draft.text='';draft.id=crypto.randomUUID();draft.windowId=null;
        reply.messages=[result,...reply.messages.filter(m=>m.id!==result.id)];
      }else if(action==='release'){reply.ready=false;reply.messages.forEach(m=>{if(m.status==='queued')m.status='cancelled';});}
      else {const m=reply.messages.find(m=>m.id===extra.id);if(m)m.status='cancelled';}
    }catch(error){
      draft.error=error.status===401?'Sign in again, then retry. Your draft is still here.':
        error.message==='session_not_ready'?'The session stopped receiving messages. Refresh its status; your draft is still here.':
        error.message==='window_changed'?'The receiving window changed. Review the latest response and edit your draft before retrying.':
        error.message==='message_pending'?'A message is already queued. Wait for it or cancel it first.':
        error.message==='invalid_message'?'Use 1–4,000 characters without control characters.':
        'Could not confirm the request. Check its status, then retry the same message if needed.';
    }finally{draft.busy=false;rerender();}
  }
  form.addEventListener('submit',event=>{event.preventDefault();if(!send.disabled){draft.windowId ||= reply.windowId;void act('send',{id:draft.id,text:draft.text});}});
  actions.append(send);
  if(ready){const release=el('button','secondary','Continue at computer');release.type='button';release.disabled=draft.busy;release.addEventListener('click',()=>void act('release'));actions.append(release);}
  form.append(label,input,note,actions);
  if(draft.error){const error=el('p','reply-error',draft.error);error.setAttribute('role','alert');form.append(error);}
  if(reply.messages.length){
    const history=el('div','reply-history');history.append(el('h2','session-response-heading','Your recent messages'));
    for(const m of reply.messages){
      const item=el('div','reply-message');item.append(el('p','session-response',m.text),el('p','field-note',`${labels[m.status]||'Unknown delivery status'} · ${new Date(m.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`));
      if(m.status==='queued'){const cancel=el('button','secondary','Cancel message');cancel.type='button';cancel.disabled=draft.busy;cancel.addEventListener('click',()=>void act('cancel',{id:m.id}));item.append(cancel);}
      history.append(item);
    }
    form.append(history);
  }
  return form;
}
