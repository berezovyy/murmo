// Startup capability probes. Notifications stay suppressed: a failed probe
// turns off that feature, never the whole adapter (r12 H3).

import { extraUndoKeys, PROBE_KEYS } from './keys.ts';
import { createStatusSurface, type StatusSurface } from './status.ts';
import { MURMO_HIGHLIGHT_REF, type OpenCodeApi, type OpenTuiCore, type TextareaEditor } from './types.ts';

export interface ProbeResult {
  readDraft: boolean;
  edit: boolean;
  measureText: boolean;
  multiline: boolean;
  selection: boolean;
  middle: boolean;
  normalization: boolean;
  ghost: boolean;
  menu: boolean;
  status: boolean;
  highlight: boolean;
  keys: readonly string[];
  checkpoints: number;
  opaqueParts: boolean;
}

function field(run: () => boolean): boolean {
  try {
    return run();
  } catch {
    return false;
  }
}

export function probeCheckpoints(textarea: TextareaEditor): { readonly ok: boolean; readonly checkpoints: number } {
  textarea.cursorOffset = textarea.editBuffer.measureText(textarea.plainText);
  const end = textarea.cursorOffset;
  textarea.setSelection(0, Math.min(3, end));
  textarea.insertText('the');
  const ok = textarea.plainText === 'the ';
  let checkpoints = 0;
  for (let n = 1; n <= 3; n++) {
    textarea.undo();
    if (textarea.plainText === 'teh ') {
      checkpoints = n;
      break;
    }
  }
  return { ok: ok && checkpoints > 0, checkpoints };
}

export function runProbes(api: OpenCodeApi, core: OpenTuiCore, status: StatusSurface | undefined): ProbeResult {
  const renderer = api.renderer;
  const textarea = new core.TextareaRenderable(renderer, { initialValue: 'teh ', width: 12, height: 2 });
  const readDraft = field(() => textarea.plainText === 'teh ' && textarea.cursorOffset >= 0);
  const measureText = field(() => typeof textarea.editBuffer.measureText === 'function');
  const measured = measureText ? probeCheckpoints(textarea) : { ok: false, checkpoints: 0 };
  const multiline = field(() => {
    textarea.replaceText('a\nb');
    return textarea.plainText === 'a\nb';
  });
  const selection = field(() => {
    textarea.cursorOffset = 2;
    textarea.setSelection(0, 1);
    const got = textarea.getSelection();
    textarea.clearSelection();
    return got?.start === 0 && got?.end === 1;
  });
  const middle = field(() => {
    textarea.replaceText('a teh z');
    textarea.cursorOffset = 5;
    textarea.setSelection(2, 5);
    textarea.insertText('the');
    return textarea.plainText === 'a the z';
  });
  const normalization = field(() => {
    const text = 'e\u0301 👨‍👩‍👧 🇺🇦 日本語\nx';
    textarea.replaceText(text);
    return textarea.plainText === text;
  });
  const opaqueParts = field(() => typeof textarea.extmarks.getAll === 'function');
  textarea.destroy();

  const seen = new Set<string>();
  let target = '';
  const intercept = (key: { preventDefault(): void; stopPropagation(): void }) => {
    seen.add(target);
    key.preventDefault();
    key.stopPropagation();
  };
  renderer.keyInput.prependListener('keypress', intercept);
  for (const key of PROBE_KEYS) {
    target = key;
    renderer.keyInput.processParsedKey({
      name: key.toLowerCase(),
      sequence: '',
      raw: '',
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      super: false,
    });
  }
  renderer.keyInput.removeListener('keypress', intercept);

  const ghost = field(() => {
    const node = new core.TextRenderable(renderer, { id: 'murmo-probe-ghost', content: 'probe' });
    renderer.root.add(node);
    const ok = node.plainText === 'probe' || node.content === 'probe';
    node.destroy();
    return ok;
  });
  const menu = ghost;
  const highlight = field(() => {
    const editor = new core.TextareaRenderable(renderer, { initialValue: 'abc', width: 8, height: 1 });
    const style = editor.syntaxStyle;
    const id = style.resolveStyleId('default') ?? style.registerStyle('default', {});
    editor.addHighlightByCharRange({ start: 0, end: 2, styleId: id, hlRef: MURMO_HIGHLIGHT_REF });
    const ok = editor.getLineHighlights(0).some((row) => row.hlRef === MURMO_HIGHLIGHT_REF);
    editor.removeHighlightsByRef(MURMO_HIGHLIGHT_REF);
    editor.destroy();
    return ok;
  });

  return {
    readDraft,
    edit: measured.ok,
    measureText,
    multiline,
    selection,
    middle,
    normalization,
    ghost,
    menu,
    status: status?.claimed === true,
    highlight,
    keys: PROBE_KEYS.filter((key) => seen.has(key)),
    checkpoints: measured.checkpoints,
    opaqueParts,
  };
}

export function undoBindingsAvailable(api: OpenCodeApi): boolean {
  try {
    return api.keymap.shortcuts('input.undo').length > 0 || extraUndoKeys(api.keymap).length > 0;
  } catch {
    return false;
  }
}

export function submitBindingsAvailable(api: OpenCodeApi, gesture: 'prompt.submit' | 'prompt.queue'): boolean {
  try {
    return api.keymap.shortcuts(gesture).length > 0;
  } catch {
    return false;
  }
}

export { createStatusSurface };
