import { defineConfig } from '@tanstack/start/config'
import viteTsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  vite: {
    plugins: [viteTsconfigPaths()],
  },
})
