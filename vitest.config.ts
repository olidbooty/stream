import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

export default mergeConfig(
  viteConfig,
  defineConfig({
    // vite.config.ts roots Vite at client/; tests are resolved from the repo root.
    root: '.',
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'server',
            environment: 'node',
            include: ['server/**/*.test.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'client',
            environment: 'jsdom',
            include: ['client/**/*.test.ts', 'test/**/*.test.ts'],
          },
        },
      ],
      coverage: {
        provider: 'v8',
        include: ['server/**/*.ts', 'client/src/**/*.ts'],
        exclude: ['**/*.test.ts', 'server/index.ts'],
      },
    },
  }),
);
