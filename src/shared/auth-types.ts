import type { SolanaSignInInput } from '@solana/wallet-standard-features';

export interface SolanaUser {
  id: string;
  walletAddress: string | null;
  displayName: string | null;
  createdAt: string;
  lastLoginAt: string;
}
export interface AuthSession {
  user: SolanaUser | null;
  owner: boolean;
  desktop?: boolean;
  companion?: boolean;
  /** Desktop only: the Privy identity linked to this Mac's workspace. */
  privy?: { subject: string; linkedAt: number } | null;
}
export interface SignInChallenge {
  id: string;
  input: SolanaSignInInput & { domain: string; address: string };
  message: string;
}
