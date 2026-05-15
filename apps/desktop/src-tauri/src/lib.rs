use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, RunEvent, State};
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
    // Bind to port 0; OS chooses. Race-free enough for dev.
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("local_addr").port()
}

fn workspace_root() -> PathBuf {
    // CARGO_MANIFEST_DIR resolves to apps/desktop/src-tauri at compile time.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .canonicalize()
        .expect("resolve workspace root")
}

fn spawn_daemon(port: u16, token: &str) -> std::io::Result<Child> {
    let root = workspace_root();

    // M1 baseline (per implementation plan): dev-mode spawn invokes pnpm.
    // Use `pnpm.cmd` on Windows because `pnpm` resolves to a .cmd shim.
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
        // ORCA_DATA_DIR intentionally unset: daemon resolves the platform default
        // (~/.orca on Unix, %APPDATA%\Orca on Windows), which matches the plan.
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Put the child in its own process group so we can kill the whole tree
    // (pnpm + tsx + node) on shutdown without leaving orphans.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn()?;

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

    Ok(child)
}

fn shutdown_daemon(child: &mut Child) {
    #[cfg(unix)]
    {
        // Negative pid signals the entire process group.
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
    let port = pick_free_port();
    let token = Uuid::new_v4().to_string();
    let endpoint = DaemonEndpoint {
        url: format!("http://127.0.0.1:{port}"),
        token: token.clone(),
    };

    let child = spawn_daemon(port, &token).expect("failed to spawn daemon");

    let state = DaemonState {
        endpoint,
        child: Mutex::new(Some(child)),
    };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![get_daemon_endpoint])
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
