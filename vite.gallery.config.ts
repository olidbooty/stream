import { defineConfig } from 'vite';

// The component gallery (2.7): a static page with no server, deployed to
// GitHub Pages. Relative asset URLs, so it works under the repo's Pages path.
export default defineConfig({
  root: 'client/gallery',
  base: './',
  build: {
    outDir: '../../dist-gallery',
    emptyOutDir: true,
  },
});
