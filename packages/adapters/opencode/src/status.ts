// Status in `prompt.footer` (r14 H4): the host allocates the space and hides
// it during composer/help dialogs. Never an absolute zIndex overlay.

import { displayText } from '@murmo/text';
import { type OpenCodeApi, STATUS_COLUMNS, STATUS_MAX_ROWS } from './types.ts';

export function footerRows(text: string | null): string[] {
  if (!text) return [];
  const parts = text.split(' | ');
  const kept =
    parts.length <= STATUS_MAX_ROWS ? parts : [parts[0] ?? '', ...parts.slice(parts.length - (STATUS_MAX_ROWS - 1))];
  return kept
    .map((row) => displayText(row.replace(/\s+/g, ' ')).slice(0, STATUS_COLUMNS))
    .filter((row) => row.length > 0);
}

export interface StatusBounds {
  readonly id?: string;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
  readonly parent?: string;
  readonly mounted: number;
}

export interface StatusSurface {
  set(value: string | null): void;
  get(): string;
  present(): boolean;
  bounds(): StatusBounds | null;
  suppress(value: boolean): void;
  dispose(): void;
  readonly claimed: boolean;
}

interface SlotAnchor {
  visible?: boolean;
  isDestroyed?: boolean;
  width?: number;
  height?: number;
  id?: string;
  parent?: { readonly id?: string };
}

/**
 * Claims `prompt.footer` additively. The render function is a descriptor the
 * host's Solid slot can wrap; tests assert the claim without Solid.
 */
export function createStatusSurface(api: OpenCodeApi): StatusSurface {
  let text = '';
  let suppressed = false;
  let mounted = 0;
  let anchor: SlotAnchor | undefined;
  let claimed = false;
  let disposeSlot: (() => void) | undefined;

  const rows = () => (suppressed ? [] : footerRows(text || null));

  try {
    disposeSlot = api.ui.slot({
      append: 'prompt.footer',
      render: () => {
        mounted++;
        const body = rows();
        return {
          tag: 'box',
          ref: (node: SlotAnchor) => {
            anchor = node;
          },
          width: '100%',
          height: Math.max(1, body.length),
          flexDirection: 'column',
          children: body.map((row) => ({ tag: 'text', width: '100%', content: row })),
        };
      },
    });
    claimed = true;
  } catch {
    claimed = false;
  }

  return {
    set(value) {
      text = value ?? '';
    },
    get: () => text,
    present() {
      if (!anchor) return false;
      for (let node: SlotAnchor | undefined = anchor; node; node = node.parent as SlotAnchor | undefined) {
        if (node.visible === false || node.isDestroyed || (node.width ?? 1) <= 0 || (node.height ?? 1) <= 0) {
          return false;
        }
      }
      return true;
    },
    bounds() {
      if (!anchor) return null;
      return {
        ...(anchor.id ? { id: anchor.id } : {}),
        width: anchor.width ?? 0,
        height: anchor.height ?? 0,
        visible: anchor.visible !== false,
        ...(anchor.parent?.id ? { parent: anchor.parent.id } : {}),
        mounted,
      };
    },
    suppress(value) {
      suppressed = value;
    },
    dispose() {
      disposeSlot?.();
      disposeSlot = undefined;
      anchor = undefined;
      claimed = false;
    },
    get claimed() {
      return claimed;
    },
  };
}
