import {api} from './auth.js';

const drafts=new Map();
const key=session=>`${session.machineId}:${session.id}`;
const activeStatuses=new Set(['queued','claimed','delivered','working']);
const channelLabels={
  queued:'Queued on AgentPulse',claimed:'Delivering to Claude Code',delivered:'Sent to Claude Code',
  working:'Claude is working',completed:'Response ready',cancelled:'Cancelled',
  expired:'Delivery could not be confirmed — check Claude before sending again',
};
const replyLabels={queued:'Queued for this session',claimed:'Delivery is unconfirmed. Check the session before sending again.',delivered:'Sent to the session',cancelled:'Cancelled',expired:'Not sent — the receiving window closed'};
const statusPrompt='Give me a concise status update: what is done, what is running, what is blocked, and what you need from me.';

function el(tag,className,text){const node=document.createElement(tag);node.className=className;if(text!=null)node.textContent=text;return node;}
export function clearReplyDrafts(){drafts.clear();}
export function channelStatusText(status){return channelLabels[status]||'Unknown delivery status';}
export function activeChannelMessage(messages=[]){return messages.filter(message=>activeStatuses.has(message.status)).at(-1)||null;}
export function composerMode(session,now=Date.now()) {
  if(session.provider==='claude'&&session.online&&session.channel?.enabled&&session.channel.ready)return 'channel';
  if(session.online&&session.reply?.ready&&session.reply.until>now)return 'reply';
  return 'none';
}
export function channelIsStalled(session,message,now=Date.now()) {
  if(!session.online||!message||!['delivered','working'].includes(message.status))return false;
  return now-Math.max(session.updatedAt||0,message.deliveredAt||message.createdAt||0)>=120000;
}

export function replyComposer(session,rerender){
  const draftKey=key(session);
  if(!drafts.has(draftKey))drafts.set(draftKey,{text:'',id:crypto.randomUUID(),editId:null,error:'',busy:false});
  const draft=drafts.get(draftKey),reply=session.reply||{ready:false,messages:[]},channel=session.channel||{enabled:false,ready:false,messages:[]};
  const mode=composerMode(session),usesChannel=mode==='channel'||(mode==='none'&&session.provider==='claude'&&channel.messages.length>0);
  const messages=usesChannel?channel.messages:reply.messages;
  const pending=messages.some(message=>['queued','claimed'].includes(message.status));
  const editing=Boolean(draft.editId);
  const form=el('form','session-reply');
  const label=el('label','',`Message ${session.provider==='claude'?'Claude':'Codex'} · ${session.project}`);
  const input=el('textarea','');input.id='reply-'+draftKey;label.htmlFor=input.id;input.dataset.replyKey=draftKey;
  input.value=draft.text;input.maxLength=4000;input.rows=3;input.placeholder='For example: Continue with items 1–3.';input.disabled=draft.busy;
  let noteText;
  if(mode==='channel')noteText='Channel connected. Messages go to this exact Claude Code session, including while it is working.';
  else if(mode==='reply')noteText=`This session can receive one follow-up until ${new Date(reply.until).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}.`;
  else if(!session.tty||session.tty==='??'||session.tty==='?')noteText='This app/background process is status-only. Send messages from a Claude Code session running in a terminal.';
  else if(!session.online)noteText='The Mac is offline. Reconnect it before sending.';
  else if(session.provider==='claude'&&channel.enabled&&channel.lastHeartbeat)noteText='AgentPulse Channel is reconnecting or closed. Wait for a fresh status; if it stays disconnected, start a new Claude session.';
  else if(session.provider==='claude'&&channel.enabled)noteText='This Claude session was not started with AgentPulse Channel. Start a new Claude session with the configured Channel.';
  else if(session.status==='waiting')noteText='Answer the pending request in Inbox first.';
  else noteText='No continuation channel is open. Start or resume the session on your computer with the updated hooks.';
  const note=el('p','field-note',noteText);note.id=input.id+'-note';input.setAttribute('aria-describedby',note.id);
  const actions=el('div','reply-actions');
  const send=el('button','primary',draft.busy?'Sending…':editing?'Save queued message':usesChannel?'Send to Claude':'Send follow-up');send.type='submit';
  const updateSendState=()=>{send.disabled=(mode==='none'&&!editing)||draft.busy||!draft.text.trim()||(pending&&!editing);};
  updateSendState();
  input.addEventListener('input',()=>{draft.text=input.value;if(!draft.editId)draft.id=crypto.randomUUID();draft.error='';draft.windowId=null;updateSendState();});

  async function act(action,extra={},preserveDraft=false){
    if(draft.busy)return;draft.busy=true;draft.error='';rerender();
    const family=usesChannel?'claude-channels':'replies';
    try{
      const payload={machineId:session.machineId,sessionId:session.id,...extra};
      if(!usesChannel)payload.windowId=action==='send'?draft.windowId:reply.windowId;
      const result=await api(`/api/mobile/${family}/${action}`,{method:'POST',body:JSON.stringify(payload)});
      if(action==='send'||action==='update'){
        if(!preserveDraft){draft.text='';draft.id=crypto.randomUUID();draft.editId=null;draft.windowId=null;}
        messages.splice(0,messages.length,result,...messages.filter(message=>message.id!==result.id));
      }else if(action==='release'){
        reply.ready=false;reply.messages.forEach(message=>{if(message.status==='queued')message.status='cancelled';});
      }else {
        const message=messages.find(item=>item.id===extra.id);if(message)message.status='cancelled';
        if(draft.editId===extra.id){draft.text='';draft.id=crypto.randomUUID();draft.editId=null;}
      }
    }catch(error){
      draft.error=error.status===401?'Sign in again, then retry. Your draft is still here.':
        ['session_not_ready','channel_not_ready'].includes(error.message)?'The session is not connected for messages. Refresh its status; your draft is still here.':
        error.message==='window_changed'?'The receiving window changed. Review the latest response and edit your draft before retrying.':
        error.message==='message_pending'?'A message is already queued. Wait for it or cancel it first.':
        error.message==='message_not_pending'?'Claude already claimed that message, so it can no longer be changed.':
        error.message==='invalid_message'?'Use 1–4,000 characters without control characters.':
        'Could not confirm the request. Check its status before trying again.';
    }finally{draft.busy=false;rerender();}
  }

  form.addEventListener('submit',event=>{
    event.preventDefault();if(send.disabled)return;
    if(mode==='reply')draft.windowId||=reply.windowId;
    void act(editing?'update':'send',{id:editing?draft.editId:draft.id,text:draft.text});
  });
  actions.append(send);
  if(mode==='channel'){
    const status=el('button','secondary','Request status');status.type='button';status.disabled=pending||draft.busy;
    status.addEventListener('click',()=>void act('send',{id:crypto.randomUUID(),text:statusPrompt},true));actions.append(status);
  }
  if(mode==='reply'){
    const release=el('button','secondary','Continue at computer');release.type='button';release.disabled=draft.busy;
    release.addEventListener('click',()=>void act('release'));actions.append(release);
  }
  if(editing){
    const stopEditing=el('button','secondary','Stop editing');stopEditing.type='button';stopEditing.disabled=draft.busy;
    stopEditing.addEventListener('click',()=>{draft.text='';draft.id=crypto.randomUUID();draft.editId=null;rerender();});actions.append(stopEditing);
  }
  form.append(label,input,note,actions);
  if(draft.error){const error=el('p','reply-error',draft.error);error.setAttribute('role','alert');form.append(error);}
  if(messages.length){
    const history=el('div','reply-history');history.append(el('h2','session-response-heading','Your recent messages'));
    for(const message of messages){
      const item=el('div','reply-message');
      item.append(el('p','session-response',message.text),el('p','field-note',`${usesChannel?channelStatusText(message.status):replyLabels[message.status]||'Unknown delivery status'} · ${new Date(message.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`));
      if(message.status==='queued'){
        if(usesChannel){
          const edit=el('button','secondary','Edit queued message');edit.type='button';edit.disabled=draft.busy;
          edit.addEventListener('click',()=>{draft.text=message.text;draft.editId=message.id;draft.error='';rerender();});item.append(edit);
        }
        const cancel=el('button','secondary','Cancel message');cancel.type='button';cancel.disabled=draft.busy;
        cancel.addEventListener('click',()=>void act('cancel',{id:message.id}));item.append(cancel);
      }
      history.append(item);
    }
    form.append(history);
  }
  return form;
}
