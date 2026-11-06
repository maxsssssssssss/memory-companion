import type { PreparationView } from "@/lib/domain/date-companion-preparation";

export type PreparationCatalog = { preparations: PreparationView[]; availableSources: Array<{ id: string; recordingDate: string; title: string; reviewAvailable?: boolean }> };
export async function preparationRequest<T>(path = "", init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/date-companion/preparations${path}`, {
      ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...init?.headers }
    });
  } catch {
    throw new Error("暂时没有收到连接结果。");
  }
  if (!response.ok) {
    const code = (await response.json().catch(() => ({}))).error;
    if (response.status === 409 && code === "version_conflict") {
      throw Object.assign(new Error("其他地方刚更新了这段讨论，这次修改没有保存。请重新读取后继续。"), { versionConflict: true });
    }
    if (response.status === 401) throw new Error("登录已过期，请重新登录。");
    if (code === "preparation_review_unavailable") throw new Error("这份相处记录已经不能关联了，可以改选其他记录。");
    if (response.status === 404) throw new Error("这段讨论或相处记录已不可用。");
    throw new Error("暂时没有收到可确认的结果。");
  }
  try { return await response.json() as T; }
  catch { throw new Error("暂时没能读到完整结果。"); }
}
