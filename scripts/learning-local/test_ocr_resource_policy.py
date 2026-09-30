"""Offline policy/transform regression; no GPU, SSH, services or third-party deps."""
import ast
import asyncio
import base64
import hashlib
import importlib.util
import io
import json
import pathlib
import tempfile
import time
import types
import unittest
from unittest import mock
import sys
sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
HANDOFF = pathlib.Path('C:/Codex/learning-ocr-handoff/20260921-171314/runtime-copy')

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

policy = load('learning_test_resource_policy', HERE / 'ocr-resource-policy.py')
builder = load('learning_test_resource_builder', HERE / 'build-ocr-resource-patch.py')

def transformed(relative):
    return builder.transform(relative, (HANDOFF / relative).read_text(encoding='utf-8'))

def functions(source, names, namespace):
    tree = ast.parse(source)
    nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    if {n.name for n in nodes} != set(names):
        raise AssertionError('Requested real function missing')
    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<actual transformed functions>', 'exec'), namespace)
    return namespace

class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.p = policy.ResourcePolicy(policy.DEFAULT_POLICY)
    def test_watermark_boundaries_and_hysteresis(self):
        self.assertTrue(self.p.observe(2048, 16384, 0)['accepting'])
        self.assertFalse(self.p.observe(2047, 16000, 1)['accepting'])
        self.assertFalse(self.p.observe(3071, 16000, 2)['accepting'])
        self.assertFalse(self.p.observe(3072, 16000, 3)['accepting'])
        self.assertFalse(self.p.observe(3072, 16000, 12)['accepting'])
        self.assertTrue(self.p.observe(3072, 16000, 13)['accepting'])
    def test_recovery_break_resets_stability(self):
        self.p.observe(2000, 12000, 0)
        self.p.observe(4000, 12000, 1)
        self.p.observe(2500, 12000, 9)
        self.assertFalse(self.p.observe(4000, 12000, 10)['accepting'])
        self.assertFalse(self.p.observe(4000, 12000, 19)['accepting'])
        self.assertTrue(self.p.observe(4000, 12000, 20)['accepting'])
    def test_duplicate_timestamp_cannot_complete_recovery(self):
        self.p.observe(2000, 12000, 0)
        for _ in range(100):
            self.assertFalse(self.p.observe(4000, 12000, 1)['accepting'])
    def test_owned_cap_and_emergency_require_persistence(self):
        self.assertIsNone(self.p.observe(5000, 16385, 0)['hard_stop'])
        self.assertIsNone(self.p.observe(5000, 16384, 9)['hard_stop'])
        self.assertIsNone(self.p.observe(5000, 16385, 10)['hard_stop'])
        self.assertEqual(self.p.observe(5000, 16385, 20)['hard_stop'], 'sustained_owned_gpu_limit')
        other = policy.ResourcePolicy(policy.DEFAULT_POLICY)
        self.assertIsNone(other.observe(1024, 10000, 0)['hard_stop'])
        self.assertIsNone(other.observe(1023, 10000, 1)['hard_stop'])
        self.assertIsNone(other.observe(1023, 10000, 10)['hard_stop'])
        self.assertEqual(other.observe(1023, 10000, 11)['hard_stop'], 'sustained_gpu_emergency')
    def test_long_unobserved_gap_is_not_proof_of_stability(self):
        self.p.observe(2000, 12000, 0)
        self.p.observe(4000, 12000, 1)
        self.assertFalse(self.p.observe(4000, 12000, 100)['accepting'])
        other = policy.ResourcePolicy(policy.DEFAULT_POLICY)
        other.observe(5000, 16385, 0)
        self.assertIsNone(other.observe(5000, 16385, 100)['hard_stop'])
    def test_config_and_samples_reject_invalid_numbers(self):
        for number in [True, -1, '2048', float('nan')]:
            with self.subTest(number=number), self.assertRaises(ValueError):
                self.p.observe(number, 0, 1)
        with self.assertRaises(ValueError):
            policy.validate_policy({**policy.DEFAULT_POLICY, 'pause_free_mib': 4096})
        with self.assertRaises(ValueError):
            policy.validate_policy({**policy.DEFAULT_POLICY, 'retry_after_seconds': True})
    def test_busy_echo_never_expands_unvalidated_unbounded_range(self):
        request = types.SimpleNamespace(request_id='new', document_id='d', sha256='a'*64,
                                        page_range=types.SimpleNamespace(start=1, end=10**12))
        def bounded_range(start, end):
            self.assertLessEqual(end-start, 30, 'Reject path attempted unbounded allocation')
            return range(start, end)
        with mock.patch.dict(policy.unaccepted.__globals__, {'range': bounded_range}):
            reply = policy.unaccepted(request, 'session-1', 'epoch', 'busy', 10)
        self.assertFalse(reply['accepted'])
    def test_epoch_is_root_and_instance_bound(self):
        self.assertNotEqual(policy.service_epoch('root-a','session-1'), policy.service_epoch('root-b','session-1'))
        self.assertNotEqual(policy.service_epoch('root-a','session-1'), policy.service_epoch('root-a','session-2'))

class SnapshotTests(unittest.TestCase):
    def test_snapshot_is_fresh_epoch_bound_and_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix='ocr-policy-test-') as temp:
            out = pathlib.Path(temp)
            self.assertFalse(policy.read_admission(out, 'current', policy.DEFAULT_POLICY, 100)['accepting'])
            state = {'at':100, 'service_epoch':'current', 'accepting':True, 'hard_stop':None, 'draining':False}
            def check(change, expected):
                (out/'resource-state.json').write_text(json.dumps({**state, **change}))
                self.assertEqual(policy.read_admission(out,'current',policy.DEFAULT_POLICY,100)['accepting'], expected)
            check({}, True); check({'at':80}, True); check({'at':79}, False)
            check({'at':101}, False); check({'service_epoch':'old'}, False)
            check({'draining':True}, False); check({'hard_stop':'oom'}, False)
            check({'accepting':'true'}, False)
            (out/'resource-state.json').write_text('{bad')
            self.assertFalse(policy.read_admission(out,'current',policy.DEFAULT_POLICY,100)['accepting'])

class Response(dict):
    def __init__(self, content, status_code=200):
        super().__init__(content); self.status_code = status_code
class FakePage:
    def get_mediabox(self): return [0,0,600,800]
    def get_cropbox(self): return [0,0,600,800]
    def get_rotation(self): return 0
    def get_size(self): return [600,800]
    def close(self): pass
class FakeDocument:
    def __init__(self, _raw=None): pass
    def __len__(self): return 2
    def __getitem__(self, _index): return FakePage()
    @classmethod
    def new(cls): return cls()
    def import_pages(self, _doc, pages): pass
    def save(self, buffer): buffer.write(b'%PDF-1.7 selected synthetic')
    def close(self): pass

class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ocr-admission-test-')
        self.out = pathlib.Path(self.temp.name)
        (self.out/'evidence').mkdir()
        (self.out/'evidence/budget.json').write_text(json.dumps({'pages':31,'http':501,'starts':9}))
        self.raw = b'%PDF-1.7 SYNTHETIC TEST ONLY'
        self.req = types.SimpleNamespace(request_id='new', document_id='doc',
            expected_service_epoch=None,expected_instance=None,
            pdf_base64=base64.b64encode(self.raw).decode(),sha256=hashlib.sha256(self.raw).hexdigest(),
            page_range=types.SimpleNamespace(start=1,end=2))
        self.reserve = mock.Mock(side_effect=AssertionError('Unaccepted request debited'))
        self.ns = {'active':None, 'jobs':{}, 'stopping':False, 'JSONResponse':Response,
                   'OUT':self.out, 'EPOCH':'current', 'RESOURCE':policy.DEFAULT_POLICY,
                   'read_admission':policy.read_admission, 'unaccepted':policy.unaccepted,
                   'budget_admission':policy.budget_admission,'R':self.out,
                   'PLAN':{'budgets':{'pages':None,'http':None,'starts':None},'session_seconds':28800},'profile':{},
                   'ParseRequest':object,'Request':object,'base64':base64,'io':io,
                   'app':types.SimpleNamespace(post=lambda *args,**kwargs:lambda fn:fn,get=lambda *args,**kwargs:lambda fn:fn),
                   'sha':lambda b:hashlib.sha256(b).hexdigest(),
                   'pdfium':types.SimpleNamespace(PdfDocument=FakeDocument), 'reserve':self.reserve}
        functions(transformed('scripts/pdf_service.py'), ['parse_pdf','public','admission','health'], self.ns)
    def tearDown(self): self.temp.cleanup()
    def call(self): return asyncio.run(self.ns['parse_pdf'](self.req, object()))
    def test_missing_or_stale_resource_snapshot_has_no_job_directory_or_debit(self):
        for snapshot in [None, {'at':0,'service_epoch':'current','accepting':True},
                         {'at':time.time(),'service_epoch':'old','accepting':True}]:
            with self.subTest(snapshot=snapshot):
                if snapshot is not None:(self.out/'resource-state.json').write_text(json.dumps(snapshot))
                reply = self.call()
                self.assertEqual(reply.status_code,503);self.assertFalse(reply['accepted'])
                self.assertEqual(reply['request_id'],'new');self.assertEqual(reply['sha256'],self.req.sha256)
                self.assertFalse((self.out/'requests').exists());self.assertEqual(self.ns['jobs'],{})
                self.assertIsNone(self.ns['active']);self.reserve.assert_not_called()
    def test_busy_rejection_does_not_accept_or_debit(self):
        self.ns['active']='other'
        reply=self.call()
        self.assertEqual(reply.status_code,409);self.assertFalse(reply['accepted'])
        self.assertEqual(reply['pages'],[1,2]);self.assertEqual(self.ns['jobs'],{})
        self.assertFalse((self.out/'requests').exists());self.reserve.assert_not_called()
    def test_duplicate_reports_stored_acceptance_before_busy_or_resource_gate(self):
        self.ns['jobs']['new']={'id':'new','status':'processing','document_id':'old-doc','sha256':'b'*64,'pages':[1]}
        self.ns['active']='new'
        reply=self.call()
        self.assertEqual(reply.status_code,409);self.assertTrue(reply['accepted'])
        self.assertEqual(reply['document_id'],'old-doc');self.assertEqual(reply['sha256'],'b'*64)
        self.reserve.assert_not_called();self.assertFalse((self.out/'requests').exists())
    def test_invalid_pdf_does_not_reach_job_creation(self):
        self.req.sha256='0'*64
        reply=self.call()
        self.assertEqual(reply.status_code,422);self.assertEqual(self.ns['jobs'],{})
        self.assertFalse((self.out/'requests').exists());self.reserve.assert_not_called()

    def test_duplicate_cannot_be_reported_unaccepted_by_wrong_expected_epoch(self):
        self.ns['jobs']['new']={'id':'new','status':'processing','document_id':'old-doc','sha256':'b'*64,'pages':[1]}
        self.req.expected_service_epoch='old';self.req.expected_instance='session-1'
        reply=self.call()
        self.assertEqual(reply.status_code,409);self.assertTrue(reply['accepted'])
        self.assertEqual(reply['document_id'],'old-doc');self.reserve.assert_not_called()
    def test_wrong_expected_instance_rejects_new_request_without_mutation(self):
        self.req.expected_service_epoch='old';self.req.expected_instance='session-1'
        reply=self.call()
        self.assertEqual(reply.status_code,409);self.assertFalse(reply['accepted'])
        self.assertEqual(reply['reason'],'instance_changed');self.assertEqual(self.ns['jobs'],{})
        self.assertFalse((self.out/'requests').exists());self.reserve.assert_not_called()
    def test_valid_snapshot_reaches_acceptance_boundary(self):
        # Stop immediately at the real directory creation boundary; never start inference.
        (self.out/'resource-state.json').write_text(json.dumps({'at':time.time(),
            'service_epoch':'current','accepting':True,'draining':False,'hard_stop':None}))
        class AcceptanceBoundary(Exception):pass
        self.ns['uuid']=types.SimpleNamespace(uuid4=mock.Mock(side_effect=AcceptanceBoundary))
        with self.assertRaises(AcceptanceBoundary):self.call()
        self.ns['uuid'].uuid4.assert_called_once();self.reserve.assert_not_called()
    def test_budget_and_session_rejections_match_health_without_jobs_or_debits(self):
        for reason in ['budget_exhausted','session_expired']:
            with self.subTest(reason=reason):
                (self.out/'resource-state.json').write_text(json.dumps({'at':time.time(),
                    'service_epoch':'current','accepting':reason!='session_expired',
                    'draining':reason=='session_expired','hard_stop':None}))
                self.ns['PLAN']['budgets']={'pages':31,'http':None}if reason=='budget_exhausted'else{'pages':None,'http':None}
                before=(self.out/'evidence/budget.json').read_bytes()
                health=asyncio.run(self.ns['health']())
                self.assertTrue(health['ready'])  # Process live does not mean accepting work.
                self.assertEqual(health['admission'],{'accepting':False,'reason':reason})
                reply=self.call();self.assertEqual(reply.status_code,503)
                self.assertFalse(reply['accepted']);self.assertEqual(reply['reason'],reason)
                self.assertEqual(reply['pages'],[1,2]);self.assertEqual(self.ns['jobs'],{})
                self.assertIsNone(self.ns['active']);self.assertFalse((self.out/'requests').exists())
                self.reserve.assert_not_called();self.assertEqual((self.out/'evidence/budget.json').read_bytes(),before)
    def test_request_budget_gate_checks_all_requested_pages_before_acceptance(self):
        (self.out/'resource-state.json').write_text(json.dumps({'at':time.time(),
            'service_epoch':'current','accepting':True,'draining':False,'hard_stop':None}))
        self.ns['PLAN']['budgets']={'pages':32,'http':None}
        self.assertTrue(asyncio.run(self.ns['health']())['admission']['accepting'])
        reply=self.call();self.assertEqual(reply['reason'],'budget_exhausted')
        self.assertFalse(reply['accepted']);self.assertEqual(self.ns['jobs'],{})
        self.assertFalse((self.out/'requests').exists());self.reserve.assert_not_called()
    def test_missing_budget_is_unknown_resource_wait_not_an_exhaustion_claim(self):
        (self.out/'resource-state.json').write_text(json.dumps({'at':time.time(),
            'service_epoch':'current','accepting':True,'draining':False,'hard_stop':None}))
        (self.out/'evidence/budget.json').unlink()
        reply=self.call();self.assertEqual(reply['reason'],'resource_wait')
        self.assertFalse(reply['accepted']);self.assertEqual(self.ns['jobs'],{})
        self.assertFalse((self.out/'requests').exists());self.reserve.assert_not_called()

class BudgetAdmissionTests(unittest.TestCase):
    def test_finite_and_unlimited_admission_are_read_only(self):
        with tempfile.TemporaryDirectory(prefix='ocr-budget-admission-')as temp:
            root=pathlib.Path(temp);(root/'evidence').mkdir();path=root/'evidence/budget.json'
            path.write_text(json.dumps({'pages':30,'http':500,'starts':8}));before=path.read_bytes()
            for caps,required,expected in [({'pages':None,'http':None},30,True),
                ({'pages':30,'http':None},1,False),({'pages':None,'http':500},1,False),
                ({'pages':32,'http':501},2,True),({'pages':31,'http':501},2,False)]:
                with self.subTest(caps=caps,required=required):
                    self.assertEqual(policy.budget_admission(root,caps,required),
                        {'accepting':expected,'reason':None if expected else 'budget_exhausted'})
                    self.assertEqual(path.read_bytes(),before)
            self.assertEqual([p.name for p in(root/'evidence').iterdir()],['budget.json'])
    def test_invalid_or_missing_ledger_and_requirements_fail_closed_without_writes(self):
        with tempfile.TemporaryDirectory(prefix='ocr-budget-invalid-')as temp:
            root=pathlib.Path(temp);caps={'pages':None,'http':None}
            closed={'accepting':False,'reason':'resource_wait'}
            self.assertEqual(policy.budget_admission(root,caps),closed);self.assertEqual(list(root.iterdir()),[])
            (root/'evidence').mkdir();path=root/'evidence/budget.json'
            for raw in ['{bad','[]','null','{}','{"pages":true,"http":0}','{"pages":0,"http":-1}']:
                with self.subTest(raw=raw):
                    path.write_text(raw);before=path.read_bytes()
                    self.assertEqual(policy.budget_admission(root,caps),closed)
                    self.assertEqual(path.read_bytes(),before)
            path.write_text('{"pages":0,"http":0}')
            for required in [0,-1,31,True,'1']:
                with self.subTest(required=required):self.assertEqual(policy.budget_admission(root,caps,required),closed)
            for bad_caps in [{},{'pages':True,'http':None},{'pages':None,'http':-1}]:
                with self.subTest(caps=bad_caps):self.assertEqual(policy.budget_admission(root,bad_caps),closed)
    def test_fresh_session_expiry_is_distinct_from_stale_or_hard_stop(self):
        with tempfile.TemporaryDirectory(prefix='ocr-session-admission-')as temp:
            root=pathlib.Path(temp);path=root/'resource-state.json'
            base={'at':100,'service_epoch':'current','accepting':False,'draining':True,'hard_stop':None}
            for change,reason in [({},'session_expired'),({'at':0},'resource_wait'),
                ({'service_epoch':'old'},'resource_wait'),({'hard_stop':'oom'},'resource_wait')]:
                with self.subTest(change=change):
                    path.write_text(json.dumps({**base,**change}))
                    self.assertEqual(policy.read_admission(root,'current',policy.DEFAULT_POLICY,100),
                        {'accepting':False,'reason':reason})
class LedgerTests(unittest.TestCase):
    def test_unlimited_accounting_passes_old_caps_without_clearing_history(self):
        with tempfile.TemporaryDirectory(prefix='ocr-ledger-test-') as temp:
            root=pathlib.Path(temp);(root/'evidence').mkdir();f=root/'evidence/budget.json'
            f.write_text(json.dumps({'pages':30,'http':500,'starts':8}))
            ns={'R':root,'PLAN':{'budgets':{'pages':None,'http':None,'starts':None}},'pathlib':pathlib,
                'json':json,'time':time,'fcntl':types.SimpleNamespace(LOCK_EX=2,flock=lambda *_:None)}
            functions(transformed('scripts/common.py'),['jdefault','write','event','reserve'],ns)
            self.assertEqual(ns['reserve']('pages'),31);self.assertEqual(ns['reserve']('http'),501)
            self.assertEqual(ns['reserve']('starts'),9)
            self.assertEqual(json.loads(f.read_text()),{'pages':31,'http':501,'starts':9})
            records=[json.loads(line)for line in(root/'evidence/business-ledger.jsonl').read_text().splitlines()]
            self.assertEqual([r['ordinal']for r in records],[31,501,9])
    def test_finite_cap_still_refuses_without_consuming_another_unit(self):
        with tempfile.TemporaryDirectory(prefix='ocr-ledger-test-') as temp:
            root=pathlib.Path(temp);(root/'evidence').mkdir();f=root/'evidence/budget.json'
            f.write_text(json.dumps({'pages':30}))
            ns={'R':root,'PLAN':{'budgets':{'pages':31}},'pathlib':pathlib,'json':json,'time':time,
                'fcntl':types.SimpleNamespace(LOCK_EX=2,flock=lambda *_:None)}
            functions(transformed('scripts/common.py'),['jdefault','write','event','reserve'],ns)
            self.assertEqual(ns['reserve']('pages'),31)
            ledger=(root/'evidence/business-ledger.jsonl').read_bytes()
            with self.assertRaises(AssertionError): ns['reserve']('pages')
            self.assertEqual(json.loads(f.read_text())['pages'],31)
            self.assertEqual((root/'evidence/business-ledger.jsonl').read_bytes(),ledger)

class MonitorTests(unittest.TestCase):
    def test_discovery_fences_reused_pid_by_birth_time(self):
        class Process:
            def __init__(self,pid=None):self.pid=pid
            def children(self,recursive=True):return []
            def create_time(self):return {10:100,11:999}[self.pid]
            def status(self):return 'running'
        ps=types.SimpleNamespace(Process=Process,Error=Exception,STATUS_ZOMBIE='zombie',process_iter=lambda _keys:[])
        ns={'tracked':{10:100,11:101},'children':[],'psutil':ps,'os':types.SimpleNamespace()}
        functions(transformed('scripts/trial_session.py'),['discover'],ns)
        self.assertEqual([p.pid for p in ns['discover']()],[10])
    def test_monitor_has_bounded_memory_full_disk_log_and_only_live_identity_accounting(self):
        with tempfile.TemporaryDirectory(prefix='ocr-monitor-test-') as temp:
            out=pathlib.Path(temp);clock=[0]
            live=types.SimpleNamespace(pid=10,memory_info=lambda:types.SimpleNamespace(rss=100))
            ns={'OUT':out,'stage':'ready_waiting_for_bounded_requests','samples':[],'peak_gpu':0,'peak_rss':0,
                'observed_ports':set(),'draining':False,'tracked':{10:100,11:101},'epoch':'current',
                'discover':lambda:[live],
                'gpu':lambda:([{'pid':10,'uuid':'gpu','mib':10000 if clock[0]==0 else 1000},
                                {'pid':11,'uuid':'gpu','mib':999999}],4000),
                'gpu_identity':lambda:({'uuid':'gpu'},[]),'network_snapshot':lambda _:[{'port':46237}],
                'policy':policy.ResourcePolicy(policy.DEFAULT_POLICY),'P':{'gpu_uuid':'gpu','max_tree_rss_bytes':10000},
                'StopTrial':RuntimeError,'psutil':types.SimpleNamespace(Error=Exception),'json':json,
                'start':0,'time':types.SimpleNamespace(time=lambda:1000+clock[0],monotonic=lambda:clock[0])}
            functions(transformed('scripts/trial_session.py'),['monitor'],ns)
            for i in range(100):clock[0]=i;self.assertEqual([r['pid']for r in ns['monitor']()],[10])
            self.assertLessEqual(len(ns['samples']),32)
            self.assertEqual(ns['peak_gpu'],10000);self.assertEqual(ns['peak_rss'],100)
            self.assertEqual(len((out/'resources.jsonl').read_text().splitlines()),100)
            self.assertEqual(ns['observed_ports'],{46237})
            self.assertTrue(json.loads((out/'resource-state.json').read_text())['accepting'])
    def test_monitor_draining_rejects_new_work_but_keeps_resource_monitor_alive(self):
        # Execute the same real monitor under its draining flag; no child/GPU access.
        source=transformed('scripts/trial_session.py')
        self.assertIsInstance(ast.parse(source),ast.Module)
        with tempfile.TemporaryDirectory(prefix='ocr-drain-test-') as temp:
            ns={'OUT':pathlib.Path(temp),'stage':'ready_waiting_for_bounded_requests','samples':[],
                'peak_gpu':0,'peak_rss':0,'observed_ports':set(),'draining':True,'tracked':{},'epoch':'current',
                'discover':lambda:[],'gpu':lambda:([],4000),'gpu_identity':lambda:({},[]),
                'network_snapshot':lambda _:[],'policy':policy.ResourcePolicy(policy.DEFAULT_POLICY),
                'P':{'gpu_uuid':'gpu','max_tree_rss_bytes':10000},'StopTrial':RuntimeError,
                'psutil':types.SimpleNamespace(Error=Exception),'json':json,'start':0,'time':time}
            functions(source,['monitor'],ns);self.assertEqual(ns['monitor'](),[])
            state=json.loads((ns['OUT']/'resource-state.json').read_text())
            self.assertFalse(state['accepting']);self.assertTrue(state['draining'])

class CleanupTests(unittest.TestCase):
    def test_gpu_residue_is_retained_until_clear_but_reused_pid_is_excluded(self):
        class Gone(Exception):pass
        class Denied(Exception):pass
        for identity,expected in [('gone',False),('denied',False),(100,False),(999,True)]:
            with self.subTest(identity=identity):
                def process(_pid):
                    if identity=='gone':raise Gone()
                    if identity=='denied':raise Denied()
                    return types.SimpleNamespace(create_time=lambda:identity)
                ps=types.SimpleNamespace(Process=process,NoSuchProcess=Gone,AccessDenied=Denied,
                    Error=Exception,net_connections=lambda **_:[],CONN_LISTEN='LISTEN')
                ns={'tracked':{10:100},'children':[],'discover':lambda:[],
                    'gpu':mock.Mock(return_value=([{'pid':10,'mib':1024}],5000)),
                    'psutil':ps,'signal':types.SimpleNamespace(SIGINT=2,SIGTERM=15,SIGHUP=1,
                        SIGKILL=9,SIG_IGN=0,signal=mock.Mock()),
                    'time':types.SimpleNamespace(monotonic=lambda:0,sleep=mock.Mock()),
                    'PORT':46237,'ENDPOINT':{'pdf_port':46238},'observed_ports':set(),
                    'summary':{},'subprocess':types.SimpleNamespace(TimeoutExpired=TimeoutError)}
                functions(transformed('scripts/trial_session.py'),['stop_all'],ns);ns['stop_all']()
                self.assertEqual(ns['summary']['cleanup_verified'],expected)
                self.assertEqual(len(ns['summary']['remaining_gpu']),0 if expected else 1)
                self.assertEqual(ns['gpu'].call_count,1 if expected else 10)

class DrainTests(unittest.TestCase):
    def test_expiry_stops_acceptance_then_waits_for_processing_jobs(self):
        # Execute the actual transformed deadline branch inside a bounded loop.
        tree=ast.parse(transformed('scripts/trial_session.py'))
        candidates=[node for node in ast.walk(tree) if isinstance(node,ast.If)
            and any(isinstance(child,ast.Assign) and any(isinstance(t,ast.Name)and t.id=='draining'
                for t in child.targets) for child in node.body)]
        self.assertEqual(len(candidates),1)
        program=ast.Module(body=[ast.While(test=ast.Constant(value=True),
            body=[candidates[0],ast.Break()],orelse=[])],type_ignores=[])
        code=compile(ast.fix_missing_locations(program),'<actual transformed drain branch>','exec')
        for state,now,stop,raises in [(None,11,True,False),('completed',11,True,False),
                ('processing',11,False,False),('corrupt',11,False,False),('processing',1811,False,True)]:
            with self.subTest(state=state,now=now),tempfile.TemporaryDirectory(prefix='ocr-drain-branch-')as temp:
                out=pathlib.Path(temp)
                if state is not None:
                    path=out/'requests/one/status.json';path.parent.mkdir(parents=True)
                    path.write_text('{bad'if state=='corrupt'else json.dumps({'status':state}))
                ns={'time':types.SimpleNamespace(monotonic=lambda:now),'deadline':10,
                    'draining':False,'monitor':mock.Mock(),'OUT':out,'json':json,
                    'P':{'drain_timeout_seconds':1800},'summary':{},'StopTrial':RuntimeError}
                if raises:
                    with self.assertRaisesRegex(RuntimeError,'session_drain_timeout'):exec(code,ns)
                else:exec(code,ns)
                self.assertTrue(ns['draining']);ns['monitor'].assert_called_once()
                self.assertEqual('requested_stop'in ns['summary'],stop)
    def test_none_deadline_continues_beyond_one_hour_eight_hours_and_days(self):
        # Execute the actual transformed deadline initializer and expiry branch.
        # This is bounded offline control-flow validation, not an elapsed-days claim.
        tree=ast.parse(transformed('scripts/trial_session.py'))
        initializers=[node for node in ast.walk(tree) if isinstance(node,ast.Assign)
            and isinstance(node.value,ast.IfExp)
            and any(isinstance(t,ast.Name)and t.id=='deadline'for t in node.targets)]
        expiries=[node for node in ast.walk(tree) if isinstance(node,ast.If)
            and any(isinstance(child,ast.Assign) and any(isinstance(t,ast.Name)and t.id=='draining'
                for t in child.targets) for child in node.body)]
        self.assertEqual(len(initializers),1);self.assertEqual(len(expiries),1)
        initialize=compile(ast.fix_missing_locations(ast.Module(body=initializers,type_ignores=[])),
            '<actual transformed deadline initializer>','exec')
        loop=ast.For(target=ast.Name(id='now',ctx=ast.Store()),
            iter=ast.Name(id='check_times',ctx=ast.Load()),body=[expiries[0],
                ast.AugAssign(target=ast.Name(id='completed_checks',ctx=ast.Store()),
                    op=ast.Add(),value=ast.Constant(value=1))],orelse=[])
        check=compile(ast.fix_missing_locations(ast.Module(body=[loop],type_ignores=[])),
            '<actual transformed unbounded lifetime branch>','exec')
        ns={'now':100,'P':{'session_seconds':None,'drain_timeout_seconds':1800},
            'monitor':mock.Mock(),'draining':False,'summary':{},'StopTrial':RuntimeError,
            'check_times':[3701,28901,7*24*3600+100],'completed_checks':0}
        ns['time']=types.SimpleNamespace(monotonic=lambda:ns['now'])
        exec(initialize,ns);self.assertIsNone(ns['deadline'])
        exec(check,ns)
        self.assertEqual(ns['completed_checks'],3);self.assertFalse(ns['draining'])
        self.assertEqual(ns['summary'],{});ns['monitor'].assert_not_called()
        # Explicit finite configuration still sets a real deadline; the existing
        # drain test covers its in-flight and timeout behavior.
        ns['now']=100;ns['P']['session_seconds']=28800
        exec(initialize,ns);self.assertEqual(ns['deadline'],28900)
class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='ocr-install-fixture-')
        self.parent=pathlib.Path(self.temp.name).resolve()
        self.source=self.parent/'old-runtime';self.bundle=self.parent/'reviewed-bundle'
        self.destination=self.parent/'core-learning-runtime-test'
        for folder in ['scripts','configs','adapter','evidence','private','cache']:
            (self.source/folder).mkdir(parents=True)
        (self.bundle/'scripts').mkdir(parents=True)
        # These tiny files are installer-only synthetic data, never OCR service fixtures.
        self.original=self.source/'scripts/service.py';self.original.write_bytes(b'original offline fixture')
        (self.source/'configs/endpoint.json').write_text('{}')
        (self.source/'adapter/example.py').write_text('# synthetic adapter')
        (self.source/'private/api-key').write_text('SYNTHETIC-NOT-A-CREDENTIAL')
        (self.source/'evidence/frozen-plan.json').write_text(json.dumps({'budgets':{'pages':30,'http':500},
            'minimum_free_mib':8192,'max_combined_gpu_mib':14336,'preflight_free_mib':18000,'gpu_uuid':'synthetic-gpu'}))
        (self.source/'evidence/adapter-source.json').write_text('{}')
        for name,data in [('budget.json','{"starts":8,"pages":30,"http":500}'),
                          ('start-attempts.jsonl','{"old":true}\n'),('business-ledger.jsonl','{"ordinal":500}\n')]:
            (self.source/'evidence'/name).write_text(data)
        integrity={'revision':'frozen-original','files':[{'path':str(self.original),
            'sha256':hashlib.sha256(self.original.read_bytes()).hexdigest()}]}
        (self.source/'evidence/launch-integrity.json').write_text(json.dumps(integrity))
        self.before={p.relative_to(self.source):p.read_bytes() for p in self.source.rglob('*')if p.is_file()}
        self.patch=self.bundle/'scripts/service.py';self.patch.write_bytes(b'reviewed offline fixture')
        manifest={'version':'learning-ocr-resource-v1','base_runtime_hashes':{'scripts/service.py':integrity['files'][0]['sha256']},
            'patches':{'scripts/service.py':{'sha256':hashlib.sha256(self.patch.read_bytes()).hexdigest()}},
            'plan_changes':{'budgets':{'starts':None,'pages':None,'http':None},'resource_policy':policy.DEFAULT_POLICY,
                'session_seconds':28800,'drain_timeout_seconds':1800}}
        path=self.bundle/'patch-manifest.json';path.write_text(json.dumps(manifest))
        self.manifest_sha=hashlib.sha256(path.read_bytes()).hexdigest()
        self.installer=load('learning_test_installer',HERE/'install-ocr-resource-patch.py')
    def tearDown(self):self.temp.cleanup()
    def run_install(self):
        # Windows junction/symlink privileges are outside this unit test; only this
        # one filesystem operation is stubbed. Copy/hash/receipts run unchanged.
        def cache_link(path,target,target_is_directory=False):
            self.assertEqual(path,self.destination/'cache');self.assertEqual(target,self.source/'cache')
            self.assertTrue(target_is_directory);path.mkdir()
        with mock.patch.object(self.installer,'APPROVED_PARENT',self.parent),mock.patch.object(pathlib.Path,'symlink_to',cache_link):
            return self.installer.install(self.source,self.destination,self.bundle,self.manifest_sha,
                'SYNTHETIC local fixture authorization only; no service operation')
    def assert_old_unchanged(self):
        self.assertEqual({p.relative_to(self.source):p.read_bytes()for p in self.source.rglob('*')if p.is_file()},self.before)
    def test_new_runtime_install_is_integrity_checked_and_does_not_copy_private_key(self):
        result=self.run_install();self.assertEqual(result['integrity'],'PASS')
        self.assertFalse(result['started']);self.assertTrue(result['old_evidence_unchanged'])
        self.assertFalse((self.destination/'private/api-key').exists())
        self.assertEqual((self.destination/'scripts/service.py').read_bytes(),self.patch.read_bytes())
        self.assertEqual(json.loads((self.destination/'evidence/budget.json').read_text()),{'starts':0,'pages':0,'http':0})
        self.assert_old_unchanged()
    def test_new_runtime_retains_parent_ledger_evidence_and_all_integrity_anchors(self):
        self.run_install();self.assert_old_unchanged()
        receipt=json.loads((self.destination/'evidence/runtime-authorization.json').read_text())
        for name in ['budget.json','start-attempts.jsonl','business-ledger.jsonl','launch-integrity.json']:
            self.assertEqual(receipt['old_ledger_sha256'][name],hashlib.sha256(self.before[pathlib.Path('evidence')/name]).hexdigest())
        entries=json.loads((self.destination/'evidence/launch-integrity.json').read_text())['files']
        self.assertIn(str(self.original),[e['path']for e in entries])
        for entry in entries:self.assertEqual(hashlib.sha256(pathlib.Path(entry['path']).read_bytes()).hexdigest(),entry['sha256'])
    def test_repeated_install_is_rejected_without_resetting_new_or_old_history(self):
        self.run_install();budget=self.destination/'evidence/budget.json';budget.write_text('{"pages":31,"http":501}')
        with self.assertRaisesRegex(ValueError,'already exists'):self.run_install()
        self.assertEqual(budget.read_text(),'{"pages":31,"http":501}');self.assert_old_unchanged()
    def test_changed_source_hash_is_rejected_before_destination_creation(self):
        self.original.write_bytes(b'changed');
        with self.assertRaisesRegex(ValueError,'Original runtime differs'):self.run_install()
        self.assertFalse(self.destination.exists())
    def test_changed_patch_hash_is_rejected_before_destination_creation(self):
        self.patch.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'Patch checksum differs'):self.run_install()
        self.assertFalse(self.destination.exists());self.assert_old_unchanged()
class TransformTests(unittest.TestCase):
    def test_all_three_actual_transforms_compile_and_anchor_drift_is_refused(self):
        for relative in ['scripts/common.py','scripts/trial_session.py','scripts/pdf_service.py']:
            with self.subTest(relative=relative):
                compile(transformed(relative),relative,'exec')
        original=(HANDOFF/'scripts/common.py').read_text()
        with self.assertRaises(ValueError):builder.transform('scripts/common.py',original.replace("assert v[kind]<PLAN['budgets'][kind]",'assert False'))

if __name__=='__main__': unittest.main(verbosity=2)
