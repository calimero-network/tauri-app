const ONBOARDING_PROGRESS_KEY = 'calimero-onboarding-progress';

export type OnboardingStep = 'welcome' | 'what-is' | 'node-setup' | 'cloud-connect' | 'login' | 'install-app';

export interface OnboardingProgress {
  currentStep: OnboardingStep;
  dataDir: string;
  nodeName: string;
  serverPort: number;
  swarmPort: number;
  nodeSetupMode: 'choose' | 'use-existing' | 'create-new';
  useExistingNode: string | null;
  nodeCreated?: boolean;
  nodeStarted?: boolean;
  savedAt: number;
}

const DEFAULT_PROGRESS: Omit<OnboardingProgress, 'savedAt'> = {
  currentStep: 'welcome',
  dataDir: '~/.calimero',
  nodeName: 'default',
  serverPort: 2528,
  swarmPort: 2428,
  nodeSetupMode: 'choose',
  useExistingNode: null,
};

/** Avoid spreading explicit `undefined` into merged state (breaks React controlled inputs). */
function omitUndefined<T extends Record<string, unknown>>(obj: Partial<T>): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

export function saveOnboardingProgress(progress: Partial<OnboardingProgress>): void {
  try {
    const existing = loadOnboardingProgress();
    const merged: OnboardingProgress = {
      ...(existing || DEFAULT_PROGRESS),
      ...omitUndefined(progress as Record<string, unknown>),
      savedAt: Date.now(),
    };
    localStorage.setItem(ONBOARDING_PROGRESS_KEY, JSON.stringify(merged));
  } catch (err) {
    console.warn('Failed to save onboarding progress:', err);
  }
}

export function loadOnboardingProgress(): OnboardingProgress | null {
  try {
    const stored = localStorage.getItem(ONBOARDING_PROGRESS_KEY);
    if (!stored) return null;

    const parsed = JSON.parse(stored) as Partial<OnboardingProgress>;
    // Expire after 7 days
    if (Date.now() - (parsed.savedAt || 0) > 7 * 24 * 60 * 60 * 1000) {
      clearOnboardingProgress();
      return null;
    }
    const normalized: OnboardingProgress = {
      ...DEFAULT_PROGRESS,
      ...omitUndefined(parsed as Record<string, unknown>),
      savedAt: parsed.savedAt ?? Date.now(),
    } as OnboardingProgress;
    return normalized;
  } catch {
    return null;
  }
}

export function clearOnboardingProgress(): void {
  try {
    localStorage.removeItem(ONBOARDING_PROGRESS_KEY);
  } catch (err) {
    console.warn('Failed to clear onboarding progress:', err);
  }
}
