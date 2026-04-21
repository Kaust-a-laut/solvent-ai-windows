import React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '../../lib/utils';

export const TogglePill: React.FC<{
  icon: React.ElementType;
  label: string;
  active: boolean;
  onClick: () => void;
}> = ({ icon: Icon, label, active, onClick }) => (
  <button
    onClick={onClick}
    className={cn(
      'flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-wider transition-all border',
      active
        ? 'bg-jb-accent/15 border-jb-accent/25 text-jb-accent'
        : 'bg-white/[0.02] border-white/[0.04] text-slate-500 hover:text-white',
    )}
  >
    <Icon size={8} />
    {label}
    {active ? <Eye size={7} /> : <EyeOff size={7} />}
  </button>
);
