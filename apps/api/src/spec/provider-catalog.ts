/** Provider IDs and capabilities are shared by validation, API discovery, and AI context. */
export const CONNECTORS = ["github", "website", "news"] as const;
export const GITHUB_QUERIES = ["assigned_issues", "open_pull_requests", "review_requests", "contribution_streak"] as const;
export const WEBSITE_QUERIES = ["page"] as const;
export const NEWS_QUERIES = ["latest_items"] as const;
export const DEVICE_METRICS = ["battery_level", "battery_status", "battery_health", "bluetooth_status", "wifi_status", "network_type", "storage_free", "storage_used_percent", "power_saver", "device_model", "android_version"] as const;

export const DATA_PROVIDER_CATALOG = [
  { id: "github", kind: "connected", description: "Read the signed-in user's GitHub issues, pull requests, review requests, and contribution streak.", queries: GITHUB_QUERIES },
  { id: "website", kind: "public_web", description: "Read bounded metadata, links, headings, text, and images from a public HTTPS page.", queries: WEBSITE_QUERIES },
  { id: "news", kind: "public_web", description: "Discover and read a public RSS or Atom feed for the latest news articles, including headlines, summaries, dates, links, and thumbnails.", queries: NEWS_QUERIES },
  { id: "android_device_info", kind: "on_device", description: "Read the host Android device's current battery, Bluetooth/Wi-Fi, network, storage, power-saver, model, and OS values.", metrics: DEVICE_METRICS },
  { id: "clock", kind: "on_device", description: "Read the device-local clock; clock components update using Android's widget lifecycle." },
] as const;
