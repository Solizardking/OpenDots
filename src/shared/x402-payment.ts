export interface PaymentOffer {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  resource: string;
}
const usdcAssets: Record<string, string> = {
  base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  'base-sepolia': '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'solana-devnet': '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};
export function isUsdcPaymentOffer(offer: PaymentOffer) {
  const expected = usdcAssets[offer.network];
  if (
    !expected ||
    offer.scheme !== 'exact' ||
    !/^[0-9]{1,20}$/.test(offer.maxAmountRequired)
  )
    return false;
  if (BigInt(offer.maxAmountRequired) <= 0n) return false;
  return expected.startsWith('0x')
    ? offer.asset.toLowerCase() === expected
    : offer.asset === expected;
}
export function usdcBaseUnits(input: string) {
  if (!/^(0|1)(\.\d{1,6})?$/.test(input))
    throw new Error('Choose a limit greater than 0 and no more than 1 USDC.');
  const [whole, fraction = ''] = input.split('.');
  const value = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (value <= 0n || value > 1000000n)
    throw new Error('Choose a limit greater than 0 and no more than 1 USDC.');
  return value;
}
export function samePaymentOffer(a: PaymentOffer, b: PaymentOffer) {
  return [
    'scheme',
    'network',
    'asset',
    'payTo',
    'maxAmountRequired',
    'resource',
  ].every(
    (key) => a[key as keyof PaymentOffer] === b[key as keyof PaymentOffer],
  );
}
