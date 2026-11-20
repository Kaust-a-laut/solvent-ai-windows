import React from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { getFileIcon } from './fileIcons';

interface Props {
  openFiles: { path: string; content: string }[];
  activeFile: string | null;
  onTabClick: (path: string) => void;
  onTabClose: (path: string) => void;
}

export const EditorTabBar: React.FC<Props> = ({ openFiles, activeFile, onTabClick, onTabClose }) => {
  return (
    <div className="h-10 bg-black/40 border-b border-white/[0.14] flex items-center px-2 gap-1 overflow-x-auto no-scrollbar shrink-0">
      {openFiles.map((file) => {
        const name = file.path.split('/').pop() ?? file.path;
        const icon = getFileIcon(name);
        const isActive = activeFile === file.path;

        return (
          <div
            key={file.path}
            onClick={() => onTabClick(file.path)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1 rounded-lg text-[11px] font-medium cursor-pointer transition-all border shrink-0',
              isActive
                ? 'bg-jb-accent/15 text-jb-accent border-jb-accent/55 shadow-[inset_0_0_0_1px_rgba(60,113,247,0.2),0_0_12px_-2px_rgba(60,113,247,0.25)]'
                : 'bg-white/[0.04] text-white/60 border-white/[0.14] hover:text-white hover:bg-white/[0.08] hover:border-white/[0.26]',
            )}
          >
            <span className={cn('shrink-0', isActive ? 'text-jb-accent' : icon.color)}>{icon.emoji}</span>
            <span>{name}</span>
            <X
              size={11}
              className="ml-0.5 hover:text-rose-400 opacity-50 hover:opacity-100 transition-opacity"
              onClick={(e) => { e.stopPropagation(); onTabClose(file.path); }}
            />
          </div>
        );
      })}
    </div>
  );
};
