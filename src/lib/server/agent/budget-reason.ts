/** Safe, persisted explanations; never expose arbitrary model/provider errors. */
export function agentBudgetEndReason(reason: string): string {
  switch (reason) {
    case "agent_decision_input_limit":
    case "agent_request_input_limit":
      return "本轮需要读取的内容超过单次处理上限，已停止。已有作答和讲解已保留；可以围绕一个更具体的目标开始新复习。这不是整个试用的请求额度耗尽。";
    case "agent_request_output_limit":
      return "本轮生成请求超过单次输出上限，已停止。已有内容已保留；这不是整个试用的请求额度耗尽。";
    case "agent_call_limit":
      return "本轮模型调用已达到任务上限，已停止。已有内容已保留，可以开始新复习；本轮上限与整个试用的剩余额度分开计算。";
    case "agent_compute_limit":
      return "本轮累计计算时间已达到上限，已停止。等待你阅读或作答的时间不计入；已有内容已保留，可以开始新复习。";
    case "agent_step_limit":
      return "本轮行动步骤已达到上限，已停止。已有内容已保留，可以开始新复习；这不是整个试用的请求额度耗尽。";
    case "agent_no_progress_limit":
      return "本轮连续重复相同行动且没有取得进展，已停止。已有内容已保留，可以换一个更具体的目标开始新复习。";
    default:
      return "本轮因执行限制停止，已有内容已保留。未记录具体限制原因，不能据此判断整个试用的剩余额度。";
  }
}
