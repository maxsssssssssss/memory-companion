// @vitest-environment node
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {AgentContext,AgentDecisionInput} from "@/lib/server/agent/types";
import type {WorkAgentContext} from "@/lib/domain/work-agent";
const mocks=vi.hoisted(()=>({profile:vi.fn(),client:vi.fn(),parse:vi.fn()}));
vi.mock("./runtime-config",()=>({resolveWorkReviewExtractorProfile:mocks.profile}));
vi.mock("./deepseek-client",()=>({createWorkReviewDeepSeekClient:mocks.client}));
vi.mock("@/lib/server/openai/structured-json",()=>({parseStructuredJsonResponse:mocks.parse}));
import {compareWorkMeeting,decideWorkAgent} from "./agent-model";

let ctx:AgentContext;
beforeEach(()=>{
  vi.resetAllMocks();vi.stubGlobal("fetch",vi.fn(()=>{throw Error("external_network_forbidden");}));
  mocks.profile.mockReturnValue({provider:"deepseek-structured-json",model:"synthetic-model",maxOutputTokens:4096,timeoutMs:1000,reasoningEffort:"provider_default"});
  mocks.client.mockReturnValue({});
  ctx={task:{goal:"看看这个项目哪些决定变了",budget:{maxOutputTokens:8000}},signal:new AbortController().signal,
    call:vi.fn(async(_request,run)=>(await run({requestId:"offline-request"})).value)} as unknown as AgentContext;
});
afterEach(()=>vi.unstubAllGlobals());
describe("Work Agent offline model adapter contract",()=>{
  it("uses the Work transport, bounded structured schema, shared call ledger and cancellation signal",async()=>{
    const result={items:[{category:"uncertain",text:"缺少后续记录",sourceFindingIds:["finding-a"],status:"uncertain"}],changes:[]};
    mocks.parse.mockResolvedValue(result);
    await expect(compareWorkMeeting({project:{id:"project-a",name:"合成项目"}} as WorkAgentContext,ctx)).resolves.toEqual(result);
    expect(ctx.call).toHaveBeenCalledOnce();expect(mocks.client).toHaveBeenCalledOnce();
    const request=mocks.parse.mock.calls[0][0];
    expect(request).toMatchObject({model:"synthetic-model",jsonRootField:null,store:false,stream:true,maxOutputTokens:4096,
      streamLimits:{maxEventBytes:200000,maxDeltaBytes:200000,maxTotalBytes:800000+256*4096},
      requestOptions:{maxRetries:0,timeout:1000,headers:{"X-Client-Request-Id":"offline-request"}}});
    expect(request.requestOptions.signal).toBeInstanceOf(AbortSignal);
    expect(request.schema.safeParse(result).success).toBe(true);
    expect(request.requestInput[0].content).toContain("提议/暂定B不能替代正式A");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports configuration failure before reserving or sending a model call",async()=>{
    mocks.client.mockImplementation(()=>{throw Error("private configuration detail");});
    await expect(compareWorkMeeting({} as WorkAgentContext,ctx)).rejects.toMatchObject({code:"known_failure",message:"办公模型配置不可用；尚未发起请求。"});
    expect(ctx.call).not.toHaveBeenCalled();expect(mocks.parse).not.toHaveBeenCalled();
  });
  it("preserves unknown outcomes without retry and strips model-generated operation reasons",async()=>{
    mocks.parse.mockRejectedValueOnce(Error("private transport detail"));
    await expect(compareWorkMeeting({} as WorkAgentContext,ctx)).rejects.toMatchObject({code:"unknown",message:"work_agent_model_outcome_unknown"});
    expect(mocks.parse).toHaveBeenCalledTimes(1);
    mocks.parse.mockResolvedValueOnce({tool:"work.compare_meeting",args:{},reason:"private source text"});
    const input={task:{goal:"比较",scope:{}},observation:{},results:[],tools:[]} as unknown as AgentDecisionInput;
    await expect(decideWorkAgent(input,ctx)).resolves.toEqual({tool:"work.compare_meeting",args:{}});
  });
});
