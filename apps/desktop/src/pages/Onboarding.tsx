import { useState, useEffect, useRef } from "react";
import { checkOnboardingState, getOnboardingMessage, type OnboardingState } from "../utils/onboarding";
import { apiClient, setAccessToken, setRefreshToken } from "@calimero-network/mero-react";
import { HTTPError } from "@calimero-network/mero-js";
import { initMerodNode, startMerod, listMerodNodes, detectRunningMerodNodes, waitForNodeHealthy } from "../utils/merod";
import { invoke } from "@tauri-apps/api/tauri";
import { saveSettings, getSettings } from "../utils/settings";
import { saveOnboardingProgress, loadOnboardingProgress } from "../utils/onboardingProgress";
import { fetchAppsFromAllRegistries, fetchAppManifest, type AppSummary } from "../utils/registry";
import { useToast } from "../contexts/ToastContext";
import { useTheme } from "../contexts/ThemeContext";
import { ArrowLeft, ArrowRight, Check, Package, Download, CheckCircle2, ChevronDown, ChevronUp, Search, AlertTriangle } from "lucide-react";
import { ScrollHint } from "../components/ScrollHint";
import calimeroLogo from "../assets/calimero-logo.svg";
import bs58 from "bs58";
import "./Onboarding.css";

interface OnboardingProps {
  onComplete: () => void;
  onSettings?: () => void;
}

type OnboardingStep = 'welcome' | 'what-is' | 'node-setup' | 'login' | 'install-app';

const ONBOARDING_STEPS: OnboardingStep[] = ['welcome', 'what-is', 'node-setup', 'login', 'install-app'];

interface UsernamePasswordFormProps {
  onSuccess: () => void;
  onError: (error: Error) => void;
  loading: boolean;
}

// Username validation: alphanumeric + underscore only, no spaces
const USERNAME_REGEX = /^[a-zA-Z0-9_]+$/;
const MIN_PASSWORD_LENGTH = 8;

function validateUsername(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Username is required';
  if (value !== trimmed) return 'Username cannot contain leading or trailing spaces';
  if (/\s/.test(value)) return 'Username cannot contain spaces';
  if (!USERNAME_REGEX.test(trimmed)) return 'Username can only contain letters, numbers, and underscores';
  return null;
}

function validatePassword(value: string): string | null {
  if (!value) return 'Password is required';
  if (value.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  return null;
}

// Username/Password Form Component - defined outside to prevent re-creation on each render
const UsernamePasswordForm: React.FC<UsernamePasswordFormProps> = ({ onSuccess, onError, loading: parentLoading }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setUsernameError(null);
    setPasswordError(null);

    const userErr = validateUsername(username);
    const passErr = validatePassword(password);
    if (userErr) {
      setUsernameError(userErr);
      return;
    }
    if (passErr) {
      setPasswordError(passErr);
      return;
    }

    const trimmedUsername = username.trim();

    try {
      setLoading(true);

      const tokenPayload = {
        auth_method: 'user_password',
        public_key: trimmedUsername, // Use username as public key for user_password provider
        client_name: 'calimero-desktop',
        timestamp: Date.now(),
        permissions: [],
        provider_data: {
          username: trimmedUsername,
          password: password
        }
      };

      // apiClient.auth is already an instance, not a function
      const tokenResponse = await apiClient.auth.requestToken(tokenPayload);

      if (tokenResponse.error) {
        setError(tokenResponse.error.message || 'Authentication failed');
        onError(new Error(tokenResponse.error.message || 'Authentication failed'));
        return;
      }

      if (tokenResponse.data?.access_token && tokenResponse.data?.refresh_token) {
        setAccessToken(tokenResponse.data.access_token);
        setRefreshToken(tokenResponse.data.refresh_token);
        onSuccess();
      } else {
        throw new Error('Failed to get access token');
      }
    } catch (err) {
      console.error('Authentication error:', err);
      let errorMessage: string;
      if (err instanceof HTTPError && err.status === 0) {
        errorMessage = 'Node is not responding. It may have crashed—check the logs.';
      } else {
        errorMessage = err instanceof Error ? err.message : 'Authentication failed';
      }
      setError(errorMessage);
      onError(err instanceof Error ? err : new Error(errorMessage));
    } finally {
      setLoading(false);
    }
  };

  const isLoading = loading || parentLoading;

  const isValid = !validateUsername(username) && !validatePassword(password);

  return (
    <form onSubmit={handleSubmit} className="username-password-form">
      <div className="form-group">
        <label htmlFor="username">Username</label>
        <input
          id="username"
          type="text"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            setUsernameError(null);
          }}
          onBlur={() => setUsernameError(validateUsername(username))}
          placeholder="Letters, numbers, underscores only"
          disabled={isLoading}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck="false"
          required
          aria-invalid={!!usernameError}
          aria-describedby={usernameError ? 'username-error' : undefined}
        />
        {usernameError && (
          <p id="username-error" className="field-error">{usernameError}</p>
        )}
      </div>

      <div className="form-group">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setPasswordError(null);
          }}
          onBlur={() => setPasswordError(validatePassword(password))}
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          disabled={isLoading}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck="false"
          required
          aria-invalid={!!passwordError}
          aria-describedby={passwordError ? 'password-error' : undefined}
        />
        {passwordError && (
          <p id="password-error" className="field-error">{passwordError}</p>
        )}
      </div>

      {error && (
        <div className="form-error">
          {error}
        </div>
      )}

      <div className="form-actions">
        <button
          type="submit"
          className="button button-primary"
          disabled={isLoading || !isValid}
        >
          {isLoading ? 'Signing In...' : 'Sign In'}
        </button>
      </div>
    </form>
  );
};

export default function Onboarding({ onComplete, onSettings }: OnboardingProps) {
  const toast = useToast();
  const { setTheme } = useTheme();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentStep, setCurrentStep] = useState<OnboardingStep>(() => {
    const saved = loadOnboardingProgress();
    return saved?.currentStep ?? 'welcome';
  });

  // Force dark mode during onboarding - override any theme changes
  useEffect(() => {
    // Set dark mode explicitly using theme context
    setTheme('dark');
    
    const forceDarkMode = () => {
      document.documentElement.setAttribute('data-theme', 'dark');
    };
    
    // Set immediately
    forceDarkMode();
    
    // Also set on any theme changes to ensure it stays dark
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          const currentTheme = document.documentElement.getAttribute('data-theme');
          if (currentTheme !== 'dark') {
            forceDarkMode();
          }
        }
      });
    });
    
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
    
    return () => {
      observer.disconnect();
    };
  }, [setTheme]);
  
  // App installation state
  const [allApps, setAllApps] = useState<AppSummary[]>([]);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);
  const [installingAppId, setInstallingAppId] = useState<string | null>(null);
  const [installedAppIds, setInstalledAppIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");

  // Node setup state - restore from saved progress if available
  const [dataDir, setDataDir] = useState(() => loadOnboardingProgress()?.dataDir ?? "~/.calimero");
  const [nodeName, setNodeName] = useState(() => loadOnboardingProgress()?.nodeName ?? "default");
  const [serverPort, setServerPort] = useState(() => loadOnboardingProgress()?.serverPort ?? 2528);
  const [swarmPort, setSwarmPort] = useState(() => loadOnboardingProgress()?.swarmPort ?? 2428);
      const [creatingNode, setCreatingNode] = useState(false);
      const [nodeError, setNodeError] = useState<string | null>(null);
      const [nodeCreated, setNodeCreated] = useState(false);
      const [nodeStarted, setNodeStarted] = useState(false);
      const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
      const [loginLoading, setLoginLoading] = useState(false);
  const [existingNodes, setExistingNodes] = useState<string[]>([]);
  const [useExistingNode, setUseExistingNode] = useState<string | null>(() => loadOnboardingProgress()?.useExistingNode ?? null);
  const [loadingExistingNodes, setLoadingExistingNodes] = useState(false);
  // 'choose' = show path selection, 'use-existing' = minimal form, 'create-new' = full form
  const [nodeSetupMode, setNodeSetupMode] = useState<'choose' | 'use-existing' | 'create-new'>(() => loadOnboardingProgress()?.nodeSetupMode ?? 'choose');
  const stepContainerRef = useRef<HTMLDivElement>(null);
  const hasAttemptedAutoContinue = useRef(false);

  useEffect(() => {
    async function loadState() {
      setLoading(true);
      try {
      const onboardingState = await checkOnboardingState();
      setState(onboardingState);
      } catch (error) {
        // If we can't check state (no node), that's okay - we'll start with welcome
      }
      setLoading(false);
    }
    loadState();
  }, []);

  // Persist onboarding progress so user can resume after accidental close
  useEffect(() => {
    saveOnboardingProgress({
      currentStep,
      dataDir,
      nodeName,
      serverPort,
      swarmPort,
      nodeSetupMode,
      useExistingNode,
      nodeCreated,
      nodeStarted,
    });
  }, [currentStep, dataDir, nodeName, serverPort, swarmPort, nodeSetupMode, useExistingNode, nodeCreated, nodeStarted]);

  // Load existing nodes when on node-setup step - auto-continue if found (skip auth)
  const prevDataDirRef = useRef(dataDir);
  useEffect(() => {
    if (currentStep !== 'node-setup') {
      hasAttemptedAutoContinue.current = false;
      return;
    }
    // Reset when dataDir changes so we retry for the new directory
    if (prevDataDirRef.current !== dataDir) {
      prevDataDirRef.current = dataDir;
      hasAttemptedAutoContinue.current = false;
    }
    if (creatingNode || nodeCreated || hasAttemptedAutoContinue.current) return;

    async function loadAndContinueIfExisting() {
      setLoadingExistingNodes(true);
      try {
        const nodes = await listMerodNodes(dataDir);
        setExistingNodes(nodes);
        
        if (nodes.length > 0) {
          hasAttemptedAutoContinue.current = true;
          const nodeToUse = nodes[0];
          setUseExistingNode(nodeToUse);
          setCreatingNode(true);
          try {
            const running = await detectRunningMerodNodes();
            const alreadyRunning = running.find(n => n.node_name === nodeToUse);
            
            if (alreadyRunning) {
              saveSettings({
                ...getSettings(),
                nodeUrl: `http://localhost:${alreadyRunning.port}`,
                useEmbeddedNode: true,
                embeddedNodeDataDir: dataDir,
                embeddedNodeName: nodeToUse,
                embeddedNodePort: alreadyRunning.port,
              });
            } else {
              await startMerod(serverPort, swarmPort, dataDir, nodeToUse, getSettings().debugLogs);
              saveSettings({
                ...getSettings(),
                nodeUrl: `http://localhost:${serverPort}`,
                useEmbeddedNode: true,
                embeddedNodeDataDir: dataDir,
                embeddedNodeName: nodeToUse,
                embeddedNodePort: serverPort,
              });
            }
            setTheme('dark');
            onComplete();
            return;
          } catch (err) {
            console.error('Failed to use existing node:', err);
            setNodeError(err instanceof Error ? err.message : 'Failed to start node');
            setNodeSetupMode('choose');
          }
          setCreatingNode(false);
          setLoadingExistingNodes(false);
        } else {
          setNodeSetupMode('create-new');
          setLoadingExistingNodes(false);
        }
      } catch (e) {
        console.warn('Could not list existing nodes:', e);
        setExistingNodes([]);
        setNodeSetupMode('create-new');
        setLoadingExistingNodes(false);
      }
    }
    loadAndContinueIfExisting();
  }, [currentStep, dataDir, creatingNode, nodeCreated, onComplete, setTheme, serverPort, swarmPort]);

  // Disable autocomplete and autocapitalize on login form inputs
  useEffect(() => {
    if (currentStep === 'login') {
      const disableAutocomplete = () => {
        const inputs = document.querySelectorAll('.onboarding-card input');
        inputs.forEach((input) => {
          const htmlInput = input as HTMLInputElement;
          htmlInput.setAttribute('autocomplete', 'off');
          htmlInput.setAttribute('autocapitalize', 'none');
          htmlInput.setAttribute('autocorrect', 'off');
          htmlInput.setAttribute('spellcheck', 'false');
        });
      };

      // Run immediately and also after a short delay to catch dynamically added inputs
      disableAutocomplete();
      const timeout = setTimeout(disableAutocomplete, 100);
      const interval = setInterval(disableAutocomplete, 500);

      return () => {
        clearTimeout(timeout);
        clearInterval(interval);
      };
    }
  }, [currentStep]);

  const handlePickDataDir = async () => {
    try {
      const result = await invoke<string | null>('pick_directory', { 
        defaultPath: dataDir || undefined 
      });
      if (result) {
        setDataDir(result);
      }
    } catch (error) {
      console.error("Failed to pick directory:", error);
      setNodeError("Failed to pick directory");
    }
  };

  const handleCreateNode = async () => {
    const targetNodeName = useExistingNode || nodeName.trim();
    if (!targetNodeName) {
      setNodeError(useExistingNode ? "Please select a node" : "Please enter a node name");
      return;
    }

    setCreatingNode(true);
    setNodeError(null);
    
    try {
      const advanceToLogin = () => {
        setTimeout(async () => {
          try {
            const onboardingState = await checkOnboardingState();
            setState(onboardingState);
            setCurrentStep('login');
          } catch (err) {
            console.error("Failed to check onboarding state:", err);
            setCurrentStep('login');
          }
        }, 2000);
      };

      if (useExistingNode) {
        // Using existing node - check if already running
        const running = await detectRunningMerodNodes();
        const alreadyRunning = running.find(n => n.node_name === useExistingNode);
        
        if (alreadyRunning) {
          setNodeCreated(true);
          setNodeStarted(true);
          const nodeUrl = `http://localhost:${alreadyRunning.port}`;
          saveSettings({
            ...getSettings(),
            nodeUrl,
            useEmbeddedNode: true,
            embeddedNodeDataDir: dataDir,
            embeddedNodeName: useExistingNode,
            embeddedNodePort: alreadyRunning.port,
          });
          await waitForNodeHealthy(nodeUrl, 5000);
          advanceToLogin();
          return;
        }
        
        // Start the existing node
        await startMerod(serverPort, swarmPort, dataDir, useExistingNode, getSettings().debugLogs);
        setNodeCreated(true);
        setNodeStarted(true);
        const nodeUrl = `http://localhost:${serverPort}`;
        saveSettings({
          ...getSettings(),
          nodeUrl,
          useEmbeddedNode: true,
          embeddedNodeDataDir: dataDir,
          embeddedNodeName: useExistingNode,
          embeddedNodePort: serverPort,
        });
        await waitForNodeHealthy(nodeUrl, 20000);
        advanceToLogin();
      } else {
        // Create new node
        try {
          await initMerodNode(targetNodeName, dataDir);
        } catch (initError: any) {
          const msg = initError?.message || initError?.toString() || "";
          if (msg.toLowerCase().includes("exist") || msg.toLowerCase().includes("already")) {
            setNodeError(`Node "${targetNodeName}" already exists. Choose "Use existing node" above or pick a different name.`);
          } else {
            throw initError;
          }
          setCreatingNode(false);
          return;
        }
        
        await startMerod(serverPort, swarmPort, dataDir, targetNodeName, getSettings().debugLogs);
        setNodeCreated(true);
        setNodeStarted(true);
        const nodeUrl = `http://localhost:${serverPort}`;
        saveSettings({
          ...getSettings(),
          nodeUrl,
          useEmbeddedNode: true,
          embeddedNodeDataDir: dataDir,
          embeddedNodeName: targetNodeName,
          embeddedNodePort: serverPort,
        });
        await waitForNodeHealthy(nodeUrl, 20000);
        advanceToLogin();
      }
    } catch (error: any) {
      console.error("Failed to create/start node:", error);
      const errorMessage = error?.message || error?.toString() || "Failed to create node";
      setNodeError(errorMessage);
      setCreatingNode(false);
      setNodeCreated(false);
      setNodeStarted(false);
      toast.error(`Failed to create node: ${errorMessage}`);
    }
  };

  // Load apps for installation step
  const loadApps = async () => {
    setLoadingApps(true);
    try {
      const settings = getSettings();
      const registries = settings.registries || [];
      
      if (registries.length === 0) {
        console.warn("No registries configured");
        setLoadingApps(false);
        return;
      }

      const results = await fetchAppsFromAllRegistries(registries);
      const fetchedApps: AppSummary[] = [];
      results.forEach(({ apps: registryApps }) => {
        registryApps.forEach(app => {
          fetchedApps.push(app);
        });
      });
      
      setAllApps(fetchedApps);
      setApps(fetchedApps.slice(0, 4)); // Show first 4 apps by default
      
      // Load installed apps
      try {
        const response = await apiClient.node.listApplications();
        if (response.data) {
          const installed = new Set<string>(
            (Array.isArray(response.data) ? response.data : []).map((app: any) => app.id as string)
          );
          setInstalledAppIds(installed);
        }
      } catch (err) {
        console.error("Failed to load installed apps:", err);
      }
    } catch (error) {
      console.error("Failed to load apps:", error);
    } finally {
      setLoadingApps(false);
    }
  };

  // Install app handler
  const handleInstallApp = async (app: AppSummary, registry: string) => {
    setInstallingAppId(app.id);
    try {
      const manifest = await fetchAppManifest(registry, app.id, app.latest_version);
      
      let wasmUrl: string;
      let wasmHashHex: string | null = null;
      
      if (manifest.artifact) {
        if (!manifest.artifact.uri) {
          toast.error("Invalid manifest: artifact URI is missing");
          return;
        }
        wasmUrl = manifest.artifact.uri;
        wasmHashHex = manifest.artifact.digest?.replace('sha256:', '') || null;
      } else if (manifest.artifacts && manifest.artifacts.length > 0) {
        const mpkArtifact = manifest.artifacts.find(a => a.type === 'mpk');
        const wasmArtifact = manifest.artifacts.find(a => a.type === 'wasm');
        
        if (mpkArtifact) {
          wasmUrl = mpkArtifact.mirrors?.[0] || `https://ipfs.io/ipfs/${mpkArtifact.cid}`;
          wasmHashHex = mpkArtifact.sha256?.replace('sha256:', '') || null;
        } else if (wasmArtifact) {
          wasmUrl = wasmArtifact.mirrors?.[0] || `https://ipfs.io/ipfs/${wasmArtifact.cid}`;
          wasmHashHex = wasmArtifact.sha256?.replace('sha256:', '') || null;
        } else {
          toast.error("No MPK or WASM artifact found");
          return;
        }
      } else {
        toast.error("No artifacts found in manifest");
        return;
      }
      
      let wasmHashBase58: string | undefined = undefined;
      if (wasmHashHex && wasmHashHex.length === 64) {
        try {
          const hashBytes = Uint8Array.from(
            wasmHashHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
          );
          wasmHashBase58 = bs58.encode(hashBytes);
        } catch (error) {
          console.warn("Failed to convert hash to base58:", error);
        }
      }
      
      const metadata = {
        name: app.name,
        description: manifest.metadata?.description || "",
        version: app.latest_version,
        developer: app.developer_pubkey,
      };
      const metadataJson = JSON.stringify(metadata);
      const metadataBytes = Array.from(new TextEncoder().encode(metadataJson));

      const request: any = {
        url: wasmUrl,
        metadata: wasmUrl.endsWith('.mpk') ? [] : metadataBytes,
      };
      if (wasmHashBase58 && !wasmUrl.endsWith('.mpk')) {
        request.hash = wasmHashBase58;
      }

      const installResponse = await apiClient.node.installApplication(request);
      if (installResponse.error) {
        throw new Error(installResponse.error.message);
      }

      toast.success(`Successfully installed ${app.name}!`);
      setInstalledAppIds(new Set([...installedAppIds, app.id]));
      
      // Ensure dark mode is saved before completing onboarding
      setTheme('dark');
      
      // Go directly to dashboard after successful installation
      setTimeout(() => {
        onComplete();
      }, 1000);
    } catch (error: any) {
      console.error("Failed to install app:", error);
      toast.error(`Failed to install app: ${error.message || error}`);
    } finally {
      setInstallingAppId(null);
    }
  };

  // Get current step index for progress
  const currentStepIndex = ONBOARDING_STEPS.indexOf(currentStep);
  const progress = ((currentStepIndex + 1) / ONBOARDING_STEPS.length) * 100;

  // If loading and we have a step other than welcome/node-setup, show loading
  if (loading && !['welcome', 'what-is', 'node-setup'].includes(currentStep)) {
    return (
      <div className="onboarding-page">
        <div className="onboarding-content">
          <div className="loading-spinner">
            <div className="spinner"></div>
            <p>Setting up Calimero Desktop...</p>
          </div>
        </div>
      </div>
    );
  }

  // If we have state, check what to show
  const message = state ? getOnboardingMessage(state) : null;

  // Only show error state if we have a configured node but auth is failing
  // For first-time users with no node, let them go through the welcome flow
  if (state && (!state.authAvailable || !state.providersAvailable)) {
    const settings = getSettings();
    // Only show error if we have a properly configured node (not default localhost)
    if (settings.nodeUrl && settings.nodeUrl !== 'http://localhost:2528' && settings.nodeUrl !== 'http://localhost:8080') {
      // Progress indicator component
      const ProgressIndicator = () => (
        <div className="onboarding-progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }}></div>
          </div>
          <div className="progress-steps">
            {ONBOARDING_STEPS.map((step, index) => (
              <div
                key={step}
                className={`progress-step ${index <= currentStepIndex ? 'active' : ''} ${index === currentStepIndex ? 'current' : ''}`}
              >
                <div className="progress-dot"></div>
              </div>
            ))}
          </div>
        </div>
      );

    return (
      <div className="onboarding-page">
          <ProgressIndicator />
        <div className="onboarding-content">
          <div className="onboarding-card error">
              <AlertTriangle className="onboarding-icon" size={48} />
              <h1>{message?.title || 'Error'}</h1>
              <p>{message?.message || state?.error || 'An error occurred'}</p>
            {state.error && (
              <div className="error-details">
                  <strong>Details:</strong> {state.error}
                </div>
              )}
              <div className="help-section">
                <h3>What to do next:</h3>
                <ol>
                  <li>Make sure your Calimero node is running</li>
                  <li>Check that the node URL in Settings is correct</li>
                  <li>Verify the authentication service is properly configured</li>
                </ol>
              </div>
            <div className="onboarding-actions">
              {onSettings && (
                  <button onClick={onSettings} className="button button-primary">
                    Open Settings
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
    // If no node configured, just continue with normal flow (welcome screen)
  }

  // Progress indicator component
  const ProgressIndicator = () => {
    const totalSteps = ONBOARDING_STEPS.length;
    const progressWidth = totalSteps > 1 ? ((currentStepIndex + 1) / totalSteps) * 100 : 0;
    const lineWidth = totalSteps > 1 ? `calc(${progressWidth}% - 80px)` : '0px';
    
    return (
      <div className="onboarding-progress">
        <div className="progress-steps">
          <div className="progress-fill-line" style={{ width: lineWidth }}></div>
          {ONBOARDING_STEPS.map((step, index) => (
            <div
              key={step}
              className={`progress-step ${index <= currentStepIndex ? 'active' : ''} ${index === currentStepIndex ? 'current' : ''}`}
            >
              <div className="progress-dot"></div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // Welcome screen
  if (currentStep === 'welcome') {
    return (
      <div className="onboarding-page">
        <ProgressIndicator />
        <div ref={stepContainerRef} className="onboarding-step-container">
          <div className="step-content">
            <div className="step-logo-wrapper">
              <img src={calimeroLogo} alt="Calimero" className="calimero-logo" />
            </div>
            <h1 className="step-title">Welcome to Calimero</h1>
            <p className="step-description">
              Calimero is like Signal, but designed to power any kind of application—not just messaging. 
              It's fully peer-to-peer, censorship-resistant, and owned by you.
            </p>
          </div>
          <div className="step-actions">
            <button
              onClick={() => setCurrentStep('what-is')}
              className="step-button step-button-primary"
            >
              Continue
              <ArrowRight size={18} />
            </button>
          </div>
          <ScrollHint containerRef={stepContainerRef} />
        </div>
      </div>
    );
  }

  // What is Calimero screen
  if (currentStep === 'what-is') {
    return (
      <div className="onboarding-page">
        <ProgressIndicator />
        <div ref={stepContainerRef} className="onboarding-step-container">
          <button 
            onClick={() => setCurrentStep('welcome')} 
            className="step-back-button"
            aria-label="Go back"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="step-content">
            <h1 className="step-title">Your Data, Your Control</h1>
            <p className="step-description">
              Calimero is built on principles that put you in charge:
            </p>
            <div className="step-principles">
              <div className="principle-item">
                <Check size={18} />
                <span><strong>Local-first</strong> — computations run on your device</span>
              </div>
              <div className="principle-item">
                <Check size={18} />
                <span><strong>Self-sovereign</strong> — you own your data</span>
              </div>
              <div className="principle-item">
                <Check size={18} />
                <span><strong>End-to-end encrypted</strong> — privacy by default</span>
              </div>
              <div className="principle-item">
                <Check size={18} />
                <span><strong>No central servers</strong> — truly decentralized</span>
              </div>
              <div className="principle-item">
                <Check size={18} />
                <span><strong>Invite-only</strong> — you control who joins</span>
              </div>
            </div>
            <div className="step-actions">
              <button
                onClick={() => setCurrentStep('node-setup')}
                className="step-button step-button-primary"
              >
                Get Started
                <ArrowRight size={18} />
              </button>
            </div>
          </div>
          <ScrollHint containerRef={stepContainerRef} />
        </div>
      </div>
    );
  }

  // Node setup step
  if (currentStep === 'node-setup') {
    const showChoice = !loadingExistingNodes && existingNodes.length > 0 && nodeSetupMode === 'choose';
    const showUseExisting = nodeSetupMode === 'use-existing';
    const showCreateNew = nodeSetupMode === 'create-new';

    return (
      <div className="onboarding-page">
        <ProgressIndicator />
        <div ref={stepContainerRef} className="onboarding-step-container">
          <button 
            onClick={() => {
              setCurrentStep('what-is');
              if (nodeSetupMode !== 'choose') setNodeSetupMode('choose');
            }} 
            className="step-back-button"
            aria-label="Go back"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="step-content">
            <h1 className="step-title">Set Up Your Node</h1>

            {nodeCreated && nodeStarted && (
              <div className="step-message step-message-success">
                <Check size={18} />
                <span>Node created and started successfully! Setting up authentication...</span>
              </div>
            )}

            {nodeError && (
              <div className="step-message step-message-error">
                {nodeError}
              </div>
            )}

            {(loadingExistingNodes || (creatingNode && existingNodes.length > 0)) && (
              <p className="step-description">
                {creatingNode && existingNodes.length > 0
                  ? 'Using your existing node...'
                  : 'Checking for existing nodes. If found, we\'ll continue automatically.'}
              </p>
            )}

            {/* Choice: Use existing vs Create new */}
            {showChoice && (
              <>
                <p className="step-description">
                  We found existing node(s) in {dataDir}. Choose how to continue:
                </p>
                <div className="node-setup-choice-cards">
                  <button
                    type="button"
                    className="node-setup-choice-card"
                    onClick={() => setNodeSetupMode('use-existing')}
                  >
                    <strong>Use existing node</strong>
                    <p>Start one of your existing nodes ({existingNodes.length} found)</p>
                  </button>
                  <button
                    type="button"
                    className="node-setup-choice-card"
                    onClick={() => setNodeSetupMode('create-new')}
                  >
                    <strong>Create new node</strong>
                    <p>Set up a fresh node with custom configuration</p>
                  </button>
                </div>
              </>
            )}

            {/* Use existing: minimal form */}
            {showUseExisting && (
              <div className="step-form">
                <p className="step-description" style={{ marginBottom: '20px' }}>
                  Select the node to start and continue.
                </p>
                <div className="form-group">
                  <label htmlFor="data-dir">Data Directory</label>
                  <div className="input-group">
                    <input
                      id="data-dir"
                      type="text"
                      value={dataDir}
                      onChange={(e) => setDataDir(e.target.value)}
                      placeholder="~/.calimero"
                      disabled={creatingNode || nodeCreated}
                    />
                    <button 
                      onClick={handlePickDataDir} 
                      className="button button-secondary"
                      disabled={creatingNode || nodeCreated}
                    >
                      Browse
                    </button>
                  </div>
                </div>
                <div className="form-group">
                  <label>Select node</label>
                  <select
                    value={useExistingNode || ''}
                    onChange={(e) => setUseExistingNode(e.target.value || null)}
                    disabled={creatingNode || nodeCreated}
                    className="existing-node-select"
                  >
                    {existingNodes.map(n => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
                <div className="step-actions" style={{ marginTop: '24px', justifyContent: 'flex-start' }}>
                  <button
                    type="button"
                    onClick={() => setNodeSetupMode('choose')}
                    className="step-button step-button-secondary"
                  >
                    <ArrowLeft size={18} />
                    Back
                  </button>
                  <button
                    onClick={handleCreateNode}
                    className="step-button step-button-primary"
                    disabled={creatingNode || nodeCreated || !useExistingNode}
                  >
                    {creatingNode ? 'Starting Node...' : 'Start Node & Continue'}
                    {!creatingNode && !nodeCreated && <ArrowRight size={18} />}
                  </button>
                </div>
              </div>
            )}

            {/* Create new: full form */}
            {showCreateNew && (
            <div className="step-form">
              <p className="step-description" style={{ marginBottom: '20px' }}>
                Create your first Calimero node. This will store your data and run applications.
              </p>
              {existingNodes.length > 0 && (
                <button
                  type="button"
                  onClick={() => setNodeSetupMode('choose')}
                  className="link-button"
                  style={{ marginBottom: '16px' }}
                >
                  ← Use existing node instead
                </button>
              )}

              <div className="form-group">
                <label htmlFor="data-dir">Data Directory</label>
                <div className="input-group">
                  <input
                    id="data-dir"
                    type="text"
                    value={dataDir}
                    onChange={(e) => setDataDir(e.target.value)}
                    placeholder="~/.calimero"
                    disabled={creatingNode || nodeCreated}
                  />
                  <button 
                    onClick={handlePickDataDir} 
                    className="button button-secondary"
                    disabled={creatingNode || nodeCreated}
                  >
                    Browse
                  </button>
                </div>
              </div>

              <div className="advanced-options-section">
                <button
                  type="button"
                  className="advanced-options-toggle"
                  onClick={() => setShowAdvancedOptions(!showAdvancedOptions)}
                  disabled={creatingNode || nodeCreated}
                >
                  <span>Advanced Options</span>
                  {showAdvancedOptions ? (
                    <ChevronUp size={18} />
                  ) : (
                    <ChevronDown size={18} />
                  )}
                </button>

                {showAdvancedOptions && (
                  <div className="advanced-options-content">
                    <div className="form-group">
                      <label htmlFor="node-name">Node Name</label>
                      <input
                        id="node-name"
                        type="text"
                        value={nodeName}
                        onChange={(e) => setNodeName(e.target.value)}
                        placeholder="default"
                        disabled={creatingNode || nodeCreated}
                      />
                      <p className="field-hint">A name for this node instance</p>
                    </div>

                    <div className="form-row">
                      <div className="form-group">
                        <label htmlFor="server-port">Server Port</label>
                        <input
                          id="server-port"
                          type="number"
                          value={serverPort}
                          onChange={(e) => setServerPort(parseInt(e.target.value) || 2528)}
                          min="1024"
                          max="65535"
                          disabled={creatingNode || nodeCreated}
                        />
                        <p className="field-hint">HTTP/API port</p>
                      </div>

                      <div className="form-group">
                        <label htmlFor="swarm-port">Swarm Port</label>
                        <input
                          id="swarm-port"
                          type="number"
                          value={swarmPort}
                          onChange={(e) => setSwarmPort(parseInt(e.target.value) || 2428)}
                          min="1024"
                          max="65535"
                          disabled={creatingNode || nodeCreated}
                        />
                        <p className="field-hint">P2P networking port</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="step-actions">
                <button
                  onClick={handleCreateNode}
                  className="step-button step-button-primary"
                  disabled={creatingNode || nodeCreated || !nodeName.trim()}
                >
                  {creatingNode ? 'Creating Node...' : nodeCreated && nodeStarted ? 'Setting Up...' : 'Create Node & Continue'}
                  {!creatingNode && !nodeCreated && <ArrowRight size={18} />}
                </button>
              </div>
            </div>
            )}
          </div>
          <ScrollHint containerRef={stepContainerRef} />
        </div>
      </div>
    );
  }

  // Login step - show after node is created
  if (currentStep === 'login') {
      return (
        <div className="onboarding-page">
        <ProgressIndicator />
          <div ref={stepContainerRef} className="onboarding-step-container">
            <div className="step-content">
              <h1 className="step-title">Set Up Authentication</h1>
              <p className="step-description">
                Create a username and password to authenticate with your Calimero node. 
                This account will be used to securely access your node and manage your applications.
              </p>
              <div className="onboarding-card">
                <UsernamePasswordForm
                onSuccess={async () => {
                  setLoginLoading(true);
                  try {
                    // Load apps for the install step
                    await loadApps();
                    // Always advance to install-app step
                    setCurrentStep('install-app');
                  } catch (error) {
                    console.error("Failed to load apps:", error);
                    // Continue anyway - user can skip
                    setCurrentStep('install-app');
                  } finally {
                    setLoginLoading(false);
                  }
              }}
              onError={(error) => {
                console.error("❌ Onboarding login failed:", error);
                  setLoginLoading(false);
              }}
                loading={loginLoading}
                />
              </div>
            </div>
            <ScrollHint containerRef={stepContainerRef} />
          </div>
        </div>
      );
    }

  // Install app step
  if (currentStep === 'install-app') {
    return (
      <div className="onboarding-page">
        <ProgressIndicator />
        <div ref={stepContainerRef} className="onboarding-step-container">
          <div className="step-content">
            <h1 className="step-title">Install Your First App</h1>
            <p className="step-description">
              Choose an application to install and get started with Calimero. You can install more apps later from the Marketplace.
            </p>
            
            {loadingApps ? (
              <div className="apps-loading">
                <p>Loading applications...</p>
              </div>
            ) : allApps.length === 0 ? (
              <div className="apps-empty">
                <p>No applications available. You can install apps later from the Marketplace.</p>
              </div>
            ) : (
              <>
                <div className="onboarding-app-search">
                  <Search size={18} className="search-icon" />
                  <input
                    type="text"
                    placeholder="Search applications..."
                    value={searchQuery}
                    onChange={(e) => {
                      const query = e.target.value.toLowerCase();
                      setSearchQuery(e.target.value);
                      if (query.trim() === "") {
                        setApps(allApps.slice(0, 4));
                      } else {
                        const filtered = allApps.filter(app => 
                          app.name.toLowerCase().includes(query) ||
                          (app as any).description?.toLowerCase().includes(query)
                        );
                        setApps(filtered.slice(0, 4));
                      }
                    }}
                    className="app-search-input"
                  />
                </div>
                {apps.length === 0 ? (
                  <div className="apps-empty">
                    <p>No applications found matching your search.</p>
                    <button
                      onClick={() => {
                        setSearchQuery("");
                        setApps(allApps.slice(0, 4));
                      }}
                      className="step-button step-button-secondary"
                    >
                      Clear Search
                    </button>
                  </div>
                ) : (
                  <div className="onboarding-apps-grid">
                    {apps.map((app) => {
                      const isInstalled = installedAppIds.has(app.id);
                      const isInstalling = installingAppId === app.id;
                      const settings = getSettings();
                      const registry = settings.registries?.[0] || '';
                      
                      return (
                        <div key={app.id} className="onboarding-app-card">
                          <div className="app-card-header">
                            <div className="app-icon-placeholder">
                              <Package size={24} />
                            </div>
                            <div className="app-info">
                              <h3>{app.name}</h3>
                              <p className="app-version">v{app.latest_version}</p>
                            </div>
                          </div>
                          {(app as any).description && (
                            <p className="app-description">{(app as any).description}</p>
                          )}
                          <button
                            onClick={() => handleInstallApp(app, registry)}
                            className="app-install-button"
                            disabled={isInstalled || isInstalling}
                          >
                            {isInstalled ? (
                              <>
                                <CheckCircle2 size={16} />
                                Installed
                              </>
                            ) : isInstalling ? (
                              <>
                                <Download size={16} />
                                Installing...
                              </>
                            ) : (
                              <>
                                <Download size={16} />
                                Install
                              </>
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            <div className="step-actions" style={{ marginTop: '24px' }}>
              <button
                onClick={() => {
                  setTheme('dark');
                  onComplete();
                }}
                className="step-button step-button-secondary"
                disabled={installingAppId !== null}
              >
                Skip for now
              </button>
            </div>
          </div>
          <ScrollHint containerRef={stepContainerRef} />
        </div>
      </div>
    );
  }

  // If we reach here, something went wrong - go to dashboard
  return null;
}
