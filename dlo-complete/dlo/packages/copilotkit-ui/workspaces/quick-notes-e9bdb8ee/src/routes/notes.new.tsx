import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { NoteForm } from '../components/NoteForm';
import { getNoteService, NoteServiceError, type Note, type NoteInput } from '../server/note-service';

type CreateNoteResult = { success: true; note: Note } | { success: false; error: { code: string; message: string } };

const createNoteFn = createServerFn({ method: 'POST' })
  .validator((input: NoteInput) => input)
  .handler(async ({ data }): Promise<CreateNoteResult> => {
    try {
      const service = getNoteService();
      const note = await service.createNote(data);
      return { success: true, note };
    } catch (error) {
      if (error instanceof NoteServiceError) {
        return {
          success: false,
          error: {
            code: error.code,
            message: error.message,
          },
        };
      }
      return {
        success: false,
        error: {
          code: 'UNKNOWN',
          message: 'An unexpected error occurred',
        },
      };
    }
  });

export const Route = createFileRoute('/notes/new')({
  component: NewNoteComponent,
});

function NewNoteComponent() {
  const navigate = useNavigate();
  const [submissionError, setSubmissionError] = useState<string | null>(null);

  const handleSubmit = (input: NoteInput) => {
    setSubmissionError(null);
    (async () => {
      try {
        const result = await createNoteFn({ data: input });
        if (result.success) {
          navigate({ to: '/' });
        } else {
          setSubmissionError(result.error.message);
        }
      } catch (error) {
        setSubmissionError('An unexpected error occurred');
      }
    })();
  };

  return (
    <div className="container">
      <h1>Create Note</h1>
      {submissionError && (
        <div style={{ color: 'red', marginBottom: '1rem', padding: '0.5rem', border: '1px solid red', borderRadius: '4px' }} role="alert">
          {submissionError}
        </div>
      )}
      <NoteForm onSubmit={handleSubmit} onCancel={() => navigate({ to: '/' })} />
    </div>
  );
}
