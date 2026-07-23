import { useState } from 'react';
import type { Note } from '../server/note-repository';

export interface NoteInput {
  title: string;
  body: string;
}

interface NoteFormProps {
  initial?: Note;
  onSubmit: (input: NoteInput) => void;
  onCancel?: () => void;
}

const TITLE_MIN = 1;
const TITLE_MAX = 200;
const BODY_MAX = 10000;

export function NoteForm({ initial, onSubmit, onCancel }: NoteFormProps) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [errors, setErrors] = useState<{ title?: string; body?: string }>({});

  const validate = (): boolean => {
    const newErrors: { title?: string; body?: string } = {};

    if (title.length < TITLE_MIN) {
      newErrors.title = 'Title is required';
    } else if (title.length > TITLE_MAX) {
      newErrors.title = `Title must be ${TITLE_MAX} characters or less`;
    }

    if (body.length > BODY_MAX) {
      newErrors.body = `Body must be ${BODY_MAX} characters or less`;
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validate()) {
      onSubmit({ title, body });
    }
  };

  const isValid = title.length >= TITLE_MIN && title.length <= TITLE_MAX && body.length <= BODY_MAX;

  return (
    <form className="note-form" onSubmit={handleSubmit}>
      <div className="form-group">
        <label htmlFor="note-title">Title *</label>
        <input
          id="note-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Enter note title"
          maxLength={TITLE_MAX}
          className={errors.title ? 'input-error' : ''}
        />
        {errors.title && <span className="error-message">{errors.title}</span>}
        <span className="char-count">
          {title.length}/{TITLE_MAX}
        </span>
      </div>

      <div className="form-group">
        <label htmlFor="note-body">Body</label>
        <textarea
          id="note-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Enter note content (optional)"
          maxLength={BODY_MAX}
          rows={8}
          className={errors.body ? 'input-error' : ''}
        />
        {errors.body && <span className="error-message">{errors.body}</span>}
        <span className="char-count">
          {body.length}/{BODY_MAX}
        </span>
      </div>

      <div className="form-actions">
        <button type="submit" disabled={!isValid} className="btn-primary">
          {initial ? 'Update Note' : 'Create Note'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn-secondary">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
