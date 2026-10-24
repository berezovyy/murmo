// Where a word is code, not prose: the `code` and `identifier` skips of
// english-word-boundary-v1. A fix is decided at the boundary right after the
// word, before the rest of the line exists, so only the text before the word
// counts. Each rule names one kind of evidence; a word that fits none is prose.

/**
 * Fences and inline code, matching engine-v2 `inCode`. A shortcut must not
 * expand inside these spans either (WordPolicy.inCode).
 */
export function inCode(prefix: string): boolean {
  // Fast path: a 1.1M-character draft with no ticks must not walk every unit (E8).
  if (!prefix.includes('`') && !prefix.includes('~')) return false;
  let fence = '';
  let inline = 0;
  for (const line of prefix.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const mark = marker[1] as string;
      if (!fence) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = '';
      continue;
    }
    if (fence) continue;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') {
        i++;
        continue;
      }
      if (line[i] !== '`') continue;
      let n = 1;
      while (line[i + n] === '`') n++;
      if (!inline) inline = n;
      else if (inline === n) inline = 0;
      i += n - 1;
    }
  }
  return fence.length > 0 || inline > 0;
}

/** A Markdown indented code block line: a tab or four spaces before any text. */
const INDENTED = /^(?:\t| {4})/;

/**
 * A shell command line: a `$ ` prompt, the hosts' `!` shell mode, or a command
 * whose arguments are literal text (`echo teh` prints `teh`).
 */
const SHELL = /^\s*(?:\$\s|!|(?:echo|printf)\s)/;

/**
 * Braces or an assignment/comparison operator earlier on the line (`{"teh": 1}`,
 * `x = teh`, `a == teh`). Prose has neither; an `=` inside a word (a URL query)
 * is not an operator.
 */
const CODE_SYNTAX = /[{}]|(?:^|\s)[-+*/%&|^!<>=:?.~]*=[-+*/%&|^!<>=:?.~]*(?=\s|$)/;

/**
 * A mapping key: the line's first token followed by `:` (`teh: 1`,
 * `"teh": 1`). A bare key starts lowercase so a prose label (`Note: …`)
 * stays prose. The line is then data, the value included.
 */
const MAPPING_LINE = /^\s*(?:"[^"\n]*"|'[^'\n]*'|[a-z_][\w.-]*)\s*:(?:\s|$)/;

/**
 * The name slot of a declaration: the word right after a declaration keyword
 * that opens the line (`const teh`, `def teh`, `pub fn teh`). The name is an
 * identifier whatever it looks like; the rest of the line is judged on its own.
 */
const DECLARATION =
  /^\s*(?:(?:export|pub|public|private|protected|static|async|abstract|final)\s+)*(?:const|let|var|val|def|fn|func|function|class|struct|enum|interface|trait|impl|typedef)\s+$/;

export type CodeContext = 'fence' | 'indented' | 'shell' | 'syntax' | 'mapping' | 'declared-name';

/**
 * Why the word that starts at `start` is code, or null when it reads as prose.
 * `cursor` is where the typed `boundary` lands, after any closing quote.
 */
export function codeContext(text: string, start: number, cursor: number, boundary: string): CodeContext | null {
  const prefix = text.slice(0, start);
  if (inCode(prefix)) return 'fence';
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (INDENTED.test(line)) return 'indented';
  if (SHELL.test(line)) return 'shell';
  if (CODE_SYNTAX.test(line)) return 'syntax';
  if (MAPPING_LINE.test(line) || MAPPING_LINE.test(line + text.slice(start, cursor) + boundary)) return 'mapping';
  if (DECLARATION.test(line)) return 'declared-name';
  return null;
}
