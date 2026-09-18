import io
import json
import unittest
from mobile_replies import listen

class MobileRepliesTests(unittest.TestCase):
    def test_explicit_message_continues_same_stop_and_acknowledges_only_after_output(self):
        output=io.StringIO();calls=[]
        def request(action,body):
            calls.append(action)
            if action=='poll':return {'status':'message','message':{'id':'message-1','text':'Pusha kontosidorna också.'}}
            self.assertEqual(json.loads(output.getvalue())['decision'],'block')
            return {'ok':True}
        listen({'machineId':'mac','sessionId':'session','eventId':'turn'},request,output,lambda:True,wait_seconds=1)
        self.assertIn('Pusha kontosidorna också.',json.loads(output.getvalue())['reason'])
        self.assertEqual(calls,['poll','ack'])
    def test_closed_receiver_and_network_failure_never_continue_or_ack(self):
        for result in [{'status':'closed','reason':'cancelled'},{'status':'closed','reason':'delivered'},{'status':'closed'},{'status':'message','message':{'id':'x','text':'\x1bBAD'}}]:
            output=io.StringIO();calls=[]
            def request(action,body):calls.append(action);return result
            listen({'machineId':'mac','sessionId':'s','eventId':'e'},request,output,lambda:True,wait_seconds=1)
            self.assertEqual(json.loads(output.getvalue()),{})
            self.assertEqual(calls,['poll'])
        output=io.StringIO()
        def fail(*args):raise OSError('private server error')
        listen({},fail,output,lambda:True,wait_seconds=1,sleep=lambda seconds:None)
        self.assertEqual(json.loads(output.getvalue()),{})
    def test_changed_turn_cannot_receive_stale_mobile_message(self):
        output=io.StringIO();checks=iter([True,False]);calls=[]
        def request(action,body):calls.append(action);return {'status':'message','message':{'id':'x','text':'Do it'}}
        listen({},request,output,lambda:next(checks),wait_seconds=1)
        self.assertEqual(json.loads(output.getvalue()),{})
        self.assertEqual(calls,['poll'])
    def test_ack_failure_does_not_emit_a_second_or_empty_decision(self):
        output=io.StringIO()
        def request(action,body):
            if action=='ack':raise OSError('lost ack')
            return {'status':'message','message':{'id':'x','text':'Go'}}
        listen({},request,output,lambda:True,wait_seconds=1)
        self.assertEqual(len(output.getvalue().splitlines()),1)
        self.assertEqual(json.loads(output.getvalue())['decision'],'block')

    def test_lost_heartbeat_reopens_the_same_turn_with_a_fresh_receiver(self):
        output=io.StringIO();bodies=[]
        results=iter([{'status':'waiting'},OSError('mac asleep'),{'status':'closed','reason':'expired'},{'status':'waiting'},
                      {'status':'message','message':{'id':'m','text':'After wake'}}])
        def request(action,body):
            bodies.append((action,dict(body)))
            result=next(results) if action=='poll' else {'ok':True}
            if isinstance(result,Exception):raise result
            return result
        listen({'machineId':'mac','sessionId':'s','eventId':'e'},request,output,lambda:True,wait_seconds=30,sleep=lambda seconds:None)
        self.assertIn('After wake',json.loads(output.getvalue())['reason'])
        polls=[b for a,b in bodies if a=='poll']
        self.assertEqual(len(polls),5)
        self.assertEqual(polls[0]['receiverId'],polls[2]['receiverId'])
        self.assertNotEqual(polls[2]['receiverId'],polls[3]['receiverId'])
        self.assertEqual(polls[0]['deadline'],polls[3]['deadline'])
        self.assertEqual(bodies[-1][1]['receiverId'],polls[3]['receiverId'])

    def test_repeated_failures_keep_waiting_until_the_turn_or_deadline_ends(self):
        output=io.StringIO();checks=iter([True]*6+[False]);calls=[]
        def fail(action,body):calls.append(action);raise OSError('offline')
        listen({},fail,output,lambda:next(checks),wait_seconds=60,sleep=lambda seconds:None)
        self.assertEqual(json.loads(output.getvalue()),{})
        self.assertEqual(len(calls),6)

    def test_no_message_never_creates_an_automatic_continuation(self):
        output=io.StringIO()
        listen({},lambda *args: self.fail('No polling after expiry'),output,wait_seconds=0)
        self.assertEqual(json.loads(output.getvalue()),{})
