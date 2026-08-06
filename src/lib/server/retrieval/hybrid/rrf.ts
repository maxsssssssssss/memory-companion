export type RrfRankedItem = {
  id: string;
  rank: number;
};

export type RrfResult = {
  id: string;
  score: number;
  ranks: Record<string, number>;
};

export function reciprocalRankFusion(
  rankings: Readonly<Record<string, readonly RrfRankedItem[]>>,
  options: {
    rankConstant?: number;
    limit?: number;
    channelWeights?: Readonly<Record<string, number>>;
  } = {}
) {
  const rankConstant = Math.max(1, options.rankConstant ?? 60);
  const fused = new Map<string, RrfResult>();
  for (const [channel, items] of Object.entries(rankings)) {
    const channelWeight = Math.max(0, options.channelWeights?.[channel] ?? 1);
    if (channelWeight === 0) continue;
    const seen = new Set<string>();
    for (const item of items) {
      if (!item.id || item.rank < 1 || seen.has(item.id)) continue;
      seen.add(item.id);
      const current = fused.get(item.id) ?? { id: item.id, score: 0, ranks: {} };
      current.score += channelWeight / (rankConstant + item.rank);
      current.ranks[channel] = item.rank;
      fused.set(item.id, current);
    }
  }
  return [...fused.values()]
    .sort((left, right) =>
      right.score - left.score ||
      Math.min(...Object.values(left.ranks)) - Math.min(...Object.values(right.ranks)) ||
      left.id.localeCompare(right.id)
    )
    .slice(0, Math.max(1, options.limit ?? 50));
}
