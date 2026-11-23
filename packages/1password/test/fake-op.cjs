#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const started = Date.now();
const args = process.argv.slice(2);
const stdin = fs.fstatSync(0);
const call = {
  args,
  started,
  stdinIsPipe: stdin.isFIFO() || stdin.isSocket(),
};

const fixture = JSON.parse(
  fs.readFileSync(process.env.FAKE_OP_FIXTURE, "utf8"),
);
const vault = (args.find((arg) => arg.startsWith("--vault=")) ?? "").slice(
  "--vault=".length,
);
const item = args[2];
const answer = fixture.all ??
  fixture.items[`${vault}/${item}`] ?? {
    stderr: `[ERROR] 2026/11/19 12:00:00 "${item}" isn't an item in the "${vault}" vault. Specify the item with its UUID, name, or domain.`,
  };

setTimeout(() => {
  call.ended = Date.now();
  fs.writeFileSync(
    path.join(
      process.env.FAKE_OP_LOG,
      `${started}-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
    ),
    JSON.stringify(call),
  );
  if (answer.item) {
    process.stdout.write(JSON.stringify(answer.item));
    return;
  }
  if (answer.stdout !== undefined) process.stdout.write(answer.stdout);
  if (answer.stderr !== undefined) {
    process.stderr.write(`${answer.stderr}\n`);
    process.exitCode = answer.exitCode ?? 1;
  }
}, answer.delayMs ?? 0);
