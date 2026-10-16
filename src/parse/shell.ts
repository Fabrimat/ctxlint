import { posix } from 'node:path';
import { inlinePath } from './paths.js';
import { packageSpec } from './versions.js';

export interface Extracted {
  kind: 'path' | 'script' | 'command' | 'version' | 'custom';
  value: string;
  /** Offset of the claim text within the parsed line. */
  index: number;
  meta?: Record<string, string>;
}

interface Tok {
  text: string;
  at: number;
  /** Offset just past the raw token. */
  end: number;
  op: boolean;
}

const OPERATORS = ['&&', '||', ';', '|'];
const startsOperator = (s: string, i: number): string | undefined =>
  OPERATORS.find((o) => s.startsWith(o, i));

/** Minimal shell tokenizer: quotes, backslash escapes, `#` comments and command separators. */
function tokenize(line: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line.charAt(i);
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '#') break;
    const op = startsOperator(line, i);
    if (op) {
      toks.push({ text: op, at: i, end: i + op.length, op: true });
      i += op.length;
      continue;
    }
    const at = i;
    let text = '';
    while (i < line.length && !/\s/.test(line.charAt(i)) && !startsOperator(line, i)) {
      const ch = line.charAt(i);
      if (ch === "'") {
        const end = line.indexOf("'", i + 1);
        const stop = end < 0 ? line.length : end;
        text += line.slice(i + 1, stop);
        i = stop + 1;
      } else if (ch === '"') {
        i++;
        while (i < line.length && line.charAt(i) !== '"') {
          if (line.charAt(i) === '\\' && i + 1 < line.length) i++;
          text += line.charAt(i++);
        }
        i++;
      } else if (ch === '\\') {
        text += line.charAt(i + 1);
        i += 2;
      } else {
        text += ch;
        i++;
      }
    }
    toks.push({ text, at, end: Math.min(i, line.length), op: false });
  }
  return toks;
}

/** The words of a shell line (quotes removed), e.g. a plugin command's argv. */
export function shellWords(line: string): string[] {
  return tokenize(line)
    .filter((t) => !t.op)
    .map((t) => t.text);
}

function splitCommands(toks: Tok[]): Tok[][] {
  const cmds: Tok[][] = [[]];
  for (const t of toks) {
    if (t.op) cmds.push([]);
    else cmds[cmds.length - 1]?.push(t);
  }
  return cmds.filter((c) => c.length > 0);
}

const KNOWN_BOOLEAN_FLAGS = new Set(
  (
    '--silent -s --if-present --frozen-lockfile -g --global -D -E -O -P -y --yes --ignore-scripts ' +
    '--prod --production --workspaces -ws --include-workspace-root -r --recursive --parallel ' +
    '--stream --offline --prefer-offline --verbose --save --save-dev --save-exact --save-optional ' +
    '--save-peer --dev --exact --optional --peer -S'
  ).split(' '),
);

interface Scan {
  pos: Tok[];
  meta: Record<string, string>;
  /** For each unrecognised flag, how many positionals preceded it. */
  unknown: number[];
}

/** Splits flags from positionals; stops at `--`. */
function scan(
  args: Tok[],
  valued: Record<string, string>,
  bool: Record<string, string> = {},
): Scan {
  const out: Scan = { pos: [], meta: {}, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (!tok || tok.text === '--') break;
    if (!tok.text.startsWith('-')) {
      out.pos.push(tok);
      continue;
    }
    const eq = tok.text.indexOf('=');
    const name = eq > 0 ? tok.text.slice(0, eq) : tok.text;
    if (Object.hasOwn(bool, name)) out.meta[bool[name] as string] = 'true';
    else if (Object.hasOwn(valued, name)) {
      const value = eq > 0 ? tok.text.slice(eq + 1) : args[++i]?.text;
      if (value) out.meta[valued[name] as string] = value;
    } else if (eq < 0 && !KNOWN_BOOLEAN_FLAGS.has(name) && !name.startsWith('--no-')) {
      // May take a value we cannot see, which would shift the positionals: drop the claim.
      out.unknown.push(out.pos.length);
    }
  }
  return out;
}

/** True when an unrecognised flag precedes the claim token, so its position is unreliable. */
const blocked = (sc: Scan, tok: Tok): boolean => {
  const idx = sc.pos.indexOf(tok);
  return sc.unknown.some((n) => n <= idx);
};

/** `<script>`, `{name}`, `$SCRIPT`, `[cmd]`, `...`: documentation placeholders, not names. */
const PLACEHOLDER = /[<>{}[\]$]|\.\.\./;

function script(
  pm: string,
  sc: Scan,
  tok: Tok | undefined,
  extra: Record<string, string> = {},
  value = tok?.text,
): Extracted[] {
  if (!tok || !value || PLACEHOLDER.test(value) || blocked(sc, tok)) return [];
  return [{ kind: 'script', value, index: tok.at, meta: { pm, ...sc.meta, ...extra } }];
}

const INSTALL_SUBS = new Set(['install', 'i', 'add']);

/**
 * `pkg@range` arguments of an install command. Global installs are skipped: they are not repo
 * dependencies. (`dlx`, `npx` and `yarn global add` never reach here.)
 */
function installs(sc: Scan, args: Tok[]): Extracted[] {
  if (args.some((t) => t.text === '-g' || t.text === '--global')) return [];
  return sc.pos.slice(1).flatMap((tok) => {
    const spec = packageSpec(tok.text);
    if (!spec || blocked(sc, tok)) return [];
    return [{ kind: 'version' as const, value: tok.text, index: tok.at, meta: { ...spec } }];
  });
}

const implicitScript = (tok: Tok | undefined): Tok | undefined =>
  tok && !tok.text.includes('/') && !tok.text.startsWith('.') ? tok : undefined;

function npm(args: Tok[]): Extracted[] {
  const sc = scan(args, { '-w': 'filter', '--workspace': 'filter' });
  const [sub, name] = sc.pos;
  if (sub?.text === 'run' || sub?.text === 'run-script') return script('npm', sc, name);
  if (sub?.text === 'test' || sub?.text === 't') return script('npm', sc, sub, {}, 'test');
  if (sub && INSTALL_SUBS.has(sub.text)) return installs(sc, args);
  // start/stop/restart have npm fallbacks; every other subcommand is not a script.
  return [];
}

const PNPM_BUILTINS = new Set(
  (
    'add i install update up upgrade remove rm uninstall un link ln unlink import rebuild rb prune ' +
    'fetch patch patch-commit patch-remove audit outdated list ls ll why licenses exec dlx create init ' +
    'publish pack setup env store config c get set root bin help server deploy doctor cache self-update ' +
    'approve-builds ignored-builds catalog'
  ).split(' '),
);

function pnpm(args: Tok[]): Extracted[] {
  const sc = scan(
    args,
    { '-F': 'filter', '--filter': 'filter', '-C': 'dir', '--dir': 'dir' },
    { '-r': 'recursive', '--recursive': 'recursive' },
  );
  const [sub, name] = sc.pos;
  if (!sub) return [];
  if (sub.text === 'run' || sub.text === 'run-script') return script('pnpm', sc, name);
  if (INSTALL_SUBS.has(sub.text)) return installs(sc, args);
  if (sub.text === 'exec') {
    return name && !blocked(sc, name)
      ? [{ kind: 'command', value: name.text, index: name.at, meta: { via: 'pnpm-exec' } }]
      : [];
  }
  if (PNPM_BUILTINS.has(sub.text)) return [];
  return script('pnpm', sc, implicitScript(sub), { implicit: 'true' });
}

const YARN_BUILTINS = new Set(
  (
    'add install remove up upgrade why info init config cache dlx exec node workspaces set plugin ' +
    'version npm pack publish login logout link unlink constraints explain bin patch patch-commit ' +
    'rebuild search stage unplug global create import'
  ).split(' '),
);

function yarn(args: Tok[]): Extracted[] {
  const sc = scan(args, {});
  const [sub, a, b, c] = sc.pos;
  if (!sub) return [];
  if (sub.text === 'run') return script('yarn', sc, a);
  if (sub.text === 'add') return installs(sc, args);
  if (sub.text === 'workspace') {
    if (!a) return [];
    return script('yarn', sc, b?.text === 'run' ? c : b, { filter: a.text });
  }
  if (YARN_BUILTINS.has(sub.text)) return [];
  return script('yarn', sc, implicitScript(sub), { implicit: 'true' });
}

function bun(args: Tok[]): Extracted[] {
  const sc = scan(args, {});
  const [sub, name] = sc.pos;
  if (sub && INSTALL_SUBS.has(sub.text)) return installs(sc, args);
  if (sub?.text !== 'run' || !name || /[./]/.test(name.text)) return [];
  return script('bun', sc, name);
}

function npx(args: Tok[]): Extracted[] {
  const sc = scan(args, { '-p': 'package', '--package': 'package' });
  const bin = sc.pos[0];
  if (!bin || blocked(sc, bin)) return [];
  // `@scope/pkg@1` and `pkg@1` lose the version; a lone leading `@` is the scope.
  const cut = bin.text.lastIndexOf('@');
  const value = cut > 0 ? bin.text.slice(0, cut) : bin.text;
  return [{ kind: 'command', value, index: bin.at, meta: { via: 'npx' } }];
}

const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;
/**
 * Binary names start lowercase: `Tests  3 passed`, `Duration 1.2s` or `27` are output lines in
 * an unprompted fence, and `app.test.ts` is a listed file. ponytail: drops the rare `R`/`MSBuild`.
 */
const BINARY_NAME = /^[a-z_][\w.+-]*$/;
const FILE_NAME = /\.(?:[cm]?[jt]sx?|json|md|ya?ml|txt|log)$/;
const WRAPPERS = new Set(['sudo', 'then', 'do', 'else', 'time']);
const NOT_COMMANDS = new Set(
  (
    'if then else elif fi for while until do done case esac in function export set unset source . ' +
    'alias echo printf read exit return eval exec test [ [[ ] ]] { } ( ) time trap shift wait ' +
    'local declare'
  ).split(' '),
);

/** Removes subshell/group punctuation hugging the command: `(cd x` ... `y)`. */
function trimGroup(cmd: Tok[]): Tok[] {
  const toks = cmd.map((t) => ({ ...t }));
  const head = toks[0];
  if (head) {
    const bare = head.text.replace(/^[({]+/, '');
    head.at += head.text.length - bare.length;
    head.text = bare;
    if (!bare) toks.shift();
  }
  const tail = toks.at(-1);
  if (tail) {
    const bare = tail.text.replace(/[)};]+$/, '');
    tail.end -= tail.text.length - bare.length;
    tail.text = bare;
    if (!bare) toks.pop();
  }
  return toks;
}

/** The command's binary (after env assignments, wrappers and Windows launcher suffixes). */
function head(raw: Tok[]): { first: Tok; rest: Tok[]; name: string; last: Tok } | undefined {
  const cmd = trimGroup(raw);
  let k = 0;
  while (
    k < cmd.length &&
    (ENV_ASSIGNMENT.test(cmd[k]?.text ?? '') || WRAPPERS.has(cmd[k]?.text ?? ''))
  )
    k++;
  const [first, ...rest] = cmd.slice(k);
  if (!first) return undefined;
  // `npm.cmd`, `bun.exe`: Windows launchers; a path such as ./run.ps1 keeps its extension.
  const name = first.text.includes('/')
    ? first.text
    : first.text.replace(/\.(?:cmd|exe|ps1)$/i, '');
  return { first, rest, name, last: cmd.at(-1) as Tok };
}

/** Binary -> plugin check id that adopted it. */
export type Adopted = ReadonlyMap<string, string>;

function classify(raw: Tok[], line: string, adopted: Adopted): Extracted[] {
  const h = head(raw);
  if (!h) return [];
  const { first, rest, name } = h;
  const check = adopted.get(name);
  if (check !== undefined) {
    // The raw text from the binary to the end of its segment.
    const value = line.slice(first.at, h.last.end);
    return [{ kind: 'custom', value, index: first.at, meta: { check, matched: 'command' } }];
  }
  if (NOT_COMMANDS.has(name) || name === 'cd') return [];
  switch (name) {
    case 'npm':
      return npm(rest);
    case 'pnpm':
      return pnpm(rest);
    case 'yarn':
      return yarn(rest);
    case 'bun':
      return bun(rest);
    case 'npx':
      return npx(rest);
  }
  if (name.includes('/')) {
    // Only relative paths; absolute, `~` and `$VAR` forms are rejected here or by inlinePath.
    const parts = name.startsWith('/') ? null : inlinePath(name);
    return parts ? [{ kind: 'path', ...parts, index: first.at }] : [];
  }
  return BINARY_NAME.test(name) && !FILE_NAME.test(name)
    ? [{ kind: 'command', value: name, index: first.at }]
    : [];
}

const NONE: Adopted = new Map();

/**
 * Extracts script, command and path claims from one logical shell line, and `custom` claims for
 * binaries a plugin adopted.
 */
export function parseShellLine(
  line: string,
  adopted: Adopted = NONE,
  shell: ShellState = {},
): Extracted[] {
  // Substitutions and heredocs hide the real command structure: precision over recall.
  if (/\$\(|`|<</.test(line)) return [];
  const outer = shell.cwd;
  const out = splitCommands(tokenize(line)).flatMap((cmd) => {
    const h = head(cmd);
    if (h?.name === 'cd') {
      const [to] = h.rest;
      // `cd`, `cd ~`, `cd $DIR`, `cd -`, `cd /abs`: somewhere we cannot follow.
      const plain = to !== undefined && !/^[~$/-]/.test(to.text) && shell.cwd !== null;
      shell.cwd = plain ? posix.normalize(posix.join(shell.cwd ?? '', to.text)) : null;
      return [];
    }
    return classify(cmd, line, adopted).flatMap((c) => moved(c, shell.cwd));
  });
  // A subshell `(cd x && ...)` does not move the lines after it.
  if (/^\s*\(/.test(line)) shell.cwd = outer;
  return out;
}

/** Where a fence has `cd`-ed to: a doc- or root-relative dir, `null` once it cannot be followed. */
export interface ShellState {
  cwd?: string | null | undefined;
}

/** A claim after `cd`: scripts run in that dir; relative paths and lost dirs are dropped. */
function moved(c: Extracted, cwd: string | null | undefined): Extracted[] {
  if (cwd === undefined || c.kind === 'command' || c.kind === 'custom' || c.kind === 'version') {
    return [c];
  }
  if (c.kind === 'script' && c.meta?.filter !== undefined) return [c];
  if (c.kind !== 'script' || cwd === null) return [];
  const dir = posix.normalize(posix.join(cwd, c.meta?.dir ?? '.'));
  return [{ ...c, meta: { ...c.meta, dir, cd: 'true' } }];
}

/** The binary of the first command of `line`, as `parseShellLine` sees it. */
export function leadingBinary(line: string): string | undefined {
  const [cmd] = splitCommands(tokenize(line));
  return cmd && head(cmd)?.name;
}

export interface Piece {
  text: string;
  line: number;
  /** 1-based column of `text[0]` in the source. */
  col: number;
}

export interface LogicalLine {
  text: string;
  locate(index: number): { line: number; col: number };
}

const SHELL_PROMPT = /^[$>] +/;
// Console transcripts print `> pkg@1 script` banners as output, so only `$` marks a command there.
const HEREDOC = /<<-?\s*['"]?(\w+)['"]?/;
const CONSOLE_PROMPT = /^\$ +/;

function join(pieces: Piece[]): LogicalLine {
  const starts: number[] = [];
  let at = 0;
  for (const p of pieces) {
    starts.push(at);
    at += p.text.length + 1;
  }
  return {
    text: pieces.map((p) => p.text).join(' '),
    locate(index) {
      let i = starts.length - 1;
      while (i > 0 && (starts[i] as number) > index) i--;
      const p = pieces[i] as Piece;
      return { line: p.line, col: p.col + index - (starts[i] as number) };
    },
  };
}

/**
 * Turns fence lines into logical command lines: joins backslash continuations, drops blanks and
 * comments, strips `$ ` and `> ` prompts. In console-style fences only prompted lines are commands.
 */
export function logicalLines(pieces: Piece[], consoleStyle: boolean): LogicalLine[] {
  const out: LogicalLine[] = [];
  let open: Piece[] | null = null;
  let heredoc: string | null = null;
  for (const piece of pieces) {
    if (heredoc !== null) {
      if (piece.text.trim() === heredoc) heredoc = null;
      continue;
    }
    let { text, col } = piece;
    if (!open) {
      const prompt = (consoleStyle ? CONSOLE_PROMPT : SHELL_PROMPT).exec(text);
      if (prompt) {
        text = text.slice(prompt[0].length);
        col += prompt[0].length;
      } else if (consoleStyle) continue;
    }
    const lead = text.length - text.trimStart().length;
    text = text.slice(lead);
    col += lead;
    if (!open && (text.trim() === '' || text.startsWith('#'))) continue;
    const doc = HEREDOC.exec(text);
    if (doc) {
      heredoc = doc[1] as string;
      open = null;
      continue;
    }
    const more = /\\\s*$/.test(text);
    if (more) text = text.replace(/\\\s*$/, '');
    open ??= [];
    open.push({ text, line: piece.line, col });
    if (!more) {
      out.push(join(open));
      open = null;
    }
  }
  if (open) out.push(join(open));
  return out;
}
