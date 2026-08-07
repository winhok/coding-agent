#!/usr/bin/env node

const command = process.argv[2];

if (command === "init") {
  import("./config/init.js").then((module) => module.runInit());
} else {
  import("./main.js").then((module) =>
    module.startAgent().catch(console.error),
  );
}
