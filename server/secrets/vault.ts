import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";
import { logEvent } from "../log.js";

/**
 * Encrypted credential store: $BELLPERSONAL_SECRETS_DIR/secrets.enc.json, mode
 * 0600 in a 0700 directory, outside the data directory so backups never carry
 * it (restoring a backup means reconnecting sources, by design).
 *
 * Each record is sealed on its own with AES-256-GCM: a random 12-byte IV, the
 * auth tag, and the record name as additional authenticated data, so a record
 * cannot be moved under another name. `kid` names the key that sealed it, so a
 * rotated master key can still open older records (see `previousKeys`).
 * Values never reach the browser and never reach a log line.
 */
export const VAULT_FILE = "secrets.enc.json";
const NAME = /^[a-z0-9][a-z0-9._:-]{0,99}$/;
const AAD_PREFIX = "bell-personal:vault:v1:";

interface SealedRecord {
  kid: string;
  iv: string;
  tag: string;
  data: string;
  updatedAt: string;
}
interface VaultFile {
  version: 1;
  records: Record<string, SealedRecord>;
}

export interface VaultRecordInfo {
  name: string;
  updatedAt: string;
  kid: string;
}

export interface VaultOptions {
  /** Directory holding secrets.enc.json (BELLPERSONAL_SECRETS_DIR). */
  directory: string;
  /** 32-byte master key; null disables the vault (credentialed sources stay off). */
  key: Buffer | null;
  /** Older master keys, so records sealed before a rotation still open. */
  previousKeys?: Buffer[];
  now?: () => Date;
}

/** Raised when a stored record cannot be opened (wrong or rotated key, tampering). Sources map it to 需要重新連線. */
export class VaultKeyError extends AppError {
  constructor(message = "無法解開已保存的連線憑證，主金鑰可能已更換。請重新連線這個來源。") { super(503, message); this.name = "VaultKeyError"; }
}

export const keyId = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 12);

function assertName(name: string): void {
  if (!NAME.test(name)) throw new Error(`Invalid vault record name: ${name}`);
}

export class Vault {
  readonly file: string;
  private readonly keys = new Map<string, Buffer>();
  private readonly currentKid: string | null;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => Date;

  constructor(private readonly options: VaultOptions) {
    this.file = path.join(options.directory, VAULT_FILE);
    this.now = options.now ?? (() => new Date());
    for (const key of [options.key, ...(options.previousKeys ?? [])]) {
      if (!key) continue;
      if (key.length !== 32) throw new Error("Vault keys must be exactly 32 bytes.");
      this.keys.set(keyId(key), key);
    }
    this.currentKid = options.key ? keyId(options.key) : null;
  }

  /** False when no master key is configured: every read and write then fails with 503. */
  get enabled(): boolean {
    return this.currentKid !== null;
  }

  async get<T = unknown>(name: string): Promise<T | undefined> {
    assertName(name);
    this.requireKey();
    const record = (await this.load()).records[name];
    if (!record) return undefined;
    return JSON.parse(this.open(name, record).toString("utf8")) as T;
  }

  async has(name: string): Promise<boolean> {
    assertName(name);
    this.requireKey();
    return Boolean((await this.load()).records[name]);
  }

  /**
   * Whether a record exists and whether a key this vault holds sealed it,
   * read from the record's `kid` without opening it: "foreign" is a record
   * sealed with a master key this server does not have (a copied secrets file).
   */
  async sealedBy(name: string): Promise<"missing" | "known" | "foreign"> {
    assertName(name);
    this.requireKey();
    const record = (await this.load()).records[name];
    if (!record) return "missing";
    return this.keys.has(record.kid) ? "known" : "foreign";
  }

  /** Names and timestamps only, never values. */
  async list(): Promise<VaultRecordInfo[]> {
    this.requireKey();
    const file = await this.load();
    return Object.entries(file.records).map(([name, record]) => ({ name, updatedAt: record.updatedAt, kid: record.kid })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async set(name: string, value: unknown): Promise<void> {
    assertName(name);
    const key = this.requireKey();
    if (value === undefined) throw new Error("Vault values must be JSON-serialisable and not undefined.");
    await this.lock(async () => {
      const file = await this.load();
      file.records[name] = this.seal(name, Buffer.from(JSON.stringify(value), "utf8"), key);
      await this.write(file);
    });
  }

  /**
   * Read-modify-write under the write lock, so a delete or set queued alongside
   * cannot be undone by a value computed from an older read. `change` gets the
   * stored value (undefined when there is none); returning undefined writes
   * nothing. Resolves to whether it wrote.
   */
  async update<T>(name: string, change: (current: T | undefined) => T | undefined): Promise<boolean> {
    assertName(name);
    const key = this.requireKey();
    return this.lock(async () => {
      const file = await this.load();
      const record = file.records[name];
      const next = change(record ? (JSON.parse(this.open(name, record).toString("utf8")) as T) : undefined);
      if (next === undefined) return false;
      file.records[name] = this.seal(name, Buffer.from(JSON.stringify(next), "utf8"), key);
      await this.write(file);
      return true;
    });
  }

  async delete(name: string): Promise<boolean> {
    assertName(name);
    this.requireKey();
    return this.lock(async () => {
      const file = await this.load();
      if (!file.records[name]) return false;
      delete file.records[name];
      await this.write(file);
      return true;
    });
  }

  /** Re-seals every record with the current key, after a rotation. Returns how many changed. */
  async rotate(): Promise<number> {
    const key = this.requireKey();
    return this.lock(async () => {
      const file = await this.load();
      let changed = 0;
      for (const [name, record] of Object.entries(file.records)) {
        if (record.kid === this.currentKid) continue;
        file.records[name] = this.seal(name, this.open(name, record), key);
        changed++;
      }
      if (changed) await this.write(file);
      return changed;
    });
  }

  private requireKey(): Buffer {
    if (!this.currentKid) throw new AppError(503, "尚未設定主金鑰，無法保存連線憑證。請依部署說明設定後重新啟動服務。");
    return this.keys.get(this.currentKid)!;
  }

  private seal(name: string, plaintext: Buffer, key: Buffer): SealedRecord {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(AAD_PREFIX + name, "utf8"));
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { kid: this.currentKid!, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64"), updatedAt: this.now().toISOString() };
  }

  private open(name: string, record: SealedRecord): Buffer {
    const key = this.keys.get(record.kid);
    if (!key) throw new VaultKeyError();
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
      decipher.setAAD(Buffer.from(AAD_PREFIX + name, "utf8"));
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]);
    } catch {
      logEvent("vault.unreadable", { name });
      throw new VaultKeyError();
    }
  }

  private async load(): Promise<VaultFile> {
    let raw: string;
    try { raw = await readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: {} };
      throw new AppError(500, "無法讀取憑證檔案，請檢查本機服務記錄。");
    }
    try {
      const parsed = JSON.parse(raw) as VaultFile;
      if (parsed?.version === 1 && parsed.records && typeof parsed.records === "object") return parsed;
    } catch { /* reported below */ }
    logEvent("vault.unreadable", { name: "*" });
    throw new AppError(500, "憑證檔案格式不正確，請移開損毀的檔案後重新連線來源。");
  }

  /** bell-pr's writeJsonAtomically, plus fsync of the file before the rename and of the directory after it. */
  private async write(value: VaultFile): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    await chmod(this.options.directory, 0o700);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(value, null, 2));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.file);
      try {
        const directory = await open(this.options.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } catch { /* Directory fsync is best effort on some filesystems. */ }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** bell-pr's promise-chain lock: writes are serialised so concurrent sets never lose each other. */
  private async lock<T>(task: () => Promise<T>): Promise<T> {
    const id = "file";
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.locks.set(id, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }
}
