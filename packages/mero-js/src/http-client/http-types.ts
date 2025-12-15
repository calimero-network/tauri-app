// Web Standards based types
export type FetchLike = (
  input: RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

export interface Transport {
  fetch: FetchLike;
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  getAuthToken?: () => Promise<string | undefined>;
  onTokenRefresh?: (newToken: string) => Promise<void>;
  timeoutMs?: number;
  credentials?: RequestCredentials;
  defaultAbortSignal?: AbortSignal;
}

// Response parsing options
export type ResponseParser =
  | 'json'
  | 'text'
  | 'blob'
  | 'arrayBuffer'
  | 'response';

export interface RequestOptions extends RequestInit {
  parse?: ResponseParser;
  timeoutMs?: number;
}

export interface HttpClient {
  get<T>(path: string, init?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, init?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, init?: RequestOptions): Promise<T>;
  delete<T>(path: string, init?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, init?: RequestOptions): Promise<T>;
  head(
    path: string,
    init?: RequestOptions,
  ): Promise<{ headers: Record<string, string>; status: number }>;
  request<T>(path: string, init?: RequestOptions): Promise<T>;
}

// Legacy compatibility types (for gradual migration)
export interface Header {
  [key: string]: string;
}

export interface ProgressCallback {
  (progress: number): void;
}

export interface HeadResponse {
  headers: Record<string, string>;
  status: number;
}

export interface LegacyRequestOptions {
  responseType?: 'arraybuffer' | 'blob' | 'json';
}
