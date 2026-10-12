export interface WalletAccount {
  chainId: string;
  address: string;
  derivationPath: string;
}
export interface WalletDescriptor {
  id: string;
  name: string;
  accounts: WalletAccount[];
  createdAt: string;
}
export interface WalletKeyDescriptor {
  id: string;
  name: string;
  wallet_ids?: string[];
  policy_ids?: string[];
  expires_at?: string;
}
export type WalletCredential = { type: 'owner' | 'api_token'; value: string };
