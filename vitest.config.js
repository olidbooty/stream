import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

export default mergeConfig(
  viteConfig,
  defineConfig({
    // vite.config.js roots Vite at client/; tests are resolved from the repo root.
    root: '.',
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'server',
            environment: 'node',
            include: ['server/**/*.test.js'],
          },
        },
        {
          extends: true,
          test: {
            name: 'client',
            environment: 'jsdom',
            include: ['client/**/*.test.js', 'test/**/*.test.js'],
          },
        },
      ],
      coverage: {
        provider: 'v8',
        include: ['server/**/*.js', 'client/src/**/*.js'],
        exclude: ['**/*.test.js', 'server/index.js'],
      },
    },
  }),
);
