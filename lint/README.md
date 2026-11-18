# `lint/`: the rails

Each file checks one invariant of the repository and exits non-zero when it
does not hold. `task lint` runs them. [`CLAUDE.md`](../CLAUDE.md) lists what
each rail protects and why it exists.

A rail has a test in [`lint/test/`](test/) that runs it against the real tree,
so it cannot pass with nothing to check. That directory also holds the tests
that are rails in their own right: properties of the whole repository, such as
"every test file is run".

Add a rail here, wire it into `lint` in [`Taskfile.yml`](../Taskfile.yml), and
give it a test in the same change.
