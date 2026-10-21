import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapsPatch } from '@murmo/core/testing';
import { createHarness, type Harness, MANUAL_EPOCH_MS } from '@murmo/core/testing';
import type { DraftIdentity } from '@murmo/store';
import { openStore, type Store } from '@murmo/store/node';
import { EMPTY_DELETE_MS, IDLE_MS, rescuePlugin } from '../src/index.ts';

export const PROJECT = createHash('sha256').update('rescue-test').digest('hex');

/** ZWJ family, flag, decomposed accent, CJK, two newlines (lesson 33). */
export const UNICODE = '👨‍👩‍👧‍👦\n🇺🇸\ne\u0301\n你好\n\n';

export type HostProfile = 'pi' | 'opencode' | 'codex' | 'claude';

/** Capability patches; Claude keeps atomic edits on the fake host (fill is phase 24). */
export const HOST_CAPS: Record<HostProfile, CapsPatch> = {
  pi: {},
  opencode: {},
  codex: { inline: { maxBytes: 900 } },
  claude: { inline: { maxBytes: 1024 } },
};

export function tempStore(prefix = 'murmo-rescue-'): { store: Promise<Store>; dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const roots = {
    data: join(dir, 'data', 'murmo'),
    state: join(dir, 'state', 'murmo'),
    cache: join(dir, 'cache', 'murmo'),
  };
  return {
    dir,
    store: openStore({ roots }),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function identity(session: string, host: DraftIdentity['host'] = 'fake'): DraftIdentity {
  return { project: PROJECT, host, session };
}

export async function withRescue(
  store: Store,
  session: string,
  options: { host?: DraftIdentity['host']; caps?: CapsPatch; private?: boolean } = {},
): Promise<Harness> {
  const id = identity(session, options.host ?? 'fake');
  if (options.private) store.privacy.setConfigPrivate(true);
  return createHarness({
    // Direct runner: the executor's activate deadline is a session-clock timer,
    // and settle would fire it while we await fs (the real clock has 50 ms).
    runner: 'direct',
    plugins: [
      rescuePlugin({
        drafts: store.drafts,
        identity: id,
        isPrivate: () => store.privacy.isPrivate(),
      }),
    ],
    ...(options.caps ? { caps: options.caps } : {}),
  });
}

export async function until<T>(fn: () => Promise<T | undefined | false | null>, message: string): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(message);
}

export async function waitSaved(store: Store, id: DraftIdentity) {
  return until(() => store.drafts.read(id), `draft ${id.session} was not saved`);
}

export async function waitGone(store: Store, id: DraftIdentity) {
  await until(
    async () => ((await store.drafts.read(id)) === undefined ? 'gone' : undefined),
    `draft ${id.session} is still on disk`,
  );
}

export async function idleSave(h: Harness, store: Store, id: DraftIdentity) {
  await h.driver.wait(IDLE_MS);
  await h.driver.settle();
  return waitSaved(store, id);
}

/** Wait until background lock/cleanup/lookup has an offer, then surface it. */
export async function presentOffer(h: Harness): Promise<string> {
  return until(async () => {
    await h.driver.move(0);
    await h.driver.settle();
    const status = h.adapter.status ?? '';
    return /Restore your last draft/.test(status) ? status : undefined;
  }, 'offer never appeared');
}

export async function assertNoOffer(h: Harness): Promise<void> {
  await new Promise((r) => setTimeout(r, 40));
  await h.driver.move(0);
  await h.driver.settle();
  const status = h.adapter.status ?? '';
  if (/Restore your last draft/.test(status)) throw new Error(`unexpected offer: ${status}`);
}

export { EMPTY_DELETE_MS, IDLE_MS, MANUAL_EPOCH_MS };
