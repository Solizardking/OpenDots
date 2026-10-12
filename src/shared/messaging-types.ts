export const CHATGPTEE_CALL_NUMBER = '+12564726195';
export type MessagingPlatform = 'telegram' | 'imessage';
export type MessagingChannelStatus = {
  platform: MessagingPlatform;
  configured: boolean;
  available: boolean;
  linked: boolean;
  reason: string;
  botUsername?: string;
  address?: string;
  linkedIdentityMasked?: string;
  dotId?: string;
  dotName?: string;
};
export type MessagingStatus = {
  callNumber: typeof CHATGPTEE_CALL_NUMBER;
  documentationVersion: 'Stable';
  channels: MessagingChannelStatus[];
};
export type MessagingLink = {
  platform: MessagingPlatform;
  code: string;
  expiresAt: string;
  instruction: string;
  url?: string;
};
