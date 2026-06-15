import React from 'react';

interface FilterProps {
  activeFilter: 'all' | 'active' | 'completed';
  onFilterChange: (filter: 'all' | 'active' | 'completed') => void;
  remainingCount: number;
}

export default function Filter({ activeFilter, onFilterChange, remainingCount }: FilterProps) {
  const filters = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'completed', label: 'Completed' }
  ] as const;

  return (
    <div className="flex items-center justify-between border-t border-gray-200 px-4 py-4">
      <div className="text-sm font-medium text-gray-700">
        {remainingCount} item{remainingCount !== 1 ? 's' : ''} left
      </div>
      <div className="flex gap-1">
        {filters.map((filter) => (
          <button
            key={filter.key}
            onClick={() => onFilterChange(filter.key as 'all' | 'active' | 'completed')}
            className={`px-3 py-2 text-sm font-medium rounded transition-colors ${
              activeFilter === filter.key
                ? 'bg-blue-500 text-white'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>
    </div>
  );
}