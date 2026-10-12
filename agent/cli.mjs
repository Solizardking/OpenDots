#!/usr/bin/env node
import { setTimeout as pause } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { createX402Client } from '@privy-io/node/x402';
import { wrapFetchWithPayment } from '@x402/fetch';
import { AgentSession } from './session.mjs';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const appId = process.env.PRIVY_APP_ID ?? 'cm7mmxm7a01bs3i2ltojavlnl';
const authUrl = process.env.PRIVY_AUTH_URL ?? 'https://chatgptee.ai/authorize';
const flag = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
if (command === 'help' || command === '--help') {
  console.log(
    `ChatGPTEE Agent\n\nchatgptee-agent login\nchatgptee-agent list-wallets\nchatgptee-agent rpc --wallet WALLET_ID < request.json\nchatgptee-agent fetch HTTPS_URL --wallet WALLET_ID --max-usdc 0.1\nchatgptee-agent logout\n\nCredentials are stored in the OS credential manager. Revoke access at ${authUrl}.`,
  );
  process.exit(0);
}
try {
  const session = new AgentSession(appId);
  if (command === 'login') {
    const device = await session.api('/device_authorization', {});
    if (device.verification_uri !== authUrl)
      throw new Error(
        'The Privy verification URI does not match PRIVY_AUTH_URL.',
      );
    console.log(
      `Visit: ${device.verification_uri_complete}\nCode: ${device.user_code}\nWaiting for approval…`,
    );
    let interval = Math.max(5, device.interval);
    const deadline = Date.now() + device.expires_in * 1000;
    let authorized = false;
    while (Date.now() < deadline) {
      await pause(interval * 1000);
      try {
        const tokens = await session.api('/token', {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: device.device_code,
        });
        session.save(tokens);
        authorized = true;
        console.log(
          'Agent connected. Credentials saved in the OS credential manager.',
        );
        break;
      } catch (e) {
        if (e.code === 'authorization_pending') continue;
        if (e.code === 'slow_down') {
          interval += 5;
          continue;
        }
        throw e;
      }
    }
    if (!authorized) throw new Error('Code expired. Restart login.');
  } else if (command === 'logout') {
    session.logout();
    console.log(
      `Local credentials removed. Revoke the authorization at ${authUrl} to stop other copies.`,
    );
  } else if (command === 'list-wallets') {
    const { wallets } = await session.authenticate();
    console.log(JSON.stringify({ wallets }, null, 2));
  } else if (command === 'rpc') {
    const wallet = flag('--wallet');
    if (!wallet) throw new Error('Select --wallet WALLET_ID.');
    const body = JSON.parse(readFileSync(0, 'utf8'));
    console.log(JSON.stringify(await session.rpc(wallet, body), null, 2));
  } else if (command === 'fetch') {
    const url = new URL(args[1]);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Use an HTTPS API URL without credentials.');
    const walletId = flag('--wallet');
    const maximum = flag('--max-usdc') ?? '0.1';
    if (!/^(0|1)(\.\d{1,6})?$/.test(maximum))
      throw new Error('Use a positive --max-usdc no greater than 1.');
    const [whole, fraction = ''] = maximum.split('.');
    const cap = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
    if (cap <= 0n || cap > 1000000n)
      throw new Error('Use a positive --max-usdc no greater than 1.');
    const { wallets } = await session.authenticate();
    const wallet = wallets.find((w) => w.id === walletId);
    if (!wallet)
      throw new Error('Select an authorized wallet with --wallet WALLET_ID.');
    // Adapter signs through the device grant; no app secret or server signing key is distributed.
    const adapter = {
      wallets: () => ({
        ethereum: () => ({
          signTypedData: async (id, input) => {
            const r = await session.rpc(id, {
              method: 'eth_signTypedData_v4',
              params: input.params,
            });
            return { signature: r.data.signature };
          },
        }),
        solana: () => ({
          signTransaction: async (id, input) => {
            const r = await session.rpc(id, {
              method: 'signTransaction',
              params: { transaction: input.transaction, encoding: 'base64' },
            });
            return { signed_transaction: r.data.signed_transaction };
          },
        }),
      }),
    };
    const client = createX402Client(adapter, {
      walletId: wallet.id,
      address: wallet.address,
    });
    client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
      const amount = BigInt(
        selectedRequirements.amount ?? selectedRequirements.maxAmountRequired,
      );
      const network = selectedRequirements.network;
      const asset = selectedRequirements.asset;
      const usdc = {
        base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        'base-sepolia': '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
        solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        'solana-devnet': '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        'eip155:8453': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        'eip155:84532': '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp':
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1':
          '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      };
      const expected = usdc[network];
      if (
        !expected ||
        (asset.startsWith('0x')
          ? asset.toLowerCase() !== expected
          : asset !== expected) ||
        amount > cap ||
        amount <= 0n
      )
        return {
          abort: true,
          reason:
            'Payment exceeds the USDC limit or uses an unsupported asset/network.',
        };
    });
    const response = await wrapFetchWithPayment(fetch, client)(url.toString(), {
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
    });
    console.log(await response.text());
    if (!response.ok) process.exitCode = 1;
  } else throw new Error('Unknown command. Run chatgptee-agent --help.');
} catch (e) {
  console.error(e.code ? `Privy: ${e.code}` : e.message);
  process.exitCode = 1;
}
