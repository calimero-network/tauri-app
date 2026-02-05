import React, { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCw, Home, Bug } from "lucide-react";
import "./ErrorBoundary.css";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional fallback component to render when an error occurs */
  fallback?: ReactNode;
  /** Name of the component/section being wrapped (for error reporting) */
  componentName?: string;
  /** Callback when an error is caught */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Whether to show a minimal error UI (useful for smaller components) */
  minimal?: boolean;
  /** Custom reset handler - if not provided, will attempt to re-render children */
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * Error Boundary component that catches JavaScript errors anywhere in its child
 * component tree, logs those errors, and displays a fallback UI.
 * 
 * Features:
 * - Catches render errors in child components
 * - Displays user-friendly error UI with recovery options
 * - Reports errors to console (and optional callback)
 * - Supports minimal mode for smaller components
 * - Provides retry/reset functionality
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log error details for debugging
    const componentName = this.props.componentName || "Unknown Component";
    console.error(`[ErrorBoundary] Error in ${componentName}:`, error);
    console.error(`[ErrorBoundary] Component stack:`, errorInfo.componentStack);

    // Store error info for display
    this.setState({ errorInfo });

    // Report error to parent if callback provided
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }

    // Report to any error tracking service (placeholder for future integration)
    this.reportError(error, errorInfo);
  }

  /**
   * Report error to error tracking service
   * This is a placeholder for future integration with services like Sentry
   */
  private reportError(error: Error, errorInfo: ErrorInfo): void {
    // Log structured error data that could be sent to an error tracking service
    const errorReport = {
      timestamp: new Date().toISOString(),
      componentName: this.props.componentName || "Unknown",
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      componentStack: errorInfo.componentStack,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "N/A",
    };

    // Store in localStorage for debugging (limited to last 10 errors)
    try {
      const storedErrors = JSON.parse(
        localStorage.getItem("calimero-error-log") || "[]"
      );
      storedErrors.push(errorReport);
      // Keep only last 10 errors
      if (storedErrors.length > 10) {
        storedErrors.shift();
      }
      localStorage.setItem("calimero-error-log", JSON.stringify(storedErrors));
    } catch (e) {
      // Ignore localStorage errors
    }

    console.info("[ErrorBoundary] Error report:", errorReport);
  }

  /**
   * Reset the error boundary to try rendering children again
   */
  handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });

    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  /**
   * Reload the entire application
   */
  handleReload = (): void => {
    window.location.reload();
  };

  /**
   * Navigate to home (for use in standalone pages)
   */
  handleGoHome = (): void => {
    window.location.href = "/";
  };

  /**
   * Copy error details to clipboard for bug reporting
   */
  handleCopyError = async (): Promise<void> => {
    const { error, errorInfo } = this.state;
    const errorText = `
Error: ${error?.name || "Unknown"}
Message: ${error?.message || "No message"}
Component: ${this.props.componentName || "Unknown"}
Stack: ${error?.stack || "No stack trace"}
Component Stack: ${errorInfo?.componentStack || "No component stack"}
Time: ${new Date().toISOString()}
    `.trim();

    try {
      await navigator.clipboard.writeText(errorText);
      // Could show a toast here if toast context was available
      console.info("[ErrorBoundary] Error details copied to clipboard");
    } catch (e) {
      console.error("[ErrorBoundary] Failed to copy error details:", e);
    }
  };

  render(): ReactNode {
    const { hasError, error } = this.state;
    const { children, fallback, minimal, componentName } = this.props;

    if (hasError) {
      // If a custom fallback is provided, use it
      if (fallback) {
        return fallback;
      }

      // Minimal error UI for smaller components
      if (minimal) {
        return (
          <div className="error-boundary error-boundary-minimal">
            <AlertTriangle size={16} />
            <span>Something went wrong</span>
            <button
              onClick={this.handleReset}
              className="error-boundary-retry-small"
              title="Try again"
            >
              <RefreshCw size={14} />
            </button>
          </div>
        );
      }

      // Full error UI
      return (
        <div className="error-boundary error-boundary-full">
          <div className="error-boundary-content">
            <div className="error-boundary-icon">
              <AlertTriangle size={48} />
            </div>
            <h2 className="error-boundary-title">Something went wrong</h2>
            <p className="error-boundary-message">
              {componentName
                ? `An error occurred in ${componentName}.`
                : "An unexpected error occurred."}
            </p>
            {error && (
              <div className="error-boundary-details">
                <code>{error.message}</code>
              </div>
            )}
            <div className="error-boundary-actions">
              <button
                onClick={this.handleReset}
                className="button button-primary"
              >
                <RefreshCw size={16} />
                Try Again
              </button>
              <button
                onClick={this.handleReload}
                className="button button-secondary"
              >
                <Home size={16} />
                Reload App
              </button>
              <button
                onClick={this.handleCopyError}
                className="button button-secondary"
                title="Copy error details for bug report"
              >
                <Bug size={16} />
                Copy Error
              </button>
            </div>
            <p className="error-boundary-hint">
              If this problem persists, try restarting the application or check
              the Settings for configuration issues.
            </p>
          </div>
        </div>
      );
    }

    return children;
  }
}

/**
 * HOC to wrap a component with an error boundary
 */
export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  options: Omit<ErrorBoundaryProps, "children"> = {}
): React.FC<P> {
  const displayName =
    WrappedComponent.displayName || WrappedComponent.name || "Component";

  const WithErrorBoundary: React.FC<P> = (props) => (
    <ErrorBoundary componentName={displayName} {...options}>
      <WrappedComponent {...props} />
    </ErrorBoundary>
  );

  WithErrorBoundary.displayName = `withErrorBoundary(${displayName})`;
  return WithErrorBoundary;
}

/**
 * Hook-friendly error boundary wrapper component
 * Useful when you need to use hooks in error handling
 */
interface ErrorBoundaryWrapperProps {
  children: ReactNode;
  componentName?: string;
  onReset?: () => void;
}

export const ErrorBoundaryWrapper: React.FC<ErrorBoundaryWrapperProps> = ({
  children,
  componentName,
  onReset,
}) => {
  return (
    <ErrorBoundary componentName={componentName} onReset={onReset}>
      {children}
    </ErrorBoundary>
  );
};

export default ErrorBoundary;
