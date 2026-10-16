//! Automatic proxy discovery for the geo-gated F1 live-timing archive.
//!
//! F1 geo-gates `livetiming.formula1.com/static/` at the CloudFront edge: blocked
//! regions get a 401, while the live feed and the archive-from-allowed-regions
//! work fine. When the direct route is blocked, this module fetches a public
//! free-proxy list, tests candidates against the archive in parallel, and uses
//! the first that actually returns the archive — so a server in a blocked region
//! reaches the archive without any hardcoded proxy. The decision is cached and
//! periodically re-probed; a manual `HOTLAP_ARCHIVE_PROXY` always wins, and
//! `HOTLAP_NO_AUTO_PROXY` disables discovery entirely.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Public free-proxy list (HTTP proxies in regions that can reach the archive).
const LIST_URL: &str = "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=protocolipport&format=text&timeout=4000&country=us,gb,de,nl,fr,ca,ie,se";
/// A small archive file used to prove a route actually reaches the archive.
const PROBE_URL: &str = "https://livetiming.formula1.com/static/2026/Index.json";
const ARCHIVE_HOST: &str = "livetiming.formula1.com";

/// How long a resolved route (direct or a specific proxy) is trusted before a
/// re-probe. Keeps discovery off the hot path once something works.
const TTL: Duration = Duration::from_secs(20 * 60);
/// How long to remember "no route worked" before trying the whole dance again.
const FAIL_TTL: Duration = Duration::from_secs(2 * 60);
const MAX_CANDIDATES: usize = 24;
const TEST_TIMEOUT: Duration = Duration::from_secs(8);
const PARALLEL: usize = 12;

#[derive(Clone)]
enum Route {
    /// The archive is reachable directly (or discovery is off/failed).
    Direct,
    /// Route archive requests through this proxy.
    Via(reqwest::Url),
}

static CACHE: Mutex<Option<(Route, Instant)>> = Mutex::new(None);

fn cached() -> Option<Route> {
    let g = CACHE.lock().unwrap();
    match &*g {
        Some((Route::Via(u), t)) if t.elapsed() < TTL => Some(Route::Via(u.clone())),
        Some((Route::Direct, t)) if t.elapsed() < FAIL_TTL => Some(Route::Direct),
        _ => None,
    }
}

fn store(route: Route) {
    *CACHE.lock().unwrap() = Some((route, Instant::now()));
}

/// Resolve how to reach the archive, returning a proxy URL to use (or `None` for
/// a direct connection). Order: manual override → cache → direct probe →
/// auto-discovery of a working free proxy.
pub async fn resolve_archive() -> Option<reqwest::Url> {
    // 1. Manual override always wins.
    if let Some(raw) = std::env::var("HOTLAP_ARCHIVE_PROXY").ok().filter(|s| !s.trim().is_empty()) {
        return reqwest::Url::parse(raw.trim()).ok();
    }
    // 2. Opt out of auto-discovery.
    if std::env::var("HOTLAP_NO_AUTO_PROXY").is_ok_and(|v| v != "0" && !v.is_empty()) {
        return None;
    }
    // 3. Trust a recent decision.
    if let Some(route) = cached() {
        return match route {
            Route::Direct => None,
            Route::Via(u) => Some(u),
        };
    }
    // 4. Probe the direct route; if the archive answers, no proxy needed.
    if probe(&direct_client(), PROBE_URL).await {
        tracing::info!("archive reachable directly");
        store(Route::Direct);
        return None;
    }
    // 5. Blocked: discover a working proxy from the public list.
    tracing::info!("archive appears geo-blocked; discovering a working proxy…");
    if let Some(url) = discover().await {
        tracing::info!(proxy = %url, "using discovered proxy for the F1 archive");
        store(Route::Via(url.clone()));
        return Some(url);
    }
    tracing::warn!("no working archive proxy found; will use the fallback source");
    store(Route::Direct);
    None
}

fn direct_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("hotlap")
        .timeout(TEST_TIMEOUT)
        .build()
        .unwrap_or_default()
}

/// True if `url` fetched through `client` returns the archive (200 + JSON body).
async fn probe(client: &reqwest::Client, url: &str) -> bool {
    match client.get(url).send().await {
        Ok(r) if r.status().as_u16() == 200 => {
            r.text().await.map(|t| t.contains("Meetings")).unwrap_or(false)
        }
        _ => false,
    }
}

/// Fetch the free-proxy list and test candidates in parallel; return the first
/// that actually reaches the archive.
async fn discover() -> Option<reqwest::Url> {
    let list = fetch_list().await;
    if list.is_empty() {
        return None;
    }
    let mut set = tokio::task::JoinSet::new();
    let mut iter = list.into_iter().take(MAX_CANDIDATES);
    // Prime a bounded number of concurrent tests.
    for _ in 0..PARALLEL {
        if let Some(p) = iter.next() {
            set.spawn(test(p));
        }
    }
    while let Some(res) = set.join_next().await {
        if let Ok(Some(url)) = res {
            set.abort_all();
            return Some(url);
        }
        // Keep the pipeline full as tests finish.
        if let Some(p) = iter.next() {
            set.spawn(test(p));
        }
    }
    None
}

/// Test a single proxy against the archive; returns it if it works.
async fn test(proxy: reqwest::Url) -> Option<reqwest::Url> {
    let p = proxy.clone();
    let proxy_rule = reqwest::Proxy::custom(move |req| {
        (req.host_str() == Some(ARCHIVE_HOST)).then(|| p.clone())
    });
    let client = reqwest::Client::builder()
        .user_agent("hotlap")
        .timeout(TEST_TIMEOUT)
        .proxy(proxy_rule)
        .build()
        .ok()?;
    probe(&client, PROBE_URL).await.then_some(proxy)
}

async fn fetch_list() -> Vec<reqwest::Url> {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let txt = match client.get(LIST_URL).send().await.and_then(|r| r.error_for_status()) {
        Ok(r) => r.text().await.unwrap_or_default(),
        Err(e) => {
            tracing::warn!(error = %e, "could not fetch proxy list");
            return Vec::new();
        }
    };
    txt.lines()
        .filter_map(|l| reqwest::Url::parse(l.trim()).ok())
        .collect()
}
