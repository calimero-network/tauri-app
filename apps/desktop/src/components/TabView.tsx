import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import "./TabView.css";

// Check if URL is external (not localhost/127.0.0.1)
const isExternalUrl = (url: string): boolean => {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    return !(
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('localhost:') ||
      hostname.startsWith('127.0.0.1:') ||
      hostname === '0.0.0.0' ||
      hostname.startsWith('0.0.0.0:')
    );
  } catch {
    return true; // If URL parsing fails, assume external
  }
};

// Check if URL is an auth login page (these can't be embedded in iframes due to X-Frame-Options)
const isAuthUrl = (url: string): boolean => {
  return url.includes('/auth/login') || url.includes('/auth/');
};

export interface Tab {
  id: string;
  title: string;
  url: string;
  windowLabel?: string;
}

interface TabViewProps {
  tabs: Tab[];
  activeTabId: string | null;
  onTabChange: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
}

export function TabView({ tabs, activeTabId, onTabChange, onTabClose }: TabViewProps) {
  const activeTab = tabs.find(t => t.id === activeTabId);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Debug: log tab info
  console.log('TabView render:', { tabs, activeTabId, activeTab });

  // For external URLs or auth URLs: Don't open window here - let InstalledApps handle it
  // We just show a message that these URLs need to open in separate windows
  // Auth URLs can't be embedded due to X-Frame-Options: DENY

  // If a tab has an auth URL, automatically open it in a new window
  useEffect(() => {
    if (activeTab && isAuthUrl(activeTab.url)) {
      const urlObj = new URL(activeTab.url);
      const domain = urlObj.hostname.replace(/\./g, '-');
      const windowLabel = `app-${domain}`;
      invoke('create_app_window', {
        windowLabel,
        url: activeTab.url,
        title: activeTab.title || 'Authentication',
      }).catch((error: unknown) => {
        console.error('Failed to open auth URL in new window:', error);
      });
    }
  }, [activeTab]);

  // Monitor iframe for auth URL navigation attempts
  // Since we can't intercept cross-origin navigation, we'll detect it via error handling
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !activeTab || isExternalUrl(activeTab.url) || isAuthUrl(activeTab.url)) return;

    // Set up a message listener to catch postMessage from the iframe
    // The injected script will postMessage when it detects an auth redirect
    const messageHandler = (event: MessageEvent) => {
      // Only handle messages from our iframe
      if (event.source !== iframe.contentWindow) return;
      
      if (event.data && event.data.type === 'AUTH_REDIRECT_DETECTED') {
        const authUrl = event.data.url;
        console.log('[TabView] Received auth redirect notification from iframe:', authUrl);
        const urlObj = new URL(authUrl);
        const domain = urlObj.hostname.replace(/\./g, '-');
        const windowLabel = `app-${domain}`;
        invoke('create_app_window', {
          windowLabel,
          url: authUrl,
          title: 'Authentication',
        }).catch((error: unknown) => {
          console.error('Failed to open auth URL in new window:', error);
        });
      }
    };

    window.addEventListener('message', messageHandler);
    
    return () => {
      window.removeEventListener('message', messageHandler);
    };
  }, [activeTab, activeTabId]);

  // For localhost URLs (non-auth): Inject fetch proxy script into iframe
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !activeTab || isExternalUrl(activeTab.url) || isAuthUrl(activeTab.url)) return;

    const handleLoad = () => {
      console.log('Iframe loaded successfully:', activeTab.url);
      
      // Try to inject fetch interceptor into iframe
      // This only works for same-origin content, but we try anyway
      try {
        const iframeWindow = iframe.contentWindow;
        if (iframeWindow) {
          // Create a script that intercepts fetch and proxies localhost requests
          const script = `
            (function() {
              if (window.__TAURI_FETCH_PROXY_INJECTED__) return;
              window.__TAURI_FETCH_PROXY_INJECTED__ = true;
              
              // Intercept window.location changes to detect auth URL redirects
              const isAuthUrl = (url) => {
                try {
                  return url.includes('/auth/login') || url.includes('/auth/') || new URL(url).pathname.startsWith('/auth/');
                } catch {
                  return false;
                }
              };
              
              // Intercept window.location.href assignments
              try {
                const originalLocationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
                if (originalLocationDescriptor && originalLocationDescriptor.set) {
                  Object.defineProperty(window, 'location', {
                    set: function(value) {
                      if (isAuthUrl(value)) {
                        console.log('[Tab Proxy] Detected auth URL redirect via location.href, notifying parent:', value);
                        // Notify parent via postMessage (works cross-origin)
                        if (window.parent) {
                          window.parent.postMessage({
                            type: 'AUTH_REDIRECT_DETECTED',
                            url: value
                          }, '*');
                        }
                        // Don't navigate in iframe - parent will open new window
                        return;
                      }
                      // For non-auth URLs, use original behavior
                      originalLocationDescriptor.set.call(window, value);
                    },
                    get: function() {
                      return window.location;
                    },
                    configurable: true
                  });
                }
              } catch (e) {
                console.warn('[Tab Proxy] Could not intercept window.location (may be non-configurable):', e);
              }
              
              // Also intercept window.location.replace and window.location.assign
              const originalReplace = window.location.replace;
              window.location.replace = function(url) {
                if (isAuthUrl(url)) {
                  console.log('[Tab Proxy] Detected auth URL in replace(), notifying parent:', url);
                  if (window.parent) {
                    window.parent.postMessage({
                      type: 'AUTH_REDIRECT_DETECTED',
                      url: url
                    }, '*');
                    return; // Don't navigate
                  }
                }
                originalReplace.call(window.location, url);
              };
              
              const originalAssign = window.location.assign;
              window.location.assign = function(url) {
                if (isAuthUrl(url)) {
                  console.log('[Tab Proxy] Detected auth URL in assign(), notifying parent:', url);
                  if (window.parent) {
                    window.parent.postMessage({
                      type: 'AUTH_REDIRECT_DETECTED',
                      url: url
                    }, '*');
                    return; // Don't navigate
                  }
                }
                originalAssign.call(window.location, url);
              };
              
              const originalFetch = window.fetch;
              window.fetch = async function(url, init) {
                const urlStr = typeof url === 'string' ? url : url.url || url.toString();
                
                // Only proxy HTTP localhost requests (mixed content issue)
                if (urlStr.startsWith('http://localhost:') || urlStr.startsWith('http://127.0.0.1:')) {
                  try {
                    console.log('[Tab Proxy] Intercepting localhost request:', urlStr);
                    
                    // Use parent window's Tauri invoke (tabs are in main window)
                    // The parent window has Tauri API access
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
                      } else {
                        bodyStr = await new Response(init.body).text();
                      }
                    }
                    
                    // Call parent window's Tauri API
                    const response = await window.parent.__TAURI_INVOKE__('proxy_http_request', {
                      request: {
                        url: urlStr,
                        method: (init && init.method) || 'GET',
                        headers: Object.keys(headers).length > 0 ? headers : null,
                        body: bodyStr
                      }
                    });
                    
                    console.log('[Tab Proxy] Proxied request successful:', urlStr, 'Status:', response.status);
                    
                    return new Response(response.body, {
                      status: response.status,
                      statusText: response.status === 200 ? 'OK' : 'Error',
                      headers: new Headers(response.headers)
                    });
                  } catch (error) {
                    console.error('[Tab Proxy] Failed to proxy request:', error);
                    // Fallback to original fetch (will fail due to mixed content, but at least we tried)
                    return originalFetch.apply(this, arguments);
                  }
                }
                
                // For non-localhost requests, use original fetch
                return originalFetch.apply(this, arguments);
              };
              
              console.log('[Tab Proxy] Fetch and location interceptors injected successfully');
            })();
          `;
          
          try {
            // Try to inject script - this will fail for cross-origin, but we try anyway
            // Use type assertion since eval exists on Window but TypeScript doesn't know
            (iframeWindow as any).eval(script);
            console.log('[Tab Proxy] Script injected into iframe');
          } catch (e) {
            // Cross-origin - can't inject directly
            // For cross-origin iframes, the external site needs to call window.parent.__TAURI_INVOKE__ directly
            // We'll set up a message listener as a fallback, but the site should use parent API directly
            console.log('[Tab Proxy] Cannot inject script (cross-origin). External site should use window.parent.__TAURI_INVOKE__');
            
            // Set up message listener for postMessage-based proxy (if external site supports it)
            const messageHandler = (event: MessageEvent) => {
              // Only handle messages from our iframe
              if (event.source !== iframeWindow) return;
              
              if (event.data && event.data.type === 'TAURI_PROXY_REQUEST') {
                // Proxy the request through Tauri
                const { url, method, headers, body } = event.data.request;
                if (url && (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:'))) {
                  // Use window.__TAURI_INVOKE__ from parent (main window)
                  (window as any).__TAURI_INVOKE__('proxy_http_request', {
                    request: { url, method, headers, body }
                  }).then((response: any) => {
                    // Send response back to iframe
                    iframeWindow.postMessage({
                      type: 'TAURI_PROXY_RESPONSE',
                      requestId: event.data.requestId,
                      response
                    }, '*');
                  }).catch((error: any) => {
                    iframeWindow.postMessage({
                      type: 'TAURI_PROXY_RESPONSE',
                      requestId: event.data.requestId,
                      error: error.message
                    }, '*');
                  });
                }
              }
            };
            
            window.addEventListener('message', messageHandler);
            
            // Cleanup message listener
            const cleanup = () => {
              window.removeEventListener('message', messageHandler);
            };
            
            // Return cleanup function
            return cleanup;
          }
        }
      } catch (e) {
        // Cross-origin access denied - expected for external URLs
        console.log('[Tab Proxy] Cross-origin iframe, cannot access contentWindow (expected)');
      }
    };

    const handleError = (event: Event) => {
      console.error('Iframe load error for:', activeTab.url, event);
      
      // When X-Frame-Options blocks an iframe, we can't access the src due to cross-origin
      // But we can try to detect if this is an auth URL error by checking the console message
      // or by attempting to open the auth URL that the app would redirect to
      
      // Since we know kv-store redirects to auth, let's check if the original URL
      // would lead to an auth redirect and open auth in a new window proactively
      // This is a workaround - ideally the app would handle this, but we can't modify it
      
      // Try to detect auth URL from error - if we can't, we'll rely on the navigation check
      console.log('[TabView] Iframe failed to load - may be X-Frame-Options blocking auth URL');
    };

    // Also listen for navigation attempts - if iframe navigates to auth URL, open in new window
    // Note: This only works for same-origin navigation. Cross-origin navigation can't be detected.
    const handleNavigation = () => {
      try {
        const currentSrc = iframe.src;
        if (isAuthUrl(currentSrc) && currentSrc !== activeTab.url) {
          console.log('[TabView] Iframe navigated to auth URL, opening in new window:', currentSrc);
          const urlObj = new URL(currentSrc);
          const domain = urlObj.hostname.replace(/\./g, '-');
          const windowLabel = `app-${domain}`;
          invoke('create_app_window', {
            windowLabel,
            url: currentSrc,
            title: 'Authentication',
          }).catch((error: unknown) => {
            console.error('Failed to open auth URL in new window:', error);
          });
        }
      } catch (e) {
        // Can't access iframe src (cross-origin) - this is expected when iframe navigates to different origin
        // The X-Frame-Options error will occur, and we can't intercept it reliably
      }
    };

    iframe.addEventListener('load', handleLoad);
    iframe.addEventListener('error', handleError);
    
    // Poll for navigation changes (since we can't reliably detect cross-origin navigation)
    const navigationCheckInterval = setInterval(() => {
      handleNavigation();
    }, 500);

    // Return cleanup function
    return () => {
      iframe.removeEventListener('load', handleLoad);
      iframe.removeEventListener('error', handleError);
      clearInterval(navigationCheckInterval);
    };
  }, [activeTab, activeTabId]);


  return (
    <div className="tab-view">
      <div className="tab-bar">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            <span className="tab-title">{tab.title}</span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="tab-content">
        {activeTab ? (
          isExternalUrl(activeTab.url) || isAuthUrl(activeTab.url) ? (
            // External URLs or Auth URLs: Show message (they should open in separate windows)
            // Auth URLs can't be embedded due to X-Frame-Options: DENY
            <div className="external-url-handler">
              <div className="external-url-message">
                <p>{isAuthUrl(activeTab.url) ? 'Auth URLs' : 'External URLs'} open in separate windows</p>
                <p className="url">{activeTab.url}</p>
                <p className="hint">
                  {isAuthUrl(activeTab.url) 
                    ? 'This auth page cannot be embedded in an iframe due to security restrictions (X-Frame-Options). It should open in a new window automatically.'
                    : 'This URL should have opened in a new window automatically.'}
                </p>
              </div>
            </div>
          ) : (
            // Localhost URLs (non-auth): Use iframe (no cross-origin issues)
            // Note: If this iframe navigates to an auth URL, it will be detected and opened in a new window
            <iframe
              ref={iframeRef}
              src={activeTab.url}
              className="tab-iframe"
              title={activeTab.title}
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-top-navigation allow-downloads"
              allow="fullscreen"
              style={{ width: '100%', height: '100%', border: 'none' }}
              allowFullScreen
              onError={() => {
                // If iframe fails to load, it might be due to X-Frame-Options blocking an auth URL
                // We can't access the src due to cross-origin, but we can try to open auth URL
                // based on the pattern we know (localhost:2528/auth/login)
                console.log('[TabView] Iframe error - may be X-Frame-Options blocking');
                // The postMessage handler will handle detecting auth URLs from injected script
              }}
            />
          )
        ) : (
          <div className="no-tab">
            <p>No tab selected</p>
          </div>
        )}
      </div>
    </div>
  );
}

