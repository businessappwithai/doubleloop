import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState, useEffect } from 'react';
import { NoteForm } from '../components/NoteForm';
import { getNoteService, NoteServiceError, type Note, type NoteInput } from '../server/note-service';

type GetNoteResult = { success: true; note: Note } | { success: false; error: { code: string; message: string } };

const getNoteFn = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<GetNoteResult> => {
    if (!id) {
      return { success: false, error: { code: 'VALIDATION', message: 'Note ID is required' } };
    }

    try {
      const note = await getNoteService().getNote(id);
      if (!note) {
        return { success: false, error: { code: 'NOT_FOUND', message: `Note with ID "${id}" not found` } };
      }
      return { success: true, note };
    } catch (error) {
      if (error instanceof NoteServiceError) {
        return { success: false, error: { code: error.code, message: error.message } };
      }
      throw error;
    }
  });

type UpdateNoteResult = { success: true; note: Note } | { success: false; error: { code: string; message: string } };

const updateNoteFn = createServerFn({ method: 'POST' })
  .validator((params: { id: string; input: NoteInput }) => params)
  .handler(async ({ data: params }): Promise<UpdateNoteResult> => {
    const { id, input } = params;
    if (!id) {
      return { success: false, error: { code: 'VALIDATION', message: 'Note ID is required' } };
    }

    try {
      const note = await getNoteService().updateNote(id, input);
      return { success: true, note };
    } catch (error) {
      if (error instanceof NoteServiceError) {
        return { success: false, error: { code: error.code, message: error.message } };
      }
      return { success: false, error: { code: 'UNKNOWN', message: 'An unexpected error occurred' } };
    }
  });

type DeleteNoteResult = { success: true } | { success: false; error: { code: string; message: string } };

const deleteNoteFn = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<DeleteNoteResult> => {
    if (!id) {
      return { success: false, error: { code: 'VALIDATION', message: 'Note ID is required' } };
    }

    try {
      await getNoteService().deleteNote(id);
      return { success: true };
    } catch (error) {
      if (error instanceof NoteServiceError) {
        return { success: false, error: { code: error.code, message: error.message } };
      }
      return { success: false, error: { code: 'UNKNOWN', message: 'An unexpected error occurred' } };
    }
  });

export const Route = createFileRoute('/notes/$noteId')({
  component: EditNoteComponent,
  loader: async ({ params }) => {
    return await getNoteFn({ data: params.noteId });
  },
});

function EditNoteComponent() {
  const navigate = useNavigate();
  const params = Route.useParams();
  const loaderData: GetNoteResult = Route.useLoaderData();
  const [note, setNote] = useState<Note | null>(() => {
    return loaderData.success ? loaderData.note : null;
  });
  const [error, setError] = useState<string | null>(() => {
    return !loaderData.success ? loaderData.error.message : null;
  });
  const [submissionError, setSubmissionError] = useState<string | null>(null);

  useEffect(() => {
    if (loaderData.success) {
      setNote(loaderData.note);
      setError(null);
    } else {
      setError(loaderData.error.message);
    }
  }, [loaderData]);

  const handleSubmit = (input: NoteInput) => {
    setSubmissionError(null);
    (async () => {
      try {
        const result = await updateNoteFn({ data: { id: params.noteId, input } });
        if (!result.success) {
          setSubmissionError(result.error.message);
        } else {
          navigate({ to: '/' });
        }
      } catch (err) {
        setSubmissionError('An unexpected error occurred');
      }
    })();
  };

  const handleDelete = () => {
    if (confirm('Are you sure you want to delete this note?')) {
      setSubmissionError(null);
      (async () => {
        try {
          const result = await deleteNoteFn({ data: params.noteId });
          if (!result.success) {
            setSubmissionError(result.error.message);
          } else {
            navigate({ to: '/' });
          }
        } catch (err) {
          setSubmissionError('An unexpected error occurred');
        }
      })();
    }
  };

  if (error) {
    return (
      <div className="container">
        <h1>Note Not Found</h1>
        <p>{error}</p>
        <button onClick={() => navigate({ to: '/' })} className="btn-primary">
          Back to Notes
        </button>
      </div>
    );
  }

  if (!note) {
    return (
      <div className="container">
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="container">
      <h1>Edit Note</h1>
      {submissionError && (
        <div
          style={{
            color: 'red',
            marginBottom: '1rem',
            padding: '0.5rem',
            border: '1px solid red',
            borderRadius: '4px',
          }}
          role="alert"
        >
          {submissionError}
        </div>
      )}
      <NoteForm initial={note} onSubmit={handleSubmit} onCancel={() => navigate({ to: '/' })} />
      <div style={{ marginTop: '2rem', paddingTop: '2rem', borderTop: '1px solid #ccc' }}>
        <button onClick={handleDelete} className="btn-danger" style={{ backgroundColor: '#dc3545' }}>
          Delete Note
        </button>
      </div>
    </div>
  );
}
