# Spec: Add `lineSeparator` option to Node.js `readline.createInterface()`

## Goal

Implement the feature requested in [nodejs/node#62785](https://github.com/nodejs/node/issues/62785):
add a user-configurable `lineSeparator` option to `readline.createInterface()` that
restricts which characters the reader treats as line terminators. The feature must
be **opt-in and backward-compatible** — if the option is omitted, behavior is
unchanged.

## Why (context you need)

Node's `readline` currently splits on the full ECMAScript `LineTerminator` set:
LF, CR, CRLF, U+2028 (LINE SEPARATOR), U+2029 (PARAGRAPH SEPARATOR). That set is
hardcoded into a single module-level regex.

This is incompatible with `JSON.stringify`, which per RFC 8259 leaves U+2028 / U+2029
raw in string values. Reading JSONL produced by `JSON.stringify` via
`readline.createInterface` cuts lines mid-string when user text contains those
codepoints. This is a real, hit-in-production bug (see issue #62785 for the
motivating case).

Prior art to read before starting:
- Issue #62785 (the accepted proposal — API shape is already agreed)
- Issue #22448 (the bug that originally added U+2028/U+2029 to the regex)
- PR #57591 (closed, unmerged, +27/−2) — shows how small a touch of this regex can be
- Issue #23929 (rejected feature — inform line events about the separator matched)

No open PR implements `lineSeparator` as of the time of writing.

## Deliverable

A single PR against `nodejs/node@main` containing:

1. Source change in `lib/internal/readline/interface.js`.
2. New / updated tests in `test/parallel/`.
3. Docs update in `doc/api/readline.md`.
4. No new error codes, no C++ changes, no deprecations.

Target total diff: ~150 lines, under 200. If your diff is substantially larger
than that, you've probably drifted out of scope — revisit.

---

## Environment setup

```sh
# Fork nodejs/node on GitHub, then:
git clone git@github.com:<your-user>/node.git
cd node
git remote add upstream https://github.com/nodejs/node.git
git checkout -b readline-line-separator

# First build takes a while (~10-20 min on a modern laptop). Subsequent rebuilds
# are incremental.
./configure
make -j$(nproc)        # or `make -j$(sysctl -n hw.ncpu)` on macOS

# Sanity-run the existing readline tests:
./out/Release/node test/parallel/test-readline-line-separators.js
```

Node's CONTRIBUTING guide: https://github.com/nodejs/node/blob/main/CONTRIBUTING.md.
Read the commit-message conventions section — node core requires
`subsystem: short summary` commit subjects (e.g. `readline: add lineSeparator option`).

---

## API design (already accepted in the issue)

Add a `lineSeparator` option to the options object passed to
`readline.createInterface()`:

```js
readline.createInterface({
  input: someStream,
  lineSeparator: /\r?\n/,          // form 1: RegExp (must have /g flag; auto-add if missing)
  // OR
  lineSeparator: '\n',             // form 2: single-char string
  // OR
  lineSeparator: ['\n', '\r\n'],   // form 3: array of strings, compiled to an alternation regex
});
```

**Rules:**
- Default value: `undefined` — preserves current behavior (splits on the full
  `LineTerminator` set).
- If user passes a `RegExp` without the `/g` flag, reject with
  `ERR_INVALID_ARG_VALUE` (don't silently add it — the lastIndex semantics matter
  and we want explicit intent).
- Strings in the array form must be non-empty. Empty string → `ERR_INVALID_ARG_VALUE`.
- Invalid types → `ERR_INVALID_ARG_TYPE` (one of: RegExp, string, string[]).

**Interaction with `crlfDelay`:** `crlfDelay` is an orthogonal, time-based mechanism
for collapsing a trailing `\r` from one chunk with a leading `\n` from the next.
When a custom `lineSeparator` is supplied that does **not** include `\r` or `\n`,
`crlfDelay` is effectively meaningless. Don't throw; document that `crlfDelay` only
affects the default separator. Add a test that covers a custom separator with
`crlfDelay` set — behavior should be: `crlfDelay` is applied iff the separator
regex could match `\r\n`.

---

## Implementation steps

### Step 1: Read the current state

Open `lib/internal/readline/interface.js`. Read these regions before touching
anything:

- Lines 81–88 (JSDoc + the `lineEnding` regex).
- Lines 90–158 (symbol declarations — this is where `kLineEnding` will go).
- Lines 170–260 (constructor: option parsing + instance field assignment. Look
  for how `crlfDelay` is handled at lines ~210 and ~249 — mirror that pattern).
- Lines 612–657 (`[kNormalWrite]`: the non-terminal splitting path. This is the
  primary code path for `for await (const line of rl)`).
- Lines 1530–1547 (`[kTtyWrite]` default case: terminal/paste splitting path).

The module-level `lineEnding` regex is referenced in ~8 places across those two
methods. List them before editing so you don't miss any:

```
lib/internal/readline/interface.js:88   const lineEnding = /\r?\n|\r(?!\n)|\u2028|\u2029/g;
lib/internal/readline/interface.js:626  (uses lineEnding)
lib/internal/readline/interface.js:631  (uses lineEnding)
lib/internal/readline/interface.js:632  (uses lineEnding)
lib/internal/readline/interface.js:638  (uses lineEnding)
lib/internal/readline/interface.js:640  (uses lineEnding)
lib/internal/readline/interface.js:641  (uses lineEnding)
lib/internal/readline/interface.js:1533 (uses lineEnding)
lib/internal/readline/interface.js:1537 (uses lineEnding)
lib/internal/readline/interface.js:1539 (uses lineEnding)
lib/internal/readline/interface.js:1542 (uses lineEnding)
```

Re-verify these line numbers yourself before editing — main moves.

### Step 2: Add the symbol

In the symbol declaration block around line 118, add:

```js
const kLineEnding = Symbol('_lineEnding');
```

### Step 3: Parse and store the option

In the constructor, near the existing `crlfDelay` handling (~line 210), read
`input.lineSeparator`, validate it, and compile to a `/g` regex stored on
`this[kLineEnding]`.

Pseudocode:

```js
// near line 210, next to crlfDelay parsing
const lineSeparator = input.lineSeparator;
if (lineSeparator !== undefined) {
  this[kLineEnding] = compileLineSeparator(lineSeparator);
}
```

Where `compileLineSeparator` is a module-local helper:

```js
function compileLineSeparator(sep) {
  if (sep instanceof RegExp) {
    if (!sep.global) {
      throw new ERR_INVALID_ARG_VALUE(
        'options.lineSeparator',
        sep,
        'must have the global (g) flag when provided as a RegExp',
      );
    }
    return sep;
  }
  if (typeof sep === 'string') {
    if (sep.length === 0) {
      throw new ERR_INVALID_ARG_VALUE('options.lineSeparator', sep, 'must be non-empty');
    }
    return new RegExp(escapeRegExp(sep), 'g');
  }
  if (ArrayIsArray(sep)) {
    if (sep.length === 0) {
      throw new ERR_INVALID_ARG_VALUE('options.lineSeparator', sep, 'must be non-empty');
    }
    for (const s of sep) {
      if (typeof s !== 'string' || s.length === 0) {
        throw new ERR_INVALID_ARG_VALUE('options.lineSeparator', sep, 'must contain only non-empty strings');
      }
    }
    // Sort longest-first so e.g. '\r\n' matches before '\r'
    const alternation = sep.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
    return new RegExp(alternation, 'g');
  }
  throw new ERR_INVALID_ARG_TYPE('options.lineSeparator', ['RegExp', 'string', 'string[]'], sep);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

Use node's primordials (`ArrayIsArray`, `StringPrototypeReplace`, `ArrayPrototypeSlice`,
`ArrayPrototypeSort`, `ArrayPrototypeMap`, `ArrayPrototypeJoin`) in the actual
implementation — node core style. Look at other files in `lib/internal/` for
examples.

### Step 4: Swap the regex references

At every call site that currently references the module-level `lineEnding`,
replace it with:

```js
const lineEndingRe = this[kLineEnding] ?? lineEnding;
// ... use lineEndingRe instead of lineEnding ...
```

Be careful: `RegExpPrototypeExec` with a `/g` regex mutates `lastIndex`. The
existing code relies on that — preserve it. Either reset `lastIndex = 0` before
use or be sure the usage pattern doesn't care. Match the existing style.

### Step 5: Handle `crlfDelay` interaction

When a custom `lineSeparator` is supplied, check whether it could match `\r\n`.
If not, skip the `crlfDelay` wait-for-LF logic. Cheap test:

```js
// After compiling the regex
this[kCrlfCompatible] = this[kLineEnding].test('\r\n');
this[kLineEnding].lastIndex = 0;  // reset after .test()
```

Then gate the existing `crlfDelay` path on `this[kCrlfCompatible] !== false`.

### Step 6: Export the symbol if needed

If tests need to probe the internal state, export `kLineEnding` from the
module-local exports block. Usually not needed — tests should verify behavior,
not internals.

### Step 7: Update the JSDoc

Update the doc comment at lines 81–87 to explain the new option, and add a
one-line note that the `lineEnding` module constant is the default set.

---

## Tests

### Test files

**Required:**

- `test/parallel/test-readline-line-separator-option.js` — new file. The primary
  place for `lineSeparator` tests.

**Touch / extend:**

- `test/parallel/test-readline-interface.js` — add a small section mirroring the
  existing `crlfDelay` tests at lines 96–98 and 1305–1377. Just a sanity check
  that the option is accepted.

**Read but don't modify unless necessary:**

- `test/parallel/test-readline-line-separators.js` — existing U+2028 / U+2029
  test. Must continue to pass unmodified (default behavior preserved).

### Required test cases (in the new file)

Each case is a separate `test(...)` or `assert` block:

1. **Default behavior unchanged:** no `lineSeparator` option → splits on U+2028
   as before.
2. **Custom RegExp excludes U+2028:** `lineSeparator: /\r?\n/g` + input
   `"a\u2028b\nc"` → two lines: `["a\u2028b", "c"]`.
3. **String form:** `lineSeparator: '\n'` + input `"a\nb\nc"` →
   `["a", "b", "c"]`.
4. **String form, multi-char:** `lineSeparator: '||'` + input `"a||b||c"` →
   `["a", "b", "c"]`.
5. **Array form:** `lineSeparator: ['\n', '\r\n']` + input `"a\nb\r\nc"` →
   `["a", "b", "c"]` (verify the longest-first sort prevents `\r` then empty-line
   bug).
6. **Regex without /g flag:** throws `ERR_INVALID_ARG_VALUE`.
7. **Empty string:** throws `ERR_INVALID_ARG_VALUE`.
8. **Empty array:** throws `ERR_INVALID_ARG_VALUE`.
9. **Array with empty string:** throws `ERR_INVALID_ARG_VALUE`.
10. **Invalid type (number, object):** throws `ERR_INVALID_ARG_TYPE`.
11. **Async iterator path:** `for await (const line of rl)` respects the custom
    separator. Use `Readable.from([Buffer.from(input)])` as input.
12. **TTY-paste path:** verify `[kTtyWrite]` respects the option when pasting
    multi-line content. Trickier to set up — look at how
    `test-readline-interface.js` tests TTY mode for the pattern.
13. **`crlfDelay` + LF-only separator:** `lineSeparator: /\n/g`, chunk 1 ends in
    `\r`, chunk 2 starts with `\n` → should emit `\r` at end of line 1, not
    collapse.
14. **JSONL regression** (the motivating case): input is `JSON.stringify({t:
    "a\u2028b"}) + "\n" + JSON.stringify({t: "c"}) + "\n"`,
    `lineSeparator: /\n/g` → both lines parse as valid JSON via `JSON.parse`.
    This is the test that justifies the whole PR; make it clear in the comment.

### Run the tests

```sh
./out/Release/node test/parallel/test-readline-line-separator-option.js
./out/Release/node test/parallel/test-readline-line-separators.js     # unchanged behavior
./out/Release/node test/parallel/test-readline-interface.js
python3 tools/test.py --mode=release parallel/test-readline-*
```

---

## Docs update

`doc/api/readline.md`:

- Add a new `lineSeparator` entry alongside `crlfDelay` (~line 713 and mirror at
  ~978 — readline module has two parallel option blocks for `createInterface`
  and `Interface` constructor).
- Include a short code example showing the JSONL / U+2028 case.
- Add an `added:` YAML tag with the version:
  ```yaml
  * `lineSeparator` {RegExp | string | string\[\]} ...
    **Default:** splits on the full ECMAScript `LineTerminator` set (LF, CR, CRLF,
    U+2028, U+2029).
  ```
  Look at how `crlfDelay` is documented for the exact format. Copy its structure.
- In the version-history block at the top of the file (~line 944), add an entry:
  ```yaml
  - version: REPLACEME
    pr-url: https://github.com/nodejs/node/pull/XXXXX
    description: The `lineSeparator` option is supported.
  ```
  Node's release tooling fills in the version and PR number — leave the
  placeholders.

---

## Final validation

Before opening the PR:

```sh
# Full readline test suite
python3 tools/test.py --mode=release parallel/test-readline-*

# Linter
make lint

# Verify no stray build artifacts
git status --short
```

Hand-check: run the motivating case against your built binary:

```js
// sanity.mjs
import { Readable } from 'node:stream';
import readline from 'node:readline';

const blob = JSON.stringify({ t: 'a\u2028b' }) + '\n';
const rl = readline.createInterface({
  input: Readable.from([blob]),
  lineSeparator: /\n/g,
});
for await (const line of rl) {
  console.log('line:', JSON.stringify(line));
  console.log('parsed:', JSON.parse(line));
}
```

```sh
./out/Release/node sanity.mjs
```

Expected: one line, parses as `{ t: 'a\u2028b' }`. Without `lineSeparator: /\n/g`,
this throws `SyntaxError: Unterminated string`.

---

## Submitting the PR

1. Commit with subject `readline: add lineSeparator option` and a body
   explaining the motivation (reference issue #62785).
2. Push to your fork.
3. Open a PR against `nodejs/node:main`. Reference #62785 in the body. Include
   the motivating JSONL example.
4. Ping `@nodejs/readline` in the PR body to get reviewers assigned.

Expected review feedback zones:
- Primordials usage — if you used `.replace` instead of
  `StringPrototypeReplace` etc., a reviewer will ask.
- The `crlfDelay` interaction behavior — document whatever you pick.
- Test coverage for the TTY path — that's the one test case that's easy to
  under-specify.

---

## Out of scope — don't do in this PR

- Changing the default line-terminator set. It must stay as it is.
- Exposing which separator matched each line (#23929 — rejected feature).
- Adding a similar option to `readline/promises` if its surface differs — separate
  PR if needed.
- Refactoring the module-level `lineEnding` regex for unrelated reasons.
- Adding a separator option to `interface.question()` or prompt handling — the
  issue scope is line reading.

---

## Success criteria

- [ ] `test/parallel/test-readline-line-separators.js` passes without modification
      (default behavior preserved).
- [ ] All new tests in `test-readline-line-separator-option.js` pass.
- [ ] `make lint` clean.
- [ ] Motivating JSONL sanity script succeeds.
- [ ] PR diff under 200 lines total, predominantly in `interface.js` and the new
      test file.
- [ ] Docs render correctly (run `make doc` if you want to preview, not
      required).
