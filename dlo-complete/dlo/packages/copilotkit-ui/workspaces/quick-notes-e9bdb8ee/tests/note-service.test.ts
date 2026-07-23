import { describe, it, expect, beforeEach } from 'vitest';
import { NoteService, NoteServiceError, NoteInput } from '../src/server/note-service';
import { InMemoryNoteRepository } from '../src/server/note-repository';

describe('NoteService', () => {
  let service: NoteService;

  beforeEach(() => {
    const repo = new InMemoryNoteRepository();
    service = new NoteService(repo);
  });

  describe('validation', () => {
    describe('title validation', () => {
      it('throws VALIDATION error for empty title', async () => {
        const input: NoteInput = { title: '', body: 'body' };
        await expect(service.createNote(input)).rejects.toThrow(NoteServiceError);
        await expect(service.createNote(input)).rejects.toMatchObject({
          code: 'VALIDATION',
        });
      });

      it('throws VALIDATION error for whitespace-only title', async () => {
        const input: NoteInput = { title: '   ', body: 'body' };
        await expect(service.createNote(input)).rejects.toThrow(NoteServiceError);
        await expect(service.createNote(input)).rejects.toMatchObject({
          code: 'VALIDATION',
        });
      });

      it('throws VALIDATION error for title over 200 characters', async () => {
        const input: NoteInput = {
          title: 'a'.repeat(201),
          body: 'body',
        };
        await expect(service.createNote(input)).rejects.toThrow(NoteServiceError);
        await expect(service.createNote(input)).rejects.toMatchObject({
          code: 'VALIDATION',
        });
      });

      it('accepts title with exactly 200 characters', async () => {
        const input: NoteInput = {
          title: 'a'.repeat(200),
          body: 'body',
        };
        const note = await service.createNote(input);
        expect(note.title).toBe('a'.repeat(200));
      });

      it('accepts title with exactly 1 character', async () => {
        const input: NoteInput = {
          title: 'a',
          body: 'body',
        };
        const note = await service.createNote(input);
        expect(note.title).toBe('a');
      });

      it('trims leading and trailing whitespace from title', async () => {
        const input: NoteInput = {
          title: '  hello world  ',
          body: 'body',
        };
        const note = await service.createNote(input);
        expect(note.title).toBe('hello world');
      });
    });

    describe('body validation', () => {
      it('throws VALIDATION error for body over 10000 characters', async () => {
        const input: NoteInput = {
          title: 'title',
          body: 'a'.repeat(10001),
        };
        await expect(service.createNote(input)).rejects.toThrow(NoteServiceError);
        await expect(service.createNote(input)).rejects.toMatchObject({
          code: 'VALIDATION',
        });
      });

      it('accepts body with exactly 10000 characters', async () => {
        const input: NoteInput = {
          title: 'title',
          body: 'a'.repeat(10000),
        };
        const note = await service.createNote(input);
        expect(note.body).toBe('a'.repeat(10000));
      });

      it('accepts empty body', async () => {
        const input: NoteInput = {
          title: 'title',
          body: '',
        };
        const note = await service.createNote(input);
        expect(note.body).toBe('');
      });

      it('accepts undefined body', async () => {
        const input: NoteInput = {
          title: 'title',
        };
        const note = await service.createNote(input);
        expect(note.body).toBe('');
      });

      it('trims leading and trailing whitespace from body', async () => {
        const input: NoteInput = {
          title: 'title',
          body: '  hello world  ',
        };
        const note = await service.createNote(input);
        expect(note.body).toBe('hello world');
      });
    });
  });

  describe('createNote', () => {
    it('creates a new note with valid input', async () => {
      const input: NoteInput = {
        title: 'Test Note',
        body: 'Test body',
      };
      const note = await service.createNote(input);

      expect(note.id).toBeDefined();
      expect(note.title).toBe('Test Note');
      expect(note.body).toBe('Test body');
    });

    it('stamps createdAt timestamp on creation', async () => {
      const beforeCreate = new Date().toISOString();
      const note = await service.createNote({
        title: 'Test',
        body: 'body',
      });
      const afterCreate = new Date().toISOString();

      expect(note.createdAt).toBeDefined();
      expect(note.createdAt >= beforeCreate).toBe(true);
      expect(note.createdAt <= afterCreate).toBe(true);
    });

    it('stamps updatedAt timestamp equal to createdAt on creation', async () => {
      const note = await service.createNote({
        title: 'Test',
        body: 'body',
      });

      expect(note.updatedAt).toBeDefined();
      expect(note.updatedAt).toBe(note.createdAt);
    });

    it('generates unique ids for each note', async () => {
      const note1 = await service.createNote({
        title: 'Note 1',
        body: 'body',
      });
      const note2 = await service.createNote({
        title: 'Note 2',
        body: 'body',
      });

      expect(note1.id).not.toBe(note2.id);
    });
  });

  describe('listNotes', () => {
    it('returns empty array when no notes exist', async () => {
      const notes = await service.listNotes();
      expect(notes).toEqual([]);
    });

    it('returns all created notes', async () => {
      await service.createNote({ title: 'Note 1', body: 'body 1' });
      await service.createNote({ title: 'Note 2', body: 'body 2' });

      const notes = await service.listNotes();
      expect(notes).toHaveLength(2);
    });

    it('returns notes ordered by updatedAt descending', async () => {
      const note1 = await service.createNote({ title: 'Note 1', body: 'body 1' });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const note2 = await service.createNote({ title: 'Note 2', body: 'body 2' });

      const notes = await service.listNotes();
      expect(notes[0].id).toBe(note2.id);
      expect(notes[1].id).toBe(note1.id);
    });
  });

  describe('getNote', () => {
    it('returns null for non-existent id', async () => {
      const note = await service.getNote('non-existent');
      expect(note).toBeNull();
    });

    it('returns the note for an existing id', async () => {
      const created = await service.createNote({
        title: 'Test Note',
        body: 'Test body',
      });

      const found = await service.getNote(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.title).toBe('Test Note');
      expect(found?.body).toBe('Test body');
    });
  });

  describe('updateNote', () => {
    it('throws NOT_FOUND error when note does not exist', async () => {
      const input: NoteInput = {
        title: 'Updated Title',
        body: 'Updated body',
      };
      await expect(service.updateNote('non-existent', input)).rejects.toThrow(
        NoteServiceError
      );
      await expect(service.updateNote('non-existent', input)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('throws VALIDATION error for invalid title on update', async () => {
      const created = await service.createNote({
        title: 'Original',
        body: 'body',
      });

      const input: NoteInput = {
        title: '',
        body: 'Updated body',
      };
      await expect(service.updateNote(created.id, input)).rejects.toThrow(
        NoteServiceError
      );
      await expect(service.updateNote(created.id, input)).rejects.toMatchObject({
        code: 'VALIDATION',
      });
    });

    it('throws VALIDATION error for invalid body on update', async () => {
      const created = await service.createNote({
        title: 'Original',
        body: 'body',
      });

      const input: NoteInput = {
        title: 'Updated Title',
        body: 'a'.repeat(10001),
      };
      await expect(service.updateNote(created.id, input)).rejects.toThrow(
        NoteServiceError
      );
      await expect(service.updateNote(created.id, input)).rejects.toMatchObject({
        code: 'VALIDATION',
      });
    });

    it('updates title and body on valid input', async () => {
      const created = await service.createNote({
        title: 'Original Title',
        body: 'Original body',
      });

      const updated = await service.updateNote(created.id, {
        title: 'Updated Title',
        body: 'Updated body',
      });

      expect(updated.title).toBe('Updated Title');
      expect(updated.body).toBe('Updated body');
    });

    it('bumps updatedAt timestamp on update', async () => {
      const created = await service.createNote({
        title: 'Original',
        body: 'body',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = await service.updateNote(created.id, {
        title: 'Updated',
        body: 'body',
      });

      expect(updated.updatedAt).not.toBe(created.updatedAt);
      expect(new Date(updated.updatedAt) > new Date(created.updatedAt)).toBe(true);
    });

    it('preserves createdAt on update', async () => {
      const created = await service.createNote({
        title: 'Original',
        body: 'body',
      });

      const updated = await service.updateNote(created.id, {
        title: 'Updated',
        body: 'body',
      });

      expect(updated.createdAt).toBe(created.createdAt);
    });

    it('preserves id on update', async () => {
      const created = await service.createNote({
        title: 'Original',
        body: 'body',
      });

      const updated = await service.updateNote(created.id, {
        title: 'Updated',
        body: 'body',
      });

      expect(updated.id).toBe(created.id);
    });

    it('trims title and body on update', async () => {
      const created = await service.createNote({
        title: 'Original',
        body: 'body',
      });

      const updated = await service.updateNote(created.id, {
        title: '  new title  ',
        body: '  new body  ',
      });

      expect(updated.title).toBe('new title');
      expect(updated.body).toBe('new body');
    });
  });

  describe('deleteNote', () => {
    it('throws NOT_FOUND error when note does not exist', async () => {
      await expect(service.deleteNote('non-existent')).rejects.toThrow(
        NoteServiceError
      );
      await expect(service.deleteNote('non-existent')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('throws VALIDATION error when id is empty', async () => {
      await expect(service.deleteNote('')).rejects.toThrow(NoteServiceError);
      await expect(service.deleteNote('')).rejects.toMatchObject({
        code: 'VALIDATION',
      });
    });

    it('deletes an existing note', async () => {
      const created = await service.createNote({
        title: 'To Delete',
        body: 'body',
      });

      await service.deleteNote(created.id);

      const found = await service.getNote(created.id);
      expect(found).toBeNull();
    });

    it('does not affect other notes on delete', async () => {
      const note1 = await service.createNote({
        title: 'Keep',
        body: 'body',
      });
      const note2 = await service.createNote({
        title: 'Delete',
        body: 'body',
      });

      await service.deleteNote(note2.id);

      const notes = await service.listNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0].id).toBe(note1.id);
    });
  });

  describe('integration scenarios', () => {
    it('handles complete CRUD workflow', async () => {
      const created = await service.createNote({
        title: 'My Note',
        body: 'My content',
      });

      let found = await service.getNote(created.id);
      expect(found?.title).toBe('My Note');

      const updated = await service.updateNote(created.id, {
        title: 'Updated Note',
        body: 'Updated content',
      });
      expect(updated.title).toBe('Updated Note');

      found = await service.getNote(created.id);
      expect(found?.title).toBe('Updated Note');

      await service.deleteNote(created.id);

      found = await service.getNote(created.id);
      expect(found).toBeNull();
    });

    it('maintains list order across multiple operations', async () => {
      const note1 = await service.createNote({
        title: 'First',
        body: 'body1',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const note2 = await service.createNote({
        title: 'Second',
        body: 'body2',
      });

      let list = await service.listNotes();
      expect(list[0].id).toBe(note2.id);

      await new Promise((resolve) => setTimeout(resolve, 10));

      await service.updateNote(note1.id, {
        title: 'First Updated',
        body: 'body1',
      });

      list = await service.listNotes();
      expect(list[0].id).toBe(note1.id);
      expect(list[1].id).toBe(note2.id);
    });

    it('handles multiple notes with various edge cases', async () => {
      const note1 = await service.createNote({
        title: 'A',
        body: '',
      });

      const note2 = await service.createNote({
        title: 'B'.repeat(100),
        body: 'content',
      });

      const note3 = await service.createNote({
        title: 'C',
        body: 'a'.repeat(9999),
      });

      const list = await service.listNotes();
      expect(list).toHaveLength(3);
      expect(list.map((n) => n.id)).toContain(note1.id);
      expect(list.map((n) => n.id)).toContain(note2.id);
      expect(list.map((n) => n.id)).toContain(note3.id);
    });
  });
});
