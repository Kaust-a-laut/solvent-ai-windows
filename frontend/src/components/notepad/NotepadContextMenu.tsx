import React, { useEffect, useRef } from 'react';
import {
  StickyNote, Image as ImageIcon, Link as LinkIcon, BoxSelect,
  Copy, Trash2, Pencil, Tag, Palette,
} from 'lucide-react';
import { cn } from '../../lib/utils';

export type ContextMenuTarget =
  | { kind: 'pane'; flowPos: { x: number; y: number } }
  | { kind: 'node'; nodeId: string; nodeType: string }
  | { kind: 'edge'; edgeId: string };

export interface ContextMenuState {
  target: ContextMenuTarget;
  screen: { x: number; y: number };
}

export interface ContextMenuActions {
  onClose: () => void;
  onAddNote: (pos: { x: number; y: number }) => void;
  onAddImage: (pos: { x: number; y: number }) => void;
  onAddLink: (pos: { x: number; y: number }) => void;
  onAddGroup: (pos: { x: number; y: number }) => void;
  onEditNode: (nodeId: string) => void;
  onDuplicateNode: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onColorNode: (nodeId: string, color: string) => void;
  onLabelEdge: (edgeId: string) => void;
  onDeleteEdge: (edgeId: string) => void;
}

const COLORS: Array<{ value: string; label: string; cls: string }> = [
  { value: 'default', label: 'Neutral', cls: 'bg-white/30' },
  { value: 'amber',   label: 'Amber',   cls: 'bg-amber-400' },
  { value: 'cyan',    label: 'Cyan',    cls: 'bg-cyan-400' },
  { value: 'purple',  label: 'Purple',  cls: 'bg-jb-purple' },
  { value: 'emerald', label: 'Emerald', cls: 'bg-emerald-400' },
];

const MenuItem: React.FC<{
  icon?: React.ElementType;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}> = ({ icon: Icon, label, onClick, danger, disabled }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={cn(
      'w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left rounded-md transition-colors',
      disabled && 'opacity-30 cursor-not-allowed',
      !disabled && (danger
        ? 'text-rose-300 hover:bg-rose-500/10'
        : 'text-slate-200 hover:bg-white/[0.06]')
    )}
  >
    {Icon && <Icon size={13} className="shrink-0 opacity-80" />}
    <span className="flex-1">{label}</span>
  </button>
);

const Divider = () => <div className="my-1 mx-2 h-px bg-white/[0.06]" />;
const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-[0.25em] font-bold text-white/30">{children}</div>
);

export const NotepadContextMenu: React.FC<{
  state: ContextMenuState;
  actions: ContextMenuActions;
  canColor: boolean;
}> = ({ state, actions, canColor }) => {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') actions.onClose();
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) actions.onClose();
    };
    window.addEventListener('keydown', onKey);
    // Capture phase so we close before underlying handlers fire.
    window.addEventListener('mousedown', onClick, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick, true);
    };
  }, [actions]);

  // Position with viewport clamping so the menu doesn't overflow.
  const style: React.CSSProperties = (() => {
    const margin = 8;
    const w = 220;
    const h = 320;
    const x = Math.min(state.screen.x, window.innerWidth - w - margin);
    const y = Math.min(state.screen.y, window.innerHeight - h - margin);
    return {
      position: 'fixed',
      left: Math.max(margin, x),
      top: Math.max(margin, y),
      width: w,
      zIndex: 9999,
    };
  })();

  const close = (run: () => void) => () => { run(); actions.onClose(); };

  return (
    <div
      ref={ref}
      style={style}
      className="bg-[#0c0c12]/95 backdrop-blur-xl border border-white/[0.08] rounded-xl shadow-2xl py-1.5 select-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.target.kind === 'pane' && (
        <>
          <SectionLabel>Add at cursor</SectionLabel>
          <MenuItem icon={StickyNote} label="Note" onClick={close(() => actions.onAddNote((state.target as { kind: 'pane'; flowPos: { x: number; y: number } }).flowPos))} />
          <MenuItem icon={ImageIcon} label="Image…" onClick={close(() => actions.onAddImage((state.target as { kind: 'pane'; flowPos: { x: number; y: number } }).flowPos))} />
          <MenuItem icon={LinkIcon} label="Link" onClick={close(() => actions.onAddLink((state.target as { kind: 'pane'; flowPos: { x: number; y: number } }).flowPos))} />
          <MenuItem icon={BoxSelect} label="Group" onClick={close(() => actions.onAddGroup((state.target as { kind: 'pane'; flowPos: { x: number; y: number } }).flowPos))} />
        </>
      )}

      {state.target.kind === 'node' && (
        <>
          <SectionLabel>{state.target.nodeType[0]?.toUpperCase()}{state.target.nodeType.slice(1)}</SectionLabel>
          <MenuItem icon={Pencil} label="Edit" onClick={close(() => actions.onEditNode((state.target as { kind: 'node'; nodeId: string }).nodeId))} />
          <MenuItem icon={Copy} label="Duplicate" onClick={close(() => actions.onDuplicateNode((state.target as { kind: 'node'; nodeId: string }).nodeId))} />
          {canColor && (
            <>
              <Divider />
              <SectionLabel>
                <span className="inline-flex items-center gap-1.5">
                  <Palette size={9} /> Accent
                </span>
              </SectionLabel>
              <div className="px-3 py-1.5 flex gap-1.5">
                {COLORS.map((c) => (
                  <button
                    key={c.value}
                    onClick={close(() => actions.onColorNode((state.target as { kind: 'node'; nodeId: string }).nodeId, c.value))}
                    className={cn('w-5 h-5 rounded-full border border-white/10 hover:scale-110 transition-transform', c.cls)}
                    title={c.label}
                  />
                ))}
              </div>
            </>
          )}
          <Divider />
          <MenuItem icon={Trash2} label="Delete" danger onClick={close(() => actions.onDeleteNode((state.target as { kind: 'node'; nodeId: string }).nodeId))} />
        </>
      )}

      {state.target.kind === 'edge' && (
        <>
          <SectionLabel>Connection</SectionLabel>
          <MenuItem icon={Tag} label="Add label…" onClick={close(() => actions.onLabelEdge((state.target as { kind: 'edge'; edgeId: string }).edgeId))} />
          <Divider />
          <MenuItem icon={Trash2} label="Delete" danger onClick={close(() => actions.onDeleteEdge((state.target as { kind: 'edge'; edgeId: string }).edgeId))} />
        </>
      )}
    </div>
  );
};
