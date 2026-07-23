import type { Note } from '../server/note-repository';

interface NoteListItemProps {
  note: Note;
  onDelete: (id: string) => void;
}

export function NoteListItem({ note, onDelete }: NoteListItemProps) {
  const preview = note.body.slice(0, 120) + (note.body.length > 120 ? '...' : '');
  const updated = new Date(note.updatedAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: note.createdAt !== note.updatedAt ? 'numeric' : undefined,
  });

  return (
    <div className="note-item">
      <div className="note-item-content">
        <h3 className="note-item-title">{note.title}</h3>
        {preview && <p className="note-item-preview">{preview}</p>}
        <span className="note-item-date">{updated}</span>
      </div>
      <button
        className="note-item-delete"
        onClick={() => onDelete(note.id)}
        aria-label={`Delete note: ${note.title}`}
      >
        Delete
      </button>
    </div>
  );
}
