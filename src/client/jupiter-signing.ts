import { VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { JupiterReview } from '../shared/jupiter-types';

export function bytesBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length && left.every((byte, i) => byte === right[i])
  );
}

function reviewSigners(
  transaction: VersionedTransaction,
  review: JupiterReview,
) {
  if (review.network !== 'solana-mainnet' || !review.executionAvailable)
    throw Error('A prepared Solana mainnet transaction review is required.');
  if (transaction.version !== 0 || review.transactionVersion !== 0)
    throw Error('This wallet flow supports Solana v0 transactions only.');
  const keys = transaction.message.staticAccountKeys;
  const signers = keys.slice(
    0,
    transaction.message.header.numRequiredSignatures,
  );
  if (
    keys[0]?.toBase58() !== review.feePayer ||
    signers.length !== review.requiredSigners.length ||
    signers.some((key, i) => key.toBase58() !== review.requiredSigners[i]) ||
    !review.requiredSigners.includes(review.address) ||
    review.deferredSigners.includes(review.address) ||
    review.deferredSigners.some(
      (key) => !review.requiredSigners.includes(key),
    ) ||
    (review.mode !== 'order' && review.deferredSigners.length !== 0)
  )
    throw Error('The transaction signers do not match the immutable review.');
  return signers;
}

export async function decodeJupiterReview(review: JupiterReview) {
  const bytes = Uint8Array.from(atob(review.transactionBase64), (c) =>
    c.charCodeAt(0),
  );
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(hash, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (hex !== review.transactionHash)
    throw Error(
      'The transaction bytes do not match the reviewed transaction hash.',
    );
  const transaction = VersionedTransaction.deserialize(bytes);
  reviewSigners(transaction, review);
  return transaction;
}

export function validateJupiterSignature(
  original: VersionedTransaction,
  signed: VersionedTransaction,
  review: JupiterReview,
): void {
  const signers = reviewSigners(signed, review);
  const message = original.message.serialize();
  if (!equalBytes(message, signed.message.serialize()))
    throw Error(
      'Your wallet changed the reviewed transaction. Prepare a fresh review.',
    );
  for (let i = 0; i < signers.length; i++) {
    const before = original.signatures[i];
    const after = signed.signatures[i];
    if (!after || after.length !== 64)
      throw Error('A required transaction signature is missing.');
    if (before.some((byte) => byte !== 0) && !equalBytes(before, after))
      throw Error('Your wallet changed an existing provider signature.');
    if (after.every((byte) => byte === 0)) {
      if (
        review.mode === 'order' &&
        review.deferredSigners.includes(signers[i].toBase58())
      )
        continue;
      throw Error(
        'Your connected wallet must sign the exact reviewed transaction.',
      );
    }
    if (!ed25519.verify(after, message, signers[i].toBytes()))
      throw Error('The transaction contains an invalid signature.');
  }
}
