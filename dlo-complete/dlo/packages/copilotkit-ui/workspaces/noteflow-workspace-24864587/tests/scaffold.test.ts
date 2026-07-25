import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const projectRoot = process.cwd()

describe('Project Scaffold', () => {
  describe('package.json', () => {
    let packageJson: Record<string, unknown>

    it('should exist and be valid JSON', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')
      expect(() => {
        packageJson = JSON.parse(content)
      }).not.toThrow()
    })

    it('should have required metadata fields', () => {
      expect(packageJson).toHaveProperty('name', 'noteflow-workspace')
      expect(packageJson).toHaveProperty('version')
      expect(packageJson).toHaveProperty('type', 'module')
    })

    it('should not declare a packageManager to allow npm install', () => {
      expect(packageJson).not.toHaveProperty('packageManager')
    })

    it('should have all required runtime dependencies', () => {
      const requiredDeps = [
        'react',
        'react-dom',
        'drizzle-orm',
        'postgres',
        'argon2',
        'zod',
        'cookie',
        'crypto-js',
      ]

      const dependencies = packageJson.dependencies as Record<string, string>
      requiredDeps.forEach((dep) => {
        expect(dependencies).toHaveProperty(dep)
        expect(dependencies[dep]).toMatch(/^\^?[\d.]+/)
      })
    })

    it('should have all required devDependencies', () => {
      const requiredDevDeps = [
        '@tanstack/start',
        '@tanstack/react-router',
        'typescript',
        'vite',
        'drizzle-kit',
        'vitest',
        'jsdom',
        '@testing-library/react',
        '@testing-library/jest-dom',
        '@testing-library/user-event',
        'tsx',
      ]

      const devDependencies = packageJson.devDependencies as Record<string, string>
      requiredDevDeps.forEach((dep) => {
        expect(devDependencies).toHaveProperty(dep)
        expect(devDependencies[dep]).toMatch(/^\^?[\d.]+/)
      })
    })

    it('vite should be ^7.1.0 to satisfy @vitejs/plugin-react@^4.3.1 compatibility', () => {
      const devDependencies = packageJson.devDependencies as Record<string, string>
      expect(devDependencies.vite).toBe('^7.1.0')
    })

    it('vite ^7.1.0 is compatible with @vitejs/plugin-react and @tanstack/react-start', () => {
      const devDependencies = packageJson.devDependencies as Record<string, string>
      const viteVersion = devDependencies.vite
      expect(viteVersion).toBe('^7.1.0')
      expect(viteVersion).not.toMatch(/^\^8/)
      expect(viteVersion).not.toMatch(/^\^5/)
      expect(viteVersion).not.toMatch(/^\^6/)
    })

    it('should have required scripts', () => {
      const scripts = packageJson.scripts as Record<string, string>
      expect(scripts).toHaveProperty('dev')
      expect(scripts).toHaveProperty('build')
      expect(scripts).toHaveProperty('preview')
      expect(scripts).toHaveProperty('typecheck')
      expect(scripts).toHaveProperty('test')
      expect(scripts).toHaveProperty('db:generate')
      expect(scripts).toHaveProperty('db:migrate')
    })

    it('test script should use vitest run without passWithNoTests', () => {
      const scripts = packageJson.scripts as Record<string, string>
      expect(scripts.test).toBe('vitest run')
      expect(scripts.test).not.toContain('--passWithNoTests')
    })

    it('scripts should have correct values', () => {
      const scripts = packageJson.scripts as Record<string, string>
      expect(scripts.dev).toBe('tanstack-start dev')
      expect(scripts.build).toBe('tanstack-start build')
      expect(scripts.typecheck).toBe('tsc --noEmit')
    })
  })

  describe('tsconfig.json', () => {
    let tsconfig: Record<string, unknown>

    it('should exist and be valid JSON', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'tsconfig.json'), 'utf-8')
      expect(() => {
        tsconfig = JSON.parse(content)
      }).not.toThrow()
    })

    it('should have strict mode enabled', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>
      expect(compilerOptions.strict).toBe(true)
    })

    it('should have strict safety flags enabled', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>
      expect(compilerOptions.noUncheckedIndexedAccess).toBe(true)
      expect(compilerOptions.exactOptionalPropertyTypes).toBe(true)
      expect(compilerOptions.noUnusedLocals).toBe(true)
      expect(compilerOptions.noUnusedParameters).toBe(true)
      expect(compilerOptions.noImplicitReturns).toBe(true)
      expect(compilerOptions.noFallthroughCasesInSwitch).toBe(true)
      expect(compilerOptions.useUnknownInCatchVariables).toBe(true)
      expect(compilerOptions.forceConsistentCasingInFileNames).toBe(true)
    })

    it('should have module resolution configured', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>
      expect(compilerOptions.moduleResolution).toBe('bundler')
      expect(compilerOptions.module).toBe('ESNext')
      expect(compilerOptions.target).toBe('ES2020')
    })

    it('should have path alias for @/', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>
      const paths = compilerOptions.paths as Record<string, string[]>
      expect(paths['@/*']).toEqual(['./src/*'])
    })

    it('should include src and exclude node_modules and dist', () => {
      expect(tsconfig.include).toContain('src')
      expect(tsconfig.exclude).toContain('node_modules')
      expect(tsconfig.exclude).toContain('dist')
    })

    it('should have JSX configured for React', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>
      expect(compilerOptions.jsx).toBe('react-jsx')
      expect(compilerOptions.jsxImportSource).toBe('react')
    })
  })

  describe('.env.example', () => {
    it('should exist', () => {
      const exists = fs.existsSync(path.join(projectRoot, '.env.example'))
      expect(exists).toBe(true)
    })

    it('should contain required environment variables', () => {
      const content = fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf-8')
      expect(content).toContain('DATABASE_URL')
      expect(content).toContain('SESSION_SECRET')
      expect(content).toContain('NODE_ENV')
      expect(content).toContain('PORT')
    })

    it('should have example values', () => {
      const content = fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf-8')
      expect(content).toContain('postgresql://')
      expect(content).toContain('development')
    })

    it('should not contain real secrets', () => {
      const content = fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf-8')
      expect(content).toContain('your-random-32-byte-hex-string-here')
      expect(content).not.toMatch(/^[a-f0-9]{64}$/m)
    })
  })

  describe('app.config.ts', () => {
    it('should exist', () => {
      const exists = fs.existsSync(path.join(projectRoot, 'app.config.ts'))
      expect(exists).toBe(true)
    })

    it('should be valid TypeScript', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'app.config.ts'), 'utf-8')
      expect(content).toContain('defineConfig')
      expect(content).toContain('export default')
    })

    it('should import from @tanstack/start/config', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'app.config.ts'), 'utf-8')
      expect(content).toMatch(/from ['"]@tanstack\/start\/config['"]/)
    })

    it('should configure vite plugins for TypeScript path resolution', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'app.config.ts'), 'utf-8')
      expect(content).toContain('vite')
      expect(content).toContain('plugins')
      expect(content).toContain('viteTsconfigPaths')
    })

    it('should import viteTsconfigPaths', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'app.config.ts'), 'utf-8')
      expect(content).toMatch(/from ['"]vite-tsconfig-paths['"]/)
    })
  })

  describe('Route files', () => {
    it('src/routes/__root.tsx should exist', () => {
      const exists = fs.existsSync(path.join(projectRoot, 'src/routes/__root.tsx'))
      expect(exists).toBe(true)
    })

    it('src/routes/index.tsx should exist', () => {
      const exists = fs.existsSync(path.join(projectRoot, 'src/routes/index.tsx'))
      expect(exists).toBe(true)
    })

    it('__root.tsx should define the root route', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'src/routes/__root.tsx'), 'utf-8')
      expect(content).toContain('createRootRoute')
      expect(content).toContain('Outlet')
      expect(content).toContain('export const Route')
    })

    it('__root.tsx should render HTML structure', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'src/routes/__root.tsx'), 'utf-8')
      expect(content).toContain('<html')
      expect(content).toContain('<head>')
      expect(content).toContain('<body>')
      expect(content).toContain('<meta charSet="utf-8"')
      expect(content).toContain('viewport')
    })

    it('index.tsx should define file route', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'src/routes/index.tsx'), 'utf-8')
      expect(content).toContain('createFileRoute')
      expect(content).toContain("createFileRoute('/')")
      expect(content).toContain('export const Route')
    })

    it('index.tsx should have placeholder page content', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'src/routes/index.tsx'), 'utf-8')
      expect(content).toContain('NoteFlow')
      expect(content).toContain('component:')
    })

    it('__root.tsx should have all required imports', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'src/routes/__root.tsx'), 'utf-8')
      expect(content).toContain("from '@tanstack/react-router'")
      expect(content).toContain('createRootRoute')
      expect(content).toContain('Outlet')
    })

    it('index.tsx should have all required imports', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'src/routes/index.tsx'), 'utf-8')
      expect(content).toContain("from '@tanstack/react-router'")
      expect(content).toContain('createFileRoute')
    })

    it('__root.tsx should render Outlet for nested routes', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'src/routes/__root.tsx'), 'utf-8')
      expect(content).toContain('<Outlet />')
    })

    it('__root.tsx should have proper HTML meta tags', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'src/routes/__root.tsx'), 'utf-8')
      expect(content).toContain('charSet="utf-8"')
      expect(content).toContain('name="viewport"')
      expect(content).toContain('content="width=device-width, initial-scale=1"')
    })
  })

  describe('.gitignore', () => {
    it('should exist', () => {
      const exists = fs.existsSync(path.join(projectRoot, '.gitignore'))
      expect(exists).toBe(true)
    })

    it('should ignore node_modules', () => {
      const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(content).toContain('node_modules/')
    })

    it('should ignore environment files', () => {
      const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(content).toContain('.env')
    })

    it('should ignore build outputs', () => {
      const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(content).toContain('dist/')
      expect(content).toContain('build/')
    })

    it('should ignore IDE files', () => {
      const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(content).toContain('.vscode/')
      expect(content).toContain('.idea/')
      expect(content).toContain('.DS_Store')
    })
  })

  describe('vitest configuration', () => {
    it('vitest.config.ts should exist', () => {
      const exists = fs.existsSync(path.join(projectRoot, 'vitest.config.ts'))
      expect(exists).toBe(true)
    })

    it('vitest.setup.ts should exist', () => {
      const exists = fs.existsSync(path.join(projectRoot, 'vitest.setup.ts'))
      expect(exists).toBe(true)
    })

    it('vitest.config.ts should configure jsdom environment', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'vitest.config.ts'), 'utf-8')
      expect(content).toContain('environment')
      expect(content).toContain('jsdom')
    })

    it('vitest.config.ts should enable globals', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'vitest.config.ts'), 'utf-8')
      expect(content).toContain('globals: true')
    })

    it('vitest.setup.ts should import testing library cleanup', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'vitest.setup.ts'), 'utf-8')
      expect(content).toContain('@testing-library/react')
      expect(content).toContain('cleanup')
      expect(content).toContain('afterEach')
    })
  })

  describe('Project structure', () => {
    it('should have src directory with routes', () => {
      const srcExists = fs.existsSync(path.join(projectRoot, 'src'))
      const routesExists = fs.existsSync(path.join(projectRoot, 'src/routes'))
      expect(srcExists).toBe(true)
      expect(routesExists).toBe(true)
    })

    it('should have all required top-level config files', () => {
      const files = [
        'package.json',
        'tsconfig.json',
        'app.config.ts',
        '.env.example',
        '.gitignore',
        'vitest.config.ts',
        'vitest.setup.ts',
      ]

      files.forEach((file) => {
        const exists = fs.existsSync(path.join(projectRoot, file))
        expect(exists).toBe(true)
      })
    })
  })
})
