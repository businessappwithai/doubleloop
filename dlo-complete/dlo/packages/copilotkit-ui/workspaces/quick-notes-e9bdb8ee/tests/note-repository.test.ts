import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryNoteRepository,
  NoteRepository,
} from '../src/server/note-repository';

describe('InMemoryNoteRepository', () => {
  let repo: NoteRepository;

  beforeEach(() => {
    repo = new InMemoryNoteRepository();
  });

  describe('list', () => {
    it('returns empty array for empty repository', async () => {
      const notes = await repo.list();
      expect(notes).toEqual([]);
    });

    it('returns notes ordered by updatedAt descending', async () => {
      const note1 = await repo.insert({ title: 'First', body: 'First body' });

      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      const note2 = await repo.insert({
        title: 'Second',
        body: 'Second body',
      });

      const notes = await repo.list();
      expect(notes).toHaveLength(2);
      expect(notes[0].id).toBe(note2.id);
      expect(notes[1].id).toBe(note1.id);
    });

    it('maintains descending order after update', async () => {
      const note1 = await repo.insert({ title: 'First', body: 'First body' });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const note2 = await repo.insert({
        title: 'Second',
        body: 'Second body',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await repo.update(note1.id, { title: 'First Updated', body: 'Updated' });

      const notes = await repo.list();
      expect(notes[0].id).toBe(note1.id);
      expect(notes[1].id).toBe(note2.id);
    });
  });

  describe('findById', () => {
    it('returns null for non-existent id', async () => {
      const note = await repo.findById('non-existent-id');
      expect(note).toBeNull();
    });

    it('returns the note for an existing id', async () => {
      const inserted = await repo.insert({
        title: 'Test Note',
        body: 'Test body',
      });

      const found = await repo.findById(inserted.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(inserted.id);
      expect(found?.title).toBe('Test Note');
      expect(found?.body).toBe('Test body');
    });

    it('returns updated note data after update', async () => {
      const inserted = await repo.insert({
        title: 'Original',
        body: 'Original body',
      });

      await repo.update(inserted.id, {
        title: 'Updated Title',
        body: 'Updated body',
      });

      const found = await repo.findById(inserted.id);
      expect(found?.title).toBe('Updated Title');
      expect(found?.body).toBe('Updated body');
    });
  });

  describe('insert', () => {
    it('creates a new note with assigned id', async () => {
      const note = await repo.insert({
        title: 'New Note',
        body: 'New body',
      });

      expect(note.id).toBeDefined();
      expect(note.title).toBe('New Note');
      expect(note.body).toBe('New body');
    });

    it('assigns createdAt and updatedAt timestamps', async () => {
      const beforeInsert = new Date().toISOString();
      const note = await repo.insert({
        title: 'Test',
        body: 'body',
      });
      const afterInsert = new Date().toISOString();

      expect(note.createdAt).toBeDefined();
      expect(note.updatedAt).toBeDefined();
      expect(note.createdAt).toEqual(note.updatedAt);
      expect(note.createdAt >= beforeInsert).toBe(true);
      expect(note.createdAt <= afterInsert).toBe(true);
    });

    it('increments note ids', async () => {
      const note1 = await repo.insert({ title: 'First', body: 'body' });
      const note2 = await repo.insert({ title: 'Second', body: 'body' });
      const note3 = await repo.insert({ title: 'Third', body: 'body' });

      expect(note1.id).not.toBe(note2.id);
      expect(note2.id).not.toBe(note3.id);
    });

    it('allows empty body', async () => {
      const note = await repo.insert({
        title: 'Title Only',
        body: '',
      });

      expect(note.body).toBe('');
    });

    it('persists note to repository', async () => {
      const inserted = await repo.insert({
        title: 'Persistent',
        body: 'Should be findable',
      });

      const found = await repo.findById(inserted.id);
      expect(found).toEqual(inserted);
    });
  });

  describe('update', () => {
    it('returns null for non-existent id', async () => {
      const result = await repo.update('non-existent-id', {
        title: 'New Title',
        body: 'New body',
      });

      expect(result).toBeNull();
    });

    it('updates title and body', async () => {
      const inserted = await repo.insert({
        title: 'Original Title',
        body: 'Original body',
      });

      const updated = await repo.update(inserted.id, {
        title: 'New Title',
        body: 'New body',
      });

      expect(updated).not.toBeNull();
      expect(updated?.title).toBe('New Title');
      expect(updated?.body).toBe('New body');
    });

    it('bumps updatedAt timestamp', async () => {
      const inserted = await repo.insert({
        title: 'Test',
        body: 'body',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = await repo.update(inserted.id, {
        title: 'Updated',
        body: 'body',
      });

      expect(updated?.updatedAt).not.toBe(inserted.createdAt);
      expect(new Date(updated!.updatedAt) > new Date(inserted.createdAt)).toBe(
        true
      );
    });

    it('preserves createdAt', async () => {
      const inserted = await repo.insert({
        title: 'Test',
        body: 'body',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = await repo.update(inserted.id, {
        title: 'Updated',
        body: 'body',
      });

      expect(updated?.createdAt).toBe(inserted.createdAt);
    });

    it('preserves id', async () => {
      const inserted = await repo.insert({
        title: 'Test',
        body: 'body',
      });

      const updated = await repo.update(inserted.id, {
        title: 'Updated',
        body: 'body',
      });

      expect(updated?.id).toBe(inserted.id);
    });

    it('allows updating only title', async () => {
      const inserted = await repo.insert({
        title: 'Original',
        body: 'Original body',
      });

      const updated = await repo.update(inserted.id, {
        title: 'New Title',
        body: inserted.body,
      });

      expect(updated?.title).toBe('New Title');
      expect(updated?.body).toBe('Original body');
    });

    it('allows updating only body', async () => {
      const inserted = await repo.insert({
        title: 'Original',
        body: 'Original body',
      });

      const updated = await repo.update(inserted.id, {
        title: inserted.title,
        body: 'New body',
      });

      expect(updated?.title).toBe('Original');
      expect(updated?.body).toBe('New body');
    });

    it('allows clearing body', async () => {
      const inserted = await repo.insert({
        title: 'Title',
        body: 'Some body text',
      });

      const updated = await repo.update(inserted.id, {
        title: 'Title',
        body: '',
      });

      expect(updated?.body).toBe('');
    });
  });

  describe('remove', () => {
    it('returns false for non-existent id', async () => {
      const result = await repo.remove('non-existent-id');
      expect(result).toBe(false);
    });

    it('returns true when removing existing note', async () => {
      const inserted = await repo.insert({
        title: 'To Delete',
        body: 'body',
      });

      const result = await repo.remove(inserted.id);
      expect(result).toBe(true);
    });

    it('removes note from repository', async () => {
      const inserted = await repo.insert({
        title: 'To Delete',
        body: 'body',
      });

      await repo.remove(inserted.id);
      const found = await repo.findById(inserted.id);
      expect(found).toBeNull();
    });

    it('does not affect other notes', async () => {
      const note1 = await repo.insert({
        title: 'Keep',
        body: 'body',
      });
      const note2 = await repo.insert({
        title: 'Delete',
        body: 'body',
      });

      await repo.remove(note2.id);
      const remaining = await repo.list();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(note1.id);
    });

    it('returns false on second removal of same id', async () => {
      const inserted = await repo.insert({
        title: 'To Delete',
        body: 'body',
      });

      const firstRemove = await repo.remove(inserted.id);
      const secondRemove = await repo.remove(inserted.id);

      expect(firstRemove).toBe(true);
      expect(secondRemove).toBe(false);
    });
  });

  describe('integration scenarios', () => {
    it('handles mixed operations', async () => {
      const note1 = await repo.insert({
        title: 'Note 1',
        body: 'Body 1',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const note2 = await repo.insert({
        title: 'Note 2',
        body: 'Body 2',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await repo.update(note1.id, {
        title: 'Note 1 Updated',
        body: 'Body 1 Updated',
      });

      const list = await repo.list();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(note1.id);
      expect(list[0].title).toBe('Note 1 Updated');

      await repo.remove(note2.id);
      const final = await repo.list();
      expect(final).toHaveLength(1);
      expect(final[0].id).toBe(note1.id);
    });

    it('maintains consistency across operations', async () => {
      const ids = [];
      for (let i = 0; i < 5; i++) {
        const note = await repo.insert({
          title: `Note ${i}`,
          body: `Body ${i}`,
        });
        ids.push(note.id);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const list1 = await repo.list();
      expect(list1).toHaveLength(5);

      await repo.update(ids[2], { title: 'Updated', body: 'Updated' });
      const list2 = await repo.list();
      expect(list2[0].id).toBe(ids[2]);

      await repo.remove(ids[0]);
      const list3 = await repo.list();
      expect(list3).toHaveLength(4);
      expect(list3.find((n) => n.id === ids[0])).toBeUndefined();
    });
  });
});
