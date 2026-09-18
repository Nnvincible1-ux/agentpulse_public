#!/usr/bin/env python3
"""Explicit mobile follow-ups through the native Stop-hook continuation contract."""
import json
import re
import sys
import time
import unicodedata
import urllib.request
import uuid
from local_connection import load_connection, NoRedirect


def transport(action, body):
    connection=load_connection()
    request=urllib.request.Request(connection['AGENTPULSE_SERVER']+'/api/bridge/replies/'+action,
        data=json.dumps(body).encode(),method='POST',headers={
            'Authorization':'Bearer '+connection['AGENTPULSE_BRIDGE_TOKEN'],'Content-Type':'application/json'})
    with urllib.request.build_opener(NoRedirect).open(request,timeout=8) as response:
        raw=response.read(32769)
        if len(raw)>32768:raise ValueError('Invalid response')
        result=json.loads(raw)
        if not isinstance(result,dict):raise ValueError('Invalid response')
        return result


def valid_message(message):
    if not isinstance(message,dict) or not isinstance(message.get('id'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',message['id']):return False
    text=message.get('text')
    return isinstance(text,str) and bool(text.strip()) and len(text.encode('utf-16-le'))//2<=4000 and all(c in '\n\t' or not unicodedata.category(c).startswith('C') for c in text)


def listen(scope, request=transport, output=sys.stdout, current=lambda:True, wait_seconds=8*3600, sleep=time.sleep, clock=time.time):
    # Wall-clock deadline: a sleeping Mac must not extend the window past what the server accepted.
    deadline=int((clock()+wait_seconds)*1000)
    body={**scope,'receiverId':str(uuid.uuid4()),'deadline':deadline}
    while clock()*1000<deadline and current():
        try:
            result=request('poll',body)
            if result.get('status')=='message':
                message=result.get('message')
                if not valid_message(message) or not current():break
                # Write exactly once. A failed acknowledgement must never duplicate the prompt.
                output.write(json.dumps({'decision':'block','reason':
                    'The user explicitly sent this follow-up to this session through AgentPulse:\n\n'+message['text']},ensure_ascii=False)+'\n')
                output.flush()
                try:request('ack',{**body,'id':message['id']})
                except Exception:pass
                return
            if result.get('status')=='closed' and result.get('reason')=='expired':
                # Heartbeat lost (for example the Mac slept). The turn is unchanged, so reopen it with a fresh window;
                # any message queued for the old window stays expired and is never replayed.
                body={**body,'receiverId':str(uuid.uuid4())}
            elif result.get('status')!='waiting':break
        except Exception:
            pass  # Transient outage: keep waiting while the turn is current and the deadline holds.
        sleep(min(3,max(0,deadline/1000-clock())))
    output.write('{}\n');output.flush()
