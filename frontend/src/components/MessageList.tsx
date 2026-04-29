import React from 'react';
import { MessageItem } from './MessageItem';
import { EmptyState } from './ui/EmptyState';
import { MessageCircle, Code, Terminal, FileText, Lightbulb, Image as ImageIcon, Wand2, Palette, Globe, Search, Compass, Brain, Sparkles, Scale, GitCompare, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '../lib/utils';
import { downloadImage } from '../lib/file-utils';
import { useVirtualMessages } from '../lib/useVirtualMessages';

interface MessageListProps {
  compact?: boolean;
}

type EmptyStatePrompt = { label: string; icon: LucideIcon; prompt: string };
type EmptyStateConfig = {
  icon: LucideIcon;
  title: string;
  description: string;
  prompts: EmptyStatePrompt[];
};

function getEmptyStateConfig(mode: string, projectName?: string | null): EmptyStateConfig {
  switch (mode) {
    case 'coding':
      return {
        icon: Code,
        title: projectName ? `Working on ${projectName}` : 'Ready to build',
        description: 'Describe what to build, refactor, or fix — I can run code and edit files.',
        prompts: [
          { label: 'Refactor a component to use hooks', icon: Code, prompt: 'Refactor a component to use hooks. Start by showing me the current implementation.' },
          { label: 'Run the build and fix any errors', icon: Terminal, prompt: 'Run the build and fix any TypeScript errors you find.' },
          {
            label: projectName ? `Explain ${projectName}'s architecture` : 'Explain the project architecture',
            icon: FileText,
            prompt: projectName ? `Explain the overall architecture and structure of ${projectName}.` : 'Explain the overall architecture and structure of this project.',
          },
          { label: 'Plan a feature step-by-step', icon: Lightbulb, prompt: 'Help me plan a new feature step-by-step before writing any code.' },
        ],
      };
    case 'vision':
      return {
        icon: ImageIcon,
        title: 'Vision lab',
        description: 'Generate, describe, or edit images.',
        prompts: [
          { label: 'Generate a hero illustration', icon: Wand2, prompt: 'Generate a hero illustration for a modern startup landing page.' },
          { label: "Describe an image I'll attach", icon: ImageIcon, prompt: 'Describe the image I will attach in detail.' },
          { label: 'Create a logo concept', icon: Palette, prompt: 'Create three logo concepts for a brand called ' },
          { label: 'Edit colors in an image', icon: Sparkles, prompt: 'Help me edit the colors and composition of the image I will attach.' },
        ],
      };
    case 'browser':
      return {
        icon: Globe,
        title: 'Search the web',
        description: 'Find, summarize, and synthesize anything online.',
        prompts: [
          { label: 'Find recent articles on a topic', icon: Search, prompt: 'Find recent articles about ' },
          { label: "Summarize a webpage I'll link", icon: FileText, prompt: 'Summarize the key points of this webpage: ' },
          { label: 'Compare two products', icon: Scale, prompt: 'Compare these two products and recommend one: ' },
          { label: 'Research a topic deeply', icon: Compass, prompt: "Research and synthesize what's known about " },
        ],
      };
    case 'waterfall':
      return {
        icon: Sparkles,
        title: 'Pipeline architect',
        description: 'Describe a goal — Solvent will plan, build, and verify across stages.',
        prompts: [
          { label: 'Build a CLI tool with tests and docs', icon: Terminal, prompt: 'Build a small CLI tool from spec to tests to documentation.' },
          { label: 'Plan a multi-stage refactor', icon: Sparkles, prompt: 'Plan and execute a multi-stage refactor of ' },
          { label: 'Research → design → prototype', icon: Compass, prompt: 'Research, design, and prototype a feature for ' },
          { label: 'Audit code and ship a fix', icon: Wand2, prompt: 'Audit the code in this project and ship a fix end-to-end.' },
        ],
      };
    case 'debate':
      return {
        icon: Scale,
        title: 'Take a side',
        description: 'Set a topic and watch two models argue both sides.',
        prompts: [
          { label: 'Build vs buy', icon: Scale, prompt: 'Should we build this in-house or buy a vendor solution?' },
          { label: 'Microservices vs monolith', icon: GitCompare, prompt: 'Compare microservices vs monolith for a small startup.' },
          { label: 'Remote vs hybrid work', icon: Users, prompt: 'Argue both sides of remote-first vs hybrid work for a 30-person team.' },
          { label: 'A tech tradeoff of your choice', icon: Brain, prompt: 'Argue both sides of ' },
        ],
      };
    case 'compare':
      return {
        icon: GitCompare,
        title: 'Side by side',
        description: 'Run the same prompt across multiple models at once.',
        prompts: [
          { label: 'Compare a prompt across models', icon: GitCompare, prompt: 'Compare how each model answers: ' },
          { label: 'Test math reasoning', icon: Scale, prompt: 'Test which model handles this math problem best: ' },
          { label: 'Compare code generation', icon: Code, prompt: 'Compare which model writes the cleanest implementation of: ' },
          { label: 'Run a fairness test', icon: Sparkles, prompt: 'Run a fairness comparison across providers on: ' },
        ],
      };
    case 'collaborate':
      return {
        icon: Users,
        title: 'Multi-agent team',
        description: 'Direct a team of specialist agents working together.',
        prompts: [
          { label: 'Two agents debate then converge', icon: Users, prompt: 'Have two agents debate then converge on: ' },
          { label: 'Plan → build → review', icon: Sparkles, prompt: 'Plan, build, and peer-review a feature: ' },
          { label: 'Split a task across specialists', icon: GitCompare, prompt: 'Split this task across specialist agents: ' },
          { label: 'Research → write → critique', icon: Brain, prompt: 'Run a research → write → critique loop on: ' },
        ],
      };
    case 'model_playground':
      return {
        icon: Wand2,
        title: 'Model lab',
        description: 'Test prompts directly against a model with no app context.',
        prompts: [
          { label: 'Test a creative writing prompt', icon: Sparkles, prompt: 'Write a 200-word story about ' },
          { label: 'Try a system prompt variation', icon: FileText, prompt: 'Use this system prompt: "" and respond to: ' },
          { label: 'Test reasoning under constraint', icon: Brain, prompt: 'Solve this in three steps or fewer: ' },
          { label: 'See raw output for a code task', icon: Code, prompt: 'Without explanation, write code for: ' },
        ],
      };
    case 'chat':
    case 'home':
    default:
      return {
        icon: MessageCircle,
        title: 'Hey there',
        description: 'Ask anything — brainstorm, summarize, draft, or talk through an idea.',
        prompts: [
          { label: 'Brainstorm names or ideas', icon: Lightbulb, prompt: 'Brainstorm 10 names for ' },
          { label: "Summarize an article I'll paste", icon: FileText, prompt: 'Summarize the key points of this article:\n\n' },
          { label: 'Explain a concept simply', icon: Brain, prompt: "Explain like I'm new to it: " },
          { label: 'Draft a polished message', icon: Sparkles, prompt: 'Help me draft a polished message about ' },
        ],
      };
  }
}

const EMPTY_STATE_SHORTCUTS = [
  { key: '↵', label: 'send' },
  { key: '⇧↵', label: 'newline' },
  { key: '⌘K', label: 'search' },
];

export const MessageList = ({ compact }: MessageListProps) => {
  const { currentMode, isProcessing, modeConfigs, selectedCloudModel, selectedLocalModel, globalProvider, deviceInfo, imageProvider, currentProject } = useAppStore(
    useShallow((state) => ({
      currentMode: state.currentMode,
      isProcessing: state.isProcessing,
      modeConfigs: state.modeConfigs,
      selectedCloudModel: state.selectedCloudModel,
      selectedLocalModel: state.selectedLocalModel,
      globalProvider: state.globalProvider,
      deviceInfo: state.deviceInfo,
      imageProvider: state.imageProvider,
      currentProject: state.currentProject,
    }))
  );

  const { scrollRef, virtualizer, messages } = useVirtualMessages();
  const isMobile = deviceInfo.isMobile;

  // Resolve Active Model Name for the prompt/header area
  // (Individual messages might vary, but for the 'AI' label we use the current config)
  const config = modeConfigs[currentMode] || { provider: 'auto', model: selectedCloudModel };
  let activeModel = config.model;

  if (currentMode === 'vision') {
    activeModel = imageProvider === 'huggingface' ? 'Stable Diffusion' :
                  imageProvider === 'local' ? 'Juggernaut XL' :
                  imageProvider === 'pollinations' ? 'Flux (Free)' : 'Imagen 3';
  } else if (config.provider === 'auto') {
    activeModel = globalProvider === 'local' ? selectedLocalModel : selectedCloudModel;
  } else if (globalProvider === 'local' && config.provider === 'gemini') {
    activeModel = selectedLocalModel;
  }

  const getTime = () => {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const isVision = currentMode === 'vision';
  const isCoding = currentMode === 'coding';
  const isCompact = compact || isCoding || isVision;

  return (
    <div className={cn(
      "flex-1 overflow-y-auto scrollbar-thin",
      isCompact ? "pt-20 pb-20 space-y-4" : "pt-[100px] pb-32 space-y-5",
      isMobile ? (compact ? "p-3 pt-16 pb-20" : "p-4 pt-20 pb-24") : "p-6"
    )} ref={scrollRef}>

      {messages.length === 0 && !isProcessing && (() => {
        const empty = getEmptyStateConfig(currentMode, currentProject?.name);
        return (
          <EmptyState
            icon={empty.icon}
            title={empty.title}
            description={empty.description}
            prompts={empty.prompts.map((p) => ({
              label: p.label,
              icon: p.icon,
              onClick: () => useAppStore.getState().setPendingPrompt(p.prompt),
            }))}
            shortcuts={EMPTY_STATE_SHORTCUTS}
          />
        );
      })()}

      {messages.length > 0 && (
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((virtualItem: { key: React.Key; index: number; start: number }) => {
            const m = messages[virtualItem.index];
            if (!m) return null;
            const isNew = virtualItem.index >= messages.length - 2;
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <MessageItem
                  message={m}
                  isUser={m.role === 'user'}
                  modelName={m.role === 'user' ? 'User' : (m.model || activeModel)}
                  time={getTime()}
                  onDownloadImage={downloadImage}
                  compact={isCompact}
                  animate={isNew}
                />
              </div>
            );
          })}
        </div>
      )}

      {isProcessing && (
         <div className="max-w-4xl mx-auto flex items-center gap-3 px-6">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-jb-accent/70 animate-bounce" />
              <span className="w-1.5 h-1.5 rounded-full bg-jb-accent/50 animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-jb-accent/30 animate-bounce [animation-delay:300ms]" />
            </div>
            <span className="text-[11px] font-bold text-slate-400">
              {activeModel} is thinking
            </span>
         </div>
      )}
    </div>
  );
};
