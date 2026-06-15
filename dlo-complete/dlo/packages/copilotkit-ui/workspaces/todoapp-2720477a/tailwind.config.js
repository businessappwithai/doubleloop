/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'todo-primary': '#3b82f6',
        'todo-secondary': '#ef4444',
        'todo-success': '#10b981',
      },
    },
  },
  plugins: [],
}