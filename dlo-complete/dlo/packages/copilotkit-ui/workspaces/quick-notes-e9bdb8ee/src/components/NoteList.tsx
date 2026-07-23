import type { Note } from '../server/note-repository';
import { NoteListItem } from './NoteListItem';

interface NoteListProps {
  notes: Note[];
  onDelete: (id: string) => void;
}

export function NoteList({ notes, onDelete }: NoteListProps) {
  if (notes.length === 0) {
    return (
      <div className="notes-empty">
        <p>No notes yet. Create one to get started!</p>
      </div>
    );
  }

  return (
    <div className="notes-list">
      {notes.map((note) => (
        <NoteListItem key={note.id} note={note} onDelete={onDelete} />
      ))}
    </div>
  );
}
