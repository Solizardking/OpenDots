import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  WalletError,
  WalletService,
  canonicalWalletChain,
} from './wallet-service.js';
import type { WorkspaceStore } from './workspace.js';
import type { PlatformConfig } from './platform-config.js';
import { PumpBuilder, PumpBuildError, pumpDecimal } from './pump-builder.js';
import type {
  PumpIntent,
  PumpReview,
  PumpStatus,
} from '../shared/pump-types.js';
import type { WalletCredential } from '../shared/wallet-types.js';

export class PumpError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
const TTL = 75_000;
/** Durable, single-use approvals. Only the owner route receives a signing credential. */
export class PumpService {
  private builder?: PumpBuilder;
  constructor(
    private db: DatabaseSync,
    private workspace: WorkspaceStore,
    private wallets: WalletService,
    private config: PlatformConfig,
    private paused: () => boolean,
    builder?: PumpBuilder,
    private now = Date.now,
  ) {
    this.builder = builder;
    db.exec(`CREATE TABLE IF NOT EXISTS pump_requests(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, review TEXT NOT NULL, status TEXT NOT NULL, signedTransaction TEXT);
      CREATE INDEX IF NOT EXISTS pump_requests_thread ON pump_requests(threadId);`);
  }
  private ready() {
    if (!this.config.pumpEnabled)
      throw new PumpError('Pump.fun is available in the local Mac app.', 403);
    if (this.paused())
      throw new PumpError(
        'Resume your workspace before preparing or signing a transaction.',
        403,
      );
    return (this.builder ??= new PumpBuilder(this.config.solanaRpcUrl));
  }
  private connectedReady() {
    if (this.paused())
      throw new PumpError(
        'Resume your workspace before preparing or submitting a transaction.',
        403,
      );
    return (this.builder ??= new PumpBuilder(this.config.solanaRpcUrl));
  }
  private connectedAddress(address: string) {
    try {
      const key = new PublicKey(address);
      if (!PublicKey.isOnCurve(key.toBytes())) throw Error();
      return key.toBase58();
    } catch {
      throw new PumpError(
        'Connect a Solana wallet with a valid signing address.',
      );
    }
  }
  async balance(walletAddress: string) {
    const address = this.connectedAddress(walletAddress);
    const builder = (this.builder ??= new PumpBuilder(
      this.config.solanaRpcUrl,
    ));
    try {
      await builder.requireMainnet();
      const balance = await builder.connection.getBalance(
        new PublicKey(address),
        'confirmed',
      );
      if (!Number.isSafeInteger(balance) || balance < 0)
        throw new PumpError(
          'The RPC balance exceeds the supported exact precision.',
          502,
        );
      const lamports = String(balance);
      return {
        address,
        network: 'solana-mainnet' as const,
        lamports,
        balanceSol: pumpDecimal(BigInt(lamports), 9),
        observedAt: this.now(),
      };
    } catch (error) {
      if (error instanceof PumpError) throw error;
      throw new PumpError(
        error instanceof PumpBuildError
          ? error.message
          : 'Wallet balance is unavailable. Refresh when the mainnet RPC is available.',
        502,
      );
    }
  }
  private wallet(threadId: string) {
    const thread = this.workspace.requireThread(threadId);
    const dot = this.workspace.dot(thread.dotId);
    if (!dot?.walletId)
      throw new PumpError('Attach a wallet to this Dot in Dot settings first.');
    const wallet = this.wallets.get(dot.walletId);
    const account = wallet.accounts.find(
      (a) => a.chainId === canonicalWalletChain('solana'),
    );
    if (
      !account ||
      !PublicKey.isOnCurve(new PublicKey(account.address).toBytes())
    )
      throw new PumpError(
        'The assigned wallet needs a Solana mainnet account.',
      );
    return { dot, wallet, address: account.address };
  }
  context(dotId: string) {
    if (!this.workspace.dot(dotId))
      throw new PumpError(
        'Select one of your Dots before opening Pump.fun.',
        404,
      );
    return (
      this.workspace
        .conversations()
        .find(
          (thread) => thread.dotId === dotId && thread.title === 'Pump.fun',
        ) ?? this.workspace.bindThread(randomUUID(), dotId, 'Pump.fun')
    );
  }
  private saved(threadId: string, id: string): PumpReview {
    this.workspace.requireThread(threadId);
    const row = this.db
      .prepare(
        'SELECT review, status FROM pump_requests WHERE id=? AND threadId=?',
      )
      .get(id, threadId);
    if (!row)
      throw new PumpError(
        'Pump transaction request not found in this conversation.',
        404,
      );
    const review: PumpReview = {
      ...JSON.parse(row.review as string),
      status: row.status as PumpStatus,
    };
    if (review.status === 'prepared' && review.expiresAt <= this.now()) {
      review.status = 'expired';
      this.db
        .prepare(
          "UPDATE pump_requests SET status='expired' WHERE id=? AND status='prepared'",
        )
        .run(id);
    }
    return review;
  }
  private update(review: PumpReview, signed?: string) {
    this.db
      .prepare(
        'UPDATE pump_requests SET review=?, status=?, signedTransaction=COALESCE(?, signedTransaction) WHERE id=?',
      )
      .run(JSON.stringify(review), review.status, signed ?? null, review.id);
  }
  async token(threadId: string, mint: string) {
    const builder = this.ready(),
      wallet = this.wallet(threadId);
    try {
      return await builder.token(mint, wallet.address);
    } catch (error) {
      throw new PumpError(
        error instanceof PumpBuildError
          ? error.message
          : 'Cannot inspect this Pump coin. Check the mint and mainnet RPC connection.',
      );
    }
  }
  async connectedToken(threadId: string, mint: string, address: string) {
    this.workspace.requireThread(threadId);
    try {
      return await this.connectedReady().token(
        mint,
        this.connectedAddress(address),
      );
    } catch (error) {
      if (error instanceof PumpError) throw error;
      throw new PumpError(
        error instanceof PumpBuildError
          ? error.message
          : 'Cannot inspect this coin. Check its mint and the mainnet RPC connection.',
      );
    }
  }
  list(threadId: string) {
    this.workspace.requireThread(threadId);
    return this.db
      .prepare(
        'SELECT id FROM pump_requests WHERE threadId=? ORDER BY rowid DESC LIMIT 20',
      )
      .all(threadId)
      .map((row) => this.saved(threadId, row.id as string));
  }
  async prepare(threadId: string, intent: PumpIntent) {
    const builder = this.ready(),
      assigned = this.wallet(threadId);
    let built;
    try {
      built = await builder.build(intent, assigned.address);
    } catch (error) {
      throw new PumpError(
        error instanceof PumpBuildError
          ? error.message
          : 'Cannot prepare this transaction. Check wallet funding, coin state and the mainnet RPC connection.',
      );
    }
    this.ready();
    const current = this.wallet(threadId);
    if (
      current.wallet.id !== assigned.wallet.id ||
      current.address !== assigned.address
    )
      throw new PumpError(
        'The assigned wallet changed. Prepare the transaction again.',
        409,
      );
    const review: PumpReview = {
      ...built,
      id: randomUUID(),
      threadId,
      dotId: assigned.dot.id,
      walletId: assigned.wallet.id,
      walletName: assigned.wallet.name,
      address: assigned.address,
      expiresAt: this.now() + TTL,
      status: 'prepared',
      transactionHash: createHash('sha256')
        .update(Buffer.from(built.transactionBase64, 'base64'))
        .digest('hex'),
    };
    // A newer proposal supersedes unapproved transactions in this conversation.
    this.db
      .prepare(
        "UPDATE pump_requests SET status='expired' WHERE threadId=? AND status='prepared'",
      )
      .run(threadId);
    this.db
      .prepare(
        'INSERT INTO pump_requests(id, threadId, review, status) VALUES(?,?,?,?)',
      )
      .run(review.id, threadId, JSON.stringify(review), review.status);
    return review;
  }
  async prepareConnected(
    threadId: string,
    intent: PumpIntent,
    walletAddress: string,
  ) {
    const thread = this.workspace.requireThread(threadId);
    const address = this.connectedAddress(walletAddress);
    let built;
    try {
      built = await this.connectedReady().build(intent, address);
    } catch (error) {
      if (error instanceof PumpError) throw error;
      throw new PumpError(
        error instanceof PumpBuildError
          ? error.message
          : 'Cannot prepare this transaction. Check your connected wallet funding, coin state and mainnet RPC connection.',
      );
    }
    this.connectedReady();
    this.workspace.requireThread(threadId);
    const review: PumpReview = {
      ...built,
      id: randomUUID(),
      threadId,
      dotId: thread.dotId,
      walletId: `connected:${address}`,
      walletName: 'Connected wallet',
      address,
      signerMode: 'connected',
      expiresAt: this.now() + TTL,
      status: 'prepared',
      transactionHash: createHash('sha256')
        .update(Buffer.from(built.transactionBase64, 'base64'))
        .digest('hex'),
    };
    this.db
      .prepare(
        "UPDATE pump_requests SET status='expired' WHERE threadId=? AND status='prepared'",
      )
      .run(threadId);
    this.db
      .prepare(
        'INSERT INTO pump_requests(id, threadId, review, status) VALUES(?,?,?,?)',
      )
      .run(review.id, threadId, JSON.stringify(review), review.status);
    return review;
  }
  async review(threadId: string, id: string): Promise<PumpReview> {
    const review = this.saved(threadId, id);
    if (
      review.status === 'submitted' &&
      review.signature &&
      (this.config.pumpEnabled || review.signerMode === 'connected')
    ) {
      const builder = (this.builder ??= new PumpBuilder(
        this.config.solanaRpcUrl,
      ));
      try {
        const result = (
          await builder.connection.getSignatureStatuses([review.signature], {
            searchTransactionHistory: true,
          })
        ).value[0];
        if (result?.err) {
          review.status = 'failed';
          review.error = `On-chain error: ${JSON.stringify(result.err)}`;
        } else if (
          result?.confirmationStatus === 'confirmed' ||
          result?.confirmationStatus === 'finalized'
        ) {
          review.status = 'confirmed';
          delete review.error;
        }
        this.update(review);
      } catch {
        /* A read outage never changes a submitted transaction to a success or failure. */
      }
    }
    return review;
  }
  decline(threadId: string, id: string) {
    const review = this.saved(threadId, id);
    if (review.status === 'prepared') {
      const result = this.db
        .prepare(
          "UPDATE pump_requests SET status='declined' WHERE id=? AND status='prepared'",
        )
        .run(id);
      if (!result.changes)
        throw new PumpError('This request is already being processed.', 409);
      review.status = 'declined';
    }
    return review;
  }
  async approve(
    threadId: string,
    id: string,
    transactionHash: string,
    credential: WalletCredential,
  ) {
    const builder = this.ready(),
      review = this.saved(threadId, id);
    if (review.signerMode === 'connected')
      throw new PumpError(
        'This request must be signed by the connected browser wallet.',
        409,
      );
    if (transactionHash !== review.transactionHash)
      throw new PumpError(
        'The reviewed transaction does not match this approval.',
        409,
      );
    if (['confirmed', 'submitted', 'failed'].includes(review.status))
      return this.review(threadId, id);
    if (review.status !== 'prepared')
      throw new PumpError(
        `This request is ${review.status}. Prepare a new transaction.`,
        409,
      );
    const assigned = this.wallet(threadId);
    if (
      assigned.wallet.id !== review.walletId ||
      assigned.address !== review.address
    )
      throw new PumpError(
        'The Dot’s wallet changed. Prepare a new transaction.',
        409,
      );
    await builder.requireMainnet();
    if (
      (await builder.connection.getBlockHeight()) >
        review.lastValidBlockHeight ||
      review.expiresAt <= this.now()
    ) {
      review.status = 'expired';
      this.update(review);
      throw new PumpError(
        'The quote or blockhash expired. Prepare and review a fresh transaction.',
        409,
      );
    }
    this.ready();
    const current = this.wallet(threadId);
    if (
      current.wallet.id !== review.walletId ||
      current.address !== review.address
    )
      throw new PumpError(
        'The Dot’s wallet changed. Prepare a new transaction.',
        409,
      );
    const claim = this.db
      .prepare(
        "UPDATE pump_requests SET status='signing' WHERE id=? AND status='prepared'",
      )
      .run(id);
    if (!claim.changes)
      throw new PumpError(
        'This transaction has already been approved or superseded.',
        409,
      );
    try {
      const transaction = Transaction.from(
        Buffer.from(review.transactionBase64, 'base64'),
      );
      // OWS expects the complete serialized Solana transaction, not raw message bytes.
      const signed = this.wallets.sign(
        review.walletId,
        'solana',
        'sign',
        Buffer.from(review.transactionBase64, 'base64').toString('hex'),
        credential,
      );
      if (!('signature' in signed))
        throw new PumpError('The wallet returned no signature.');
      transaction.addSignature(
        new PublicKey(review.address),
        Buffer.from(signed.signature, 'hex'),
      );
      if (!transaction.verifySignatures())
        throw new PumpError('Wallet or mint signature verification failed.');
      const bytes = transaction.serialize();
      review.signature = bs58.encode(transaction.signature!);
      // Persist before broadcasting. Network errors or duplicate clicks can only recheck this signature.
      review.status = 'submitted';
      this.update(review, bytes.toString('base64'));
      try {
        const signature = await builder.connection.sendRawTransaction(bytes, {
          skipPreflight: false,
          maxRetries: 2,
          preflightCommitment: 'confirmed',
        });
        if (signature !== review.signature)
          throw Error('RPC returned a different transaction signature.');
      } catch {
        review.error =
          'Submission could not be verified. Check this signature before preparing another transaction.';
        this.update(review);
      }
      return this.review(threadId, id);
    } catch (error) {
      if (review.status !== 'submitted') {
        review.status = error instanceof WalletError ? 'prepared' : 'failed';
        this.update(review);
      }
      // Never send signer errors (which may contain a credential) to the model or logs.
      throw new PumpError(
        error instanceof WalletError
          ? 'Wallet unlock or policy check failed. Check your credential and wallet policy.'
          : 'The wallet could not sign this transaction. Nothing was broadcast.',
        error instanceof WalletError && error.status !== 401
          ? error.status
          : 400,
      );
    }
  }
  /** The browser signs. The server accepts only the immutable reviewed message and valid signatures. */
  async submitConnected(
    threadId: string,
    id: string,
    transactionHash: string,
    signedBase64: string,
  ) {
    const builder = this.connectedReady(),
      review = this.saved(threadId, id);
    if (review.signerMode !== 'connected')
      throw new PumpError(
        'Use the local wallet approval for this request.',
        409,
      );
    if (transactionHash !== review.transactionHash)
      throw new PumpError(
        'The reviewed transaction does not match this approval.',
        409,
      );
    if (['confirmed', 'submitted', 'failed'].includes(review.status))
      return this.review(threadId, id);
    if (review.status !== 'prepared')
      throw new PumpError(
        `This request is ${review.status}. Prepare a new transaction.`,
        409,
      );
    await builder.requireMainnet();
    if (
      review.expiresAt <= this.now() ||
      (await builder.connection.getBlockHeight()) > review.lastValidBlockHeight
    ) {
      review.status = 'expired';
      this.update(review);
      throw new PumpError(
        'The quote or blockhash expired. Prepare and review a fresh transaction.',
        409,
      );
    }
    let transaction: Transaction, bytes: Buffer;
    try {
      bytes = Buffer.from(signedBase64, 'base64');
      if (
        !bytes.length ||
        bytes.length > 1232 ||
        bytes.toString('base64') !== signedBase64
      )
        throw Error();
      transaction = Transaction.from(bytes);
      const original = Transaction.from(
        Buffer.from(review.transactionBase64, 'base64'),
      );
      if (
        !transaction.serializeMessage().equals(original.serializeMessage()) ||
        transaction.feePayer?.toBase58() !== review.address ||
        !transaction.verifySignatures()
      )
        throw Error();
      // A launch's mint signature must remain exactly the pre-signed signature from preparation.
      for (const expected of original.signatures) {
        if (
          expected.signature &&
          !transaction.signatures
            .find((s) => s.publicKey.equals(expected.publicKey))
            ?.signature?.equals(expected.signature)
        )
          throw Error();
      }
    } catch {
      throw new PumpError(
        'The wallet must sign the exact reviewed transaction, including every required signature.',
        409,
      );
    }
    this.connectedReady();
    const claim = this.db
      .prepare(
        "UPDATE pump_requests SET status='signing' WHERE id=? AND status='prepared'",
      )
      .run(id);
    if (!claim.changes)
      throw new PumpError(
        'This transaction has already been approved or superseded.',
        409,
      );
    review.signature = bs58.encode(transaction.signature!);
    review.status = 'submitted';
    this.update(review, bytes.toString('base64'));
    try {
      const signature = await builder.connection.sendRawTransaction(bytes, {
        skipPreflight: false,
        maxRetries: 2,
        preflightCommitment: 'confirmed',
      });
      if (signature !== review.signature) throw Error();
    } catch {
      review.error =
        'Submission could not be verified. Check this signature before preparing another transaction.';
      this.update(review);
    }
    return this.review(threadId, id);
  }
}
