import React from 'react';
import { motion } from 'framer-motion';
import { IntelPanel } from '../IntelPanel';
import { VIEW_TRANSITION } from './types';

export const PipIntelView: React.FC = () => (
  <motion.div
    key="intel"
    {...VIEW_TRANSITION}
    className="flex-1 flex flex-col overflow-hidden"
  >
    <IntelPanel />
  </motion.div>
);
