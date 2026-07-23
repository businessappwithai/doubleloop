import { Pool } from 'pg';

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteInsertInput {
  title: string;
  body: string;
}

export interface NoteUpdateInput {
  title: string;
  body: string;
}

export interface NoteRepository {
  list(): Promise<Note[]>;
  findById(id: string): Promise<Note | null>;
  insert(input: NoteInsertInput): Promise<Note>;
  update(id: string, input: NoteUpdateInput): Promise<Note | null>;
  remove(id: string): Promise<boolean>;
}

interface DbNote {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

function dbToNote(row: DbNote): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresNoteRepository implements NoteRepository {
  constructor(private pool: Pool) {}

  async list(): Promise<Note[]> {
    const result = await this.pool.query<DbNote>(
      'SELECT * FROM notes ORDER BY updated_at DESC'
    );
    return result.rows.map(dbToNote);
  }

  async findById(id: string): Promise<Note | null> {
    const result = await this.pool.query<DbNote>(
      'SELECT * FROM notes WHERE id = $1',
      [id]
    );
    return result.rows.length > 0 ? dbToNote(result.rows[0]) : null;
  }

  async insert(input: NoteInsertInput): Promise<Note> {
    const result = await this.pool.query<DbNote>(
      'INSERT INTO notes (title, body) VALUES ($1, $2) RETURNING *',
      [input.title, input.body]
    );
    return dbToNote(result.rows[0]);
  }

  async update(id: string, input: NoteUpdateInput): Promise<Note | null> {
    const result = await this.pool.query<DbNote>(
      'UPDATE notes SET title = $1, body = $2, updated_at = now() WHERE id = $3 RETURNING *',
      [input.title, input.body, id]
    );
    return result.rows.length > 0 ? dbToNote(result.rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM notes WHERE id = $1',
      [id]
    );
    return result.rowCount! > 0;
  }
}

export class InMemoryNoteRepository implements NoteRepository {
  private notes: Note[] = [];
  private nextId = 0;

  async list(): Promise<Note[]> {
    return [...this.notes]
      .sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )
      .map((n) => ({ ...n }));
  }

  async findById(id: string): Promise<Note | null> {
    const note = this.notes.find((n) => n.id === id);
    return note ? { ...note } : null;
  }

  async insert(input: NoteInsertInput): Promise<Note> {
    const now = new Date().toISOString();
    const note: Note = {
      id: String(this.nextId++),
      title: input.title,
      body: input.body,
      createdAt: now,
      updatedAt: now,
    };
    this.notes.push(note);
    return { ...note };
  }

  async update(id: string, input: NoteUpdateInput): Promise<Note | null> {
    const note = this.notes.find((n) => n.id === id);
    if (!note) {
      return null;
    }
    note.title = input.title;
    note.body = input.body;
    note.updatedAt = new Date().toISOString();
    return { ...note };
  }

  async remove(id: string): Promise<boolean> {
    const index = this.notes.findIndex((n) => n.id === id);
    if (index === -1) {
      return false;
    }
    this.notes.splice(index, 1);
    return true;
  }
}
