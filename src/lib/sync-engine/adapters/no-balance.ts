import {SyncUnsupportedError, type SyncConnector, type SyncInput, type SyncResult} from "../types";

/**
 * 暂无公开余额接口的官方预设适配器：
 * 账号模块应隐藏，存量账号同步直接报不支持，不再伪装成功；
 * 套餐用量由对应套餐适配器独立承载。
 */
export class NoBalanceConsoleAdapter implements SyncConnector {
  readonly providerType: "openai" | "anthropic" | "minimax" | "volcengine-plan" | "tencent-hunyuan" | "opencode-go" | "qwenai" | "siliconflow";
  readonly capabilities = {balance: false, rates: false, quota: false, auth: "manual" as const};

  constructor(providerType: "openai" | "anthropic" | "minimax" | "volcengine-plan" | "tencent-hunyuan" | "opencode-go" | "qwenai" | "siliconflow") {
    this.providerType = providerType;
  }

  async sync(_input: SyncInput): Promise<SyncResult> {
    throw new SyncUnsupportedError("ACCOUNT_SYNC_UNSUPPORTED");
  }
}
