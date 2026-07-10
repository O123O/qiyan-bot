import { WeixinCredentialStore, type WeixinCredentialHandle } from "./credential-store.ts";

export type WeixinBootstrap =
  | { configured: false }
  | { configured: true; credential: WeixinCredentialHandle };

export async function bootstrapWeixin(qiyanHome: string): Promise<WeixinBootstrap> {
  const credential = await new WeixinCredentialStore(qiyanHome).loadPinned();
  return credential ? { configured: true, credential } : { configured: false };
}
