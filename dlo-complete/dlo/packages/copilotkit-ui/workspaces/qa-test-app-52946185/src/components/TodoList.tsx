import React, { useState, useEffect } from 'react';

interface Task {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
}

type FilterType = 'all' | 'active' | 'completed';

interface TodoFormProps {
  onAdd: (title: string) => void;
}

interface TodoItemProps {
  task: Task;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

const TodoForm: React.FC<TodoFormProps> = ({ onAdd }) => {
  const [input, setInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      onAdd(input.trim());
      setInput('');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="todo-form">
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Add a new task..."
        className="todo-input"
        autoFocus
      />
      <button type="submit" className="todo-button">
        Add Task
      </button>
    </form>
  );
};

const TodoItem: React.FC<TodoItemProps> = ({ task, onToggle, onDelete }) => {
  return (
    <li className="todo-item">
      <div className="todo-item-content">
        <input
          type="checkbox"
          checked={task.completed}
          onChange={() => onToggle(task.id)}
          className="todo-checkbox"
          aria-label={`Toggle ${task.title}`}
        />
        <span className={`todo-title ${task.completed ? 'completed' : ''}`}>
          {task.title}
        </span>
      </div>
      <button
        onClick={() => onDelete(task.id)}
        className="todo-delete"
        aria-label={`Delete ${task.title}`}
      >
        Delete
      </button>
    </li>
  );
};

const TodoList: React.FC = () => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<FilterType>('all');

  useEffect(() => {
    const saved = localStorage.getItem('tasks');
    if (saved) {
      try {
        setTasks(JSON.parse(saved));
      } catch (error) {
        console.error('Failed to parse tasks from localStorage:', error);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('tasks', JSON.stringify(tasks));
  }, [tasks]);

  const addTask = (title: string) => {
    const newTask: Task = {
      id: Date.now().toString(),
      title,
      completed: false,
      createdAt: Date.now(),
    };
    setTasks([newTask, ...tasks]);
  };

  const toggleTask = (id: string) => {
    setTasks(
      tasks.map((task) =>
        task.id === id ? { ...task, completed: !task.completed } : task
      )
    );
  };

  const deleteTask = (id: string) => {
    setTasks(tasks.filter((task) => task.id !== id));
  };

  const filteredTasks = tasks.filter((task) => {
    if (filter === 'active') return !task.completed;
    if (filter === 'completed') return task.completed;
    return true;
  });

  const completedCount = tasks.filter((task) => task.completed).length;
  const activeCount = tasks.length - completedCount;

  return (
    <div className="todo-container">
      <h1 className="todo-title-main">My Tasks</h1>
      <TodoForm onAdd={addTask} />

      <div className="todo-filters">
        {(['all', 'active', 'completed'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`filter-button ${filter === f ? 'active' : ''}`}
            aria-pressed={filter === f}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      <ul className="todo-list">
        {filteredTasks.length > 0 ? (
          filteredTasks.map((task) => (
            <TodoItem
              key={task.id}
              task={task}
              onToggle={toggleTask}
              onDelete={deleteTask}
            />
          ))
        ) : (
          <li className="todo-empty">
            {filter === 'active'
              ? 'No active tasks'
              : filter === 'completed'
                ? 'No completed tasks'
                : 'No tasks yet. Add one to get started!'}
          </li>
        )}
      </ul>

      {tasks.length > 0 && (
        <div className="todo-stats">
          <span>{activeCount} active</span>
          <span>{completedCount} completed</span>
        </div>
      )}

      <style>{`
        .todo-container {
          max-width: 600px;
          margin: 0 auto;
          padding: 20px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }

        .todo-title-main {
          color: #333;
          margin-bottom: 24px;
          font-size: 32px;
          font-weight: 700;
        }

        .todo-form {
          display: flex;
          gap: 8px;
          margin-bottom: 20px;
        }

        .todo-input {
          flex: 1;
          padding: 12px 16px;
          border: 2px solid #e0e0e0;
          border-radius: 8px;
          font-size: 16px;
          transition: border-color 0.2s;
        }

        .todo-input:focus {
          outline: none;
          border-color: #4CAF50;
        }

        .todo-button {
          padding: 12px 24px;
          background-color: #4CAF50;
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: background-color 0.2s;
        }

        .todo-button:hover {
          background-color: #45a049;
        }

        .todo-button:active {
          transform: scale(0.98);
        }

        .todo-filters {
          display: flex;
          gap: 8px;
          margin-bottom: 20px;
          justify-content: center;
        }

        .filter-button {
          padding: 8px 16px;
          border: 2px solid #e0e0e0;
          background-color: white;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 600;
          transition: all 0.2s;
        }

        .filter-button:hover {
          border-color: #4CAF50;
        }

        .filter-button.active {
          background-color: #4CAF50;
          color: white;
          border-color: #4CAF50;
        }

        .todo-list {
          list-style: none;
          padding: 0;
          margin: 0 0 20px 0;
        }

        .todo-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          background-color: #f9f9f9;
          border: 1px solid #e0e0e0;
          border-radius: 6px;
          margin-bottom: 8px;
          transition: background-color 0.2s;
        }

        .todo-item:hover {
          background-color: #f0f0f0;
        }

        .todo-item-content {
          display: flex;
          align-items: center;
          gap: 12px;
          flex: 1;
          min-width: 0;
        }

        .todo-checkbox {
          width: 20px;
          height: 20px;
          cursor: pointer;
          accent-color: #4CAF50;
          flex-shrink: 0;
        }

        .todo-title {
          color: #333;
          font-size: 16px;
          word-break: break-word;
        }

        .todo-title.completed {
          color: #999;
          text-decoration: line-through;
        }

        .todo-delete {
          padding: 6px 12px;
          background-color: #ff6b6b;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 600;
          transition: background-color 0.2s;
          flex-shrink: 0;
          margin-left: 8px;
        }

        .todo-delete:hover {
          background-color: #ff5252;
        }

        .todo-empty {
          text-align: center;
          padding: 40px 20px;
          color: #999;
          font-size: 16px;
          background-color: #f9f9f9;
          border: 1px solid #e0e0e0;
          border-radius: 6px;
          list-style: none;
        }

        .todo-stats {
          display: flex;
          justify-content: center;
          gap: 24px;
          padding: 12px 0;
          color: #666;
          font-size: 14px;
          border-top: 1px solid #e0e0e0;
        }
      `}</style>
    </div>
  );
};

export default TodoList;