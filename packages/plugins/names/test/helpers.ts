import type { NameCandidate } from '@murmo/vocab';
import { wordKey } from '@murmo/vocab';
import { memoryBackend, namesPlugin } from '../src/index.ts';

export function candidate(
  name: string,
  kind = 'class',
  file = 'src/outbox/worker.rs',
  line = 12,
  refs = 9,
  owner = '',
): NameCandidate {
  const parts = name.split(/::|\./);
  return {
    id: 0,
    name,
    key: wordKey(name),
    refs,
    location: { kind, file, line },
    locations: 1,
    member: owner ? wordKey(owner) : wordKey(parts[parts.length - 1] ?? name),
  };
}

export const FIXTURE: NameCandidate[] = [
  candidate('OutboxWorker', 'class', 'src/outbox/worker.rs', 12, 9),
  candidate('HttpServerConfig', 'type', 'src/http/config.rs', 4, 5),
  candidate('OutboxWorker::drain_queue', 'method', 'src/outbox/worker.rs', 40, 3, 'OutboxWorker'),
];

export function pluginOf(entries: NameCandidate[] = FIXTURE, settings: Record<string, unknown> = {}, host = '') {
  return namesPlugin(memoryBackend(entries, { english: ['the', 'config', 'worker'] }), settings, host);
}
