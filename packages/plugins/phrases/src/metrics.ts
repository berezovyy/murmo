// Local counters only: shown, accepted, dismissed, characters saved, stale
// drops. Numbers, never text (knowledge § 7, Espanso stats).

export interface PhraseMetrics {
  shown: number;
  accepted: number;
  dismissed: number;
  charactersSaved: number;
  staleDrops: number;
}

export function emptyMetrics(): PhraseMetrics {
  return { shown: 0, accepted: 0, dismissed: 0, charactersSaved: 0, staleDrops: 0 };
}

export function formatDoctorStats(metrics: PhraseMetrics, extra?: string): string {
  const parts = [
    `shown ${metrics.shown}`,
    `accepted ${metrics.accepted}`,
    `dismissed ${metrics.dismissed}`,
    `saved ${metrics.charactersSaved}`,
    `stale ${metrics.staleDrops}`,
  ];
  if (extra) parts.push(extra);
  return `phrases: ${parts.join('; ')}`;
}
