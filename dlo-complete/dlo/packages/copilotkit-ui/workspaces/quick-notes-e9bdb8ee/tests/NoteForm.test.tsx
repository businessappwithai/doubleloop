import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NoteForm } from '../src/components/NoteForm';
import type { Note } from '../src/server/note-repository';

describe('NoteForm', () => {
  describe('validation', () => {
    it('blocks submit with empty title', () => {
      const onSubmit = vi.fn();
      render(<NoteForm onSubmit={onSubmit} />);

      const submitButton = screen.getByRole('button', { name: /create note/i });
      expect(submitButton).toBeDisabled();
    });

    it('shows error message for empty title on submit attempt', async () => {
      const onSubmit = vi.fn();
      render(<NoteForm onSubmit={onSubmit} />);

      const form = screen.getByRole('button', { name: /create note/i }).closest('form');
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(screen.getByText('Title is required')).toBeInTheDocument();
      });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('blocks submit with title over 200 characters', () => {
      const onSubmit = vi.fn();
      render(<NoteForm onSubmit={onSubmit} />);

      const titleInput = screen.getByLabelText('Title *') as HTMLInputElement;
      const longTitle = 'a'.repeat(201);

      fireEvent.change(titleInput, { target: { value: longTitle } });

      const submitButton = screen.getByRole('button', { name: /create note/i });
      expect(submitButton).toBeDisabled();
    });

    it('shows error message for title over 200 characters on submit', async () => {
      const onSubmit = vi.fn();
      render(<NoteForm onSubmit={onSubmit} />);

      const titleInput = screen.getByLabelText('Title *') as HTMLInputElement;
      const longTitle = 'a'.repeat(201);

      fireEvent.change(titleInput, { target: { value: longTitle } });

      const form = screen.getByRole('button', { name: /create note/i }).closest('form');
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(screen.getByText(/must be 200 characters or less/i)).toBeInTheDocument();
      });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('blocks submit with body over 10000 characters', () => {
      const onSubmit = vi.fn();
      render(<NoteForm onSubmit={onSubmit} />);

      const titleInput = screen.getByLabelText('Title *') as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: 'Valid Title' } });

      const bodyInput = screen.getByLabelText('Body') as HTMLTextAreaElement;
      const longBody = 'a'.repeat(10001);
      fireEvent.change(bodyInput, { target: { value: longBody } });

      const submitButton = screen.getByRole('button', { name: /create note/i });
      expect(submitButton).toBeDisabled();
    });

    it('shows error message for body over 10000 characters', async () => {
      const onSubmit = vi.fn();
      render(<NoteForm onSubmit={onSubmit} />);

      const titleInput = screen.getByLabelText('Title *') as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: 'Valid Title' } });

      const bodyInput = screen.getByLabelText('Body') as HTMLTextAreaElement;
      const longBody = 'a'.repeat(10001);
      fireEvent.change(bodyInput, { target: { value: longBody } });

      const form = screen.getByRole('button', { name: /create note/i }).closest('form');
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(screen.getByText(/must be 10000 characters or less/i)).toBeInTheDocument();
      });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('allows empty body', () => {
      const onSubmit = vi.fn();
      render(<NoteForm onSubmit={onSubmit} />);

      const titleInput = screen.getByLabelText('Title *') as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: 'Title Only' } });

      const submitButton = screen.getByRole('button', { name: /create note/i });
      expect(submitButton).not.toBeDisabled();
    });

    it('enables submit with valid title and empty body', () => {
      const onSubmit = vi.fn();
      render(<NoteForm onSubmit={onSubmit} />);

      const titleInput = screen.getByLabelText('Title *') as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: 'Valid Title' } });

      const submitButton = screen.getByRole('button', { name: /create note/i });
      expect(submitButton).not.toBeDisabled();
    });

    it('enables submit with valid title and body', () => {
      const onSubmit = vi.fn();
      render(<NoteForm onSubmit={onSubmit} />);

      const titleInput = screen.getByLabelText('Title *') as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: 'Valid Title' } });

      const bodyInput = screen.getByLabelText('Body') as HTMLTextAreaElement;
      fireEvent.change(bodyInput, { target: { value: 'Some body text' } });

      const submitButton = screen.getByRole('button', { name: /create note/i });
      expect(submitButton).not.toBeDisabled();
    });
  });

  describe('submit behavior', () => {
    it('calls onSubmit with title and body on valid submit', async () => {
      const onSubmit = vi.fn();
      render(<NoteForm onSubmit={onSubmit} />);

      const titleInput = screen.getByLabelText('Title *') as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: 'Test Title' } });

      const bodyInput = screen.getByLabelText('Body') as HTMLTextAreaElement;
      fireEvent.change(bodyInput, { target: { value: 'Test body' } });

      const submitButton = screen.getByRole('button', { name: /create note/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith({
          title: 'Test Title',
          body: 'Test body',
        });
      });
    });

    it('calls onSubmit with empty body if not provided', async () => {
      const onSubmit = vi.fn();
      render(<NoteForm onSubmit={onSubmit} />);

      const titleInput = screen.getByLabelText('Title *') as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: 'Title Only' } });

      const submitButton = screen.getByRole('button', { name: /create note/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith({
          title: 'Title Only',
          body: '',
        });
      });
    });

    it('does not call onSubmit if validation fails', async () => {
      const onSubmit = vi.fn();
      render(<NoteForm onSubmit={onSubmit} />);

      const form = screen.getByRole('button', { name: /create note/i }).closest('form');
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(onSubmit).not.toHaveBeenCalled();
      });
    });
  });

  describe('cancel behavior', () => {
    it('calls onCancel when cancel button is clicked', () => {
      const onCancel = vi.fn();
      render(<NoteForm onSubmit={vi.fn()} onCancel={onCancel} />);

      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      fireEvent.click(cancelButton);

      expect(onCancel).toHaveBeenCalled();
    });

    it('does not show cancel button when onCancel is not provided', () => {
      render(<NoteForm onSubmit={vi.fn()} />);

      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });
  });

  describe('initial values', () => {
    it('populates form with initial note values', () => {
      const initial: Note = {
        id: '1',
        title: 'Existing Title',
        body: 'Existing body',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      render(<NoteForm initial={initial} onSubmit={vi.fn()} />);

      const titleInput = screen.getByLabelText('Title *') as HTMLInputElement;
      const bodyInput = screen.getByLabelText('Body') as HTMLTextAreaElement;

      expect(titleInput.value).toBe('Existing Title');
      expect(bodyInput.value).toBe('Existing body');
    });

    it('shows "Update Note" button when initial is provided', () => {
      const initial: Note = {
        id: '1',
        title: 'Title',
        body: 'Body',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      render(<NoteForm initial={initial} onSubmit={vi.fn()} />);

      expect(screen.getByRole('button', { name: /update note/i })).toBeInTheDocument();
    });

    it('shows "Create Note" button when initial is not provided', () => {
      render(<NoteForm onSubmit={vi.fn()} />);

      expect(screen.getByRole('button', { name: /create note/i })).toBeInTheDocument();
    });
  });

  describe('character counting', () => {
    it('displays title character count', () => {
      render(<NoteForm onSubmit={vi.fn()} />);

      const titleInput = screen.getByLabelText('Title *') as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: 'Test' } });

      expect(screen.getByText('4/200')).toBeInTheDocument();
    });

    it('displays body character count', () => {
      render(<NoteForm onSubmit={vi.fn()} />);

      const bodyInput = screen.getByLabelText('Body') as HTMLTextAreaElement;
      fireEvent.change(bodyInput, { target: { value: 'Test body' } });

      expect(screen.getByText('9/10000')).toBeInTheDocument();
    });
  });
});
