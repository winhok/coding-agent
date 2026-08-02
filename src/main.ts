#!/usr/bin/env node

import { render } from "ink";
import { createElement } from "react";
import { App } from "./ui/app.tsx";

async function main(): Promise<void> {
  const app = render(createElement(App));
  await app.waitUntilExit();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
