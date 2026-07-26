import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const projectRoot = process.cwd()

describe('Dependency Resolution', () => {
  describe('package.json dependency compatibility', () => {
    let packageJson: Record<string, unknown>

    it('should load package.json', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')
      packageJson = JSON.parse(content)
      expect(packageJson).toBeDefined()
    })

    it('vite should satisfy @tanstack/react-start peer dependency >=7.0.0', () => {
      const devDependencies = packageJson.devDependencies as Record<string, string>
      const viteVersion = devDependencies.vite

      expect(viteVersion).toBe('^7.1.0')
      const majorVersion = parseInt(viteVersion.match(/\d+/)?.[0] || '0')
      expect(majorVersion).toBeGreaterThanOrEqual(7)
    })

    it('@tanstack/start should be in devDependencies only', () => {
      const dependencies = packageJson.dependencies as Record<string, string>
      const devDependencies = packageJson.devDependencies as Record<string, string>

      expect(dependencies['@tanstack/react-start']).toBeUndefined()
      expect(dependencies['@tanstack/start']).toBeUndefined()
      expect(devDependencies['@tanstack/start']).toBeDefined()
    })

    it('react and react-dom versions should match', () => {
      const dependencies = packageJson.dependencies as Record<string, string>

      const reactVersion = dependencies.react
      const reactDomVersion = dependencies['react-dom']

      expect(reactVersion).toBe(reactDomVersion)
    })

    it('drizzle-orm and drizzle-kit should be compatible', () => {
      const dependencies = packageJson.dependencies as Record<string, string>
      const devDependencies = packageJson.devDependencies as Record<string, string>

      const drmVersion = dependencies['drizzle-orm']
      const drkVersion = devDependencies['drizzle-kit']

      expect(drmVersion).toBeDefined()
      expect(drkVersion).toBeDefined()

      const drmMajor = parseInt(drmVersion.match(/\d+/)?.[0] || '0')
      const drkMajor = parseInt(drkVersion.match(/\d+/)?.[0] || '0')

      expect(drmMajor).toBeGreaterThan(0)
      expect(drkMajor).toBeGreaterThan(0)
    })

    it('typescript should be present for development', () => {
      const devDependencies = packageJson.devDependencies as Record<string, string>

      expect(devDependencies.typescript).toBeDefined()
      expect(devDependencies.typescript).toMatch(/^\^/)
    })

    it('testing dependencies should be present', () => {
      const devDependencies = packageJson.devDependencies as Record<string, string>

      expect(devDependencies.vitest).toBeDefined()
      expect(devDependencies.jsdom).toBeDefined()
      expect(devDependencies['@testing-library/react']).toBeDefined()
      expect(devDependencies['@testing-library/jest-dom']).toBeDefined()
    })

    it('zod should be available for validation', () => {
      const dependencies = packageJson.dependencies as Record<string, string>

      expect(dependencies.zod).toBeDefined()
      expect(dependencies.zod).toMatch(/^\^/)
    })

    it('all dependencies should use caret ranges for flexibility', () => {
      const dependencies = packageJson.dependencies as Record<string, string>
      const devDependencies = packageJson.devDependencies as Record<string, string>

      Object.entries(dependencies).forEach(([name, version]) => {
        if (name !== 'react' && name !== 'react-dom') {
          expect(version).toMatch(/^\^/, `Dependency ${name} should use caret range`)
        }
      })

      Object.entries(devDependencies).forEach(([name, version]) => {
        expect(version).toMatch(/^\^/, `Dev dependency ${name} should use caret range`)
      })
    })

    it('postgres client should be installed', () => {
      const dependencies = packageJson.dependencies as Record<string, string>

      expect(dependencies.postgres).toBeDefined()
      expect(dependencies.postgres).toMatch(/^\^/)
    })

    it('argon2 password hashing library should be installed', () => {
      const dependencies = packageJson.dependencies as Record<string, string>

      expect(dependencies.argon2).toBeDefined()
      expect(dependencies.argon2).toMatch(/^\^/)
    })

    it('cookie parser should be installed for session management', () => {
      const dependencies = packageJson.dependencies as Record<string, string>

      expect(dependencies.cookie).toBeDefined()
      expect(dependencies.cookie).toMatch(/^\^/)
    })

    it('crypto utilities should be available', () => {
      const dependencies = packageJson.dependencies as Record<string, string>

      expect(dependencies['crypto-js']).toBeDefined()
      expect(dependencies['crypto-js']).toMatch(/^\^/)
    })
  })

  describe('package.json script configuration', () => {
    let packageJson: Record<string, unknown>

    it('should load package.json', () => {
      const content = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')
      packageJson = JSON.parse(content)
      expect(packageJson).toBeDefined()
    })

    it('should have dev script that uses tanstack-start', () => {
      const scripts = packageJson.scripts as Record<string, string>
      expect(scripts.dev).toBe('tanstack-start dev')
    })

    it('should have build script that uses tanstack-start', () => {
      const scripts = packageJson.scripts as Record<string, string>
      expect(scripts.build).toBe('tanstack-start build')
    })

    it('should have preview script', () => {
      const scripts = packageJson.scripts as Record<string, string>
      expect(scripts.preview).toBeDefined()
      expect(scripts.preview).toContain('tanstack-start')
    })

    it('should have typecheck script using tsc', () => {
      const scripts = packageJson.scripts as Record<string, string>
      expect(scripts.typecheck).toBe('tsc --noEmit')
    })

    it('should have test script using vitest run', () => {
      const scripts = packageJson.scripts as Record<string, string>
      expect(scripts.test).toBe('vitest run')
    })

    it('should have database generation script', () => {
      const scripts = packageJson.scripts as Record<string, string>
      expect(scripts['db:generate']).toBeDefined()
      expect(scripts['db:generate']).toContain('drizzle-kit')
    })

    it('should have database migration script', () => {
      const scripts = packageJson.scripts as Record<string, string>
      expect(scripts['db:migrate']).toBeDefined()
    })
  })
})
