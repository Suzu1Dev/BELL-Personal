import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Express } from "express";
import { appContext, createApp, type AppOptions } from "./app.js";
import type { CommandOptions, CommandResult, CommandRunner } from "./ai/process.js";
import { PROFILE_ROLES } from "../shared/profile.js";
import { AppError } from "./errors.js";
import { readRuntimeConfig } from "./runtime-config.js";
import { offlineNetwork } from "./public-fetch.js";
import { createServices, type CoreServices, type ServiceSeams } from "./services.js";

/** The Claude Code 2.1.292 stream recorded on this host (server/fixtures), one parsed event per line. */
export const claudeFixtureEvents = (): Record<string, any>[] =>
  readFileSync(new URL("./fixtures/claude-structured-output.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));

/** A fixed 32-byte key for tests (base64). */
export const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

export function tempDir(t: TestContext, prefix = "bell-personal-test-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Runtime config for tests: data and secrets in `dir`, a master key, plus any overrides. */
export function testConfig(dir: string, env: NodeJS.ProcessEnv = {}) {
  return readRuntimeConfig({
    BELLPERSONAL_DATA_DIR: join(dir, "data"),
    BELLPERSONAL_SECRETS_DIR: join(dir, "secrets"),
    BELLPERSONAL_MASTER_KEY: TEST_MASTER_KEY,
    ...env,
  });
}

export interface RecordedCall {
  executable: string;
  args: string[];
  options: CommandOptions;
}

/**
 * A command() fake: `respond` decides each call's stdout (lines are replayed
 * through onLine, like the real CLI), or throws to simulate a failure.
 * Unhandled CLIs (status probes) fail like a missing executable.
 */
export function fakeCommand(respond: (call: RecordedCall) => string | CommandResult | undefined | Promise<string | CommandResult | undefined>) {
  const calls: RecordedCall[] = [];
  const runner: CommandRunner = async (executable, args, options = {}) => {
    const call = { executable, args, options };
    calls.push(call);
    if (options.signal?.aborted) throw new AppError(409, "工作已取消。");
    const answer = await respond(call);
    if (answer === undefined) throw new AppError(503, `${executable} 無法啟動：not found`);
    const result = typeof answer === "string" ? { stdout: answer, stderr: "", code: 0 } : answer;
    for (const line of result.stdout.split("\n")) if (line) options.onLine?.(line, "stdout");
    if (options.signal?.aborted) throw new AppError(409, "工作已取消。");
    if (!(options.allowedCodes ?? [0]).includes(result.code)) throw new AppError(422, `${executable} 執行失敗`);
    return result;
  };
  return { runner, calls };
}

/**
 * Core services on a fresh temp data dir. Every role is ticked so each
 * feature module is on, as before 初次設定 existed; `fresh: true` keeps a
 * new install's settings (no roles, 初次設定 not done).
 */
export function testServices(t: TestContext, options: { env?: NodeJS.ProcessEnv; seams?: ServiceSeams; fresh?: boolean } = {}): CoreServices {
  const dir = tempDir(t);
  // Never the real network from a test: remote images go nowhere unless a test injects its own network.
  const services = createServices(testConfig(dir, options.env), { command: fakeCommand(() => undefined).runner, publicNetwork: offlineNetwork, ...options.seams });
  t.after(() => services.close());
  if (!options.fresh) allFeatures(services);
  return services;
}

/** Ticks every role (each feature module on), for tests that are not about 身分與功能. */
export function allFeatures(services: Pick<CoreServices, "settings">): void {
  services.settings.update({ "profile.roles": [...PROFILE_ROLES] });
}

export interface TestServer {
  port: number;
  app: Express;
  services: CoreServices;
  /** Raw HTTP request; Host defaults to 127.0.0.1:4331 (an allowed local host). */
  call(method: string, path: string, options?: { headers?: Record<string, string | undefined>; body?: unknown }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any; body: Buffer }>;
}

/** createApp + listen(0) with cleanup in t.after (closes the server, modules and services). */
export async function startTestServer(t: TestContext, services: CoreServices, options: AppOptions = {}): Promise<TestServer> {
  const app = createApp(services, { staticDirectory: join(services.config.dataDir, "missing-dist"), ...options });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    appContext(app).today.actions.close();
    await appContext(app).modules.close();
  });
  const port = (server.address() as AddressInfo).port;
  const call: TestServer["call"] = (method, path, callOptions = {}) =>
    new Promise((resolve, reject) => {
      const body = callOptions.body === undefined ? undefined : typeof callOptions.body === "string" ? callOptions.body : JSON.stringify(callOptions.body);
      const headers: Record<string, string> = { host: "127.0.0.1:4331" };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        // Node sends DELETE bodies without a length unless told; browsers always send one.
        headers["content-length"] = String(Buffer.byteLength(body));
      }
      for (const [key, value] of Object.entries(callOptions.headers ?? {})) {
        if (value === undefined) delete headers[key.toLowerCase()];
        else headers[key.toLowerCase()] = value;
      }
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => { chunks.push(chunk); });
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const text = raw.toString("utf8");
          let json: unknown;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolve({ status: res.statusCode!, headers: res.headers, text, json, body: raw });
        });
      });
      req.on("error", reject);
      req.end(body);
    });
  return { port, app, services, call };
}
