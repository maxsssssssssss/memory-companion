import { mergeConfig } from 'vitest/config';
import existing from '../../vitest.config';
export default mergeConfig(existing, { test: {
  include: ['src/lib/server/learning/*.test.ts', 'src/app/api/learning/*.test.ts', 'src/components/learning/*.test.tsx', 'src/components/product-system/product-system.test.tsx'],
  exclude: ['src/lib/server/learning/paddle-handoff.integration.test.ts', 'src/lib/server/learning/pdf-real-regression.test.ts'],
  maxWorkers: 2,
} });
