use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::image::Image;
use tauri::{AppHandle, Manager, RunEvent, State};
use uuid::Uuid;

#[derive(Clone, Serialize)]
pub struct DaemonEndpoint {
    pub url: String,
    pub token: String,
}

struct DaemonState {
    endpoint: DaemonEndpoint,
    // None when we adopted an existing daemon (we don't own it).
    // Held to keep the process handle alive; not read after setup.
    #[allow(dead_code)]
    child: Mutex<Option<Child>>,
}

#[derive(serde::Deserialize)]
struct DiscoveryRecord {
    url: String,
    token: String,
    #[allow(dead_code)]
    pid: u32,
}

#[tauri::command]
fn get_daemon_endpoint(state: State<DaemonState>) -> DaemonEndpoint {
    state.endpoint.clone()
}

fn pick_free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("local_addr").port()
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .canonicalize()
        .expect("resolve workspace root")
}

fn bundled_sidecar_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let exe_suffix = std::env::consts::EXE_SUFFIX;
    let triple = env!("ORCA_TARGET_TRIPLE");
    // Some bundle formats (deb, rpm) strip Tauri's triple suffix; others keep it.
    for name in [
        format!("orca-daemon-{triple}{exe_suffix}"),
        format!("orca-daemon{exe_suffix}"),
    ] {
        let candidate = dir.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn attach_log_pipes(child: &mut Child) {
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[daemon] {line}");
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[daemon!] {line}");
            }
        });
    }
}

/// Compute the data directory mirroring config.ts logic:
/// ORCA_DATA_DIR env → ~/.orca (unix) / %APPDATA%/Orca (windows)
fn daemon_data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("ORCA_DATA_DIR") {
        return PathBuf::from(d);
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA").unwrap_or_default();
        return PathBuf::from(base).join("Orca");
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").expect("HOME env var not set");
        PathBuf::from(home).join(".orca")
    }
}

/// Read and parse daemon.json from data_dir. Returns None if missing or invalid.
fn read_discovery(data_dir: &PathBuf) -> Option<DiscoveryRecord> {
    let path = data_dir.join("daemon.json");
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Check if a daemon at `url` is healthy by sending a minimal HTTP GET to /v1/health
/// and verifying the response contains `"service":"orca-daemon"`.
/// Uses a raw TcpStream to avoid adding an HTTP client dependency.
fn health_ok(url: &str) -> bool {
    // Parse host:port from the URL (e.g. "http://127.0.0.1:8787")
    let addr = url
        .trim_start_matches("http://")
        .trim_start_matches("https://");

    // addr may be "127.0.0.1:8787" or "127.0.0.1:8787/some/path" — take only host:port
    let host_port = addr.split('/').next().unwrap_or(addr);

    let mut stream = match std::net::TcpStream::connect_timeout(
        &host_port
            .parse()
            .unwrap_or_else(|_| "127.0.0.1:8787".parse().unwrap()),
        Duration::from_secs(2),
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };

    let request = format!("GET /v1/health HTTP/1.0\r\nHost: {host_port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }

    // Find the JSON body after the blank line separating headers from body
    let body = response
        .split("\r\n\r\n")
        .nth(1)
        .or_else(|| response.split("\n\n").nth(1))
        .unwrap_or("");

    let Ok(val) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };

    val.get("service").and_then(|s| s.as_str()) == Some("orca-daemon")
}

/// Spawn the daemon as a completely detached process (its own session, not tied to
/// the app's process group). Stdio goes to data_dir/daemon.log.
fn spawn_detached(
    app: &AppHandle,
    port: u16,
    token: &str,
    data_dir: &PathBuf,
) -> std::io::Result<Child> {
    // Open log file for daemon output
    let log_path = data_dir.join("daemon.log");
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let log_file2 = log_file.try_clone()?;

    let child = if cfg!(debug_assertions) {
        eprintln!("[orca] debug build — spawning daemon via pnpm dev (hot reload), detached");
        let root = workspace_root();
        #[cfg(target_os = "windows")]
        let program = "pnpm.cmd";
        #[cfg(not(target_os = "windows"))]
        let program = "pnpm";

        let mut cmd = Command::new(program);
        cmd.arg("--filter")
            .arg("@orca/daemon")
            .arg("dev")
            .current_dir(&root)
            .env("ORCA_PORT", port.to_string())
            .env("ORCA_TOKEN", token)
            .stdout(Stdio::from(log_file))
            .stderr(Stdio::from(log_file2));

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                cmd.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
        }

        cmd.spawn()?
    } else {
        match bundled_sidecar_path() {
            Some(sidecar) => {
                eprintln!("[orca] launching sidecar detached: {}", sidecar.display());
                let runtime_dir = app
                    .path()
                    .resolve("runtime", tauri::path::BaseDirectory::Resource)
                    .map_err(|e| std::io::Error::other(format!("resolve runtime resource dir: {e}")))?;

                let mut cmd = Command::new(&sidecar);
                cmd.env("ORCA_PORT", port.to_string())
                    .env("ORCA_TOKEN", token)
                    .env("ORCA_RUNTIME_DIR", runtime_dir)
                    .stdout(Stdio::from(log_file))
                    .stderr(Stdio::from(log_file2));

                #[cfg(unix)]
                {
                    use std::os::unix::process::CommandExt;
                    unsafe {
                        cmd.pre_exec(|| {
                            libc::setsid();
                            Ok(())
                        });
                    }
                }

                cmd.spawn()?
            }
            None => {
                eprintln!("[orca] no sidecar found; falling back to pnpm dev, detached");
                let root = workspace_root();
                #[cfg(target_os = "windows")]
                let program = "pnpm.cmd";
                #[cfg(not(target_os = "windows"))]
                let program = "pnpm";

                let mut cmd = Command::new(program);
                cmd.arg("--filter")
                    .arg("@orca/daemon")
                    .arg("dev")
                    .current_dir(&root)
                    .env("ORCA_PORT", port.to_string())
                    .env("ORCA_TOKEN", token)
                    .stdout(Stdio::from(log_file))
                    .stderr(Stdio::from(log_file2));

                #[cfg(unix)]
                {
                    use std::os::unix::process::CommandExt;
                    unsafe {
                        cmd.pre_exec(|| {
                            libc::setsid();
                            Ok(())
                        });
                    }
                }

                cmd.spawn()?
            }
        }
    };

    Ok(child)
}

/// Poll daemon.json + health for up to `timeout`. Returns the adopted endpoint on success.
fn poll_for_healthy_daemon(data_dir: &PathBuf, timeout: Duration) -> Option<DaemonEndpoint> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(rec) = read_discovery(data_dir) {
            if health_ok(&rec.url) {
                return Some(DaemonEndpoint { url: rec.url, token: rec.token });
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_discovery_record() {
        let json = r#"{"version":1,"url":"http://127.0.0.1:8787","token":"t","pid":1,"startedAt":"x","protocol":"http"}"#;
        let rec: DiscoveryRecord = serde_json::from_str(json).unwrap();
        assert_eq!(rec.url, "http://127.0.0.1:8787");
        assert_eq!(rec.token, "t");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_daemon_endpoint])
        .setup(|app| {
            let data_dir = daemon_data_dir();

            // Try to adopt a running daemon first
            let (endpoint, child) = if let Some(rec) = read_discovery(&data_dir) {
                if health_ok(&rec.url) {
                    eprintln!("[orca] adopted running daemon at {}", rec.url);
                    let ep = DaemonEndpoint { url: rec.url, token: rec.token };
                    (ep, None)
                } else {
                    // Discovery file exists but daemon is not healthy — spawn detached
                    spawn_new_daemon(app.handle(), &data_dir)?
                }
            } else {
                // No discovery file — spawn detached
                spawn_new_daemon(app.handle(), &data_dir)?
            };

            app.manage(DaemonState {
                endpoint,
                child: Mutex::new(child),
            });

            if let Some(window) = app.get_webview_window("main") {
                if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/icon.png")) {
                    let _ = window.set_icon(icon);
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if matches!(event, RunEvent::Exit) {
                // The daemon is now an independent service — do NOT kill it on app exit.
            }
        });
}

/// Spawn a new detached daemon, then poll until healthy or timeout.
fn spawn_new_daemon(
    app: &AppHandle,
    data_dir: &PathBuf,
) -> Result<(DaemonEndpoint, Option<Child>), Box<dyn std::error::Error>> {
    let port = pick_free_port();
    let token = Uuid::new_v4().to_string();

    // Ensure data dir exists for the log file
    std::fs::create_dir_all(data_dir)?;

    let mut child = spawn_detached(app, port, &token, data_dir)?;

    match poll_for_healthy_daemon(data_dir, Duration::from_secs(10)) {
        Some(ep) => {
            eprintln!("[orca] daemon healthy at {}", ep.url);
            // We hold the child handle for cleanup reference but will NOT kill it on exit
            Ok((ep, Some(child)))
        }
        None => {
            eprintln!("[orca] daemon did not become healthy within 10s; using fallback endpoint");
            // Fallback: use the port/token we intended (daemon may still be starting)
            let ep = DaemonEndpoint {
                url: format!("http://127.0.0.1:{port}"),
                token: token.clone(),
            };
            attach_log_pipes(&mut child);
            Ok((ep, Some(child)))
        }
    }
}
