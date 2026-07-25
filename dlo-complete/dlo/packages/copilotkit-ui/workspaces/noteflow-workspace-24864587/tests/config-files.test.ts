import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const projectRoot = process.cwd()

describe('Configuration Files', () => {
  describe('drizzle.config.ts', () => {
    it('should exist', () => {
      const exists = fs.existsSync(path.join(projectRoot, 'drizzle.config.ts'))
      expect(exists).toBe(true)
    })

    it('should import defineConfig from drizzle-kit', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'drizzle.config.ts'), 'utf-8')
      expect(content).toContain('defineConfig')
      expect(content).toMatch(/from ['"]drizzle-kit['"]/)
    })

    it('should configure PostgreSQL dialect', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'drizzle.config.ts'), 'utf-8')
      expect(content).toContain("dialect: 'postgresql'")
    })

    it('should reference schema file location', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'drizzle.config.ts'), 'utf-8')
      expect(content).toContain('./src/server/db/schema.ts')
    })

    it('should configure migrations output directory', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'drizzle.config.ts'), 'utf-8')
      expect(content).toContain('./drizzle/migrations')
    })

    it('should reference DATABASE_URL environment variable', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'drizzle.config.ts'), 'utf-8')
      expect(content).toContain('DATABASE_URL')
    })

    it('should export default config', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'drizzle.config.ts'), 'utf-8')
      expect(content).toContain('export default')
    })
  })

  describe('app.config.ts (TanStack Start)', () => {
    let appConfig: string

    it('should exist and be readable', () => {
      const exists = fs.existsSync(path.join(projectRoot, 'app.config.ts'))
      expect(exists).toBe(true)
      appConfig = fs.readFileSync(path.join(projectRoot, 'app.config.ts'), 'utf-8')
      expect(appConfig).toBeDefined()
      expect(appConfig.length).toBeGreaterThan(0)
    })

    it('should import defineConfig from @tanstack/start/config', () => {
      expect(appConfig).toMatch(/from ['"]@tanstack\/start\/config['"]/)
    })

    it('should export default configuration', () => {
      expect(appConfig).toContain('export default defineConfig')
    })

    it('should configure vite plugins', () => {
      expect(appConfig).toContain('vite:')
      expect(appConfig).toContain('plugins:')
    })

    it('should include viteTsconfigPaths plugin', () => {
      expect(appConfig).toContain('viteTsconfigPaths')
      expect(appConfig).toMatch(/viteTsconfigPaths\(\)/)
    })

    it('should import viteTsconfigPaths from vite-tsconfig-paths', () => {
      expect(appConfig).toMatch(/from ['"]vite-tsconfig-paths['"]/)
    })
  })

  describe('TypeScript Configuration (tsconfig.json)', () => {
    let tsconfig: Record<string, unknown>

    it('should load and parse as valid JSON', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'tsconfig.json'), 'utf-8')
      expect(() => {
        tsconfig = JSON.parse(content)
      }).not.toThrow()
    })

    it('should have compilerOptions', () => {
      expect(tsconfig).toHaveProperty('compilerOptions')
      expect(tsconfig.compilerOptions).toBeDefined()
    })

    it('should have jsx set to react-jsx', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>
      expect(compilerOptions.jsx).toBe('react-jsx')
    })

    it('should have jsxImportSource set to react', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>
      expect(compilerOptions.jsxImportSource).toBe('react')
    })

    it('should use ES2020 as target', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>
      expect(compilerOptions.target).toBe('ES2020')
    })

    it('should use ESNext module format', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>
      expect(compilerOptions.module).toBe('ESNext')
    })

    it('should use bundler module resolution', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>
      expect(compilerOptions.moduleResolution).toBe('bundler')
    })

    it('should have @/* path alias', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>
      const paths = compilerOptions.paths as Record<string, string[]>
      expect(paths).toBeDefined()
      expect(paths['@/*']).toEqual(['./src/*'])
    })

    it('should include strict and safety flags', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>
      expect(compilerOptions.strict).toBe(true)
      expect(compilerOptions.noUncheckedIndexedAccess).toBe(true)
      expect(compilerOptions.exactOptionalPropertyTypes).toBe(true)
      expect(compilerOptions.noUnusedLocals).toBe(true)
      expect(compilerOptions.noUnusedParameters).toBe(true)
      expect(compilerOptions.noImplicitReturns).toBe(true)
      expect(compilerOptions.noFallthroughCasesInSwitch).toBe(true)
      expect(compilerOptions.useUnknownInCatchVariables).toBe(true)
      expect(compilerOptions.forceConsistentCasingInFileNames).toBe(true)
    })

    it('should enable JSON module resolution', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>
      expect(compilerOptions.resolveJsonModule).toBe(true)
    })

    it('should include src directory', () => {
      expect(tsconfig.include).toContain('src')
    })

    it('should exclude node_modules and dist', () => {
      expect(tsconfig.exclude).toContain('node_modules')
      expect(tsconfig.exclude).toContain('dist')
    })
  })

  describe('vitest Configuration', () => {
    let vitestConfig: string

    it('should exist', () => {
      const exists = fs.existsSync(path.join(projectRoot, 'vitest.config.ts'))
      expect(exists).toBe(true)
      vitestConfig = fs.readFileSync(path.join(projectRoot, 'vitest.config.ts'), 'utf-8')
      expect(vitestConfig).toBeDefined()
    })

    it('should import defineConfig from vitest/config', () => {
      expect(vitestConfig).toMatch(/from ['"]vitest\/config['"]/)
    })

    it('should import react plugin from @vitejs/plugin-react', () => {
      expect(vitestConfig).toMatch(/from ['"]@vitejs\/plugin-react['"]/)
    })

    it('should import path module', () => {
      expect(vitestConfig).toContain("import path from 'path'")
    })

    it('should configure jsdom environment', () => {
      expect(vitestConfig).toContain("environment: 'jsdom'")
    })

    it('should enable globals', () => {
      expect(vitestConfig).toContain('globals: true')
    })

    it('should reference vitest.setup.ts', () => {
      expect(vitestConfig).toContain('./vitest.setup.ts')
    })

    it('should include react plugin', () => {
      expect(vitestConfig).toContain('plugins: [react()]')
    })

    it('should configure @/* path alias', () => {
      expect(vitestConfig).toContain("'@': path.resolve")
      expect(vitestConfig).toContain('./src')
    })
  })

  describe('.env.example', () => {
    let envExample: string

    it('should exist', () => {
      const exists = fs.existsSync(path.join(projectRoot, '.env.example'))
      expect(exists).toBe(true)
      envExample = fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf-8')
      expect(envExample).toBeDefined()
    })

    it('should document DATABASE_URL', () => {
      expect(envExample).toContain('DATABASE_URL')
      expect(envExample).toContain('postgresql://')
    })

    it('should document SESSION_SECRET', () => {
      expect(envExample).toContain('SESSION_SECRET')
      expect(envExample).toContain('32-byte-hex-string')
    })

    it('should document NODE_ENV', () => {
      expect(envExample).toContain('NODE_ENV')
      expect(envExample).toContain('development')
    })

    it('should document PORT', () => {
      expect(envExample).toContain('PORT')
      expect(envExample).toContain('3000')
    })

    it('should include generation instructions for SESSION_SECRET', () => {
      expect(envExample).toMatch(/generate with/)
    })

    it('should not contain actual secrets', () => {
      expect(envExample).not.toMatch(/^[a-f0-9]{64}$/m)
      expect(envExample).toContain('your-random')
    })
  })
})
