import {
  CHATGPTEE_CALL_NUMBER,
  type MessagingChannelStatus,
  type MessagingLink,
  type MessagingPlatform,
  type MessagingStatus,
} from '../shared/messaging-types.js';
import { MessagingStore, type MessagingBinding } from './messaging-store.js';

export type NativeMessagingEvent = {
  platform: MessagingPlatform;
  senderId: string;
  spaceId: string;
  messageId: string;
  text: string;
  direction: 'inbound';
  isDirect: boolean;
  phone?: string;
};
export type MessagingTransport = {
  status(): Omit<MessagingChannelStatus, 'linked'>[];
  sendText(
    target: { platform: MessagingPlatform; spaceId: string; phone?: string },
    text: string,
  ): Promise<unknown>;
};
export type MessagingWorkspace = {
  dot(id: string): { id: string; name: string } | undefined;
  createConversation(dotId: string, title: string): Promise<{ id: string }>;
  turn(threadId: string, prompt: string, signal: AbortSignal): Promise<string>;
};
export class MessagingRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 503,
  ) {
    super(message);
  }
}
export class MessagingCoordinator {
  private queues = new Map<string, { promise: Promise<void>; count: number }>();
  private active = new Map<
    string,
    {
      ownerId: string;
      platform: MessagingPlatform;
      controller: AbortController;
    }
  >();
  private stopped = false;
  constructor(
    private store: MessagingStore,
    private transport: MessagingTransport,
    private workspace: (
      ownerId: string,
    ) => Promise<MessagingWorkspace | undefined>,
    private scope: (platform: MessagingPlatform) => string,
  ) {}
  private provider(platform: MessagingPlatform) {
    return this.transport.status().find((item) => item.platform === platform);
  }
  private linkAvailable(provider: Omit<MessagingChannelStatus, 'linked'>) {
    return (
      provider.available &&
      (provider.platform === 'telegram'
        ? Boolean(provider.botUsername)
        : /^\+[1-9]\d{6,14}$/.test(provider.address ?? ''))
    );
  }
  async status(ownerId: string, dotId?: string): Promise<MessagingStatus> {
    const workspace = await this.workspace(ownerId);
    if (dotId && !workspace?.dot(dotId))
      throw new MessagingRequestError('Dot not found.', 404);
    return {
      callNumber: CHATGPTEE_CALL_NUMBER,
      documentationVersion: 'Stable',
      channels: this.transport.status().map((provider) => {
        const binding = this.store.binding(ownerId, provider.platform);
        const dot = binding && workspace?.dot(binding.dotId);
        const linked = Boolean(
          binding && binding.scope === this.scope(provider.platform) && dot,
        );
        return {
          platform: provider.platform,
          configured: provider.configured,
          available: this.linkAvailable(provider),
          reason:
            provider.available && !this.linkAvailable(provider)
              ? 'A verified dedicated messaging address is required to link a new account.'
              : provider.reason,
          botUsername: provider.botUsername,
          address: provider.address,
          linked,
          ...(linked && binding && dot
            ? {
                linkedIdentityMasked: `${binding.senderId.startsWith('+') ? '+' : ''}••••${binding.senderId.slice(-4)}`,
                dotId: dot.id,
                dotName: dot.name,
              }
            : {}),
        };
      }),
    };
  }
  async link(
    ownerId: string,
    platform: MessagingPlatform,
    dotId: string,
  ): Promise<MessagingLink> {
    const workspace = await this.workspace(ownerId);
    if (!workspace?.dot(dotId))
      throw new MessagingRequestError('Choose a Dot in your workspace.', 404);
    const provider = this.provider(platform);
    if (!provider || !this.linkAvailable(provider) || this.stopped)
      throw new MessagingRequestError(
        'This channel is awaiting dedicated Spectrum setup.',
        503,
      );
    const result = this.store.issue(
      ownerId,
      dotId,
      platform,
      this.scope(platform),
    );
    return {
      platform,
      ...result,
      instruction:
        platform === 'telegram'
          ? `Send /start ${result.code} to the ChatGPTEE Telegram bot in a private chat.`
          : `Send LINK ${result.code} to the ChatGPTEE iMessage address from your own iMessage account.`,
      ...(platform === 'telegram' && provider.botUsername
        ? {
            url: `https://t.me/${provider.botUsername}?start=${result.code}`,
          }
        : platform === 'imessage' && provider.address?.startsWith('+')
          ? {
              url: `sms:${provider.address}?body=${encodeURIComponent(`LINK ${result.code}`)}`,
            }
          : {}),
    };
  }
  unlink(ownerId: string, platform: MessagingPlatform) {
    const old = this.store.unlink(ownerId, platform);
    if (old) this.active.get(old.id)?.controller.abort();
  }
  async receive(event: NativeMessagingEvent) {
    if (
      this.stopped ||
      !event.isDirect ||
      event.direction !== 'inbound' ||
      !this.provider(event.platform)?.available ||
      !event.text.trim() ||
      event.text.length > 12000 ||
      [event.senderId, event.spaceId, event.messageId].some(
        (v) => !v || v.length > 512,
      )
    )
      return;
    const scope = this.scope(event.platform);
    const match = event.text
      .trim()
      .match(
        event.platform === 'telegram'
          ? /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{32})$/
          : /^LINK\s+([A-Za-z0-9_-]{32})$/i,
      );
    let binding: MessagingBinding | undefined;
    if (match) {
      if (!this.store.hasLink(match[1], event.platform, scope)) return;
    } else {
      binding = this.store.identity(event.platform, scope, event.senderId);
      if (
        !binding ||
        binding.spaceId !== event.spaceId ||
        binding.phone !== event.phone
      )
        return;
    }
    // Unknown senders and invalid codes never fill the persistent replay table.
    if (
      this.store.seen(
        event.platform,
        scope,
        event.spaceId,
        event.messageId,
        event.phone,
      )
    )
      return;
    if (match) {
      binding = this.store.claim(match[1], {
        platform: event.platform,
        scope,
        senderId: event.senderId,
        spaceId: event.spaceId,
        phone: event.phone,
      });
      // Invalid links reveal no account or workspace information.
      if (!binding) return;
      for (const [id, running] of this.active)
        if (
          id !== binding.id &&
          running.ownerId === binding.ownerId &&
          running.platform === binding.platform
        )
          running.controller.abort();
    }
    if (!binding) return;
    const captured = binding;
    const key = `${captured.ownerId}:${captured.platform}`;
    const queue = this.queues.get(key) ?? {
      promise: Promise.resolve(),
      count: 0,
    };
    if (queue.count >= 8) return;
    queue.count++;
    queue.promise = queue.promise
      .catch(() => {})
      .then(async () => {
        if (this.stopped || !this.store.current(captured)) return;
        const controller = new AbortController();
        this.active.set(captured.id, {
          ownerId: captured.ownerId,
          platform: captured.platform,
          controller,
        });
        try {
          const workspace = await this.workspace(captured.ownerId);
          const dot = workspace?.dot(captured.dotId);
          if (!workspace || !dot || !this.store.current(captured)) return;
          if (match) {
            await this.reply(
              captured,
              `Linked to ${dot.name} in your ChatGPTEE workspace. You can now send messages here. Unlink this channel in ChatGPTEE's Phone panel.`,
              controller.signal,
            );
            return;
          }
          let threadId =
            captured.threadId ??
            this.store.binding(captured.ownerId, captured.platform)?.threadId;
          if (!threadId) {
            const conversation = await workspace.createConversation(
              captured.dotId,
              `${captured.platform === 'telegram' ? 'Telegram' : 'iMessage'} conversation`,
            );
            if (!this.store.thread(captured, conversation.id)) return;
            threadId = conversation.id;
          }
          controller.signal.throwIfAborted();
          if (!this.store.current(captured)) return;
          const response = await workspace.turn(
            threadId,
            event.text,
            controller.signal,
          );
          await this.reply(captured, response, controller.signal);
        } catch {
          if (!controller.signal.aborted)
            await this.reply(
              captured,
              'This conversation is temporarily unavailable. Continue in ChatGPTEE or try again later.',
              controller.signal,
            ).catch(() => {});
        } finally {
          this.active.delete(captured.id);
        }
      })
      .finally(() => {
        queue.count--;
        if (!queue.count && this.queues.get(key) === queue)
          this.queues.delete(key);
      });
    this.queues.set(key, queue);
  }
  private async reply(
    binding: MessagingBinding,
    text: string,
    signal: AbortSignal,
  ) {
    if (
      signal.aborted ||
      this.stopped ||
      !this.store.current(binding) ||
      !this.provider(binding.platform)?.available
    )
      return;
    // Plain text only; chunk below both providers' message limits.
    for (
      let offset = 0;
      offset < Math.min(text.length, 16000);
      offset += 3500
    ) {
      if (signal.aborted || this.stopped || !this.store.current(binding))
        return;
      await this.transport.sendText(
        {
          platform: binding.platform,
          spaceId: binding.spaceId,
          phone: binding.phone,
        },
        text.slice(offset, offset + 3500),
      );
    }
  }
  async drain() {
    await Promise.all([...this.queues.values()].map((queue) => queue.promise));
  }
  async stop() {
    this.stopped = true;
    for (const running of this.active.values()) running.controller.abort();
    await this.drain();
  }
}
