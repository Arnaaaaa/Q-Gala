import { defineConfig } from 'vite';

// Relative base so the build works from any GitHub Pages path.
export default defineConfig({
  base: './',
  server: { port: 5173 },
  build: { target: 'es2020' },
});
