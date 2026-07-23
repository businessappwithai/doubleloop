import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';

export default defineConfig({
  plugins: [tanstackStart(), react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [],
  },
});
