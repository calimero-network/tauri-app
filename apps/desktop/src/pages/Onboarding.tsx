import { useState, useEffect, useRef } from "react";
import { checkOnboardingState, getOnboardingMessage, type OnboardingState } from "../utils/onboarding";
import { apiClient } from "../lib/mero-client";
import { LoginView } from "../components/LoginView";
import { initMerodNode, startMerod, listMerodNodes, detectRunningMerodNodes, waitForNodeHealthy, stopMerod, killAllMerodProcesses, deleteCalimeroDataDir } from "../utils/merod";
import { invoke } from "@tauri-apps/api/tauri";
import { saveSettings, getSettings, clearAllAppData } from "../utils/settings";
import { saveOnboardingProgress, loadOnboardingProgress } from "../utils/onboardingProgress";
import { startCloudLogin } from "../utils/cloudAuth";
import { isCloudEnabled } from "../utils/featureFlags";
import { fetchAppsFromAllRegistries, fetchAppManifest, recordDownload, type AppSummary } from "../utils/registry";
import { useToast } from "../contexts/ToastContext";
import { useTheme } from "../contexts/ThemeContext";
import { ArrowLeft, ArrowRight, Check, Package, Download, CheckCircle2, ChevronDown, ChevronUp, AlertTriangle, Settings, RefreshCw } from "lucide-react";
import calimeroLogo from "../assets/calimero-logo.svg";
import bs58 from "bs58";
import "./Onboarding.css";

interface OnboardingProps {
  onComplete: () => void;
  onSettings?: () => void;
}

type OnboardingStep = 'welcome' | 'what-is' | 'node-setup' | 'cloud-connect' | 'login' | 'install-app';

const ONBOARDING_STEPS: OnboardingStep[] = isCloudEnabled()
  ? ['welcome', 'what-is', 'node-setup', 'cloud-connect', 'login', 'install-app']
  : ['welcome', 'what-is', 'node-setup', 'login', 'install-app'];

const STEP_AFTER_NODE_SETUP: OnboardingStep = isCloudEnabled() ? 'cloud-connect' : 'login';


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
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);
  const [installingAppId, setInstallingAppId] = useState<string | null>(null);
  const [installedAppIds, setInstalledAppIds] = useState<Set<string>>(new Set());

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
  const [loginTransitioning, setLoginTransitioning] = useState(false);
  const [cloudConnecting, setCloudConnecting] = useState(false);
  const [cloudConnected, setCloudConnected] = useState(() => getSettings().cloudConnected ?? false);
  const [existingNodes, setExistingNodes] = useState<string[]>([]);
  const [useExistingNode, setUseExistingNode] = useState<string | null>(() => loadOnboardingProgress()?.useExistingNode ?? null);
  const [loadingExistingNodes, setLoadingExistingNodes] = useState(false);
  // 'choose' = show path selection, 'use-existing' = minimal form, 'create-new' = full form
  const [nodeSetupMode, setNodeSetupMode] = useState<'choose' | 'use-existing' | 'create-new'>(() => loadOnboardingProgress()?.nodeSetupMode ?? 'choose');
  const stepContainerRef = useRef<HTMLDivElement>(null);
  const hasAttemptedAutoContinue = useRef(false);
  const [showFloatingMenu, setShowFloatingMenu] = useState(false);
  const [nuking, setNuking] = useState(false);

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

  // Load existing nodes when on node-setup step - auto-continue to login if found
  const prevDataDirRef = useRef(dataDir);
  useEffect(() => {
    if (currentStep !== 'node-setup') {
      return;
    }
    // Reset only when dataDir changes so we retry for the new directory.
    // Do NOT reset on step change — otherwise pressing Back from cloud-connect
    // re-triggers auto-advance and the user is bounced forward again.
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
            setCreatingNode(false);
            setCurrentStep(STEP_AFTER_NODE_SETUP);
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
      const advanceToCloudConnect = () => {
        setTimeout(async () => {
          try {
            const onboardingState = await checkOnboardingState();
            setState(onboardingState);
            setCurrentStep(STEP_AFTER_NODE_SETUP);
          } catch (err) {
            console.error("Failed to check onboarding state:", err);
            setCurrentStep(STEP_AFTER_NODE_SETUP);
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
          // check_merod_health appends /health — use /auth so it hits /auth/health
          await waitForNodeHealthy(`${nodeUrl}/auth`, 5000);
          advanceToCloudConnect();
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
        // check_merod_health appends /health — use /auth so it hits /auth/health
        await waitForNodeHealthy(`${nodeUrl}/auth`, 20000);
        advanceToCloudConnect();
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
        // check_merod_health appends /health — use /auth so it hits /auth/health
        await waitForNodeHealthy(`${nodeUrl}/auth`, 20000);
        advanceToCloudConnect();
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
      
      setApps(fetchedApps.slice(0, 4));
      
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

      // Record download with registry (fire-and-forget)
      recordDownload(registry, app.id, app.latest_version);

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

  // Reset node state and go back to node-setup (used by cloud-connect and login back buttons)
  const goBackToNodeSetup = () => {
    setNodeCreated(false);
    setNodeStarted(false);
    setCreatingNode(false);
    setCurrentStep('node-setup');
  };

  // Hard reset: kill all merod processes, delete data dir, wipe all storage, reload
  const handleNukeAll = async () => {
    setNuking(true);
    setShowFloatingMenu(false);
    // 1. Graceful stop then force-kill
    try { await stopMerod(); } catch { /* not tracked — ok */ }
    try { await killAllMerodProcesses(); } catch { /* best-effort */ }
    // 2. Wait for OS to release file handles
    await new Promise((r) => setTimeout(r, 800));
    // 3. Delete the data directory (settings path + default ~/.calimero)
    const settingsDataDir = getSettings().embeddedNodeDataDir || '~/.calimero';
    const dirsToDelete = [...new Set([settingsDataDir, '~/.calimero'])];
    for (const dir of dirsToDelete) {
      try { await deleteCalimeroDataDir(dir); } catch { /* dir may not exist */ }
    }
    // 4. Wipe all client-side state
    clearAllAppData();
    sessionStorage.clear();
    window.location.reload();
  };

  const FloatingMenu = () => (
    <>
      {showFloatingMenu && (
        <div
          className="onboarding-floating-overlay"
          onClick={() => setShowFloatingMenu(false)}
        />
      )}
      <div className="onboarding-floating-actions">
        {showFloatingMenu && (
          <div className="onboarding-floating-menu">
            <button
              className="floating-menu-item"
              onClick={() => { setShowFloatingMenu(false); window.location.reload(); }}
            >
              <RefreshCw size={14} />
              Reload page
            </button>
            <div className="floating-menu-divider" />
            <button
              className="floating-menu-item floating-menu-item-danger"
              disabled={nuking}
              onClick={handleNukeAll}
            >
              {nuking ? 'Stopping & resetting...' : '⚠ Reset everything'}
            </button>
          </div>
        )}
        <button
          className="onboarding-cog-btn"
          onClick={() => setShowFloatingMenu(v => !v)}
          title="Options"
          aria-label="Options"
        >
          <Settings size={18} />
        </button>
      </div>
    </>
  );

  // Get current step index for progress
  const currentStepIndex = ONBOARDING_STEPS.indexOf(currentStep);
  const progress = ((currentStepIndex + 1) / ONBOARDING_STEPS.length) * 100;

  // If loading and we have a step other than welcome/node-setup, show loading
  if (loading && !['welcome', 'what-is', 'node-setup'].includes(currentStep)) {
    return (
      <div className="onboarding-page" data-testid="onboarding-page">
        <FloatingMenu />
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
      const handleBackToNodeSetup = () => {
        // Clear the saved nodeUrl so the error condition no longer triggers,
        // then go back to node-setup so the user can reconfigure.
        saveSettings({
          ...getSettings(),
          nodeUrl: 'http://localhost:2528',
          useEmbeddedNode: undefined,
          embeddedNodeName: undefined,
          embeddedNodePort: undefined,
          embeddedNodeDataDir: undefined,
        });
        setState(null);
        setNodeCreated(false);
        setNodeStarted(false);
        setNodeSetupMode('choose');
        hasAttemptedAutoContinue.current = false;
        setCurrentStep('node-setup');
      };

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
      <div className="onboarding-page" data-testid="onboarding-page">
          <ProgressIndicator />
          <FloatingMenu />
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
              <button onClick={handleBackToNodeSetup} className="button button-secondary">
                <ArrowLeft size={16} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                Back to Node Setup
              </button>
              {onSettings && (
                  <button onClick={onSettings} className="button button-primary">
                    Open Settings
                </button>
              )}
              <button onClick={handleNukeAll} disabled={nuking} className="button button-danger">
                {nuking ? 'Stopping & resetting...' : 'Reset & Start Over'}
              </button>
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
      <div className="onboarding-page" data-testid="onboarding-page">
        <ProgressIndicator />
        <FloatingMenu />
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
        </div>
      </div>
    );
  }

  // What is Calimero screen
  if (currentStep === 'what-is') {
    return (
      <div className="onboarding-page" data-testid="onboarding-page">
        <ProgressIndicator />
        <FloatingMenu />
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
      <div className="onboarding-page" data-testid="onboarding-page">
        <ProgressIndicator />
        <FloatingMenu />
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
        </div>
      </div>
    );
  }

  // Cloud connect step - optional, skippable
  if (currentStep === 'cloud-connect') {
    return (
      <div className="onboarding-page" data-testid="onboarding-page">
        <ProgressIndicator />
        <FloatingMenu />
        <div ref={stepContainerRef} className="onboarding-step-container">
          <div className="step-content">
            <h1 className="step-title">Connect to Calimero Cloud</h1>
            <p className="step-description">
              Sign in with Google to enable cloud features like High Availability,
              cloud-hosted contexts, and managed infrastructure. This is optional &mdash;
              your local node works fully without it.
            </p>
            <div className="onboarding-card" style={{ textAlign: 'center', padding: '32px' }}>
              {cloudConnecting ? (
                <div className="loading-spinner">
                  <div className="spinner" />
                  <p>Waiting for sign-in in your browser...</p>
                </div>
              ) : cloudConnected ? (
                <div>
                  <CheckCircle2 size={48} style={{ color: 'var(--accent-color, #4ade80)', marginBottom: '12px' }} />
                  <p style={{ fontWeight: 600, fontSize: '1.1rem' }}>Connected to Calimero Cloud</p>
                  <p style={{ opacity: 0.7, marginTop: '4px' }}>{getSettings().cloudUserEmail}</p>
                </div>
              ) : (
                <button
                  className="google-signin-btn"
                  onClick={async () => {
                    setCloudConnecting(true);
                    try {
                      const userInfo = await startCloudLogin();
                      if (userInfo) {
                        setCloudConnected(true);
                        toast.success('Connected to Calimero Cloud');
                      } else {
                        toast.error('Cloud login timed out or was cancelled');
                      }
                    } catch (err: unknown) {
                      toast.error(`Cloud login failed: ${String(err)}`);
                    } finally {
                      setCloudConnecting(false);
                    }
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
                    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
                    <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
                    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
                  </svg>
                  Sign in with Google
                </button>
              )}
            </div>
            <div className="step-actions" style={{ marginTop: '24px' }}>
              <button
                className="button button-secondary"
                onClick={goBackToNodeSetup}
              >
                <ArrowLeft size={16} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                Back
              </button>
              <button
                className="button button-primary"
                onClick={async () => {
                  try {
                    const onboardingState = await checkOnboardingState();
                    setState(onboardingState);
                  } catch {
                    // continue anyway
                  }
                  setCurrentStep('login');
                }}
              >
                {cloudConnected ? 'Continue' : 'Skip for now'}
                <ArrowRight size={16} style={{ marginLeft: '4px', verticalAlign: 'middle' }} />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Login step - show after node is created
  if (currentStep === 'login') {
      return (
        <div className="onboarding-page" data-testid="onboarding-page">
        <ProgressIndicator />
        <FloatingMenu />
          <div ref={stepContainerRef} className="onboarding-step-container onboarding-step-login">
            <button
              onClick={() => {
                if (STEP_AFTER_NODE_SETUP === 'node-setup') {
                  goBackToNodeSetup();
                } else {
                  setNodeCreated(false);
                  setNodeStarted(false);
                  setCreatingNode(false);
                  setCurrentStep(STEP_AFTER_NODE_SETUP);
                }
              }}
              className="step-back-button"
              aria-label="Go back"
            >
              <ArrowLeft size={18} />
            </button>
            <div className="step-content" style={{ justifyContent: 'center' }}>
              <h1 className="step-title">Set Up Authentication</h1>
              <p className="step-description">
                Create a username and password to authenticate with your Calimero node.
                This account will be used to securely access your node and manage your applications.
              </p>
              <div className="onboarding-card" style={{ alignItems: 'center' }}>
                {loginTransitioning ? (
                  <div className="loading-spinner">
                    <div className="spinner" />
                    <p>Setting up your account...</p>
                  </div>
                ) : (
                  <LoginView
                    variant="dark"
                    onSuccess={async () => {
                      setLoginTransitioning(true);
                      try {
                        await loadApps();
                      } catch (error) {
                        console.error("Failed to load apps:", error);
                      }
                      setCurrentStep('install-app');
                    }}
                    onError={(error) => {
                      console.error("❌ Onboarding login failed:", error);
                    }}
                  />
                )}
              </div>
            </div>
            </div>
        </div>
      );
    }

  // Install app step
  if (currentStep === 'install-app') {
    return (
      <div className="onboarding-page" data-testid="onboarding-page">
        <ProgressIndicator />
        <FloatingMenu />
        <div ref={stepContainerRef} className="onboarding-step-container">
          <button
            onClick={() => setCurrentStep('login')}
            className="step-back-button"
            aria-label="Go back"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="step-content">
            <h1 className="step-title">Install Your First App</h1>
            <p className="step-description">
              Choose an application to install and get started with Calimero. You can install more apps later from the Marketplace.
            </p>
            
            {loadingApps ? (
              <div className="apps-loading">
                <p>Loading applications...</p>
              </div>
            ) : apps.length === 0 ? (
              <div className="apps-empty">
                <p>No applications available. You can install apps later from the Marketplace.</p>
              </div>
            ) : (
              <div className="onboarding-apps-grid">
                {apps.map((app) => {
                  const isInstalled = installedAppIds.has(app.id);
                  const isInstalling = installingAppId === app.id;
                  const settings = getSettings();
                  const registry = settings.registries?.[0] || '';
                  const description = (app as any).description || "No description available.";

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
                      <p className="app-description">{description}</p>
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
            <div className="step-content-spacer" aria-hidden="true" />
          </div>
        </div>
      </div>
    );
  }

  // If we reach here, something went wrong - go to dashboard
  return null;
}
