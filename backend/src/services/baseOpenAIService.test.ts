import { describe, it, expect } from 'vitest';
import { isProblematicToolResult, prependTruthfulnessNote, parseToolCalls, buildRecoveryHint, parseXmlToolCalls, stripRanges } from './baseOpenAIService';

describe('isProblematicToolResult', () => {
  it('flags strings starting with "Error"', () => {
    expect(isProblematicToolResult('Error: file not found')).toBe(true);
    expect(isProblematicToolResult('error: lowercase still counts')).toBe(true);
  });

  it('flags objects with deferred_to_frontend status', () => {
    expect(isProblematicToolResult({ status: 'deferred_to_frontend', tool: 'ide_show_diff' })).toBe(true);
  });

  it('flags objects with a non-empty error field', () => {
    expect(isProblematicToolResult({ error: 'timeout' })).toBe(true);
  });

  it('does not flag successful string results', () => {
    expect(isProblematicToolResult('ok')).toBe(false);
    expect(isProblematicToolResult('File contents here')).toBe(false);
  });

  it('does not flag successful object results', () => {
    expect(isProblematicToolResult({ status: 'success', path: 'a/b' })).toBe(false);
    expect(isProblematicToolResult({ ok: true })).toBe(false);
  });

  it('handles null and undefined', () => {
    expect(isProblematicToolResult(null)).toBe(false);
    expect(isProblematicToolResult(undefined)).toBe(false);
  });

  it('does not flag "errorless" substrings mid-string', () => {
    expect(isProblematicToolResult('No error found here')).toBe(false);
  });
});

describe('parseToolCalls', () => {
  it('parses valid JSON arguments', () => {
    const calls = parseToolCalls([
      { id: 'c1', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'read_file',
      callId: 'c1',
      args: { path: 'src/a.ts' },
      parseError: null,
    });
  });

  it('captures parseError and resets arguments to {} for malformed JSON', () => {
    const input = [
      { id: 'c2', function: { name: 'write_file', arguments: '{ "path": "a.ts", "content": "truncat' } },
    ];
    const calls = parseToolCalls(input);
    expect(calls[0]?.parseError).toBeTruthy();
    expect(calls[0]?.args).toEqual({});
    // Sanitized in place so downstream history stays valid JSON.
    expect(input[0]?.function.arguments).toBe('{}');
  });

  it('handles an empty tool_calls array', () => {
    expect(parseToolCalls([])).toEqual([]);
  });
});

describe('buildRecoveryHint', () => {
  it('appends read_file ENOENT guidance', () => {
    const msg = buildRecoveryHint('read_file', 'ENOENT: no such file or directory', 1, 3);
    expect(msg).toContain('Use list_files to discover');
  });

  it('appends list_files ENOENT guidance', () => {
    const msg = buildRecoveryHint('list_files', 'ENOENT: no such file or directory', 1, 3);
    expect(msg).toContain('parent directory');
  });

  it('appends run_shell guidance only at failure threshold', () => {
    const below = buildRecoveryHint('run_shell', 'exit 1', 1, 3);
    expect(below).not.toContain('Multiple shell attempts');
    const at = buildRecoveryHint('run_shell', 'exit 1', 3, 3);
    expect(at).toContain('Multiple shell attempts');
  });

  it('returns the message unchanged for unrelated tools', () => {
    expect(buildRecoveryHint('grep_files', 'something else', 1, 3)).toBe('something else');
  });
});

describe('parseXmlToolCalls + stripRanges', () => {
  const tools = ['read_file', 'write_file'];

  it('parses a single XML call and reports its byte range', () => {
    const content = 'I will read the config now.\n<read_file><path>src/config.ts</path></read_file>';
    const { calls, ranges } = parseXmlToolCalls(content, tools);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('read_file');
    expect(calls[0]?.args).toEqual({ path: 'src/config.ts' });
    expect(ranges).toHaveLength(1);
    expect(content.slice(ranges[0]!.start, ranges[0]!.end)).toMatch(/^<read_file>.*<\/read_file>$/);
  });

  it('preserves narrative when stripping XML ranges (H1 regression)', () => {
    const content = 'Sure — checking now.\n<read_file><path>a.ts</path></read_file>\nThen I will summarize.';
    const { ranges } = parseXmlToolCalls(content, tools);
    const cleaned = stripRanges(content, ranges);
    expect(cleaned).toContain('Sure — checking now.');
    expect(cleaned).toContain('Then I will summarize.');
    expect(cleaned).not.toContain('<read_file>');
  });

  it('strips multiple, possibly out-of-order ranges', () => {
    // Two tools — outer loop visits read_file first, write_file second, so ranges are name-grouped
    // not document-ordered. stripRanges must still produce coherent output.
    const content = 'A <write_file><path>b</path><content>x</content></write_file> B <read_file><path>a</path></read_file> C';
    const { ranges } = parseXmlToolCalls(content, tools);
    const cleaned = stripRanges(content, ranges);
    expect(cleaned).toBe('A  B  C'.trim());
  });

  it('returns content unchanged when no calls match', () => {
    const content = 'just narrative, no tools';
    const { calls, ranges } = parseXmlToolCalls(content, tools);
    expect(calls).toEqual([]);
    expect(ranges).toEqual([]);
    expect(stripRanges(content, ranges)).toBe(content);
  });

  it('skips malformed (unclosed) tags', () => {
    const content = '<read_file><path>truncated';
    const { calls, ranges } = parseXmlToolCalls(content, tools);
    expect(calls).toEqual([]);
    expect(ranges).toEqual([]);
  });
});

describe('prependTruthfulnessNote', () => {
  it('prepends the system note when hadProblems is true', () => {
    const out = prependTruthfulnessNote('Done.', true);
    expect(out).toMatch(/^\[System note:/);
    expect(out).toContain('Done.');
  });

  it('returns the text unchanged when hadProblems is false', () => {
    const out = prependTruthfulnessNote('Done.', false);
    expect(out).toBe('Done.');
  });
});
