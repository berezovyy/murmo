// Reused overlay nodes for ghost and menu (lesson 19: one node per suggestion
// grew 207 MiB → 1.69 GB). Status is not an overlay. Dispose on teardown.
//
// Both nodes are absolute children of the prompt's box, so the host's layout
// moves them with the prompt (centred on the home screen, at the bottom of a
// session, after a resize). The menu sits right above the box, like
// OpenCode's own `/` and `@` lists, as wide as the box and never wider than
// the terminal; it drops below the box only when there is more room there.
// A host without a box to draw into gets them on the root at screen
// coordinates instead.

import type { PresentedMenuItem } from '@murmo/api/adapter';
import { clipToCells, displayText } from '@murmo/text';
import {
  MENU_WINDOW,
  type OpenCodeRenderer,
  type OpenTuiCore,
  type PromptBox,
  type TextareaEditor,
  type TextOverlay,
} from './types.ts';

export interface OverlayState {
  ghost: string | null;
  menu: string | null;
}

type Measure = (text: string) => number;
type Name = 'ghost' | 'menu';

interface Placed {
  readonly node: TextOverlay;
  readonly host: PromptBox | null;
}

interface MenuRows {
  readonly rows: readonly string[];
  readonly selected: number;
}

const columns: Measure = (text) => text.length;

/** The window of at most `size` rows that keeps `selected` in view. */
function windowOf(rows: number, selected: number, size: number): number {
  return Math.min(Math.max(0, selected - (size - 1)), Math.max(0, rows - size));
}

export class Overlay {
  readonly #renderer: OpenCodeRenderer;
  readonly #core: OpenTuiCore;
  readonly #nodes = new Map<Name, Placed>();
  readonly state: OverlayState = { ghost: null, menu: null };
  #menu: MenuRows | null = null;
  #measure: Measure = columns;
  #blocked = false;

  constructor(renderer: OpenCodeRenderer, core: OpenTuiCore) {
    this.#renderer = renderer;
    this.#core = core;
  }

  get size(): number {
    return this.#nodes.size;
  }

  get blocked(): boolean {
    return this.#blocked;
  }

  /** The node for `name`, under the editor's box; made again only when the prompt changed. */
  node(name: Name, editor?: TextareaEditor): TextOverlay {
    const host = drawableBox(editor);
    const current = this.#nodes.get(name);
    if (current && current.host === host && !current.node.isDestroyed) return current.node;
    if (current && !current.node.isDestroyed) current.node.destroy();
    const node = new this.#core.TextRenderable(this.#renderer, {
      id: `murmo-${name}`,
      position: 'absolute',
      width: 1,
      height: 1,
      zIndex: 1200,
      bg: '#101010',
      fg: name === 'ghost' ? '#888888' : '#aabbcc',
      wrapMode: 'none',
      content: '',
    });
    if (host?.add) host.add(node);
    else this.#renderer.root.add(node);
    this.#nodes.set(name, { node, host });
    return node;
  }

  showGhost(text: string | null, editor: TextareaEditor | undefined, measure: Measure): void {
    this.#measure = measure;
    this.state.ghost = text ? displayText(text).replace(/\n/g, ' ') : null;
    this.#placeGhost(editor);
    this.#renderer.requestRender();
  }

  /**
   * Rows read `> ;tst  Run the project test suite.`: the label, then the
   * description. Built-in rows carry no owner; the core already prefixes a
   * third-party row with `[plugin id]`.
   */
  showMenu(
    items: readonly PresentedMenuItem[] | null,
    selected: number,
    editor: TextareaEditor | undefined,
    measure: Measure,
  ): void {
    this.#measure = measure;
    if (!items?.length) {
      this.#menu = null;
      this.state.menu = null;
    } else {
      const rows = items.map((item, index) => {
        const mark = index === selected ? '> ' : '  ';
        const detail = (item.detail ?? '').split('\n')[0] ?? '';
        return displayText(`${mark}${item.label}  ${detail}`.trimEnd());
      });
      this.#menu = { rows, selected: Math.min(Math.max(0, selected), rows.length - 1) };
    }
    this.#placeMenu(editor);
    this.#renderer.requestRender();
  }

  /** Hide both while an OpenCode panel or dialog is over the prompt; show them again after. */
  setBlocked(blocked: boolean, editor: TextareaEditor | undefined): void {
    if (blocked === this.#blocked) return;
    this.#blocked = blocked;
    this.refresh(editor);
  }

  refresh(editor: TextareaEditor | undefined): void {
    this.#placeGhost(editor);
    this.#placeMenu(editor);
    this.#renderer.requestRender();
  }

  hide(): void {
    for (const { node } of this.#nodes.values()) node.visible = false;
  }

  dispose(): void {
    for (const { node } of this.#nodes.values()) if (!node.isDestroyed) node.destroy();
    this.#nodes.clear();
    this.#menu = null;
    this.state.ghost = null;
    this.state.menu = null;
  }

  #placeGhost(editor: TextareaEditor | undefined): void {
    const text = this.state.ghost;
    if (!text || !editor || this.#blocked) {
      this.#hideNode('ghost');
      return;
    }
    const node = this.node('ghost', editor);
    const origin = this.#origin(editor);
    const cursor = editor.visualCursor;
    const x = editor.x + cursor.visualCol;
    const width = Math.min(editor.x + editor.width, this.#renderer.width) - x;
    const shown = width > 0 ? clipToCells(text, width, this.#measure) : '';
    node.content = shown;
    node.width = Math.max(1, this.#measure(shown));
    node.height = 1;
    node.left = x - origin.x;
    node.top = editor.y + cursor.visualRow - origin.y;
    node.visible = shown.length > 0;
  }

  #placeMenu(editor: TextareaEditor | undefined): void {
    const menu = this.#menu;
    if (!menu || !editor || this.#blocked) {
      this.state.menu = null;
      this.#hideNode('menu');
      return;
    }
    const node = this.node('menu', editor);
    const origin = this.#origin(editor);
    const box = screenBox(editor);
    const screenWidth = Math.max(1, this.#renderer.width);
    const left = Math.min(Math.max(0, box.x), screenWidth - 1);
    const width = Math.max(1, Math.min(box.width, screenWidth - left));
    const above = Math.max(0, box.y);
    const below = Math.max(0, this.#renderer.height - (box.y + box.height));
    const wanted = Math.min(MENU_WINDOW, menu.rows.length);
    const upward = above >= wanted || above >= below;
    const count = Math.max(1, Math.min(wanted, upward ? above : below));
    const start = windowOf(menu.rows.length, menu.selected, count);
    const lines = menu.rows.slice(start, start + count).map((row) => clipToCells(row, width, this.#measure));
    const body = lines.join('\n');
    this.state.menu = body;
    node.content = body;
    node.width = width;
    node.height = lines.length;
    node.left = left - origin.x;
    node.top = (upward ? box.y - lines.length : box.y + box.height) - origin.y;
    node.visible = true;
  }

  #hideNode(name: Name): void {
    const placed = this.#nodes.get(name);
    if (placed && !placed.node.isDestroyed) placed.node.visible = false;
  }

  /** Screen position the node's `left`/`top` count from: its box, or the screen. */
  #origin(editor: TextareaEditor): { x: number; y: number } {
    const host = drawableBox(editor);
    return host ? { x: host.x ?? 0, y: host.y ?? 0 } : { x: 0, y: 0 };
  }
}

/** The prompt's box when the host lets Murmo draw into it. */
function drawableBox(editor: TextareaEditor | undefined): PromptBox | null {
  const box = editor?.parent;
  if (!box || box.isDestroyed || typeof box.add !== 'function') return null;
  if (typeof box.x !== 'number' || typeof box.y !== 'number') return null;
  return box;
}

/** The prompt box on screen; the textarea itself when the host gives no box. */
function screenBox(editor: TextareaEditor): { x: number; y: number; width: number; height: number } {
  const box = editor.parent;
  if (box && !box.isDestroyed) {
    const { x, y, width, height } = box;
    if (x !== undefined && y !== undefined && width !== undefined && height !== undefined && width > 0 && height > 0) {
      return { x, y, width, height };
    }
  }
  return { x: editor.x, y: editor.y, width: editor.width, height: editor.height };
}
