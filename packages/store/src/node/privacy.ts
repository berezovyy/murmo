// Private mode (vision principle 6): on when `[privacy] private = true` or the
// flag file exists. While on, nothing learned is written, plugin storage
// writes are denied with reason `private mode`, and draft rescue saves
// nothing (phase 17 asks `isPrivate`). Trust approvals still save: they are
// explicit user actions. `murmo private on|off` writes only the flag.
import fsp from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StoreLayout } from '../layout.ts';
import { encodeRecord } from '../records.ts';
import { ensurePrivateDir, exists, type ModeRepairs, writeAtomic } from './files.ts';

export interface Privacy {
  /** The flag file or the config says private. Checked on every learned write. */
  isPrivate(): Promise<boolean>;
  /** Only the flag file (what `murmo private` controls). */
  flag(): Promise<boolean>;
  setFlag(on: boolean, now?: number): Promise<void>;
  /** The merged config's `[privacy] private`, updated on each config reload. */
  setConfigPrivate(on: boolean): void;
}

export function createPrivacy(layout: StoreLayout, configPrivate = false, repairs?: ModeRepairs): Privacy {
  let fromConfig = configPrivate;
  const flag = () => exists(layout.privateFlag);
  return {
    isPrivate: async () => fromConfig || (await flag()),
    flag,
    async setFlag(on, now = Date.now()) {
      if (on) {
        await ensurePrivateDir(dirname(layout.privateFlag), layout.roots.state, repairs);
        await writeAtomic(layout.privateFlag, encodeRecord({ schema: 1, since: now }), { durable: true });
      } else {
        await fsp.rm(layout.privateFlag, { force: true });
      }
    },
    setConfigPrivate(on) {
      fromConfig = on;
    },
  };
}
