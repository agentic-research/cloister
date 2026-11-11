#![cfg(feature = "llo-execution")]
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cloister-991e65 review, fix 4: a stop that arrives while LLO is still
// STARTING the run. LLO publishes a run only when `start` returns, so an
// immediate cancel answers `Ok(false)` and the worker being started keeps
// running — the host runtime then printed "stopped" and exited, leaving it.
// The backend here models exactly that: `cancel` is `Ok(false)` until `start`
// has returned, `Ok(true)` after. cloister must wait for start to settle and
// cancel then. (LLO side: ley-line-open-f963e6.)

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cloister_host_runtime::execution::{
    AwaitRun, CancelOutcome, Deployment, LeylineExecutionBackend,
};
use cloister_host_runtime::{Artifact, Backend, Confinement, ExecutionMode, LaunchPlan};
use leyline_runtime::{
    Backend as LeylineBackendTrait, BackendCapabilities, BackendClass, BackendRun,
    BackendRunStatus, EnforcedCeilings, ExecutionError, ExecutionRequest, RunOutcome,
};

/// `start` blocks until released; `cancel` reflects whether LLO has published
/// the run yet, like the real backend.
struct GatedBackend {
    entered: Mutex<Option<Sender<()>>>,
    release: Mutex<Receiver<()>>,
    fail_start: bool,
    published: AtomicBool,
    cancelled: AtomicBool,
    /// What each inner `cancel` call answered, in order.
    cancels: Mutex<Vec<bool>>,
}

impl GatedBackend {
    fn new(fail_start: bool) -> (Arc<Self>, Receiver<()>, Sender<()>) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let backend = Arc::new(Self {
            entered: Mutex::new(Some(entered_tx)),
            release: Mutex::new(release_rx),
            fail_start,
            published: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            cancels: Mutex::new(Vec::new()),
        });
        (backend, entered_rx, release_tx)
    }
}

impl AwaitRun for GatedBackend {
    fn await_run(&self, _run_id: &str) -> Result<RunOutcome, ExecutionError> {
        while !self.cancelled.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(RunOutcome {
            status: BackendRunStatus::Succeeded,
            output: None,
        })
    }
}

impl LeylineBackendTrait for GatedBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            backend_id: "gated".into(),
            backend_class: BackendClass::MicroVm,
            available: true,
            unavailable_reason: None,
            enforced: EnforcedCeilings::hypervisor_backed(),
        }
    }

    fn start(&self, _request: &ExecutionRequest) -> Result<BackendRun, ExecutionError> {
        if let Some(tx) = self.entered.lock().unwrap().take() {
            let _ = tx.send(());
        }
        let _ = self.release.lock().unwrap().recv();
        if self.fail_start {
            return Err(ExecutionError::backend("worker never became ready"));
        }
        self.published.store(true, Ordering::SeqCst);
        Ok(BackendRun {
            backend_id: "gated".into(),
            channels: Vec::new(),
        })
    }

    fn cancel(&self, _run_id: &str) -> Result<bool, ExecutionError> {
        let published = self.published.load(Ordering::SeqCst);
        self.cancels.lock().unwrap().push(published);
        if published {
            self.cancelled.store(true, Ordering::SeqCst);
        }
        Ok(published)
    }
}

fn plan() -> LaunchPlan {
    LaunchPlan {
        schema: "cloister/host-runtime/v1".into(),
        bundle: "alpha".into(),
        mode: ExecutionMode::Microvm,
        artifact: Artifact {
            image: "ghcr.io/example/alpha".into(),
            digest: format!("blake3-256:{}", "a".repeat(64)),
            entrypoint: "/bin/agent".into(),
            args: Vec::new(),
        },
        confinement: Confinement::default(),
        workspace: "/tmp/workspace".into(),
        control_socket: "/tmp/control.sock".into(),
    }
}

#[test]
fn a_stop_during_start_waits_for_start_and_then_cancels_the_published_run() {
    let (inner, entered, release) = GatedBackend::new(false);
    let backend = Arc::new(LeylineExecutionBackend::new(
        Arc::clone(&inner),
        Deployment::default(),
    ));

    let launching = {
        let backend = Arc::clone(&backend);
        std::thread::spawn(move || backend.launch(&plan()))
    };
    entered
        .recv_timeout(Duration::from_secs(5))
        .expect("start was entered");

    // The hazard, shown on the inner backend directly: during start LLO
    // answers Ok(false) — "no such run" — although a worker is starting.
    assert!(!inner.cancel("run-alpha").unwrap());

    let (done_tx, done_rx) = mpsc::channel();
    let stopper = {
        let backend = Arc::clone(&backend);
        std::thread::spawn(move || {
            let outcome = backend.cancel(&plan());
            let _ = done_tx.send(());
            outcome
        })
    };
    // While start is in progress the stop waits; it must not cancel early.
    assert!(
        done_rx.recv_timeout(Duration::from_millis(100)).is_err(),
        "a stop during start returned before start settled"
    );
    release.send(()).unwrap();

    let outcome = stopper.join().unwrap().expect("cancel");
    assert_eq!(outcome, CancelOutcome::Cancelled);
    // One premature Ok(false) from the direct probe above, then exactly one
    // cancel from cloister — after the run was published.
    assert_eq!(*inner.cancels.lock().unwrap(), vec![false, true]);
    launching
        .join()
        .unwrap()
        .expect("the launch completes once cancelled");
}

#[test]
fn a_stop_before_launch_means_the_run_is_never_started() {
    let (inner, _entered, _release) = GatedBackend::new(false);
    let backend = LeylineExecutionBackend::new(Arc::clone(&inner), Deployment::default());
    assert_eq!(
        backend.cancel(&plan()).unwrap(),
        CancelOutcome::NeverStarted
    );
    let err = backend
        .launch(&plan())
        .expect_err("must not start after a stop");
    assert!(err.to_string().contains("not starting it"), "{err}");
    assert!(
        inner.cancels.lock().unwrap().is_empty(),
        "nothing to cancel in LLO"
    );
}

#[test]
fn a_stop_while_start_fails_reports_that_there_was_nothing_to_stop() {
    let (inner, entered, release) = GatedBackend::new(true);
    let backend = Arc::new(LeylineExecutionBackend::new(
        Arc::clone(&inner),
        Deployment::default(),
    ));
    let launching = {
        let backend = Arc::clone(&backend);
        std::thread::spawn(move || backend.launch(&plan()))
    };
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    let stopper = {
        let backend = Arc::clone(&backend);
        std::thread::spawn(move || backend.cancel(&plan()))
    };
    release.send(()).unwrap();
    assert_eq!(stopper.join().unwrap().unwrap(), CancelOutcome::StartFailed);
    assert!(launching.join().unwrap().is_err());
    assert!(
        inner.cancels.lock().unwrap().is_empty(),
        "no cancel for a run that never existed"
    );
}
