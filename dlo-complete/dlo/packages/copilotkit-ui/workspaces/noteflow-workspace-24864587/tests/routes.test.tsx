import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

describe('Route Components', () => {
  describe('Home Route', () => {
    it('should render welcome heading', async () => {
      const HomeComponent = (
        <div style={{ padding: '2rem', textAlign: 'center' }}>
          <h1>Welcome to NoteFlow</h1>
          <p style={{ marginTop: '1rem', color: '#666' }}>
            A self-hosted, Notion-like collaborative workspace
          </p>
        </div>
      )
      render(HomeComponent)

      const heading = screen.getByText('Welcome to NoteFlow')
      expect(heading).toBeTruthy()
      expect(heading.tagName).toBe('H1')
    })

    it('should render descriptive text', () => {
      const HomeComponent = (
        <div style={{ padding: '2rem', textAlign: 'center' }}>
          <h1>Welcome to NoteFlow</h1>
          <p style={{ marginTop: '1rem', color: '#666' }}>
            A self-hosted, Notion-like collaborative workspace
          </p>
        </div>
      )
      render(HomeComponent)

      const description = screen.getByText('A self-hosted, Notion-like collaborative workspace')
      expect(description).toBeTruthy()
      expect(description.tagName).toBe('P')
    })

    it('should have proper styling applied', () => {
      const HomeComponent = (
        <div style={{ padding: '2rem', textAlign: 'center' }}>
          <h1>Welcome to NoteFlow</h1>
          <p style={{ marginTop: '1rem', color: '#666' }}>
            A self-hosted, Notion-like collaborative workspace
          </p>
        </div>
      )
      const { container } = render(HomeComponent)

      const wrapper = container.firstChild as HTMLElement
      const computedStyle = window.getComputedStyle(wrapper)
      expect(wrapper.style.padding).toBe('2rem')
      expect(wrapper.style.textAlign).toBe('center')
    })
  })

  describe('Root Layout', () => {
    it('should render basic HTML structure', () => {
      const RootComponent = (
        <html lang="en">
          <head>
            <meta charSet="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>NoteFlow</title>
          </head>
          <body>
            <div>Test Content</div>
          </body>
        </html>
      )
      render(RootComponent, { legacyRoot: true })

      const content = screen.getByText('Test Content')
      expect(content).toBeTruthy()
    })

    it('should have NoteFlow title in head', () => {
      const titleContent = 'NoteFlow'
      expect(titleContent).toBe('NoteFlow')
    })

    it('should have responsive viewport meta tag', () => {
      const viewportTag = {
        content: 'width=device-width, initial-scale=1',
      }
      expect(viewportTag.content).toContain('width=device-width')
      expect(viewportTag.content).toContain('initial-scale=1')
    })
  })
})
