import bs58 from 'bs58';
const numeric = (value) =>
  (typeof value === 'number' || (typeof value === 'string' && value !== '')) &&
  Number.isFinite(Number(value))
    ? Number(value)
    : null;
export function validMarketMint(value) {
  try {
    return (
      typeof value === 'string' &&
      value.length <= 44 &&
      bs58.decode(value).length === 32
    );
  } catch {
    return false;
  }
}
export function selectSolanaPair(payload, mint, { pumpOnly = false } = {}) {
  const rows = Array.isArray(payload) ? payload : payload?.pairs || [];
  return (
    rows
      .filter(
        (pair) =>
          pair?.chainId === 'solana' &&
          pair?.baseToken?.address === mint &&
          validMarketMint(pair.pairAddress) &&
          numeric(pair.priceUsd) > 0 &&
          (!pumpOnly || /^pump(fun|swap)$/i.test(pair.dexId)),
      )
      .sort((a, b) => {
        const venue =
          Number(/^pump(fun|swap)$/i.test(b.dexId)) -
          Number(/^pump(fun|swap)$/i.test(a.dexId));
        return (
          venue ||
          (numeric(b.liquidity?.usd) || 0) - (numeric(a.liquidity?.usd) || 0) ||
          (numeric(b.volume?.h24) || 0) - (numeric(a.volume?.h24) || 0)
        );
      })[0] || null
  );
}
