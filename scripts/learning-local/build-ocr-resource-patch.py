"""Build an offline patch bundle from the byte-verified OCR handoff.
No SSH, service start, handoff overwrite, or ledger reset. Installation into a
NEW remote runtime requires separate explicit authorization.
"""
import argparse
import ast
import hashlib
import importlib.util
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
SERVICE_SHA = "5b9bc6eccde6b3c595c7b3269635422252159186c28364abae251b7142261453"

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def replace_once(source, before, after):
    if source.count(before) != 1:
        raise ValueError("Delivered patch anchor differs: " + before[:90])
    return source.replace(before, after, 1)

def transform(relative, source):
    def change(before, after):
        nonlocal source
        source = replace_once(source, before, after)
    if relative == "scripts/common.py":
        change("  assert v[kind]<PLAN['budgets'][kind],kind+' budget exhausted'",
               "  cap=PLAN['budgets'][kind]\n  assert cap is None or v[kind]<cap,kind+' budget exhausted'")
    elif relative == "scripts/trial_session.py":
        change("import pathlib,os,sys,json,time,signal,subprocess,socket,fcntl,urllib.request,urllib.error,psutil",
               "import pathlib,os,sys,json,time,signal,subprocess,socket,fcntl,urllib.request,urllib.error,psutil\nfrom resource_policy import ResourcePolicy,service_epoch")
        change("assert (len(attempt_file.read_text().splitlines()) if attempt_file.exists() else 0)<8",
               "start_cap=P['budgets']['starts']\nassert start_cap is None or (len(attempt_file.read_text().splitlines()) if attempt_file.exists() else 0)<start_cap")
        change("tracked={};children=[];samples=[];start=time.monotonic();stage='preflight';reason=None;server=None;mapping=None",
               "tracked={};children=[];samples=[];start=time.monotonic();stage='preflight';reason=None;server=None;mapping=None\npolicy=ResourcePolicy(P['resource_policy']);epoch=service_epoch(R,OUT)\npeak_gpu=0;peak_rss=0;observed_ports=set();draining=False")
        change("def monitor():", "def monitor():\n global peak_gpu,peak_rss")
        change(" live=discover();rows,free=gpu();own=[x for x in rows if x['pid'] in tracked]",
               " live=discover();rows,free=gpu();live_ids={x.pid for x in live};own=[x for x in rows if x['pid'] in live_ids]")
        change(" samples.append(rec)",
               " samples.append(rec)\n if len(samples)>32:del samples[:-32]\n peak_gpu=max(peak_gpu,sum(x['mib'] or 0 for x in own));peak_rss=max(peak_rss,rss)\n observed_ports.update(x['port'] for x in listeners)")
        change(" if sum(x['mib'] for x in own)>P['max_combined_gpu_mib']:raise StopTrial('combined_gpu_above_14GiB')\n if free<P['minimum_free_mib']:raise StopTrial('shared_free_below_8GiB')",
               " state=policy.observe(free,sum(x['mib'] for x in own),time.monotonic())\n state.update(at=time.time(),service_epoch=epoch,instance=OUT.name,draining=draining)\n if draining:state['accepting']=False\n tmp=OUT/'resource-state.json.new';tmp.write_text(json.dumps(state));tmp.replace(OUT/'resource-state.json')\n if state['hard_stop']:raise StopTrial(state['hard_stop'])")
        change("  remain=[x for x in rows if x['pid'] in tracked]",
               "  def still_owned(pid):\n   if pid not in tracked:return False\n   try:return psutil.Process(pid).create_time()==tracked[pid]\n   except psutil.NoSuchProcess:return True\n   except psutil.AccessDenied:return True\n  remain=[x for x in rows if still_owned(x['pid'])]")
        change(" ports={PORT,ENDPOINT['pdf_port']}|{x['port'] for row in samples for x in row.get('listeners',[])}",
               " ports={PORT,ENDPOINT['pdf_port']}|observed_ports")
        change(" from common import verify", " from common import verify,reserve")
        change(" if free<P['preflight_free_mib']:raise StopTrial('preflight_free_below_18000')",
               " if free<policy.config['startup_free_mib']:raise StopTrial('startup_resource_insufficient')")
        change(" with (R/'evidence/start-attempts.jsonl').open('a') as f:f.write(json.dumps({'number':number,'at':time.time(),'command':cmd})+'\\n')",
               " reserve('starts',instance=OUT.name)\n with (R/'evidence/start-attempts.jsonl').open('a') as f:f.write(json.dumps({'number':number,'at':time.time(),'command':cmd})+'\\n')")
        change(" deadline=time.monotonic()+3600", " deadline=None if P['session_seconds'] is None else time.monotonic()+P['session_seconds']")
        change("  if time.monotonic()>deadline:raise StopTrial('one_hour_service_bound')",
               "  if deadline is not None and time.monotonic()>deadline:\n   draining=True\n   monitor()\n   active_jobs=[]\n   for status_file in (OUT/'requests').glob('*/status.json'):\n    try:active_jobs.append(json.loads(status_file.read_text()).get('status')=='processing')\n    except (OSError,ValueError):active_jobs.append(True)\n   if not any(active_jobs):summary['requested_stop']={'reason':'session_lifetime_reached'};break\n   if time.monotonic()>deadline+P['drain_timeout_seconds']:raise StopTrial('session_drain_timeout')")
        change("  peak_combined_gpu_mib=max((sum(x['mib'] or 0 for x in s['own_gpu']) for s in samples),default=0),\n  peak_rss_bytes=max((s['rss_bytes'] for s in samples),default=0))",
               "  peak_combined_gpu_mib=peak_gpu,peak_rss_bytes=peak_rss)")
    elif relative == "scripts/pdf_service.py":
        change("from common import *",
               "from common import *\nfrom resource_policy import read_admission,service_epoch,unaccepted,budget_admission")
        change(" request_id:str=Field(pattern=r'^[A-Za-z0-9_-]{1,64}$')", " request_id:str=Field(pattern=r'^[A-Za-z0-9_-]{1,64}$')\n expected_service_epoch:str|None=Field(default=None,pattern=r'^[a-f0-9]{64}$')\n expected_instance:str|None=Field(default=None,pattern=r'^session-[1-9][0-9]*$')")
        change(" if stopping:return JSONResponse({'error':'instance_stopping'},status_code=503)", " if stopping:return JSONResponse({'error':'instance_stopping'},status_code=503)\n if req.request_id in jobs:return JSONResponse({'error':'request_id_already_used','accepted':True,**public(jobs[req.request_id])},status_code=409)\n if (req.expected_service_epoch is None)!=(req.expected_instance is None):return JSONResponse({'error':'invalid_instance_binding'},status_code=422)\n if req.expected_service_epoch is not None and (req.expected_service_epoch!=EPOCH or req.expected_instance!=OUT.name):return JSONResponse(unaccepted(req,OUT.name,EPOCH,'instance_changed',RESOURCE['retry_after_seconds']),status_code=409)")
        change("OUT=pathlib.Path(os.environ['OCR_INSTANCE_DIR'])",
               "OUT=pathlib.Path(os.environ['OCR_INSTANCE_DIR'])\nEPOCH=service_epoch(R,OUT)\nRESOURCE=PLAN['resource_policy']")
        change(" return {k:j[k] for k in ['id','status','document_id','sha256','pages','current_page','completed_pages','inflight','vl_calls','cancelled','publishable'] if k in j}",
               " return {**{k:j[k] for k in ['id','status','document_id','sha256','pages','current_page','completed_pages','inflight','vl_calls','cancelled','publishable'] if k in j},'request_id':j['id'],'instance':OUT.name,'service_epoch':EPOCH}")
        change("  'instance':OUT.name,'native_vlm':False,'automatic_retries':0}",
               "  'instance':OUT.name,'service_epoch':EPOCH,'native_vlm':False,'automatic_retries':0,\n  'admission':admission(),'resource_policy_version':RESOURCE['version'],\n  'runtime_budget':PLAN['budgets'],'session_seconds':PLAN['session_seconds']}")
        change("@app.get('/health')", "def admission(required_pages=1):\n state=read_admission(OUT,EPOCH,RESOURCE)\n return budget_admission(R,PLAN['budgets'],required_pages) if state['accepting'] else state\n\n@app.get('/health')")
        change("@app.delete('/requests/{rid}')",
               "@app.get('/requests/{rid}/result')\nasync def request_result(rid:str):\n if rid not in jobs:return JSONResponse({'error':'not_found'},status_code=404)\n j=jobs[rid]\n if j['status']!='completed':return JSONResponse(public(j),status_code=409)\n result=j['dir']/'response.json'\n if not result.exists():return JSONResponse({'error':'result_unavailable',**public(j)},status_code=409)\n return json.loads(result.read_text())\n\n@app.delete('/requests/{rid}')")
        change(" return {'service_version':'ocr-pdf-trial-0.1','request_id':j['id'],'status':'completed','publishable':True,",
               " return {'service_version':'ocr-pdf-trial-0.1','request_id':j['id'],'status':'completed','publishable':True,\n  'instance':OUT.name,'service_epoch':EPOCH,")
        change(" if active is not None:return JSONResponse({'error':'busy','automatic_queue':False},status_code=409)\n if req.request_id in jobs:return JSONResponse({'error':'request_id_already_used'},status_code=409)",
               " if active is not None:return JSONResponse(unaccepted(req,OUT.name,EPOCH,'busy',RESOURCE['retry_after_seconds']),status_code=409)")
        change(" d=OUT/'requests'/uuid.uuid4().hex;d.mkdir(parents=True)",
               " # Fresh gate after validation, before directory/job/ledger creation.\n gate=admission(len(physical))\n if not gate['accepting']:return JSONResponse(unaccepted(req,OUT.name,EPOCH,gate['reason'],RESOURCE['retry_after_seconds']),status_code=503)\n d=OUT/'requests'/uuid.uuid4().hex;d.mkdir(parents=True)")
    else:
        raise ValueError("Unknown patch target")
    ast.parse(source, filename=relative)
    return source

def build(handoff, output):
    if output.exists():
        raise ValueError("Output already exists; preserve prior evidence")
    if sha((handoff / "service-handoff.json").read_bytes()) != SERVICE_SHA:
        raise ValueError("Handoff identity differs")
    manifest = json.loads((handoff / "file-manifest.json").read_bytes())
    for entry in manifest["files"]:
        file = (handoff / entry["path"]).resolve()
        if not file.is_relative_to(handoff.resolve()):
            raise ValueError("Handoff path escaped")
        raw = file.read_bytes()
        if len(raw) != entry["bytes"] or sha(raw) != entry["sha256"]:
            raise ValueError("Handoff bytes differ: " + entry["path"])
    patches = {}
    for relative in ["scripts/common.py", "scripts/trial_session.py", "scripts/pdf_service.py"]:
        original = (handoff / "runtime-copy" / relative).read_bytes()
        updated = transform(relative, original.decode().replace("\r\n", "\n")).encode()
        patches[relative] = {"original_sha256": sha(original), "sha256": sha(updated), "bytes": updated}
    policy = (HERE / "ocr-resource-policy.py").read_bytes()
    patches["scripts/resource_policy.py"] = {"original_sha256": None, "sha256": sha(policy), "bytes": policy}
    spec = importlib.util.spec_from_file_location("resource_policy", HERE / "ocr-resource-policy.py")
    module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    expected = {e["path"].removeprefix("runtime-copy/"): e["sha256"] for e in manifest["files"] if e["path"].startswith("runtime-copy/")}
    output.mkdir(parents=True)
    for relative, entry in patches.items():
        file = output / relative;file.parent.mkdir(exist_ok=True, parents=True);file.write_bytes(entry["bytes"])
    receipt = {
        "version": "learning-ocr-resource-v1", "handoff_sha256": SERVICE_SHA,
        "verified_handoff_files": len(manifest["files"]) + 1,
        "base_runtime_hashes": expected,
        "patches": {k: {f: v for f, v in e.items() if f != "bytes"} for k, e in patches.items()},
        "plan_changes": {"budgets": {"starts": None, "pages": None, "http": None},
                         "resource_policy": module.DEFAULT_POLICY, "session_seconds": None,
                         "drain_timeout_seconds": 1800},
        "limits_retained": "Single GPU UUID; single instance/request; model/config/dependency hashes; per-page region/per-request limits; no automatic engine restart",
        "scope": "OFFLINE PATCH ONLY; separate server authorization required; candidate thresholds have not been validated on GPU",
    }
    (output / "patch-manifest.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    return {"output": str(output), "verified_handoff_files": receipt["verified_handoff_files"], "patch_files": len(patches), "remote_actions": 0}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--handoff", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.handoff, args.output)))
