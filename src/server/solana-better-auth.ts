import { createHash, randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { createSignInMessageText } from '@solana/wallet-standard-util';
import {
  APIError,
  createAuthEndpoint,
  getSessionFromCtx,
} from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { BetterAuthPlugin } from 'better-auth';
import { z } from 'zod';

const walletAddress = z
  .string()
  .min(32)
  .max(44)
  .refine((value) => {
    try {
      return bs58.decode(value).length === 32;
    } catch {
      return false;
    }
  }, 'Choose a valid Solana wallet.');
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const fail = () =>
  new APIError('UNAUTHORIZED', {
    message:
      'Sign-in proof expired or invalid. Request a new wallet signature.',
  });

// A native Solana plugin: SIWE's Ethereum parser/address/chain rules are not used.
// Port of the tested clawd/src/solana-auth.ts plugin, with workspace claim validation.
export function solanaAuth(
  origin: string,
  now = Date.now,
  onWalletProof?: (id: string, address: string) => Promise<void>,
) {
  const domain = new URL(origin).host;
  return {
    id: 'clawd-solana',
    endpoints: {
      solanaNonce: createAuthEndpoint(
        '/solana/nonce',
        {
          method: 'POST',
          requireRequest: true,
          body: z
            .object({
              address: walletAddress,
              purpose: z.enum(['sign-in', 'link']).default('sign-in'),
            })
            .strict(),
        },
        async (ctx) => {
          const session =
            ctx.body.purpose === 'link' ? await getSessionFromCtx(ctx) : null;
          if (
            ctx.body.purpose === 'link' &&
            (!session || now() - session.session.createdAt.getTime() > 300000)
          )
            throw new APIError('UNAUTHORIZED', {
              message: 'Sign in again before linking a wallet.',
            });
          const nonce = randomBytes(24).toString('hex'),
            binding = randomBytes(32).toString('hex');
          const input = {
            domain,
            address: ctx.body.address,
            uri: origin + '/sign-in',
            version: '1',
            chainId: 'solana:mainnet',
            statement:
              ctx.body.purpose === 'link'
                ? 'Link this Solana wallet to your ChatGPTEE account. This does not authorize transactions or payments.'
                : 'Sign in to ChatGPTEE with Solana. This does not authorize transactions or payments.',
            nonce,
            issuedAt: new Date(now()).toISOString(),
            expirationTime: new Date(now() + 300000).toISOString(),
          };
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: 'clawd-solana:' + nonce,
            value: JSON.stringify({
              input,
              binding: digest(binding),
              userId: session?.user.id ?? null,
              purpose: ctx.body.purpose,
            }),
            expiresAt: new Date(now() + 300000),
          });
          await ctx.setSignedCookie(
            'clawd_siws_' + nonce,
            binding,
            ctx.context.secret,
            {
              httpOnly: true,
              secure: origin.startsWith('https:'),
              sameSite: 'lax',
              path: '/',
              maxAge: 300,
            },
          );
          return ctx.json({ input, message: createSignInMessageText(input) });
        },
      ),
      solanaVerify: createAuthEndpoint(
        '/solana/verify',
        {
          method: 'POST',
          requireRequest: true,
          body: z
            .object({
              nonce: z.string().regex(/^[a-f0-9]{48}$/),
              signature: z.string().min(64).max(90),
              message: z.string().max(4000).optional(),
            })
            .strict(),
        },
        async (ctx) => {
          const record =
            await ctx.context.internalAdapter.findVerificationValue(
              'clawd-solana:' + ctx.body.nonce,
            );
          if (!record || record.expiresAt.getTime() <= now()) throw fail();
          const challenge = JSON.parse(record.value) as {
            input: Parameters<typeof createSignInMessageText>[0];
            binding: string;
            userId: string | null;
            purpose: string;
          };
          const binding = await ctx.getSignedCookie(
            'clawd_siws_' + ctx.body.nonce,
            ctx.context.secret,
          );
          if (!binding || digest(binding) !== challenge.binding) throw fail();
          const message = createSignInMessageText(challenge.input);
          if (ctx.body.message !== undefined && ctx.body.message !== message)
            throw fail();
          try {
            if (
              !ed25519.verify(
                bs58.decode(ctx.body.signature),
                new TextEncoder().encode(message),
                bs58.decode(challenge.input.address),
                { zip215: false },
              )
            )
              throw fail();
          } catch {
            throw fail();
          }
          // Atomic consumption happens after signature validation and before account/session creation.
          if (
            !(await ctx.context.internalAdapter.consumeVerificationValue(
              'clawd-solana:' + ctx.body.nonce,
            ))
          )
            throw fail();
          ctx.setCookie('clawd_siws_' + ctx.body.nonce, '', {
            httpOnly: true,
            secure: origin.startsWith('https:'),
            sameSite: 'lax',
            path: '/',
            maxAge: 0,
          });
          const key = {
            providerId: 'solana',
            accountId: challenge.input.address,
          };
          const existing =
            await ctx.context.internalAdapter.findAccountOwnerByKey(key);
          let user;
          if (challenge.purpose === 'link') {
            const session = await getSessionFromCtx(ctx);
            if (
              !session ||
              session.user.id !== challenge.userId ||
              now() - session.session.createdAt.getTime() > 300000
            )
              throw fail();
            if (
              existing &&
              (existing.kind !== 'owned' ||
                existing.user.id !== session.user.id)
            )
              throw new APIError('CONFLICT', {
                message: 'This wallet belongs to another ChatGPTEE account.',
              });
            user = session.user;
            const savedWallet = (
              user as typeof user & { solanaWallet?: string }
            ).solanaWallet;
            if (savedWallet && savedWallet !== challenge.input.address)
              throw new APIError('CONFLICT', {
                message:
                  'This account already has a Solana wallet. Sign in with that wallet.',
              });
          } else if (existing?.kind === 'owned') user = existing.user;
          else if (existing) throw fail();
          else
            user = await ctx.context.internalAdapter.createUser(
              {
                name: 'ChatGPTEE ' + challenge.input.address.slice(0, 6),
                email:
                  digest(challenge.input.address) + '@solana.clawd.invalid',
                emailVerified: false,
                solanaWallet: challenge.input.address,
              },
              { method: 'solana' },
            );
          if (onWalletProof)
            await onWalletProof(user.id, challenge.input.address);
          if (!existing)
            await ctx.context.internalAdapter.createAccount({
              ...key,
              userId: user.id,
            });
          if (challenge.purpose === 'link') {
            await ctx.context.internalAdapter.updateUser(user.id, {
              solanaWallet: challenge.input.address,
            });
            return ctx.json({ linked: true });
          }
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
          );
          if (!session)
            throw new APIError('INTERNAL_SERVER_ERROR', {
              message: 'Unable to create sign-in session.',
            });
          await setSessionCookie(ctx, { session, user });
          return ctx.json({
            user: {
              id: user.id,
              name: user.name,
              solanaWallet: challenge.input.address,
            },
          });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
