// I-06: cache snapshot ber-versi. Invalidasi: cek `cfg:version` (default tiap 10 s) — outbox publisher menaikkan
// versi di setiap perubahan config → berlaku ≤ interval poll + waktu publish (FR-P02 ≤ 30 s, R-12).
import type { Logger } from "@smip/observability";
import type { Snapshot } from "./snapshot";

/** Kunci Redis versi config (sama dengan @smip/db CONFIG_VERSION_KEY; diduplikasi karena router tak boleh impor db). */
export const CONFIG_VERSION_KEY = "cfg:version";
export type SnapshotLoader = (version: number) => Promise<Snapshot>;

export interface VersionSource {
  get(key: string): Promise<string | null>;
}

export class SnapshotStore {
  private snap: Snapshot | null = null;
  private checkedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loading: Promise<Snapshot> | null = null;

  constructor(
    private readonly load: SnapshotLoader,
    private readonly versions: VersionSource,
    private readonly opts: { pollMs?: number; logger?: Logger; now?: () => number } = {},
  ) {}

  private get pollMs() {
    return this.opts.pollMs ?? 10_000;
  }

  /**
   * Snapshot terkini. Versi config dicek paling sering sekali per `pollMs` (hemat 1 GET Redis per plan);
   * bila berubah → reload. Perubahan config terlihat ≤ pollMs setelah outbox dipublikasikan (R-12).
   */
  async get(): Promise<Snapshot> {
    const now = (this.opts.now ?? Date.now)();
    if (this.snap && now - this.checkedAt < this.pollMs) return this.snap;
    return this.refresh(now);
  }

  /** Paksa cek versi sekarang (dipanggil subscriber `config.changed` untuk invalidasi instan). */
  async refresh(now = (this.opts.now ?? Date.now)()): Promise<Snapshot> {
    const v = Number((await this.versions.get(CONFIG_VERSION_KEY)) ?? 0);
    this.checkedAt = now;
    if (this.snap && this.snap.version === v) return this.snap;
    this.loading ??= this.load(v).finally(() => {
      this.loading = null;
    });
    this.snap = await this.loading;
    this.opts.logger?.info("router snapshot dimuat", {
      version: v,
      policies: this.snap.policies.size,
      connectors: this.snap.connectors.size,
    });
    return this.snap;
  }

  /** Poll versi di latar (worker-dispatch) supaya plan() tidak menunggu reload. */
  start(): void {
    this.timer ??= setInterval(
      () => void this.refresh().catch((e) => this.opts.logger?.error("reload snapshot gagal", { error: e })),
      this.pollMs,
    );
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
