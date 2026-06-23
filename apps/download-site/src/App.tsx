import { useState, useEffect, useMemo } from "react";
import {
  Button,
  Card,
  Container,
  Heading,
  Text,
  Box,
  Stack,
  Grid,
  List,
  Divider,
} from "@calimero-network/mero-ui";
import {
  Download,
  Box as BoxIcon,
  Grid as GridIcon,
  Monitor,
  Refresh,
  ExternalLink,
} from "@calimero-network/mero-icons";
import {
  fetchRelease,
  getDownloadsForPlatform,
  getAvailablePlatforms,
  getGitHubRepoUrl,
  formatDate,
  detectPlatform,
  getPlatformLabel,
  type ReleaseManifest,
  type OS,
  type DownloadAsset,
} from "./release";
import "./App.css";

// Platform tab configuration
const PLATFORM_ORDER: OS[] = ["macos", "windows", "linux", "chromebook"];

interface PlatformTabProps {
  platform: OS;
  isActive: boolean;
  isAvailable: boolean;
  onClick: () => void;
}

function PlatformTab({
  platform,
  isActive,
  isAvailable,
  onClick,
}: PlatformTabProps) {
  const label = getPlatformLabel(platform);
  return (
    <button
      onClick={onClick}
      className={`platform-tab ${isActive ? "active" : ""} ${!isAvailable ? "disabled" : ""}`}
      disabled={!isAvailable}
      style={{
        padding: "0.75rem 1.5rem",
        border: "none",
        background: isActive ? "var(--color-brand-600)" : "transparent",
        color: isActive
          ? "var(--color-background-primary)"
          : isAvailable
            ? "var(--color-text-primary)"
            : "var(--color-text-muted)",
        borderRadius: "0.5rem",
        cursor: isAvailable ? "pointer" : "not-allowed",
        fontWeight: isActive ? 600 : 400,
        fontSize: "0.875rem",
        transition: "all 0.15s ease",
        opacity: isAvailable ? 1 : 0.5,
      }}
    >
      {label}
      {!isAvailable && " (Coming Soon)"}
    </button>
  );
}

interface DownloadButtonProps {
  asset: DownloadAsset;
  isPrimary?: boolean;
}

function DownloadButton({ asset, isPrimary = false }: DownloadButtonProps) {
  const handleDownload = () => {
    window.location.href = asset.url;
  };

  if (isPrimary) {
    return (
      <Button
        variant="primary"
        size="xl"
        onClick={handleDownload}
        style={{ width: "100%", maxWidth: "20rem" }}
      >
        <Stack spacing="xs" align="start">
          <Text weight="semibold" size="md" style={{ color: "#1a1a1a" }}>
            Download for {getPlatformLabel(asset.os)}
          </Text>
          <Text size="sm" style={{ color: "#4a4a4a" }}>
            {asset.format.toUpperCase()} • {asset.sizeFormatted}
          </Text>
        </Stack>
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      size="md"
      onClick={handleDownload}
      leftIcon={<Download size={16} />}
    >
      {asset.label} ({asset.sizeFormatted})
    </Button>
  );
}

function App() {
  const [release, setRelease] = useState<ReleaseManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detectedPlatform] = useState(() => detectPlatform());
  const [selectedPlatform, setSelectedPlatform] = useState<OS>("macos");

  // Determine available platforms from release
  const availablePlatforms = useMemo(() => {
    if (!release) return [];
    return getAvailablePlatforms(release);
  }, [release]);

  // Get downloads for selected platform
  const platformDownloads = useMemo(() => {
    if (!release) return { primary: null, alternatives: [] };
    return getDownloadsForPlatform(release, selectedPlatform);
  }, [release, selectedPlatform]);

  // Set initial platform based on detection
  useEffect(() => {
    if (
      detectedPlatform !== "unknown" &&
      availablePlatforms.includes(detectedPlatform)
    ) {
      setSelectedPlatform(detectedPlatform);
    } else if (availablePlatforms.length > 0) {
      setSelectedPlatform(availablePlatforms[0]);
    }
  }, [detectedPlatform, availablePlatforms]);

  // Fetch release info
  useEffect(() => {
    fetchRelease()
      .then((manifest) => {
        if (manifest) {
          setRelease(manifest);
          setError(null);
        } else {
          setError("Unable to fetch release information. Please try again.");
        }
        setLoading(false);
      })
      .catch(() => {
        setError("Unable to fetch release information. Please try again.");
        setLoading(false);
      });
  }, []);

  const gitHubRepoUrl = getGitHubRepoUrl();
  const gitHubOrgUrl = "https://github.com/calimero-network";

  return (
    <div className="download-page">
      {/* Header */}
      <header className="header">
        <div className="header-inner">
          <a href="/" className="header-brand">
            <span className="header-title">Calimero Desktop</span>
          </a>
          <nav className="header-nav">
            <a href="https://calimero.network" target="_blank" rel="noopener noreferrer" className="header-nav-link">Website</a>
            <a href="https://docs.calimero.network" target="_blank" rel="noopener noreferrer" className="header-nav-link">Docs</a>
            <a href={gitHubOrgUrl} target="_blank" rel="noopener noreferrer" className="header-nav-link">GitHub</a>
          </nav>
        </div>
      </header>

      {/* Hero Section */}
      <main className="main">
        <div className="hero-section">
        <Container>
          <Box style={{ paddingTop: "5rem", paddingBottom: "5rem" }}>
            <Grid columns={2} gap={32} align="center">
              <Box>
                <Stack spacing="xl">
                  <Stack spacing="md">
                    {release && (
                      <Box>
                        <span className="version-badge">v{release.version} — Latest Release</span>
                      </Box>
                    )}
                    <Heading level={1} size="4xl" weight="bold" className="gradient-heading">
                      Calimero Desktop
                    </Heading>
                    <Text
                      size="lg"
                      color="muted"
                      style={{ maxWidth: "32rem", lineHeight: 1.7 }}
                    >
                      A powerful desktop application for interacting with the
                      Calimero Network. Manage contexts, install applications,
                      and connect to your node.
                    </Text>
                  </Stack>

                  {loading ? (
                    <Box>
                      <Text color="muted">Checking for latest release...</Text>
                    </Box>
                  ) : error ? (
                    <Stack spacing="md">
                      <Text color="error">{error}</Text>
                      <a
                        href={`${gitHubRepoUrl}/releases`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Button variant="outline" leftIcon={<ExternalLink />}>
                          View releases on GitHub
                        </Button>
                      </a>
                    </Stack>
                  ) : (
                    <Stack spacing="lg">
                      {/* Platform Tabs */}
                      <Box
                        style={{
                          display: "flex",
                          gap: "0.5rem",
                          padding: "0.25rem",
                          background: "var(--color-background-secondary)",
                          borderRadius: "0.75rem",
                          width: "fit-content",
                        }}
                      >
                        {PLATFORM_ORDER.map((platform) => (
                          <PlatformTab
                            key={platform}
                            platform={platform}
                            isActive={selectedPlatform === platform}
                            isAvailable={availablePlatforms.includes(platform)}
                            onClick={() => setSelectedPlatform(platform)}
                          />
                        ))}
                      </Box>

                      {/* Primary Download */}
                      {platformDownloads.primary ? (
                        <Box className="download-glow">
                          <DownloadButton
                            asset={platformDownloads.primary}
                            isPrimary
                          />
                        </Box>
                      ) : availablePlatforms.includes(selectedPlatform) ? (
                        <Text color="muted">
                          No installer available for this platform yet.
                        </Text>
                      ) : (
                        <Text color="muted">
                          {getPlatformLabel(selectedPlatform)} support coming
                          soon.
                        </Text>
                      )}

                      {/* Alternative Downloads */}
                      {platformDownloads.alternatives.length > 0 && (
                        <Stack spacing="sm">
                          <Text size="sm" color="muted">
                            Other formats:
                          </Text>
                          <Stack direction="horizontal" spacing="sm">
                            {platformDownloads.alternatives.map((asset) => (
                              <DownloadButton
                                key={asset.filename}
                                asset={asset}
                              />
                            ))}
                          </Stack>
                        </Stack>
                      )}

                      {/* Release Info */}
                      {release && (
                        <Stack
                          direction="horizontal"
                          spacing="sm"
                          align="center"
                        >
                          <Text size="sm" color="muted">
                            Released {formatDate(release.publishedAt)}
                          </Text>
                          <Text size="sm" color="muted">
                            •
                          </Text>
                          <a
                            href={release.notesUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ textDecoration: "none" }}
                          >
                            <Text
                              size="sm"
                              style={{ color: "var(--color-brand-600)" }}
                            >
                              Release Notes <ExternalLink size={12} />
                            </Text>
                          </a>
                        </Stack>
                      )}
                    </Stack>
                  )}
                </Stack>
              </Box>

              {/* App Preview */}
              <Box>
                <div style={{
                  overflow: "hidden",
                  borderRadius: "0.75rem",
                  border: "1px solid #27272a",
                  boxShadow: "0 0 40px rgba(165, 255, 17, 0.04), 0 20px 60px rgba(0,0,0,0.6)",
                }}>
                  <img
                    src={`${import.meta.env.BASE_URL}preview.png`}
                    alt="Calimero Desktop preview"
                    style={{ width: "100%", height: "auto", display: "block" }}
                  />
                </div>
              </Box>
            </Grid>
          </Box>
        </Container>
        </div>

        <Divider />

        {/* Features Section */}
        <Container>
          <Box style={{ paddingTop: "4rem", paddingBottom: "4rem" }}>
            <Stack spacing="xl">
              <Box
                style={{
                  textAlign: "center",
                  maxWidth: "48rem",
                  margin: "0 auto",
                }}
              >
                <Heading
                  level={2}
                  size="3xl"
                  weight="bold"
                  style={{ marginBottom: "1rem" }}
                >
                  Features
                </Heading>
                <Text size="lg" color="muted">
                  Everything you need to interact with the Calimero Network
                </Text>
              </Box>

              <Grid columns={4} gap={16}>
                <Card>
                  <Stack spacing="lg" style={{ height: "100%" }}>
                    <Box
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      width={56}
                      height={56}
                      borderRadius="lg"
                      style={{
                        flexShrink: 0,
                        backgroundColor: "var(--color-brand-600)",
                        color: "var(--color-background-primary)",
                      }}
                    >
                      <BoxIcon size={28} />
                    </Box>
                    <Stack spacing="xs">
                      <Heading
                        level={3}
                        size="lg"
                        weight="semibold"
                        style={{ margin: 0 }}
                      >
                        Context Management
                      </Heading>
                      <Text
                        color="muted"
                        style={{ margin: 0, lineHeight: 1.6 }}
                      >
                        Create, manage, and interact with isolated execution
                        contexts for your applications.
                      </Text>
                    </Stack>
                  </Stack>
                </Card>

                <Card>
                  <Stack spacing="lg" style={{ height: "100%" }}>
                    <Box
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      width={56}
                      height={56}
                      borderRadius="lg"
                      style={{
                        flexShrink: 0,
                        backgroundColor: "var(--color-brand-600)",
                        color: "var(--color-background-primary)",
                      }}
                    >
                      <GridIcon size={28} />
                    </Box>
                    <Stack spacing="xs">
                      <Heading
                        level={3}
                        size="lg"
                        weight="semibold"
                        style={{ margin: 0 }}
                      >
                        App Marketplace
                      </Heading>
                      <Text
                        color="muted"
                        style={{ margin: 0, lineHeight: 1.6 }}
                      >
                        Browse and install WebAssembly applications from
                        configured registries.
                      </Text>
                    </Stack>
                  </Stack>
                </Card>

                <Card>
                  <Stack spacing="lg" style={{ height: "100%" }}>
                    <Box
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      width={56}
                      height={56}
                      borderRadius="lg"
                      style={{
                        flexShrink: 0,
                        backgroundColor: "var(--color-brand-600)",
                        color: "var(--color-background-primary)",
                      }}
                    >
                      <Monitor size={28} />
                    </Box>
                    <Stack spacing="xs">
                      <Heading
                        level={3}
                        size="lg"
                        weight="semibold"
                        style={{ margin: 0 }}
                      >
                        Node Connection
                      </Heading>
                      <Text
                        color="muted"
                        style={{ margin: 0, lineHeight: 1.6 }}
                      >
                        Connect to your Calimero node with secure authentication
                        and real-time status.
                      </Text>
                    </Stack>
                  </Stack>
                </Card>

                <Card>
                  <Stack spacing="lg" style={{ height: "100%" }}>
                    <Box
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      width={56}
                      height={56}
                      borderRadius="lg"
                      style={{
                        flexShrink: 0,
                        backgroundColor: "var(--color-brand-600)",
                        color: "var(--color-background-primary)",
                      }}
                    >
                      <Refresh size={28} />
                    </Box>
                    <Stack spacing="xs">
                      <Heading
                        level={3}
                        size="lg"
                        weight="semibold"
                        style={{ margin: 0 }}
                      >
                        Auto Updates
                      </Heading>
                      <Text
                        color="muted"
                        style={{ margin: 0, lineHeight: 1.6 }}
                      >
                        Stay up to date with automatic update notifications and
                        seamless upgrades.
                      </Text>
                    </Stack>
                  </Stack>
                </Card>
              </Grid>
            </Stack>
          </Box>
        </Container>

        <Divider />

        {/* System Requirements */}
        <Container>
          <Box style={{ paddingTop: "4rem", paddingBottom: "4rem" }}>
            <Grid columns={2} gap={32} align="start">
              <Box>
                <Stack spacing="lg">
                  <Heading level={2} size="3xl" weight="bold">
                    System Requirements
                  </Heading>
                  <Text size="lg" color="muted">
                    Ensure your system meets the minimum requirements to run
                    Calimero Desktop.
                  </Text>
                </Stack>
              </Box>
              <Box>
                <Stack spacing="xl">
                  <Stack spacing="lg">
                    <Heading level={4} size="lg" weight="semibold">
                      macOS
                    </Heading>
                    <List
                      items={[
                        { id: 1, content: "macOS 10.15 (Catalina) or later" },
                        { id: 2, content: "Apple Silicon or Intel processor" },
                        { id: 3, content: "100 MB available disk space" },
                      ]}
                      variant="ghost"
                      divider={true}
                    />
                  </Stack>

                  <Stack spacing="lg">
                    <Heading level={4} size="lg" weight="semibold">
                      Windows
                    </Heading>
                    <List
                      items={[
                        { id: 1, content: "Windows 10 (64-bit) or later" },
                        { id: 2, content: "x64 processor" },
                        { id: 3, content: "100 MB available disk space" },
                      ]}
                      variant="ghost"
                      divider={true}
                    />
                  </Stack>

                  <Stack spacing="lg">
                    <Heading level={4} size="lg" weight="semibold">
                      Linux
                    </Heading>
                    <List
                      items={[
                        {
                          id: 1,
                          content:
                            "Ubuntu 20.04+, Fedora 35+, or equivalent distro",
                        },
                        { id: 2, content: "x64 processor" },
                        { id: 3, content: "100 MB available disk space" },
                        { id: 4, content: "WebKit2GTK 4.0" },
                      ]}
                      variant="ghost"
                      divider={true}
                    />
                  </Stack>

                  <Stack spacing="lg">
                    <Heading level={4} size="lg" weight="semibold">
                      Chromebook
                    </Heading>
                    <List
                      items={[
                        {
                          id: 1,
                          content:
                            "ChromeOS with the Linux (Crostini) environment enabled",
                        },
                        { id: 2, content: "ARM64 (aarch64) processor" },
                        { id: 3, content: "100 MB available disk space" },
                        {
                          id: 4,
                          content:
                            "Install the .deb via the Files app, then launch from the launcher",
                        },
                      ]}
                      variant="ghost"
                      divider={true}
                    />
                  </Stack>
                </Stack>
              </Box>
            </Grid>
          </Box>
        </Container>
      </main>

      {/* Footer */}
      <footer className="footer">
        <Divider />
        <Container>
          <Box padding="xl">
            <Stack
              direction="horizontal"
              justify="space-between"
              align="center"
            >
              <Text size="sm" color="muted">
                &copy; {new Date().getFullYear()} Calimero Network. All rights
                reserved.
              </Text>
              <Stack direction="horizontal" spacing="lg">
                <a
                  href="https://calimero.network/privacy-policy"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "none" }}
                >
                  <Text size="sm" color="muted">
                    Privacy Policy
                  </Text>
                </a>
                <a
                  href="https://calimero.network/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "none" }}
                >
                  <Text size="sm" color="muted">
                    Terms of Service
                  </Text>
                </a>
                <a
                  href={gitHubOrgUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "none" }}
                >
                  <Text size="sm" color="muted">
                    GitHub
                  </Text>
                </a>
              </Stack>
            </Stack>
          </Box>
        </Container>
      </footer>
    </div>
  );
}

export default App;
