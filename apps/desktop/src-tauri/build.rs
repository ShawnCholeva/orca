fn main() {
    // Expose the build's target triple so lib.rs can locate the
    // Tauri-bundled sidecar binary, which is suffixed with this triple.
    let triple = std::env::var("TARGET").expect("TARGET env var set by cargo");
    println!("cargo:rustc-env=ORCA_TARGET_TRIPLE={triple}");
    tauri_build::build()
}
