import * as argon2 from 'argon2';

// Shared by member PINs, staff passwords, and admin passwords. argon2id
// is the recommended variant — resistant to both GPU and side-channel
// cracking attempts, and needs no manual salt handling (argon2 embeds it
// in the hash string it returns).
export async function hashSecret(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifySecret(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
