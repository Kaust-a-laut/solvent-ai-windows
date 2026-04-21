import React from 'react';
import { motion } from 'framer-motion';
import { WaterfallVisualizer } from '../WaterfallVisualizer';
import { VIEW_TRANSITION } from './types';

export const PipWaterfallView: React.FC = () => (
  <motion.div
    key="waterfall"
    {...VIEW_TRANSITION}
    className="flex-1 flex flex-col overflow-y-auto fluid-scrollbar"
  >
    <div className="p-3"><WaterfallVisualizer /></div>
  </motion.div>
);
