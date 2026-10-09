import type {SyncConnector, SyncInput, SyncResult} from "../types";

/** 手动兜底适配器：不自动同步，余额与倍率由用户在 UI 手动维护。 */
export class ManualAdapter implements SyncConnector {
  readonly providerType = "manual" as const;
  readonly capabilities = {balance: false, rates: false, quota: false, auth: "manual" as const};

  async sync(_input: SyncInput): Promise<SyncResult> {
    return {providerType: "manual"};
  }
}
