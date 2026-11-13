import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { command } from "./process.js";

// A child that answers each stdin line and exits when stdin closes, like `claude auth login` waiting for a pasted code.
const ECHO = "process.stdin.setEncoding('utf8');process.stdout.write('ready\\n');let all='';process.stdin.on('data',(d)=>{all+=d});process.stdin.on('end',()=>{process.stdout.write('got '+all.trim()+'\\n')})";

test("command(): a stdin stream stays open until it ends, so a running CLI can be answered later", async () => {
  const stdin = new PassThrough();
  const lines: string[] = [];
  const run = command(process.execPath, ["-e", ECHO], { stdin, timeoutMs: 10_000, onLine: (line) => {
    lines.push(line);
    if (line === "ready") setTimeout(() => stdin.end("the-code\n"), 20);
  } });
  const result = await run;
  assert.deepEqual(lines, ["ready", "got the-code"]);
  assert.equal(result.code, 0);
});

test("command(): aborting a process waiting on a stdin stream stops it", async () => {
  const stdin = new PassThrough();
  const controller = new AbortController();
  const run = command(process.execPath, ["-e", ECHO], { stdin, signal: controller.signal, timeoutMs: 10_000, onLine: (line) => {
    if (line === "ready") controller.abort();
  } });
  await assert.rejects(run, (error: { status?: number }) => error.status === 409);
  stdin.destroy();
});

test("command(): a failure message masks the secrets it was given and any key-shaped CLI output", async () => {
  const key = `sk-proj-${"w".repeat(40)}`;
  const script = `process.stderr.write("401 Unauthorized: " + ${JSON.stringify(key)} + " (" + ${JSON.stringify(key.slice(0, 12))} + "…" + ${JSON.stringify(key.slice(-6))} + ")\\n"); process.exit(3)`;
  await assert.rejects(command(process.execPath, ["-e", script], { timeoutMs: 10_000, secrets: [key] }), (error: { status?: number; message: string }) => {
    assert.equal(error.status, 422);
    for (const fragment of [key, key.slice(0, 12), key.slice(-6)]) assert.ok(!error.message.includes(fragment), fragment.slice(0, 4));
    assert.match(error.message, /執行失敗：401 Unauthorized: \[REDACTED\] \(\[REDACTED\]\)$/);
    return true;
  });
  // No secrets given: the shape alone still masks a key the CLI printed.
  await assert.rejects(command(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(key)}); process.exit(1)`], { timeoutMs: 10_000 }),
    (error: { message: string }) => !error.message.includes(key.slice(0, 12)) && /\[REDACTED\]/.test(error.message));
});
