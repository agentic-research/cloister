#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

export * from "../cli/commands/runtime-storage-init.mjs";
import { main } from "../cli/commands/runtime-storage-init.mjs";
import { runIfDirect } from "./lib/run-cli-wrapper.mjs";
await runIfDirect(import.meta.url, main, "cloister runtime storage init");
