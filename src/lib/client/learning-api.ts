import type { LearningPage, LearningPageSummary, LearningSource } from "@/lib/domain/learning";
import type { FrameworkEdit, FrameworkView } from "@/lib/domain/learning-framework";
import type { NodeConversation, OverviewView } from "@/lib/domain/learning-study";
import type { QuizActionInput, QuizAttemptView, QuizConfig, QuizRunSummary } from "@/lib/domain/learning-quiz";
import type { LearningPreparationRun } from "@/lib/domain/learning-preparation";

export class LearningApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
export function learningErrorMessage(error: unknown): string {
  if (!(error instanceof LearningApiError)) return "未能确认保存或读取结果，请检查网络后重试；刷新页面可核对已保存的内容。";
  const messages: Record<string, string> = {
    learning_preparation_interrupted: "整理已暂停，已保存材料和已完成内容都还在。继续时会先核对已有处理结果。",
    preparation_interrupted: "本次整理状态已变化，请重新读取进度；不会重复提交未确认的请求。",
    preparation_not_found: "找不到这次整理记录，或对应材料已删除。请重新打开学习页核对。",
    learning_materials_need_attention: "有材料尚未完整准备好。可查看具体影响，再决定是否先使用可用部分。",
    learning_preparation_failed: "本次整理未完成。材料和已有成果都已保留，请查看材料状态后再继续。",
    pdf_scope_blocked: "所选页含不可用、失败或未覆盖内容；请选择其他可用页，原 PDF 仍可查看。",
    pdf_scope_missing_content: "所选页有空块或缺失图像内容，不能当作完整文字使用。请缩小到不依赖缺失内容的其他页。",
    pdf_scope_incomplete_region: "选中块合并了其他物理页，请将全部成员页纳入范围。",
    pdf_warning_ack_required: "所选页有解析告警，请先查看问题并明确确认使用，或排除这些页。",
    pdf_scope_not_selected: "请先明确选择 PDF 解析版本和用于学习的物理页；此操作不代表内容已核实。",
    quiz_grounding_invalid: "生成依据摘录或解析引用不符合本次材料，题组未发布；原材料和旧成果保留。",
    quiz_busy: "这个学习页已有题组正在生成，请等待完成。旧题组仍可使用。",
    quiz_scope_too_large: "这次旧请求受到了当时的处理限制。可以保留全部所选材料，重新开始分段整理。",
    generation_request_does_not_fit: "这部分资料合并后的请求超过当前单次处理容量，尚未发送给模型。原材料、已完成进度和旧成果保留，无需删除材料。",
    generation_plan_invalid: "本次考点安排未能完成，已读资料与旧成果保留，可以继续未完成部分。",
    generation_plan_changed: "本次处理所用的资料或设置已变化，请重新开始整理；旧成果保留。",
    generation_result_unknown: "这部分生成结果尚未确认，已完成内容保留；系统不会重复提交这次请求。",
    generation_part_failed: "这部分整理暂未完成，已完成内容和旧成果保留。",
    quiz_invalid_result: "本次题目结构、数量或来源不符合要求，未发布题组，已有成果保留。",
    quiz_reading_invalid_result: "材料整理阶段的结果不符合格式要求，尚未开始出题。材料、已完成进度和旧成果保留。",
    quiz_reading_invalid_source: "材料整理阶段的原文定位未通过检查，尚未开始出题。材料和旧成果保留，请重新生成新题组。",
    quiz_reading_restart_required: "这次材料整理采用的旧格式已无法继续，尚未生成可作答题组。材料和旧成果保留，请重新生成新题组。",
    quiz_selection_invalid_result: "考点安排阶段的结果不符合要求，尚未开始出题。材料、已完成进度和旧成果保留。",
    quiz_not_found: "找不到题组或作答，或它不属于当前学习页。",
    quiz_deleted: "这份题组已删除，相关作答记录已清除。材料和其他学习成果仍保留。",
    quiz_not_ready: "题组尚不可作答，空题组不会记为生成成功。",
    quiz_edit_conflict: "作答已在另一窗口更新，请重新载入核对；本次操作没有覆盖新进度。",
    quiz_attempt_complete: "这次作答已结束，记录与答案保持不变。可重新选择设置生成另一组。",
    quiz_question_complete: "本题已提交、跳过或看过答案，记录已保存。",
    quiz_choose_first: "请先选择一个选项。",
    quiz_answers_hidden: "测验完成整组后才显示答案、解析与来源。",
    overview_busy: "关系总览正在更新，旧成果仍可阅读；完成后再整理新材料。",
    overview_scope_too_large: "章节及实际材料内容过多，旧总览保留；没有截断材料或只凭摘要生成。",
    overview_invalid_relation: "关系指向或来源不符合要求，新总览未发布，旧版保留。",
    overview_no_valid_relations: "生成的关系均未通过检查，本次没有发布新总览；这不表示材料之间没有联系。",
    study_content_changed: "知识点、章节或来源已变化。本次结果未发布；旧对话保留，请基于当前内容明确开始新对话。",
    node_qa_busy: "这段对话已有问题正在回答，请等待完成。",
    node_context_too_large: "当前知识点及所需材料超过本次上下文预算，未发起请求；不会静默截断材料。",
    conversation_not_found: "找不到这段学习对话，或它不属于当前账号和知识点。",
    note_too_large: "存入后会超过个人笔记长度上限，请先整理现有笔记。",
    learning_cleanup_failed: "材料已失效，但临时处理文件尚未清理完；请重试删除以完成清理。",
    audio_tools_unavailable: "本地音频校验工具暂不可用，尚未保存原音，请稍后重试。",
    audio_resource_limit: "音频校验超过本地时间限制，本批未保存；请拆分后重试。",
    learning_asr_not_configured: "录音转写服务尚未配置，请联系管理员。原音已保存，可以稍后转写。",
    invalid_audio: "无法读取该录音或格式不支持；请使用正常音频文件。原件未保存。",
    audio_too_large: "单份录音暂不超过 64 MiB。",
    audio_batch_too_large: "每次添加录音暂不超过 128 MiB、最多 2 份。",
    audio_too_long: "单份录音暂不超过 2 小时。",
    audio_busy: "这个学习页已有转写任务，请等待完成。",
    audio_not_transcribed: "录音还没有转写完成。原音已保存，可以查看准备进度或稍后继续整理。",
    audio_interrupted: "转写已中断，原音及已完成分片保留；可手动恢复未完成部分。",
    audio_transcription_failed: "转写未完成，原音和已完成分片仍保留；未知提交只查询，不自动重发。",
    audio_invalid_timestamps: "ASR 没有返回有效时间位置，本材料未发布转写；不会编造时间戳。",
    audio_empty_transcript: "ASR 未返回可用正文，本材料未发布转写。",
    audio_terminal: "本次转写已失效，迟到结果不会保存。",
    learning_generation_not_configured: "学习生成尚未配置，请联系管理员。材料已保存，配置完成后可再次尝试。",
    framework_busy: "这个学习页已有一批正在整理，请等待本批完成。旧框架仍可阅读和编辑。",
    framework_scope_too_large: "这次旧请求受到了当时的处理限制。可以保留全部所选材料，重新开始分段整理。",
    framework_invalid_result: "生成结果不完整或格式不符合要求，本次未保存新成果；材料和旧成果仍保留。",
    framework_invalid_source: "这部分解释未能准确对应原文，暂未发布。材料、已完成进度和旧成果都还在。",
    framework_missing_material: "这部分整理遗漏了材料，暂未发布。已完成进度保留，可以继续未完成部分。",
    framework_provider_failed: "本次生成失败或结果未能确认，旧成果仍保留；不会自动再次调用模型。",
    framework_save_failed: "生成结果未能保存，本次未保存新成果；材料和旧成果仍保留，不会自动重新调用模型。",
    framework_interrupted: "本次整理已中断或超时，未发布新成果；如需再次整理，请手动重新整理。",
    framework_terminal: "本次整理已结束或失效，迟到结果不会发布。",
    framework_edit_conflict: "这章已在其他操作中修改。你的草稿仍在，请先核对最新内容，再重新编辑保存。",
    framework_not_found: "找不到该框架或知识点，或当前账号无权访问。",
    unauthenticated: "登录已过期，请重新登录。",
    cross_origin_forbidden: "请求来源与当前站点不一致，请从本页重新进入后操作。",
    page_not_found: "找不到这个学习页，或当前账号无权访问。",
    page_deleted: "这个学习页已删除。",
    material_not_found: "找不到这份材料，或它不属于当前学习页。",
    material_deleted: "来源已删除，不能再查看原文。",
    invalid_utf8: "文件不是有效的 UTF-8 文本，请转换为 UTF-8 TXT 后再导入。",
    invalid_text: "材料为空或包含非文本内容。",
    text_too_large: "单份文本不能超过 1 MiB，请按自然章节拆分。",
    batch_too_large: "本批文本超过 4 MiB，请分批保存。",
    invalid_txt_filename: "当前只支持 UTF-8 TXT 文件。",
    invalid_pdf: "PDF 内容损坏或不是可读取的 PDF，请检查原文件后重新添加。本批未保存。",
    pdf_incomplete: "未能完整读取此 PDF，其中部分页面、字体或图片暂不支持。本批未保存，请导出普通 PDF 后重试。",
    invalid_pdf_filename: "PDF 文件名无效，请使用以 .pdf 结尾的文件名。",
    pdf_encrypted: "本轮不支持加密或受密码保护的 PDF，请自行导出未加密副本后添加。",
    pdf_unsupported: "此 PDF 的页面格式或 XFA 表单暂不支持，请导出普通 PDF 后添加。",
    pdf_page_limit: "单份 PDF 暂支持 1–200 个物理页，请分成较小文件后添加。",
    pdf_too_large: "单份 PDF 暂不能超过 20 MiB，请压缩或拆分后添加。",
    pdf_batch_too_large: "本批 PDF 超过 50 MiB，请分批保存。",
    pdf_resource_limit: "此 PDF 超过当前校验的时间或内存限制，本批未保存。请拆分或简化文件后重试。",
    pdf_image_limit: "此 PDF 含超过 1600 万像素的单张图片，当前无法安全预览。请降低图片分辨率后添加，本批未保存。",
    learning_upload_busy: "当前有其他材料正在保存，请稍后重试。本次提交标识会保留。",
    learning_upload_too_large: "本次上传超过请求大小限制。PDF 每批不超过 50 MiB，文本每批不超过 4 MiB，请分批保存。",
    pdf_validator_unavailable: "本地 PDF 校验组件暂不可用，本批未保存。请稍后重试。",
    pdf_interrupted: "本次 PDF 保存已中断，请重新载入核对后重试。",
    pdf_parser_not_configured: "PDF 解析服务尚未配置，原件仍可查看。",
    pdf_parser_unavailable: "PDF 解析服务暂未就绪，本次尚未提交解析。原件和已完成内容都已保留。",
    pdf_parser_config_invalid: "PDF 解析服务配置异常，请联系管理员检查；原件仍保留。",
    pdf_parser_findings_invalid: "PDF 已知风险记录配置无效，已停止处理。",
    pdf_parser_outcome_unknown: "上次请求结果不明；已阻止重复提交。需核对原请求，不会自动重新解析。",
    pdf_parser_resource_wait: "正在等待解析资源，已完成页已保存。可以稍后继续处理未完成页。",
    pdf_parser_service_changed: "上次处理对应的解析服务已变化，已完成页仍保留。需要先核对原请求，再继续未完成页。",
    pdf_parser_budget_exhausted: "本轮解析额度已用完，已完成页和原件仍保留。未完成页不会自动重试。",
    pdf_parser_session_expired: "本轮解析服务使用时段已结束，已完成页和原件仍保留。未完成页不会自动重试。",
    pdf_not_parsed: "PDF 原件已保存，但尚未解析，当前不能作为框架或 Quiz 的文字依据。请使用原页查看。",
    pdf_not_found: "找不到这份 PDF，或它不属于当前学习页。",
    source_changed: "材料或选择范围已在其他操作中改变，请重新载入后选择。",
    submission_conflict: "本次提交与已保存内容不一致，请重新载入核对。",
    invalid_input: "材料或提交格式不符合要求，请检查后再试。"
  };
  return messages[error.code] ?? "暂时无法确认操作结果。请保留当前内容，重试或重新载入核对。";
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/learning/pages${path}`, { ...init, cache: "no-store", credentials: "same-origin" });
  const body = await response.json();
  if (!response.ok) throw new LearningApiError(response.status, typeof body.error === "string" ? body.error : "request_failed");
  return body as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export const LEARNING_INVALIDATION_CHANNEL = "learning-material-deletion";
function notifyDeletion(pageId: string) {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(LEARNING_INVALIDATION_CHANNEL);
  channel.postMessage({ pageId }); channel.close();
}
export async function learningPdfResponse(pageId: string, materialId: string, signal: AbortSignal, head = false) {
  const response = await fetch(`/api/learning/pages/${encodeURIComponent(pageId)}/materials/${encodeURIComponent(materialId)}/pdf`, {
    method: head ? "HEAD" : "GET", credentials: "same-origin", cache: "no-store", signal
  });
  if (!response.ok) throw new LearningApiError(response.status, response.status === 410 ? "material_deleted" : response.status === 401 ? "unauthenticated" : "pdf_not_found");
  return response;
}
export const learningApi = {
  preparation: (pageId: string, signal?: AbortSignal) => request<{ runs: LearningPreparationRun[] }>(`/${encodeURIComponent(pageId)}/preparation`, { signal }),
  startPreparation: (pageId: string, id: string, materialIds: string[], intent: "organize" | "prepare" = "organize") => request<{ run: LearningPreparationRun }>(`/${encodeURIComponent(pageId)}/preparation`, json("POST", { id, materialIds, intent })),
  resumePreparation: (pageId: string, id: string, options: { continueWithAvailable?: true; materialIds?: string[] } = {}) => request<{ run: LearningPreparationRun }>(`/${encodeURIComponent(pageId)}/preparation`, json("POST", { id, ...options })),
  parsePdf: (pageId:string,materialId:string,input:{id:string;physicalPages:number[];resumeFrom?:string})=>request<{document:import("@/lib/domain/learning-parsed-document").ParsedDocument}>(`/${pageId}/materials/${materialId}/parsed`,json("POST",input)),
  parsedSource: (pageId:string,materialId:string,documentId:string,blockId:string)=>request<import("@/lib/domain/learning-parsed-document").ParsedBlockSource>(`/${pageId}/materials/${materialId}/parsed?document=${documentId}&block=${blockId}`),
  parsed: (pageId: string, materialId: string, documentId?:string, summary=false) => request<{ progress:Array<{physical_page:number;request_id:string;status:string; wait?:{reason:"resource_wait"|"busy";retryAfterSeconds:number;retryAt:string;expiresAt:string};issue?:"pdf_parser_service_changed"|"pdf_parser_budget_exhausted"|"pdf_parser_session_expired"}>;
    documents: Array<Omit<import("@/lib/domain/learning-parsed-document").ParsedDocument,"pages">>; document: import("@/lib/domain/learning-parsed-document").ParsedDocument|null; selection: import("@/lib/domain/learning-pdf-study").PdfStudySelection|null; readiness?: import("@/lib/domain/learning-pdf-study").LearningPdfReadiness|null }>(`/${pageId}/materials/${materialId}/parsed?${new URLSearchParams({...documentId?{document:documentId}:{},...summary?{summary:"1"}:{}})}`),
  pdfStudyScope: async (pageId:string,materialId:string,revision:number,selection:import("@/lib/domain/learning-pdf-study").PdfStudySelection)=>{const r=await request<{page:LearningPage}>(`/${pageId}/materials/${materialId}/parsed`,json("PATCH",{revision,selection}));notifyDeletion(pageId);return r;},
  quizzes: (pageId: string) => request<{ quizzes: QuizRunSummary[] }>(`/${pageId}/quiz`),
  deleteQuiz: async (pageId: string, id: string) => {
    const result = await request<{ quizzes: QuizRunSummary[] }>(`/${pageId}/quiz`, json("DELETE", { id }));
    notifyDeletion(pageId); return result;
  },
  generateQuiz: (pageId: string, id: string, settings: QuizConfig, resume=false) => request<{ quizzes: QuizRunSummary[] }>(`/${pageId}/quiz`, {...json("POST", { id, settings,...(resume?{resume:true}:{}) }),headers:{"content-type":"application/json",prefer:"respond-async"}}),
  quizAttempt: (pageId: string, id: string) => request<{ attempt: QuizAttemptView }>(`/${pageId}/quiz?attempt=${id}`),
  startQuiz: (pageId: string, id: string, quizId: string, mode: "practice" | "test") => request<{ attempt: QuizAttemptView }>(`/${pageId}/quiz`, json("PATCH", { kind: "start", value: { id, quizId, mode } })),
  quizAction: (pageId: string, value: QuizActionInput) => request<{ attempt: QuizAttemptView }>(`/${pageId}/quiz`, json("PATCH", { kind: "act", value })),
  quizSource: (pageId: string, id: string, question: number, index: number) => request<{ source: { kind: string; text?: string; materialId?: string; paragraph?: import("@/lib/domain/learning").LearningParagraph } }>(`/${pageId}/quiz?attempt=${id}&question=${question}&source=${index}`),
  transcriptions: (id: string, signal?: AbortSignal) => request<{ runs: Array<{ id: string; status: string }> }>(`/${encodeURIComponent(id)}/transcriptions`, { signal }),
  transcribe: (pageId: string, id: string, materialIds: string[]) => request<{ page: LearningPage }>(`/${encodeURIComponent(pageId)}/transcriptions`, json("POST", { id, materialIds })),
  framework: (id: string, signal?: AbortSignal) => request<{ framework: FrameworkView }>(`/${encodeURIComponent(id)}/framework`, { signal }),
  organize: (pageId: string, id: string, materialIds: string[]) => request<{ framework: FrameworkView; overviewError?: string }>(`/${encodeURIComponent(pageId)}/framework`, json("POST", { id, materialIds })),
  overview: (pageId: string) => request<{ overview: OverviewView }>(`/${encodeURIComponent(pageId)}/overview`),
  updateOverview: (pageId: string, id: string) => request<{ overview: OverviewView }>(`/${encodeURIComponent(pageId)}/overview`, json("POST", { id })),
  conversations: (pageId: string, chapter: string, node: string) => request<{ conversations: NodeConversation[] }>(`/${encodeURIComponent(pageId)}/node-qa?${new URLSearchParams({ chapter, node })}`),
  askNode: (pageId: string, input: { id: string; conversationId: string; chapterId: string; nodeId: string; action: "ask" | "rephrase" | "example"; question: string }) => request<{ conversations: NodeConversation[] }>(`/${encodeURIComponent(pageId)}/node-qa`, json("POST", input)),
  saveAnswerNote: (pageId: string, input: { turnId: string; chapterId: string; nodeId: string; revision: number; section: number }) => request<{ framework: FrameworkView }>(`/${encodeURIComponent(pageId)}/node-qa`, json("PATCH", input)),
  studySource: (pageId: string, kind: "overview" | "answer", id: string, item: number, index: number) => request<{ source: { materialId: string; title: string; paragraph: import("@/lib/domain/learning").LearningParagraph } }>(`/${encodeURIComponent(pageId)}/study-source?${new URLSearchParams({ kind, id, item: String(item), index: String(index) })}`),
  editFramework: (pageId: string, edit: FrameworkEdit) => request<{ framework: FrameworkView }>(`/${encodeURIComponent(pageId)}/framework`, json("PATCH", edit)),
  frameworkSource: (pageId: string, chapter: string, node: string, index: number) => request<{ source: { materialId: string; title: string; paragraph: import("@/lib/domain/learning").LearningParagraph } }>(
    `/${encodeURIComponent(pageId)}/framework/source?${new URLSearchParams({ chapter, node, index: String(index) })}`),
  list: (signal?: AbortSignal) => request<{ pages: LearningPageSummary[] }>("", { signal }),
  create: (id: string, title: string) => request<{ page: LearningPage }>("", json("POST", { id, title })),
  get: (id: string, signal?: AbortSignal) => request<{ page: LearningPage }>(`/${encodeURIComponent(id)}`, { signal }),
  save: (id: string, body: FormData) => request<{ page: LearningPage; preparation?: import("@/lib/domain/learning").LearningUploadPreparation[]; run?: LearningPreparationRun }>(`/${encodeURIComponent(id)}/materials`, { method: "POST", body }),
  select: (id: string, revision: number, materialIds: string[]) => request<{ page: LearningPage }>(`/${encodeURIComponent(id)}`, json("PATCH", { revision, materialIds })),
  source: (id: string, materialId: string, signal?: AbortSignal) => request<{ source: LearningSource }>(`/${encodeURIComponent(id)}/materials/${encodeURIComponent(materialId)}`, { signal }),
  deleteMaterial: async (id: string, materialId: string) => {
    const result = await request<{ page: LearningPage }>(`/${encodeURIComponent(id)}/materials/${encodeURIComponent(materialId)}`, { method: "DELETE" });
    notifyDeletion(id); return result;
  },
  deletePage: async (id: string) => {
    const result = await request<{ deleted: true }>(`/${encodeURIComponent(id)}`, { method: "DELETE" });
    notifyDeletion(id); return result;
  }
};
