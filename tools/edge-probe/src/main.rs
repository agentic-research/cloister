// SPDX-License-Identifier: AGPL-3.0-or-later
//
// edge-probe — the guest half of "no declared edge ⇒ no channel"
// (cloister-77870d, cloister-da1a59).
//
// An ordinary std::net program: no vsock, nothing LLO-specific. Since LLO
// v0.28.0 (ADR-0046 Q7) each confinement/v1 §6 grant carrying a `guestPort`
// is presented as TCP on the guest loopback, so an unmodified workload sees
// its declared channels as plain sockets. The plan this runs under declares
// exactly two:
//
//   connect, guestPort 9000 — the workload dials its one declared peer
//   bind,    guestPort 8080 — the workload serves; only that channel reaches it
//
// It dials the peer, then tries every other way out, then serves one
// connection on 8080 and writes the whole report to it. Guest stdout is not
// relied on: the declared channel is the witness.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::time::Duration;

const PEER: &str = "127.0.0.1:9000";
const SERVE: &str = "127.0.0.1:8080";

fn dial(target: &str) -> String {
    let addr: SocketAddr = target.parse().unwrap();
    match TcpStream::connect_timeout(&addr, Duration::from_secs(2)) {
        Ok(_) => "CONNECTED".into(),
        Err(e) => e.to_string(),
    }
}

fn talk_to_peer() -> String {
    let attempt = || -> std::io::Result<String> {
        let mut s = TcpStream::connect(PEER)?;
        s.set_read_timeout(Some(Duration::from_secs(5)))?;
        s.write_all(b"hello from the guest\n")?;
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line)?;
        Ok(line.trim().to_string())
    };
    match attempt() {
        Ok(reply) => format!("replied {reply:?}"),
        Err(e) => format!("FAILED {e}"),
    }
}

fn udp() -> String {
    match UdpSocket::bind("127.0.0.1:0") {
        Ok(s) => match s.send_to(b"x", "1.1.1.1:53") {
            Ok(n) => format!("SENT {n} bytes"),
            Err(e) => format!("socket opened, send: {e}"),
        },
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
    let report = [
        format!("declared peer {PEER}: {}", talk_to_peer()),
        format!("undeclared loopback 127.0.0.1:9001: {}", dial("127.0.0.1:9001")),
        format!("undeclared loopback 127.0.0.1:3306: {}", dial("127.0.0.1:3306")),
        format!("tcp 1.1.1.1:443: {}", dial("1.1.1.1:443")),
        format!("tcp 10.0.2.2:80: {}", dial("10.0.2.2:80")),
        format!("udp 1.1.1.1:53: {}", udp()),
        format!("interfaces: {}", interfaces()),
    ]
    .join("\n");

    let listener = TcpListener::bind(SERVE).expect("bind the declared serve port");
    let (mut conn, _) = listener.accept().expect("accept on the declared serve port");
    let mut greeting = [0u8; 64];
    let _ = conn.set_read_timeout(Some(Duration::from_millis(200)));
    let _ = conn.read(&mut greeting);
    let _ = writeln!(conn, "edge-probe: served on declared {SERVE}\n{report}");
}
