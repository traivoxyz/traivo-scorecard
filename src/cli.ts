#!/usr/bin/env node
import { run } from "./run.js";

run(process.argv.slice(2), {
  out: (l) => process.stdout.write(l + "\n"),
  err: (l) => process.stderr.write(l + "\n"),
}).then((code) => {
  process.exitCode = code;
});
