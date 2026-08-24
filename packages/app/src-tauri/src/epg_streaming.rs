//! Streaming EPG Parser
//!
//! This module provides high-performance streaming XMLTV parsing that:
//! - Streams the download through the (optionally gzip) decoder into a SINGLE
//!   parse pass — download and parse overlap, and the decompressed XML is
//!   never materialized as a whole. Parsed batches are spooled in memory until
//!   the download is verified (clean end + content-length satisfied + XMLTV
//!   head probe) and only then swapped in, so a bad/partial download never
//!   replaces existing data
//! - Pipelined inserts (file path) or spool-then-insert (network path)
//! - Inserts with honest timing: the insert connection runs with
//!   busy_timeout=0, lock contention is retried with measured sleeps, and
//!   lock_wait_ms is reported separately from insert_ms so queueing vs. real
//!   writing can be told apart
//! - Sends progress updates to the frontend
//! - Handles large EPG files (>50MB) efficiently
//! - Supports multiple channels sharing the same tvg-id (primary + backup streams)

use std::collections::HashMap;
use std::error::Error;
use anyhow::{Context, Result};
use chrono::DateTime;
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use log::{error, info, warn};
use futures_util::StreamExt;

use crate::dvr::database::DvrDatabase;
use tauri::Emitter;

/// Retry a sync database operation with exponential backoff when "database is locked" occurs.
/// Serializes ALL EPG program writes (deletes, channel metadata, batch
/// inserts) across concurrent source syncs. SQLite allows only one writer at
/// a time; without this, N sources finishing their parses together thrash the
/// write lock — busy_timeout burns, retry budgets get exhausted, and
/// "database is locked" escapes into parse failures. With the mutex the
/// writes form one orderly queue, and the time spent queueing is exactly what
/// `lock_wait_ms` reports. A poisoned mutex (panicked holder) is recovered,
/// not propagated.
static EPG_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn with_sync_db_retry<F, T>(mut operation: F) -> Result<T>
where
    F: FnMut() -> Result<T>,
{
    let max_retries = 5;
    let mut last_error = None;

    for attempt in 1..=max_retries {
        match operation() {
            Ok(result) => return Ok(result),
            Err(e) => {
                let err_str = e.to_string().to_lowercase();
                if err_str.contains("database is locked") || err_str.contains("busy") {
                    if attempt < max_retries {
                        let delay_ms = 100 * attempt as u64;
                        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    }
                    last_error = Some(e);
                } else {
                    return Err(e);
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Max retries exceeded for database operation")))
}

/// Batch size for database inserts - optimized for modern NVMe SSDs
const BATCH_SIZE: usize = 25000;
/// Channel buffer size for pipelining (number of batches in flight)
const CHANNEL_BUFFER: usize = 4;
/// Progress update interval (every N batches)
const PROGRESS_INTERVAL: usize = 5;

/// Parse XMLTV date format: YYYYMMDDHHmmss +0000 -> ISO 8601
/// Returns the original string if parsing fails
fn parse_xmltv_date(date_str: &str) -> String {
    // XMLTV format: YYYYMMDDHHmmss +0000 (timezone is optional)
    // Examples: "20240223020000 +0000" or "20240223020000" or "20240223020000+0000"
    let trimmed = date_str.trim();

    // Try to parse with regex-like approach
    if trimmed.len() >= 14 {
        let year = &trimmed[0..4];
        let month = &trimmed[4..6];
        let day = &trimmed[6..8];
        let hour = &trimmed[8..10];
        let min = &trimmed[10..12];
        let sec = &trimmed[12..14];

        // Extract timezone if present (format: +0000 or -0500, with or without space)
        let tz = if trimmed.len() > 14 {
            // Look for + or - followed by 4 digits anywhere after the date part
            let remainder = &trimmed[14..];
            // Find the first + or - character
            if let Some(sign_pos) = remainder.find(|c| c == '+' || c == '-') {
                let tz_start = &remainder[sign_pos..];
                // Check if we have at least 5 chars (+/- plus 4 digits)
                if tz_start.len() >= 5 {
                    let tz_part = &tz_start[..5];
                    // Verify the format is +HHMM or -HHMM
                    if tz_part.chars().next().map(|c| c == '+' || c == '-').unwrap_or(false)
                        && tz_part[1..].chars().all(|c| c.is_ascii_digit())
                    {
                        // Convert +0000 to +00:00
                        format!("{}{}:{}", &tz_part[0..1], &tz_part[1..3], &tz_part[3..5])
                    } else {
                        "Z".to_string()
                    }
                } else {
                    "Z".to_string()
                }
            } else {
                "Z".to_string()
            }
        } else {
            "Z".to_string()
        };

        // Build ISO 8601: YYYY-MM-DDTHH:mm:ss+00:00
        format!("{}-{}-{}T{}:{}:{}{}", year, month, day, hour, min, sec, tz)
    } else {
        // Fallback: return original if it doesn't match expected format
        trimmed.to_string()
    }
}

/// An EPG program parsed from XMLTV
#[derive(Debug, Clone, Default)]
pub struct EpgProgram {
    pub channel_id: String,
    pub title: String,
    pub sub_title: Option<String>,
    pub description: Option<String>,
    pub start: String,  // ISO 8601 format
    pub stop: String,   // ISO 8601 format
}

/// Channel mapping from EPG channel ID to stream_id(s)
/// Supports multiple stream_ids for channels sharing the same tvg-id
#[derive(Debug, Clone, Deserialize)]
pub struct ChannelMapping {
    pub epg_channel_id: String,
    pub stream_id: String,
    pub channel_name: String,
}

/// Progress update sent to frontend
#[derive(Debug, Clone, Serialize)]
pub struct EpgParseProgress {
    pub source_id: String,
    pub phase: String,      // "streaming", "parsing", "inserting", "complete"
    pub bytes_downloaded: u64,
    pub total_bytes: Option<u64>,
    pub programs_parsed: usize,
    pub programs_matched: usize,
    pub programs_inserted: usize,
    pub estimated_remaining_seconds: Option<u64>,
}

/// Result of streaming EPG parse
#[derive(Debug, Clone, Serialize)]
pub struct EpgParseResult {
    pub source_id: String,
    pub total_programs: usize,
    pub matched_programs: usize,
    pub inserted_programs: usize,
    pub unmatched_channels: usize,
    pub matched_channels: usize,
    pub duration_ms: u64,
    pub bytes_processed: u64,
    /// Wall time spent downloading the EPG file (or reading it, for local files).
    pub download_ms: u64,
    /// Wall time spent decompressing (0 when the payload wasn't gzipped).
    pub decompress_ms: u64,
    /// Wall time spent parsing the XML (XMLTV -> matched programs).
    pub parse_ms: u64,
    /// Wall time spent inserting the parsed batches into the database
    /// (includes waiting for the SQLite write lock held by other sources).
    pub insert_ms: u64,
    /// Wall time of insert_ms that was spent waiting for the SQLite write
    /// lock (contention), not writing rows.
    pub lock_wait_ms: u64,
}

/// Configuration for one source in a multi-source EPG parse
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEpgConfig {
    pub source_id: String,
    pub source_name: String,
    pub channel_mappings: Vec<ChannelMapping>,
    pub advanced_epg_matching: bool,
    pub timeshift_hours: f64,
    pub clear_existing: bool,
}

/// Per-source stats accumulated during multi-source parsing
struct SourceParseStats {
    matched_programs: usize,
    unmatched_channels: std::collections::HashSet<String>,
    matched_channels: std::collections::HashSet<String>,
}

/// Normalize a channel name for fuzzy matching
/// Removes common prefixes, suffixes, and special characters
fn normalize_channel_name(name: &str) -> String {
    let name = name.trim();

    // Remove common prefixes (case insensitive)
    let prefixes = [
        "prime:", "il:", "f:", "ss:", "##", "####",
        "[", "]", "(", ")", "{", "}",
    ];
    let mut result = name.to_string();
    for prefix in &prefixes {
        if result.to_lowercase().starts_with(prefix) {
            result = result[prefix.len()..].to_string();
        }
    }

    // Remove superscript characters (ᴿᴬᵂ, ᴴᴰ, etc.)
    let superscripts = ['\u{1d3f}', '\u{1d2c}', '\u{1d42}', '\u{1d34}', '\u{1d35}', '\u{2076}', '\u{2070}', '\u{1da0}', '\u{1d56}', '\u{02e2}'];
    for ch in &superscripts {
        result = result.replace(*ch, "");
    }

    // Keep only alphanumeric characters and '+'
    result = result.chars()
        .filter(|c| c.is_alphanumeric() || *c == '+')
        .collect::<String>()
        .to_lowercase();

    result
}

/// Build a channel lookup map that supports multiple stream_ids per epg_channel_id
/// This allows primary + backup streams to all get the same EPG data
fn build_channel_lookup(mappings: Vec<ChannelMapping>) -> HashMap<String, Vec<String>> {
    let mut lookup: HashMap<String, Vec<String>> = HashMap::new();

    for mapping in mappings {
        let stream_id = mapping.stream_id;

        if !mapping.epg_channel_id.is_empty() {
            lookup
                .entry(mapping.epg_channel_id.trim().to_string())
                .or_default()
                .push(stream_id.clone());
        }

        // Also add name-based lookup for fallback
        if !mapping.channel_name.is_empty() {
            let name = mapping.channel_name.trim().to_string();
            lookup
                .entry(name.clone())
                .or_default()
                .push(stream_id.clone());

            // Also add normalized version for fuzzy matching
            let normalized = normalize_channel_name(&name);
            if normalized != name.to_lowercase() && !normalized.is_empty() {
                lookup
                    .entry(normalized)
                    .or_default()
                    .push(stream_id.clone());
            }
        }
    }

    dedupe_lookup_values(lookup)
}

/// Merge channel lookup with display name mapping from EPG XML
/// This creates bidirectional mappings between M3U names and EPG channel IDs
fn merge_with_display_names(
    mut channel_lookup: HashMap<String, Vec<String>>,
    display_name_mapping: &HashMap<String, String>,
) -> HashMap<String, Vec<String>> {
    // For each M3U channel name in channel_lookup, check if it matches
    // any EPG display name, and if so, also map the EPG channel ID
    let m3u_names: Vec<String> = channel_lookup.keys().cloned().collect();

    for m3u_name in m3u_names {
        let normalized_m3u = normalize_channel_name(&m3u_name);

        // Check if this M3U name (or its normalized version) matches any EPG display name
        if let Some(epg_channel_id) = display_name_mapping.get(&m3u_name)
            .or_else(|| display_name_mapping.get(&normalized_m3u))
        {
            // Get the stream_ids for this M3U name
            if let Some(stream_ids) = channel_lookup.get(&m3u_name).cloned() {
                // Also map the EPG channel ID to these stream_ids
                channel_lookup
                    .entry(epg_channel_id.clone())
                    .or_default()
                    .extend(stream_ids.clone());
            }
        }
    }

    dedupe_lookup_values(channel_lookup)
}

/// Remove duplicate stream_ids from every lookup vector.
///
/// The display-name merge can append the same stream_id to one
/// epg_channel_id key more than once: an M3U name, its normalized alias
/// key, and a matching display name can all extend the same vector. Each
/// vector entry means "emit one program copy for this stream", so
/// duplicates are pure wasted insert work — the INSERT's ON CONFLICT(id)
/// would otherwise dedupe them only after the row has been written. The
/// final DB state is identical either way; this just avoids the redundant
/// writes (feeds with heavy raw/normalized name collisions were inserting
/// several copies per program).
fn dedupe_lookup_values(
    mut lookup: HashMap<String, Vec<String>>,
) -> HashMap<String, Vec<String>> {
    for stream_ids in lookup.values_mut() {
        stream_ids.sort_unstable();
        stream_ids.dedup();
    }
    lookup
}

/// Stream and parse EPG XML from URL with true streaming and pipelining
pub async fn stream_parse_epg<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    db: &DvrDatabase,
    source_id: String,
    source_name: String,
    epg_url: String,
    channel_mappings: Vec<ChannelMapping>,
    advanced_epg_matching: bool,
    timeshift_hours: f64,
    clear_existing: bool,
    user_agent: Option<String>,
) -> Result<EpgParseResult> {
    let start_time = std::time::Instant::now();
    let src_ctx = format!("{} ({})", source_name, source_id);

    info!("Starting TRUE streaming EPG parse for source {} from {} (advanced matching: {}, clear_existing: {})", src_ctx, epg_url, advanced_epg_matching, clear_existing);

    // Build channel lookup map (supports multiple stream_ids per epg_channel_id)
    let channel_lookup = build_channel_lookup(channel_mappings);

    info!("Channel lookup has {} entries", channel_lookup.len());

    // Check if URL is gzipped
    let is_gzipped = epg_url.ends_with(".gz");

    // Create HTTP client with optimized settings and TLS configuration
    // Using native-tls to handle various certificate types including self-signed
    let ua = match user_agent {
        Some(ref u) if !u.trim().is_empty() => u.clone(),
        _ => "VLC/3.0.18 LibVLC/3.0.18".to_string(),
    };

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(12))
        .timeout(std::time::Duration::from_secs(300))
        .pool_max_idle_per_host(10)
        .danger_accept_invalid_certs(true)  // Accept self-signed/invalid certificates
        .danger_accept_invalid_hostnames(true)  // Accept invalid hostnames
        .user_agent(ua)
        .build()
        .context("Failed to create HTTP client")?;

    // Start download with streaming
    emit_progress(
        &app_handle,
        &source_id,
        EpgParseProgress {
            source_id: source_id.clone(),
            phase: "streaming".to_string(),
            bytes_downloaded: 0,
            total_bytes: None,
            programs_parsed: 0,
            programs_matched: 0,
            programs_inserted: 0,
            estimated_remaining_seconds: None,
        },
    );

    let response = match client
        .get(&epg_url)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            // Extract detailed error information
            let err_source = e.source().map(|s| s.to_string()).unwrap_or_else(|| "unknown".to_string());
            let err_kind = format!("{:?}", e);
            
            let err_msg = format!(
                "Failed to download EPG from {}: {} (source: {}, kind: {})", 
                epg_url, e, err_source, err_kind
            );
            error!("[EPG] {}", err_msg);
            return Err(anyhow::anyhow!(err_msg));
        }
    };

    let response = match response.error_for_status() {
        Ok(resp) => resp,
        Err(e) => {
            let err_msg = format!("HTTP error from EPG URL {}: {}", epg_url, e);
            error!("[EPG] {}", err_msg);
            return Err(anyhow::anyhow!(err_msg));
        }
    };

    let total_bytes = response.content_length();
    info!("EPG download started, total size: {:?} bytes", total_bytes);

    // Check if response is actually gzipped (server may return gzip even if URL doesn't end with .gz)
    let is_response_gzipped = response.headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_lowercase().contains("gzip"))
        .unwrap_or(false);
    let should_decompress = is_gzipped || is_response_gzipped;
    if should_decompress {
        info!("[EPG] Will decompress response (URL gzipped: {}, Content-Encoding: {})",
            is_gzipped,
            response.headers().get("content-encoding").and_then(|v| v.to_str().ok()).unwrap_or("none")
        );
    }

    // SQLite old programs deletion is now deferred to parse_download_stream 
    // to ensure download succeeds first

    // Create channel for parse->insert pipeline
    let (batch_tx, batch_rx) = mpsc::channel::<Vec<EpgProgram>>(CHANNEL_BUFFER);

    // Clone for parser task
    let channel_lookup_clone = channel_lookup.clone();
    let source_id_clone = source_id.clone();
    let app_handle_clone = app_handle.clone();
    let db_clone = db.clone();
    let src_ctx_clone = src_ctx.clone();

    // Spawn parser task that downloads and parses concurrently
    let parser_task = tokio::spawn(async move {
        parse_download_stream(
            response,
            channel_lookup_clone,
            batch_tx,
            app_handle_clone,
            source_id_clone,
            total_bytes,
            is_gzipped,
            advanced_epg_matching,
            db_clone,
            src_ctx_clone,
            timeshift_hours,
            clear_existing,
        ).await
    });

    // Run inserter task concurrently
    let inserter_result = insert_batches_pipeline(
        db,
        batch_rx,
        &source_id,
        app_handle.clone(),
        total_bytes,
        start_time,
    ).await;

    // Wait for parser to complete. Propagate the inner error as-is so real
    // failures (download, XMLTV probe, DB) are visible to the UI instead of
    // being hidden behind a generic "Parser task failed" wrapper.
    let parser_result = parser_task.await.context("EPG parser task panicked")??;
    // A batch that exhausted its retry budget is a data-loss event (the old
    // programs were already deleted for this source) — surface it instead of
    // reporting a silent partial insert.
    let inserter_result = inserter_result?;

    let duration_ms = start_time.elapsed().as_millis() as u64;

    let result = EpgParseResult {
        source_id: source_id.clone(),
        total_programs: parser_result.total_programs,
        matched_programs: parser_result.matched_programs,
        inserted_programs: inserter_result.inserted,
        unmatched_channels: parser_result.unmatched_channels,
        matched_channels: parser_result.matched_channels,
        duration_ms,
        bytes_processed: parser_result.bytes_processed,
        download_ms: parser_result.download_ms,
        decompress_ms: parser_result.decompress_ms,
        parse_ms: parser_result.parse_ms,
        insert_ms: inserter_result.insert_ms,
        lock_wait_ms: inserter_result.lock_wait_ms,
    };

    info!(
        "[EPG TIMING] source=\"{}\" url=\"{}\" download_ms={} decompress_ms={} parse_ms={} insert_ms={} lock_wait_ms={} total_ms={} bytes={} programs={} matched={} inserted={} unmatched_channels={}",
        src_ctx, epg_url,
        result.download_ms, result.decompress_ms, result.parse_ms, result.insert_ms,
        result.lock_wait_ms,
        result.duration_ms, result.bytes_processed,
        result.total_programs, result.matched_programs, result.inserted_programs,
        result.unmatched_channels
    );

    append_epg_timing_record(&app_handle, &source_id, &source_name, &epg_url, &result);

    Ok(result)
}

// =============================================================================
// Multi-source streaming EPG parse (download once, apply to many sources)
// =============================================================================

/// Stream and parse EPG XML from URL for multiple sources with a single download.
/// Each source gets programmes for its own channels. Waterfall-safe: clear_existing
/// is respected per source (typically false for global EPG gap-filling).
pub async fn stream_parse_epg_multi<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    db: &DvrDatabase,
    epg_url: String,
    source_configs: Vec<SourceEpgConfig>,
    user_agent: Option<String>,
) -> Result<Vec<EpgParseResult>> {
    let start_time = std::time::Instant::now();
    let source_count = source_configs.len();

    if source_configs.is_empty() {
        return Ok(Vec::new());
    }

    info!(
        "Starting multi-source EPG parse for {} source(s) from {}",
        source_count, epg_url
    );

    // Check if URL is gzipped
    let is_gzipped = epg_url.ends_with(".gz");

    // Create HTTP client
    let ua = match user_agent {
        Some(ref u) if !u.trim().is_empty() => u.clone(),
        _ => "VLC/3.0.18 LibVLC/3.0.18".to_string(),
    };

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(12))
        .timeout(std::time::Duration::from_secs(300))
        .pool_max_idle_per_host(10)
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .user_agent(ua)
        .build()
        .context("Failed to create HTTP client")?;

    // Download
    let response = match client.get(&epg_url).send().await {
        Ok(resp) => resp,
        Err(e) => {
            let err_msg = format!("Failed to download EPG from {}: {}", epg_url, e);
            error!("[EPG] {}", err_msg);
            return Err(anyhow::anyhow!(err_msg));
        }
    };

    let response = match response.error_for_status() {
        Ok(resp) => resp,
        Err(e) => {
            let err_msg = format!("HTTP error from EPG URL {}: {}", epg_url, e);
            error!("[EPG] {}", err_msg);
            return Err(anyhow::anyhow!(err_msg));
        }
    };

    let total_bytes = response.content_length();
    info!("EPG download started, total size: {:?} bytes", total_bytes);

    let is_response_gzipped = response.headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_lowercase().contains("gzip"))
        .unwrap_or(false);
    let should_decompress = is_gzipped || is_response_gzipped;

    // Download chunks into memory
    let download_start = std::time::Instant::now();
    let mut chunks: Vec<bytes::Bytes> = Vec::new();
    let mut total_bytes_downloaded: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                total_bytes_downloaded += chunk.len() as u64;
                chunks.push(chunk);
            }
            Err(e) => {
                warn!("Download error: {}", e);
                return Err(anyhow::anyhow!("Download interrupted: {}", e));
            }
        }
    }

    let download_ms = download_start.elapsed().as_millis() as u64;

    if let Some(expected) = total_bytes {
        if total_bytes_downloaded < expected {
            return Err(anyhow::anyhow!(
                "Incomplete EPG download: expected {} bytes but got {}",
                expected, total_bytes_downloaded
            ));
        }
    }

    info!("[EPG] EPG Download verified successful.");

    // Combine chunks
    let total_size = chunks.iter().map(|c| c.len()).sum::<usize>();
    let mut compressed_data = Vec::with_capacity(total_size);
    for chunk in chunks {
        compressed_data.extend_from_slice(&chunk);
    }

    let has_gzip_magic = compressed_data.len() >= 2
        && compressed_data[0] == 0x1f && compressed_data[1] == 0x8b;
    let should_decompress = should_decompress || has_gzip_magic;

    // Decompress
    let decompress_start = std::time::Instant::now();
    let xml_data: Vec<u8> = if should_decompress {
        use flate2::read::MultiGzDecoder;
        use std::io::Read;
        // MultiGzDecoder: handles concatenated gzip members (plain GzDecoder
        // silently truncates at the first member boundary) — parity with the
        // single-source parser.
        let mut decoder = MultiGzDecoder::new(&compressed_data[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed)
            .context("Failed to decompress gzipped EPG")?;
        info!("[EPG] Decompressed {} bytes to {} bytes", compressed_data.len(), decompressed.len());
        decompressed
    } else {
        compressed_data
    };
    let decompress_ms = decompress_start.elapsed().as_millis() as u64;

    // Extract EPG channel metadata once, insert for all sources
    let epg_channels = extract_epg_channels(&xml_data);

    // Guard against applying an empty/garbage response (e.g. an HTTP error page
    // served with status 200) which would otherwise wipe per-source epg_channels
    // and report a bogus success. Keep existing EPG data intact instead.
    let has_programmes = xml_data
        .windows(b"<programme".len())
        .any(|w| w == b"<programme");
    if epg_channels.is_empty() && !has_programmes {
        return Err(anyhow::anyhow!(
            "EPG response from {} contained no channels or programmes; keeping existing EPG data",
            epg_url
        ));
    }

    for config in &source_configs {
        if let Err(e) = insert_epg_channels(db, &config.source_id, &epg_channels) {
            warn!("[EPG] Failed to insert epg_channels for source {}: {}", config.source_id, e);
        }
    }

    // Delete old programs for sources that request it (after verified download)
    for config in &source_configs {
        if config.clear_existing {
            let deleted = delete_programs_for_source(db, &config.source_id)?;
            info!("[EPG] Deleted {} old programs for source {}", deleted, config.source_id);
        }
    }

    // Build the display-name mapping ONCE (a full XML scan) if any source needs
    // advanced matching, then reuse it for all sources — previously this ran a
    // full re-scan of the document once per source.
    let display_mapping: Option<HashMap<String, String>> =
        if source_configs.iter().any(|c| c.advanced_epg_matching) {
            info!("[EPG] Advanced EPG matching enabled - building display name mappings once");
            Some(build_display_name_mapping(&xml_data))
        } else {
            None
        };

    // Build master channel lookup: epg_channel_id -> Vec<(source_id, stream_id)>
    let mut master_lookup: HashMap<String, Vec<(String, String)>> = HashMap::new();

    for config in &source_configs {
        let mut source_lookup = build_channel_lookup(config.channel_mappings.clone());

        // If advanced matching enabled for this source, merge display names
        // using the shared (hoisted) mapping.
        if config.advanced_epg_matching {
            if let Some(ref dm) = display_mapping {
                source_lookup = merge_with_display_names(source_lookup, dm);
            }
        }

        for (epg_id, stream_ids) in source_lookup {
            let entry = master_lookup.entry(epg_id).or_default();
            for stream_id in stream_ids {
                entry.push((config.source_id.clone(), stream_id));
            }
        }
    }

    info!("[EPG] Master lookup has {} entries for {} sources", master_lookup.len(), source_count);

    // Create per-source batch channels and inserter tasks
    let mut batch_senders: HashMap<String, mpsc::Sender<Vec<EpgProgram>>> = HashMap::new();
    let mut inserter_handles: Vec<tokio::task::JoinHandle<anyhow::Result<InserterResult>>> = Vec::new();

    for config in &source_configs {
        let (batch_tx, batch_rx) = mpsc::channel::<Vec<EpgProgram>>(CHANNEL_BUFFER);
        let sid = config.source_id.clone();
        let db_clone = db.clone();
        let app_clone = app_handle.clone();

        let handle = tokio::spawn(async move {
            insert_batches_pipeline(&db_clone, batch_rx, &sid, app_clone, total_bytes, start_time).await
        });

        batch_senders.insert(config.source_id.clone(), batch_tx);
        inserter_handles.push(handle);
    }

    // Parse once, route programmes to per-source batches
    let parse_start = std::time::Instant::now();
    let parse_result = parse_and_stream_batches_multi(
        &xml_data,
        master_lookup,
        batch_senders,
        app_handle.clone(),
        total_bytes,
        total_bytes_downloaded,
        start_time,
    ).await?;
    let parse_ms = parse_start.elapsed().as_millis() as u64;

    // Wait for all inserters to finish
    let mut per_source_inserted: HashMap<String, usize> = HashMap::new();
    let mut per_source_insert_ms: HashMap<String, u64> = HashMap::new();
    let mut per_source_lock_wait_ms: HashMap<String, u64> = HashMap::new();
    for (i, handle) in inserter_handles.into_iter().enumerate() {
        let sid = source_configs[i].source_id.clone();
        match handle.await {
            Ok(Ok(result)) => {
                per_source_insert_ms.insert(sid.clone(), result.insert_ms);
                per_source_lock_wait_ms.insert(sid.clone(), result.lock_wait_ms);
                per_source_inserted.insert(sid, result.inserted);
            }
            Ok(Err(e)) => {
                // Per-source insert failure (e.g. a batch exhausted its retry
                // budget) — record 0 for this source so the gap is visible,
                // but don't fail the other sources in this multi-source parse.
                warn!("[EPG] Inserter failed for source {}: {}", sid, e);
                per_source_insert_ms.insert(sid.clone(), 0);
                per_source_lock_wait_ms.insert(sid.clone(), 0);
                per_source_inserted.insert(sid, 0);
            }
            Err(e) => {
                warn!("[EPG] Inserter task panicked for source {}: {}", sid, e);
                per_source_insert_ms.insert(sid.clone(), 0);
                per_source_lock_wait_ms.insert(sid, 0);
            }
        }
    }

    let duration_ms = start_time.elapsed().as_millis() as u64;

    // Build per-source results
    let mut results = Vec::with_capacity(source_configs.len());
    for config in &source_configs {
        let sid = &config.source_id;
        let stats = parse_result.source_stats.get(sid);
        let inserted = per_source_inserted.get(sid).copied().unwrap_or(0);
        let insert_ms = per_source_insert_ms.get(sid).copied().unwrap_or(0);
        let lock_wait_ms = per_source_lock_wait_ms.get(sid).copied().unwrap_or(0);

        let matched = stats.map(|s| s.matched_programs).unwrap_or(0);
        let unmatched = stats.map(|s| s.unmatched_channels.len()).unwrap_or(0);
        let matched_ch = stats.map(|s| s.matched_channels.len()).unwrap_or(0);

        let result = EpgParseResult {
            source_id: sid.clone(),
            total_programs: parse_result.total_programs,
            matched_programs: matched,
            inserted_programs: inserted,
            unmatched_channels: unmatched,
            matched_channels: matched_ch,
            duration_ms,
            bytes_processed: parse_result.bytes_processed,
            download_ms,
            decompress_ms,
            parse_ms,
            insert_ms,
            lock_wait_ms,
        };

        info!(
            "[EPG TIMING] source=\"{}\" url=\"{}\" download_ms={} decompress_ms={} parse_ms={} insert_ms={} lock_wait_ms={} total_ms={} bytes={} programs={} matched={} inserted={} unmatched_channels={}",
            sid, epg_url,
            result.download_ms, result.decompress_ms, result.parse_ms, result.insert_ms,
            result.lock_wait_ms,
            result.duration_ms, result.bytes_processed,
            result.total_programs, result.matched_programs, result.inserted_programs,
            result.unmatched_channels
        );

        append_epg_timing_record(&app_handle, sid, &config.source_name, &epg_url, &result);

        results.push(result);
    }

    info!(
        "Multi-source EPG parse complete: {} total programs, {} sources, {}ms",
        parse_result.total_programs, source_count, duration_ms
    );

    Ok(results)
}

/// Aggregated parser result from multi-source streaming parse
struct MultiSourceParserResult {
    total_programs: usize,
    bytes_processed: u64,
    source_stats: HashMap<String, SourceParseStats>,
}
struct StreamingParserResult {
    total_programs: usize,
    matched_programs: usize,
    unmatched_channels: usize,
    matched_channels: usize,
    bytes_processed: u64,
    /// Wall time spent downloading the EPG file (or reading it, for local files).
    download_ms: u64,
    /// Wall time spent decompressing (0 when the payload wasn't gzipped).
    decompress_ms: u64,
    /// Wall time spent parsing the XML into matched programmes.
    parse_ms: u64,
}

/// Result of the spooled network parse: parsed batches held in memory until
/// the download has been verified (clean end + XMLTV head), then swapped in.
struct SpooledParse {
    spool: Vec<Vec<EpgProgram>>,
    channels: Vec<EpgChannelInfo>,
    result: StreamingParserResult,
}

/// Parse EPG by downloading chunks and parsing incrementally
/// Handles both plain XML and gzipped XML (.xml.gz)
async fn parse_download_stream<R: tauri::Runtime>(
    response: reqwest::Response,
    channel_lookup: HashMap<String, Vec<String>>,
    batch_tx: mpsc::Sender<Vec<EpgProgram>>,
    app_handle: tauri::AppHandle<R>,
    source_id: String,
    total_bytes: Option<u64>,
    is_gzipped: bool,
    advanced_epg_matching: bool,
    db: crate::dvr::database::DvrDatabase,
    src_ctx: String,
    timeshift_hours: f64,
    clear_existing: bool,
) -> Result<StreamingParserResult> {
    let start_time = std::time::Instant::now();

    // Check if response is actually gzipped BEFORE consuming response body
    let content_encoding = response
        .headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "none".to_string());

    // Bridge the async download into a synchronous byte stream so the parse
    // (a sync, CPU-bound single pass) consumes chunks as they arrive — download
    // and parse now OVERLAP instead of running serially.
    //
    // Safety is unchanged: nothing is deleted until the download finishes
    // cleanly (no network error, content-length satisfied) AND the head of the
    // payload is confirmed to be XMLTV. Parsed batches are spooled in memory
    // during the download and only handed to the inserter after that swap
    // point, so a bad/partial download never replaces existing programs.
    // tokio mpsc: the download task awaits `send` when the channel is full
    // (true async backpressure — no busy-polling that would throttle the
    // download to ~one chunk per ms), and the reader side uses
    // `blocking_recv` on the blocking thread pool.
    let (chunk_tx, chunk_rx) = tokio::sync::mpsc::channel::<bytes::Bytes>(16);

    let downloaded_total = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let download_finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let download_errored = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let download_finished_ms = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

    let dl_total = downloaded_total.clone();
    let dl_finished = download_finished.clone();
    let dl_errored = download_errored.clone();
    let dl_finished_ms = download_finished_ms.clone();
    let dl_start = start_time;

    // Handle deliberately dropped: the task ends itself when the stream does.
    let _download_task = tokio::spawn(async move {
        let mut stream = response.bytes_stream();
        while let Some(chunk_result) = stream.next().await {
            match chunk_result {
                Ok(chunk) => {
                    dl_total.fetch_add(
                        chunk.len() as u64,
                        std::sync::atomic::Ordering::Relaxed,
                    );
                    // send().await yields the worker while the channel is full
                    // (the parser on the blocking pool drains it) — proper
                    // backpressure without blocking a worker or throttling.
                    if chunk_tx.send(chunk).await.is_err() {
                        // Parser is gone — stop downloading.
                        return;
                    }
                }
                Err(e) => {
                    warn!("Download error: {}", e);
                    dl_errored.store(true, std::sync::atomic::Ordering::Relaxed);
                    // Dropping chunk_tx makes the parser see a clean EOF; the
                    // errored flag below prevents any swap.
                    return;
                }
            }
        }
        dl_finished.store(true, std::sync::atomic::Ordering::Relaxed);
        dl_finished_ms.store(
            dl_start.elapsed().as_millis() as u64,
            std::sync::atomic::Ordering::Relaxed,
        );
        // chunk_tx dropped here -> clean EOF for the parser
    });

    // Sync reader over the channel (blocks only a blocking thread, never a
    // tokio worker).
    struct ChunkBridge {
        rx: tokio::sync::mpsc::Receiver<bytes::Bytes>,
        current: std::io::Cursor<bytes::Bytes>,
        eof: bool,
    }

    impl std::io::Read for ChunkBridge {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.current.position() >= self.current.get_ref().len() as u64 {
                if self.eof {
                    return Ok(0);
                }
                match self.rx.blocking_recv() {
                    Some(bytes) => {
                        self.current = std::io::Cursor::new(bytes);
                    }
                    None => {
                        // Channel closed = the download task ended.
                        self.eof = true;
                        return Ok(0);
                    }
                }
            }
            self.current.read(buf)
        }
    }

    let mut bridge = ChunkBridge {
        rx: chunk_rx,
        current: std::io::Cursor::new(bytes::Bytes::new()),
        eof: false,
    };

    // NOTE: everything that reads from `bridge` (the gzip-magic peek, the
    // XMLTV head probe, the parse) happens inside the spawn_blocking task
    // below. The bridge blocks on channel recv while waiting for the next
    // download chunk, and blocking a tokio worker here deadlocks once enough
    // concurrent sources park their workers (each waits on a chunk that only
    // another worker's download task can deliver). The blocking thread pool
    // has no such coupling, so ALL bridge reads must stay in spawn_blocking.

    emit_progress(
        &app_handle,
        &source_id,
        EpgParseProgress {
            source_id: source_id.to_string(),
            phase: "parsing".to_string(),
            bytes_downloaded: 0,
            total_bytes,
            programs_parsed: 0,
            programs_matched: 0,
            programs_inserted: 0,
            estimated_remaining_seconds: None,
        },
    );

    // Run the probe + single-pass parse on a blocking thread while the
    // download task keeps feeding the bridge — download and parse overlap.
    let app_handle_clone = app_handle.clone();
    let source_id_clone = source_id.clone();
    let src_ctx_clone = src_ctx.clone();
    let dl_progress = downloaded_total.clone();
    let parse_start = std::time::Instant::now();

    let blocking = tokio::task::spawn_blocking(move || -> Result<SpooledParse> {
        use std::io::Read;

        // Peek the first two bytes for the gzip magic, then hand the stream to
        // the (de)compression layer. Magic bytes are the authoritative gzip
        // signal: reqwest auto-decompresses Content-Encoding: gzip and strips
        // the header, so neither the URL suffix nor the header alone means the
        // body is still compressed — trusting both could double-decompress and
        // hard-fail. (Runs here on a blocking thread: the peek waits for the
        // first download chunk and must never block a tokio worker.)
        let mut first_two = [0u8; 2];
        let mut filled = 0usize;
        while filled < 2 {
            let n = bridge.read(&mut first_two[filled..])?;
            if n == 0 {
                break; // empty body
            }
            filled += n;
        }
        let has_gzip_magic = filled == 2 && first_two[0] == 0x1f && first_two[1] == 0x8b;
        if has_gzip_magic {
            info!(
                "[EPG] Decompressing response (URL gzipped: {}, Content-Encoding: {})",
                is_gzipped, content_encoding
            );
        }

        // Decoder over the bridge: decompressed stream for gzip, passthrough
        // otherwise.
        let prefix = std::io::Cursor::new(first_two.to_vec());
        let mut dec: Box<dyn Read + Send> = if has_gzip_magic {
            let inner = std::io::BufReader::with_capacity(256 * 1024, prefix.chain(bridge));
            // MultiGzDecoder: handles concatenated gzip members (plain
            // GzDecoder silently truncates at the first member boundary).
            Box::new(flate2::bufread::MultiGzDecoder::new(inner))
        } else {
            Box::new(prefix.chain(bridge))
        };

        // Guard: verify the payload actually looks like XMLTV BEFORE any swap
        // (protects against HTTP error pages / garbage served with status 200
        // wiping the guide). Consumes up to 256KB from the stream; the bytes
        // are replayed below so nothing is lost.
        let mut head = Vec::with_capacity(256 * 1024);
        let _ = (&mut dec).take(256 * 1024).read_to_end(&mut head);
        let head_is_xmltv = {
            let s = String::from_utf8_lossy(&head);
            s.contains("<programme") || s.contains("<tv")
        };
        if !head_is_xmltv {
            return Err(anyhow::anyhow!(
                "EPG response from {} contained no XMLTV data (channels/programmes); keeping existing EPG data",
                src_ctx_clone
            ));
        }

        let reader = std::io::BufReader::with_capacity(
            256 * 1024,
            std::io::Cursor::new(head).chain(dec),
        );

        let mut last_progress_update = std::time::Instant::now();
        let mut on_progress = |parsed: usize, matched: usize| {
            if last_progress_update.elapsed().as_millis() > 100 {
                emit_progress(
                    &app_handle_clone,
                    &source_id_clone,
                    EpgParseProgress {
                        source_id: source_id_clone.to_string(),
                        phase: "parsing".to_string(),
                        bytes_downloaded: dl_progress
                            .load(std::sync::atomic::Ordering::Relaxed),
                        total_bytes,
                        programs_parsed: parsed,
                        programs_matched: matched,
                        programs_inserted: 0,
                        estimated_remaining_seconds: estimate_remaining(
                            dl_progress.load(std::sync::atomic::Ordering::Relaxed),
                            total_bytes,
                            start_time.elapsed().as_secs(),
                        ),
                    },
                );
                last_progress_update = std::time::Instant::now();
            }
        };

        // Single pass. Batches are spooled in memory until the download has
        // been verified and the swap point below is reached.
        let mut spool: Vec<Vec<EpgProgram>> = Vec::new();
        let mut sink = |batch: Vec<EpgProgram>| {
            spool.push(batch);
            true
        };

        let (channels, result) = parse_and_stream_epg_once(
            reader,
            channel_lookup,
            advanced_epg_matching,
            timeshift_hours,
            &mut sink,
            &mut on_progress,
        )?;

        Ok(SpooledParse {
            spool,
            channels,
            result,
        })
    });

    let spooled = blocking.await.context("EPG parse task panicked")??;
    let parse_ms = parse_start.elapsed().as_millis() as u64;

    // The parser reads to EOF, which only happens once the download task has
    // ended, so the download wall is complete by now. Prefer the network-side
    // stamp (pure download duration); fall back to elapsed as a safety net.
    let download_ms = {
        let stamped = download_finished_ms.load(std::sync::atomic::Ordering::Relaxed);
        if stamped == 0 {
            start_time.elapsed().as_millis() as u64
        } else {
            stamped
        }
    };
    let total_bytes_downloaded = downloaded_total.load(std::sync::atomic::Ordering::Relaxed);

    // Verify the download before swapping anything.
    if download_errored.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(anyhow::anyhow!(
            "EPG download for {} was interrupted by a network error; keeping existing EPG data",
            src_ctx
        ));
    }
    if !download_finished.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(anyhow::anyhow!(
            "EPG download for {} did not complete; keeping existing EPG data",
            src_ctx
        ));
    }
    if let Some(expected_len) = total_bytes {
        if total_bytes_downloaded < expected_len {
            return Err(anyhow::anyhow!(
                "Incomplete EPG download: expected {} bytes but got {}; keeping existing EPG data",
                expected_len, total_bytes_downloaded
            ));
        }
    }

    // Swap point: download verified AND payload is XMLTV (probe passed inside
    // the blocking task). Safe to replace old programs now.
    info!(
        "[EPG] EPG Download verified successful ({} bytes).",
        total_bytes_downloaded
    );
    if clear_existing {
        info!("[EPG] Deleting old programs for source {}", src_ctx);
        let deleted_count = delete_programs_for_source(&db, &source_id)?;
        info!("[EPG] Deleted {} old programs for source {}", deleted_count, src_ctx);
    } else {
        info!("[EPG] Skipping deletion of old programs because clear_existing is false");
    }

    // Persist channel metadata for the channel editor (collected in the pass)
    if let Err(e) = insert_epg_channels(&db, &source_id, &spooled.channels) {
        warn!("[EPG] Failed to insert epg_channels for source {}: {}", source_id, e);
    }

    // Hand the spooled batches to the inserter pipeline (async try_send so a
    // busy inserter never blocks a tokio worker).
    for batch in spooled.spool {
        let mut pending = Some(batch);
        loop {
            match batch_tx.try_send(pending.take().expect("batch present")) {
                Ok(()) => break,
                Err(tokio::sync::mpsc::error::TrySendError::Full(b)) => {
                    pending = Some(b);
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                    warn!(
                        "[EPG] Inserter channel closed while draining spool for source {}",
                        source_id
                    );
                    break;
                }
            }
        }
    }

    // Signal the inserter that parsing is complete
    drop(batch_tx);

    let mut result = spooled.result;
    result.download_ms = download_ms;
    result.decompress_ms = 0; // overlapped with parsing in the streaming pass
    result.parse_ms = parse_ms;
    result.bytes_processed = total_bytes_downloaded;

    let total_ms = start_time.elapsed().as_millis() as u64;
    info!(
        "[EPG Timing] Download: {}ms, Stream-Parse (incl. decompress, incl. download wait): {}ms, Total: {}ms",
        download_ms, parse_ms, total_ms
    );

    Ok(result)
}

/// Build a mapping from display names to channel IDs by parsing <channel> elements
/// This allows matching M3U channel names like "US: BET" to EPG channel id "bet.us"
fn build_display_name_mapping(xml_data: &[u8]) -> HashMap<String, String> {
    let mut mapping: HashMap<String, String> = HashMap::new();
    let mut reader = Reader::from_reader(xml_data);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::with_capacity(4096);
    let mut current_channel_id: Option<String> = None;
    let mut current_element: Option<&'static str> = None;
    let mut current_text = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                let name = name.as_ref();
                match name {
                    b"channel" => {
                        // Parse channel id attribute
                        for attr in e.attributes() {
                            if let Ok(attr) = attr {
                                if attr.key.as_ref() == b"id" {
                                    let value = attr
                                        .decode_and_unescape_value(reader.decoder())
                                        .unwrap_or_default();
                                    current_channel_id = Some(value.to_string());
                                    break;
                                }
                            }
                        }
                    }
                    b"display-name" => {
                        current_element = Some("display-name");
                        current_text.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if current_element.is_some() {
                    if let Ok(text) = e.unescape() {
                        current_text.push_str(&text);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                let name = name.as_ref();
                match name {
                    b"channel" => {
                        current_channel_id = None;
                    }
                    b"display-name" => {
                        if let Some(ref channel_id) = current_channel_id {
                            let display_name = current_text.trim().to_string();
                            if !display_name.is_empty() {
                                // Add mapping from display name to channel ID
                                mapping.insert(display_name.clone(), channel_id.clone());
                                // Also add normalized version
                                let normalized = normalize_channel_name(&display_name);
                                if !normalized.is_empty() && normalized != display_name.to_lowercase() {
                                    mapping.insert(normalized, channel_id.clone());
                                }
                            }
                        }
                        current_element = None;
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                warn!("XML parse error during display name extraction: {}", e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    info!("[EPG] Built display name mapping with {} entries", mapping.len());
    mapping
}

/// Info about an EPG channel extracted from XMLTV <channel> elements
#[derive(Debug, Clone)]
struct EpgChannelInfo {
    id: String,
    display_name: String,
    icon_url: Option<String>,
}

/// Extract all <channel> elements from XMLTV data.
/// Collects id, first <display-name>, and first <icon src="..."> for each channel.
fn extract_epg_channels(xml_data: &[u8]) -> Vec<EpgChannelInfo> {
    let mut channels: Vec<EpgChannelInfo> = Vec::new();
    let mut reader = Reader::from_reader(xml_data);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::with_capacity(4096);
    let mut current_channel_id: Option<String> = None;
    let mut current_display_name: Option<String> = None;
    let mut current_icon_url: Option<String> = None;
    let mut current_element: Option<&'static str> = None;
    let mut current_text = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                let name = name.as_ref();
                match name {
                    b"channel" => {
                        current_channel_id = None;
                        current_display_name = None;
                        current_icon_url = None;
                        for attr in e.attributes() {
                            if let Ok(attr) = attr {
                                if attr.key.as_ref() == b"id" {
                                    let value = attr
                                        .decode_and_unescape_value(reader.decoder())
                                        .unwrap_or_default();
                                    current_channel_id = Some(value.to_string());
                                    break;
                                }
                            }
                        }
                    }
                    b"display-name" | b"icon" => {
                        current_element = Some(if name == b"display-name" { "display-name" } else { "icon" });
                        current_text.clear();

                        // For <icon>, also try to read src attribute immediately
                        if name == b"icon" {
                            for attr in e.attributes() {
                                if let Ok(attr) = attr {
                                    if attr.key.as_ref() == b"src" {
                                        let value = attr
                                            .decode_and_unescape_value(reader.decoder())
                                            .unwrap_or_default();
                                        current_icon_url = Some(value.to_string());
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if current_element == Some("display-name") {
                    if let Ok(text) = e.unescape() {
                        current_text.push_str(&text);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                let name = name.as_ref();
                match name {
                    b"channel" => {
                        if let (Some(id), Some(display_name)) = (current_channel_id.take(), current_display_name.take()) {
                            channels.push(EpgChannelInfo {
                                id,
                                display_name,
                                icon_url: current_icon_url.take(),
                            });
                        }
                    }
                    b"display-name" => {
                        let text = current_text.trim().to_string();
                        if !text.is_empty() && current_display_name.is_none() {
                            // Keep only the first display-name per channel
                            current_display_name = Some(text);
                        }
                        current_element = None;
                    }
                    b"icon" => {
                        current_element = None;
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                // Handle self-closing <icon src="..."/>
                if e.local_name().as_ref() == b"icon"
                    && current_channel_id.is_some()
                    && current_icon_url.is_none()
                {
                    for attr in e.attributes() {
                        if let Ok(attr) = attr {
                            if attr.key.as_ref() == b"src" {
                                let value = attr
                                    .decode_and_unescape_value(reader.decoder())
                                    .unwrap_or_default();
                                current_icon_url = Some(value.to_string());
                                break;
                            }
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                warn!("XML parse error during EPG channel extraction: {}", e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    info!("[EPG] Extracted {} channels from XMLTV", channels.len());
    channels
}

/// Bulk insert/replace EPG channels into the epg_channels table
fn insert_epg_channels(db: &DvrDatabase, source_id: &str, channels: &[EpgChannelInfo]) -> Result<usize> {
    with_sync_db_retry(|| {
        // Serialized with all other EPG program writes (see EPG_WRITE_LOCK).
        let _guard = EPG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut conn = db.get_conn()?;
        // IMMEDIATE: this writes, so take the write lock at BEGIN — a deferred
        // tx upgrading to write can hit BUSY_SNAPSHOT when another connection
        // commits in between (busy_timeout can't fix that).
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

        // First, clear old channels for this source so we don't accumulate stale entries
        tx.execute("DELETE FROM epg_channels WHERE source_id = ?1", rusqlite::params![source_id])?;

        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO epg_channels (id, display_name, icon_url, source_id)
             VALUES (?1, ?2, ?3, ?4)"
        )?;

        let mut inserted = 0;
        for ch in channels {
            match stmt.execute(rusqlite::params![
                ch.id,
                ch.display_name,
                ch.icon_url.as_deref().unwrap_or(""),
                source_id,
            ]) {
                Ok(_) => inserted += 1,
                Err(e) => {
                    warn!("Failed to insert epg_channel {}: {}", ch.id, e);
                }
            }
        }

        stmt.finalize()?;
        tx.commit()?;

        info!("[EPG] Inserted {} epg_channels for source {}", inserted, source_id);
        Ok(inserted)
    })
}

/// Convert ISO 8601 datetime string to UTC format for storage.
/// Note: Timeshift is applied in SQL (programs_effective view), not here.
/// This ensures per-channel timeshift adjustments work immediately.
fn normalize_to_utc(date_str: &str) -> String {
    // Fast path: the canonical XMLTV form produced by parse_xmltv_date
    // ("20260223010000+00:00") contains no '-', and both chrono parsers below
    // require '-' separators — so nothing can convert. Returns an unchanged
    // copy; hot parse loops additionally guard the call itself (contains('-'))
    // to skip even this allocation.
    if !date_str.contains('-') {
        return date_str.to_string();
    }

    // Try parsing as a fixed-offset datetime (covers "+00:00", "+05:30", "Z", etc.)
    if let Ok(dt) = DateTime::parse_from_rfc3339(date_str) {
        // Convert to UTC and format with Z suffix
        return dt.to_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    }
    
    // Fallback: attempt manual parse
    if let Ok(dt) = DateTime::parse_from_str(date_str, "%Y-%m-%dT%H:%M:%S%z") {
        return dt.to_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    }
    
    // Couldn't parse, return as-is
    date_str.to_string()
}

/// Single-pass streaming parse core.
///
/// Parses <channel> metadata, incrementally merges display-name mappings
/// (advanced matching), and matches <programme> events — all in ONE pass over
/// the XML, reading from any `BufRead` (in-memory slice, gzip decoder over
/// buffered bytes, or a file). The decompressed XML is never materialized as a
/// whole; matched programmes flow out through `batch_tx` in batches.
///
/// Returns the extracted channel metadata (for the channel editor) and parse
/// stats. Phase timings are measured by the caller.
fn parse_and_stream_epg_once<R: std::io::BufRead>(
    reader: R,
    mut resolved_lookup: HashMap<String, Vec<String>>,
    advanced_epg_matching: bool,
    timeshift_hours: f64,
    // Batch sink: receives each 25k-program batch as it fills. Return false to
    // stop parsing early (e.g. the consumer went away). Kept synchronous so the
    // parse can run on a blocking thread while an async download feeds it.
    batch_sink: &mut dyn FnMut(Vec<EpgProgram>) -> bool,
    on_progress: &mut (dyn FnMut(usize, usize) + Send),
) -> Result<(Vec<EpgChannelInfo>, StreamingParserResult)> {
    // Timeshift is applied in SQL (programs_effective view), not here.
    let _timeshift_secs = (timeshift_hours * 3600.0).round() as i64;

    let mut xml = Reader::from_reader(reader);
    xml.config_mut().trim_text(true);

    let mut buf = Vec::with_capacity(4096);

    // <channel id="..."><display-name>..</display-name><icon src=".."/></channel>
    let mut in_channel = false;
    let mut channel_id: Option<String> = None;
    let mut channel_display_name: Option<String> = None;
    let mut channel_icon: Option<String> = None;
    let mut channel_element: Option<&'static str> = None;
    let mut channel_text = String::new();

    // <programme> element state
    let mut current_program: Option<EpgProgram> = None;
    let mut current_element: Option<&'static str> = None;
    let mut current_text = String::new();

    // Advanced matching: display name -> channel id, collected from <channel>
    // elements during the pass. XMLTV places all <channel> elements before
    // <programme> elements, so by the first programme the map is complete and
    // we can run the exact same merge as the (previously separate) full-document
    // pass — replicating `build_display_name_mapping` + `merge_with_display_names`
    // in the single pass.
    let mut display_map: HashMap<String, String> = HashMap::new();
    let mut lookup_merged = false;

    let mut channels: Vec<EpgChannelInfo> = Vec::new();
    let mut total_programs = 0usize;
    let mut matched_programs = 0usize;
    let mut unmatched_channels: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut matched_channels_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut batch: Vec<EpgProgram> = Vec::with_capacity(BATCH_SIZE);

    loop {
        match xml.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                let name = name.as_ref();
                if in_channel {
                    match name {
                        b"display-name" => {
                            channel_element = Some("display-name");
                            channel_text.clear();
                        }
                        b"icon" => {
                            channel_element = Some("icon");
                            if channel_icon.is_none() {
                                for attr in e.attributes() {
                                    if let Ok(a) = attr {
                                        if a.key.as_ref() == b"src" {
                                            channel_icon = a
                                                .decode_and_unescape_value(xml.decoder())
                                                .ok()
                                                .map(|v| v.to_string());
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                } else {
                    match name {
                        b"channel" => {
                            in_channel = true;
                            channel_id = None;
                            channel_display_name = None;
                            channel_icon = None;
                            for attr in e.attributes() {
                                if let Ok(a) = attr {
                                    if a.key.as_ref() == b"id" {
                                        channel_id = a
                                            .decode_and_unescape_value(xml.decoder())
                                            .ok()
                                            .map(|v| v.to_string());
                                        break;
                                    }
                                }
                            }
                        }
                        b"programme" => {
                            let mut program = EpgProgram::default();
                            for attr in e.attributes() {
                                if let Ok(a) = attr {
                                    let key = a.key.as_ref();
                                    let value = a
                                        .decode_and_unescape_value(xml.decoder())
                                        .unwrap_or_default();
                                    match key {
                                        b"channel" => program.channel_id = value.to_string(),
                                        b"start" => program.start = parse_xmltv_date(&value),
                                        b"stop" => program.stop = parse_xmltv_date(&value),
                                        _ => {}
                                    }
                                }
                            }
                            current_program = Some(program);
                        }
                        b"title" | b"desc" | b"sub-title" => {
                            current_element = match name {
                                b"title" => Some("title"),
                                b"desc" => Some("desc"),
                                _ => Some("sub-title"),
                            };
                            current_text.clear();
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                // Self-closing <icon src="..."/> inside a channel
                if in_channel && channel_icon.is_none() && e.local_name().as_ref() == b"icon" {
                    for attr in e.attributes() {
                        if let Ok(a) = attr {
                            if a.key.as_ref() == b"src" {
                                channel_icon = a
                                    .decode_and_unescape_value(xml.decoder())
                                    .ok()
                                    .map(|v| v.to_string());
                                break;
                            }
                        }
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if let Ok(text) = e.unescape() {
                    if in_channel && channel_element == Some("display-name") {
                        channel_text.push_str(&text);
                    } else if current_element.is_some() {
                        current_text.push_str(&text);
                    }
                }
            }
            Ok(Event::CData(e)) => {
                // CDATA-wrapped titles/descriptions were previously dropped
                // (Event::CData was never handled); treat them like text so
                // those fields populate correctly.
                if current_element.is_some() {
                    current_text.push_str(&String::from_utf8_lossy(&e));
                } else if in_channel && channel_element == Some("display-name") {
                    channel_text.push_str(&String::from_utf8_lossy(&e));
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                let name = name.as_ref();
                if in_channel {
                    match name {
                        b"display-name" => {
                            let text = channel_text.trim().to_string();
                            if !text.is_empty() && channel_display_name.is_none() {
                                channel_display_name = Some(text);
                            }
                            channel_element = None;
                        }
                        b"icon" => {
                            channel_element = None;
                        }
                        b"channel" => {
                            in_channel = false;
                            if let (Some(id), Some(display_name)) =
                                (channel_id.take(), channel_display_name.take())
                            {
                                channels.push(EpgChannelInfo {
                                    id: id.clone(),
                                    display_name: display_name.clone(),
                                    icon_url: channel_icon.take(),
                                });

                                // Collect display-name -> channel-id entries for
                                // advanced matching (same keys/conditions as
                                // build_display_name_mapping). The merge itself
                                // runs lazily at the first <programme>, once all
                                // channels (which precede programmes in XMLTV)
                                // have been seen, reusing the exact original
                                // merge algorithm.
                                if advanced_epg_matching {
                                    display_map.insert(display_name.clone(), id.clone());
                                    let norm = normalize_channel_name(&display_name);
                                    if !norm.is_empty() && norm != display_name.to_lowercase() {
                                        display_map.insert(norm, id.clone());
                                    }
                                }
                            } else {
                                channel_icon.take();
                            }
                        }
                        _ => {}
                    }
                } else {
                    match name {
                        b"programme" => {
                            if let Some(mut program) = current_program.take() {
                                total_programs += 1;

                                // Lazy display-name merge: channels precede
                                // programmes in XMLTV, so by the first
                                // programme the display map is complete. Run
                                // the original merge exactly once.
                                if advanced_epg_matching && !lookup_merged {
                                    resolved_lookup =
                                        merge_with_display_names(resolved_lookup, &display_map);
                                    lookup_merged = true;
                                }

                                // Lookup: EPG channel IDs, M3U names, and
                                // normalized versions (fast O(1) lookups).
                                let stream_ids = resolved_lookup
                                    .get(&program.channel_id)
                                    .or_else(|| {
                                        resolved_lookup.get(&normalize_channel_name(
                                            &program.channel_id,
                                        ))
                                    });

                                if let Some(stream_ids) = stream_ids {
                                    matched_programs += 1; // count once, not per stream_id

                                    // Hot path (one stream_id per EPG channel —
                                    // ~650k programmes on otx88): reuse the
                                    // programme's own Strings instead of cloning
                                    // all five per programme, which cost millions
                                    // of heap allocations per big feed. Output
                                    // is identical (same id, same fields). The
                                    // clone is only for the rare multi-stream_id
                                    // case below.
                                    if stream_ids.len() == 1 {
                                        let stream_id = &stream_ids[0];
                                        program.channel_id = stream_id.clone();
                                        // Fast path: parse_xmltv_date output
                                        // ("20260223010000+00:00") contains no
                                        // '-', so neither chrono parser below
                                        // can match it — skip the parse AND
                                        // the per-program heap allocation
                                        // (normalize_to_utc would return an
                                        // unchanged copy).
                                        if program.start.contains('-') {
                                            program.start =
                                                normalize_to_utc(&program.start);
                                        }
                                        if program.stop.contains('-') {
                                            program.stop =
                                                normalize_to_utc(&program.stop);
                                        }
                                        matched_channels_set.insert(stream_id.clone());
                                        batch.push(program);

                                        if batch.len() >= BATCH_SIZE {
                                            let batch_to_send =
                                                std::mem::take(&mut batch);
                                            batch.reserve(BATCH_SIZE);
                                            if !batch_sink(batch_to_send) {
                                                warn!("Batch sink stopped, stopping parser");
                                            }
                                        }
                                    } else {
                                        for stream_id in stream_ids {
                                            matched_channels_set.insert(stream_id.clone());
                                            let mut program_copy = program.clone();
                                            program_copy.channel_id = stream_id.clone();
                                            program_copy.start =
                                                normalize_to_utc(&program_copy.start);
                                            program_copy.stop =
                                                normalize_to_utc(&program_copy.stop);
                                            batch.push(program_copy);

                                            if batch.len() >= BATCH_SIZE {
                                                let batch_to_send =
                                                    std::mem::take(&mut batch);
                                                batch.reserve(BATCH_SIZE);
                                                if !batch_sink(batch_to_send) {
                                                    warn!("Batch sink stopped, stopping parser");
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                } else {
                                    unmatched_channels.insert(program.channel_id);
                                }

                                if total_programs % (BATCH_SIZE * PROGRESS_INTERVAL) == 0 {
                                    on_progress(total_programs, matched_programs);
                                }
                            }
                        }
                        b"title" => {
                            if let Some(ref mut program) = current_program {
                                program.title = std::mem::take(&mut current_text);
                            }
                            current_element = None;
                        }
                        b"desc" => {
                            if let Some(ref mut program) = current_program {
                                program.description = Some(std::mem::take(&mut current_text));
                            }
                            current_element = None;
                        }
                        b"sub-title" => {
                            if let Some(ref mut program) = current_program {
                                program.sub_title = Some(std::mem::take(&mut current_text));
                            }
                            current_element = None;
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                warn!("XML parse error: {}", e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    // Send remaining programs
    if !batch.is_empty() {
        let _ = batch_sink(batch);
    }

    info!(
        "[EPG] Parser finished: {} programs, {} matched, {} unmatched channels, {} matched channels",
        total_programs,
        matched_programs,
        unmatched_channels.len(),
        matched_channels_set.len()
    );

    Ok((
        channels,
        StreamingParserResult {
            total_programs,
            matched_programs,
            unmatched_channels: unmatched_channels.len(),
            matched_channels: matched_channels_set.len(),
            bytes_processed: 0, // filled by the caller
            download_ms: 0,
            decompress_ms: 0,
            parse_ms: 0,
        },
    ))
}

/// Parse XMLTV and route matched programmes to per-source batch channels.
/// A single download is shared across all sources — each source only gets
/// programmes for channels in its own channel mapping (waterfill behaviour).
async fn parse_and_stream_batches_multi<R: tauri::Runtime>(
    xml_data: &[u8],
    master_lookup: HashMap<String, Vec<(String, String)>>,
    mut batch_senders: HashMap<String, mpsc::Sender<Vec<EpgProgram>>>,
    app_handle: tauri::AppHandle<R>,
    total_bytes: Option<u64>,
    bytes_downloaded: u64,
    start_time: std::time::Instant,
) -> Result<MultiSourceParserResult> {
    let mut reader = Reader::from_reader(xml_data);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::with_capacity(4096);
    let mut current_program: Option<EpgProgram> = None;
    let mut current_element: Option<&'static str> = None;
    let mut current_text = String::new();

    let mut total_programs = 0usize;
    let mut global_matched = 0usize;
    let mut last_progress_update = std::time::Instant::now();

    // Per-source batch buffers and stats
    let mut batch_buffers: HashMap<String, Vec<EpgProgram>> = HashMap::new();
    let mut source_stats: HashMap<String, SourceParseStats> = HashMap::new();

    for sid in batch_senders.keys() {
        batch_buffers.insert(sid.clone(), Vec::with_capacity(BATCH_SIZE));
        source_stats.insert(sid.clone(), SourceParseStats {
            matched_programs: 0,
            unmatched_channels: std::collections::HashSet::new(),
            matched_channels: std::collections::HashSet::new(),
        });
    }

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                let name = name.as_ref();
                match name {
                    b"programme" => {
                        let mut program = EpgProgram::default();
                        for attr in e.attributes() {
                            if let Ok(attr) = attr {
                                let key = attr.key.as_ref();
                                let value = attr.decode_and_unescape_value(reader.decoder()).unwrap_or_default();
                                match key {
                                    b"channel" => program.channel_id = value.to_string(),
                                    b"start" => program.start = parse_xmltv_date(&value),
                                    b"stop" => program.stop = parse_xmltv_date(&value),
                                    _ => {}
                                }
                            }
                        }
                        current_program = Some(program);
                    }
                    b"title" | b"desc" | b"sub-title" => {
                        current_element = Some(match name {
                            b"title" => "title",
                            b"desc" => "desc",
                            _ => "sub-title",
                        });
                        current_text.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if let Some(ref _element) = current_element {
                    if let Ok(text) = e.unescape() {
                        current_text.push_str(&text);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                let name = name.as_ref();
                match name {
                    b"programme" => {
                        if let Some(program) = current_program.take() {
                            total_programs += 1;

                            let pairs = master_lookup.get(&program.channel_id)
                                .or_else(|| master_lookup.get(&normalize_channel_name(&program.channel_id)));

                            if let Some(pairs) = pairs {
                                global_matched += 1;

                                // Hot path (one target per programme — the
                                // common case for global EPG gap-filling, where
                                // a channel belongs to a single source): move
                                // the programme's own Strings instead of
                                // cloning all five per programme. The clone is
                                // only for the rare multi-source case below.
                                // Also skip normalize_to_utc unless the date
                                // contains '-': parse_xmltv_date output
                                // ("20260223010000+00:00") has no '-', so
                                // neither chrono parser can match it and the
                                // call would just return an unchanged copy.
                                if pairs.len() == 1 {
                                    let (source_id, stream_id) = &pairs[0];
                                    let mut copy = program; // move, not clone
                                    copy.channel_id = stream_id.clone();
                                    if copy.start.contains('-') {
                                        copy.start = normalize_to_utc(&copy.start);
                                    }
                                    if copy.stop.contains('-') {
                                        copy.stop = normalize_to_utc(&copy.stop);
                                    }

                                    let buffer = batch_buffers.get_mut(source_id).unwrap();
                                    buffer.push(copy);

                                    if buffer.len() >= BATCH_SIZE {
                                        let batch_to_send = std::mem::take(buffer);
                                        buffer.reserve(BATCH_SIZE);
                                        if let Some(sender) = batch_senders.get(source_id) {
                                            if sender.send(batch_to_send).await.is_err() {
                                                warn!("Batch channel closed for source {}, stopping parser", source_id);
                                            }
                                        }
                                    }

                                    if let Some(stats) = source_stats.get_mut(source_id) {
                                        stats.matched_programs += 1;
                                        stats.matched_channels.insert(stream_id.clone());
                                    }
                                } else {
                                    for (source_id, stream_id) in pairs {
                                        let mut copy = program.clone();
                                        copy.channel_id = stream_id.clone();
                                        if copy.start.contains('-') {
                                            copy.start = normalize_to_utc(&copy.start);
                                        }
                                        if copy.stop.contains('-') {
                                            copy.stop = normalize_to_utc(&copy.stop);
                                        }

                                        let buffer = batch_buffers.get_mut(source_id).unwrap();
                                        buffer.push(copy);

                                        if buffer.len() >= BATCH_SIZE {
                                            let batch_to_send = std::mem::take(buffer);
                                            buffer.reserve(BATCH_SIZE);
                                            if let Some(sender) = batch_senders.get(source_id) {
                                                if sender.send(batch_to_send).await.is_err() {
                                                    warn!("Batch channel closed for source {}, stopping parser", source_id);
                                                }
                                            }
                                        }

                                        if let Some(stats) = source_stats.get_mut(source_id) {
                                            stats.matched_programs += 1;
                                            stats.matched_channels.insert(stream_id.clone());
                                        }
                                    }
                                }
                            } else {
                                // Track unmatched per source... but we don't know which source
                                // expected this channel. Skip for now.
                            }

                            // Progress update
                            if total_programs % (BATCH_SIZE * PROGRESS_INTERVAL) == 0 {
                                if last_progress_update.elapsed().as_millis() > 100 {
                                    emit_progress(
                                        &app_handle,
                                        "multi",
                                        EpgParseProgress {
                                            source_id: "multi".to_string(),
                                            phase: "parsing".to_string(),
                                            bytes_downloaded,
                                            total_bytes,
                                            programs_parsed: total_programs,
                                            programs_matched: global_matched,
                                            programs_inserted: 0,
                                            estimated_remaining_seconds: estimate_remaining(
                                                bytes_downloaded, total_bytes,
                                                start_time.elapsed().as_secs(),
                                            ),
                                        },
                                    );
                                    last_progress_update = std::time::Instant::now();
                                }
                            }
                        }
                    }
                    b"title" => {
                        if let Some(ref mut program) = current_program {
                            program.title = std::mem::take(&mut current_text);
                        }
                        current_element = None;
                    }
                    b"desc" => {
                        if let Some(ref mut program) = current_program {
                            program.description = Some(std::mem::take(&mut current_text));
                        }
                        current_element = None;
                    }
                    b"sub-title" => {
                        if let Some(ref mut program) = current_program {
                            program.sub_title = Some(std::mem::take(&mut current_text));
                        }
                        current_element = None;
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                warn!("XML parse error: {}", e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    // Send remaining batches for all sources and drop senders to signal completion
    for (source_id, buffer) in batch_buffers {
        if !buffer.is_empty() {
            if let Some(sender) = batch_senders.remove(&source_id) {
                let _ = sender.send(buffer).await;
            }
        } else if let Some(sender) = batch_senders.remove(&source_id) {
            drop(sender);
        }
    }

    info!(
        "[EPG] Multi-source parser finished: {} programs, {} total matched",
        total_programs, global_matched
    );

    Ok(MultiSourceParserResult {
        total_programs,
        bytes_processed: bytes_downloaded,
        source_stats,
    })
}

/// Inserter pipeline - receives batches and inserts them concurrently
struct InserterResult {
    inserted: usize,
    /// Wall time spent inserting all received batches into the database
    /// (includes waiting for the SQLite write lock held by other sources).
    insert_ms: u64,
    /// Wall time of that insert_ms that was spent waiting for the SQLite
    /// write lock (contention), not writing rows.
    lock_wait_ms: u64,
}

async fn insert_batches_pipeline<R: tauri::Runtime>(
    db: &DvrDatabase,
    mut batch_rx: mpsc::Receiver<Vec<EpgProgram>>,
    source_id: &str,
    app_handle: tauri::AppHandle<R>,
    total_bytes: Option<u64>,
    start_time: std::time::Instant,
) -> anyhow::Result<InserterResult> {
    // Timed from the FIRST received batch: for the network path the pipeline
    // starts while the download is still streaming, so insert_ms must measure
    // the insert phase, not the wait for batches to arrive.
    let mut insert_start: Option<std::time::Instant> = None;
    let mut total_inserted = 0usize;
    let mut batch_count = 0usize;

    // Emit inserting phase
    emit_progress(
        &app_handle,
        source_id,
        EpgParseProgress {
            source_id: source_id.to_string(),
            phase: "inserting".to_string(),
            bytes_downloaded: total_bytes.unwrap_or(0),
            total_bytes,
            programs_parsed: 0,
            programs_matched: 0,
            programs_inserted: 0,
            estimated_remaining_seconds: None,
        },
    );

    let mut total_lock_wait_ms = 0u64;
    // First batch that exhausted its retry budget (if any). Fail the parse
    // loudly rather than reporting a silent partial insert.
    let mut batch_error: Option<anyhow::Error> = None;

    // Process batches as they arrive
    while let Some(batch) = batch_rx.recv().await {
        let _ = insert_start.get_or_insert_with(std::time::Instant::now);
        batch_count += 1;

        match insert_programs_batch_timed(db, source_id, &batch).await {
            Ok((inserted, lock_wait_ms)) => {
                total_inserted += inserted;
                total_lock_wait_ms += lock_wait_ms;

                // Progress update every N batches
                if batch_count % PROGRESS_INTERVAL == 0 {
                    emit_progress(
                        &app_handle,
                        source_id,
                        EpgParseProgress {
                            source_id: source_id.to_string(),
                            phase: "inserting".to_string(),
                            bytes_downloaded: total_bytes.unwrap_or(0),
                            total_bytes,
                            programs_parsed: 0,
                            programs_matched: 0,
                            programs_inserted: total_inserted,
                            estimated_remaining_seconds: estimate_remaining_programs(
                                total_inserted as u64,
                                total_inserted as u64 + 100000, // rough estimate
                                start_time.elapsed().as_secs(),
                            ),
                        },
                    );
                }
            }
            Err(e) => {
                warn!("Failed to insert batch: {}", e);
                if batch_error.is_none() {
                    batch_error = Some(e);
                }
            }
        }
    }

    info!(
        "[EPG] Inserter finished: {} batches, {} programs inserted ({}ms waiting on DB lock)",
        batch_count, total_inserted, total_lock_wait_ms
    );

    if let Some(e) = batch_error {
        return Err(e);
    }

    Ok(InserterResult {
        inserted: total_inserted,
        insert_ms: insert_start
            .map(|t| t.elapsed().as_millis() as u64)
            .unwrap_or(0),
        lock_wait_ms: total_lock_wait_ms,
    })
}

/// Delete all programs for a source (called before inserting new programs)
fn delete_programs_for_source(db: &DvrDatabase, source_id: &str) -> Result<usize> {
    with_sync_db_retry(|| {
        // Serialized with all other EPG program writes (see EPG_WRITE_LOCK).
        // Re-acquired per retry so the backoff sleep never holds the mutex.
        let _guard = EPG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let conn = db.get_conn()?;
        let deleted = conn.execute(
            "DELETE FROM programs WHERE source_id = ?1",
            rusqlite::params![source_id],
        )?;
        Ok(deleted)
    })
}

/// The secondary indexes on `programs` dropped during a bulk EPG load and
/// rebuilt once after it. Kept in sync with the schema in
/// packages/ui/src/db/index.ts.
///
/// `idx_programs_stream` is deliberately NOT dropped: the JS-side bulk EPG
/// alignment (per source, after its inserts) JOINs `programs` on stream_id,
/// and the guide queries the same way — without it those go from indexed
/// lookups to full scans of the ~2.5M-row table (measured: alignments ballooned
/// 2.5–5.5s to 11–52s when it was dropped in the first bulk-load run). The
/// full-scan DELETE cost of dropping `idx_programs_source` is negligible
/// (otx88 inserted 742k rows in 5.4s with it dropped).
const PROGRAMS_INDEXES_TO_DROP: [&str; 3] = [
    "idx_programs_time",
    "idx_programs_source",
    "idx_programs_title",
];

/// Drop the `programs` secondary indexes before a bulk EPG load.
///
/// Index maintenance is a large fraction of INSERT/DELETE cost (each index is
/// another B-tree updated per row). With ~1.7M programs written per sync-all
/// run, keeping 3 secondary indexes live (PK + 3 B-trees per row) vs the full
/// set measurably cuts the serialized insert queue: the first bulk-load run
/// collapsed summed insert_ms from 228s to 87s. `idx_programs_stream` stays
/// live (see PROGRAMS_INDEXES_TO_DROP) because the per-source JS alignment
/// and the guide both need it.
///
/// Serialized with all other EPG program writes (see EPG_WRITE_LOCK) so no
/// in-flight insert transaction is open when the schema changes. The pool's
/// 30s busy_timeout + with_sync_db_retry handle incidental contention from
/// non-EPG writers (channel upserts, JS-side alignment).
pub fn drop_programs_indexes(db: &DvrDatabase) -> Result<()> {
    with_sync_db_retry(|| {
        let _guard = EPG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let conn = db.get_conn()?;
        let sql = PROGRAMS_INDEXES_TO_DROP
            .iter()
            .map(|name| format!("DROP INDEX IF EXISTS {}", name))
            .collect::<Vec<_>>()
            .join(";");
        conn.execute_batch(&sql)?;
        info!("[EPG] Dropped {} secondary indexes on programs for bulk load (kept idx_programs_stream)", PROGRAMS_INDEXES_TO_DROP.len());
        Ok(())
    })
}

/// Recreate the `programs` secondary indexes after a bulk EPG load.
///
/// Mirrors the definitions in packages/ui/src/db/index.ts. Safe to call when
/// the indexes already exist (IF NOT EXISTS).
pub fn recreate_programs_indexes(db: &DvrDatabase) -> Result<()> {
    with_sync_db_retry(|| {
        let _guard = EPG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let conn = db.get_conn()?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_programs_stream ON programs(stream_id);
             CREATE INDEX IF NOT EXISTS idx_programs_time ON programs(start, end);
             CREATE INDEX IF NOT EXISTS idx_programs_source ON programs(source_id);
             CREATE INDEX IF NOT EXISTS idx_programs_title ON programs(title COLLATE NOCASE);",
        )?;
        info!("[EPG] Recreated secondary indexes on programs (all 4 present)");
        Ok(())
    })
}

/// Insert a batch of programs into the database, returning the number of
/// inserted rows and the total time spent waiting for the SQLite write lock.
///
/// The insert connection runs with busy_timeout=0 so lock contention surfaces
/// immediately as SQLITE_BUSY instead of blocking invisibly inside SQLite;
/// each retry sleep is timed and accumulated into the returned lock_wait_ms.
async fn insert_programs_batch_timed(
    db: &DvrDatabase,
    source_id: &str,
    programs: &[EpgProgram],
) -> Result<(usize, u64)> {
    // Budget: a huge feed can hold the write lock for a minute or more, so
    // keep retrying well past that before giving up.
    const MAX_LOCK_WAIT_MS: u64 = 120_000;
    const RETRY_STEP_MS: u64 = 250;

    let mut lock_wait_ms = 0u64;
    loop {
        // All EPG program writes are serialized through EPG_WRITE_LOCK (the
        // mutex IS the queue — SQLite only allows one writer at a time). Time
        // the queue wait so lock_wait_ms reports the honest total contention
        // (mutex wait + SQLITE_BUSY retry sleeps). The guard is scoped to the
        // inner call so the retry sleep below never holds it.
        let lock_acquire_start = std::time::Instant::now();
        let result = {
            let guard = EPG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            lock_wait_ms += lock_acquire_start.elapsed().as_millis() as u64;
            let r = insert_programs_batch_inner(db, source_id, programs);
            drop(guard);
            r
        };
        match result {
            Ok(inserted) => return Ok((inserted, lock_wait_ms)),
            Err(e) if is_db_locked(&e) && lock_wait_ms < MAX_LOCK_WAIT_MS => {
                tokio::time::sleep(std::time::Duration::from_millis(RETRY_STEP_MS)).await;
                lock_wait_ms += RETRY_STEP_MS;
            }
            Err(e) => return Err(e),
        }
    }
}

/// True when the error is SQLite lock contention ("database is locked" / busy).
fn is_db_locked(e: &anyhow::Error) -> bool {
    is_db_locked_str(&e.to_string())
}

/// String-level variant for use on raw error messages (e.g. per-row insert errors).
fn is_db_locked_str(s: &str) -> bool {
    let l = s.to_lowercase();
    l.contains("database is locked") || l.contains("busy")
}

fn insert_programs_batch_inner(
    db: &DvrDatabase,
    source_id: &str,
    programs: &[EpgProgram],
) -> Result<usize> {
    let mut conn = db.get_conn()?;
    // Do not block inside SQLite on lock contention — surface SQLITE_BUSY
    // immediately so the timed retry loop above can measure the wait. The
    // timeout is restored to 30s on BOTH the Ok and Err paths below before
    // this connection returns to the pool (r2d2 will not do it for us on
    // reuse — its on_acquire customizer only runs when a connection is first
    // CREATED). Without the restore, the busy_timeout=0 would permanently
    // poison the pooled connection: every later user (update_source_meta,
    // deletes, channel upserts) would inherit busy_timeout=0 and fail
    // INSTANTLY with "database is locked" on any incidental contention.
    conn.busy_timeout(std::time::Duration::ZERO)?;
    let result = insert_programs_batch_inner_conn(&mut conn, source_id, programs);
    let _ = conn.busy_timeout(std::time::Duration::from_secs(30));
    result
}

fn insert_programs_batch_inner_conn(
    conn: &mut rusqlite::Connection,
    source_id: &str,
    programs: &[EpgProgram],
) -> Result<usize> {
    // IMMEDIATE: this writes, so take the write lock at BEGIN. A deferred tx
    // upgrading to write can hit BUSY_SNAPSHOT (which busy_timeout can't
    // fix) when another connection commits in between; with busy_timeout=0
    // that surfaces as an instant, retryable BUSY instead.
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    let mut stmt = tx.prepare(
        "INSERT INTO programs (
            id, stream_id, title, subtitle, description, start, end, source_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            subtitle = excluded.subtitle,
            description = excluded.description,
            start = excluded.start,
            end = excluded.end",
    )?;

    let inserted = insert_programs_rows(&mut stmt, programs, source_id)?;

    stmt.finalize()?;
    tx.commit()?;

    Ok(inserted)
}

/// Execute a single batch of rows against an already-prepared insert statement.
///
/// Duplicate keys are ignored (multiple channels sharing a tvg-id). Any lock
/// contention (SQLITE_BUSY, surfaced immediately because the insert connection
/// runs with busy_timeout=0) aborts the whole batch with an error so the timed
/// retry loop re-runs it — silently skipping the contended rows would lose
/// data. Other per-row failures are logged and skipped, as before.
fn insert_programs_rows(
    stmt: &mut rusqlite::Statement,
    programs: &[EpgProgram],
    source_id: &str,
) -> Result<usize> {
    use rusqlite::params;

    let mut inserted = 0;

    for program in programs {
        let stream_id = &program.channel_id;
        let id = format!("{}_{}", stream_id, &program.start);

        match stmt.execute(params![
            id,
            stream_id,
            program.title,
            program.sub_title.as_deref().unwrap_or(""),
            program.description.as_deref().unwrap_or(""),
            program.start,
            program.stop,
            source_id,
        ]) {
            Ok(_) => inserted += 1,
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("UNIQUE constraint failed") {
                    // Silently ignore duplicates - they happen when multiple channels share tvg-id
                    // and have the same program at the same time
                } else if is_db_locked_str(&msg) {
                    // Lock contention mid-batch (busy_timeout=0 surfaces it
                    // here). Abort the whole batch so the timed retry loop in
                    // insert_programs_batch_timed re-runs it (with the wait
                    // counted in lock_wait_ms) instead of silently dropping
                    // the contended rows.
                    return Err(e.into());
                } else {
                    warn!("Failed to insert program for stream {}: {}", stream_id, e);
                }
            }
        }
    }

    Ok(inserted)
}

/// Emit progress event to frontend
/// Emit progress event to frontend (Tauri's emit is synchronous).
fn emit_progress<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    _source_id: &str,
    progress: EpgParseProgress,
) {
    let _ = app_handle.emit("epg:parse_progress", progress);
}

/// Debug-only EPG timing log (`<app_data>/epg_timings.jsonl`).
/// OFF by default — enable by setting the `YNOTV_EPG_TIMING` environment
/// variable when launching the app (any value). Kept around because it is the
/// instrument used to compare sync performance across builds/runs; flipping
/// the env var back on requires no rebuild.
static EPG_TIMING_ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

fn epg_timing_enabled() -> bool {
    *EPG_TIMING_ENABLED.get_or_init(|| std::env::var("YNOTV_EPG_TIMING").is_ok())
}

/// Append one machine-readable timing record per source parse to
/// `<app_data>/epg_timings.jsonl` (one JSON object per line, best-effort).
/// Lets users compare EPG sync performance across builds/runs (e.g. before
/// and after a parser change) by diffing the two most recent runs.
/// No-op unless the `YNOTV_EPG_TIMING` env var is set.
fn append_epg_timing_record<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    source_id: &str,
    source_name: &str,
    url: &str,
    r: &EpgParseResult,
) {
    use tauri::Manager;

    if !epg_timing_enabled() {
        return;
    }

    let Ok(dir) = app_handle.path().app_data_dir() else {
        return;
    };
    let path = dir.join("epg_timings.jsonl");

    let line = serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "source_id": source_id,
        "source_name": source_name,
        "url": url,
        "download_ms": r.download_ms,
        "decompress_ms": r.decompress_ms,
        "parse_ms": r.parse_ms,
        "insert_ms": r.insert_ms,
        "lock_wait_ms": r.lock_wait_ms,
        "total_ms": r.duration_ms,
        "bytes_processed": r.bytes_processed,
        "total_programs": r.total_programs,
        "matched_programs": r.matched_programs,
        "inserted_programs": r.inserted_programs,
        "unmatched_channels": r.unmatched_channels,
    });

    use std::io::Write;
    match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => {
            if let Err(e) = writeln!(f, "{}", line) {
                warn!("[EPG] Failed to write timing record: {}", e);
            }
        }
        Err(e) => warn!("[EPG] Failed to open timing log {}: {}", path.display(), e),
    }

    // Accumulate into the run summary (reset by `epg_timing_run_end`).
    let mut agg = EPG_RUN_TIMING.lock().unwrap_or_else(|e| e.into_inner());
    let now = chrono::Utc::now();
    agg.first_ts.get_or_insert(now);
    agg.last_ts = Some(now);
    agg.sources += 1;
    agg.total_inserted += r.inserted_programs as u64;
    agg.sum_download_ms += r.download_ms;
    agg.sum_parse_ms += r.parse_ms;
    agg.sum_insert_ms += r.insert_ms;
    agg.sum_lock_wait_ms += r.lock_wait_ms;
    agg.sum_total_ms += r.duration_ms;
}

/// Per-run aggregation of per-source timing records (see `append_epg_timing_record`).
#[derive(Default)]
struct RunTimingSummary {
    first_ts: Option<chrono::DateTime<chrono::Utc>>,
    last_ts: Option<chrono::DateTime<chrono::Utc>>,
    sources: usize,
    total_inserted: u64,
    sum_download_ms: u64,
    sum_parse_ms: u64,
    sum_insert_ms: u64,
    sum_lock_wait_ms: u64,
    sum_total_ms: u64,
}

impl RunTimingSummary {
    const fn new() -> Self {
        Self {
            first_ts: None,
            last_ts: None,
            sources: 0,
            total_inserted: 0,
            sum_download_ms: 0,
            sum_parse_ms: 0,
            sum_insert_ms: 0,
            sum_lock_wait_ms: 0,
            sum_total_ms: 0,
        }
    }
}

static EPG_RUN_TIMING: std::sync::Mutex<RunTimingSummary> =
    std::sync::Mutex::new(RunTimingSummary::new());

/// Emit ONE summary row per sync-all run into `epg_timings.jsonl`
/// (`"kind": "run"`), aggregating the per-source rows recorded since the
/// previous call, then reset the accumulator. Called by the TS sync
/// orchestration in its finally block so even failed runs get a row.
/// `alignment_max_ms` / `sources_ok` / `sources_failed` are TS-side facts the
/// Rust side cannot see (per-source JS alignment, per-source success flags).
pub fn epg_timing_run_end<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    alignment_max_ms: Option<u64>,
    sources_ok: Option<usize>,
    sources_failed: Option<usize>,
) -> Result<()> {
    use tauri::Manager;
    use std::io::Write;

    if !epg_timing_enabled() {
        // Nothing accumulated (append is gated too), so there is no state to clear.
        return Ok(());
    }

    let agg = {
        let mut g = EPG_RUN_TIMING.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *g)
    };

    let Ok(dir) = app_handle.path().app_data_dir() else {
        return Ok(());
    };
    let path = dir.join("epg_timings.jsonl");

    let wall_ms = match (agg.first_ts, agg.last_ts) {
        (Some(first), Some(last)) => (last - first).num_milliseconds().max(0) as u64,
        _ => 0,
    };

    let line = serde_json::json!({
        "kind": "run",
        "ts": chrono::Utc::now().to_rfc3339(),
        "wall_ms": wall_ms,
        "sources": agg.sources,
        "sources_ok": sources_ok,
        "sources_failed": sources_failed,
        "total_inserted": agg.total_inserted,
        "sum_download_ms": agg.sum_download_ms,
        "sum_parse_ms": agg.sum_parse_ms,
        "sum_insert_ms": agg.sum_insert_ms,
        "sum_lock_wait_ms": agg.sum_lock_wait_ms,
        "sum_total_ms": agg.sum_total_ms,
        "alignment_max_ms": alignment_max_ms,
    });

    match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => writeln!(f, "{}", line)
            .map_err(|e| anyhow::anyhow!("Failed to write run timing record: {}", e))?,
        Err(e) => return Err(anyhow::anyhow!("Failed to open timing log {}: {}", path.display(), e)),
    }
    info!("[EPG] Run summary written: {} sources, {} programs, {}ms wall", agg.sources, agg.total_inserted, wall_ms);
    Ok(())
}

/// Estimate remaining time for download
fn estimate_remaining(bytes_read: u64, total_bytes: Option<u64>, elapsed_secs: u64) -> Option<u64> {
    if elapsed_secs == 0 {
        return None;
    }

    let total = total_bytes?;
    if bytes_read >= total {
        return Some(0);
    }

    let rate = bytes_read as f64 / elapsed_secs as f64;
    let remaining = (total - bytes_read) as f64 / rate;

    Some(remaining as u64)
}

/// Estimate remaining time for program processing
fn estimate_remaining_programs(programs_processed: u64, total_programs: u64, elapsed_secs: u64) -> Option<u64> {
    if elapsed_secs == 0 || programs_processed == 0 {
        return None;
    }

    if programs_processed >= total_programs {
        return Some(0);
    }

    let rate = programs_processed as f64 / elapsed_secs as f64;
    let remaining_programs = total_programs - programs_processed;
    let remaining_secs = remaining_programs as f64 / rate;

    Some(remaining_secs as u64)
}

/// Parse EPG from file (for local XMLTV files) - optimized version
pub async fn parse_epg_file<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    db: &DvrDatabase,
    source_id: String,
    file_path: String,
    channel_mappings: Vec<ChannelMapping>,
    advanced_epg_matching: bool,
    timeshift_hours: f64,
    clear_existing: bool,
) -> Result<EpgParseResult> {
    info!("Parsing local EPG file with streaming: {}, clear_existing: {}", file_path, clear_existing);
    let start_time = std::time::Instant::now();

    // Build channel lookup map (supports multiple stream_ids per epg_channel_id)
    let channel_lookup = build_channel_lookup(channel_mappings);

    // Probe the file with a separate handle (so the main reader isn't
    // consumed): detect gzip by magic bytes and confirm the content is
    // actually XMLTV BEFORE deleting existing programs.
    let (is_gzip, head_is_xmltv) = {
        use std::io::{BufRead, Read};
        let mut probe = std::io::BufReader::with_capacity(
            256 * 1024,
            std::fs::File::open(&file_path).context("Failed to open EPG file")?,
        );
        let head = probe.fill_buf().context("Failed to read EPG file")?;
        let gz = head.len() >= 2 && head[0] == 0x1f && head[1] == 0x8b;
        let looks_like_xmltv = if gz {
            // MultiGzDecoder: handles concatenated gzip members (some providers
            // append members), which plain GzDecoder silently truncates at the
            // first member boundary. Single-member files are unchanged.
            let mut dec = flate2::bufread::MultiGzDecoder::new(probe);
            let mut h = Vec::new();
            let _ = (&mut dec).take(256 * 1024).read_to_end(&mut h);
            let s = String::from_utf8_lossy(&h);
            s.contains("<programme") || s.contains("<tv")
        } else {
            let s = String::from_utf8_lossy(head);
            s.contains("<programme") || s.contains("<tv")
        };
        (gz, looks_like_xmltv)
    };
    if !head_is_xmltv {
        return Err(anyhow::anyhow!(
            "EPG file {} contained no XMLTV data (channels/programmes); keeping existing EPG data",
            file_path
        ));
    }

    let total_bytes = std::fs::File::open(&file_path)
        .and_then(|f| f.metadata())
        .ok()
        .map(|m| m.len());

    // Safe to replace old programs now: content is confirmed XMLTV
    if clear_existing {
        let deleted_count = delete_programs_for_source(db, &source_id)?;
        info!("[EPG] Deleted {} old programs for source {}", deleted_count, source_id);
    } else {
        info!("[EPG] Skipping deletion of old programs because clear_existing is false");
    }

    // Streaming reader for the parse pass (re-opened so the probe above can
    // consume its own handle). Decompressed data is never fully materialized.
    let reader: Box<dyn std::io::BufRead + Send> = if is_gzip {
        // flate2's bufread::MultiGzDecoder implements Read (not BufRead), so
        // wrap it in a BufReader to hand quick_xml a streaming BufRead.
        let file = std::fs::File::open(&file_path).context("Failed to open EPG file")?;
        let dec = flate2::bufread::MultiGzDecoder::new(std::io::BufReader::with_capacity(
            256 * 1024,
            file,
        ));
        Box::new(std::io::BufReader::with_capacity(256 * 1024, dec))
    } else {
        let file = std::fs::File::open(&file_path).context("Failed to open EPG file")?;
        Box::new(std::io::BufReader::with_capacity(256 * 1024, file))
    };

    // Create channel for parse->insert pipeline
    let (batch_tx, batch_rx) = mpsc::channel::<Vec<EpgProgram>>(CHANNEL_BUFFER);

    // Spawn parser task (file read + decompress + parse all happen inside the
    // streaming pass; the inserter runs concurrently on this task)
    let app_handle_clone = app_handle.clone();
    let source_id_clone = source_id.clone();
    let parse_start = std::time::Instant::now();
    let mut last_progress_update = std::time::Instant::now();
    // Parse on a blocking thread: file reads + decompression + the sync parse
    // core run here, while the inserter consumes batches concurrently below
    // (blocking_send hands each batch off with backpressure).
    let parser_task = tokio::task::spawn_blocking(move || {
        let mut on_progress = |parsed: usize, matched: usize| {
            if last_progress_update.elapsed().as_millis() > 100 {
                emit_progress(
                    &app_handle_clone,
                    &source_id_clone,
                    EpgParseProgress {
                        source_id: source_id_clone.to_string(),
                        phase: "parsing".to_string(),
                        bytes_downloaded: total_bytes.unwrap_or(0),
                        total_bytes,
                        programs_parsed: parsed,
                        programs_matched: matched,
                        programs_inserted: 0,
                        estimated_remaining_seconds: estimate_remaining(
                            total_bytes.unwrap_or(0),
                            total_bytes,
                            start_time.elapsed().as_secs(),
                        ),
                    },
                );
                last_progress_update = std::time::Instant::now();
            }
        };
        let mut sink = |batch: Vec<EpgProgram>| batch_tx.blocking_send(batch).is_ok();
        let (channels, result) = parse_and_stream_epg_once(
            reader,
            channel_lookup,
            advanced_epg_matching,
            timeshift_hours,
            &mut sink,
            &mut on_progress,
        )?;
        drop(batch_tx);
        Ok::<_, anyhow::Error>((channels, result))
    });

    // Run inserter concurrently
    let inserter_result = insert_batches_pipeline(
        db,
        batch_rx,
        &source_id,
        app_handle.clone(),
        total_bytes,
        start_time,
    ).await;

    // Wait for parser
    let (epg_channels, mut parser_result) = parser_task.await
        .context("Parser task panicked")??;
    // A batch that exhausted its retry budget means programs are missing —
    // surface it instead of reporting a silent partial insert.
    let inserter_result = inserter_result?;
    let parse_ms = parse_start.elapsed().as_millis() as u64;

    // Persist channel metadata for the channel editor (collected in the pass)
    if let Err(e) = insert_epg_channels(db, &source_id, &epg_channels) {
        warn!("[EPG] Failed to insert epg_channels for source {}: {}", source_id, e);
    }

    let duration_ms = start_time.elapsed().as_millis() as u64;

    // File read is overlapped with the streaming parse, so download/decompress
    // are reported inside parse_ms (0 here).
    parser_result.download_ms = 0;
    parser_result.decompress_ms = 0;
    parser_result.parse_ms = parse_ms;
    parser_result.bytes_processed = total_bytes.unwrap_or(0);

    let result = EpgParseResult {
        source_id: source_id.clone(),
        total_programs: parser_result.total_programs,
        matched_programs: parser_result.matched_programs,
        inserted_programs: inserter_result.inserted,
        unmatched_channels: parser_result.unmatched_channels,
        matched_channels: parser_result.matched_channels,
        duration_ms,
        bytes_processed: parser_result.bytes_processed,
        download_ms: parser_result.download_ms,
        decompress_ms: parser_result.decompress_ms,
        parse_ms: parser_result.parse_ms,
        insert_ms: inserter_result.insert_ms,
        lock_wait_ms: inserter_result.lock_wait_ms,
    };

    info!(
        "[EPG TIMING] source=\"{}\" file=\"{}\" download_ms={} decompress_ms={} parse_ms={} insert_ms={} lock_wait_ms={} total_ms={} bytes={} programs={} matched={} inserted={} unmatched_channels={}",
        source_id, file_path,
        result.download_ms, result.decompress_ms, result.parse_ms, result.insert_ms,
        result.lock_wait_ms,
        result.duration_ms, result.bytes_processed,
        result.total_programs, result.matched_programs, result.inserted_programs,
        result.unmatched_channels
    );

    append_epg_timing_record(&app_handle, &source_id, &source_id, &file_path, &result);

    Ok(result)
}

/// Sync and save all EPG channels and programs to a separate database cache file
pub async fn cache_entire_epg_db<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    epg_url: String,
    epg_link_id: String,
    user_agent: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;
    let app_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join(format!("epg_cache_{}.db", epg_link_id));
    
    info!("[EPG Cache] Downloading and caching entire EPG from {} to {:?}", epg_url, db_path);

    // 1. Download EPG XML data
    let ua = match user_agent {
        Some(ref u) if !u.trim().is_empty() => u.clone(),
        _ => "VLC/3.0.18 LibVLC/3.0.18".to_string(),
    };

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(300))
        .pool_max_idle_per_host(10)
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .user_agent(ua)
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(&epg_url).send().await.map_err(|e| e.to_string())?;
    // Reject HTTP error responses (404/503/...) before their body can be parsed
    // as empty XML and overwrite the existing cache below.
    let response = response
        .error_for_status()
        .map_err(|e| format!("HTTP error from EPG URL {}: {}", epg_url, e))?;
    let is_response_gzipped = response.headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_lowercase().contains("gzip"))
        .unwrap_or(false);
    let should_decompress = epg_url.ends_with(".gz") || is_response_gzipped;

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let data = bytes.to_vec();

    let has_gzip_magic = data.len() >= 2 && data[0] == 0x1f && data[1] == 0x8b;
    let should_decompress = should_decompress || has_gzip_magic;

    let xml_data = if should_decompress {
        use flate2::read::GzDecoder;
        use std::io::Read;
        let mut decoder = GzDecoder::new(&data[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed)
            .map_err(|e| format!("Failed to decompress gzipped EPG: {}", e))?;
        decompressed
    } else {
        data
    };

    // 2. Open separate SQLite database connection
    let mut conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // Drop and recreate tables
    tx.execute("DROP TABLE IF EXISTS epg_channels", []).map_err(|e| e.to_string())?;
    tx.execute("DROP TABLE IF EXISTS programs", []).map_err(|e| e.to_string())?;
    
    tx.execute(
        "CREATE TABLE epg_channels (
            id TEXT PRIMARY KEY,
            display_name TEXT,
            icon_url TEXT
        )",
        [],
    ).map_err(|e| e.to_string())?;

    tx.execute(
        "CREATE TABLE programs (
            id TEXT PRIMARY KEY,
            stream_id TEXT,
            title TEXT,
            subtitle TEXT,
            description TEXT,
            start TEXT,
            end TEXT
        )",
        [],
    ).map_err(|e| e.to_string())?;

    // Extract and insert EPG channels
    let epg_channels = extract_epg_channels(&xml_data);
    let mut chan_stmt = tx.prepare(
        "INSERT OR REPLACE INTO epg_channels (id, display_name, icon_url)
         VALUES (?1, ?2, ?3)",
    ).map_err(|e| e.to_string())?;

    for ch in &epg_channels {
        let icon = ch.icon_url.as_deref().unwrap_or("");
        if let Err(e) = chan_stmt.execute(rusqlite::params![ch.id, ch.display_name, icon]) {
            warn!("Failed to insert EPG channel in cache {}: {}", ch.id, e);
        }
    }
    chan_stmt.finalize().map_err(|e| e.to_string())?;

    // Extract and insert programs
    let mut prog_stmt = tx.prepare(
        "INSERT OR REPLACE INTO programs (
            id, stream_id, title, subtitle, description, start, end
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ).map_err(|e| e.to_string())?;

    let mut reader = Reader::from_reader(&xml_data[..]);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::with_capacity(4096);
    let mut current_program: Option<EpgProgram> = None;
    let mut current_element: Option<String> = None;
    let mut current_text = String::new();
    let mut program_count: usize = 0;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "programme" {
                    let mut program = EpgProgram {
                        channel_id: String::new(),
                        title: String::new(),
                        sub_title: None,
                        description: None,
                        start: String::new(),
                        stop: String::new(),
                    };
                    for attr in e.attributes() {
                        if let Ok(a) = attr {
                            let key = String::from_utf8_lossy(a.key.as_ref()).to_string();
                            let value = a.decode_and_unescape_value(reader.decoder()).unwrap_or_default().to_string();
                            match key.as_str() {
                                "channel" => program.channel_id = value,
                                "start" => program.start = parse_xmltv_date(&value),
                                "stop" => program.stop = parse_xmltv_date(&value),
                                _ => {}
                            }
                        }
                    }
                    current_program = Some(program);
                } else if current_program.is_some() {
                    current_element = Some(name);
                    current_text.clear();
                }
            }
            Ok(Event::Text(e)) => {
                if current_element.is_some() {
                    if let Ok(t) = e.unescape() {
                        current_text.push_str(&t);
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "programme" {
                    if let Some(program) = current_program.take() {
                        program_count += 1;
                        let id = format!("{}_{}", program.channel_id, program.start);
                        let title = &program.title;
                        let sub = program.sub_title.as_deref().unwrap_or("");
                        let desc = program.description.as_deref().unwrap_or("");
                        
                        if let Err(e) = prog_stmt.execute(rusqlite::params![
                            id,
                            program.channel_id,
                            title,
                            sub,
                            desc,
                            program.start,
                            program.stop,
                        ]) {
                            if !e.to_string().contains("UNIQUE constraint failed") {
                                warn!("Failed to insert EPG program in cache: {}", e);
                            }
                        }
                    }
                } else if current_program.is_some() {
                    if let Some(ref elem) = current_element {
                        if let Some(ref mut program) = current_program {
                            match elem.as_str() {
                                "title" => program.title = current_text.trim().to_string(),
                                "sub-title" => program.sub_title = Some(current_text.trim().to_string()),
                                "desc" => program.description = Some(current_text.trim().to_string()),
                                _ => {}
                            }
                        }
                    }
                    current_element = None;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                warn!("XML parse error: {}", e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    prog_stmt.finalize().map_err(|e| e.to_string())?;

    // Guard against replacing a good cache with an empty/garbage parse (e.g. an
    // HTTP error page served with status 200). Returning Err drops the
    // transaction, rolling back the DROP/CREATE above so the existing cache
    // survives intact.
    if epg_channels.is_empty() && program_count == 0 {
        return Err(format!(
            "EPG response from {} contained no channels or programmes; preserving existing cache",
            epg_url
        ));
    }

    tx.commit().map_err(|e| e.to_string())?;

    // Compact database file size
    conn.execute("VACUUM", []).map_err(|e| e.to_string())?;

    info!("[EPG Cache] Entire EPG cached successfully for link {}", epg_link_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_mappings() -> Vec<ChannelMapping> {
        // M3U names deliberately mixed-case / prefixed to exercise the
        // display-name merge edge cases.
        vec![
            ChannelMapping { epg_channel_id: "M3U0001".into(), stream_id: "s1".into(), channel_name: "FooBar".into() },
            ChannelMapping { epg_channel_id: "M3U0002".into(), stream_id: "s2".into(), channel_name: "US: News HD".into() },
            ChannelMapping { epg_channel_id: "M3U0003".into(), stream_id: "s3".into(), channel_name: "Sports One".into() },
            ChannelMapping { epg_channel_id: "M3U0004".into(), stream_id: "s4".into(), channel_name: "plain".into() },
        ]
    }

    fn sample_xml() -> String {
        // Display names engineered to match M3U names in different ways:
        // - "foobar" == normalize("FooBar")   (the case the incremental merge missed)
        // - "US: News HD" exact match
        // - "sport one" == normalize("Sports One")
        // - "plain" exact (already normalized)
        let mut xml = String::from("<?xml version=\"1.0\"?><tv>");
        for (id, disp) in [
            ("CH1", "foobar"),
            ("CH2", "US: News HD"),
            ("CH3", "sports one"),
            ("CH4", "plain"),
        ] {
            xml.push_str(&format!(
                "<channel id=\"{}\"><display-name>{}</display-name></channel>",
                id, disp
            ));
        }
        for (ch, start) in [
            ("CH1", "20260223010000 +0000"),
            ("CH2", "20260223020000 +0000"),
            ("CH3", "20260223030000 +0000"),
            ("CH4", "20260223040000 +0000"),
        ] {
            xml.push_str(&format!(
                "<programme start=\"{}\" stop=\"20260223100000 +0000\" channel=\"{}\"><title>T</title><desc>D</desc></programme>",
                start, ch
            ));
        }
        xml.push_str("</tv>");
        xml
    }

    /// Count how many programmes (and how many stream copies, matching the
    /// one-copy-per-stream-id behaviour) the OLD pipeline
    /// (build_display_name_mapping + merge_with_display_names + lookup) would
    /// produce. Returns (programs, copies).
    fn old_pipeline_counts(xml: &str, mappings: &[ChannelMapping]) -> (usize, usize) {
        let lookup = build_channel_lookup(mappings.to_vec());
        let display = build_display_name_mapping(xml.as_bytes());
        let merged = merge_with_display_names(lookup, &display);

        let mut programs = 0usize;
        let mut copies = 0usize;
        let mut reader = Reader::from_reader(xml.as_bytes());
        reader.config_mut().trim_text(true);
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) => {
                    if e.local_name().as_ref() == b"programme" {
                        let mut ch = String::new();
                        for attr in e.attributes() {
                            if let Ok(a) = attr {
                                if a.key.as_ref() == b"channel" {
                                    ch = a
                                        .decode_and_unescape_value(reader.decoder())
                                        .unwrap_or_default()
                                        .to_string();
                                }
                            }
                        }
                        if let Some(ids) = merged
                            .get(&ch)
                            .or_else(|| merged.get(&normalize_channel_name(&ch)))
                        {
                            programs += 1;
                            // Copies: one per unique stream_id. The merge
                            // dedupes the raw+normalized alias collisions, so
                            // this is the same count the single-pass core emits.
                            copies += ids.len();
                        }
                    }
                }
                Ok(Event::Eof) => break,
                Ok(_) => {}
                Err(_) => break,
            }
            buf.clear();
        }
        (programs, copies)
    }

    #[tokio::test]
    async fn single_pass_merge_matches_old_pipeline() {
        let xml = sample_xml();
        let mappings = sample_mappings();
        let (expected_programs, expected_copies) = old_pipeline_counts(&xml, &mappings);
        assert_eq!(
            (expected_programs, expected_copies),
            (4, 4),
            "sanity: 4 programmes / 4 copies after dedupe (CH2/CH3 previously emitted 2 copies each via raw+normalized keys)"
        );

        let lookup = build_channel_lookup(mappings);

        let mut flowed: Vec<EpgProgram> = Vec::new();
        let mut sink = |batch: Vec<EpgProgram>| {
            flowed.extend(batch);
            true
        };

        let (channels, result) = parse_and_stream_epg_once(
            xml.as_bytes(),
            lookup,
            true, // advanced matching
            0.0,
            &mut sink,
            &mut |_, _| {},
        )
        .expect("single-pass parse");

        let flowed = flowed.len();

        assert_eq!(channels.len(), 4, "all channels extracted");
        assert_eq!(result.total_programs, 4, "all programmes counted");
        assert_eq!(
            result.matched_programs, expected_programs,
            "matched programmes must be identical to the old pipeline"
        );
        assert_eq!(flowed, expected_copies, "stream copies must match the old pipeline");
    }

    #[test]
    fn merge_dedupes_duplicate_stream_ids() {
        let lookup = build_channel_lookup(sample_mappings());
        let display = build_display_name_mapping(sample_xml().as_bytes());
        let merged = merge_with_display_names(lookup, &display);

        // CH2 ("US: News HD") and CH3 ("Sports One") match their display
        // names via BOTH the raw key and the normalized alias key, which
        // previously appended the same stream_id twice to the epg id's
        // vector (2 copies each). After dedupe each stream appears once.
        assert_eq!(merged.get("CH2").map(Vec::len), Some(1), "CH2 stream_id deduped");
        assert_eq!(merged.get("CH3").map(Vec::len), Some(1), "CH3 stream_id deduped");
        assert_eq!(merged.get("CH1").map(Vec::len), Some(1));
        assert_eq!(merged.get("CH4").map(Vec::len), Some(1));

        // Invariant: no lookup vector contains a duplicate stream_id.
        for (key, ids) in &merged {
            let mut sorted = ids.clone();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(sorted.len(), ids.len(), "no duplicate stream_ids under key {}", key);
        }
    }

    #[test]
    fn busy_contention_aborts_batch_instead_of_dropping_rows() {
        use tempfile::tempdir;

        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("test.db");
        let mut conn1 = rusqlite::Connection::open(&db_path).expect("conn1");
        conn1
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE programs (
                     id TEXT PRIMARY KEY, stream_id TEXT, title TEXT, subtitle TEXT,
                     description TEXT, start TEXT, end TEXT, source_id TEXT
                 );",
            )
            .expect("schema");
        // conn1 holds the SQLite write lock for the rest of the test.
        let tx1 = conn1.transaction().expect("tx1");
        tx1.execute(
            "INSERT INTO programs VALUES ('lock','l','t','','','0','0','s')",
            [],
        )
        .expect("write lock");

        let mut conn2 = rusqlite::Connection::open(&db_path).expect("conn2");
        conn2
            .busy_timeout(std::time::Duration::ZERO)
            .expect("busy_timeout=0");
        let tx2 = conn2.transaction().expect("tx2");
        let mut stmt = tx2
            .prepare(
                "INSERT INTO programs (id, stream_id, title, subtitle, description, start, end, source_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET title = excluded.title",
            )
            .expect("stmt");

        let programs = vec![EpgProgram {
            channel_id: "c1".into(),
            title: "Title".into(),
            sub_title: None,
            description: None,
            start: "20260223010000 +0000".into(),
            stop: "20260223100000 +0000".into(),
        }];

        // The whole batch must fail (so the timed retry loop can re-run it
        // with lock_wait accounting), NOT silently report fewer inserted rows.
        let err = insert_programs_rows(&mut stmt, &programs, "src")
            .expect_err("contended write must abort the batch");
        let msg = err.to_string().to_lowercase();
        assert!(
            msg.contains("database is locked") || msg.contains("busy"),
            "expected a lock error, got: {}",
            msg
        );
    }

    #[tokio::test]
    async fn cdata_wrapped_title_is_parsed() {
        let xml = "<?xml version=\"1.0\"?><tv>\
            <channel id=\"c1\"><display-name>One</display-name></channel>\
            <programme start=\"20260223010000 +0000\" stop=\"20260223100000 +0000\" channel=\"c1\">\
            <title><![CDATA[Show <Name> & More]]></title></programme></tv>";
        let mappings = vec![ChannelMapping {
            epg_channel_id: "c1".into(),
            stream_id: "s1".into(),
            channel_name: "One".into(),
        }];
        let lookup = build_channel_lookup(mappings);
        let mut programs: Vec<EpgProgram> = Vec::new();
        let mut sink = |batch: Vec<EpgProgram>| {
            programs.extend(batch);
            true
        };
        let (_channels, _result) = parse_and_stream_epg_once(
            xml.as_bytes(),
            lookup,
            false,
            0.0,
            &mut sink,
            &mut |_, _| {},
        )
        .expect("parse");
        assert_eq!(programs.len(), 1);
        assert_eq!(programs[0].title, "Show <Name> & More");
    }

    #[test]
    fn multigz_decodes_all_members_plain_gz_truncates_at_first() {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::{Read, Write};

        let doc1 = "<tv><programme channel=\"c1\" start=\"20260223010000 +0000\" stop=\"20260223020000 +0000\"><title>A</title></programme></tv>";
        let doc2 = "<programme channel=\"c2\" start=\"20260223020000 +0000\" stop=\"20260223030000 +0000\"><title>B</title></programme></tv>";

        let mut member1 = Vec::new();
        {
            let mut enc = GzEncoder::new(&mut member1, Compression::default());
            enc.write_all(doc1.as_bytes()).unwrap();
            enc.finish().unwrap();
        }
        let mut member2 = Vec::new();
        {
            let mut enc = GzEncoder::new(&mut member2, Compression::default());
            enc.write_all(doc2.as_bytes()).unwrap();
            enc.finish().unwrap();
        }
        let mut combined = member1.clone();
        combined.extend_from_slice(&member2);

        // Plain GzDecoder silently stops at the first member boundary — this is
        // the pre-existing behavior the new MultiGzDecoder replaces.
        let mut single = String::new();
        flate2::read::GzDecoder::new(&combined[..])
            .read_to_string(&mut single)
            .unwrap();
        assert!(
            single.contains("c1") && !single.contains("c2"),
            "GzDecoder must stop at the first member boundary"
        );

        // MultiGzDecoder (now used by the parse paths) reads every member.
        let mut multi = String::new();
        flate2::read::MultiGzDecoder::new(&combined[..])
            .read_to_string(&mut multi)
            .unwrap();
        assert!(
            multi.contains("c1") && multi.contains("c2"),
            "MultiGzDecoder must read all members"
        );

        // Truncated gzip: member1 complete + a cut member2 must ERROR, not
        // silently return partial data (so a truncated download that slips
        // past content-length can't swap partial programs).
        let cut = member1.len() + 5;
        let mut out = String::new();
        let res = flate2::read::MultiGzDecoder::new(&combined[..cut]).read_to_string(&mut out);
        assert!(
            res.is_err(),
            "truncated gzip must error, not silently succeed (got {})",
            out
        );
    }
}
