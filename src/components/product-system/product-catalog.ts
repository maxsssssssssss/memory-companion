export const productIds = ["date_companion", "daily_reflection", "office_review"] as const;

export type ProductId = (typeof productIds)[number];

export type ProductDefinition = Readonly<{
  id: ProductId;
  name: string;
  description: string;
  href: string | null;
  mark: string;
}>;

export const PRODUCT_CATALOG: readonly ProductDefinition[] = [
  {
    id: "date_companion",
    name: "约会陪伴",
    description: "记录一次相处，回看你和 Ta 之间值得留下的内容。",
    href: "/date-companion/a",
    mark: "约"
  },
  {
    id: "daily_reflection",
    name: "日常复盘",
    description: "自然表达，把重要的想法整理成可以继续使用的内容。",
    href: "/reflection",
    mark: "记"
  },
  {
    id: "office_review",
    name: "办公复盘",
    description: "为工作沟通与决策保留连续的复盘空间。",
    href: null,
    mark: "复"
  }
] as const;

export function isProductId(value: string | null): value is ProductId {
  return productIds.includes(value as ProductId);
}
