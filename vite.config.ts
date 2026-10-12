import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { darkTheme } from './src/build/dark-theme';
import { publicDocsPlugin } from './src/build/public-docs';
export default defineConfig({
  plugins: [react(), publicDocsPlugin()],
  css: { postcss: { plugins: [darkTheme()] } },
  build: { outDir: 'dist/client', target: 'es2022' },
  server: {
    port: 3460,
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
});
