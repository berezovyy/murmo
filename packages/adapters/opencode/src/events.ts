// OpenCode 2.1.1: live startup stayed blocked in round 14 (E10). Advertise no
// event capabilities until a no-network live run passes.

import { doctorLinesFor, opencodeEventCaps } from '@murmo/core';

export function opencodeEventDoctor(): { name: string; detail: string }[] {
  return doctorLinesFor('opencode', opencodeEventCaps());
}
