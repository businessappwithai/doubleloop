import { describe, it, expect } from 'vitest'

describe('Smoke Test', () => {
  it('should pass', () => {
    expect(true).toBe(true)
  })

  it('should support basic arithmetic', () => {
    expect(2 + 2).toBe(4)
  })
})
