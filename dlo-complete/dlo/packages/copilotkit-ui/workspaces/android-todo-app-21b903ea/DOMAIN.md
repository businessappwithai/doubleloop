# Domain Document — Android Todo App

> Source: User-provided research
> Created: 2026-06-15T18:00:12.883Z

# Android Todo Application - Requirements

## Core Features
- Task creation with title and description
- Mark tasks as complete/incomplete
- Delete tasks
- Filter tasks by status (All, Active, Completed)
- Persistent storage using Room database
- Swipe to delete gesture
- Task priority levels (High, Medium, Low)
- Due date picker for tasks

## Technical Stack
- Language: Kotlin
- Architecture: MVVM with LiveData
- Database: Room with SQLite
- UI Framework: Jetpack Compose (modern approach)
- Testing: JUnit, Espresso

## UI/UX Requirements
- Material Design 3 components
- Dark mode support
- Responsive layout for various screen sizes
- Smooth animations for task transitions
- Empty state messaging

## Data Model
- Task entity with: id, title, description, completed, priority, dueDate, createdDate

## User Flows
1. Create new task → Edit task → Mark complete/incomplete → Delete
2. Filter tasks by status
3. Sort tasks by date or priority
4. View empty state when no tasks
5. Persist data across app restarts