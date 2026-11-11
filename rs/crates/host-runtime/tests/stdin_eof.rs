// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cloister-991e65 review, fix 3: `run --stop-on-stdin-eof` stops the run when
// its supervisor goes away. `cluster up` holds each host runtime's stdin open
// and never writes; when `up` dies — even by SIGKILL — the pipe closes. These
// pin the watcher that turns that EOF into a stop.

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::sync::mpsc;
use std::time::Duration;

use cloister_host_runtime::watch_for_eof;

#[test]
fn eof_on_an_empty_reader_fires_once() {
    let mut fired = 0;
    watch_for_eof(std::io::empty(), || fired += 1);
    assert_eq!(fired, 1);
}

#[test]
fn data_is_not_eof_and_closing_the_writer_is() {
    let (mut writer, reader) = UnixStream::pair().unwrap();
    let (tx, rx) = mpsc::channel();
    let watcher = std::thread::spawn(move || watch_for_eof(reader, move || tx.send(()).unwrap()));

    writer.write_all(b"anything").unwrap();
    assert!(
        rx.recv_timeout(Duration::from_millis(100)).is_err(),
        "bytes on stdin must not read as the supervisor going away"
    );

    drop(writer); // the supervisor dies: its end of the pipe closes
    rx.recv_timeout(Duration::from_secs(5)).expect("EOF fires the stop");
    watcher.join().unwrap();
}
