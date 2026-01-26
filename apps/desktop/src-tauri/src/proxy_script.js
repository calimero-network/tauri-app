(function() {
    if (window.__TAURI_FETCH_PROXY_INJECTED__) return;
    window.__TAURI_FETCH_PROXY_INJECTED__ = true;
    
    // Get configured node URL (injected by Rust backend)
    // This is replaced at runtime by Rust when creating the window
    const configuredNodeUrl = '__CONFIGURED_NODE_URL__';
    const defaultNodeUrl = 'http://localhost:2528';
    const nodeUrl = configuredNodeUrl !== '__CONFIGURED_NODE_URL__' ? configuredNodeUrl : defaultNodeUrl;
    
    console.log('[Tauri Proxy] Configured node URL for interception:', nodeUrl);
    
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
        
        // Only proxy requests to the configured local node URL (HTTP localhost)
        // HTTPS registries don't need proxying (no mixed content issues)
        // Use precise matching to avoid port confusion (e.g., localhost:2528 vs localhost:25280)
        const shouldProxy = urlStr === nodeUrl || urlStr.startsWith(nodeUrl + '/') || urlStr.startsWith(nodeUrl + '?') || urlStr.startsWith(nodeUrl + '#');
        console.log('[Tauri Proxy] Should proxy?', shouldProxy, 'for URL:', urlStr);
        if (shouldProxy) {
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
                // Debug: Log body for /refresh endpoint
                if (urlStr.includes('/refresh')) {
                    console.log('[Tauri Proxy /refresh] Body being proxied:', bodyStr);
                    console.log('[Tauri Proxy /refresh] Body type:', typeof bodyStr);
                    console.log('[Tauri Proxy /refresh] Body length:', bodyStr ? bodyStr.length : 0);
                }
                const response = await proxyRequest(urlStr, (init && init.method) || 'GET', headers, bodyStr);
                
                console.log('[Tauri Proxy] Proxy response:', response.status, urlStr);
                
                // Create a Response-like object
                return new Response(response.body, {
                    status: response.status,
                    statusText: response.status === 200 ? 'OK' : (response.statusText || 'Error'),
                    headers: new Headers(response.headers)
                });
            } catch (error) {
                console.error('[Tauri Proxy] Fetch proxy failed:', error, 'URL:', urlStr);
                // Fall back to original fetch (will fail due to mixed content, but at least we tried)
                return originalFetch.apply(this, arguments);
            }
        }
        
        // For non-localhost requests, use original fetch
        return originalFetch.apply(this, arguments);
    };
    
    console.log('[Tauri Proxy] Fetch interceptor injected immediately');
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
