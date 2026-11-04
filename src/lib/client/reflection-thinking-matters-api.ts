import { z } from "zod";

import {
  ThinkingMatterSchema,
  ThinkingMatterViewSchema,
  type ThinkingMatter,
  type ThinkingMatterBeginTurn,
  type ThinkingMatterCreate,
  type ThinkingMatterMutation,
  type ThinkingMatterView,
} from "@/lib/domain/reflection-thinking-matter";

export type ThinkingMattersApi = {
  list(signal?: AbortSignal): Promise<ThinkingMatter[]>;
  get(id: string, signal?: AbortSignal): Promise<ThinkingMatterView>;
  create(input: Omit<ThinkingMatterCreate, "source"> & { sourceCardId?: string; sourceCardVersion?: number }, signal?: AbortSignal): Promise<ThinkingMatterView>;
  turn(id: string, input: Omit<ThinkingMatterBeginTurn, "taskId">, signal?: AbortSignal): Promise<ThinkingMatterView>;
  mutate(id: string, input: ThinkingMatterMutation, signal?: AbortSignal): Promise<ThinkingMatterView>;
  recover(id: string, input: { operationKey: string }, signal?: AbortSignal): Promise<ThinkingMatterView>;
  linkCard(id: string, input: { operationKey: string; expectedVersion: number; cardId: string; cardVersion: number }, signal?: AbortSignal): Promise<ThinkingMatterView>;
  unlinkCard(id: string, input: { operationKey: string; expectedVersion: number; cardId: string }, signal?: AbortSignal): Promise<ThinkingMatterView>;
};

export class ThinkingMattersApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "ThinkingMattersApiError";
  }
}

const base = "/api/daily-reflections/thinking/matters";

function view(payload: unknown) {
  // Execution details may accompany the business response; the page renders
  // only the persisted matter and its history.
  const envelope = z.object({ matter: z.unknown(), events: z.unknown() }).safeParse(payload);
  const parsed = ThinkingMatterViewSchema.safeParse(envelope.success ? envelope.data : null);
  if (!parsed.success) throw new ThinkingMattersApiError(502, "invalid_response", "暂时无法读取已保存的进展，请稍后重新读取。");
  return parsed.data;
}

export function createThinkingMattersApi(fetcher: typeof fetch = fetch): ThinkingMattersApi {
  async function request(path: string, body?: unknown, signal?: AbortSignal) {
    let response: Response;
    try {
      response = await fetcher(path, {
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ThinkingMattersApiError(0, "unknown", "连接中断，保存或回复的结果尚未确认。请先重新读取进展。");
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new ThinkingMattersApiError(response.status, "invalid_response", "暂时无法读取结果，请重新读取进展。"); }
    if (!response.ok) {
      const code = z.object({ error: z.string() }).safeParse(payload);
      throw new ThinkingMattersApiError(response.status, code.success ? code.data.error : "unavailable",
        response.status === 401 ? "登录已失效，请重新登录。"
          : response.status === 404 ? "这件事不存在或当前账号无权查看。"
            : response.status === 409 ? "进展已经变化，请重新读取后继续。"
              : "这次回复未完成，已保存的进展仍可查看。请先重新读取进展。");
    }
    return payload;
  }
  return {
    async list(signal) {
      const parsed = z.object({ matters: z.array(ThinkingMatterSchema) }).safeParse(await request(base, undefined, signal));
      if (!parsed.success) throw new ThinkingMattersApiError(502, "invalid_response", "暂时无法读取正在想的事，请稍后重新读取。");
      return parsed.data.matters;
    },
    async get(id, signal) { return view(await request(`${base}/${encodeURIComponent(id)}`, undefined, signal)); },
    async create(input, signal) { return view(await request(base, input, signal)); },
    async turn(id, input, signal) { return view(await request(`${base}/${encodeURIComponent(id)}`, { action: "turn", ...input }, signal)); },
    async mutate(id, input, signal) { return view(await request(`${base}/${encodeURIComponent(id)}`, { action: "mutate", ...input }, signal)); },
    async recover(id, input, signal) { return view(await request(`${base}/${encodeURIComponent(id)}`, { action: "recover", ...input }, signal)); },
    async linkCard(id, input, signal) { return view(await request(`${base}/${encodeURIComponent(id)}`, { action: "link_card", ...input }, signal)); },
    async unlinkCard(id, input, signal) { return view(await request(`${base}/${encodeURIComponent(id)}`, { action: "unlink_card", ...input }, signal)); },
  };
}
