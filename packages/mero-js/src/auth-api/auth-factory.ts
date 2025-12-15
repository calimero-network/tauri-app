import { AuthApiClient } from './auth-client';
import { AuthApiClientConfig } from './auth-types';
import { HttpClient } from '../http-client';

// Mock HTTP client for testing
class MockHttpClient implements HttpClient {
  async get<T>(): Promise<T> {
    throw new Error(
      'HTTP client not implemented - use createAuthApiClientFromHttpClient with a real HTTP client',
    );
  }
  async post<T>(): Promise<T> {
    throw new Error(
      'HTTP client not implemented - use createAuthApiClientFromHttpClient with a real HTTP client',
    );
  }
  async put<T>(): Promise<T> {
    throw new Error(
      'HTTP client not implemented - use createAuthApiClientFromHttpClient with a real HTTP client',
    );
  }
  async delete<T>(): Promise<T> {
    throw new Error(
      'HTTP client not implemented - use createAuthApiClientFromHttpClient with a real HTTP client',
    );
  }
  async patch<T>(): Promise<T> {
    throw new Error(
      'HTTP client not implemented - use createAuthApiClientFromHttpClient with a real HTTP client',
    );
  }
  async head(): Promise<{ headers: Record<string, string>; status: number }> {
    throw new Error(
      'HTTP client not implemented - use createAuthApiClientFromHttpClient with a real HTTP client',
    );
  }
  async request<T>(): Promise<T> {
    throw new Error(
      'HTTP client not implemented - use createAuthApiClientFromHttpClient with a real HTTP client',
    );
  }
}

// Factory functions for creating Auth API clients
export function createBrowserAuthApiClient(
  config: AuthApiClientConfig,
): AuthApiClient {
  const httpClient = new MockHttpClient();
  return new AuthApiClient(httpClient);
}

export function createNodeAuthApiClient(
  config: AuthApiClientConfig,
): AuthApiClient {
  const httpClient = new MockHttpClient();
  return new AuthApiClient(httpClient);
}

export function createAuthApiClient(
  config: AuthApiClientConfig,
): AuthApiClient {
  const httpClient = new MockHttpClient();
  return new AuthApiClient(httpClient);
}

export function createAuthApiClientFromHttpClient(
  httpClient: HttpClient,
  config: AuthApiClientConfig,
): AuthApiClient {
  return new AuthApiClient(httpClient);
}
