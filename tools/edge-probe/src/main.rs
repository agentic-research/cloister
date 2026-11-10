// SPDX-License-Identifier: AGPL-3.0-or-later
//
// edge-probe — the guest half of "no declared edge ⇒ no channel"
// (cloister-77870d).
//
// The plan declares ONE §6 `bind` grant. On the microVM tier that compiles to
// one vsock port the guest may serve on (LLO `vsock_unix_mappings`: grant 0,
// bind ⇒ VSOCK_UNIX_BASE_PORT + 1), and the host dials the granted UNIX path to
// reach it. Nothing else is supposed to exist: no NIC, no implicit vsock, no
// TSI. This binary serves the one channel and, over it, reports every other
// way out it tried and how each failed — guest stdout is discarded by the
// backend today (ley-line-open-a26ad0), so the channel is the only witness.
//
// Protocol: the host connects, the probe writes its report and exits 0.

use std::io::Write;
use std::net::{SocketAddr, TcpStream, UdpSocket};
use std::os::fd::FromRawFd;
use std::time::Duration;

const VSOCK_UNIX_BASE_PORT: u32 = 0x1_0000;
const SERVE_PORT: u32 = VSOCK_UNIX_BASE_PORT + 1;
const VMADDR_CID_HOST: u32 = 2;

fn vsock_addr(cid: u32, port: u32) -> libc::sockaddr_vm {
    let mut addr: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
    addr.svm_family = libc::AF_VSOCK as libc::sa_family_t;
    addr.svm_cid = cid;
    addr.svm_port = port;
    addr
}

fn errno() -> String {
    std::io::Error::last_os_error().to_string()
}

/// Try to dial the host over vsock on `port`; report the outcome.
fn dial_vsock(port: u32) -> String {
    unsafe {
        let fd = libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM, 0);
        if fd < 0 {
            return format!("socket: {}", errno());
        }
        let addr = vsock_addr(VMADDR_CID_HOST, port);
        let rc = libc::connect(
            fd,
            &addr as *const _ as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t,
        );
        let out = if rc == 0 { "CONNECTED".to_string() } else { errno() };
        libc::close(fd);
        out
    }
}

fn dial_tcp(target: &str) -> String {
    let addr: SocketAddr = target.parse().unwrap();
    match TcpStream::connect_timeout(&addr, Duration::from_secs(2)) {
        Ok(_) => "CONNECTED".into(),
        Err(e) => e.to_string(),
    }
}

fn send_udp(target: &str) -> String {
    match UdpSocket::bind("0.0.0.0:0").and_then(|s| s.send_to(b"x", target)) {
        Ok(n) => format!("SENT {n} bytes"),
        Err(e) => e.to_string(),
    }
}

fn interfaces() -> String {
    match std::fs::read_dir("/sys/class/net") {
        Ok(entries) => {
            let mut names: Vec<String> = entries
                .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
                .collect();
            names.sort();
            names.join(",")
        }
        Err(e) => format!("unreadable: {e}"),
    }
}

fn main() {
    // Probe first, so the report describes the guest before any connection.
    let report = [
        format!("interfaces: {}", interfaces()),
        format!("vsock dial {VSOCK_UNIX_BASE_PORT} (grant 0 dial half, not declared): {}", dial_vsock(VSOCK_UNIX_BASE_PORT)),
        format!("vsock dial {SERVE_PORT} (grant 0 serve half, guest-originated): {}", dial_vsock(SERVE_PORT)),
        format!("vsock dial {} (no grant 1): {}", VSOCK_UNIX_BASE_PORT + 2, dial_vsock(VSOCK_UNIX_BASE_PORT + 2)),
        format!("vsock dial 1024 (below the §6 range): {}", dial_vsock(1024)),
        format!("tcp 1.1.1.1:443: {}", dial_tcp("1.1.1.1:443")),
        format!("tcp 10.0.2.2:80: {}", dial_tcp("10.0.2.2:80")),
        format!("udp 1.1.1.1:53: {}", send_udp("1.1.1.1:53")),
    ]
    .join("\n");

    unsafe {
        let fd = libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM, 0);
        assert!(fd >= 0, "socket: {}", errno());
        let addr = vsock_addr(libc::VMADDR_CID_ANY, SERVE_PORT);
        let rc = libc::bind(
            fd,
            &addr as *const _ as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t,
        );
        assert!(rc == 0, "bind vsock {SERVE_PORT}: {}", errno());
        assert!(libc::listen(fd, 1) == 0, "listen: {}", errno());
        let conn = libc::accept(fd, std::ptr::null_mut(), std::ptr::null_mut());
        assert!(conn >= 0, "accept: {}", errno());
        let mut stream = std::fs::File::from_raw_fd(conn);
        let _ = writeln!(stream, "edge-probe: served on declared vsock port {SERVE_PORT}\n{report}");
    }
}
