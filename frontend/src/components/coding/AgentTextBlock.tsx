import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, CheckCheck } from 'lucide-react';

interface Props {
  text: string;
  isStreaming: boolean;
}

const StreamingDots: React.FC = () => (
  <span className="inline-flex items-center gap-0.5 ml-0.5 align-middle">
    {[0, 1, 2].map(i => (
      <span
        key={i}
        className="inline-block w-1.5 h-1.5 rounded-full bg-jb-accent/70 animate-bounce"
        style={{ animationDelay: `${i * 150}ms`, animationDuration: '0.8s' }}
      />
    ))}
  </span>
);

const CodeBlock: React.FC<{ language: string; children: string }> = ({ language, children }) => {
  const [copied, setCopied] = React.useState(false);
  const code = children.replace(/\n$/, '');

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative my-2 rounded-xl overflow-hidden border border-white/[0.07] bg-black/40">
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/[0.03] border-b border-white/[0.05]">
        <span className="text-[11px] font-mono text-white/30">{language || 'text'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="p-1 hover:bg-white/10 rounded text-white/30 hover:text-white/60 transition-colors"
          aria-label="Copy code"
        >
          {copied ? <CheckCheck size={11} className="text-emerald-400" /> : <Copy size={11} />}
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneDark as Record<string, React.CSSProperties>}
        customStyle={{
          margin: 0,
          padding: '12px',
          fontSize: '11px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          background: 'transparent',
        }}
        wrapLongLines
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
};

export const AgentTextBlock: React.FC<Props> = ({ text, isStreaming }) => {
  if (isStreaming) {
    return (
      <div className="flex items-start gap-2">
        <div className="flex-1 text-[12px] leading-relaxed text-slate-300 whitespace-pre-wrap min-h-[20px]">
          {text || ''}
          <StreamingDots />
        </div>
      </div>
    );
  }

  if (!text) return null;

  return (
    <div className="text-[12px] leading-relaxed text-slate-300 prose-sm">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const isInline = !match;
            if (isInline) {
              return (
                <code className="bg-white/[0.06] px-1 rounded text-[11px] font-mono text-jb-accent" {...props}>
                  {children}
                </code>
              );
            }
            return (
              <CodeBlock language={match?.[1] || ''}>
                {String(children)}
              </CodeBlock>
            );
          },
          a: (props) => <a target="_blank" rel="noopener noreferrer" {...props} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
};
