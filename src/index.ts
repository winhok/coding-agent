#!/usr/bin/env node

import { CLI_EXIT, runCli } from "./cli/run.js";

const exitCode = await runCli(process.argv.slice(2));
if (
  process.exitCode !== CLI_EXIT.interrupted &&
  process.exitCode !== CLI_EXIT.terminated
) {
  process.exitCode = exitCode;
}
