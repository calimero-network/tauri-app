// ErrorResponse import removed as it's not used
import {
  HttpClient,
  Transport,
  RequestOptions,
  ResponseParser,
} from './http-types';
import { combineSignals, createTimeoutSignal } from './signal-utils';

// Custom error class for HTTP errors
export class HTTPError extends Error {
  name = 'HTTPError' as const;

  constructor(
    public status: number,
    public statusText: string,
    public url: string,
    public headers: Headers,
    public bodyText?: string, // cap at ~64KB
  ) {
    super(`HTTP ${status} ${statusText}`);
  }

  toJSON(): {
    status: number;
    statusText: string;
    url: string;
    headers: Record<string, string>;
    bodyText?: string;
  } {
    return {
      status: this.status,
      statusText: this.statusText,
      url: this.url,
      headers: headersToRecord(this.headers),
      bodyText: this.bodyText,
    };
  }
}

// Helper function to convert Headers to Record
function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

// Web Standards HTTP client implementation
export class WebHttpClient implements HttpClient {
  constructor(private transport: Transport) {}

  async get<T>(path: string, init?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...init, method: 'GET' });
  }

  async post<T>(
    path: string,
    body?: unknown,
    init?: RequestOptions,
  ): Promise<T> {
    return this.request<T>(path, {
      ...init,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  }

  async put<T>(
    path: string,
    body?: unknown,
    init?: RequestOptions,
  ): Promise<T> {
    return this.request<T>(path, {
      ...init,
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  }

  async delete<T>(path: string, init?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...init, method: 'DELETE' });
  }

  async patch<T>(
    path: string,
    body?: unknown,
    init?: RequestOptions,
  ): Promise<T> {
    return this.request<T>(path, {
      ...init,
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  }

  async head(
    path: string,
    init?: RequestOptions,
  ): Promise<{ headers: Record<string, string>; status: number }> {
    const response = await this.makeRequest<Response>(path, {
      ...init,
      method: 'HEAD',
      parse: 'response',
    });
    return {
      headers: headersToRecord(response.headers),
      status: response.status,
    };
  }

  async request<T>(path: string, init?: RequestOptions): Promise<T> {
    return this.makeRequest<T>(path, init);
  }

  private async makeRequest<T>(
    path: string,
    init?: RequestOptions,
  ): Promise<T> {
    const url = this.buildUrl(path);
    // Detect Tauri - check multiple ways since __TAURI_INTERNALS__ might not be available
    // Also use minimal path if credentials is 'omit' (Tauri workaround)
    const hasTauriInternals = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    const hasTauri = typeof window !== 'undefined' && '__TAURI__' in window;
    const isTauri = hasTauriInternals || hasTauri || this.transport.credentials === 'omit';
    
    // In Tauri, use absolute minimal RequestInit - just like a direct fetch call
    if (isTauri) {
      const headers = await this.buildHeaders(init?.headers);
      let headersObj: Record<string, string>;
      if (headers instanceof Headers) {
        headersObj = {};
        headers.forEach((value, key) => {
          headersObj[key] = value;
        });
      } else {
        headersObj = headers;
      }
      
      // Build minimal RequestInit - only what's absolutely necessary
      const requestInit: RequestInit = {};
      
      if (init?.method && init.method !== 'GET') {
        requestInit.method = init.method;
      }
      
      if (headersObj && Object.keys(headersObj).length > 0) {
        requestInit.headers = headersObj;
      }
      
      if (init?.body !== undefined && init.body !== null) {
        requestInit.body = init.body;
      }
      
      if (this.transport.credentials !== undefined) {
        requestInit.credentials = this.transport.credentials;
      }
      
      try {
        const response = await globalThis.fetch(url, requestInit);
        
        if (!response.ok) {
          const bodyText = await this.getBodyText(response);
          throw new HTTPError(
            response.status,
            response.statusText,
            url,
            response.headers,
            bodyText,
          );
        }
        
        return this.parseResponse<T>(response, init?.parse);
      } catch (error) {
        if (error instanceof HTTPError) {
          throw error;
        }
        throw new HTTPError(
          0,
          'Network Error',
          url,
          new Headers(),
          error instanceof Error ? error.message : 'Unknown error',
        );
      }
    }
    
    // Non-Tauri: use full implementation with signals, etc.
    const signal = this.createAbortSignal(init);
    const headers = await this.buildHeaders(init?.headers);
    let headersObj: Record<string, string>;
    if (headers instanceof Headers) {
      headersObj = {};
      headers.forEach((value, key) => {
        headersObj[key] = value;
      });
    } else {
      headersObj = headers;
    }
    
    const requestInit: RequestInit = {
      method: init?.method || 'GET',
      headers: headersObj,
    };
    
    if (init?.body !== undefined) {
      requestInit.body = init.body;
    }
    
    if (signal) {
      requestInit.signal = signal;
    }
    
    if (this.transport.credentials !== undefined) {
      requestInit.credentials = this.transport.credentials;
    }
    
    if (init?.mode !== undefined) {
      requestInit.mode = init.mode;
    }
    if (init?.cache !== undefined) {
      requestInit.cache = init.cache;
    }
    if (init?.redirect !== undefined) {
      requestInit.redirect = init.redirect;
    }
    if (init?.referrer !== undefined) {
      requestInit.referrer = init.referrer;
    }
    if (init?.referrerPolicy !== undefined) {
      requestInit.referrerPolicy = init.referrerPolicy;
    }
    if (init?.integrity !== undefined) {
      requestInit.integrity = init.integrity;
    }
    if (init?.keepalive !== undefined) {
      requestInit.keepalive = init.keepalive;
    }

    try {
      const response = await this.transport.fetch(url, requestInit);

      if (!response.ok) {
        const bodyText = await this.getBodyText(response);
        throw new HTTPError(
          response.status,
          response.statusText,
          url,
          response.headers,
          bodyText,
        );
      }

      return this.parseResponse<T>(response, init?.parse);
    } catch (error) {
      if (error instanceof HTTPError) {
        throw error;
      }
      throw new HTTPError(
        0,
        'Network Error',
        url,
        new Headers(),
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  }

  private buildUrl(path: string): string {
    // Handle absolute URLs
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path;
    }

    // Handle baseUrl with path
    const baseUrl = this.transport.baseUrl;
    if (path.startsWith('/')) {
      // If path starts with /, combine with baseUrl
      const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
      return `${base}${path}`;
    } else {
      // If path doesn't start with /, append to baseUrl
      const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
      return `${base}${path}`;
    }
  }

  private createAbortSignal(init?: RequestOptions): AbortSignal | undefined {
    // Skip AbortSignal in Tauri - it causes HTTP 0 Network Error
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (isTauri) {
      return undefined;
    }

    const signals: AbortSignal[] = [];

    if (this.transport.defaultAbortSignal) {
      signals.push(this.transport.defaultAbortSignal);
    }

    if (init?.signal) {
      signals.push(init.signal);
    }

    const timeoutMs = init?.timeoutMs || this.transport.timeoutMs;
    if (timeoutMs) {
      signals.push(createTimeoutSignal(timeoutMs));
    }

    return signals.length > 0 ? combineSignals(signals) : undefined;
  }

  private async buildHeaders(
    initHeaders?: HeadersInit,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      ...this.transport.defaultHeaders,
    };

    // Add auth token if available and not empty
    if (this.transport.getAuthToken) {
      try {
        const token = await this.transport.getAuthToken();
        if (token && token.trim() !== '') {
          headers.Authorization = `Bearer ${token}`;
        }
      } catch (error) {
        // Ignore auth token errors
      }
    }

    // Add init headers
    if (initHeaders) {
      if (initHeaders instanceof Headers) {
        initHeaders.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(initHeaders)) {
        initHeaders.forEach(([key, value]) => {
          headers[key] = value;
        });
      } else {
        Object.assign(headers, initHeaders);
      }
    }

    return headers;
  }

  private async parseResponse<T>(
    response: Response,
    parse?: ResponseParser,
  ): Promise<T> {
    switch (parse) {
      case 'text':
        return (await response.text()) as T;
      case 'blob':
        return (await response.blob()) as T;
      case 'arrayBuffer':
        return (await response.arrayBuffer()) as T;
      case 'response':
        return response as T;
      case 'json':
      default:
        return await response.json();
    }
  }

  private async getBodyText(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return text.length > 65536 ? text.slice(0, 65536) + '...' : text;
    } catch {
      return '';
    }
  }
}
