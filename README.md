# WhatEat Backend

A TypeScript + Express + Supabase backend for a personal recipe management app with Sign in with Apple authentication.

## Features

- **Authentication**: Sign in with Apple via Supabase Auth
- **Recipe CRUD**: Create, read, update, delete recipes with ingredients and steps
- **URL Import**: Extract recipes from URLs (schema.org + AI fallback)
- **Image Import**: Extract recipes from photos using AI
- **Daily Suggestions**: AI-generated recipe ideas based on preferences
- **Rate Limiting**: Usage tracking and quotas for AI features

## Tech Stack

- **Runtime**: Node.js with TypeScript (ES Modules)
- **Framework**: Express.js
- **Database**: Supabase (PostgreSQL with RLS)
- **Auth**: Supabase Auth with Apple provider
- **AI**: OpenAI API (GPT-4 / Vision)
- **Logging**: Pino

## Getting Started

### Prerequisites

- Node.js 20+
- A Supabase project
- Apple Developer account (for Sign in with Apple)
- OpenAI API key (optional, for AI features)

### Installation

```bash
# Install dependencies
npm install

# Copy environment file and fill in values
cp .env.example .env

# Run database migrations (via Supabase CLI)
npx supabase db push

# Start development server
npm run dev
```

## API Endpoints

### Health
- `GET /api/v1/health` - Health check

### Recipes (requires auth)
- `GET /api/v1/recipes` - List recipes (paginated)
- `GET /api/v1/recipes/:id` - Get single recipe
- `POST /api/v1/recipes` - Create recipe
- `PATCH /api/v1/recipes/:id` - Update recipe
- `DELETE /api/v1/recipes/:id` - Soft delete recipe

### Import (requires auth)
- `POST /api/v1/import/url` - Import recipe from URL
- `POST /api/v1/import/image` - Import recipe from image
- `GET /api/v1/import/jobs` - List import jobs
- `GET /api/v1/import/jobs/:id` - Get job status

### Daily (requires auth)
- `GET /api/v1/daily/suggestions` - Get today's suggestions
- `POST /api/v1/daily/suggestions/:id/save` - Save suggestion as recipe
- `GET /api/v1/daily/preferences` - Get user preferences
- `PUT /api/v1/daily/preferences` - Update preferences

## Authentication

All protected endpoints require the `Authorization` header:

```
Authorization: Bearer <supabase-jwt>
```

### iOS Integration

```swift
// 1. Sign in with Apple
let appleIDCredential = try await ASAuthorizationAppleIDProvider().signIn()

// 2. Exchange for Supabase session
let session = try await supabase.auth.signInWithIdToken(
  credentials: .init(provider: .apple, idToken: appleIDCredential.identityToken)
)

// 3. Use the access token for API calls
var request = URLRequest(url: URL(string: "https://api.example.com/api/v1/recipes")!)
request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
```

## Project Structure

```
src/
├── index.ts              # Entry point
├── app.ts                # Express app setup
├── config/
│   ├── env.ts            # Environment validation
│   └── supabase.ts       # Supabase clients
├── middleware/
│   ├── auth.ts           # JWT verification
│   ├── errorHandler.ts   # Global error handler
│   └── requestId.ts      # Request ID tracking
├── routes/
│   ├── health.ts         # Health check
│   ├── recipes.ts        # Recipe CRUD
│   ├── import.ts         # URL/image import
│   └── daily.ts          # Daily suggestions
├── services/
│   ├── recipe.service.ts # Recipe business logic
│   ├── import.service.ts # Import processing
│   └── ai.service.ts     # OpenAI integration
├── types/
│   ├── supabase.ts       # Database types
│   └── index.ts          # Shared types
└── utils/
    ├── logger.ts         # Pino logger
    └── errors.ts         # Custom errors
```

## Scripts

```bash
npm run dev       # Start dev server with hot reload
npm run build     # Compile TypeScript
npm run start     # Run compiled code
npm run typecheck # Type check without emitting
npm run rebuild:esbuild # Fix esbuild binary for your current Node architecture
```

## Troubleshooting

### esbuild/tsx architecture mismatch (macOS)

If you see an error like "You installed esbuild for another platform", your
Node architecture does not match the installed esbuild binary.

Quick fix:

```bash
npm run rebuild:esbuild
```

If that does not work, reinstall dependencies using a single architecture:

```bash
rm -rf node_modules package-lock.json
npm install
```

Tip: On Apple Silicon, avoid mixing Rosetta (x64) Node with arm64 installs.
`node -p process.arch` should align with `uname -m`.

## License

MIT


# whatEatBE
