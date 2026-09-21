import { createContext, useContext, useState, useCallback, useMemo, ReactNode } from 'react';

type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number; // Auto-dismiss duration in ms (default: 5000)
}

interface ToastActions {
  removeToast: (id: string) => void;
  // Each returns the new toast's id. They always did at runtime; the type said
  // `void`, so a caller could not hold a long-running toast open and dismiss it
  // when the work finished — which is exactly what progress needs.
  success: (message: string, duration?: number) => string;
  error: (message: string, duration?: number) => string;
  warning: (message: string, duration?: number) => string;
  /**
   * `duration: 0` never auto-dismisses. Pair it with the returned id and
   * `removeToast` for work whose length is not known in advance, such as
   * installing an app from the registry.
   */
  info: (message: string, duration?: number) => string;
}

// Split so firing a toast only re-renders the container, not every page that
// holds a useToast() handle.
const ToastActionsContext = createContext<ToastActions | undefined>(undefined);
const ToastStateContext = createContext<Toast[] | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((type: ToastType, message: string, duration = 5000) => {
    const id = crypto.randomUUID();
    const newToast: Toast = { id, type, message, duration };

    setToasts((prev) => [...prev, newToast]);

    // Auto-dismiss if duration is set
    if (duration > 0) {
      setTimeout(() => {
        removeToast(id);
      }, duration);
    }

    return id;
  }, [removeToast]);

  const success = useCallback((message: string, duration?: number) => {
    return showToast('success', message, duration);
  }, [showToast]);

  const error = useCallback((message: string, duration?: number) => {
    return showToast('error', message, duration);
  }, [showToast]);

  const warning = useCallback((message: string, duration?: number) => {
    return showToast('warning', message, duration);
  }, [showToast]);

  const info = useCallback((message: string, duration?: number) => {
    return showToast('info', message, duration);
  }, [showToast]);

  // Every callback above is identity-stable, so this value never changes.
  const actions = useMemo<ToastActions>(
    () => ({ removeToast, success, error, warning, info }),
    [removeToast, success, error, warning, info]
  );

  return (
    <ToastActionsContext.Provider value={actions}>
      <ToastStateContext.Provider value={toasts}>
        {children}
      </ToastStateContext.Provider>
    </ToastActionsContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastActionsContext);
  if (context === undefined) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

export function useToastState() {
  const context = useContext(ToastStateContext);
  if (context === undefined) {
    throw new Error('useToastState must be used within a ToastProvider');
  }
  return context;
}
