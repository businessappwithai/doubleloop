import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const projectRoot = process.cwd()

describe('Complete Project Scaffold Verification', () => {
  describe('File existence', () => {
    const requiredFiles = [
      'package.json',
      'tsconfig.json',
      'app.config.ts',
      '.env.example',
      '.gitignore',
      'vitest.config.ts',
      'vitest.setup.ts',
      'drizzle.config.ts',
      'src/routes/__root.tsx',
      'src/routes/index.tsx',
    ]

    requiredFiles.forEach((file) => {
      it(`should have ${file}`, () => {
        const exists = fs.existsSync(path.join(projectRoot, file))
        expect(exists).toBe(true)
      })
    })
  })

  describe('Vite version fix', () => {
    it('vite version should be ^7.1.0 (compatible with @vitejs/plugin-react@^4.3.1)', () => {
      const packageJsonPath = path.join(projectRoot, 'package.json')
      const content = fs.readFileSync(packageJsonPath, 'utf-8')
      const packageJson = JSON.parse(content)
      const devDependencies = packageJson.devDependencies as Record<string, string>

      expect(devDependencies.vite).toBe('^7.1.0')
    })

    it('@vitejs/plugin-react version should be compatible with vite 7.x', () => {
      const packageJsonPath = path.join(projectRoot, 'package.json')
      const content = fs.readFileSync(packageJsonPath, 'utf-8')
      const packageJson = JSON.parse(content)
      const devDependencies = packageJson.devDependencies as Record<string, string>

      expect(devDependencies['@vitejs/plugin-react']).toBe('^4.3.1')
    })

    it('vite and @vitejs/plugin-react versions should be compatible', () => {
      const packageJsonPath = path.join(projectRoot, 'package.json')
      const content = fs.readFileSync(packageJsonPath, 'utf-8')
      const packageJson = JSON.parse(content)
      const devDependencies = packageJson.devDependencies as Record<string, string>

      const viteVersion = devDependencies.vite
      const pluginVersion = devDependencies['@vitejs/plugin-react']

      const viteMajor = parseInt(viteVersion.match(/\d+/)?.[0] || '0')
      expect(viteMajor).toBe(7)
      expect(pluginVersion).toBe('^4.3.1')
    })
  })

  describe('package.json structure', () => {
    let packageJson: Record<string, unknown>

    it('should be valid JSON', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')
      expect(() => {
        packageJson = JSON.parse(content)
      }).not.toThrow()
    })

    it('should have name noteflow-workspace', () => {
      expect(packageJson.name).toBe('noteflow-workspace')
    })

    it('should have type module', () => {
      expect(packageJson.type).toBe('module')
    })

    it('should have version 0.1.0', () => {
      expect(packageJson.version).toBe('0.1.0')
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
      })
    })

    it('should have all required dev dependencies', () => {
      const requiredDevDeps = [
        '@tanstack/start',
        '@tanstack/react-router',
        '@vitejs/plugin-react',
        'typescript',
        'vite',
        'vite-tsconfig-paths',
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
      })
    })

    it('should have required scripts', () => {
      const scripts = packageJson.scripts as Record<string, string>

      expect(scripts.dev).toBe('tanstack-start dev')
      expect(scripts.build).toBe('tanstack-start build')
      expect(scripts.preview).toBe('tanstack-start preview')
      expect(scripts.typecheck).toBe('tsc --noEmit')
      expect(scripts.test).toBe('vitest run')
      expect(scripts['db:generate']).toBe('drizzle-kit generate')
      expect(scripts['db:migrate']).toContain('tsx')
    })
  })

  describe('TypeScript configuration', () => {
    let tsconfig: Record<string, unknown>

    it('should be valid JSON', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'tsconfig.json'), 'utf-8')
      expect(() => {
        tsconfig = JSON.parse(content)
      }).not.toThrow()
    })

    it('should have strict compiler options', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>

      expect(compilerOptions.strict).toBe(true)
      expect(compilerOptions.noUncheckedIndexedAccess).toBe(true)
      expect(compilerOptions.exactOptionalPropertyTypes).toBe(true)
      expect(compilerOptions.noUnusedLocals).toBe(true)
      expect(compilerOptions.noUnusedParameters).toBe(true)
      expect(compilerOptions.noImplicitReturns).toBe(true)
      expect(compilerOptions.noFallthroughCasesInSwitch).toBe(true)
      expect(compilerOptions.useUnknownInCatchVariables).toBe(true)
    })

    it('should have path alias @/* -> ./src/*', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>
      const paths = compilerOptions.paths as Record<string, string[]>

      expect(paths['@/*']).toEqual(['./src/*'])
    })

    it('should target ES2020 with ESNext module', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>

      expect(compilerOptions.target).toBe('ES2020')
      expect(compilerOptions.module).toBe('ESNext')
      expect(compilerOptions.moduleResolution).toBe('bundler')
    })

    it('should configure JSX for React', () => {
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>

      expect(compilerOptions.jsx).toBe('react-jsx')
      expect(compilerOptions.jsxImportSource).toBe('react')
    })
  })

  describe('Environment configuration', () => {
    let envExample: string

    it('.env.example should exist', () => {
      const exists = fs.existsSync(path.join(projectRoot, '.env.example'))
      expect(exists).toBe(true)
      envExample = fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf-8')
    })

    it('should document DATABASE_URL', () => {
      expect(envExample).toContain('DATABASE_URL')
      expect(envExample).toContain('postgresql://')
    })

    it('should document SESSION_SECRET', () => {
      expect(envExample).toContain('SESSION_SECRET')
      expect(envExample).toContain('32-byte-hex-string')
    })

    it('should document NODE_ENV and PORT', () => {
      expect(envExample).toContain('NODE_ENV')
      expect(envExample).toContain('PORT')
      expect(envExample).toContain('3000')
    })

    it('should not contain real secrets', () => {
      expect(envExample).not.toMatch(/^[a-f0-9]{64}$/m)
    })
  })

  describe('Route components', () => {
    it('__root.tsx should define root route component', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'src/routes/__root.tsx'), 'utf-8')

      expect(content).toContain('createRootRoute')
      expect(content).toContain('Outlet')
      expect(content).toContain('html lang="en"')
      expect(content).toContain('NoteFlow')
    })

    it('index.tsx should define home route component', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'src/routes/index.tsx'), 'utf-8')

      expect(content).toContain('createFileRoute')
      expect(content).toContain('createFileRoute()')
      expect(content).toContain('Welcome to NoteFlow')
      expect(content).toContain('Notion-like collaborative workspace')
    })
  })

  describe('Configuration files', () => {
    it('app.config.ts should export TanStack Start configuration', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'app.config.ts'), 'utf-8')

      expect(content).toContain('defineConfig')
      expect(content).toContain('@tanstack/start/config')
      expect(content).toContain('vite')
      expect(content).toContain('viteTsconfigPaths')
    })

    it('drizzle.config.ts should export Drizzle Kit configuration', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'drizzle.config.ts'), 'utf-8')

      expect(content).toContain('defineConfig')
      expect(content).toContain("dialect: 'postgresql'")
      expect(content).toContain('./src/server/db/schema.ts')
      expect(content).toContain('./drizzle/migrations')
    })

    it('vitest.config.ts should configure test environment', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'vitest.config.ts'), 'utf-8')

      expect(content).toContain('@vitejs/plugin-react')
      expect(content).toContain("environment: 'jsdom'")
      expect(content).toContain('globals: true')
      expect(content).toContain('./vitest.setup.ts')
    })

    it('vitest.setup.ts should configure testing library', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'vitest.setup.ts'), 'utf-8')

      expect(content).toContain('@testing-library/jest-dom')
      expect(content).toContain('cleanup')
      expect(content).toContain('afterEach')
    })
  })

  describe('.gitignore configuration', () => {
    it('should ignore dependencies', () => {
      const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(content).toContain('node_modules/')
    })

    it('should ignore environment files', () => {
      const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(content).toContain('.env')
      expect(content).toContain('.env.local')
    })

    it('should ignore build artifacts', () => {
      const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(content).toContain('dist/')
      expect(content).toContain('build/')
    })

    it('should ignore IDE and editor files', () => {
      const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(content).toContain('.vscode/')
      expect(content).toContain('.idea/')
      expect(content).toContain('.DS_Store')
    })

    it('should ignore test coverage', () => {
      const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(content).toContain('coverage/')
    })
  })

  describe('Development readiness', () => {
    it('package.json should not have packageManager field (to allow npm install)', () => {
      const packageJsonPath = path.join(projectRoot, 'package.json')
      const content = fs.readFileSync(packageJsonPath, 'utf-8')
      const packageJson = JSON.parse(content)

      expect(packageJson).not.toHaveProperty('packageManager')
    })

    it('all dependencies should use caret versions for flexibility', () => {
      const packageJsonPath = path.join(projectRoot, 'package.json')
      const content = fs.readFileSync(packageJsonPath, 'utf-8')
      const packageJson = JSON.parse(content)
      const devDependencies = packageJson.devDependencies as Record<string, string>

      Object.entries(devDependencies).forEach(([name, version]) => {
        expect(version).toMatch(/^\^/, `${name} should use caret range, got: ${version}`)
      })
    })

    it('src and tests directories should exist', () => {
      const srcExists = fs.existsSync(path.join(projectRoot, 'src'))
      const routesExists = fs.existsSync(path.join(projectRoot, 'src/routes'))
      const testsExists = fs.existsSync(path.join(projectRoot, 'tests'))

      expect(srcExists).toBe(true)
      expect(routesExists).toBe(true)
      expect(testsExists).toBe(true)
    })
  })
})
