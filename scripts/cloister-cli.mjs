#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Compatibility path for older repository callers. The package bin is bin/cloister.mjs.

import { run } from "../bin/cloister.mjs";

process.exitCode = await run();
