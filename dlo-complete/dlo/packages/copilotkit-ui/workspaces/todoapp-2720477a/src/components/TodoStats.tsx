import React from 'react';

interface Todo {
  id: string;
  text: string;
  completed: boolean;
}

type FilterType = 'all' | 'active' | 'completed';

interface TodoStatsProps {
  todos: Todo[];
  filter: FilterType;
  onFilterChange: (filter: FilterType) => void;
}

const FILTER_OPTIONS: Array<{ label: string; value: FilterType }> = [
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Completed', value: 'completed' },
];

export const TodoStats: React.FC<TodoStatsProps> = ({
  todos,
  filter,
  onFilterChange,
}) => {
  const remainingCount = todos.filter(todo => !todo.completed).length;
  const completedCount = todos.length - remainingCount;

  return (
    <div className="flex items-center justify-between bg-white border-t border-gray-200 px-4 py-3 text-sm text-gray-600">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-gray-800">{remainingCount}</span>
          <span>{remainingCount === 1 ? 'item' : 'items'} left</span>
        </div>
        {completedCount > 0 && (
          <div className="flex items-center gap-2">
            <span className="font-semibold">{completedCount}</span>
            <span>{completedCount === 1 ? 'completed' : 'completed'}</span>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        {FILTER_OPTIONS.map(({ label, value }) => (
          <button
            key={value}
            onClick={() => onFilterChange(value)}
            className={`px-3 py-1 rounded-md font-medium transition-colors whitespace-nowrap ${
              filter === value
                ? 'bg-blue-100 text-blue-700'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
};