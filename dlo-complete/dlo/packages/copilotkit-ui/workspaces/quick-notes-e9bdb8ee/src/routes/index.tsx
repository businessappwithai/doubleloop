import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState, useEffect } from 'react';
import { NoteList } from '../components/NoteList';
import { getNoteService, NoteServiceError, type Note } from '../server/note-service';

type ListNotesResult = { notes: Note[] } | { error: { code: string; message: string } };

export const listNotesFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ListNotesResult> => {
    try {
      const notes = await getNoteService().listNotes();
      return { notes };
    } catch (error) {
      if (error instanceof NoteServiceError) {
        return { error: { code: error.code, message: error.message } };
      }
      throw error;
    }
  }
);

type DeleteNoteResult = { success: true } | { error: { code: string; message: string } };

export const deleteNoteFn = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<DeleteNoteResult> => {
    if (!id) {
      return { error: { code: 'VALIDATION', message: 'Note ID is required' } };
    }

    try {
      await getNoteService().deleteNote(id);
      return { success: true };
    } catch (error) {
      if (error instanceof NoteServiceError) {
        return { error: { code: error.code, message: error.message } };
      }
      throw error;
    }
  });

export const Route = createFileRoute('/')({
  component: IndexRoute,
  loader: async () => {
    return await listNotesFn();
  },
});

function IndexRoute() {
  const navigate = useNavigate();
  const loaderData = Route.useLoaderData();
  const [notes, setNotes] = useState<Note[]>(() => {
    return 'notes' in loaderData ? loaderData.notes : [];
  });
  const [error, setError] = useState<string | null>(() => {
    return 'error' in loaderData ? loaderData.error.message : null;
  });

  useEffect(() => {
    if ('notes' in loaderData) {
      setNotes(loaderData.notes);
    }
  }, [loaderData]);

  const handleDelete = async (id: string) => {
    setError(null);
    const result = await deleteNoteFn({ data: id });

    if ('error' in result) {
      setError(result.error.message);
      return;
    }

    // Refresh the list after successful deletion
    const refreshResult = await listNotesFn();
    if ('notes' in refreshResult) {
      setNotes(refreshResult.notes);
    } else {
      setError(refreshResult.error.message);
    }
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Quick Notes</h1>
        <button
          onClick={() => navigate({ to: '/notes/new' })}
          className="btn-primary"
        >
          New Note
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <NoteList notes={notes} onDelete={handleDelete} />
    </div>
  );
}
