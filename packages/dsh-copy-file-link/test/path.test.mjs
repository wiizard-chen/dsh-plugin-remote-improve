/**
 * Verify the clipboard payload built by the shipped client bundle.
 *
 * The browser bundle is one file with no module exports, so this test evaluates
 * the exact source between the `#region path-helpers` markers rather than
 * re-implementing it: what runs here is what the page runs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');
const region = /\/\/ #region path-helpers\n([\s\S]*?)\/\/ #endregion path-helpers/.exec(source);
assert.ok(region !== null, 'client.js must keep its #region path-helpers block');

const { clipboardText } = new Function(
  `${region[1]}
  return { clipboardText };`,
)();

test('the clipboard holds the bare absolute path', () => {
  assert.equal(
    clipboardText('/example/project/src/index.ts'),
    '/example/project/src/index.ts',
  );
});

test('no Markdown wrapper, label, or angle brackets are added', () => {
  for (const path of [
    '/example/project/src/index.ts',
    '/example/project/my docs/design notes.md',
    '/example/project/a(1).md',
    '/example/dsh-home/profiles/web/cordis.patch.yml',
  ]) {
    const text = clipboardText(path);
    assert.equal(text, path);
    assert.ok(!text.includes('[') && !text.includes(']('), 'the payload is not a link');
    assert.ok(!text.includes('<') && !text.includes('>'), 'the payload is not wrapped');
  }
});

test('the path keeps the spelling the Host reports, separators included', () => {
  assert.equal(clipboardText('C:\\work\\proj\\src\\a.ts'), 'C:\\work\\proj\\src\\a.ts');
  assert.equal(clipboardText('/hosts'), '/hosts');
  assert.equal(clipboardText('/数据/报告 2026.md'), '/数据/报告 2026.md');
});

test('a trailing separator is not trimmed', () => {
  assert.equal(clipboardText('/example/project/'), '/example/project/');
});
