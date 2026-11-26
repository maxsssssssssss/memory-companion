import type { PreparationView } from "@/lib/domain/date-companion-preparation";

export type PreparationCatalog = { preparations: PreparationView[]; availableSources: Array<{ id: string; recordingDate: string; title: string; reviewAvailable?: boolean }> };
/** Status/code are retained for the notebook's recovery UI; existing callers can
 * continue to use Error.message and versionConflict. A network error is not proof
 * that a write failed. */
export class PreparationRequestError extends Error {
  readonly versionConflict: boolean;
  constructor(message: string, readonly status: number | null, readonly code: string, readonly uncertain = false) {
    super(message); this.name = "PreparationRequestError";
    this.versionConflict = status === 409 && code === "version_conflict";
  }
}
export async function preparationRequest<T>(path = "", init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/date-companion/preparations${path}`, {
      ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...init?.headers }
    });
  } catch (cause) {
    if (init?.signal?.aborted) throw new PreparationRequestError("已停止等待，刚才发出的内容仍可重新读取。", null, "wait_cancelled", true);
    throw new PreparationRequestError(cause instanceof Error && cause.name === "AbortError" ? "已停止等待。" : "暂时没有收到连接结果。", null, "connection_unknown", true);
  }
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const code = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : undefined;
    if (response.status === 409 && code === "version_conflict") {
      throw new PreparationRequestError("其他地方刚更新了这段讨论，这次修改没有保存。请重新读取后继续。", response.status, code);
    }
    if (response.status === 401) throw new PreparationRequestError("登录已过期，请重新登录。", 401, code ?? "unauthorized");
    if (response.status === 403) throw new PreparationRequestError("当前账号无权操作这段讨论。", 403, code ?? "forbidden");
    if (code === "preparation_review_unavailable") throw new PreparationRequestError("这份相处记录已经不能关联了，可以改选其他记录。", response.status, code);
    if (code === "preparation_retry_unavailable") throw new PreparationRequestError("这一轮的状态已变更，请重新读取讨论。", response.status, code);
    if (response.status === 404) throw new PreparationRequestError("这段讨论或相处记录已不可用。", 404, code ?? "not_found");
    throw new PreparationRequestError("暂时没有收到可确认的结果。", response.status, code ?? "preparation_unavailable", response.status >= 500);
  }
  try { return await response.json() as T; }
  catch { throw new PreparationRequestError("暂时没能读到完整结果。", response.status, "response_unknown", true); }
}
