import { describe, it, expect } from 'vitest';
import { compactHistory } from './baseOpenAIService';

type Msg = { role: string; content: string; tool_call_id?: string; name?: string; tool_calls?: unknown };

function makeIteration(toolName: string, resultContent: string): Msg[] {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_x', type: 'function', function: { name: toolName, arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_x', name: toolName, content: resultContent },
  ];
}

describe('compactHistory', () => {
  it('leaves small payloads unchanged', () => {
    const msgs: Msg[] = [
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 'hello' },
    ];
    expect(compactHistory(msgs, 4, 32_768)).toEqual(msgs);
  });

  it('compresses old tool results when over threshold', () => {
    const big = 'x'.repeat(5_000);
    const msgs: Msg[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'go' },
      ...makeIteration('read_file', big),
      ...makeIteration('read_file', big),
      ...makeIteration('read_file', big),
      ...makeIteration('read_file', big),
      ...makeIteration('read_file', big),
      // 2 recent iterations kept verbatim
      ...makeIteration('run_shell', '{"stdout":"ok","exitCode":0}'),
      ...makeIteration('list_files', '[]'),
    ];

    const result = compactHistory(msgs, 2, 32_768);

    // Recent run_shell result untouched
    const recentShell = result.find((m) => m.role === 'tool' && m.name === 'run_shell');
    expect(recentShell?.content).toBe('{"stdout":"ok","exitCode":0}');

    // Old read_file results compacted
    const oldReads = result.filter((m) => m.role === 'tool' && m.name === 'read_file');
    for (const m of oldReads) {
      expect(m.content).toContain('compacted');
      expect(m.content.length).toBeLessThan(200);
    }

    // User/system untouched
    expect(result.find((m) => m.role === 'user')?.content).toBe('go');
  });

  it('never compacts write_file results', () => {
    const big = 'x'.repeat(5_000);
    const msgs: Msg[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      ...makeIteration('read_file', big),
      ...makeIteration('read_file', big),
      ...makeIteration('write_file', '{"status":"success","path":"foo.ts"}'),
      ...makeIteration('read_file', big),
      ...makeIteration('read_file', big),
    ];

    const result = compactHistory(msgs, 1, 32_768);
    const writeResult = result.find((m) => m.role === 'tool' && m.name === 'write_file');
    expect(writeResult?.content).toBe('{"status":"success","path":"foo.ts"}');
  });
});
