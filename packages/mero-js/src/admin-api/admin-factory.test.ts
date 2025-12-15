import { describe, it, expect } from 'vitest';
import {
  createBrowserAdminApiClient,
  createNodeAdminApiClient,
  createAdminApiClient,
  createAdminApiClientFromHttpClient,
} from './admin-factory';
import { AdminApiClient } from './admin-client';
import { HttpClient } from '../http-client';

// Mock HttpClient
class MockHttpClient implements HttpClient {
  async get<T>(path: string): Promise<T> {
    return {} as T;
  }

  async post<T>(path: string, body?: any): Promise<T> {
    return {} as T;
  }

  async put<T>(path: string, body?: any): Promise<T> {
    return {} as T;
  }

  async delete<T>(path: string): Promise<T> {
    return {} as T;
  }

  async head<T>(path: string): Promise<T> {
    return {} as T;
  }

  async patch<T>(path: string, body?: any): Promise<T> {
    return {} as T;
  }
}

describe('Admin API Factory Functions', () => {
  describe('createBrowserAdminApiClient', () => {
    it('should create AdminApiClient with browser HTTP client', () => {
      const config = {
        baseUrl: 'http://localhost',
        getAuthToken: async () => 'test-token',
        timeoutMs: 10000,
      };

      const client = createBrowserAdminApiClient(config);
      expect(client).toBeInstanceOf(AdminApiClient);
    });

    it('should create AdminApiClient with default config', () => {
      const config = {
        baseUrl: 'http://localhost',
      };

      const client = createBrowserAdminApiClient(config);
      expect(client).toBeInstanceOf(AdminApiClient);
    });
  });

  describe('createNodeAdminApiClient', () => {
    it('should create AdminApiClient with node HTTP client', () => {
      const config = {
        baseUrl: 'http://localhost',
        getAuthToken: async () => 'test-token',
        timeoutMs: 10000,
      };

      const client = createNodeAdminApiClient(config);
      expect(client).toBeInstanceOf(AdminApiClient);
    });

    it('should create AdminApiClient with default config', () => {
      const config = {
        baseUrl: 'http://localhost',
      };

      const client = createNodeAdminApiClient(config);
      expect(client).toBeInstanceOf(AdminApiClient);
    });
  });

  describe('createAdminApiClient', () => {
    it('should create AdminApiClient with universal HTTP client', () => {
      const config = {
        baseUrl: 'http://localhost',
        getAuthToken: async () => 'test-token',
        timeoutMs: 10000,
      };

      const client = createAdminApiClient(config);
      expect(client).toBeInstanceOf(AdminApiClient);
    });

    it('should create AdminApiClient with default config', () => {
      const config = {
        baseUrl: 'http://localhost',
      };

      const client = createAdminApiClient(config);
      expect(client).toBeInstanceOf(AdminApiClient);
    });
  });

  describe('createAdminApiClientFromHttpClient', () => {
    it('should create AdminApiClient from existing HttpClient', () => {
      const mockHttpClient = new MockHttpClient();
      const config = {
        baseUrl: 'http://localhost',
        getAuthToken: async () => 'test-token',
        timeoutMs: 10000,
      };

      const client = createAdminApiClientFromHttpClient(mockHttpClient, config);
      expect(client).toBeInstanceOf(AdminApiClient);
    });

    it('should create AdminApiClient with minimal config', () => {
      const mockHttpClient = new MockHttpClient();
      const config = {
        baseUrl: 'http://localhost',
      };

      const client = createAdminApiClientFromHttpClient(mockHttpClient, config);
      expect(client).toBeInstanceOf(AdminApiClient);
    });
  });
});
