// SPDX-License-Identifier: AGPL-3.0-or-later

import { createInterface } from "node:readline/promises";

export function isAffirmative(answer) {
  return /^(y|yes)$/i.test(String(answer).trim());
}

export async function requestOperatorConsent({
  input,
  output,
  prompt,
  nonInteractiveMessage,
}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error(nonInteractiveMessage);
  }
  const rl = createInterface({ input, output });
  try {
    return isAffirmative(await rl.question(prompt));
  } finally {
    rl.close();
  }
}
