export const REFLECTION_ROUTES = {
  home: "/reflection",
  capture: "/reflection/capture",
  cards: "/reflection/cards",
  memory: "/reflection/memory",
  reflect: "/reflection/reflect",
  ask: "/reflection/ask"
} as const;

export const REFLECTION_DESKTOP_NAV = [
  { href: REFLECTION_ROUTES.home, label: "今天", match: "exact" },
  { href: REFLECTION_ROUTES.cards, label: "卡片", match: "prefix" },
  { href: REFLECTION_ROUTES.memory, label: "记忆", match: "prefix" },
  { href: REFLECTION_ROUTES.reflect, label: "回看", match: "prefix" },
  { href: REFLECTION_ROUTES.ask, label: "问问过去", match: "prefix" }
] as const;

export const REFLECTION_MOBILE_NAV = [
  { href: REFLECTION_ROUTES.home, label: "今天", icon: "今", match: "exact" },
  { href: REFLECTION_ROUTES.cards, label: "卡片", icon: "卡", match: "prefix" },
  { href: REFLECTION_ROUTES.capture, label: "开始表达", icon: "+", match: "prefix", primary: true },
  { href: REFLECTION_ROUTES.reflect, label: "回看", icon: "回", match: "prefix" },
  { href: REFLECTION_ROUTES.ask, label: "问问", icon: "问", match: "prefix" }
] as const;

export const REFLECTION_TRUST_COPY =
  "原始表达会保留为可核对的来源；整理出的内容由你决定是否保存为卡片或长期记住。";

export const REFLECTION_ASK_EXAMPLES = [
  "我最近反复在想什么？",
  "我为什么做过那个决定？",
  "有哪些事情我说过要继续做？"
] as const;

export function reflectionSessionPath(reflectionId: string) {
  return `/reflection/sessions/${encodeURIComponent(reflectionId)}`;
}

export function reflectionCardPath(cardId: string) {
  return `/reflection/cards/${encodeURIComponent(cardId)}`;
}

export function reflectionMemoryPath(memoryId: string) {
  return `/reflection/memory/${encodeURIComponent(memoryId)}`;
}

export function reflectionRouteIsActive(
  pathname: string,
  item: { href: string; match: "exact" | "prefix" }
) {
  return item.match === "exact"
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
}
