// Reused overlay nodes for ghost and menu (lesson 19: one node per suggestion
// grew 207 MiB → 1.69 GB). Status is not an overlay. Dispose on teardown.

import type { PresentedMenuItem } from '@murmo/api/adapter';
import { clipToCells, displayText } from '@murmo/text';
import {
  MENU_WINDOW,
  type OpenCodeRenderer,
  type OpenTuiCore,
  type TextareaEditor,
  type TextOverlay,
} from './types.ts';

export interface OverlayState {
  ghost: string | null;
  menu: string | null;
}

const GHOST_CELLS = 88;

export class Overlay {
  readonly #renderer: OpenCodeRenderer;
  readonly #core: OpenTuiCore;
  readonly #nodes = new Map<string, TextOverlay>();
  readonly state: OverlayState = { ghost: null, menu: null };
  blocked = false;

  constructor(renderer: OpenCodeRenderer, core: OpenTuiCore) {
    this.#renderer = renderer;
    this.#core = core;
  }

  get size(): number {
    return this.#nodes.size;
  }

  node(name: 'ghost' | 'menu'): TextOverlay {
    let overlay = this.#nodes.get(name);
    if (!overlay) {
      overlay = new this.#core.TextRenderable(this.#renderer, {
        id: `murmo-${name}`,
        position: 'absolute',
        width: 88,
        height: name === 'menu' ? 8 : 1,
        zIndex: 1200,
        bg: '#101010',
        fg: name === 'ghost' ? '#888888' : '#aabbcc',
        content: '',
      });
      this.#renderer.root.add(overlay);
      this.#nodes.set(name, overlay);
    }
    return overlay;
  }

  showGhost(text: string | null, editor: TextareaEditor | undefined, measure: (s: string) => number): void {
    this.state.ghost = text;
    const clipped = text ? clipToCells(displayText(text).replace(/\n/g, ' '), GHOST_CELLS, measure) : null;
    this.#place('ghost', clipped, editor);
  }

  showMenu(items: readonly PresentedMenuItem[] | null, selected: number, editor: TextareaEditor | undefined): void {
    if (!items?.length) {
      this.state.menu = null;
      this.#place('menu', null, editor);
      return;
    }
    const start = Math.max(0, selected - (MENU_WINDOW - 1));
    const lines = items.slice(start, start + MENU_WINDOW).map((item, index) => {
      const mark = index + start === selected ? '> ' : '  ';
      const detail = (item.detail ?? '').split('\n')[0] ?? '';
      const owner = item.owner && !item.owner.startsWith('murmo') ? ` [${item.owner}]` : '';
      return displayText(`${mark}${item.label}  ${detail}${owner}`.trimEnd());
    });
    const body = lines.join('\n');
    this.state.menu = body;
    this.#place('menu', body, editor);
  }

  refresh(editor: TextareaEditor | undefined): void {
    this.#place('ghost', this.state.ghost, editor);
    this.#place('menu', this.state.menu, editor);
  }

  hide(): void {
    for (const overlay of this.#nodes.values()) overlay.visible = false;
  }

  dispose(): void {
    for (const overlay of this.#nodes.values()) overlay.destroy();
    this.#nodes.clear();
    this.state.ghost = null;
    this.state.menu = null;
  }

  #place(name: 'ghost' | 'menu', text: string | null, editor: TextareaEditor | undefined): void {
    const overlay = this.node(name);
    overlay.visible = !!text && !this.blocked;
    if (text) overlay.content = text;
    overlay.plainText = text ?? '';
    if (name === 'menu') overlay.height = text ? Math.min(8, text.split('\n').length + 1) : 8;
    if (text && editor) {
      const cursor = editor.visualCursor;
      overlay.left = Math.max(0, Math.min(editor.x + cursor.visualCol, this.#renderer.width - 88));
      const row = editor.y + cursor.visualRow;
      overlay.top = name === 'ghost' ? row : row + 9 <= this.#renderer.height ? row + 1 : Math.max(0, row - 8);
    }
    this.#renderer.requestRender();
  }
}
