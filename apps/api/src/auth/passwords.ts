import { hash, verify } from '@node-rs/argon2';

const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
// Pre-computed hash used to keep timing similar when a user does not exist.
let dummyHash: string | null = null;

export const hashSecret = (plain: string) => hash(plain, OPTIONS);

export async function verifySecret(hashValue: string | null | undefined, plain: string): Promise<boolean> {
  if (!hashValue) {
    dummyHash ??= await hash('not-a-real-password', OPTIONS);
    await verify(dummyHash, plain).catch(() => false);
    return false;
  }
  return verify(hashValue, plain).catch(() => false);
}
