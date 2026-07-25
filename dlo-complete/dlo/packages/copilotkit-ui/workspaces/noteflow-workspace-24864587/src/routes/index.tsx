import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: () => (
    <div style={{ padding: '2rem', textAlign: 'center' }}>
      <h1>Welcome to NoteFlow</h1>
      <p style={{ marginTop: '1rem', color: '#666' }}>
        A self-hosted, Notion-like collaborative workspace
      </p>
    </div>
  ),
})
