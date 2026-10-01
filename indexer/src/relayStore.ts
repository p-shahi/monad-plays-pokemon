import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";

const recordSchema = z.object({
  requestId: z.string(), owner: z.string(), action: z.number().int(),
  executionNonce: z.string(), deadline: z.number().int(), sponsorNonce: z.number().int(),
  txHash: z.string(), rawTransaction: z.string(), reserved: z.string(),
  status: z.enum(["pending", "confirmed", "failed"]),
  cancelHash: z.string().optional(), cancelRaw: z.string().optional(),
  settledAt: z.number().optional(), error: z.string().optional(),
});
export type RelayRecord = z.infer<typeof recordSchema>;

const journalSchema = z.object({
  version: z.literal(1), network: z.string(), sponsor: z.string(),
  records: z.record(z.string(), recordSchema), spent: z.record(z.string(), z.string()),
});

export class RelayStore {
  private compromised = false;
  private constructor(
    private filename: string,
    readonly data: z.infer<typeof journalSchema>,
    private release: () => Promise<void>,
  ) {}

  static async open(directory: string, network: string, sponsor: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let compromised = false;
    const release = await lockfile.lock(directory, {
      lockfilePath: path.join(directory, "relay.lock"),
      stale: 10000,
      onCompromised: () => { compromised = true; },
    });
    try {
      const filename = path.join(directory, "relay.json");
      let data: z.infer<typeof journalSchema>;
      try {
        data = journalSchema.parse(JSON.parse(await readFile(filename, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        data = { version: 1, network, sponsor, records: {}, spent: {} };
      }
      if (data.network !== network || (sponsor && data.sponsor && data.sponsor !== sponsor)) {
        throw new Error("Relay journal belongs to another network or sponsor. Use a separate SAVE_DIR.");
      }
      data.sponsor ||= sponsor;
      const store = new RelayStore(filename, data, release);
      store.assertWritable = () => {
        if (compromised || store.compromised) throw new Error("Relay journal is unavailable");
      };
      await store.save();
      return store;
    } catch (error) {
      await release();
      throw error;
    }
  }

  assertWritable() {
    if (this.compromised) throw new Error("Relay journal is unavailable");
  }

  async save() {
    this.assertWritable();
    const temporary = `${this.filename}.tmp`;
    try {
      const file = await open(temporary, "w", 0o600);
      try {
        await file.writeFile(JSON.stringify(this.data));
        await file.sync();
      } finally { await file.close(); }
      this.assertWritable();
      await rename(temporary, this.filename);
      const directory = await open(path.dirname(this.filename), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      this.compromised = true;
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  pending() {
    return Object.values(this.data.records).filter(record => record.status === "pending");
  }

  committed(day: string) {
    return BigInt(this.data.spent[day] ?? "0") +
      this.pending().reduce((sum, record) => sum + BigInt(record.reserved), 0n);
  }

  async settle(record: RelayRecord, status: "confirmed" | "failed", cost: bigint, error?: string) {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    record.status = status;
    record.error = error;
    record.settledAt = now;
    record.rawTransaction = "";
    delete record.cancelRaw;
    this.data.spent[day] = (BigInt(this.data.spent[day] ?? "0") + cost).toString();
    for (const [id, entry] of Object.entries(this.data.records)) {
      if (entry.settledAt && now - entry.settledAt > 86400000 && entry.deadline * 1000 < now) {
        delete this.data.records[id];
      }
    }
    for (const date of Object.keys(this.data.spent)) {
      if (Date.parse(date) < now - 7 * 86400000) delete this.data.spent[date];
    }
    await this.save();
  }

  async close() { await this.release(); }
}
