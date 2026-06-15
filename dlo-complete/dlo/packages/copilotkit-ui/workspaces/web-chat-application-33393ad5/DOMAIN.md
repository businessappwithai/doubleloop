# Domain Document — Web Chat Application

> Source: User-provided research
> Created: 2026-06-15T18:07:24.455Z

# Web Chat Application Requirements

## Core Features
- User registration and login with JWT authentication
- Real-time message sending and receiving using WebSockets
- Chat rooms/channels
- User presence tracking (online/offline status)
- Message history with pagination
- User profiles with avatars
- Message reactions and replies
- File sharing capability

## Technical Stack
- Frontend: React 19 with TypeScript
- Backend: Node.js with Express
- Database: PostgreSQL with Prisma ORM
- Real-time: Socket.io for WebSocket communication
- Authentication: JWT + refresh tokens
- Storage: AWS S3 for file uploads

## Architecture
- Microservices: Auth service, Chat service, File service
- Real-time event bus using Socket.io
- Redis for caching and session management
- Docker containerization