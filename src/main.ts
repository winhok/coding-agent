#!/usr/bin/env node

import { render } from "ink";
import { createElement } from "react";
import { createRuntime } from "./index.ts";
import { App } from "./ui/app.tsx";

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const app = render(createElement(App, { runtime }));

  try {
    await app.waitUntilExit();
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
