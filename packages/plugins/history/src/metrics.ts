// Numbers only, never text (knowledge § 7).

export interface HistoryMetrics {
  recorded: number;
  searches: number;
  inserts: number;
  staleDrops: number;
}

export function emptyMetrics(): HistoryMetrics {
  return { recorded: 0, searches: 0, inserts: 0, staleDrops: 0 };
}

export function formatDoctorStats(
  metrics: HistoryMetrics,
  extra?: { readonly enabled?: boolean; readonly prompts?: number; readonly merged?: string },
): string {
  const parts = [
    extra?.enabled === true ? 'on' : 'off',
    `prompts ${extra?.prompts ?? 0}`,
    extra?.merged ? `merged ${extra.merged}` : 'never merged',
    `recorded ${metrics.recorded}`,
    `searches ${metrics.searches}`,
    `inserts ${metrics.inserts}`,
  ];
  return `history: ${parts.join('; ')}`;
}
