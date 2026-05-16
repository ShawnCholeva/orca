use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, State};
use uuid::Uuid;

#[derive(Clone, Serialize)]
pub struct DaemonEndpoint {
    pub url: String,
    pub token: String,
}

struct DaemonState {
    endpoint: DaemonEndpoint,
    child: Mutex<Option<Child>>,
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

/// Path to the bundled sidecar binary, if one exists next to the app exe.
/// Tauri's externalBin places `orca-daemon-<target-triple>` next to the main
/// app exe in production bundles; on launch it's accessible at that location.
fn bundled_sidecar_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let exe_suffix = std::env::consts::EXE_SUFFIX;
    // Tauri preserves the triple suffix in the bundled name.
    let triple = env!("ORCA_TARGET_TRIPLE");
    let with_triple = dir.join(format!("orca-daemon-{triple}{exe_suffix}"));
    if with_triple.exists() {
        return Some(with_triple);
    }
    // Fallback: some bundle formats strip the triple suffix.
    let without_triple = dir.join(format!("orca-daemon{exe_suffix}"));
    if without_triple.exists() {
        return Some(without_triple);
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

fn configure_command_lifecycle(cmd: &mut Command) {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    // Put the child in its own process group so we can kill the whole tree on
    // shutdown without leaving orphans.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
}

/// Production path: invoke the sidecar binary directly with the runtime tree
/// (better-sqlite3 + native binding) located in Tauri resources.
fn spawn_sidecar(
    app: &AppHandle,
    sidecar: PathBuf,
    port: u16,
    token: &str,
) -> std::io::Result<Child> {
    let runtime_dir = app
        .path()
        .resolve("runtime", tauri::path::BaseDirectory::Resource)
        .map_err(|e| std::io::Error::other(format!("resolve runtime resource dir: {e}")))?;

    let mut cmd = Command::new(&sidecar);
    cmd.env("ORCA_PORT", port.to_string())
        .env("ORCA_TOKEN", token)
        .env("ORCA_RUNTIME_DIR", runtime_dir);
    configure_command_lifecycle(&mut cmd);

    let mut child = cmd.spawn()?;
    attach_log_pipes(&mut child);
    Ok(child)
}

/// Dev fallback: when no bundled sidecar is present (e.g. `cargo run`,
/// `pnpm tauri:dev`), invoke `pnpm --filter @orca/daemon dev` from the
/// workspace root. Matches the M1 baseline.
fn spawn_dev(port: u16, token: &str) -> std::io::Result<Child> {
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
        .env("ORCA_TOKEN", token);
    configure_command_lifecycle(&mut cmd);

    let mut child = cmd.spawn()?;
    attach_log_pipes(&mut child);
    Ok(child)
}

fn shutdown_daemon(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe {
            libc::kill(-pid, libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_daemon_endpoint])
        .setup(|app| {
            let port = pick_free_port();
            let token = Uuid::new_v4().to_string();
            let endpoint = DaemonEndpoint {
                url: format!("http://127.0.0.1:{port}"),
                token: token.clone(),
            };

            let child = match bundled_sidecar_path() {
                Some(sidecar) => {
                    eprintln!("[orca] launching sidecar: {}", sidecar.display());
                    spawn_sidecar(app.handle(), sidecar, port, &token)
                }
                None => {
                    eprintln!("[orca] no sidecar found; falling back to pnpm dev");
                    spawn_dev(port, &token)
                }
            }
            .expect("failed to spawn daemon");

            app.manage(DaemonState {
                endpoint,
                child: Mutex::new(Some(child)),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                if let Some(state) = app.try_state::<DaemonState>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(mut child) = guard.take() {
                            shutdown_daemon(&mut child);
                        }
                    }
                }
            }
        });
}
