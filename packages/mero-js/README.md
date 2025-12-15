# Mero.js - Pure JavaScript SDK for Calimero

A lightweight, universal JavaScript SDK for Calimero that works in both browser and Node.js environments using Web Standards.

> **🚨 Breaking Change (v1.0.0)**: This version removes all legacy Axios-based code. The package now uses only Web Standards (`fetch`, `AbortController`) with zero external dependencies.

## Features

- 🌐 **Web Standards First**: Built on `fetch`, `AbortController`, and other Web APIs
- 🔄 **Universal**: Works in browsers, Node.js, and edge runtimes
- 📦 **Zero Dependencies**: No external dependencies, uses native Web APIs
- 🔧 **Dependency Injection**: Flexible and testable architecture
- ⚡ **Modern**: ES2020+ with TypeScript support
- 🛡️ **Type Safe**: Full TypeScript definitions
- 🔄 **Smart Retry**: Distinguishes user aborts vs timeouts for intelligent retry logic
- 🎯 **Advanced Cancellation**: Signal combination and proper timeout handling

## Behavior

### Error Model (Throwing)

The client **throws** `HTTPError` on any `!response.ok` status. Network/timeout/abort errors are re-thrown as-is:

```typescript
try {
  const data = await httpClient.get('/api/data');
  // Success - data is the parsed response
} catch (error) {
  if (error instanceof HTTPError) {
    console.log(`HTTP ${error.status}: ${error.statusText}`);
    console.log('URL:', error.url);
    console.log('Headers:', error.headers);
    console.log('Body:', error.bodyText); // Up to 64KB
  } else if (error.name === 'TimeoutError') {
    // Request timed out
  } else if (error.name === 'AbortError') {
    // Request was cancelled
  }
}
```

### Parsing Defaults & Override

Each method accepts optional `{ parse?: 'json'|'text'|'blob'|'arrayBuffer'|'response' }`:

**Default parsing rules:**

- `Content-Type: application/json` → parse as JSON
- `Content-Type: text/*` → parse as text
- Other types → parse as `arrayBuffer`

**Override:**

```typescript
// Get raw Response object
const response = await httpClient.get('/api/data', { parse: 'response' });
```

### Retry Policy (`withRetry`)

The `withRetry` helper retries on:

- `HTTPError` with status `429` or `>= 500`
- `TimeoutError` (internal timeouts)
- `TypeError` (network failures)

**Never retries:**

- `AbortError` (user/caller aborts)

```typescript
import { withRetry } from '@calimero-network/mero-js';

const data = await withRetry(
  (attempt) => httpClient.get('/api/data'),
  { attempts: 3 }, // Default: 3 attempts
);
```

### Signal Composition

The client combines caller signals with internal timeouts:

```typescript
const userSignal = new AbortController().signal;
const data = await httpClient.get('/api/data', {
  signal: userSignal,
  timeoutMs: 5000,
});
```

### Header Precedence & Authorization

- **Caller headers win**: Request-level headers override client defaults
- **Authorization rules**: Only set `Authorization: Bearer ${token}` if caller didn't provide any `authorization` header (case-insensitive)

### FormData Handling

For `FormData` bodies, the client does **not** set `content-type` (lets browser/undici add the boundary):

```typescript
const formData = new FormData();
formData.append('file', file);
await httpClient.post('/api/upload', formData);
// No content-type header is set by the client
```

### Credentials

No implicit `same-origin` default. Credentials are only set if explicitly provided:

```typescript
const client = createBrowserHttpClient({
  baseUrl: 'https://api.example.com',
  credentials: 'include', // Only if you want to include credentials
});
```

## Installation

```bash
npm install @calimero-network/mero-js
```

## Quick Start

### Browser Usage

```typescript
import { createBrowserHttpClient } from '@calimero-network/mero-js';

const httpClient = createBrowserHttpClient({
  baseUrl: 'https://api.calimero.network',
  getAuthToken: async () => localStorage.getItem('access_token'),
  onTokenRefresh: async (newToken) =>
    localStorage.setItem('access_token', newToken),
});

// Make requests
try {
  const data = await httpClient.get<{ message: string }>('/api/hello');
  console.log(data.message);
} catch (error) {
  console.error('Request failed:', error);
}
```

### Node.js Usage

```typescript
import { createNodeHttpClient } from '@calimero-network/mero-js';
// For Node.js < 18, install undici: npm install undici
import { fetch as undiciFetch } from 'undici';

const httpClient = createNodeHttpClient({
  baseUrl: 'https://api.calimero.network',
  fetch: undiciFetch, // Required for Node.js < 18
  getAuthToken: async () => process.env.ACCESS_TOKEN,
});

const data = await httpClient.get<{ message: string }>('/api/hello');
console.log(data.message);
```

### Universal Usage

```typescript
import { createUniversalHttpClient } from '@calimero-network/mero-js';

const httpClient = createUniversalHttpClient({
  baseUrl: 'https://api.calimero.network',
  getAuthToken: async () => {
    return typeof window !== 'undefined'
      ? localStorage.getItem('access_token')
      : process.env.ACCESS_TOKEN;
  },
});
```

## API Reference

### Factory Functions

#### `createBrowserHttpClient(options)`

Creates an HTTP client optimized for browser environments.

#### `createNodeHttpClient(options)`

Creates an HTTP client for Node.js environments.

#### `createUniversalHttpClient(options)`

Creates an HTTP client that works in both browser and Node.js.

### Options

```typescript
interface HttpClientOptions {
  baseUrl: string; // Base URL for all requests
  fetch?: typeof fetch; // Custom fetch implementation (Node.js)
  getAuthToken?: () => Promise<string | undefined>; // Token getter
  onTokenRefresh?: (token: string) => Promise<void>; // Token refresh callback
  defaultHeaders?: Record<string, string>; // Default headers
  timeoutMs?: number; // Request timeout (default: 30000)
  credentials?: RequestCredentials; // CORS credentials (default: 'same-origin' for browser)
  defaultAbortSignal?: AbortSignal; // Default abort signal for all requests
}
```

### HTTP Methods

```typescript
// GET request
const response = await httpClient.get<T>('/api/endpoint', init?);

// POST request
const response = await httpClient.post<T>('/api/endpoint', body?, init?);

// PUT request
const response = await httpClient.put<T>('/api/endpoint', body?, init?);

// DELETE request
const response = await httpClient.delete<T>('/api/endpoint', init?);

// PATCH request
const response = await httpClient.patch<T>('/api/endpoint', body?, init?);

// HEAD request
const response = await httpClient.head<T>('/api/endpoint', init?);

// Generic request
const response = await httpClient.request<T>('/api/endpoint', init?);
```

### Request Options

```typescript
interface RequestOptions extends RequestInit {
  parse?: 'json' | 'text' | 'blob' | 'arrayBuffer' | 'response';
  timeoutMs?: number;
}
```

### Response Format

All methods return the parsed data directly or throw errors:

```typescript
// Success - returns parsed data
const data: T = await httpClient.get<T>('/api/data');

// Error - throws HTTPError or other errors
try {
  const data = await httpClient.get('/api/data');
} catch (error) {
  if (error instanceof HTTPError) {
    console.log(`HTTP ${error.status}: ${error.statusText}`);
    console.log('URL:', error.url);
    console.log('Headers:', error.headers);
    console.log('Body:', error.bodyText);
  }
}
```

## Advanced Usage

### Custom Transport

```typescript
import { createHttpClient, Transport } from '@calimero-network/mero-js';

const transport: Transport = {
  fetch: customFetch,
  baseUrl: 'https://api.example.com',
  getAuthToken: async () => 'your-token',
  timeoutMs: 5000,
};

const httpClient = createHttpClient(transport);
```

### Error Handling

```typescript
try {
  const data = await httpClient.get('/api/data');
  // Success - data is the parsed response
  console.log(data);
} catch (error) {
  if (error instanceof HTTPError) {
    // HTTP error (4xx, 5xx)
    console.error(`HTTP ${error.status}: ${error.statusText}`);
    console.error('URL:', error.url);
    console.error('Body:', error.bodyText);
  } else if (error.name === 'TimeoutError') {
    // Request timed out
    console.error('Request timed out');
  } else if (error.name === 'AbortError') {
    // Request was cancelled
    console.error('Request was cancelled');
  } else {
    // Network or other errors
    console.error('Request failed:', error);
  }
}
```

### Custom Headers

```typescript
const data = await httpClient.post('/api/data', body, {
  headers: {
    'Content-Type': 'application/json',
    'X-Custom-Header': 'value',
  },
});
```

### Request Cancellation

```typescript
const abortController = new AbortController();

// Cancel request after 5 seconds
setTimeout(() => abortController.abort(), 5000);

const data = await httpClient.get('/api/slow-endpoint', {
  signal: abortController.signal,
});
```

### FormData Support

```typescript
const formData = new FormData();
formData.append('file', fileInput.files[0]);
formData.append('name', 'John Doe');

const data = await httpClient.post('/api/upload', formData);
// Content-Type is set by the browser/undici with proper boundary
```

### Response Parsing

```typescript
// Explicit parsing
const jsonData = await httpClient.get('/api/data', { parse: 'json' });
const textData = await httpClient.get('/api/text', { parse: 'text' });
const blobData = await httpClient.get('/api/file', { parse: 'blob' });

// Auto-detection based on Content-Type (default)
const autoData = await httpClient.get('/api/data');
```

### Retry with Exponential Backoff

```typescript
import { withRetry } from '@calimero-network/mero-js';

const data = await withRetry(
  (attempt) => httpClient.get('/api/unreliable-endpoint'),
  { attempts: 3 }, // Default: 3 attempts
);
```

### Signal Combination

```typescript
import { combineSignals, createTimeoutSignal } from '@calimero-network/mero-js';

// Combine multiple abort signals
const userSignal = new AbortController().signal;
const timeoutSignal = createTimeoutSignal(5000);
const combinedSignal = combineSignals([userSignal, timeoutSignal]);

const data = await httpClient.get('/api/endpoint', {
  signal: combinedSignal,
});
```

### CORS and Credentials

```typescript
const httpClient = createBrowserHttpClient({
  baseUrl: 'https://api.example.com',
  credentials: 'include', // Include cookies in CORS requests
});

// For APIs that require credentials
const data = await httpClient.get('/api/protected', {
  credentials: 'include',
});
```

## Migration from Axios

If you're migrating from an Axios-based client:

1. **Replace imports**: Use the factory functions instead of direct class instantiation
2. **Update method signatures**: Methods now use `RequestInit` instead of custom options
3. **Handle responses**: Methods now return parsed data directly or throw errors (no more `ResponseData<T>`)
4. **Token management**: Use the `getAuthToken` and `onTokenRefresh` callbacks

## Browser Support

- Modern browsers with `fetch` support (Chrome 42+, Firefox 39+, Safari 10.1+)
- Node.js 18+ (native fetch) or Node.js 16+ with `undici`

## Bundle Sizes

- **ESM**: ~9.4kb (gzipped: ~3.2kb)
- **CJS**: ~10.5kb (gzipped: ~3.6kb)

## Examples

See the `examples/` directory for complete usage examples:

- `browser-example.ts` - Browser-specific usage (designed for browser environments)
- `node-example.ts` - Node.js-specific usage (designed for Node.js environments)
- `universal-example.ts` - Universal usage (works in both browser and Node.js)

**Note**: Run `npm run build` before running the examples, as they import from the built library.

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Test
pnpm test

# Lint
pnpm lint
```

## License

MIT
