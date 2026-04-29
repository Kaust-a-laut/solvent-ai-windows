import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { AgentMessage, ToolEvent } from '../../store/codingSlice';
import { persistAgentMessages, restoreAgentMessages } from '../../store/codingSlice';
import { API_BASE_URL, BASE_URL } from '../../lib/config';
import { fetchWithRetry, getSecret } from '../../lib/api-client';
import { toolResultToIDEActions } from '../../lib/toolToIDEAction';
import { AgentStatusBar } from './AgentStatusBar';
import { AgentTimeline } from './AgentTimeline';
import { EmptyState } from '../ui/EmptyState';
import { Code } from 'lucide-react';
import { AgentInput } from './AgentInput';
import { AGENT_MODEL_OPTIONS } from '../ModelSelector';
import type { AgentProvider } from '../../store/settingsSlice';

const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'create_file', 'replace_in_files']);
const MAX_TOOL_RESULT_CHARS = 500;

function truncateResult(event: ToolEvent): ToolEvent {
  if (typeof event.result === 'string' && event.result.length > MAX_TOOL_RESULT_CHARS) {
    return { ...event, result: event.result.slice(0, MAX_TOOL_RESULT_CHARS) + '…' };
  }
  return event;
}

interface PreviewContext {
  snapshot: string | null;
  bodyHTML: string | null;
  consoleBuffer: Array<{ level: string; message: string; timestamp: number }>;
  selectedElement: { tag: string; id?: string; classes: string[]; text: string } | null;
}

function buildPreviewContextBlock(ctx: PreviewContext): string {
  const parts: string[] = [];
  if (ctx.selectedElement) {
    const el = ctx.selectedElement;
    const sel = `${el.tag}${el.id ? `#${el.id}` : ''}${el.classes.length ? '.' + el.classes.join('.') : ''}`;
    parts.push(`[preview: user selected ${sel} — "${el.text.slice(0, 80)}"]`);
  }
  const errors = ctx.consoleBuffer.filter(e => e.level === 'error').slice(-3);
  if (errors.length > 0) {
    parts.push(`[preview console errors]\n${errors.map(e => `- ${e.message.slice(0, 200)}`).join('\n')}`);
  }
  const snap = ctx.snapshot ?? ctx.bodyHTML;
  if (snap) {
    parts.push(`[preview snapshot]\n${snap.slice(0, 2000)}${snap.length > 2000 ? '…' : ''}`);
  }
  return parts.join('\n\n');
}

export const AgentChatPanel: React.FC = () => {
  const {
    addAgentMessage, clearAgentMessages, updateAgentMessage,
    truncateAfterMessage, updateUserMessageContent,
    activeFile, openFiles, selectedAgentModel, selectedAgentProvider,
    setOpenFiles, setActiveFile, addTerminalLine,
    setPendingDiff, requestSandboxRun,
    agentMessages, currentProject, setProjectMap,
    previewSnapshot, previewBodyHTML, previewConsoleBuffer, previewSelectedElement,
    setAgentBusy, queuedAgentPrompt, setQueuedAgentPrompt,
    accumulateTokenUsage, sessionPromptTokens, sessionCompletionTokens, sessionCachedTokens,
    resetTokenUsage, setMemoryVisible,
    setAgentPlan,
  } = useAppStore();

  const [isGenerating, setIsGenerating] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [currentAction, setCurrentAction] = useState('');
  const [iteration, setIteration] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const textIterationRef = useRef(0);
  // Pending text_delta buffer — coalesced to ~50ms to reduce re-renders.
  const pendingDeltaRef = useRef<{ buf: string; iterIdx: number; timer: ReturnType<typeof setTimeout> | null }>({
    buf: '',
    iterIdx: 0,
    timer: null,
  });

  // Restore persisted messages on project switch
  useEffect(() => {
    if (!currentProject) return;
    if (agentMessages.length > 0) return;
    const projectKey = `${currentProject.type}:${currentProject.path}`;
    const saved = restoreAgentMessages(projectKey);
    if (saved && saved.length > 0) {
      clearAgentMessages();
      const cleaned = saved
        .filter(m => !(m.role === 'assistant' && m.isStreaming))
        .map(m => m.role === 'assistant' ? { ...m, isStreaming: false } : m);
      cleaned.forEach(m => addAgentMessage(m));
    }
  }, [currentProject?.path]);

  // Persist messages on change
  useEffect(() => {
    if (!currentProject) return;
    if (agentMessages.length === 0) return;
    const projectKey = `${currentProject.type}:${currentProject.path}`;
    const timer = setTimeout(() => {
      persistAgentMessages(projectKey, agentMessages);
    }, 2000);
    return () => clearTimeout(timer);
  }, [agentMessages, currentProject?.path]);

  // Sync local isGenerating to the store so PreviewPanel can show/hide the fix chip
  useEffect(() => { setAgentBusy(isGenerating); }, [isGenerating, setAgentBusy]);

  // Pick up queued agent prompts (e.g. from PreviewPanel's "Ask agent to fix" chip)
  useEffect(() => {
    if (!queuedAgentPrompt || isGenerating) return;
    setQueuedAgentPrompt(null); // clear it immediately
    handleSend(queuedAgentPrompt);
  }, [queuedAgentPrompt, isGenerating, setQueuedAgentPrompt]);

  // Fetch project index
  useEffect(() => {
    if (!currentProject) { setProjectMap(null); return; }
    const fetchIndex = async () => {
      try {
        const param = currentProject.type === 'folder'
          ? `?project=${encodeURIComponent(currentProject.path)}`
          : `?project=${encodeURIComponent(currentProject.name)}`;
        const data = await fetchWithRetry(`${BASE_URL}/api/files/index${param}`) as { map: string };
        setProjectMap(data.map ?? null);
      } catch { setProjectMap(null); }
    };
    void fetchIndex();
  }, [currentProject?.path]);

  // Cleanup abort controller
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const copyMessage = useCallback(async (msg: AgentMessage) => {
    let text = msg.content;
    const allEvents = msg.iterations?.flatMap(i => i.toolEvents) ?? msg.toolEvents ?? [];
    if (allEvents.length) {
      const toolText = allEvents.map(e =>
        `[${e.type}] ${e.tool}(${JSON.stringify(e.args)})${e.result ? ' → ' + JSON.stringify(e.result).slice(0, 500) : ''}${e.error ? ' → ERROR: ' + e.error : ''}`
      ).join('\n');
      text = text ? text + '\n\n--- Tool Calls ---\n' + toolText : toolText;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMsgId(msg.id);
      setTimeout(() => setCopiedMsgId(null), 2000);
    } catch { /* silent */ }
  }, []);

  const dispatchIDEActions = useCallback(async (event: ToolEvent) => {
    const actions = toolResultToIDEActions(event);
    for (const action of actions) {
      switch (action.type) {
        case 'open_file': {
          let content = action.content;
          if (!content) {
            try {
              const data = await fetchWithRetry(`${BASE_URL}/api/files/read?path=${encodeURIComponent(action.path)}`) as Record<string, string>;
              content = data.content ?? '';
            } catch {
              addTerminalLine(`[ERROR]: Could not open ${action.path}`);
              break;
            }
          }
          const currentFiles = useAppStore.getState().openFiles;
          const existing = currentFiles.find((f) => f.path === action.path);
          if (existing) setActiveFile(action.path);
          else { setOpenFiles([...currentFiles, { path: action.path, content }]); setActiveFile(action.path); }
          break;
        }
        case 'show_diff': {
          const currentFiles = useAppStore.getState().openFiles;
          const existing = currentFiles.find((f) => f.path === action.filePath);
          setPendingDiff({
            original: existing?.content ?? action.original,
            modified: action.modified,
            filePath: action.filePath,
            description: action.description,
          });
          break;
        }
        case 'terminal_output':
          for (const line of action.lines) {
            addTerminalLine(line.slice(0, 200));
          }
          break;
        case 'run_sandbox':
          requestSandboxRun();
          break;
      }
    }
  }, [setOpenFiles, setActiveFile, addTerminalLine, setPendingDiff, requestSandboxRun]);

  const flushPendingDelta = useCallback((assistantId: string) => {
    const pending = pendingDeltaRef.current;
    if (pending.timer) { clearTimeout(pending.timer); pending.timer = null; }
    if (!pending.buf) return;
    const delta = pending.buf;
    const iterIdx = pending.iterIdx;
    pending.buf = '';
    updateAgentMessage(assistantId, (prev) => {
      const iters = prev.iterations ? [...prev.iterations] : [];
      const existing = iters.find(it => it.index === iterIdx);
      if (existing) existing.text += delta;
      else iters.push({ index: iterIdx, text: delta, toolEvents: [] });
      return { content: (prev.content ?? '') + delta, iterations: iters };
    });
  }, [updateAgentMessage]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setIsGenerating(false);
    setCurrentAction('');
  }, []);

  const handleSend = useCallback(async (text: string) => {
    if (!text.trim() || isGenerating) return;

    const userMsg: AgentMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      fileContext: activeFile ?? undefined,
    };
    addAgentMessage(userMsg);

    // Snapshot preview state once at send time — same data the inline context
    // block uses, also forwarded as structured fields so preview-runtime tools
    // (get_console_logs, get_selected_element) can read live values.
    const { previewUrl, previewBodyHash } = useAppStore.getState();
    const previewStatePayload = {
      url: previewUrl ?? null,
      bodyHash: previewBodyHash ?? null,
      consoleBuffer: previewConsoleBuffer.slice(-200),
      selectedElement: previewSelectedElement ?? null,
    };

    setIsGenerating(true);
    setCurrentAction('Thinking...');
    setIteration(0);
    textIterationRef.current = 0;

    const assistantId = `asst-${Date.now()}`;
    addAgentMessage({
      id: assistantId,
      role: 'assistant',
      content: '',
      toolEvents: [],
      iterations: [],
      isStreaming: true,
    });

    abortRef.current = new AbortController();

    // Build a preview-runtime context block (if a preview is active).
    const previewBlock = buildPreviewContextBlock({
      snapshot: previewSnapshot,
      bodyHTML: previewBodyHTML,
      consoleBuffer: previewConsoleBuffer,
      selectedElement: previewSelectedElement,
    });

    // Inline fileContext + preview as a prefix on the user message so the backend
    // sees them even on providers that don't read openFiles separately.
    const contextPrefix = [
      activeFile ? `[active file: ${activeFile}]` : '',
      previewBlock,
    ].filter(Boolean).join('\n\n');
    const userContentForWire = contextPrefix
      ? `${contextPrefix}\n\n${userMsg.content}`
      : userMsg.content;

    try {
      const secret = await getSecret();
      const url = `${API_BASE_URL}/agent/chat`;
      const agentOption = AGENT_MODEL_OPTIONS.find(
        m => m.model === selectedAgentModel && m.provider === selectedAgentProvider
      );
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Solvent-Secret': secret },
        body: JSON.stringify({
          messages: [
            ...agentMessages.map(m => ({ role: m.role, content: m.content })),
            { role: userMsg.role, content: userContentForWire },
          ],
          model: selectedAgentModel,
          provider: selectedAgentProvider,
          tier: agentOption?.tier || 'code-only',
          ...(currentProject && { project: currentProject.type === 'folder' ? currentProject.path : currentProject.name }),
          ...(currentProject && { projectRoot: currentProject.path }),
          openFiles: openFiles.slice(0, 10),
          previewState: previewStatePayload,
        }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data: ')) continue;
          const json = line.slice(6).trim();
          if (!json || json === '[DONE]') continue;

          try {
            const evt = JSON.parse(json) as { type: string } & Record<string, unknown>;

            switch (evt.type) {
              case 'text_delta': {
                const delta = (evt.content as string) ?? '';
                if (!delta) break;
                const iterIdx = textIterationRef.current;
                const pending = pendingDeltaRef.current;
                // If iteration changed, flush what we have first.
                if (pending.buf && pending.iterIdx !== iterIdx) {
                  flushPendingDelta(assistantId);
                }
                pending.buf += delta;
                pending.iterIdx = iterIdx;
                if (!pending.timer) {
                  pending.timer = setTimeout(() => flushPendingDelta(assistantId), 50);
                }
                break;
              }
              case 'tool_start':
              case 'tool_result':
              case 'tool_error': {
                flushPendingDelta(assistantId);
                const toolEvent: ToolEvent = {
                  type: evt.type as ToolEvent['type'],
                  tool: evt.tool as string,
                  args: evt.args as Record<string, unknown>,
                  result: evt.result,
                  error: evt.error as string | undefined,
                  iteration: evt.iteration as number,
                  callId: evt.callId as string,
                };
                const iterIdx = toolEvent.iteration;
                if (evt.type === 'tool_start') {
                  textIterationRef.current = iterIdx + 1;
                  setIteration(iterIdx + 1);
                  setCurrentAction(`${toolEvent.tool} ${(toolEvent.args?.path as string) || ''}`);
                  if (WRITE_TOOL_NAMES.has(toolEvent.tool)) {
                    const path = toolEvent.args?.path as string;
                    if (path) {
                      const snap = useAppStore.getState().openFiles.find(f => f.path === path)?.content;
                      if (snap) toolEvent.beforeContent = snap;
                    }
                  }
                }
                updateAgentMessage(assistantId, (prev) => {
                  const iters = prev.iterations ? [...prev.iterations] : [];
                  const existing = iters.find(it => it.index === iterIdx);
                  const truncated = truncateResult(toolEvent);
                  if (existing) existing.toolEvents = [...existing.toolEvents, truncated];
                  else iters.push({ index: iterIdx, text: '', toolEvents: [truncated] });
                  return { iterations: iters };
                });
                if (evt.type === 'tool_result' || evt.type === 'tool_error') {
                  await dispatchIDEActions(toolEvent);
                }
                // Extract plan data from create_plan / update_plan results
                const tre = evt as { tool?: string; result?: { plan?: any } };
                if ((tre.tool === 'create_plan' || tre.tool === 'update_plan') && tre.result?.plan) {
                  setAgentPlan({ steps: tre.result.plan });
                }
                break;
              }
              case 'text_complete': {
                flushPendingDelta(assistantId);
                const finalText = (evt.content as string) ?? '';
                updateAgentMessage(assistantId, (prev) => ({
                  content: finalText,
                  isStreaming: false,
                  iterations: prev.iterations?.map((it, idx) =>
                    idx === (prev.iterations?.length ?? 0) - 1 ? { ...it, text: finalText } : it
                  ),
                }));
                break;
              }
              case 'usage': {
                const u = evt as Record<string, unknown>;
                if (typeof u.promptTokens === 'number' && typeof u.completionTokens === 'number') {
                  accumulateTokenUsage({ promptTokens: u.promptTokens, completionTokens: u.completionTokens, cachedTokens: u.cachedTokens as number | undefined });
                }
                break;
              }
              case 'plan_update': {
                const u = evt as Record<string, unknown>;
                if (u.plan && typeof u.plan === 'object') {
                  setAgentPlan(u.plan as any);
                }
                break;
              }
              case 'done':
                flushPendingDelta(assistantId);
                updateAgentMessage(assistantId, { isStreaming: false });
                setIsGenerating(false);
                setCurrentAction('');
                break;
              case 'error': {
                flushPendingDelta(assistantId);
                addTerminalLine(`[Agent Error]: ${evt.message as string}`);
                const errMsg = useAppStore.getState().agentMessages.find(m => m.id === assistantId);
                if (!errMsg?.content) {
                  useAppStore.setState(state => ({
                    agentMessages: state.agentMessages.filter(m => m.id !== assistantId),
                  }));
                } else {
                  updateAgentMessage(assistantId, { isStreaming: false });
                }
                setIsGenerating(false);
                setCurrentAction('');
                break;
              }
            }
          } catch { /* malformed SSE line — skip */ }
        }
      }
    } catch (err) {
      flushPendingDelta(assistantId);
      const currentMsg = useAppStore.getState().agentMessages.find(m => m.id === assistantId);
      if (!currentMsg?.content) {
        useAppStore.setState(state => ({
          agentMessages: state.agentMessages.filter(m => m.id !== assistantId),
        }));
      } else {
        updateAgentMessage(assistantId, { isStreaming: false });
      }
      if ((err as Error).name !== 'AbortError') {
        addTerminalLine(`[Agent Error]: ${(err as Error).message}`);
      }
      setIsGenerating(false);
      setCurrentAction('');
    }
  }, [agentMessages, isGenerating, currentProject, activeFile, openFiles, selectedAgentModel, selectedAgentProvider, previewSnapshot, previewBodyHTML, previewConsoleBuffer, previewSelectedElement, addAgentMessage, updateAgentMessage, dispatchIDEActions, addTerminalLine, flushPendingDelta]);

  const handleModelChange = useCallback((model: string, provider: string) => {
    useAppStore.getState().setSelectedAgentModel(model);
    useAppStore.getState().setSelectedAgentProvider(provider as AgentProvider);
  }, []);

  return (
    <div className="flex flex-col h-full bg-jb-panel border-l border-white/[0.06]">
      <AgentStatusBar
        isGenerating={isGenerating}
        currentAction={currentAction}
        iteration={iteration}
        model={selectedAgentModel || AGENT_MODEL_OPTIONS[0]?.model || 'gemini-2.5-flash'}
        onStop={handleStop}
        onClear={() => { clearAgentMessages(); resetTokenUsage(); }}
        onModelChange={handleModelChange}
        tokenUsage={{ promptTokens: sessionPromptTokens, completionTokens: sessionCompletionTokens, cachedTokens: sessionCachedTokens }}
        onToggleMemory={() => setMemoryVisible(true)}
      />
      {agentMessages.length === 0 && !isGenerating && (
        <div className="flex-1 flex items-center justify-center overflow-y-auto">
          <EmptyState
            icon={Code}
            title="Agent ready"
            description="Describe a task, paste some code, or ask a question to get started."
          />
        </div>
      )}
      {agentMessages.length > 0 && (
      <AgentTimeline
        agentMessages={agentMessages}
        isGenerating={isGenerating}
        copiedMsgId={copiedMsgId}
        onCopy={copyMessage}
        onEditAndRerun={(messageId, newContent) => {
          truncateAfterMessage(messageId);
          updateUserMessageContent(messageId, newContent);
          handleSend(newContent);
        }}
        onUndoIteration={async (iter) => {
          const writeEvents = iter.toolEvents.filter(
            (e) => e.type === 'tool_start' && WRITE_TOOL_NAMES.has(e.tool) && e.beforeContent !== undefined
          );
          const secret = await getSecret();
          for (const evt of writeEvents) {
            const filePath = evt.args?.path as string;
            if (!filePath || !evt.beforeContent) continue;
            try {
              // Write the beforeContent back to the file
              await fetch(`${BASE_URL}/api/files/write`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Solvent-Secret': secret },
                body: JSON.stringify({ path: filePath, content: evt.beforeContent, project: currentProject?.path }),
              });
              // Update openFiles in the store
              const currentFiles = useAppStore.getState().openFiles;
              setOpenFiles(currentFiles.map(f =>
                f.path === filePath ? { ...f, content: evt.beforeContent! } : f
              ));
            } catch (err) {
              addTerminalLine(`[undo] Failed to revert ${filePath}: ${err}`);
            }
          }
          addTerminalLine(`[undo] Reverted ${writeEvents.length} file write(s) from iteration ${iter.index + 1}`);
        }}
      />
      )}
      <AgentInput
        isGenerating={isGenerating}
        onSend={handleSend}
        onStop={handleStop}
        onAttach={(fileName, content) => {
          const ext = fileName.split('.').pop() ?? 'text';
          const block = `[Attached: ${fileName}]\n\`\`\`${ext}\n${content}\n\`\`\`\n`;
          void handleSend(block);
        }}
      />
    </div>
  );
};
