import React from 'react';
import { motion } from 'framer-motion';
import {
  LayoutDashboard, Shield, Users, Layers,
  Code2, Search, PenLine,
} from 'lucide-react';
import { cn } from '../../lib/utils';

export type PipView = 'dash' | 'notes' | 'overseer' | 'missions' | 'waterfall' | 'code' | 'intel';

interface TabDef {
  id: PipView;
  icon: React.ElementType;
  label: string;
  color: string;
}

const TABS: TabDef[] = [
  { id: 'dash',      icon: LayoutDashboard, label: 'Home',     color: 'text-white' },
  { id: 'overseer',  icon: Shield,          label: 'Overseer', color: 'text-emerald-400' },
  { id: 'missions',  icon: Users,           label: 'Missions', color: 'text-jb-purple' },
  { id: 'waterfall', icon: Layers,          label: 'Flow',     color: 'text-jb-purple' },
  { id: 'code',      icon: Code2,           label: 'Code',     color: 'text-jb-accent' },
  { id: 'intel',     icon: Search,          label: 'Intel',    color: 'text-cyan-400' },
  { id: 'notes',     icon: PenLine,         label: 'Notes',    color: 'text-amber-400' },
];

interface PipTabBarProps {
  activeView: PipView;
  onChangeView: (v: PipView) => void;
  unreadOverseer: number;
  activeMissions: number;
}

export const PipTabBar: React.FC<PipTabBarProps> = ({
  activeView,
  onChangeView,
  unreadOverseer,
  activeMissions,
}) => {
  return (
    <div className="flex items-center justify-around px-1 py-1 bg-[#0a0a0f]/80 backdrop-blur-xl border-t border-white/[0.06] shrink-0">
      {TABS.map((tab) => {
        const isActive = activeView === tab.id;
        const Icon = tab.icon;
        const showBadge =
          (tab.id === 'overseer' && unreadOverseer > 0) ||
          (tab.id === 'missions' && activeMissions > 0);
        const badgeColor = tab.id === 'overseer' ? 'bg-emerald-400' : 'bg-indigo-400';

        return (
          <button
            key={tab.id}
            onClick={() => onChangeView(tab.id)}
            className={cn(
              'relative flex flex-col items-center justify-center gap-0.5 py-1.5 px-2 rounded-lg transition-all duration-200',
              isActive ? 'bg-white/[0.04]' : 'hover:bg-white/[0.02]',
            )}
          >
            {isActive && (
              <motion.div
                layoutId="cc-tab-indicator"
                className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-4 h-0.5 rounded-full"
                style={{ backgroundColor: tab.id === 'dash' ? 'rgba(255,255,255,0.5)' : undefined }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              >
                {tab.id !== 'dash' && (
                  <div className={cn('w-full h-full rounded-full', tab.color.replace('text-', 'bg-'))} />
                )}
              </motion.div>
            )}

            <div className="relative">
              <Icon
                size={14}
                className={cn(
                  'transition-colors duration-200',
                  isActive ? tab.color : 'text-white/25',
                )}
              />
              {showBadge && (
                <div className={cn('absolute -top-0.5 -right-1 w-1.5 h-1.5 rounded-full', badgeColor)} />
              )}
            </div>

            <span
              className={cn(
                'text-[9px] font-medium tracking-wide transition-colors duration-200',
                isActive ? 'text-white/80' : 'text-white/20',
              )}
            >
              {tab.label}
            </span>
          </button>
        );
      })}
    </div>
  );
};
