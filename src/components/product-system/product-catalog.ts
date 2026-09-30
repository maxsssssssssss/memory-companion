export const productIds = ["date_companion", "daily_reflection", "office_review", "learning_organizer"] as const;

export type ProductId = (typeof productIds)[number];

export type ProductDefinition = Readonly<{
  id: ProductId;
  name: string;
  description: string;
  href: string | null;
  mark: string;
  trial?: boolean;
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
    name: "工作复盘",
    description: "上传会议录音，核对讨论、决定、承诺和行动事项。",
    href: "/work-review",
    mark: "复"
  },
  {
    id: "learning_organizer",
    name: "学习整理",
    description: "整理课件、录音和笔记，理清知识关系，再用 Quiz 检查理解。",
    href: "/learning",
    mark: "学",
    trial: true
  }
] as const;

export function isProductId(value: string | null): value is ProductId {
  return productIds.includes(value as ProductId);
}
