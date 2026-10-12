import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      exclude: [...configDefaults.exclude, 'artifacts/**', 'agent/test/**'],
      // Runtime probes start fresh SDK processes with a 15-second child limit.
      testTimeout: 20_000,
    },
  }),
);
