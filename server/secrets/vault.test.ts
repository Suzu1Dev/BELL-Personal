import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../test-helpers.js";
import { Vault, VaultKeyError, keyId } from "./vault.js";

const key = Buffer.alloc(32, 3);
const otherKey = Buffer.alloc(32, 4);

test("records round-trip, are encrypted at rest and written 0600 in a 0700 directory", async (t) => {
  const dir = join(tempDir(t), "secrets");
  const vault = new Vault({ directory: dir, key });
  assert.equal(vault.enabled, true);
  assert.equal(await vault.get("google.oauth"), undefined);
  await vault.set("google.oauth", { refresh_token: "1//refresh-token-value", scope: "gmail.modify" });
  await vault.set("moodle.token", "moodle-token-value");
  assert.deepEqual(await vault.get("google.oauth"), { refresh_token: "1//refresh-token-value", scope: "gmail.modify" });
  assert.equal(await vault.get("moodle.token"), "moodle-token-value");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(vault.file).mode & 0o777, 0o600);
  const raw = readFileSync(vault.file, "utf8");
  assert.doesNotMatch(raw, /refresh-token-value|moodle-token-value|gmail\.modify/);
  const file = JSON.parse(raw);
  assert.equal(file.version, 1);
  assert.equal(file.records["moodle.token"].kid, keyId(key));
  assert.equal(Buffer.from(file.records["moodle.token"].iv, "base64").length, 12);
  assert.deepEqual((await vault.list()).map((item) => item.name), ["google.oauth", "moodle.token"]);
  assert.equal(await vault.delete("moodle.token"), true);
  assert.equal(await vault.delete("moodle.token"), false);
  assert.equal(await vault.has("moodle.token"), false);
  assert.deepEqual(readdirSync(dir), ["secrets.enc.json"], "no temporary files are left behind");
});

test("a record moved under another name, or tampered with, does not open", async (t) => {
  const dir = tempDir(t);
  const vault = new Vault({ directory: dir, key });
  await vault.set("a", "alpha");
  await vault.set("b", "beta");
  const file = JSON.parse(readFileSync(vault.file, "utf8"));
  file.records.b = file.records.a; // AAD is the record name
  writeFileSync(vault.file, JSON.stringify(file));
  await assert.rejects(vault.get("b"), VaultKeyError);
  assert.equal(await vault.get("a"), "alpha");
  file.records.a.data = Buffer.from("tampered").toString("base64");
  writeFileSync(vault.file, JSON.stringify(file));
  await assert.rejects(vault.get("a"), VaultKeyError);
});

test("a different master key cannot read old records; listing it as a previous key can, and rotate re-seals", async (t) => {
  const dir = tempDir(t);
  await new Vault({ directory: dir, key }).set("canvas.token", "canvas-secret");
  await assert.rejects(new Vault({ directory: dir, key: otherKey }).get("canvas.token"), (error: { status?: number }) => error instanceof VaultKeyError && error.status === 503);
  const rotated = new Vault({ directory: dir, key: otherKey, previousKeys: [key] });
  assert.equal(await rotated.get("canvas.token"), "canvas-secret");
  assert.equal(await rotated.rotate(), 1);
  assert.equal(await new Vault({ directory: dir, key: otherKey }).get("canvas.token"), "canvas-secret");
});

test("without a master key the vault is disabled with a user-facing 503", async (t) => {
  const vault = new Vault({ directory: tempDir(t), key: null });
  assert.equal(vault.enabled, false);
  await assert.rejects(vault.set("x", 1), (error: { status?: number; message?: string }) => error.status === 503 && /主金鑰/.test(error.message ?? ""));
  await assert.rejects(vault.get("x"), (error: { status?: number }) => error.status === 503);
});

test("concurrent writes are serialised and none is lost", async (t) => {
  const vault = new Vault({ directory: tempDir(t), key });
  await Promise.all(Array.from({ length: 20 }, (_, index) => vault.set(`k${index}`, index)));
  assert.equal((await vault.list()).length, 20);
  for (let index = 0; index < 20; index++) assert.equal(await vault.get(`k${index}`), index);
});

test("update reads and writes under the lock and never recreates a deleted record", async (t) => {
  const vault = new Vault({ directory: tempDir(t), key });
  const bump = (current: number | undefined) => (current === undefined ? undefined : current + 1);
  assert.equal(await vault.update("missing", bump), false);
  assert.equal(await vault.has("missing"), false);
  await vault.set("n", 1);
  assert.equal(await vault.update("n", bump), true);
  assert.equal(await vault.get("n"), 2);
  // Queued in either order next to a delete, the record ends up deleted.
  await Promise.all([vault.update("n", bump), vault.delete("n")]);
  assert.equal(await vault.has("n"), false);
  await vault.set("n", 1);
  await Promise.all([vault.delete("n"), vault.update("n", bump)]);
  assert.equal(await vault.has("n"), false);
});

test("names are validated and a corrupt file is reported, not overwritten silently", async (t) => {
  const dir = tempDir(t);
  const vault = new Vault({ directory: dir, key });
  await assert.rejects(vault.set("../escape", 1), /Invalid vault record name/);
  writeFileSync(vault.file, "{broken");
  await assert.rejects(vault.get("a"), (error: { status?: number }) => error.status === 500);
  await assert.rejects(vault.set("a", 1), (error: { status?: number }) => error.status === 500);
  assert.equal(readFileSync(vault.file, "utf8"), "{broken");
});
