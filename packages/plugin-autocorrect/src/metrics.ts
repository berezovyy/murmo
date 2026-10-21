// Local counters only: applied, rejected, abstained by reason. Nothing leaves
// the machine. Doctor (phase 27) prints these numbers.

export type AbstainReason = 'paste' | 'unknown-origin' | 'skip' | 'mode' | 'disabled' | 'language' | 'origin';

export interface AutocorrectMetrics {
  applied: number;
  rejected: number;
  abstained: Record<AbstainReason, number>;
}

export function emptyMetrics(): AutocorrectMetrics {
  return {
    applied: 0,
    rejected: 0,
    abstained: {
      paste: 0,
      'unknown-origin': 0,
      skip: 0,
      mode: 0,
      disabled: 0,
      language: 0,
      origin: 0,
    },
  };
}

export function formatDoctorMetrics(metrics: AutocorrectMetrics, disabled?: string): string {
  const parts = [
    `applied ${metrics.applied}`,
    `rejected ${metrics.rejected}`,
    `abstained paste=${metrics.abstained.paste} unknown-origin=${metrics.abstained['unknown-origin']} skip=${metrics.abstained.skip} mode=${metrics.abstained.mode}`,
  ];
  if (disabled) parts.push(disabled);
  return `autocorrect: ${parts.join('; ')}`;
}
