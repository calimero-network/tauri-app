// Retry helper for HTTP requests
export interface RetryOptions {
  attempts?: number;
}

// Error types for retry logic
interface ErrorWithName extends Error {
  name: string;
}

interface ErrorWithStatus extends Error {
  status: number;
}

interface ErrorWithHeaders extends Error {
  headers?: Headers;
}

// Default retry condition - retry on network errors and 5xx status codes
function defaultRetryCondition(error: Error, attempt: number): boolean {
  // Don't retry on the last attempt
  if (attempt <= 0) return false;

  // Distinguish timeout vs. user abort:
  // - Timeout: name === 'TimeoutError' (per spec/platforms)
  // - User abort: name === 'AbortError'
  const errorWithName = error as ErrorWithName;
  const name = errorWithName?.name;
  if (name === 'TimeoutError') return true;
  if (name === 'AbortError') return false;

  // HTTP 5xx and 429 (including HTTPError from web-client)
  const errorWithStatus = error as ErrorWithStatus;
  if (
    'status' in errorWithStatus &&
    typeof errorWithStatus.status === 'number'
  ) {
    const status = errorWithStatus.status;
    return status >= 500 || status === 429;
  }
  // Network TypeError (DNS/reset) is reasonably retryable
  if (name === 'TypeError') return true;

  return false;
}

// Calculate delay with exponential backoff and jitter
function calculateDelay(attempt: number): number {
  const baseDelayMs = 250; // Base 250ms as per spec
  const delay = baseDelayMs * Math.pow(2, attempt - 1);

  // Add ±20% jitter to reduce stampedes
  const jitter = (Math.random() - 0.5) * 0.4 * delay;
  return Math.max(0, delay + jitter);
}

// Retry helper function with new signature
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { attempts = 3 } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error as Error;

      // Check if we should retry (this handles the last attempt check)
      if (!defaultRetryCondition(lastError, attempts - attempt)) {
        throw lastError;
      }

      // Calculate delay
      let delayMs = calculateDelay(attempt);

      // Check for Retry-After header if it's an HTTP error
      const errorWithHeaders = lastError as ErrorWithHeaders;
      const hdrs = errorWithHeaders.headers;
      const retryAfter = hdrs?.get?.('Retry-After');
      if (retryAfter) {
        // If it's a number, treat as seconds
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) {
          delayMs = Math.max(delayMs, seconds * 1000);
        } else {
          // If it's a date, calculate the difference
          const date = new Date(retryAfter);
          if (!isNaN(date.getTime())) {
            const waitTime = Math.max(0, date.getTime() - Date.now());
            // Cap wait at 60s per attempt as per spec
            delayMs = Math.max(delayMs, Math.min(waitTime, 60000));
          }
        }
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error('Retry failed without error');
}

// Helper to create a retry-enabled HTTP client method
export function createRetryableMethod<T extends unknown[], R>(
  method: (...args: T) => Promise<R>,
  retryOptions: RetryOptions = {},
) {
  return async (...args: T): Promise<R> => {
    return withRetry(() => method(...args), retryOptions);
  };
}
