import { useState, useEffect } from "react";
import {
  Button,
  Card,
  Container,
  Heading,
  Text,
  Box,
  Stack,
  Grid,
  Navbar,
  NavbarBrand,
  NavbarMenu,
  NavbarItem,
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
import "./App.css";

// GitHub repository configuration
const GITHUB_REPO = "calimero-network/tauri-app";
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface ReleaseInfo {
  tag_name: string;
  name: string;
  published_at: string;
  html_url: string;
  body: string;
  assets: ReleaseAsset[];
}

interface DownloadInfo {
  version: string;
  releaseDate: string;
  releaseUrl: string;
  releaseNotes: string;
  macosUrl: string | null;
  macosSize: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function detectPlatform(): "macos" | "windows" | "linux" | "unknown" {
  const userAgent = navigator.userAgent.toLowerCase();
  const platform = navigator.platform.toLowerCase();

  // Check for iPhone/iPod
  if (userAgent.includes("iphone") || userAgent.includes("ipod")) {
    return "unknown";
  }

  // Check for iPad - iPadOS 13+ may report as MacIntel, so check touch capability
  if (
    userAgent.includes("ipad") ||
    (platform.includes("mac") && navigator.maxTouchPoints > 1)
  ) {
    return "unknown";
  }

  // Check for macOS - Macintosh in user agent and no touch capability
  if (userAgent.includes("macintosh") && navigator.maxTouchPoints <= 1) {
    return "macos";
  }
  if (userAgent.includes("win")) return "windows";
  if (userAgent.includes("linux")) return "linux";
  return "unknown";
}

async function fetchLatestRelease(): Promise<DownloadInfo | null> {
  try {
    const response = await fetch(GITHUB_API_URL, {
      headers: {
        Accept: "application/vnd.github.v3+json",
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const release: ReleaseInfo = await response.json();

    // Find macOS DMG asset
    const macosAsset = release.assets.find(
      (asset) =>
        asset.name.endsWith(".dmg") ||
        (asset.name.includes("macos") && asset.name.endsWith(".dmg"))
    );

    return {
      version: release.tag_name.replace(/^v/, ""),
      releaseDate: formatDate(release.published_at),
      releaseUrl: release.html_url,
      releaseNotes: release.body || "",
      macosUrl: macosAsset?.browser_download_url || null,
      macosSize: macosAsset ? formatBytes(macosAsset.size) : null,
    };
  } catch (error) {
    console.error("Failed to fetch release info:", error);
    return null;
  }
}

// Fallback release info when API is unavailable
const FALLBACK_RELEASE: DownloadInfo = {
  version: "0.1.0",
  releaseDate: "Coming Soon",
  releaseUrl: `https://github.com/${GITHUB_REPO}/releases`,
  releaseNotes: "",
  macosUrl: null,
  macosSize: null,
};

function App() {
  const [release, setRelease] = useState<DownloadInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [platform] = useState(() => detectPlatform());

  useEffect(() => {
    fetchLatestRelease()
      .then((info) => {
        if (info) {
          setRelease(info);
          setError(null);
        } else {
          setRelease(FALLBACK_RELEASE);
          setError("Unable to fetch latest release. Please try again later.");
        }
        setLoading(false);
      })
      .catch(() => {
        setRelease(FALLBACK_RELEASE);
        setError("Unable to fetch latest release. Please try again later.");
        setLoading(false);
      });
  }, []);

  const handleDownload = () => {
    if (release?.macosUrl) {
      window.location.href = release.macosUrl;
    }
  };

  return (
    <div className="download-page">
      {/* Header */}
      <header className="header">
        <Container>
          <Navbar variant="minimal" size="md">
            <NavbarBrand text="Calimero" />
            <NavbarMenu align="right">
              <NavbarItem>
                <a
                  href="https://calimero.network"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <Text color="secondary">Website</Text>
                </a>
              </NavbarItem>
              <NavbarItem>
                <a
                  href="https://docs.calimero.network"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <Text color="secondary">Docs</Text>
                </a>
              </NavbarItem>
              <NavbarItem>
                <a
                  href={`https://github.com/${GITHUB_REPO}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <Text color="secondary">GitHub</Text>
                </a>
              </NavbarItem>
            </NavbarMenu>
          </Navbar>
        </Container>
      </header>

      {/* Hero Section */}
      <main className="main">
        <Container>
          <Box style={{ paddingTop: "4rem", paddingBottom: "4rem" }}>
            <Grid columns={2} gap={32} align="center">
              <Box>
                <Stack spacing="xl">
                  <Stack spacing="md">
                    <Heading level={1} size="4xl" weight="bold">
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
                  ) : (
                    <Stack spacing="lg">
                      {platform === "macos" && release?.macosUrl ? (
                        <Box>
                          <Button
                            variant="primary"
                            size="xl"
                            onClick={handleDownload}
                            style={{ width: "100%", maxWidth: "20rem" }}
                          >
                            <Stack spacing="xs" align="start">
                              <Text
                                weight="semibold"
                                size="md"
                                style={{ color: "#1a1a1a" }}
                              >
                                Download for macOS
                              </Text>
                              <Text size="sm" style={{ color: "#4a4a4a" }}>
                                Version {release.version} • {release.macosSize}
                              </Text>
                            </Stack>
                          </Button>
                        </Box>
                      ) : platform === "macos" ? (
                        <Button
                          size="xl"
                          disabled
                          style={{ width: "100%", maxWidth: "20rem" }}
                        >
                          <Text>macOS Download - Coming Soon</Text>
                        </Button>
                      ) : (
                        <Box>
                          <Text color="muted" style={{ marginBottom: "1rem" }}>
                            Calimero Desktop is currently available for macOS.
                            {platform === "windows" &&
                              " Windows support coming soon."}
                            {platform === "linux" &&
                              " Linux support coming soon."}
                          </Text>
                          {release?.macosUrl && (
                            <Button
                              variant="outline"
                              size="lg"
                              onClick={handleDownload}
                              leftIcon={<Download />}
                            >
                              Download for macOS anyway
                            </Button>
                          )}
                        </Box>
                      )}

                      {release && (
                        <Stack
                          direction="horizontal"
                          spacing="sm"
                          align="center"
                        >
                          <Text size="sm" color="muted">
                            v{release.version}
                          </Text>
                          <Text size="sm" color="muted">
                            •
                          </Text>
                          <Text size="sm" color="muted">
                            {release.releaseDate}
                          </Text>
                          <Text size="sm" color="muted">
                            •
                          </Text>
                          <a
                            href={release.releaseUrl}
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

                      {error && <Text color="error">{error}</Text>}
                    </Stack>
                  )}
                </Stack>
              </Box>

              {/* App Preview */}
              <Box>
                <Card style={{ overflow: "hidden" }}>
                  <Box
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    minHeight="400px"
                    backgroundColor="muted"
                  >
                    <Stack spacing="sm" align="center">
                      <Box
                        display="flex"
                        alignItems="center"
                        justifyContent="center"
                        width={64}
                        height={64}
                        borderRadius="lg"
                        style={{
                          backgroundColor: "var(--color-brand-600)",
                          color: "var(--color-background-primary)",
                        }}
                      >
                        <BoxIcon size={32} />
                      </Box>
                      <Text color="muted" size="sm">
                        App Preview
                      </Text>
                    </Stack>
                  </Box>
                </Card>
              </Box>
            </Grid>
          </Box>
        </Container>

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
                <Stack spacing="lg">
                  <Heading level={4} size="lg" weight="semibold">
                    macOS
                  </Heading>
                  <List
                    items={[
                      {
                        id: 1,
                        content: "macOS 10.15 (Catalina) or later",
                      },
                      {
                        id: 2,
                        content: "Apple Silicon or Intel processor",
                      },
                      {
                        id: 3,
                        content: "100 MB available disk space",
                      },
                    ]}
                    variant="ghost"
                    divider={true}
                  />
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
                  href="https://calimero.network/privacy"
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
                  href={`https://github.com/${GITHUB_REPO}`}
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
