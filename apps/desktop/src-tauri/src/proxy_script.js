(function() {
    if (window.__TAURI_FETCH_PROXY_INJECTED__) return;
    window.__TAURI_FETCH_PROXY_INJECTED__ = true;

    // Get configured node URL (injected by Rust backend)
    // This is replaced at runtime by Rust when creating the window
    const configuredNodeUrl = '__CONFIGURED_NODE_URL__';
    const defaultNodeUrl = 'http://localhost:2528';
    const nodeUrl = configuredNodeUrl !== '__CONFIGURED_NODE_URL__' ? configuredNodeUrl : defaultNodeUrl;

    console.log('[Tauri Proxy] Configured node URL for interception:', nodeUrl);

    // Sentinel the desktop puts in the app's refresh-token slot instead of the
    // real refresh token. MUST match BROKERED_REFRESH_TOKEN in src/lib/token-broker.ts.
    const BROKERED_REFRESH_TOKEN = 'calimero-desktop-brokered-refresh-token';

    // Check if a URL is an HTTP localhost request that needs proxying
    function isHttpLocalhost(urlStr) {
        try {
            const u = new URL(urlStr);
            return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
        } catch (e) {
            return false;
        }
    }

    // The proxy exists solely to bypass mixed-content blocking: HTTPS-hosted
    // app pages cannot fetch http://localhost directly. When the page itself
    // is served over plain HTTP (e.g. the node's auth frontend at
    // http://localhost:2528/auth/login after a logout → browser-style login
    // navigation), native fetch works fine — and Tauri v1 IPC scopes are
    // exact-domain matches registered for the app's original domain, so
    // invoking the proxy from a localhost-origin page fails with
    // "Scope not defined for URL". Never proxy from non-HTTPS pages.
    function pageNeedsProxy() {
        try {
            return window.location.protocol === 'https:';
        } catch (e) {
            // No usable location (shouldn't happen in a real webview) —
            // keep the historical always-proxy behavior.
            return true;
        }
    }

    // Only windows the desktop handed the sentinel are brokered. A window with a
    // real refresh token is the sole holder in its own isolated store and rotates
    // directly, which is what an app does in an ordinary browser.
    function isAuthRefresh(urlStr, method, body) {
        if ((method || 'GET').toUpperCase() !== 'POST') return false;
        try {
            if (!new URL(urlStr).pathname.replace(/\/+$/, '').endsWith('/auth/refresh')) return false;
        } catch (e) {
            return false;
        }
        if (typeof body !== 'string') return false;
        try {
            return JSON.parse(body).refresh_token === BROKERED_REFRESH_TOKEN;
        } catch (e) {
            return false;
        }
    }

    // Ask the desktop window to rotate its refresh token and hand back a fresh
    // access token. Returns a proxy-shaped response ({status, body, headers}) so
    // both the fetch and XHR paths can consume it exactly like a proxied reply.
    async function brokerTokenRefresh() {
        const invokeFn = getTauriInvoke();
        if (!invokeFn) {
            // No Tauri IPC — we must NOT fall through to the network, because the
            // app is holding the sentinel, not a real refresh token.
            console.error('[Tauri Proxy] /auth/refresh needs Tauri IPC to be brokered by the desktop');
            return {
                status: 401,
                body: JSON.stringify({ error: 'Token refresh unavailable: no Tauri IPC' }),
                headers: { 'content-type': 'application/json' },
            };
        }

        try {
            const accessToken = await invokeFn('broker_token_refresh');
            console.log('[Tauri Proxy] /auth/refresh brokered by desktop');
            // Same wire shape the node returns, so unmodified mero-js/mero-react
            // parse it as an ordinary refresh response. The refresh token stays
            // the sentinel: the desktop keeps the real one.
            return {
                status: 200,
                body: JSON.stringify({
                    data: { access_token: accessToken, refresh_token: BROKERED_REFRESH_TOKEN },
                }),
                headers: { 'content-type': 'application/json' },
            };
        } catch (error) {
            console.error('[Tauri Proxy] Desktop token broker failed:', error);
            return {
                status: 401,
                body: JSON.stringify({ error: String((error && error.message) || error) }),
                headers: { 'content-type': 'application/json' },
            };
        }
    }

    // Normalize the first fetch() argument: string | URL | Request → string URL
    function normalizeUrl(urlArg) {
        if (typeof urlArg === 'string') return urlArg;
        if (urlArg instanceof URL) return urlArg.href;
        if (typeof Request !== 'undefined' && urlArg instanceof Request) return urlArg.url;
        return String(urlArg);
    }

    // Extract the Accept header value from a fetch init (or Request) headers bag.
    // Returns '' when not present.
    function getAcceptHeader(headers) {
        if (!headers) return '';
        // Headers object — .get() is case-insensitive per spec
        if (headers instanceof Headers) return headers.get('accept') || '';
        if (Array.isArray(headers)) {
            const found = headers.find(h => h[0].toLowerCase() === 'accept');
            return found ? found[1] : '';
        }
        if (typeof headers === 'object') return headers['Accept'] || headers['accept'] || '';
        return '';
    }

    // Extract the Authorization header value from a headers bag.
    function getAuthHeader(headers) {
        if (!headers) return '';
        if (headers instanceof Headers) return headers.get('authorization') || '';
        if (Array.isArray(headers)) {
            const found = headers.find(h => h[0].toLowerCase() === 'authorization');
            return found ? found[1] : '';
        }
        if (typeof headers === 'object') return headers['Authorization'] || headers['authorization'] || '';
        return '';
    }

    // Get the Tauri invoke function (Tauri v2 API shapes).
    // __TAURI_INTERNALS__.invoke is injected into every webview the app's
    // capabilities cover (including remote app windows), regardless of
    // withGlobalTauri. window.__TAURI__.core.invoke only exists when the
    // global API bundle is enabled.
    function getTauriInvoke() {
        if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
            return window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
        }
        if (typeof window.__TAURI__ !== 'undefined'
            && window.__TAURI__.core
            && typeof window.__TAURI__.core.invoke === 'function') {
            return window.__TAURI__.core.invoke.bind(window.__TAURI__.core);
        }
        return null;
    }

    // Low-level Tauri v2 event listener that works with just
    // window.__TAURI_INTERNALS__ (always injected natively) without needing
    // the @tauri-apps/api JS bundle (Vercel-hosted apps don't load it, so
    // window.__TAURI__ is undefined there).
    //
    // Mirrors what @tauri-apps/api/event does internally in v2:
    //   1. transformCallback() registers the handler and returns a numeric id.
    //   2. The `plugin:event|listen` command routes the named event to it.
    async function tauriListen(eventName, handler, invokeFn) {
        // Happy-path: @tauri-apps/api is loaded (e.g. localhost dev or app with bundled API).
        if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.listen === 'function') {
            return window.__TAURI__.event.listen(eventName, handler);
        }
        // Fallback: use the internal IPC directly.
        const internals = window.__TAURI_INTERNALS__;
        if (!internals || typeof internals.transformCallback !== 'function') {
            throw new Error('Tauri internals unavailable for event listen');
        }
        const handlerId = internals.transformCallback(handler);
        const eventId = await invokeFn('plugin:event|listen', {
            event: eventName,
            target: { kind: 'Any' },
            handler: handlerId,
        });
        return function unlisten() {
            invokeFn('plugin:event|unlisten', { event: eventName, eventId }).catch(() => {});
        };
    }

    // Proxy an SSE request through Tauri IPC so it works even from HTTPS-hosted
    // app windows (where native fetch → http://localhost would be blocked by
    // mixed-content rules).  The Rust side streams chunks back as window events;
    // we expose them as a ReadableStream so SseClient.readStream() needs no changes.
    async function proxySSEViaTauri(url, authHeader, signal, invokeFn) {
        const streamId = 'sse-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        const encoder = new TextEncoder();
        let streamController = null;
        let unlistenChunk = null;
        let unlistenEnd = null;

        const readableStream = new ReadableStream({
            start(c) { streamController = c; },
        });

        function cleanup() {
            if (unlistenChunk) { unlistenChunk(); unlistenChunk = null; }
            if (unlistenEnd)   { unlistenEnd();   unlistenEnd   = null; }
        }

        // Register listeners BEFORE invoking so we never miss the first chunk
        try {
            [unlistenChunk, unlistenEnd] = await Promise.all([
                tauriListen('sse-chunk-' + streamId, (event) => {
                    if (event.payload && streamController) {
                        try { streamController.enqueue(encoder.encode(event.payload)); } catch (_) {}
                    }
                }, invokeFn),
                tauriListen('sse-end-' + streamId, () => {
                    try { if (streamController) streamController.close(); } catch (_) {}
                    cleanup();
                }, invokeFn),
            ]);
        } catch (err) {
            console.warn('[Tauri Proxy] SSE: event listen failed:', err);
            try { if (streamController) streamController.error(new Error('SSE listen setup failed: ' + err)); } catch (_) {}
            cleanup();
            return new Response(new ReadableStream({ start(c) { c.error(new Error('SSE unavailable')); } }), { status: 503 });
        }

        // Wire up AbortSignal → cancel_sse_stream
        if (signal) {
            const onAbort = () => {
                invokeFn('cancel_sse_stream', { streamId }).catch(() => {});
                try { if (streamController) streamController.error(new DOMException('Aborted', 'AbortError')); } catch (_) {}
                cleanup();
            };
            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        }

        // Fire-and-forget the Rust streaming command
        invokeFn('proxy_sse_stream', { url, authHeader, streamId }).catch((err) => {
            console.error('[Tauri Proxy] SSE proxy_sse_stream error:', err);
            try { if (streamController) streamController.error(new Error('SSE proxy error: ' + err)); } catch (_) {}
            cleanup();
        });

        console.log('[Tauri Proxy] SSE stream started via Tauri IPC, stream_id:', streamId);
        return new Response(readableStream, {
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }),
        });
    }

    // ─── Binary-safe body helpers ───────────────────────────────────────────
    // The Tauri proxy carries request/response bodies across IPC. Binary
    // payloads (image uploads, blob downloads) must travel as base64 or a UTF-8
    // round-trip corrupts them (String(arrayBuffer) → "[object ArrayBuffer]",
    // response.text() → mojibake). Text bodies stay plain strings.
    function bytesToBase64(bytes) {
        let binary = '';
        const CHUNK = 0x8000; // avoid arg-count limits in String.fromCharCode
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(binary);
    }

    function base64ToBytes(b64) {
        const binary = atob(b64 || '');
        const len = binary.length;
        const out = new Uint8Array(len);
        for (let i = 0; i < len; i++) out[i] = binary.charCodeAt(i);
        return out;
    }

    // A fetch/XHR body is "binary" when it isn't naturally a string. FormData is
    // deliberately treated as text (its multipart boundary lives in a header we
    // don't reconstruct here) — same as the previous behavior, not a regression.
    function isBinaryBody(body) {
        if (body == null || typeof body === 'string') return false;
        if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return false;
        if (typeof FormData !== 'undefined' && body instanceof FormData) return false;
        return true;
    }

    // Resolve any fetch/XHR body into { body, bodyBase64 } for proxyRequest:
    // exactly one is non-null (or both null for an empty body).
    async function encodeBody(body) {
        if (body == null) return { body: null, bodyBase64: null };
        if (!isBinaryBody(body)) {
            if (typeof body === 'string') return { body: body, bodyBase64: null };
            // URLSearchParams / FormData → serialize to text (unchanged behavior)
            return { body: await new Response(body).text(), bodyBase64: null };
        }
        let bytes;
        if (body instanceof ArrayBuffer) {
            bytes = new Uint8Array(body);
        } else if (ArrayBuffer.isView(body)) {
            bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        } else {
            // Blob / File
            bytes = new Uint8Array(await new Response(body).arrayBuffer());
        }
        return { body: null, bodyBase64: bytesToBase64(bytes) };
    }

    // A proxy reply's body → a BodyInit for `new Response(...)`: raw bytes when
    // the backend flagged it binary (body_base64), else the plain string body.
    function decodeResponseBody(response) {
        if (response && typeof response.body_base64 === 'string') {
            return base64ToBytes(response.body_base64);
        }
        return (response && response.body) || '';
    }

    // Helper function to proxy regular HTTP requests through Tauri
    async function proxyRequest(url, method, headers, body, bodyBase64) {
        // A sentinel-bearing /auth/refresh is answered by the desktop instead of
        // being forwarded to the node. Both the fetch and XHR interceptors funnel
        // through here, so this single check covers both.
        if (isAuthRefresh(url, method, body)) {
            return brokerTokenRefresh();
        }

        const invokeFn = getTauriInvoke();
        if (!invokeFn) {
            console.error('[Tauri Proxy] Tauri invoke API not available!');
            throw new Error('Tauri invoke API not available');
        }

        console.log('[Tauri Proxy] Calling Tauri proxy with headers:', Object.keys(headers || {}));
        const response = await invokeFn('proxy_http_request', {
            request: {
                url: url,
                method: method || 'GET',
                headers: headers && Object.keys(headers).length > 0 ? headers : null,
                body: body != null ? body : null,
                body_base64: bodyBase64 != null ? bodyBase64 : null
            },
            configured_node_url: nodeUrl
        });

        return response;
    }

    // Store original fetch IMMEDIATELY before React loads
    const originalFetch = window.fetch.bind(window);

    // Intercept fetch API IMMEDIATELY - React makes calls during initialization
    window.fetch = async function(urlArg, init) {
        // Normalise url — could be a string, URL object, or Request object
        const urlStr = normalizeUrl(urlArg);

        // When fetch() receives a Request object as the sole argument, pull its
        // headers so the SSE / proxy logic can inspect them without init
        const effectiveHeaders = (init && init.headers)
            || (typeof Request !== 'undefined' && urlArg instanceof Request ? urlArg.headers : null);
        const effectiveSignal = (init && init.signal)
            || (typeof Request !== 'undefined' && urlArg instanceof Request ? urlArg.signal : null);
        const effectiveMethod = (init && init.method)
            || (typeof Request !== 'undefined' && urlArg instanceof Request ? urlArg.method : 'GET');
        // A Request's body is a one-shot stream, so read it off a clone - the
        // original must stay consumable for the originalFetch fallback below.
        // Read a Request body as bytes and only decode textual content types:
        // .text() on a Blob/ArrayBuffer payload would corrupt it before encodeBody.
        let effectiveBody = null;
        if (init && init.body != null) {
            effectiveBody = init.body;
        } else if (typeof Request !== 'undefined' && urlArg instanceof Request && urlArg.body != null) {
            const buf = await urlArg.clone().arrayBuffer();
            const ct = (urlArg.headers.get('content-type') || '').toLowerCase();
            const textual = !ct || ct.includes('json') || ct.startsWith('text/')
                || ct.includes('x-www-form-urlencoded');
            effectiveBody = textual ? new TextDecoder().decode(buf) : new Uint8Array(buf);
        }

        console.log('[Tauri Proxy] Fetch called:', urlStr);

        // Proxy any HTTP localhost request (any port) to avoid mixed content blocking.
        // The Rust backend validates the URL before proxying.
        // Mixed-content proxying only applies to an HTTPS-hosted page (finding
        // #145: proxying from a plain-HTTP localhost page fails the Tauri IPC
        // scope check). A sentinel-bearing /auth/refresh is also routed through
        // here regardless of host, so the sentinel is brokered rather than sent
        // out over the network - a real refresh token is not routed specially.
        const shouldProxy =
            (pageNeedsProxy() && isHttpLocalhost(urlStr)) ||
            isAuthRefresh(urlStr, effectiveMethod, effectiveBody);
        console.log('[Tauri Proxy] Should proxy?', shouldProxy, 'for URL:', urlStr);

        if (shouldProxy) {
            // Route SSE requests through the Tauri streaming command so they work
            // even from HTTPS-hosted app windows (e.g. Vercel frontends).
            // Strict proxy buffering (response.text()) would hang an SSE stream,
            // and a plain originalFetch() call fails with mixed-content when the
            // app window is served over HTTPS.
            const acceptHeader = getAcceptHeader(effectiveHeaders);
            if (acceptHeader.includes('text/event-stream')) {
                const invokeFn = getTauriInvoke();
                if (invokeFn) {
                    console.log('[Tauri Proxy] SSE request — routing via Tauri IPC streaming:', urlStr);
                    return proxySSEViaTauri(
                        urlStr,
                        getAuthHeader(effectiveHeaders),
                        effectiveSignal,
                        invokeFn,
                    );
                }
                // No Tauri IPC (shouldn't happen in app windows) — fall through to originalFetch
                console.warn('[Tauri Proxy] SSE: no Tauri IPC, falling back to originalFetch for:', urlStr);
                return originalFetch.apply(this, arguments);
            }

            // Reject immediately if signal is already aborted
            if (effectiveSignal && effectiveSignal.aborted) {
                return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
            }

            try {
                const headers = {};
                if (init && init.headers) {
                    if (init.headers instanceof Headers) {
                        init.headers.forEach((value, key) => { headers[key] = value; });
                    } else if (Array.isArray(init.headers)) {
                        init.headers.forEach(([key, value]) => { headers[key] = value; });
                    } else {
                        Object.assign(headers, init.headers);
                    }
                }

                // Encode the body binary-safely: strings pass through, binary
                // (Blob/ArrayBuffer/typed array) becomes base64 so image uploads
                // survive the IPC hop intact.
                const { body: reqBody, bodyBase64: reqBodyBase64 } =
                    effectiveBody != null ? await encodeBody(effectiveBody) : { body: null, bodyBase64: null };

                console.log('[Tauri Proxy] Intercepting fetch:', urlStr, 'method:', init?.method || 'GET');
                console.log('[Tauri Proxy] Headers being sent:', JSON.stringify(headers, null, 2));
                console.log('[Tauri Proxy] Has Authorization header?', 'Authorization' in headers || 'authorization' in headers);

                const requestPromise = proxyRequest(urlStr, effectiveMethod, headers, reqBody, reqBodyBase64);

                let response;
                if (effectiveSignal) {
                    const abortPromise = new Promise((_, reject) => {
                        const onAbort = () => {
                            effectiveSignal.removeEventListener('abort', onAbort);
                            reject(new DOMException('The operation was aborted.', 'AbortError'));
                        };
                        effectiveSignal.addEventListener('abort', onAbort);
                        requestPromise.then(() => effectiveSignal.removeEventListener('abort', onAbort))
                                      .catch(() => effectiveSignal.removeEventListener('abort', onAbort));
                    });
                    response = await Promise.race([requestPromise, abortPromise]);
                } else {
                    response = await requestPromise;
                }

                console.log('[Tauri Proxy] Proxy response:', response.status, urlStr);

                // decodeResponseBody yields raw bytes for binary replies (images,
                // blobs) so response.blob()/arrayBuffer() are byte-exact.
                return new Response(decodeResponseBody(response), {
                    status: response.status,
                    statusText: response.status === 200 ? 'OK' : (response.statusText || 'Error'),
                    headers: new Headers(response.headers)
                });
            } catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') {
                    throw error;
                }
                // Last resort: try the native fetch. If the proxy failed for an
                // IPC scope error while the page can reach localhost natively,
                // this recovers; if mixed content blocks it, it fails the same
                // way the proxy just did.
                console.error('[Tauri Proxy] Fetch proxy failed, falling back to native fetch:', error, 'URL:', urlStr);
                return originalFetch.apply(this, arguments);
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
            const shouldProxy =
                (pageNeedsProxy() && isHttpLocalhost(xhrUrl)) ||
                isAuthRefresh(xhrUrl, xhrMethod, body);

            if (shouldProxy) {
                console.log('[Tauri Proxy] XHR intercepted:', xhrMethod, xhrUrl);

                // Encode the request body binary-safely (this is the image-upload
                // path: axios PUTs an ArrayBuffer, which String(body) used to turn
                // into the literal "[object ArrayBuffer]").
                encodeBody(body)
                    .then(function(enc) {
                        return proxyRequest(xhrUrl, xhrMethod, xhrHeaders, enc.body, enc.bodyBase64);
                    })
                    .then(function(response) {
                        console.log('[Tauri Proxy] XHR proxy response:', response.status, xhrUrl);

                        // Decode the reply for whichever mode the caller reads.
                        const hasBinary = response && typeof response.body_base64 === 'string';
                        const bytes = hasBinary ? base64ToBytes(response.body_base64) : null;
                        const text = hasBinary ? new TextDecoder().decode(bytes) : (response.body || '');
                        const rt = (xhr.responseType || '').toLowerCase();
                        // Content-Type for the Blob's `type` (native XHR sets it from this header).
                        const contentType = response.headers
                            ? (response.headers['content-type'] || response.headers['Content-Type'] || '')
                            : '';
                        let responseValue;
                        if (rt === 'arraybuffer') {
                            responseValue = bytes ? bytes.buffer : new TextEncoder().encode(text).buffer;
                        } else if (rt === 'blob') {
                            const blobOpts = contentType ? { type: contentType } : undefined;
                            responseValue = bytes ? new Blob([bytes], blobOpts) : new Blob([text], blobOpts);
                        } else if (rt === 'json') {
                            try { responseValue = JSON.parse(text); } catch (_) { responseValue = null; }
                        } else {
                            responseValue = text;
                        }

                        Object.defineProperty(xhr, 'status', { value: response.status, writable: false, configurable: true });
                        Object.defineProperty(xhr, 'statusText', { value: response.status === 200 ? 'OK' : 'Error', writable: false, configurable: true });
                        Object.defineProperty(xhr, 'responseText', { value: text, writable: false, configurable: true });
                        Object.defineProperty(xhr, 'response', { value: responseValue, writable: false, configurable: true });
                        Object.defineProperty(xhr, 'readyState', { value: 4, writable: false, configurable: true });

                        let headerStr = '';
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
                        // Same last-resort fallback as fetch: open() already ran
                        // on the real XHR, so a native send() can still succeed
                        // (e.g. when only the IPC scope was the problem).
                        console.error('[Tauri Proxy] XHR proxy failed, falling back to native XHR:', error, 'URL:', xhrUrl);
                        try {
                            originalSend(body);
                        } catch (sendError) {
                            console.error('[Tauri Proxy] Native XHR fallback failed:', sendError, 'URL:', xhrUrl);
                            if (typeof xhr.onerror === 'function') {
                                xhr.onerror(new ProgressEvent('error'));
                            }
                            xhr.dispatchEvent(new ProgressEvent('error'));
                            xhr.dispatchEvent(new ProgressEvent('loadend'));
                        }
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

    // ── Badge + Notification bridge ──────────────────────────────────────────
    // WKWebView doesn't implement the Badging or Notification web APIs. Route
    // them to the native shell so a per-app window can badge its own dock icon
    // and post banners. No-ops gracefully if the native commands aren't present
    // (e.g. the in-process fallback window on non-macOS). Wrapped + gated on
    // `window.navigator` so injecting the script outside a real webview (e.g. a
    // bare `new Function('window', src)` harness) can't throw.
    try {
        const nav = window.navigator;
        if (nav) {
            nav.setAppBadge = function (count) {
                const inv = getTauriInvoke();
                if (!inv) return Promise.resolve();
                return Promise.resolve(inv('set_badge', { count: Number(count) || 0 })).catch(function () {});
            };
            nav.clearAppBadge = function () {
                const inv = getTauriInvoke();
                if (!inv) return Promise.resolve();
                return Promise.resolve(inv('set_badge', { count: 0 })).catch(function () {});
            };
        }
        const NativeNotification = function (title, options) {
            options = options || {};
            const inv = getTauriInvoke();
            if (inv) Promise.resolve(inv('notify', { title: String(title || ''), body: String(options.body || '') })).catch(function () {});
        };
        NativeNotification.permission = 'granted';
        NativeNotification.requestPermission = function (cb) {
            if (typeof cb === 'function') cb('granted');
            return Promise.resolve('granted');
        };
        Object.defineProperty(window, 'Notification', { value: NativeNotification, writable: true, configurable: true });
    } catch (e) {
        console.warn('[Tauri Proxy] Notification polyfill failed:', e);
    }

    checkTauriAPI();
})();
