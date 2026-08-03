#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Repository compatibility wrapper. Product behavior lives under cli/.

export * from "../cli/lib/dev/bootstrap.mjs";
import { main } from "../cli/lib/dev/bootstrap.mjs";
import { runIfDirect } from "./lib/run-cli-wrapper.mjs";
await runIfDirect(import.meta.url, main, "dev-bootstrap");
