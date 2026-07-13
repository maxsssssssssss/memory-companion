type OpenRouterErrorPayload = {
  error?: {
    message?: string;
    code?: string | number;
    metadata?: {
      provider_name?: string;
      raw?: string;
    };
  };
  message?: string;
};

const MAX_ERROR_DETAIL_LENGTH = 240;

function looksLikeHtml(value: string) {
  const sample = value.trim().slice(0, 500).toLowerCase();

  return sample.startsWith("<!doctype") || sample.startsWith("<html") || sample.includes("<body") || sample.includes("</html>");
}

function sanitizeErrorDetail(value: string | undefined) {
  const trimmedValue = value?.replace(/\s+/g, " ").trim();
  if (!trimmedValue || looksLikeHtml(trimmedValue)) {
    return undefined;
  }

  return trimmedValue.length <= MAX_ERROR_DETAIL_LENGTH ? trimmedValue : `${trimmedValue.slice(0, MAX_ERROR_DETAIL_LENGTH)}...`;
}

export function getOpenRouterErrorMessage(payload: OpenRouterErrorPayload, response: Response) {
  if (response.status >= 500) {
    return "OpenRouter 服务暂时不可用，请稍后重试。";
  }

  const primaryMessage = sanitizeErrorDetail(payload.error?.message) ?? sanitizeErrorDetail(payload.message) ?? response.statusText;
  const rawDetail = sanitizeErrorDetail(payload.error?.metadata?.raw);
  const parts = [
    primaryMessage,
    payload.error?.code ? `code=${payload.error.code}` : undefined,
    payload.error?.metadata?.provider_name ? `provider=${payload.error.metadata.provider_name}` : undefined,
    rawDetail ? `raw=${rawDetail}` : undefined,
    response.headers.get("x-generation-id") ? `generation=${response.headers.get("x-generation-id")}` : undefined
  ];

  return parts.filter(Boolean).join(" · ");
}
