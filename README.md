# textclean

Text hygiene for repositories. Line endings, BOMs, trailing whitespace, tabs,
final newlines — found, reported, and fixed with one command.

**Zero dependencies.** Node's standard library only. Nothing to install, ever.

This package is **not published to npm** — that name belongs to an unrelated
text-cleaning library. Run it from a checkout:

```console
$ git clone https://github.com/Xwalims/textclean.git
$ cd textclean
$ node bin/textclean.js --help
```

Or link it onto your `PATH`:

```console
$ npm link          # provides the `textclean` command
```

Requires Node 20 or newer.

---

<!-- hero -->

[![CI](https://github.com/Xwalims/textclean/actions/workflows/ci.yml/badge.svg)](https://github.com/Xwalims/textclean/actions/workflows/ci.yml)
![node 20+](https://img.shields.io/badge/node-20+-brightgreen)
![MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![dependencies](https://img.shields.io/badge/dependencies-none-2f6f4f)

## Contents

- [The safe default](#the-safe-default)
  - [Exit codes](#exit-codes)
- [Transformations](#transformations)
  - [Mixed line endings](#mixed-line-endings)
  - [Markdown code fences](#markdown-code-fences)
- [Choosing files](#choosing-files)
- [`--json`](#--json)
- [License](#license)

<!-- /hero -->

## The safe default

**textclean does not modify anything unless you tell it to.** Without
`--write` it only reports what it would change. This is deliberate: a tool that
rewrites your source tree on first run is a tool nobody runs twice.

```console
$ textclean notes.txt --eol lf --strip-trailing-whitespace
would fix notes.txt
          crlf → lf, trailing whitespace stripped
          15 B → 11 B (-4 B)
1 file would change
```

The file on disk is untouched. When you are ready:

```console
$ textclean notes.txt --write --eol lf --strip-trailing-whitespace
fixed     notes.txt
          crlf → lf, trailing whitespace stripped
          15 B → 11 B (-4 B)
1 file fixed
```

Here is the same file, before and after, in raw bytes:

```console
$ xxd notes.txt                          # before
00000000: 616c 7068 6120 200d 0a62 6574 610d 0a    alpha  ..beta..

$ xxd notes.txt                          # after
00000000: 616c 7068 610a 6265 7461 0a              alpha.beta.
```

`\r\n` became `\n` and the two trailing spaces are gone. Nothing else moved.

---

## CI mode

`--check` never writes and exits **1** if any file would change, so it drops
straight into a pipeline:

```console
$ textclean . --check --eol lf --strip-trailing-whitespace
would fix notes.txt
          crlf → lf, trailing whitespace stripped
          15 B → 11 B (-4 B)
1 file would change
check failed: run with --write to apply

$ echo $?
1
```

```yaml
# .github/workflows/ci.yml
- name: Check text hygiene
  run: node textclean/bin/textclean.js . --check --eol lf --strip-bom --strip-trailing-whitespace
```

The command is `textclean`, so if you have linked this package (`npm link`) or
installed it as a dev dependency, `npx textclean ...` works equally well.

### Exit codes

| Code | Meaning |
| ---- | ------- |
| `0`  | Clean, or changes were written |
| `1`  | `--check` found at least one file that would change |
| `2`  | Bad usage, or a file could not be read |

---

## Transformations

Each is independently toggleable and off unless you ask for it.

| Flag | Effect |
| ---- | ------ |
| `--eol <lf\|crlf\|cr\|keep>` | Normalize line endings (default `keep`) |
| `--ensure-crlf` | Shorthand for `--eol crlf` |
| `--strip-bom` | Remove a leading UTF-8 byte-order mark |
| `--ensure-final-newline` | Add a trailing newline when missing |
| `--no-final-newline` | Remove the trailing newline |
| `--strip-trailing-whitespace` | Strip trailing spaces/tabs from each line |
| `--trim-leading-whitespace` | Strip leading spaces/tabs from each line |
| `--tabs-to-spaces <n>` | Expand tabs to n-column tab stops |
| `--collapse-blank-lines <n>` | Cap consecutive blank lines at n |
| `--no-trailing-blank-lines` | Remove blank lines at end of file |
| `--skip-code-fences` | Protect fenced code blocks in Markdown |
| `--no-skip-code-fences` | …or don't (auto-on for `.md`/`.markdown`) |

### Mixed line endings

textclean detects each terminator type separately on the raw bytes, so `mixed`
is a real diagnosis, not a guess:

```console
$ textclean mixed.txt --eol lf
would fix mixed.txt
          mixed → lf
          9 B → 8 B (-1 B)
1 file would change
```

### Markdown code fences

This is the one case where a "cleanup" tool can quietly break your code, so
textclean refuses to.

Inside a fenced code block, trailing whitespace, leading whitespace, tab
expansion, and blank-line collapsing are **all skipped** by default for
`.md`/`.markdown`. Trailing spaces are a Markdown hard line break; indentation
and tabs inside a fence are the code itself.

```console
$ cat demo.md
# Title  

Some prose here.  

```js
const a = 1;   
```

end.

$ textclean demo.md --strip-trailing-whitespace
fixed     demo.md
          trailing whitespace stripped
          63 B → 59 B (-4 B)
1 file fixed
```

The result:

```
# Title

Some prose here.

```js
const a = 1;   
```

end.
```

`const a = 1;   ` keeps its three trailing spaces. The prose around it was
cleaned. Pass `--no-skip-code-fences` to clean inside fences too — you will
want `--tabs-to-spaces` set correctly first.

Line-ending conversion is applied everywhere, including inside fences. A file
with a CRLF fence and LF prose is exactly the mixed-ending problem textclean
exists to remove.

---

## What it refuses to touch

A text hygiene tool that "fixes" a binary file has destroyed it. textclean
detects a NUL byte in the first 8000 bytes and skips the file entirely:

```console
$ textclean . --write --eol lf
SKIP   image.bin (binary: NUL byte detected, never modified)
all clean, 1 skipped (binary)
```

**UTF-16 is rejected, not converted.** textclean rewrites UTF-8 only. A file
starting with a UTF-16 BOM gets a clear message and is left alone — silently
re-encoding would change every line of it:

```console
$ textclean . --write --eol lf
SKIP   u16.txt (file starts with a UTF-16LE BOM; textclean rewrites UTF-8 text only (re-save the file as UTF-8, e.g. `iconv -f utf-16 -t utf-8`))
all clean, 1 skipped (binary)
```

Convert it yourself first (`iconv -f utf-16 -t utf-8 in.txt > out.txt`), then
run textclean on the result.

An empty file stays empty. Adding a newline to zero bytes is noise, not hygiene.

---

## Choosing files

```bash
textclean src docs            # only these paths
textclean . --ext .js,.md     # only these extensions
textclean . --exclude dist    # skip matching paths
textclean . --no-gitignore    # ignore .gitignore files
```

`.git` and `node_modules` are **always** skipped, unconditionally — you cannot
turn that off and accidentally rewrite a dependency.

`--exclude` takes globs:

- a pattern **containing** `/` is matched against the whole relative path
  (`sub/a.js` matches only `sub/a.js`)
- a pattern with **no** `/` is matched against every path segment, so `dist` or
  `*.log` excludes that name at any depth
- inside a pattern, `*` does not cross `/` but `**` does

### What `.gitignore` support means

With `--gitignore` on (the default), textclean reads a root `.gitignore` plus
any nested ones. Supported syntax:

- blank lines and `#` comments
- `!` negation, last match wins
- trailing `/` = directory only
- leading `/`, or a `/` anywhere but the end = anchored to that ignore file's
  directory; a bare name matches at any depth
- `*`, `?`, `**`, and character classes `[abc]` / `[!abc]`
- `\` escape of the first special character

Not supported, and not claimed anywhere: backslash line continuations, regex
class edge cases beyond a plain class, and git's per-file precedence rules for
nested ignore files beyond plain last-match-wins within one file.

---

## `--diff`

```console
$ textclean demo.md --diff --strip-trailing-whitespace --no-trailing-blank-lines
would fix demo.md
          trailing whitespace stripped, trailing blank lines removed, final newline added
          63 B → 59 B (-4 B)
--- a/demo.md
+++ b/demo.md
@@ -1,6 +1,6 @@
-# Title  
+# Title
 
-Some prose here.  
+Some prose here.
 
 ```js
 const a = 1;   
1 file would change
```

Note the fence: `const a = 1;   ` appears as unchanged context, exactly as it
will stay on disk.

The renderer is intentionally not a general diff algorithm. Every transform
preserves line order and line count (blank-line collapsing only ever removes
lines), so a positional comparison is a complete description of the change —
no Myers, no LCS, no heuristics, and no way to emit a subtly wrong hunk.
Terminator-only differences are rendered explicitly as `\r\n` rather than
silently, and a missing final newline is labelled.

---

## `--json`

```console
$ textclean a.txt --json --strip-trailing-whitespace
{
  "version": "0.1.0",
  "write": false,
  "check": false,
  "summary": {
    "files": 1,
    "wouldChange": 1,
    "clean": 0,
    "binary": 0,
    "unsupported": 0,
    "errors": 0
  },
  "missing": [],
  "files": [
    {
      "path": "a.txt",
      "absolutePath": "/tmp/x/a.txt",
      "status": "would-change",
      "bom": null,
      "eol": "lf",
      "bytesBefore": 4,
      "bytesAfter": 2,
      "reasons": [
        "trailing-whitespace-stripped"
      ],
      "written": false,
      "error": null
    }
  ]
}
```

`status` is one of `clean`, `would-change`, `binary`, `unsupported`, `error`.

---

## Safety

`--write` never writes in place. It writes a temp file in the same directory,
`fsync`s it, and `rename(2)`s it over the target. `rename(2)` is atomic within
a filesystem, so a reader never sees a half-written file and a crash mid-write
leaves the original intact. The file **mode is preserved** explicitly, so an
executable script stays executable.

Running twice is a no-op the second time. textclean is idempotent, which the
test suite asserts for a combined transform.

---

## Library API

```js
const { analyzeFile, plan, apply } = require('textclean');

// Byte-level facts about a file on disk.
const info = analyzeFile('notes.txt');
// → { size, mode, bom, lineEndings, binary, finalNewline, supported, reason }

// What WOULD change. Never writes. 'after' is the new text.
const result = plan('alpha  \r\nbeta\r\n', { eol: 'lf', stripTrailingWhitespace: true });
result.after;     // 'alpha\nbeta\n'
result.changed;   // true
result.reasons;   // ['trailing-whitespace-stripped']

// Transform in memory. Buffer in, Buffer out.
apply(buffer, { stripBom: true });  // → Buffer
```

All options and their defaults live in one frozen object:

```js
const { DEFAULTS } = require('textclean');
DEFAULTS.eol;           // 'keep'
DEFAULTS.skipCodeFences; // null = auto (on for .md/.markdown)
```

`plan` and `apply` are pure functions. Writing is the CLI's job.

---

## Development

```bash
node --test        # 145 tests, no install needed
```

Tested on Node 20, 22, and 24 (`.github/workflows/ci.yml`). The suite covers
byte-level detection, every transformation, fence protection, the diff
renderer, directory walking, and end-to-end CLI runs that spawn the real binary
and assert real exit codes and real bytes.

The repo dogfoods itself — CI runs textclean over its own tree with `--check`.

## License

MIT © 2026 Xwalims
