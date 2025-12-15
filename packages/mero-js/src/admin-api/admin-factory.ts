import { AdminApiClient } from './admin-client';
import { AdminApiClientConfig } from './admin-types';
import { HttpClient } from '../http-client';

// Mock HTTP client for testing
class MockHttpClient implements HttpClient {
  async get<T>(): Promise<T> {
    throw new Error(
      'HTTP client not implemented - use createAdminApiClientFromHttpClient with a real HTTP client',
    );
  }
  async post<T>(): Promise<T> {
    throw new Error(
      'HTTP client not implemented - use createAdminApiClientFromHttpClient with a real HTTP client',
    );
  }
  async put<T>(): Promise<T> {
    throw new Error(
      'HTTP client not implemented - use createAdminApiClientFromHttpClient with a real HTTP client',
    );
  }
  async delete<T>(): Promise<T> {
    throw new Error(
      'HTTP client not implemented - use createAdminApiClientFromHttpClient with a real HTTP client',
    );
  }
  async patch<T>(): Promise<T> {
    throw new Error(
      'HTTP client not implemented - use createAdminApiClientFromHttpClient with a real HTTP client',
    );
  }
  async head(): Promise<{ headers: Record<string, string>; status: number }> {
    throw new Error(
      'HTTP client not implemented - use createAdminApiClientFromHttpClient with a real HTTP client',
    );
  }
  async request<T>(): Promise<T> {
    throw new Error(
      'HTTP client not implemented - use createAdminApiClientFromHttpClient with a real HTTP client',
    );
  }
}

// Factory functions for creating Admin API clients
export function createBrowserAdminApiClient(
  config: AdminApiClientConfig,
): AdminApiClient {
  const httpClient = new MockHttpClient();
  return new AdminApiClient(httpClient);
}

export function createNodeAdminApiClient(
  config: AdminApiClientConfig,
): AdminApiClient {
  const httpClient = new MockHttpClient();
  return new AdminApiClient(httpClient);
}

export function createAdminApiClient(
  config: AdminApiClientConfig,
): AdminApiClient {
  const httpClient = new MockHttpClient();
  return new AdminApiClient(httpClient);
}

export function createAdminApiClientFromHttpClient(
  httpClient: HttpClient,
  config: AdminApiClientConfig,
): AdminApiClient {
  return new AdminApiClient(httpClient);
}
