# Event Management Backend

## Purpose
This is the backend for the Event Management website and mobile application. It serves as the foundation for the REST API.

## Technology Stack
- Node.js
- Express.js
- JavaScript
- dotenv for environment variables
- CORS
- nodemon (development)

## Setup Instructions
1. Clone the repository and navigate to this backend directory.
2. Run `npm install` to install dependencies.
3. Copy `.env.example` to `.env` and configure your environment variables.

## Development Command
To start the server in development mode with live reloading:
```bash
npm run dev
```

## Production Command
To start the server for production:
```bash
npm start
```

## Allow shared user contact details
An organizer and system users may share an email address and phone number (the same person can hold both accounts, on the same event or different ones), but there is only ONE ORGANIZER ACCOUNT PER EMAIL, and an ADMINISTRATOR's email is never shared with any other account (sign-up, adding an account and changing an email all refuse it).
```bash
npm run migrate:user-contact-uniqueness
npm run migrate:user-contact-uniqueness -- --apply
```
The migration requires `ATLAS_URL`, changes indexes only, and does not modify user records. It also creates the organizer-only unique email index; if two organizer accounts already share an email it lists them instead, and you resolve those first.

## Folder Structure
- `src/config/`: Configuration files (Database, Environment, External services)
- `src/controllers/`: Handle HTTP requests and responses
- `src/services/`: Business logic and application operations
- `src/repositories/`: Database access layer (CRUD)
- `src/models/`: Database schemas/models
- `src/routes/`: API route definitions
- `src/middlewares/`: Express middlewares (Auth, Validation, Error handling, etc.)
- `src/validators/`: Request validation schemas
- `src/utils/`: Common helper functions and utilities
- `src/sockets/`: WebSocket/Socket.IO functionality

## Basic API Health-Check
- **GET /api/health**: Confirms that the backend server is running.
