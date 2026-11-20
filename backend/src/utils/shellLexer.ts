/**
 * Minimal shell-aware lexer used by run_shell's security policy.
 *
 * The policy must see a command the way the shell that will run it sees it.
 * A whitespace split gets that wrong in ways that are exploitable:
 * `cat "../../etc/passwd"` keeps its quotes and resolves inside the root,
 * `echo pwn>../out` hides its redirect inside one word, and `\.\./secret`
 * resolves inside the root before bash strips the backslashes.
 *
 * This lexer splits pipeline/chain operators and redirects that sit outside
 * quotes (with or without surrounding whitespace), strips quoting the way the
 * target shell would, and flags every word that the shell would expand
 * (variables, `~`, brace expansion, cmd `%VAR%`) so the caller can reject it
 * instead of guessing what it expands to.
 *
 * Two dialects:
 * - `posix` (bash / sh, including git-bash on Windows): `'…'` is literal,
 *   `"…"` allows `\` escapes and `$` expansion, `\` escapes outside quotes.
 * - `cmd` (cmd.exe fallback on Windows without git-bash): only `"…"` quotes,
 *   `^` is the escape character, `\` is a path separator, `%VAR%` expands.
 */

export type ShellDialect = 'posix' | 'cmd';

export interface ShellWord {
  /** The word after quote removal — what the program receives as argv. */
  text: string;
  /** True when the shell would expand part of this word ($VAR, ~, {a,b}, %VAR%). */
  expands: boolean;
  /** True when the word contains unquoted glob characters (* ? [). */
  globs: boolean;
}

export interface ShellStage {
  /** The raw source text of the stage, trimmed (used for prefix allowlisting). */
  raw: string;
  words: ShellWord[];
  /** File targets of redirects (`> f`, `>>f`, `<f`, `2>f`, `&>f`). fd dups like `2>&1` are excluded. */
  redirects: ShellWord[];
}

export interface LexedCommand {
  stages: ShellStage[];
  /** True if the command needs a real shell (multiple stages, redirects, or globs/expansions). */
  needsShell: boolean;
}

export class ShellSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellSyntaxError';
  }
}

const BRACE_EXPANSION = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;
const CMD_VAR_EXPANSION = /%[^%\s]+%|![^!\s]+!/;

export function lexShellCommand(command: string, dialect: ShellDialect = 'posix'): LexedCommand {
  const stages: ShellStage[] = [];
  let needsShell = false;

  let words: ShellWord[] = [];
  let redirects: ShellWord[] = [];
  let stageStart = 0;

  // Current word accumulation.
  let text = '';
  let unquotedText = ''; // only the characters that appeared outside any quotes
  let inWord = false;
  let expands = false;
  let globs = false;
  // When set, the next completed word is a redirect target instead of an argv word.
  let pendingRedirect: 'file' | 'fd-or-file' | null = null;

  const finishWord = () => {
    if (!inWord) return;
    if (dialect === 'posix' && BRACE_EXPANSION.test(unquotedText)) expands = true;
    if (dialect === 'cmd' && CMD_VAR_EXPANSION.test(text)) expands = true;
    const word: ShellWord = { text, expands, globs };
    if (pendingRedirect) {
      // `>&2`, `2>&1`, `<&-` duplicate/close fds rather than naming a file.
      const isFdDup = pendingRedirect === 'fd-or-file' && /^(?:\d+-?|-)$/.test(text);
      if (!isFdDup) redirects.push(word);
      pendingRedirect = null;
    } else {
      words.push(word);
    }
    text = '';
    unquotedText = '';
    inWord = false;
    expands = false;
    globs = false;
  };

  const finishStage = (end: number) => {
    finishWord();
    if (pendingRedirect) throw new ShellSyntaxError('Redirect operator is missing its target.');
    const raw = command.slice(stageStart, end).trim();
    if (words.length > 0 || redirects.length > 0) {
      stages.push({ raw, words, redirects });
    } else if (raw.length > 0) {
      throw new ShellSyntaxError(`Empty command near '${raw.slice(0, 20)}'.`);
    }
    words = [];
    redirects = [];
  };

  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i]!;
    const next = command[i + 1];

    // ── Quotes ───────────────────────────────────────────────────────────
    if (ch === "'" && dialect === 'posix') {
      const close = command.indexOf("'", i + 1);
      if (close === -1) throw new ShellSyntaxError('Unclosed single quote.');
      text += command.slice(i + 1, close);
      inWord = true;
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const c = command[j]!;
        if (c === '"') { closed = true; break; }
        if (dialect === 'posix') {
          if (c === '\\' && j + 1 < n && '"\\$`\n'.includes(command[j + 1]!)) {
            text += command[j + 1];
            j += 2;
            continue;
          }
          if (c === '$') expands = true;
        }
        text += c;
        j++;
      }
      if (!closed) throw new ShellSyntaxError('Unclosed double quote.');
      inWord = true;
      i = j + 1;
      continue;
    }

    // ── Escapes ──────────────────────────────────────────────────────────
    if ((ch === '\\' && dialect === 'posix') || (ch === '^' && dialect === 'cmd')) {
      if (i + 1 >= n) throw new ShellSyntaxError('Trailing escape character.');
      if (command[i + 1] === '\n') { i += 2; continue; } // line continuation
      text += command[i + 1];
      inWord = true;
      i += 2;
      continue;
    }

    // ── Whitespace ───────────────────────────────────────────────────────
    if (ch === ' ' || ch === '\t') {
      finishWord();
      i++;
      continue;
    }

    // ── Stage separators: || && ; | & newline ────────────────────────────
    if (ch === '\n' || ch === '\r' || ch === ';' || ch === '|' || (ch === '&' && next !== '>')) {
      if (ch === '\r' && next === '\n') { i++; continue; }
      if (ch === '|' && next === '&') {
        throw new ShellSyntaxError("'|&' pipes are not supported.");
      }
      finishStage(i);
      needsShell = true;
      const twoChar = (ch === '|' && next === '|') || (ch === '&' && next === '&');
      i += twoChar ? 2 : 1;
      stageStart = i;
      continue;
    }

    // ── Redirects: [n]> [n]>> [n]< >| &> &>> >& <& ───────────────────────
    if (ch === '>' || ch === '<' || (ch === '&' && next === '>')) {
      // A word made only of digits right before the operator is an fd number (`2>`).
      if (inWord && /^\d+$/.test(text) && text === unquotedText) {
        text = '';
        unquotedText = '';
        inWord = false;
      } else {
        finishWord();
      }
      if (pendingRedirect) throw new ShellSyntaxError('Redirect operator is missing its target.');
      needsShell = true;

      let j = i;
      if (ch === '&') j++; // `&>` / `&>>`
      const op = command[j]!;
      j++;
      if (op === '<' && command[j] === '<') {
        throw new ShellSyntaxError('Here-documents (<<) are not supported.');
      }
      if (command[j] === '(') {
        throw new ShellSyntaxError('Process substitution (<(...) / >(...)) is not permitted.');
      }
      let target: 'file' | 'fd-or-file' = 'file';
      if (op === '>' && command[j] === '>') j++;
      else if (op === '>' && command[j] === '|') j++;
      else if (op === '<' && command[j] === '>') j++;
      if (ch !== '&' && command[j] === '&') { j++; target = 'fd-or-file'; }
      if (command[j] === '(') {
        throw new ShellSyntaxError('Process substitution (<(...) / >(...)) is not permitted.');
      }
      pendingRedirect = target;
      i = j;
      continue;
    }

    // ── Ordinary character ───────────────────────────────────────────────
    if (dialect === 'posix') {
      if (ch === '$') expands = true;
      if (ch === '~' && (!inWord || /[=:]$/.test(text))) expands = true;
      if (ch === '(' || ch === ')') {
        // Unquoted parens are subshells / syntax in bash — never a plain argument.
        throw new ShellSyntaxError("Unquoted '(' or ')' is not permitted.");
      }
    }
    if (ch === '*' || ch === '?' || ch === '[') {
      globs = true;
      needsShell = true;
    }
    text += ch;
    unquotedText += ch;
    inWord = true;
    i++;
  }

  finishStage(n);
  if (stages.length > 1) needsShell = true;
  if (stages.some(s => s.words.some(w => w.expands) || s.redirects.length > 0)) needsShell = true;
  return { stages, needsShell };
}
