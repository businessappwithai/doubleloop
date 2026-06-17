import React, { useState } from 'react';
import './TodoForm.css';

interface TodoFormProps {
  onAddTodo: (title: string) => void;
}

export const TodoForm: React.FC<TodoFormProps> = ({ onAddTodo }) => {
  const [input, setInput] = useState('');

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (input.trim()) {
      onAddTodo(input.trim());
      setInput('');
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.currentTarget.value);
  };

  return (
    <form className="todo-form" onSubmit={handleSubmit}>
      <div className="todo-form-wrapper">
        <input
          type="text"
          className="todo-form-input"
          placeholder="Add a new task..."
          value={input}
          onChange={handleChange}
          autoFocus
          aria-label="New task input"
        />
        <button
          type="submit"
          className="todo-form-button"
          disabled={!input.trim()}
          aria-label="Add task button"
        >
          Add
        </button>
      </div>
    </form>
  );
};