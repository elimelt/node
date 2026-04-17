'use strict';
const common = require('../common');

if (process.env.TERM === 'dumb') {
  common.skip('skipping - dumb terminal');
}

const assert = require('node:assert');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

class FakeInput extends EventEmitter {
  resume() {}
  pause() {}
  write() {}
  end() {}
}

function collectLines(options, chunks) {
  const fi = new FakeInput();
  const rli = new readline.Interface({ input: fi, ...options });
  const lines = [];
  rli.on('line', (line) => lines.push(line));
  for (const chunk of chunks) {
    fi.emit('data', chunk);
  }
  rli.close();
  return lines;
}

// 1. Default behavior: U+2028 and U+2029 are still line terminators.
{
  const lines = collectLines({}, ['a\u2028b\u2029c\nd\n']);
  assert.deepStrictEqual(lines, ['a', 'b', 'c', 'd']);
}

// 2. Custom RegExp excludes U+2028 from the separator set.
{
  const lines = collectLines(
    { lineSeparator: /\r?\n/g },
    ['a\u2028b\nc\n'],
  );
  assert.deepStrictEqual(lines, ['a\u2028b', 'c']);
}

// 3. String form.
{
  const lines = collectLines({ lineSeparator: '\n' }, ['a\nb\nc\n']);
  assert.deepStrictEqual(lines, ['a', 'b', 'c']);
}

// 4. String form with multi-char separator.
{
  const lines = collectLines({ lineSeparator: '||' }, ['a||b||c||']);
  assert.deepStrictEqual(lines, ['a', 'b', 'c']);
}

// 5. Array form. Longest-first sort must ensure '\r\n' wins over '\r'.
{
  const lines = collectLines(
    { lineSeparator: ['\n', '\r\n'] },
    ['a\nb\r\nc\n'],
  );
  assert.deepStrictEqual(lines, ['a', 'b', 'c']);
}

// 6. Regex without the /g flag throws ERR_INVALID_ARG_VALUE.
{
  const fi = new FakeInput();
  assert.throws(
    () => new readline.Interface({ input: fi, lineSeparator: /\n/ }),
    { code: 'ERR_INVALID_ARG_VALUE' },
  );
}

// 7. Empty string throws ERR_INVALID_ARG_VALUE.
{
  const fi = new FakeInput();
  assert.throws(
    () => new readline.Interface({ input: fi, lineSeparator: '' }),
    { code: 'ERR_INVALID_ARG_VALUE' },
  );
}

// 8. Empty array throws ERR_INVALID_ARG_VALUE.
{
  const fi = new FakeInput();
  assert.throws(
    () => new readline.Interface({ input: fi, lineSeparator: [] }),
    { code: 'ERR_INVALID_ARG_VALUE' },
  );
}

// 9. Array containing an empty string throws ERR_INVALID_ARG_VALUE.
{
  const fi = new FakeInput();
  assert.throws(
    () => new readline.Interface({ input: fi, lineSeparator: ['\n', ''] }),
    { code: 'ERR_INVALID_ARG_VALUE' },
  );
  assert.throws(
    () => new readline.Interface({ input: fi, lineSeparator: ['\n', 42] }),
    { code: 'ERR_INVALID_ARG_VALUE' },
  );
}

// 10. Invalid types throw ERR_INVALID_ARG_TYPE.
{
  const fi = new FakeInput();
  for (const bad of [42, true, {}, Symbol('x'), () => {}]) {
    assert.throws(
      () => new readline.Interface({ input: fi, lineSeparator: bad }),
      { code: 'ERR_INVALID_ARG_TYPE' },
    );
  }
}

// 11. Async iterator path respects the custom separator.
(async () => {
  const input = Readable.from([Buffer.from('a\u2028b\nc\nd')]);
  const rl = readline.createInterface({ input, lineSeparator: /\n/g });
  const out = [];
  for await (const line of rl) {
    out.push(line);
  }
  assert.deepStrictEqual(out, ['a\u2028b', 'c', 'd']);
})().then(common.mustCall());

// 12. TTY (terminal) paste path respects the custom separator.
{
  const fi = new FakeInput();
  const rli = new readline.Interface({
    input: fi,
    output: fi,
    terminal: true,
    lineSeparator: '||',
  });
  const lines = [];
  rli.on('line', (line) => lines.push(line));
  // rli.write() dispatches to kTtyWrite when terminal is true.
  rli.write('foo||bar||baz');
  rli.close();
  assert.deepStrictEqual(lines, ['foo', 'bar']);
}

// 13. crlfDelay is a no-op when the custom separator cannot match `\r\n`.
//     A trailing `\r` in chunk 1 followed by a leading `\n` in chunk 2 must
//     still emit the `\r` as part of the first line rather than being
//     collapsed with the next chunk's `\n`.
{
  const lines = collectLines(
    { lineSeparator: /\n/g, crlfDelay: Infinity },
    ['foo\r', '\nbar\n'],
  );
  assert.deepStrictEqual(lines, ['foo\r', 'bar']);
}

// 14. JSONL regression — the motivating case from nodejs/node#62785.
//     JSON.stringify leaves U+2028 raw; with the default separator the line
//     would be split inside the JSON string and JSON.parse would throw.
(async () => {
  const obj1 = { t: 'a\u2028b' };
  const obj2 = { t: 'c' };
  const blob = `${JSON.stringify(obj1)}\n${JSON.stringify(obj2)}\n`;
  const rl = readline.createInterface({
    input: Readable.from([blob]),
    lineSeparator: /\n/g,
  });
  const parsed = [];
  for await (const line of rl) {
    parsed.push(JSON.parse(line));
  }
  assert.deepStrictEqual(parsed, [obj1, obj2]);
})().then(common.mustCall());
