// Status in `prompt.footer` (r14 H4): the host allocates the space and hides
// it during composer/help dialogs. Never an absolute zIndex overlay.
// Nothing here may assume the host renders descriptors: a slot draws only a
// renderable built with the host's own @opentui/core (live on 2.1.1).

import { displayText } from '@murmo/text';
import { type OpenCodeApi, type OpenTuiCore, STATUS_COLUMNS, STATUS_MAX_ROWS, type TextOverlay } from './types.ts';

function clip(row: string): string {
  return row.length <= STATUS_COLUMNS ? row : `${row.slice(0, STATUS_COLUMNS - 1)}…`;
}

export function footerRows(text: string | null): string[] {
  if (!text) return [];
  const parts = text.split(' | ');
  const kept =
    parts.length <= STATUS_MAX_ROWS ? parts : [parts[0] ?? '', ...parts.slice(parts.length - (STATUS_MAX_ROWS - 1))];
  return kept.map((row) => clip(displayText(row.replace(/\s+/g, ' ')))).filter((row) => row.length > 0);
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
  parent?: SlotAnchor | null;
}

type FooterNode = TextOverlay & SlotAnchor & { destroyed?: boolean; murmoShows?: boolean };

// One live node per mounted prompt (home and session prompts are separate
// components); older mounts the host dropped without destroying are let go.
const MAX_MOUNTS = 4;

/**
 * Claims `prompt.footer` additively. The host's slot inserts whatever render
 * returns into its own tree, so render returns a real `TextRenderable` from
 * the host's `@opentui/core`; status changes write to the mounted nodes.
 */
export function createStatusSurface(api: OpenCodeApi, core: OpenTuiCore): StatusSurface {
  let text = '';
  let suppressed = false;
  let mounted = 0;
  let nodes: FooterNode[] = [];
  let claimed = false;
  let disposeSlot: (() => void) | undefined;

  const rows = () => (suppressed ? [] : footerRows(text || null));
  const gone = (node: FooterNode) => node.isDestroyed === true || node.destroyed === true;
  const paint = (node: FooterNode) => {
    const body = node.murmoShows === false ? [] : rows();
    node.content = body.join('\n');
    // The footer is one flex row shared with the host's location and key
    // hints: take only the columns the text needs.
    node.width = Math.max(1, ...body.map((row) => row.length));
    node.height = Math.max(1, body.length);
    node.visible = body.length > 0;
  };
  const repaint = () => {
    nodes = nodes.filter((node) => !gone(node));
    for (const node of nodes) paint(node);
    try {
      api.renderer.requestRender();
    } catch {
      // A torn-down renderer has nothing left to draw.
    }
  };

  const mount = (shows: boolean): FooterNode => {
    mounted++;
    const node = new core.TextRenderable(api.renderer, {
      id: `murmo-status-${mounted}`,
      width: 1,
      height: 1,
      wrapMode: 'none',
      truncate: true,
      flexShrink: 1,
      content: '',
    }) as FooterNode;
    node.murmoShows = shows;
    paint(node);
    nodes = [...nodes.filter((n) => !gone(n)).slice(1 - MAX_MOUNTS), node];
    return node;
  };

  // A session's prompt spans the terminal, so its footer has room. The home
  // screen's prompt is at most 75 columns and its footer row is already full
  // of host hints (live on 2.1.1: Murmo rows overflowed the box and squeezed
  // the location to "/"), so there status goes to the full-width home footer.
  const disposers: Array<() => void> = [];
  try {
    disposers.push(api.ui.slot({ append: 'prompt.footer', render: (input) => mount(!!input?.sessionID) }));
    claimed = true;
    disposers.push(api.ui.slot({ append: 'home.footer', render: () => mount(true) }));
  } catch {
    // An older host without the slot keeps whatever claim succeeded.
  }
  disposeSlot = () => {
    for (const dispose of disposers.splice(0)) dispose();
  };

  const anchor = () => nodes.filter((node) => !gone(node)).at(-1);

  return {
    set(value) {
      const next = value ?? '';
      if (next === text) return;
      text = next;
      repaint();
    },
    get: () => text,
    present() {
      const node = anchor();
      if (!node?.visible) return false;
      for (let at: SlotAnchor | null | undefined = node; at; at = at.parent) {
        if (at.visible === false || at.isDestroyed || (at.width ?? 1) <= 0 || (at.height ?? 1) <= 0) return false;
      }
      return true;
    },
    bounds() {
      const node = anchor();
      if (!node) return null;
      return {
        ...(node.id ? { id: node.id } : {}),
        width: node.width ?? 0,
        height: node.height ?? 0,
        visible: node.visible !== false,
        ...(node.parent?.id ? { parent: node.parent.id } : {}),
        mounted,
      };
    },
    suppress(value) {
      if (value === suppressed) return;
      suppressed = value;
      repaint();
    },
    dispose() {
      disposeSlot?.();
      disposeSlot = undefined;
      for (const node of nodes) if (!gone(node)) node.destroy();
      nodes = [];
      claimed = false;
    },
    get claimed() {
      return claimed;
    },
  };
}
