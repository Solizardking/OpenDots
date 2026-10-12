import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { WorkspaceStore } from './workspace.js';
import type { PlatformConfig } from './platform-config.js';
import {
  JupiterProvider,
  JupiterError,
  verifyJupiterSignatures,
} from './jupiter-provider.js';
import type {
  JupiterSwap,
  JupiterReview,
  JupiterStatus,
  JupiterAvailability,
} from '../shared/jupiter-types.js';
export { JupiterError } from './jupiter-provider.js';

/** Owner-scoped, immutable approvals. Managed execution is claimed once, including ambiguous submissions. */
export class JupiterService {
  private provider: JupiterProvider;
  constructor(
    private db: DatabaseSync,
    private workspace: WorkspaceStore,
    config: PlatformConfig,
    private paused: () => boolean,
    provider?: JupiterProvider,
    private now = Date.now,
  ) {
    this.provider =
      provider ??
      new JupiterProvider(
        config.solanaRpcUrl,
        config.tradingEnv?.JUPITER_API_KEY ??
          config.tradingEnv?.JUP_SWAP_V1_API_KEY ??
          process.env.JUPITER_API_KEY,
      );
    db.exec(`CREATE TABLE IF NOT EXISTS jupiter_requests(id TEXT PRIMARY KEY,threadId TEXT NOT NULL,review TEXT NOT NULL,status TEXT NOT NULL,providerRequestId TEXT,signedTransaction TEXT);
      CREATE INDEX IF NOT EXISTS jupiter_requests_thread ON jupiter_requests(threadId);`);
  }
  availability(): JupiterAvailability {
    return {
      configured: this.provider.configured,
      source: 'Jupiter',
      supportedTransactionVersions: [0],
      message: this.provider.configured
        ? 'Jupiter managed orders and advanced builds use connected-wallet approval. Version 0 is supported; version 1 requires an SDK and wallet upgrade.'
        : 'Jupiter is not configured on this server.',
    };
  }
  status() {
    return this.availability();
  }
  private ready() {
    if (this.paused())
      throw new JupiterError(
        'Resume your workspace before preparing or submitting a swap.',
        403,
      );
    if (!this.provider.configured)
      throw new JupiterError('Jupiter is not configured on this server.', 503);
  }
  context(dotId: string) {
    if (!this.workspace.dot(dotId))
      throw new JupiterError('Select one of your Dots to open Jupiter.', 404);
    return (
      this.workspace
        .conversations()
        .find(
          (thread) => thread.dotId === dotId && thread.title === 'Jupiter',
        ) ?? this.workspace.bindThread(randomUUID(), dotId, 'Jupiter')
    );
  }
  async quote(input: JupiterSwap, address?: string) {
    try {
      return await this.provider.quote(input, address);
    } catch (error) {
      if (error instanceof JupiterError) throw error;
      throw new JupiterError(
        'The Jupiter quote is unavailable. Check mints, amount and mainnet RPC.',
        502,
      );
    }
  }
  private saved(threadId: string, id: string): JupiterReview {
    this.workspace.requireThread(threadId);
    const row = this.db
      .prepare(
        'SELECT review,status FROM jupiter_requests WHERE id=? AND threadId=?',
      )
      .get(id, threadId);
    if (!row)
      throw new JupiterError(
        'Jupiter request not found in this conversation.',
        404,
      );
    const review: JupiterReview = {
      ...JSON.parse(row.review as string),
      status: row.status as JupiterStatus,
    };
    if (review.status === 'prepared' && review.expiresAt <= this.now()) {
      this.db
        .prepare(
          "UPDATE jupiter_requests SET status='expired' WHERE id=? AND status='prepared'",
        )
        .run(id);
      review.status = 'expired';
    }
    return review;
  }
  private update(review: JupiterReview) {
    // A late submission response or polling read must never overwrite a terminal receipt.
    this.db
      .prepare(
        'UPDATE jupiter_requests SET review=?,status=? WHERE id=? AND status=?',
      )
      .run(
        JSON.stringify(review),
        review.status,
        review.id,
        review.status === 'expired' ? 'prepared' : 'submitted',
      );
  }
  list(threadId: string) {
    this.workspace.requireThread(threadId);
    return this.db
      .prepare(
        'SELECT id FROM jupiter_requests WHERE threadId=? ORDER BY rowid DESC LIMIT 20',
      )
      .all(threadId)
      .map((row) => this.saved(threadId, row.id as string));
  }
  async prepare(
    threadId: string,
    input: JupiterSwap,
    address: string,
    signal?: AbortSignal,
  ) {
    this.ready();
    const thread = this.workspace.requireThread(threadId);
    let built;
    try {
      built = await this.provider.prepare(input, address);
    } catch (error) {
      if (error instanceof JupiterError) throw error;
      throw new JupiterError(
        'Cannot prepare this swap. Check wallet funding, token state and mainnet RPC.',
        502,
      );
    }
    this.ready();
    this.workspace.requireThread(threadId);
    if (signal?.aborted)
      throw new JupiterError(
        'The swap draft changed before preparation completed.',
        409,
      );
    if (built.review.expiresAt <= this.now())
      throw new JupiterError(
        'The quote expired during preparation. Prepare again.',
        409,
      );
    const review: JupiterReview = {
      ...built.review,
      id: randomUUID(),
      threadId,
      dotId: thread.dotId,
      status: 'prepared',
      transactionHash: createHash('sha256')
        .update(Buffer.from(built.review.transactionBase64, 'base64'))
        .digest('hex'),
    };
    this.db
      .prepare(
        "UPDATE jupiter_requests SET status='expired' WHERE threadId=? AND status='prepared'",
      )
      .run(threadId);
    this.db
      .prepare(
        'INSERT INTO jupiter_requests(id,threadId,review,status,providerRequestId) VALUES(?,?,?,?,?)',
      )
      .run(
        review.id,
        threadId,
        JSON.stringify(review),
        review.status,
        built.providerRequestId ?? null,
      );
    return review;
  }
  decline(threadId: string, id: string) {
    const review = this.saved(threadId, id);
    if (review.status === 'prepared') {
      const claim = this.db
        .prepare(
          "UPDATE jupiter_requests SET status='declined' WHERE id=? AND status='prepared'",
        )
        .run(id);
      if (!claim.changes)
        throw new JupiterError('This swap is already processing.', 409);
      review.status = 'declined';
    }
    return review;
  }
  async review(threadId: string, id: string) {
    const review = this.saved(threadId, id);
    if (review.status === 'submitted' && review.signature) {
      try {
        await this.provider.requireMainnet();
        const status = (
          await this.provider.connection.getSignatureStatuses(
            [review.signature],
            { searchTransactionHistory: true },
          )
        ).value[0];
        const terminal =
          status?.err ||
          status?.confirmationStatus === 'confirmed' ||
          status?.confirmationStatus === 'finalized';
        // Deferred payer receipts need message verification before either a success or failure is attributed to this approval.
        if (terminal && review.deferredSigners.includes(review.feePayer)) {
          const landed = await this.provider.connection.getTransaction(
            review.signature,
            { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
          );
          if (!landed) return review;
          const original = VersionedTransaction.deserialize(
            Buffer.from(review.transactionBase64, 'base64'),
          );
          const complete = new VersionedTransaction(
            landed.transaction.message,
            landed.transaction.signatures.map((signature) =>
              bs58.decode(signature),
            ),
          );
          verifyJupiterSignatures(original, complete, review.address, []);
          if (landed.transaction.signatures[0] !== review.signature)
            throw Error();
        }
        if (status?.err) {
          review.status = 'failed';
          review.error =
            'The transaction failed on-chain. Inspect the signature for details.';
        } else if (
          status?.confirmationStatus === 'confirmed' ||
          status?.confirmationStatus === 'finalized'
        ) {
          review.status = 'confirmed';
          delete review.error;
        }
        if (review.status !== 'submitted') this.update(review);
      } catch {
        /* Read outages retain submitted state and the receipt. */
      }
      return this.saved(threadId, id);
    }
    return review;
  }
  async submit(
    threadId: string,
    id: string,
    transactionHash: string,
    signedBase64: string,
  ) {
    this.ready();
    const review = this.saved(threadId, id);
    if (transactionHash !== review.transactionHash)
      throw new JupiterError(
        'The reviewed transaction differs from this approval.',
        409,
      );
    if (['submitted', 'confirmed', 'failed'].includes(review.status))
      return this.review(threadId, id);
    if (review.status !== 'prepared')
      throw new JupiterError(
        `This swap is ${review.status}. Prepare a new transaction.`,
        409,
      );
    let signed: VersionedTransaction, bytes: Buffer;
    try {
      bytes = Buffer.from(signedBase64, 'base64');
      if (
        !bytes.length ||
        bytes.length > 1232 ||
        bytes.toString('base64') !== signedBase64
      )
        throw Error();
      const original = VersionedTransaction.deserialize(
        Buffer.from(review.transactionBase64, 'base64'),
      );
      signed = VersionedTransaction.deserialize(bytes);
      verifyJupiterSignatures(
        original,
        signed,
        review.address,
        review.deferredSigners,
      );
    } catch (error) {
      if (error instanceof JupiterError) throw error;
      throw new JupiterError(
        'The connected wallet must sign the exact reviewed transaction.',
        409,
      );
    }
    await this.provider.requireMainnet();
    if (
      review.expiresAt <= this.now() ||
      (review.lastValidBlockHeight !== undefined &&
        (await this.provider.connection.getBlockHeight('confirmed')) >
          review.lastValidBlockHeight) ||
      !(
        await this.provider.connection.isBlockhashValid(
          signed.message.recentBlockhash,
          { commitment: 'confirmed' },
        )
      ).value
    ) {
      review.status = 'expired';
      this.update(review);
      throw new JupiterError(
        'The quote or blockhash expired. Prepare a fresh swap.',
        409,
      );
    }
    this.ready();
    this.workspace.requireThread(threadId);
    const claim = this.db
      .prepare(
        "UPDATE jupiter_requests SET status='submitted',signedTransaction=? WHERE id=? AND status='prepared'",
      )
      .run(signedBase64, id);
    if (!claim.changes)
      throw new JupiterError(
        'This swap is already submitted or superseded.',
        409,
      );
    review.status = 'submitted';
    // Never derive a transaction ID from a zero payer signature in sponsored/RFQ orders.
    if (signed.signatures[0].some((value) => value !== 0))
      review.signature = bs58.encode(signed.signatures[0]);
    this.update(review);
    try {
      if (review.mode === 'order') {
        const row = this.db
          .prepare('SELECT providerRequestId FROM jupiter_requests WHERE id=?')
          .get(id);
        if (!row?.providerRequestId) throw Error();
        const receipt = await this.provider.execute(
          signedBase64,
          row.providerRequestId as string,
          review.lastValidBlockHeight,
        );
        review.providerCode = receipt.code;
        if (receipt.signature) {
          if (review.signature && review.signature !== receipt.signature)
            throw Error();
          review.signature = receipt.signature;
        }
        // Jupiter Success is a submission receipt. Independent RPC confirmation decides success.
        if (receipt.status === 'Failed')
          review.error = `Jupiter reported submission code ${receipt.code}. Check the receipt before preparing another swap.`;
        if (!review.signature)
          review.error =
            'Jupiter submission has no verified transaction signature. Do not submit this order again.';
      } else {
        const signature = await this.provider.connection.sendRawTransaction(
          bytes,
          {
            skipPreflight: false,
            maxRetries: 2,
            preflightCommitment: 'confirmed',
          },
        );
        if (signature !== review.signature) throw Error();
      }
    } catch {
      review.error =
        'Submission could not be verified. This order will not be submitted again automatically. Check its receipt before preparing another swap.';
    }
    this.update(review);
    return this.review(threadId, id);
  }
}
