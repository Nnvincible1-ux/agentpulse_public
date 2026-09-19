#!/usr/bin/env python3
"""Explicit mobile follow-ups through the native Stop-hook continuation contract."""
import json
import re
import subprocess
import sys
import time
import unicodedata
import urllib.request
import uuid
from local_connection import load_connection, NoRedirect


# Two hours: long enough to answer from a phone, short enough that a forgotten
# session does not hold its terminal for a working day. install_monitor.py sets
# the Stop hook timeout from this value.
WAIT_SECONDS = 2 * 3600
# The Stop hook blocks the terminal while it waits, and UserPromptSubmit cannot run
# behind it, so the registry can never show the person typing. Recent keyboard or
# mouse use is the only usable signal that they are back at the Mac.
PRESENT_SECONDS = 60
FAST_POLL_SECONDS = 3
SLOW_POLL_SECONDS = 10
FAST_POLL_WINDOW = 60


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


def read_hid_idle():
    return subprocess.check_output(['/usr/sbin/ioreg', '-c', 'IOHIDSystem'], text=True,
                                   stderr=subprocess.DEVNULL, timeout=2)


def idle_seconds(source=read_hid_idle):
    """Seconds since the last keyboard or mouse event, or inf when it cannot be read."""
    for line in source().splitlines():
        if 'HIDIdleTime' in line:
            try:
                return int(line.rsplit('=', 1)[1].strip()) / 1e9
            except (ValueError, IndexError):
                return float('inf')
    return float('inf')


def valid_message(message):
    if not isinstance(message,dict) or not isinstance(message.get('id'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',message['id']):return False
    text=message.get('text')
    return isinstance(text,str) and bool(text.strip()) and len(text.encode('utf-16-le'))//2<=4000 and all(c in '\n\t' or not unicodedata.category(c).startswith('C') for c in text)


def listen(scope, request=transport, output=sys.stdout, current=lambda:True, wait_seconds=WAIT_SECONDS, sleep=time.sleep, clock=time.time, idle=idle_seconds):
    # Wall-clock deadline: a sleeping Mac must not extend the window past what the server accepted.
    started=clock()
    deadline=int((started+wait_seconds)*1000)
    body={**scope,'receiverId':str(uuid.uuid4()),'deadline':deadline}
    while clock()*1000<deadline and current():
        try:
            # Never hold the terminal of someone sitting at the Mac; they can just type.
            if idle()<PRESENT_SECONDS:break
        except Exception:
            pass  # Idle time unreadable: keep the window open rather than dropping follow-ups.
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
        # Answers usually arrive right after the agent stops, so poll closely for a
        # minute and then back off; a full window costs ~740 requests instead of ~2400.
        interval=FAST_POLL_SECONDS if clock()-started<FAST_POLL_WINDOW else SLOW_POLL_SECONDS
        sleep(min(interval,max(0,deadline/1000-clock())))
    output.write('{}\n');output.flush()
