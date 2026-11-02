import {test,expect} from "@playwright/test";
import {mkdtempSync,rmSync,mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {openWorkReviewDatabase} from "@/lib/server/work-review/db";
import {seedWorkAgentCase} from "@/lib/server/work-review/agent-test-fixture";
import {openWorkAgentRuntime,startWorkAgent,readWorkAgentProject,projectWorkAgentTask} from "@/lib/server/work-review/agent-service";
import {WorkAgentRepository} from "@/lib/server/work-review/agent-repository";
import {readWorkAgentSource} from "@/lib/server/work-review/agent-context";

// Browser uses real components and a real isolated SQLite/Runtime fixture.
// HTTP/auth is intercepted here; the separate route tests exercise the actual Next API.
test("P1/P2 browser: compare, confirm, reopen, inspect timeline/radar evidence and invalidate",async({page})=>{
  test.setTimeout(120_000);
  const root=mkdtempSync(join(tmpdir(),"work-agent-browser-"));
  const db=openWorkReviewDatabase({filePath:join(root,"work.sqlite")}),f=seedWorkAgentCase(db);
  const m2=structuredClone(f.m2);
  m2.changes.push({key:"track_test",kind:"relation",relation:"tracks",anchorFindingId:f.findings.test,findingId:f.findings.test,todoId:f.test.id,label:"跟进测试工作",sourceFindingIds:[f.findings.test]});
  m2.changes.push({key:"track_deploy",kind:"relation",relation:"tracks",anchorFindingId:f.findings.a,findingId:f.findings.deploy,todoId:f.deployment.id,label:"部署跟进一期决定",sourceFindingIds:[f.findings.a,f.findings.deploy]});
  const runner=openWorkAgentRuntime(db,{checkpointPath:join(root,"checkpoints.sqlite"),
    compare:async(context)=>structuredClone(context.meetingId===f.meetings[1]?m2:f.m3),
    decision:async(input)=>input.results.some(r=>r.tool==="work.compare_meeting")?{finish:"比较已保存"}:{tool:"work.compare_meeting",args:{}}});
  const errors:string[]=[],external:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  try {
    // Explicit M2 confirmation creates A -> suspended; B is still only a proposal.
    let prior=await runner.runtime.advance(f.accountId,startWorkAgent(db,f.accountId,f.project.id,{id:randomUUID(),meetingId:f.meetings[1],goal:"整理后续工作"}).id);
    const p=new WorkAgentRepository(db).read(prior)!.preview!;
    prior=await runner.runtime.submitEvent(f.accountId,prior.id,{id:randomUUID(),kind:"work_selection",version:1,refId:p.id,
      message:JSON.stringify({previewId:p.id,fingerprint:p.fingerprint,keys:p.changes.map(c=>c.change.key)})},{expectedVersion:1});
    await runner.runtime.resolveApproval(f.accountId,prior.id,{approvalId:prior.approval!.id,fingerprint:prior.approval!.fingerprint,expectedVersion:1,decision:"approve",eventId:randomUUID()});
    await page.route("**/*",async route=>{
      const url=new URL(route.request().url());
      if(!["127.0.0.1","localhost"].includes(url.hostname)){external.push(url.hostname);return route.abort();}
      const json=(body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",headers:{"Cache-Control":"private, no-store"},body:JSON.stringify(body)});
      if(url.pathname==="/api/auth/me")return json({user:{id:f.accountId,email:"synthetic@example.invalid",name:"合成验收账号"}});
      if(url.pathname==="/api/work-reviews/config")return json({limits:{maxUploadBytes:314572800,maxAudioDurationSeconds:14400},
        capabilities:{projects:true,weekly:true,weeklyAi:false,weeklyVerifier:false,weeklyQa:false,weeklyQaVerifier:false}});
      if(url.pathname===`/api/work-reviews/projects/${f.project.id}/agent`){
        try {
          if(route.request().method()==="GET")return json(url.searchParams.has("findingId")?
            {source:readWorkAgentSource(db,f.accountId,f.project.id,url.searchParams.get("findingId")!)}:readWorkAgentProject(db,f.accountId,f.project.id));
          const body=route.request().postDataJSON();
          let task;
          if(route.request().method()==="POST")task=await runner.runtime.advance(f.accountId,startWorkAgent(db,f.accountId,f.project.id,body).id);
          else if(body.action==="select")task=await runner.runtime.submitEvent(f.accountId,body.id,{id:body.eventId,kind:"work_selection",version:body.expectedVersion,refId:body.selection.previewId,message:JSON.stringify(body.selection)},{expectedVersion:body.expectedVersion});
          else if(body.action==="approval")task=await runner.runtime.resolveApproval(f.accountId,body.id,body);
          else throw Error("unexpected_browser_action");
          return json({task:projectWorkAgentTask(db,task)},202);
        }catch{return json({error:"synthetic_source_changed"},409);}
      }
      if(url.pathname.startsWith("/api/"))return route.abort();
      return route.continue();
    });
    await page.goto(`/work-review/projects/${f.project.id}?meeting=${f.meetings[2]}`);
    await expect(page.getByRole("heading",{name:"合成：客户工单同步一期",exact:true})).toBeVisible();
    await page.getByLabel("这场会之后，你想整理什么？").fill("帮我整理今天开完会之后的工作");
    await page.getByRole("button",{name:"与项目历史对比",exact:true}).click();
    await expect(page.getByRole("heading",{name:"修改预览",exact:true})).toBeVisible();
    await expect(page.getByRole("heading",{name:"一期同步方案 · 已暂停",exact:true})).toBeVisible();
    await expect(page.locator("#work-radar summary").filter({hasText:"A方案部署"})).toContainText("需要核实");
    expect(f.todos.getTodo(f.accountId,f.deployment.id).title).toBe("A方案部署");
    await page.getByRole("button",{name:"选中全部",exact:true}).click();
    await expect(page.getByRole("checkbox",{name:"待用户拒绝的错误建议：完成供应商等待",exact:true})).toBeDisabled();
    await expect(page.getByRole("checkbox",{name:"待用户拒绝的错误建议：完成供应商等待",exact:true})).not.toBeChecked();
    await page.getByRole("button",{name:"核对选中的 5 项修改"}).click();
    await page.getByRole("button",{name:"确认保存选中的修改",exact:true}).click();
    await expect(page.getByRole("dialog",{name:"保存固定预览"})).toBeVisible();
    await page.getByRole("button",{name:"确认保存 5 项",exact:true}).click();
    await expect(page.getByText("已保存 5 项，未采用 1 项",{exact:true})).toBeVisible();
    await expect(page.getByText("已确认并保存",{exact:true})).toHaveCount(5);
    await expect(page.getByText("待用户确认",{exact:true})).toHaveCount(0);
    expect(f.todos.getTodo(f.accountId,f.deployment.id).title).toBe("B方案部署");
    expect(f.todos.getTodo(f.accountId,f.test.id).status).toBe("completed");
    expect(f.todos.getTodo(f.accountId,f.vendor.id).status).toBe("open");
    const count=db.prepare("SELECT count(*) n FROM wr_todo_events").get();
    await page.reload();
    await expect(page.getByText("已保存 5 项，未采用 1 项",{exact:true})).toBeVisible();
    await expect(page.getByRole("heading",{name:"一期同步方案 · 当前有效",exact:true})).toBeVisible();
    await expect(page.getByRole("heading",{name:"回滚测试 · 工作记录",exact:true})).toBeVisible();
    await expect(page.getByText("关联待办：回滚测试 · 已完成",{exact:true})).toBeVisible();
    await expect(page.getByText("回滚测试：尚无已确认的关闭关系。",{exact:true})).toHaveCount(0);
    const radar=page.getByRole("region",{name:"未闭环事项雷达"});
    await expect(radar.locator("summary").filter({hasText:"B方案部署"})).toContainText("待办未完成");
    await expect(radar.locator("summary").filter({hasText:"日志保留期限"})).toContainText("问题未解决");
    await expect(radar.locator("summary").filter({hasText:"等待供应商回复"})).toContainText("等待他人");
    await expect(radar.locator("summary").filter({hasText:"回滚测试"})).toHaveCount(0);
    await expect(radar.locator("summary").filter({hasText:"回滚重复写入问题"})).toHaveCount(0);
    await expect(radar.locator("summary").filter({hasText:"同步延迟监控"})).toBeVisible();
    await radar.getByRole("button",{name:"等待他人",exact:true}).click();
    await expect(radar.locator("summary")).toHaveCount(1);
    await radar.getByRole("button",{name:"全部",exact:true}).click();
    const history=page.getByRole("region",{name:"决策时间线"});
    await history.getByText(/查看历史与来源/).click();
    await expect(history.locator("summary").filter({hasText:"B方案候选"})).toContainText("候选 / 暂定");
    for(const [date,label,meeting,quote] of [["2026-10-06","记录事实","合成M1","正式采用方案A"],["2026-10-13","暂停决定","合成M2","还没有批准B替代A"],["2026-10-27","替代决定","合成M3","正式决定一期用B替代A"]]){
      const row=history.locator("li").filter({has:page.locator("summary").filter({hasText:`${date} · ${label} · 一期同步方案`})});
      await row.locator("summary").click();
      await row.getByRole("button",{name:new RegExp(`查看原文 · ${meeting}`)}).click();
      await expect(page.getByRole("dialog")).toContainText(quote);await page.keyboard.press("Escape");
    }
    await page.getByRole("button",{name:"查看原文 1",exact:true}).first().click();
    await expect(page.getByRole("dialog")).toContainText("会议原文");
    await page.keyboard.press("Escape");
    expect(db.prepare("SELECT count(*) n FROM wr_todo_events").get()).toEqual(count);
    mkdirSync("output/playwright",{recursive:true});
    await page.screenshot({path:"output/playwright/work-agent-p2-desktop.png",fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:"output/playwright/work-agent-p2-mobile.png",fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    const meeting=f.repo.getMeeting(f.accountId,f.meetings[2]);
    f.projects.setMeetingProjects({accountId:f.accountId,meetingId:meeting.id,expectedVersion:meeting.version,operationKey:"browser_unlink",projectIds:[]});
    await page.reload();
    await expect(page.getByRole("heading",{name:"一期同步方案 · 待核实",exact:true})).toBeVisible();
    await expect(page.getByText("B替代A，部署需调整。",{exact:false})).toHaveCount(0);
    await expect(page.locator("#work-radar summary").filter({hasText:"一期同步方案"})).toContainText("依据失效");
    expect(external).toEqual([]);expect(errors).toEqual([]);
  }finally{runner.runtime.close();db.close();rmSync(root,{recursive:true,force:true});}
});
