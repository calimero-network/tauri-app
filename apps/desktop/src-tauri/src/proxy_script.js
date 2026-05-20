(function() {
    if (window.__TAURI_FETCH_PROXY_INJECTED__) return;
    window.__TAURI_FETCH_PROXY_INJECTED__ = true;
    
    // Get configured node URL (injected by Rust backend)
    // This is replaced at runtime by Rust when creating the window
    const configuredNodeUrl = '__CONFIGURED_NODE_URL__';
    const defaultNodeUrl = 'http://localhost:2528';
    const nodeUrl = configuredNodeUrl !== '__CONFIGURED_NODE_URL__' ? configuredNodeUrl : defaultNodeUrl;

    console.log('[Tauri Proxy] Configured node URL for interception:', nodeUrl);

    // Check if a URL is an HTTP localhost request that needs proxying
    // Any http://localhost:* or http://127.0.0.1:* request from an HTTPS page
    // will be blocked by mixed content rules, so we proxy all of them
    function isHttpLocalhost(urlStr) {
        try {
            var u = new URL(urlStr);
            return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
        } catch (e) {
            return false;
        }
    }
    
    // Helper function to proxy HTTP requests through Tauri
    async function proxyRequest(url, method, headers, body) {
        // Get Tauri invoke function - check at call time, not script load time
        let invokeFn = null;
        if (typeof window.__TAURI_INVOKE__ === 'function') {
            invokeFn = window.__TAURI_INVOKE__;
        } else if (typeof window.__TAURI__ !== 'undefined' && typeof window.__TAURI__.invoke === 'function') {
            invokeFn = window.__TAURI__.invoke.bind(window.__TAURI__);
        } else {
            console.error('[Tauri Proxy] Tauri invoke API not available!');
            throw new Error('Tauri invoke API not available');
        }
        
        console.log('[Tauri Proxy] Calling Tauri proxy with headers:', Object.keys(headers || {}));
        const response = await invokeFn('proxy_http_request', {
            request: {
                url: url,
                method: method || 'GET',
                headers: headers && Object.keys(headers).length > 0 ? headers : null,
                body: body
            },
            configured_node_url: nodeUrl
        });
        
        return response;
    }
    
    // Store original fetch IMMEDIATELY before React loads
    const originalFetch = window.fetch.bind(window);
    
    // Intercept fetch API IMMEDIATELY - React makes calls during initialization
    window.fetch = async function(url, init) {
        const urlStr = typeof url === 'string' ? url : (url instanceof URL ? url.href : url.toString());

        // Debug: log all fetch calls to see what's happening
        console.log('[Tauri Proxy] Fetch called:', urlStr);

        // Proxy any HTTP localhost request (any port) to avoid mixed content blocking.
        // The Rust backend validates the URL before proxying.
        const shouldProxy = isHttpLocalhost(urlStr);
        console.log('[Tauri Proxy] Should proxy?', shouldProxy, 'for URL:', urlStr);

        // Never proxy streaming (SSE) requests. The Tauri IPC proxy calls
        // response.text() on the Rust side which buffers the entire body —
        // for a never-ending SSE stream this hangs forever, so SseClient
        // never receives the connect message, session_id stays null, and no
        // subscriptions reach the server.
        // App windows are served from http://, not tauri://, so the original
        // fetch can reach http://localhost:* directly with no mixed-content block.
        if (shouldProxy && init) {
            var acceptHeader = '';
            if (init.headers instanceof Headers) {
                acceptHeader = init.headers.get('Accept') || init.headers.get('accept') || '';
            } else if (Array.isArray(init.headers)) {
                var found = init.headers.find(function(h) { return h[0].toLowerCase() === 'accept'; });
                if (found) acceptHeader = found[1];
            } else if (init.headers && typeof init.headers === 'object') {
                acceptHeader = init.headers['Accept'] || init.headers['accept'] || '';
            }
            if (acceptHeader === 'text/event-stream') {
                console.log('[Tauri Proxy] SSE request — bypassing proxy for streaming:', urlStr);
                return originalFetch.apply(this, arguments);
            }
        }

        if (shouldProxy) {
            // Reject immediately if signal is already aborted
            if (init && init.signal && init.signal.aborted) {
                return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
            }

            try {
                const headers = {};
                if (init && init.headers) {
                    if (init.headers instanceof Headers) {
                        init.headers.forEach((value, key) => {
                            headers[key] = value;
                        });
                    } else if (Array.isArray(init.headers)) {
                        init.headers.forEach(([key, value]) => {
                            headers[key] = value;
                        });
                    } else {
                        Object.assign(headers, init.headers);
                    }
                }

                let bodyStr = null;
                if (init && init.body) {
                    if (typeof init.body === 'string') {
                        bodyStr = init.body;
                    } else if (init.body instanceof FormData || init.body instanceof Blob) {
                        bodyStr = await new Response(init.body).text();
                    } else {
                        bodyStr = await new Response(init.body).text();
                    }
                }

                console.log('[Tauri Proxy] Intercepting fetch:', urlStr, 'method:', init?.method || 'GET');
                console.log('[Tauri Proxy] Headers being sent:', JSON.stringify(headers, null, 2));
                console.log('[Tauri Proxy] Has Authorization header?', 'Authorization' in headers || 'authorization' in headers);

                const requestPromise = proxyRequest(urlStr, (init && init.method) || 'GET', headers, bodyStr);

                let response;
                if (init && init.signal) {
                    // Race the request against the abort signal
                    const abortPromise = new Promise((_, reject) => {
                        const onAbort = () => {
                            init.signal.removeEventListener('abort', onAbort);
                            reject(new DOMException('The operation was aborted.', 'AbortError'));
                        };
                        init.signal.addEventListener('abort', onAbort);
                        // Clean up listener when request wins
                        requestPromise.then(() => init.signal.removeEventListener('abort', onAbort))
                                      .catch(() => init.signal.removeEventListener('abort', onAbort));
                    });
                    response = await Promise.race([requestPromise, abortPromise]);
                } else {
                    response = await requestPromise;
                }

                console.log('[Tauri Proxy] Proxy response:', response.status, urlStr);

                return new Response(response.body, {
                    status: response.status,
                    statusText: response.status === 200 ? 'OK' : (response.statusText || 'Error'),
                    headers: new Headers(response.headers)
                });
            } catch (error) {
                console.error('[Tauri Proxy] Fetch proxy failed:', error, 'URL:', urlStr);
                // In non-Tauri environments (tests, dev server), Tauri invoke isn't
                // available — fall back so Playwright mocks and dev server still work.
                const isTauri = typeof window.__TAURI_INVOKE__ === 'function' ||
                    (typeof window.__TAURI__ !== 'undefined' && typeof window.__TAURI__.invoke === 'function');
                if (!isTauri) {
                    return originalFetch.apply(this, arguments);
                }
                // In Tauri, falling back always produces HTTP 0 (mixed content).
                // Re-throw so the caller gets the real error.
                throw error;
            }
        }
        
        // For non-localhost requests, use original fetch
        return originalFetch.apply(this, arguments);
    };
    
    // Also intercept XMLHttpRequest for libraries that use XHR instead of fetch
    const OriginalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
        const xhr = new OriginalXHR();
        const originalOpen = xhr.open.bind(xhr);
        const originalSend = xhr.send.bind(xhr);
        let xhrMethod = 'GET';
        let xhrUrl = '';
        let xhrHeaders = {};

        xhr.open = function(method, url) {
            xhrMethod = method || 'GET';
            xhrUrl = typeof url === 'string' ? url : url.toString();
            xhrHeaders = {};
            return originalOpen.apply(this, arguments);
        };

        const originalSetRequestHeader = xhr.setRequestHeader.bind(xhr);
        xhr.setRequestHeader = function(name, value) {
            xhrHeaders[name] = value;
            return originalSetRequestHeader.apply(this, arguments);
        };

        xhr.send = function(body) {
            const shouldProxy = isHttpLocalhost(xhrUrl);

            if (shouldProxy) {
                console.log('[Tauri Proxy] XHR intercepted:', xhrMethod, xhrUrl);

                proxyRequest(xhrUrl, xhrMethod, xhrHeaders, body ? String(body) : null)
                    .then(function(response) {
                        console.log('[Tauri Proxy] XHR proxy response:', response.status, xhrUrl);
                        Object.defineProperty(xhr, 'status', { value: response.status, writable: false });
                        Object.defineProperty(xhr, 'statusText', { value: response.status === 200 ? 'OK' : 'Error', writable: false });
                        Object.defineProperty(xhr, 'responseText', { value: response.body || '', writable: false });
                        Object.defineProperty(xhr, 'response', { value: response.body || '', writable: false });
                        Object.defineProperty(xhr, 'readyState', { value: 4, writable: false });

                        var headerStr = '';
                        if (response.headers) {
                            Object.keys(response.headers).forEach(function(key) {
                                headerStr += key + ': ' + response.headers[key] + '\r\n';
                            });
                        }
                        xhr.getAllResponseHeaders = function() { return headerStr; };
                        xhr.getResponseHeader = function(name) {
                            return response.headers ? (response.headers[name] || response.headers[name.toLowerCase()] || null) : null;
                        };

                        if (typeof xhr.onreadystatechange === 'function') {
                            xhr.onreadystatechange(new Event('readystatechange'));
                        }
                        xhr.dispatchEvent(new Event('readystatechange'));
                        if (typeof xhr.onload === 'function') {
                            xhr.onload(new ProgressEvent('load'));
                        }
                        xhr.dispatchEvent(new ProgressEvent('load'));
                        xhr.dispatchEvent(new ProgressEvent('loadend'));
                    })
                    .catch(function(error) {
                        console.error('[Tauri Proxy] XHR proxy failed:', error, 'URL:', xhrUrl);
                        if (typeof xhr.onerror === 'function') {
                            xhr.onerror(new ProgressEvent('error'));
                        }
                        xhr.dispatchEvent(new ProgressEvent('error'));
                        xhr.dispatchEvent(new ProgressEvent('loadend'));
                    });
                return;
            }

            return originalSend.apply(this, arguments);
        };

        return xhr;
    };
    window.XMLHttpRequest.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest.UNSENT = 0;
    window.XMLHttpRequest.OPENED = 1;
    window.XMLHttpRequest.HEADERS_RECEIVED = 2;
    window.XMLHttpRequest.LOADING = 3;
    window.XMLHttpRequest.DONE = 4;

    console.log('[Tauri Proxy] Fetch + XHR interceptors injected');
    console.log('[Tauri Proxy] Original fetch stored:', typeof originalFetch);

    // Check Tauri API availability - it might not be ready immediately
    function checkTauriAPI() {
        if (typeof window.__TAURI_INVOKE__ === 'function') {
            console.log('[Tauri Proxy] Tauri invoke available: YES');
            return window.__TAURI_INVOKE__;
        } else if (typeof window.__TAURI__ !== 'undefined' && typeof window.__TAURI__.invoke === 'function') {
            console.log('[Tauri Proxy] Tauri invoke available via __TAURI__: YES');
            return window.__TAURI__.invoke.bind(window.__TAURI__);
        } else {
            console.warn('[Tauri Proxy] Tauri invoke NOT available yet');
            return null;
        }
    }
    
    // Check immediately
    checkTauriAPI();
})();
