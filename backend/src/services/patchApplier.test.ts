import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff, applyHunks } from './patchApplier';

const apply = (content: string, diff: string) => applyHunks(content, parseUnifiedDiff(diff));

describe('patchApplier', () => {
  it('applies a simple LF hunk', () => {
    const r = apply('a\nb\nc\n', '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
    expect(r.success).toBe(true);
    expect(r.newContent).toBe('a\nB\nc\n');
  });

  it('does not truncate CRLF hunks at blank context lines', () => {
    const content = 'one\r\n\r\ntwo\r\nthree\r\n';
    const diff = '--- a/f\r\n+++ b/f\r\n@@ -1,4 +1,4 @@\r\n one\r\n \r\n two\r\n-three\r\n+THREE\r\n';
    const hunks = parseUnifiedDiff(diff);
    expect(hunks[0]!.lines).toHaveLength(5);
    const r = applyHunks(content, hunks);
    expect(r.success).toBe(true);
    expect(r.newContent).toBe('one\r\n\r\ntwo\r\nTHREE\r\n'); // CRLF preserved
  });

  it('inserts @@ -0,0 hunks at the top of the file, not before the last line', () => {
    const r = apply('x\ny\n', '@@ -0,0 +1,2 @@\n+header1\n+header2\n');
    expect(r.success).toBe(true);
    expect(r.newContent).toBe('header1\nheader2\nx\ny\n');
  });

  it('creates content for an empty (new) file', () => {
    const r = apply('', '@@ -0,0 +1,2 @@\n+first\n+second\n');
    expect(r.newContent).toBe('first\nsecond\n');
  });

  it('inserts pure-insertion hunks after the referenced line', () => {
    const r = apply('a\nb\nc\n', '@@ -2,0 +3,1 @@\n+inserted\n');
    expect(r.newContent).toBe('a\nb\ninserted\nc\n');
  });

  it('does not match expected blank lines past EOF', () => {
    const r = apply('a\nb', '@@ -2,3 +2,3 @@\n b\n \n \n');
    expect(r.success).toBe(false);
  });
});
