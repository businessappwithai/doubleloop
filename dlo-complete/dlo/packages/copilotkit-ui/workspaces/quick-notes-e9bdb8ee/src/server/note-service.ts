import {
  Note,
  NoteRepository,
  PostgresNoteRepository,
  InMemoryNoteRepository,
} from './note-repository';
import { getPool } from './db-client';

export type { Note };

export interface NoteInput {
  title: string;
  body?: string;
}

export class NoteServiceError extends Error {
  constructor(
    public code: 'VALIDATION' | 'NOT_FOUND',
    message: string
  ) {
    super(message);
    this.name = 'NoteServiceError';
  }
}

export class NoteService {
  constructor(private repository: NoteRepository) {}

  async listNotes(): Promise<Note[]> {
    return this.repository.list();
  }

  async getNote(id: string): Promise<Note | null> {
    return this.repository.findById(id);
  }

  async createNote(input: NoteInput): Promise<Note> {
    const title = (input.title ?? '').trim();
    const body = (input.body ?? '').trim();

    if (!title || title.length < 1 || title.length > 200) {
      throw new NoteServiceError(
        'VALIDATION',
        'Title is required and must be between 1 and 200 characters'
      );
    }

    if (body.length > 10000) {
      throw new NoteServiceError(
        'VALIDATION',
        'Body must not exceed 10000 characters'
      );
    }

    return this.repository.insert({
      title,
      body,
    });
  }

  async updateNote(id: string, input: NoteInput): Promise<Note> {
    if (!id) {
      throw new NoteServiceError(
        'VALIDATION',
        'Note ID is required'
      );
    }

    const existingNote = await this.repository.findById(id);
    if (!existingNote) {
      throw new NoteServiceError(
        'NOT_FOUND',
        `Note with ID "${id}" not found`
      );
    }

    const title = (input.title ?? '').trim();
    const body = (input.body ?? '').trim();

    if (!title || title.length < 1 || title.length > 200) {
      throw new NoteServiceError(
        'VALIDATION',
        'Title is required and must be between 1 and 200 characters'
      );
    }

    if (body.length > 10000) {
      throw new NoteServiceError(
        'VALIDATION',
        'Body must not exceed 10000 characters'
      );
    }

    const updated = await this.repository.update(id, {
      title,
      body,
    });

    if (!updated) {
      throw new NoteServiceError(
        'NOT_FOUND',
        `Note with ID "${id}" not found`
      );
    }

    return updated;
  }

  async deleteNote(id: string): Promise<void> {
    if (!id) {
      throw new NoteServiceError(
        'VALIDATION',
        'Note ID is required'
      );
    }

    const deleted = await this.repository.remove(id);
    if (!deleted) {
      throw new NoteServiceError(
        'NOT_FOUND',
        `Note with ID "${id}" not found`
      );
    }
  }
}

let noteServiceInstance: NoteService | undefined;

export function getNoteService(): NoteService {
  if (noteServiceInstance !== undefined) {
    return noteServiceInstance;
  }

  const pool = getPool();
  const repository: NoteRepository = pool
    ? new PostgresNoteRepository(pool)
    : new InMemoryNoteRepository();

  noteServiceInstance = new NoteService(repository);
  return noteServiceInstance;
}
